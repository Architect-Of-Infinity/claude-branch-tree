// Unit tests for src/page-hook.js: the jump-view byte swap, run in a fake page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.resolve(__dirname, '../extension/src/page-hook.js'), 'utf8');

const CONV = '11111111-2222-4333-8444-555555555555';
const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002';
const enc = new TextEncoder();

function fakePage(storage, upstream) {
  const attrs = {};
  const posted = [];
  const win = {
    location: { pathname: `/chat/${CONV}`, origin: 'https://claude.ai' },
    sessionStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    postMessage: (m) => posted.push(m.kind),
    fetch: upstream,
  };
  win.window = win;
  win.document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] ?? null } };
  const ctx = vm.createContext({ ...win, TextEncoder, TransformStream, Response, Headers, Request, Blob, DecompressionStream, Uint8Array, JSON, Date, Object, String, setTimeout: () => 0 });
  ctx.window = ctx;
  vm.runInContext(SRC, ctx);
  return { ctx, attrs, posted, storage };
}

// A protobuf-ish frame: other uuid fields (tags 0x0A, 0x12) + the leaf field (0x3A, len 36).
function frame(leaf) {
  const parts = [[0x0a, 0x24, ...enc.encode(OLD.replace('aaaa', 'cccc'))], [0x3a, 0x24, ...enc.encode(leaf)], [0x12, 0x24, ...enc.encode(OLD)]];
  const body = Uint8Array.from(parts.flat());
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

function streamOf(bytes, cuts) {
  return new ReadableStream({
    start(c) {
      let prev = 0;
      for (const cut of [...cuts, bytes.length]) { c.enqueue(bytes.slice(prev, cut)); prev = cut; }
      c.close();
    },
  });
}

test('swaps only the leaf field, even when split across chunks; same length', async () => {
  const storage = { 'cbt-jump': JSON.stringify({ conv: CONV, from: OLD, to: NEW, focus: NEW, ts: Date.now() }) };
  const orig = frame(OLD);
  let seenHeaders = null;
  const page = fakePage(storage, async (u, init) => {
    seenHeaders = init.headers;
    return new Response(streamOf(orig, [9, 50, 51]), { headers: { 'content-type': 'application/connect+proto' } });
  });
  assert.equal(storage['cbt-jump'], undefined, 'jump request is one-shot');
  assert.equal(page.attrs['data-cbt-jump'], 'pending');
  const res = await page.ctx.window.fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', {
    method: 'POST', headers: { 'content-type': 'application/connect+proto', 'connect-accept-encoding': 'gzip' },
  });
  const out = new Uint8Array(await res.arrayBuffer());
  assert.equal(out.length, orig.length, 'length unchanged');
  const text = new TextDecoder().decode(out);
  assert.ok(text.includes(NEW), 'new leaf present');
  assert.equal(text.split(OLD).length - 1, 1, 'the other field holding the old id (tag 0x12) is untouched');
  assert.equal(new Headers(seenHeaders).get('connect-accept-encoding'), null, 'asked for uncompressed frames');
  assert.equal(page.attrs['data-cbt-jump'], 'applied');
  assert.equal(JSON.parse(storage['cbt-jump-done']).to, NEW);
  assert.ok(page.posted.includes('jump-applied'));
});

