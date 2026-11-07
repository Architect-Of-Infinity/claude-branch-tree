// Unit tests for src/tree.js. Run: node --test tree.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const T = require(path.resolve(process.argv[2] || '../extension/src/tree.js'));
const { IDS, TEXT, conversation } = require('./fixtures');

const name = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));
const names = (arr) => arr.map((u) => name[u]);
const tree = () => { const c = conversation(); return T.buildTree(c.chat_messages, c.current_leaf_message_uuid); };
const R = (...keys) => keys.map((k) => ({ role: k[0] === 'H' ? 'human' : 'assistant', text: TEXT[k] }));

test('structure, versions, turns, stats', () => {
  const tr = tree();
  assert.deepEqual(names(tr.roots), ['H1']);
  assert.deepEqual(names(tr.nodes.get(IDS.A1).children), ['H2a', 'H2b']); // sorted by time, not array order
  assert.equal(tr.nodes.get(IDS.H2b).versionIndex, 1);
  assert.equal(tr.nodes.get(IDS.H2b).versionCount, 2);
  assert.equal(tr.nodes.get(IDS.A2a2).versionIndex, 1);
  assert.equal(tr.nodes.get(IDS.H3b).turn, 3);
  assert.equal(tr.nodes.get(IDS.A3b).turn, 3);
  assert.deepEqual(T.stats(tr), { messages: 11, human: 6, assistant: 5, forks: 2, leaves: 3, maxTurn: 3 });
  assert.deepEqual(names(tr.serverPath), ['H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b']);
});

test('human-only display skips Claude and merges across retries', () => {
  const tr = tree();
  assert.deepEqual(names(T.displayRoots(tr, 'human')), ['H1']);
  assert.deepEqual(names(T.displayChildren(tr, IDS.H1, 'human')), ['H2a', 'H2b']);
  assert.deepEqual(names(T.displayChildren(tr, IDS.H2a, 'human')), ['H3a', 'H3c']);
  assert.deepEqual(names(T.displayChildren(tr, IDS.H2a, 'full')), ['A2a', 'A2a2']);
});

test('on-screen branch = the edited branch (matches server leaf)', () => {
  const v = T.detectVisiblePath(tree(), R('H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b'));
  assert.equal(v.source, 'dom');
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b']);
  assert.equal(v.confidence, 1);
  assert.equal(v.mapping.get(IDS.H2b), 2);
});

test('on-screen branch differs from server leaf; duplicate text resolved by ancestors', () => {
  const v = T.detectVisiblePath(tree(), R('H1', 'A1', 'H2a', 'A2a', 'H3a'));
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2a', 'A2a', 'H3a']); // not H3b despite identical text
  assert.equal(v.mapping.get(IDS.A2a), 3, "Claude's reply mapped to its element (needed for retry arrows)");
  assert.equal(v.mapping.get(IDS.A1), 1);
});

test("Claude's retry version detected even with a 'Thought process' header above it", () => {
  const rendered = R('H1', 'A1', 'H2a', 'A2a2', 'H3c');
  rendered[3].text = 'Thought process\nPlanning answer…\n\n' + TEXT.A2a2;
  const v = T.detectVisiblePath(tree(), rendered);
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2a', 'A2a2', 'H3c']);
});

test('markdown on screen vs raw API text still matches', () => {
  assert.equal(T.matchText(TEXT.H1, 'Hello there, I want to plan a trip for next year'), true);
  assert.equal(T.matchText('abc', 'abd'), false);
  assert.equal(T.matchText('', ''), false);
});

test('partially rendered page (only last turns) still anchors', () => {
  const v = T.detectVisiblePath(tree(), R('A2a2', 'H3c'));
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2a', 'A2a2', 'H3c']);
});

test('just-sent message not in tree yet → anchors on the previous one', () => {
  const rendered = [...R('H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b'), { role: 'human', text: 'brand new question' }];
  const v = T.detectVisiblePath(tree(), rendered);
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b']);
});

test('nothing rendered → server fallback', () => {
  const v = T.detectVisiblePath(tree(), []);
  assert.equal(v.source, 'server');
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b']);
});

test('firstDivergence tells which arrow to press and how far', () => {
  const tr = tree();
  const d = T.firstDivergence(tr, tr.serverPath, IDS.H3c);
  assert.equal(d.depth, 2);
  assert.equal(name[d.wanted], 'H2a');
  assert.equal(name[d.current], 'H2b');
  assert.equal(d.wantedIndex, 0);
  assert.equal(d.currentIndex, 1);
  assert.equal(T.firstDivergence(tr, tr.serverPath, IDS.H3b), null);
});

