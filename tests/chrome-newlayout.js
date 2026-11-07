// Real Chrome + real extension against a fake claude.ai that mimics the NEW
// layout (checked live 2026-11-07): data-cds rows with data-turn-key, no
// version arrows, and the chat loaded from a binary StreamTimeline stream whose
// current_leaf_message_id (field 7 → bytes 0x3A 0x24 + 36 chars) picks the branch.
// Network is intercepted; nothing reaches the real claude.ai.
// Run: node chrome-newlayout.js
const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { IDS, conversation } = require('./fixtures');

const EXT = path.resolve(__dirname, '../extension');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const CONV = '11111111-2222-4333-8444-555555555555';
const name = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));

// Binary "snapshot": a few uuid fields with other tags, then the leaf field.
function timelineBytes(leaf) {
  const conv = conversation();
  const parts = [];
  const str = (tag, s) => parts.push(Buffer.from([tag, s.length]), Buffer.from(s));
  str(0x0a, CONV);
  for (const m of conv.chat_messages) str(0x12, m.uuid); // message ids (incl. the leaf id, other tag)
  str(0x3a, leaf);                                        // conversation.current_leaf_message_id
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5); head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

const fakePage = () => `<!doctype html><html data-mode="dark"><head><meta charset="utf-8"><title>Claude</title>
<style>
 body{margin:0;font:15px/1.6 system-ui;background:#262624;color:#eee}
 [data-testid=chat-header]{height:48px;display:flex;align-items:center;justify-content:flex-end;padding:0 12px;border-bottom:1px solid #8884}
 [data-cds=Toolbar]>div{display:flex;gap:6px} [data-cds=Toolbar] button{background:none;border:0;color:#aaa}
 main{max-width:720px;margin:0 auto;padding:16px}
 [data-cds=UserMessage]{display:flex;flex-direction:column;align-items:flex-end;margin:18px 0 6px}
 [data-testid=user-message]{background:#8882;border-radius:12px;padding:6px 14px;max-width:80%}
 [data-cds=AssistantMessage]{display:flex;flex-direction:column;margin:6px 0 18px}
</style></head><body>
<div data-testid="chat-header"><div data-cds="Toolbar" role="toolbar"><div><button aria-label="Activity panel">▤</button><button>Share</button></div></div></div>
<div data-testid="chat-column-body"><main id="root">loading…</main></div>
<script>
const conv = ${JSON.stringify(conversation())};
const msgs = new Map(conv.chat_messages.map(m => [m.uuid, m]));
let shown = [];
function pathTo(u){ const o=[]; while(u && msgs.has(u)){ o.unshift(u); u = msgs.get(u).parent_message_uuid; } return o; }
async function load(){
  const res = await fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', {
    method:'POST', headers:{'content-type':'application/connect+proto','connect-protocol-version':'1','connect-accept-encoding':'gzip'}, body:new Uint8Array(5) });
  const buf = new Uint8Array(await res.arrayBuffer());
  let leaf = null;
  for (let i = 5; i < buf.length - 37; ) { const tag = buf[i], len = buf[i+1]; const s = new TextDecoder().decode(buf.slice(i+2, i+2+len)); if (tag === 0x3a) leaf = s; i += 2 + len; }
  shown = pathTo(leaf);
  let h = '';
  for (const u of shown) {
    const m = msgs.get(u); const t = m.content[0].text.replace(/\\*\\*/g, '');
    h += m.sender === 'human'
      ? '<div data-cds="UserMessage" data-turn-key="'+u+'"><div data-testid="user-message">'+t+'</div><div data-cds="MessageActions" data-testid="user-message-actions"><button aria-label="Retry">↻</button><button aria-label="Edit">✎</button></div></div>'
      : '<div data-cds="AssistantMessage" data-testid="assistant-message" data-turn-key="'+m.parent_message_uuid+'"><div data-cds="Prose"><p>'+t+'</p></div><div data-cds="MessageActions" data-testid="message-actions"></div></div>';
  }
  document.getElementById('root').innerHTML = h;
}
window.__shown = () => shown;
load();
</script></body></html>`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1280, height: 820 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  const calls = { tree: 0, timeline: 0, timelineGzipAsked: 0 };
  await ctx.route('https://claude.ai/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes('StreamTimeline')) {
      calls.timeline++;
      if (req.headers()['connect-accept-encoding']) calls.timelineGzipAsked++;
      return route.fulfill({ contentType: 'application/connect+proto', body: timelineBytes(IDS.A3b) });
    }
    if (url.includes('/chat_conversations/')) { calls.tree++; return route.fulfill({ json: conversation() }); }
    if (url.includes('/api/')) return route.fulfill({ json: [{ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', capabilities: ['chat'] }] });
    return route.fulfill({ contentType: 'text/html', body: fakePage() });
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  const shown = async () => (await page.evaluate(() => window.__shown())).map((u) => name[u]).join(' → ');
  const nav = (turnKey, cds) => `[data-cds="${cds}"][data-turn-key="${turnKey}"] > .cbt-vnav`;
  const step = async (label, fn) => { process.stdout.write(label.padEnd(58)); await fn(); console.log('✓'); };

  await page.goto(`https://claude.ai/chat/${CONV}`);

  await step('toolbar button sits in the new chat header', async () => {
    await page.waitForSelector('[data-testid="chat-header"] #cbt-toolbar-btn', { timeout: 8000 });
  });
  await step('latest branch shown; ‹ 2 / 2 › added under message 2', async () => {
    assert.equal(await shown(), 'H1 → A1 → H2b → A2b → H3b → A3b');
    await page.waitForSelector(nav(IDS.H2b, 'UserMessage'), { timeout: 8000 });
    assert.equal((await page.textContent(nav(IDS.H2b, 'UserMessage') + ' span')).replace('versions', '').trim(), '2 / 2');
    assert.equal(await page.locator('.cbt-vnav').count(), 1, 'only messages with versions get arrows');
  });
  await page.screenshot({ path: path.join(OUT, 'n1-latest-with-arrows.png') });

  await step('‹ on message 2 → reload shows version 1 branch', async () => {
    await Promise.all([page.waitForEvent('load'), page.click(nav(IDS.H2b, 'UserMessage') + ' button:first-child')]);
    await page.waitForSelector(`[data-turn-key="${IDS.H2a}"]`, { timeout: 8000 });
    assert.equal(await shown(), 'H1 → A1 → H2a → A2a2 → H3c');
    assert.equal(await page.getAttribute('html', 'data-cbt-jump'), 'applied');
  });
  await step('banner + arrows on message 2 (1/2) and on the retried reply (2/2)', async () => {
    await page.waitForSelector('#cbt-banner', { timeout: 8000 });
    await page.waitForSelector(nav(IDS.H2a, 'AssistantMessage'), { timeout: 8000 });
    assert.equal((await page.textContent(nav(IDS.H2a, 'UserMessage') + ' span')).replace('versions', '').trim(), '1 / 2');
    assert.equal((await page.textContent(nav(IDS.H2a, 'AssistantMessage') + ' span')).replace('versions', '').trim(), '2 / 2');
  });
  await page.screenshot({ path: path.join(OUT, 'n2-jumped.png') });

  await step("‹ on Claude's retried reply → reload shows reply version 1", async () => {
    await Promise.all([page.waitForEvent('load'), page.click(nav(IDS.H2a, 'AssistantMessage') + ' button:first-child')]);
    await page.waitForSelector(`[data-turn-key="${IDS.H3a}"]`, { timeout: 8000 });
    assert.equal(await shown(), 'H1 → A1 → H2a → A2a → H3a');
  });
  await step('panel highlights the branch actually on screen', async () => {
    await page.click('#cbt-toolbar-btn');
    await page.waitForSelector('#cbt-host .row', { timeout: 8000 });
    await page.waitForTimeout(400);
    const on = await page.evaluate(() => [...document.querySelector('#cbt-host').shadowRoot.querySelectorAll('.row.onscreen')].map((r) => r.dataset.uuid));
    assert.deepEqual(on.map((u) => name[u]), ['H1', 'H2a', 'H3a']);
    const st = await page.evaluate(() => document.querySelector('#cbt-host').shadowRoot.querySelector('.foot .st').textContent);
    assert.match(st, /older branch/);
  });
  await page.screenshot({ path: path.join(OUT, 'n3-panel-jumped.png') });

  await step('panel click on a latest-branch row → plain reload to latest', async () => {
    await Promise.all([page.waitForEvent('load'), page.click(`#cbt-host .row[data-uuid="${IDS.H3b}"]`)]);
    await page.waitForSelector(`[data-turn-key="${IDS.H3b}"]`, { timeout: 8000 });
    assert.equal(await shown(), 'H1 → A1 → H2b → A2b → H3b → A3b');
    assert.equal(await page.getAttribute('html', 'data-cbt-jump'), null);
    assert.equal(await page.locator('#cbt-banner').count(), 0);
  });
  await step('"Back to latest" button returns to the latest branch', async () => {
    await Promise.all([page.waitForEvent('load'), page.click(nav(IDS.H2b, 'UserMessage') + ' button:first-child')]);
    await page.waitForSelector('#cbt-banner button:not(.sec)', { timeout: 8000 });
    await Promise.all([page.waitForEvent('load'), page.click('#cbt-banner button:not(.sec)')]);
    await page.waitForSelector(`[data-turn-key="${IDS.H2b}"]`, { timeout: 8000 });
    assert.equal(await shown(), 'H1 → A1 → H2b → A2b → H3b → A3b');
  });
  await step('a manual reload after a switch goes back to latest', async () => {
    await Promise.all([page.waitForEvent('load'), page.click(nav(IDS.H2b, 'UserMessage') + ' button:first-child')]);
    await page.waitForSelector(`[data-turn-key="${IDS.H2a}"]`, { timeout: 8000 });
    await page.reload();
    await page.waitForSelector(`[data-turn-key="${IDS.H2b}"]`, { timeout: 8000 });
  });
  await step('all-branches export downloads', async () => {
    await page.click('#cbt-toolbar-btn').catch(() => {});
    if (!(await page.evaluate(() => document.querySelector('#cbt-host').shadowRoot.querySelector('.panel').classList.contains('open')))) await page.click('#cbt-toolbar-btn');
    await page.waitForSelector('#cbt-host .row', { timeout: 8000 });
    await page.click('#cbt-host [data-act="menu"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cbt-host [data-act="dl-all"]')]);
    const p = await dl.path();
    const md = fs.readFileSync(p, 'utf8');
    assert.equal((md.match(/^# Branch /gm) || []).length, 3);
  });

  await step('vault saved this chat and its page lists it', async () => {
    const v = await ctx.newPage();
    await v.goto(sw.url().replace('src/background.js', `vault/vault.html?conv=${CONV}`));
    await v.waitForSelector('.chat', { timeout: 8000 });
    await v.click('[data-tab="reply"]');
    await v.waitForSelector('.ver', { timeout: 8000 });
    const n = await v.locator('.ver').count();
    assert.ok(n >= 5, `expected replies from every branch, got ${n}`);
    await v.locator('[data-act="preview"]').first().click();
    await v.waitForSelector('pre.preview');
    await v.screenshot({ path: path.join(OUT, 'n4-vault.png') });
    await v.close();
  });

  console.log(`\nAPI: ${calls.tree} tree fetches, ${calls.timeline} timeline loads (${calls.timelineGzipAsked} still asking for gzip — expected only on non-switch loads)`);
  console.log('page errors:', errors.length ? errors : 'none');
  await ctx.close();
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
