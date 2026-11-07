// Unit tests for src/vault.js + src/zip.js. Run: node --test vault.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
global.CBT = {};
const T = require('../extension/src/tree.js');
CBT.tree = T;
const V = require('../extension/src/vault.js');
const Z = require('../extension/src/zip.js');

const ROOT = '00000000-0000-4000-8000-000000000000';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (m) => new Date(Date.UTC(2026, 10, 7, 9, m)).toISOString();
const OUT = '/mnt/user-data/outputs/pet.md';
const tool = (name, input) => ({ type: 'tool_use', name, input });
// You: "doc about cats" → Claude writes pet.md, then edits it.
// You (edited): "doc about dogs" → Claude writes pet.md again (overwrites on claude.ai).
function data() {
  return {
    name: 'Pets', updated_at: at(30), current_leaf_message_uuid: id(4),
    chat_messages: [
      { uuid: id(1), sender: 'human', parent_message_uuid: ROOT, created_at: at(1), content: [{ type: 'text', text: 'doc about cats' }],
        files_v2: [{ file_uuid: 'f-111', file_name: 'cat.png', file_kind: 'image' }],
        attachments: [{ file_name: 'notes.txt', file_type: 'text/plain', extracted_content: 'my notes' }] },
      { uuid: id(2), sender: 'assistant', parent_message_uuid: id(1), created_at: at(2), content: [
        { type: 'text', text: 'Writing it.' },
        tool('create_file', { path: OUT, file_text: '# Cats\nCats are great.' }),
        tool('str_replace', { path: OUT, old_str: 'great', new_str: 'independent' }),
        tool('present_files', { filepaths: [OUT, '/mnt/user-data/outputs/pet.docx'] }),
        tool('artifacts', { id: 'poem', command: 'create', title: 'Cat poem', type: 'text/markdown', content: 'Purr' }),
        tool('artifacts', { id: 'poem', command: 'update', old_str: 'Purr', new_str: 'Purr purr' }),
        { type: 'text', text: 'Done.' },
      ] },
      { uuid: id(3), sender: 'human', parent_message_uuid: ROOT, created_at: at(10), content: [{ type: 'text', text: 'doc about dogs' }] },
      { uuid: id(4), sender: 'assistant', parent_message_uuid: id(3), created_at: at(11), content: [
        tool('create_file', { path: OUT, file_text: '# Dogs\nDogs are loyal.' }),
        tool('str_replace', { path: OUT, old_str: 'NOT THERE', new_str: 'x' }),
        tool('present_files', { filepaths: ['/mnt/user-data/outputs/pet.docx'] }),
      ] },
    ],
  };
}
const build = () => { const d = data(); return { d, tree: T.buildTree(d.chat_messages, d.current_leaf_message_uuid) }; };

test('every branch keeps its own version of an overwritten file', () => {
  const { d, tree } = build();
  const { docs, presented } = V.extractDocVersions(tree, d);
  const pet = docs.filter((x) => x.path === OUT);
  assert.equal(pet.length, 2, 'one version per writing message');
  assert.equal(pet.find((x) => x.msg === id(2)).text, '# Cats\nCats are independent.', 'edit replayed');
  const dogs = pet.find((x) => x.msg === id(4));
  assert.equal(dogs.text, '# Dogs\nDogs are loyal.');
  assert.equal(dogs.partial, true, 'failed edit flagged, text kept');
  const poem = docs.find((x) => x.path === 'artifact:poem');
  assert.equal(poem.text, 'Purr purr');
  assert.equal(poem.name, 'Cat poem');
  const pres = presented.map((p) => `${p.msg.slice(-1)}:${p.path.split('/').pop()}`).sort();
  assert.deepEqual(pres, ['2:pet.docx', '2:pet.md', '4:pet.docx', '4:pet.md']);
});

test('tool name prefixes and Claude-Code style tools are understood', () => {
  assert.deepEqual(V.toolOp(tool('mcp__fs__write', { file_path: '/a', content: 'x' })), { op: 'set', path: '/a', text: 'x' });
  assert.equal(V.toolOp(tool('edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).op, 'replace');
  assert.equal(V.toolOp(tool('bash', { command: 'ls' })), null);
  assert.equal(V.toolOp({ type: 'text', text: 'hi' }), null);
});

test('uploads and replies are extracted', () => {
  const { d, tree } = build();
  const ups = V.extractUploads(tree, d);
  assert.deepEqual(ups.map((u) => u.name).sort(), ['cat.png', 'notes.txt']);
  assert.equal(ups.find((u) => u.name === 'notes.txt').text, 'my notes');
  const reps = V.extractReplies(tree);
  assert.equal(reps.length, 1, 'a reply made only of tool calls has no text to keep');
});

test('branch labels match the all-branches numbering', () => {
  const { tree } = build();
  const L = T.branchLabels(tree);
  assert.equal(L.get(id(2)), 'Branch 1');
  assert.equal(L.get(id(4)), 'Branch 2');
});

test('capture: saves docs, downloads files once, dedupes blobs, survives re-runs', async () => {
  const store = {};
  global.chrome = { storage: { local: {
    async get(k) { if (k == null) return { ...store }; return Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, JSON.parse(JSON.stringify(store[x]))])); },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); },
  } } };
  const fetched = [];
  global.fetch = async (url) => {
    fetched.push(url);
    const body = url.includes('pet.docx') ? 'DOCX-BYTES' : url.includes('f-111') ? 'PNG-BYTES' : null;
    if (!body) return { ok: false, status: 404, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': url.includes('docx') ? 'application/vnd.openxmlformats' : 'image/png' }), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  const { d, tree } = build();
  const L = T.branchLabels(tree);
  const opts = { convUuid: 'c-1', orgId: 'org-1', saveReplies: true, branchOf: (u) => L.get(u) };
  const r1 = await V.capture(tree, d, opts);
  assert.equal(r1.error, undefined);
  const conv = store['vault:c:c-1'];
  const kinds = conv.items.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {});
  assert.deepEqual(kinds, { doc: 3, reply: 1, upload: 2, file: 1 });
  // pet.docx: only the newest writer (branch 2) can be on disk → downloaded once
  assert.equal(fetched.filter((u) => u.includes('pet.docx')).length, 1);
  assert.ok(fetched.some((u) => u === '/api/organizations/org-1/conversations/c-1/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fpet.docx'));
  assert.ok(fetched.some((u) => u === '/api/organizations/org-1/files/f-111/contents'));
  assert.ok(!fetched.some((u) => u.includes('pet.md')), 'text file already rebuilt from history, not downloaded');
  assert.equal(conv.items.find((i) => i.kind === 'file').branch, 'Branch 2');
  assert.equal(store['vault:index']['c-1'].items, 7);
  // re-run: nothing new, no downloads
  const before = fetched.length;
  const r2 = await V.capture(tree, d, { ...opts, force: true });
  assert.equal(r2.added, 0);
  assert.equal(fetched.length, before);
});