test('search, ancestors, exports', () => {
  const tr = tree();
  const hits = T.search(tr, 'FOOD', {});
  assert.deepEqual(names([...hits]).sort(), ['H3a', 'H3b']);
  assert.equal(T.search(tr, 'my label', { [IDS.H2b]: 'My label here' }).size, 1);
  const anc = T.withAncestors(tr, hits);
  assert.ok(anc.has(IDS.H1) && anc.has(IDS.A2a));
  const md = T.branchToMarkdown(tr, tr.serverPath, 'Trip');
  assert.match(md, /## You \(v2\/2\)/);
  assert.match(md, /bibimbap/);
  const outline = T.outlineToMarkdown(tr, 'human', { [IDS.H2b]: 'Korea route' }, 'Trip', 40);
  assert.match(outline, /Korea route/);
  assert.match(outline, /◆/);
});

test('orphans and cycles do not crash or vanish', () => {
  const c = conversation();
  c.chat_messages.push({ uuid: 'orphan', sender: 'human', parent_message_uuid: 'missing', created_at: '2026-11-01T11:00:00Z', text: 'legacy text field' });
  const tr = T.buildTree(c.chat_messages, 'not-a-real-leaf');
  assert.ok(tr.roots.includes('orphan'));
  assert.equal(tr.nodes.get('orphan').text, 'legacy text field');
  assert.ok(tr.serverPath.length > 0); // fell back to newest leaf
  // cycle
  const cyc = T.buildTree([
    { uuid: 'a', sender: 'human', parent_message_uuid: 'b', created_at: '2026-01-01T00:00:00Z', content: [] },
    { uuid: 'b', sender: 'assistant', parent_message_uuid: 'a', created_at: '2026-01-01T00:01:00Z', content: [] },
  ], null);
  assert.ok(T.pathTo(cyc, 'a').length <= 2);
});

test('performance: 3000-message chat builds and matches quickly', () => {
  const msgs = [];
  let parent = '00000000-0000-4000-8000-000000000000';
  for (let i = 0; i < 3000; i++) {
    const uuid = 'm' + i;
    msgs.push({ uuid, sender: i % 2 ? 'assistant' : 'human', parent_message_uuid: parent, created_at: new Date(1e12 + i * 1000).toISOString(), content: [{ type: 'text', text: `message number ${i} with some text` }] });
    parent = uuid;
  }
  const t0 = performance.now();
  const tr = T.buildTree(msgs, parent);
  const rendered = msgs.slice(-200).map((m) => ({ role: m.sender, text: m.content[0].text }));
  const v = T.detectVisiblePath(tr, rendered);
  const ms = performance.now() - t0;
  assert.equal(v.path.length, 3000);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

test('exact mode: page gives message ids (new claude.ai layout)', () => {
  const tr = tree();
  const rendered = [
    { role: 'human', uuid: IDS.H1, text: 'x' }, { role: 'assistant', turnKey: IDS.H1, text: 'y' },
    { role: 'human', uuid: IDS.H2a, text: 'x' }, { role: 'assistant', turnKey: IDS.H2a, text: '' },
    { role: 'human', uuid: IDS.H3c, text: 'x' },
  ];
  const v = T.detectVisiblePath(tr, rendered);
  assert.equal(v.exact, true);
  assert.deepEqual(names(v.path), ['H1', 'A1', 'H2a', 'A2a2', 'H3c']);
  assert.equal(v.mapping.get(IDS.A2a2), 3, 'reply between your messages mapped via turnKey');
  assert.equal(v.mapping.get(IDS.A1), 1);
});

test('exact mode: last-turn retry version chosen from the jump hint', () => {
  const tr = tree();
  const rendered = [
    { role: 'human', uuid: IDS.H1, text: 'x' }, { role: 'assistant', turnKey: IDS.H1, text: '' },
    { role: 'human', uuid: IDS.H2a, text: 'x' }, { role: 'assistant', turnKey: IDS.H2a, text: '' },
  ];
  assert.deepEqual(names(T.detectVisiblePath(tr, rendered, IDS.H3a).path), ['H1', 'A1', 'H2a', 'A2a']);
  assert.deepEqual(names(T.detectVisiblePath(tr, rendered, IDS.H3c).path), ['H1', 'A1', 'H2a', 'A2a2']);
});

test('exact mode: a just-sent message not in the tree yet is ignored', () => {
  const tr = tree();
  const rendered = [
    { role: 'human', uuid: IDS.H1, text: 'x' }, { role: 'assistant', turnKey: IDS.H1, text: '' },
    { role: 'human', uuid: '99999999-0000-4000-8000-000000000000', text: 'new' },
  ];
  assert.deepEqual(names(T.detectVisiblePath(tr, rendered).path), ['H1', 'A1']);
});

test('latestLeafOf picks the newest descendant (what a switch shows)', () => {
  const tr = tree();
  assert.equal(name[T.latestLeafOf(tr, IDS.H2a)], 'H3c');
  assert.equal(name[T.latestLeafOf(tr, IDS.A2a)], 'H3a');
});

test('all-branches export: every branch once, shared history not repeated', () => {
  const tr = tree();
  const md = T.allBranchesToMarkdown(tr, 'Trip', { [IDS.H2b]: 'Korea route' });
  assert.equal((md.match(/^# Branch /gm) || []).length, 3);
  assert.equal((md.match(/Hello there/g) || []).length, 1, 'first message written once');
  assert.match(md, /same as Branch 1/);
  assert.match(md, /Korea route/);
  assert.match(md, /latest on server/);
});

test('metro layout: first child continues the line, siblings branch right, lanes are reused', () => {
  global.CBT = global.CBT || {};
  require('../extension/src/panel.js');
  const L = global.CBT.layoutLanes;
  // A → B, A → C (fork), B → D ; order: A, B, D, C
  const rows = [{ uuid: 'A', kids: ['B', 'C'] }, { uuid: 'B', kids: ['D'] }, { uuid: 'D', kids: [] }, { uuid: 'C', kids: [] }];
  const on = (p, c) => c !== 'C';
  const lay = L(rows, on);
  assert.deepEqual(lay.rows.map((r) => r.lane), [0, 0, 0, 1]);
  assert.equal(lay.lanes, 2);
  const kinds = (i) => lay.rows[i].segs.map((s) => `${s.k}${s.lane}${s.on ? '+' : ''}`).sort().join(' ');
  assert.equal(kinds(0), 'elbow1 out0+');   // A: down to B (on screen), branch right to C (off)
  assert.equal(kinds(1), 'in0+ out0+ pass1'); // C's line passes beside B
  assert.equal(kinds(2), 'in0+ pass1');
  assert.equal(kinds(3), 'in1');
});