test('JSON flavour is rewritten too', async () => {
  const storage = { 'cbt-jump': JSON.stringify({ conv: CONV, from: OLD, to: NEW, ts: Date.now() }) };
  const body = JSON.stringify({ update: { conversation: { currentLeafMessageId: OLD }, messages: [{ id: OLD }] } });
  const page = fakePage(storage, async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  const res = await page.ctx.window.fetch('/claudeai-rpc/x.ConversationService/ReadConversation', { method: 'POST', headers: {} });
  const j = JSON.parse(await res.text());
  assert.equal(j.update.conversation.currentLeafMessageId, NEW);
  assert.equal(j.update.messages[0].id, OLD);
});

test('no jump for another chat, stale request, or other endpoints', async () => {
  for (const req of [
    { conv: '99999999-2222-4333-8444-555555555555', from: OLD, to: NEW, ts: Date.now() },
    { conv: CONV, from: OLD, to: NEW, ts: Date.now() - 10 * 60 * 1000 },
    { conv: CONV, from: OLD, to: 'not-a-uuid', ts: Date.now() },
  ]) {
    const page = fakePage({ 'cbt-jump': JSON.stringify(req) }, async () => new Response(frame(OLD)));
    const res = await page.ctx.window.fetch('/claudeai-rpc/x.ConversationService/StreamTimeline', { method: 'POST' });
    assert.ok(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer())).includes(OLD));
    assert.equal(page.attrs['data-cbt-jump'], undefined);
  }
});

test('passive mode: signals on sends, passes responses through untouched', async () => {
  const sentinel = { tag: 'original' };
  const page = fakePage({}, async () => sentinel);
  assert.equal(await page.ctx.window.fetch('/claudeai-rpc/x.ConversationService/PerformAction', { method: 'POST' }), sentinel);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(page.posted, ['mutation-start', 'mutation-done']);
  await page.ctx.window.fetch('/claudeai-rpc/x.ConversationService/ReportViewing', { method: 'POST' });
  assert.equal(page.posted.length, 2, 'ReportViewing ignored');
  assert.equal(page.attrs['data-cbt-hook'], '2');
});

test('gzip-compressed frames (server honoured gzip anyway) are unzipped, swapped, sent on uncompressed', async () => {
  const zlib = require('node:zlib');
  const storage = { 'cbt-jump': JSON.stringify({ conv: CONV, from: OLD, to: NEW, ts: Date.now() }) };
  const plain = frame(OLD);
  const payload = zlib.gzipSync(Buffer.from(plain.slice(5)));
  const gz = new Uint8Array(5 + payload.length);
  gz[0] = 1; new DataView(gz.buffer).setUint32(1, payload.length); gz.set(payload, 5);
  const trailer = Uint8Array.from([2, 0, 0, 0, 2, 0x7b, 0x7d]); // end-of-stream "{}"
  const all = new Uint8Array(gz.length + trailer.length); all.set(gz); all.set(trailer, gz.length);
  const page = fakePage(storage, async () => new Response(streamOf(all, [3, 20]), { headers: { 'content-type': 'application/connect+proto', 'connect-content-encoding': 'gzip' } }));
  const res = await page.ctx.window.fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', { method: 'POST', headers: {} });
  assert.equal(res.headers.get('connect-content-encoding'), null);
  const out = new Uint8Array(await res.arrayBuffer());
  assert.equal(out[0], 0, 'first frame now uncompressed');
  const len = new DataView(out.buffer).getUint32(1);
  assert.equal(len, plain.length - 5);
  const text = new TextDecoder().decode(out.slice(5, 5 + len));
  assert.ok(text.includes(NEW));
  assert.deepEqual([...out.slice(5 + len)], [...trailer], 'end-of-stream frame passed through');
  assert.equal(page.attrs['data-cbt-jump'], 'applied');
});

test('page passing a Request object: gzip header is still removed', async () => {
  const storage = { 'cbt-jump': JSON.stringify({ conv: CONV, from: OLD, to: NEW, ts: Date.now() }) };
  let seen = null;
  const page = fakePage(storage, async (input) => { seen = input; return new Response(frame(OLD), { headers: { 'content-type': 'application/connect+proto' } }); });
  const req = new Request('https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', { method: 'POST', headers: { 'connect-accept-encoding': 'gzip', 'content-type': 'application/connect+proto' }, body: new Uint8Array(5) });
  const res = await page.ctx.window.fetch(req);
  assert.equal(seen.headers.get('connect-accept-encoding'), null);
  assert.equal(seen.headers.get('content-type'), 'application/connect+proto');
  assert.ok(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer())).includes(NEW));
});