test('zip opens in a real unzip tool with correct contents', () => {
  const enc = new TextEncoder();
  const zip = Z.makeZip([
    { name: 'documents/pet — msg1 Branch 1.md', bytes: enc.encode('# Cats') },
    { name: 'documents/pet — msg1 Branch 1.md', bytes: enc.encode('# dup') },
    { name: 'files/ünïcode.txt', bytes: enc.encode('x'.repeat(5000)) },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const f = path.join(dir, 'a.zip');
  fs.writeFileSync(f, zip);
  const out = execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); [print(i.filename, len(z.read(i))) for i in z.infolist()]`, f]).toString();
  assert.match(out, /^None/);
  assert.match(out, /pet — msg1 Branch 1\.md 6/);
  assert.match(out, /pet — msg1 Branch 1 \(2\)\.md 5/);
  assert.match(out, /ünïcode\.txt 5000/);
});

test('live claude.ai format (2026-11): Write + SendUserFile + files[] per branch', async () => {
  const H = (n, parent, m, text, extra) => ({ uuid: id(n), sender: 'human', parent_message_uuid: parent, created_at: at(m), content: [{ type: 'text', text }], files: [], ...extra });
  const A = (n, parent, m, file, fileUuid) => ({
    uuid: id(n), sender: 'assistant', parent_message_uuid: parent, created_at: at(m),
    content: [
      { type: 'tool_use', id: 't' + n, name: 'Write', input: { file_path: `/home/claude/${file}`, content: `about ${file}` } },
      { type: 'tool_result', tool_use_id: 't' + n, content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_use', id: 's' + n, name: 'SendUserFile', input: { files: [`/home/claude/${file}`], status: 'normal', display: 'attach' } },
      { type: 'tool_result', tool_use_id: 's' + n, content: [{ type: 'text', text: 'sent' }] },
      { type: 'text', text: 'Here it is.' },
    ],
    files: [{ file_uuid: fileUuid, uuid: fileUuid, file_name: file, file_kind: 'blob', download_source: 'files-api', size_bytes: 10, success: true, created_at: at(m) }],
  });
  const d = { name: 'Live', updated_at: at(40), current_leaf_message_uuid: id(14), chat_messages: [
    H(10, ROOT, 1, 'dogs please'), A(11, id(10), 2, 'dogs.md', 'fu-dogs'),
    H(12, ROOT, 5, 'cats please'), A(13, id(12), 6, 'cats.md', 'fu-cats'),
    H(14, id(13), 7, 'look at this', { files: [{ file_uuid: 'fu-img', file_name: 'moon.png', file_kind: 'image', success: true }] }),
  ] };
  const tree = T.buildTree(d.chat_messages, d.current_leaf_message_uuid);
  const { docs, presented } = V.extractDocVersions(tree, d);
  assert.deepEqual(docs.map((x) => x.name).sort(), ['cats.md', 'dogs.md']);
  assert.equal(presented.length, 2);
  const files = V.extractUploads(tree, d);
  assert.deepEqual(files.map((f) => `${f.kind}:${f.name}`).sort(), ['file:cats.md', 'file:dogs.md', 'upload:moon.png']);

  const store = {};
  global.chrome = { storage: { local: {
    async get(k) { return Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, JSON.parse(JSON.stringify(store[x]))])); },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); },
  } } };
  const fetched = [];
  global.fetch = async (url) => {
    fetched.push(url);
    return { ok: url.includes('/files/'), status: url.includes('/files/') ? 200 : 404, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode('bytes of ' + url).buffer };
  };
  const L = T.branchLabels(tree);
  const r = await V.capture(tree, d, { convUuid: 'c-live', orgId: 'o', saveReplies: false, branchOf: (u) => L.get(u) });
  assert.equal(r.failed, 0);
  assert.deepEqual(fetched.sort(), ['/api/organizations/o/files/fu-cats/contents', '/api/organizations/o/files/fu-dogs/contents', '/api/organizations/o/files/fu-img/contents'], 'no wiggle calls: every share has its own copy');
  const items = store['vault:c:c-live'].items;
  const dogsFile = items.find((i) => i.kind === 'file' && i.name === 'dogs.md');
  assert.equal(dogsFile.branch, 'Branch 1');
  assert.equal(dogsFile.mime, 'text/markdown');
  assert.equal(items.find((i) => i.kind === 'file' && i.name === 'cats.md').branch, 'Branch 2');
});
