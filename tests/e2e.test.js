// End-to-end test in jsdom: a fake claude.ai page whose "‹ k/n ›" arrows really
// switch versions (re-rendering asynchronously like React), plus mocked chrome.*
// and fetch. Loads the extension's real scripts in manifest order.
// Run: node --test e2e.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDS, conversation } = require('./fixtures');

const EXT = path.resolve(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

async function setup({ toolbar = true } = {}) {
  const conv = conversation();
  const dom = new JSDOM('<!doctype html><html data-mode="dark"><body><div id="root"></div></body></html>', {
    url: 'https://claude.ai/chat/11111111-2222-4333-8444-555555555555',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  windows.push(w);
  const doc = w.document;
  w.Element.prototype.scrollIntoView = function () {};
  w.TextEncoder = TextEncoder;
  Object.defineProperty(w, 'crypto', { value: require('node:crypto').webcrypto });
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  doc.cookie = 'lastActiveOrg=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  // ---- fake claude.ai app ----
  const msgs = new Map(conv.chat_messages.map((m) => [m.uuid, m]));
  const kids = new Map();
  for (const m of conv.chat_messages) {
    const p = m.parent_message_uuid;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(m.uuid);
  }
  for (const list of kids.values()) list.sort((a, b) => Date.parse(msgs.get(a).created_at) - Date.parse(msgs.get(b).created_at));
  const choice = new Map(); // parent uuid → chosen child index (default newest, like claude.ai after reload)
  const ROOT = '00000000-0000-4000-8000-000000000000';
  function shownPath() {
    const out = [];
    let p = ROOT;
    while (kids.has(p)) {
      const list = kids.get(p);
      const i = choice.has(p) ? choice.get(p) : list.length - 1;
      p = list[i];
      out.push(p);
    }
    return out;
  }
  function renderApp() {
    const root = doc.getElementById('root');
    const tb = toolbar
      ? '<div class="relative flex-1 flex items-center shrink min-w-0"><div class="flex flex-row items-center min-w-0"><span>Trip planning</span></div></div>'
      : '';
    let html = `<header>${tb}</header><main>`;
    for (const u of shownPath()) {
      const m = msgs.get(u);
      const sibs = kids.get(m.parent_message_uuid);
      const i = sibs.indexOf(u);
      const text = m.content[0].text.replace(/\*\*/g, ''); // rendered markdown
      html += '<div class="turn">';
      html += m.sender === 'human'
        ? `<div data-testid="user-message"><p>${text}</p></div>`
        : `<div data-is-streaming="false"><div class="standard-markdown"><p>${text}</p></div></div>`;
      html += '<div class="actions"><button aria-label="Copy">c</button>';
      if (sibs.length > 1) {
        html += `<button class="prev" data-p="${m.parent_message_uuid}" ${i === 0 ? 'disabled' : ''}>‹</button>` +
          `<span>${i + 1} / ${sibs.length}</span>` +
          `<button class="next" data-p="${m.parent_message_uuid}" ${i === sibs.length - 1 ? 'disabled' : ''}>›</button>`;
      }
      html += '</div></div>';
    }
    root.innerHTML = html + '</main>';
  }
  doc.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button.prev, button.next');
    if (!b || b.disabled) return;
    const p = b.dataset.p;
    const list = kids.get(p);
    const cur = choice.has(p) ? choice.get(p) : list.length - 1;
    choice.set(p, Math.max(0, Math.min(list.length - 1, cur + (b.classList.contains('next') ? 1 : -1))));
    clicks.push(b.classList.contains('next') ? 'next' : 'prev');
    setTimeout(renderApp, 40); // React-ish async re-render
  });
  const clicks = [];
  renderApp();

  // ---- mocked chrome.* ----
  const areas = { sync: {}, local: {} };
  const listeners = { message: [], storage: [] };
  const area = (n) => ({
    async get(k) {
      if (k == null) return { ...areas[n] };
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => x in areas[n]).map((x) => [x, structuredClone(areas[n][x])]));
    },
    async set(obj) { Object.assign(areas[n], structuredClone(obj)); },
    async remove(k) { delete areas[n][k]; },
  });
  w.chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (f) => listeners.storage.push(f) } },
    runtime: {
      onMessage: { addListener: (f) => listeners.message.push(f) },
      sendMessage: (m) => sent.push(m),
      getManifest: () => manifest,
    },
  };
  const sent = [];

  // ---- mocked fetch (content-script world) ----
  const fetched = [];
  w.fetch = async (url) => {
    fetched.push(url);
    if (/chat_conversations\//.test(url)) return { ok: true, status: 200, json: async () => structuredClone(conv) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // ---- load extension scripts in manifest order ----
  for (const cs of manifest.content_scripts) {
    if (cs.world === 'MAIN') continue;
    for (const f of cs.js) w.eval(fs.readFileSync(path.join(EXT, f), 'utf8') + `\n//# sourceURL=${f}`);
  }

  const shadow = () => doc.getElementById('cbt-host').shadowRoot;
  const rows = () => [...shadow().querySelectorAll('.row')];
  const onscreen = () => rows().filter((r) => r.classList.contains('onscreen')).map((r) => name[r.dataset.uuid]);
  const rowOf = (key) => shadow().querySelector(`.row[data-uuid="${IDS[key]}"]`);
  const toggle = () => listeners.message.forEach((f) => f({ type: 'cbt-toggle' }));
  const shownNames = () => shownPath().map((u) => name[u]);
  await sleep(150); // let async init() finish (settings load)
  return { w, doc, shadow, rows, onscreen, rowOf, toggle, areas, fetched, clicks, shownNames, sent, choice, renderApp };
}

test('opens, draws the tree, highlights the branch actually on screen', async () => {
  const t = await setup();
  await sleep(100);
  assert.ok(t.doc.getElementById('cbt-toolbar-btn'), 'toolbar button injected');
  t.toggle();
  await sleep(300);
  assert.ok(t.shadow().querySelector('.panel').classList.contains('open'));
  assert.equal(t.fetched.length, 1);
  assert.match(t.fetched[0], /organizations\/aaaaaaaa-.*chat_conversations\/11111111-.*tree=True/);
  assert.equal(t.rows().length, 6, 'human-only view: 6 of your messages');
  assert.deepEqual(t.onscreen(), ['H1', 'H2b', 'H3b']);
  assert.equal(t.shadow().querySelector('.wrap').dataset.theme, 'dark');
  assert.match(t.shadow().querySelector('.sub').textContent, /6 msgs · 2 forks · 3 branches/);
});

test('clicking a row on another branch flips Claude\'s arrows to reach it', async () => {
  const t = await setup();
  t.toggle();
  await sleep(300);
  // H3c needs: user-message arrow (H2b→H2a, 1 click prev) then Claude-reply arrow (A2a2 is already newest)
  t.rowOf('H3c').click();
  await sleep(2500);
  assert.deepEqual(t.shownNames(), ['H1', 'A1', 'H2a', 'A2a2', 'H3c']);
  assert.deepEqual(t.clicks, ['prev']);
  assert.deepEqual(t.onscreen(), ['H1', 'H2a', 'H3c']);

  // H3a needs Claude's reply flipped back: A2a2 → A2a (prev)
  t.rowOf('H3a').click();
  await sleep(2500);
  assert.deepEqual(t.shownNames(), ['H1', 'A1', 'H2a', 'A2a', 'H3a']);
  assert.deepEqual(t.clicks, ['prev', 'prev']);
  assert.deepEqual(t.onscreen(), ['H1', 'H2a', 'H3a']);

  // and back to the edited branch (next on the user message)
  t.rowOf('H3b').click();
  await sleep(2500);
  assert.deepEqual(t.shownNames(), ['H1', 'A1', 'H2b', 'A2b', 'H3b', 'A3b']);
  assert.deepEqual(t.onscreen(), ['H1', 'H2b', 'H3b']);
});

test('manual arrow clicks on the page update the highlight without refetching', async () => {
  const t = await setup();
  t.toggle();
  await sleep(300);
  const n = t.fetched.length;
  t.doc.querySelector('button.prev').click(); // user flips message 2 back to v1 by hand
  await sleep(700);
  assert.deepEqual(t.onscreen(), ['H1', 'H2a', 'H3c']);
  assert.equal(t.fetched.length, n, 'no extra API call');
});

test('full mode, search, star, rename, collapse persist', async () => {
  const t = await setup();
  t.toggle();
  await sleep(300);
  t.shadow().querySelector('[data-mode="full"]').click();
  await sleep(50);
  assert.equal(t.rows().length, 11, 'full view shows Claude replies too');
  assert.equal(t.areas.sync.settings.viewMode, 'full');
  t.shadow().querySelector('[data-mode="human"]').click();
  await sleep(50);

  const search = t.shadow().querySelector('input[type="search"]');
  search.value = 'food';
  search.dispatchEvent(new t.w.Event('input'));
  await sleep(200);
  const marked = t.rows().filter((r) => r.querySelector('mark')).map((r) => name[r.dataset.uuid]);
  assert.deepEqual(marked.sort(), ['H3a', 'H3b']);
  assert.match(t.shadow().querySelector('.count').textContent, /2 hits/);
  search.value = '';
  search.dispatchEvent(new t.w.Event('input'));
  await sleep(200);

  t.rowOf('H2a').querySelector('.star').click();
  await sleep(10);
  t.rowOf('H2a').dispatchEvent(new t.w.MouseEvent('dblclick', { bubbles: true }));
  const input = t.shadow().querySelector('input.edit');
  assert.ok(input, 'rename box shown');
  input.value = 'Japan route';
  input.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(10);
  assert.equal(t.rowOf('H2a').querySelector('.lbl').textContent, 'Japan route');

  t.rowOf('H2a').querySelector('.tog').click(); // collapse H2a's sub-branches
  await sleep(10);
  assert.equal(t.rowOf('H3a'), null);
  assert.match(t.rowOf('H2a').querySelector('.hidden-n').textContent, /\+2/);

  await sleep(500); // debounced save
  const saved = Object.entries(t.areas.local).find(([k]) => k.startsWith('conv:'))[1];
  assert.equal(saved.labels[IDS.H2a], 'Japan route');
  assert.deepEqual(saved.stars, [IDS.H2a]);
  assert.deepEqual(saved.collapsed, [IDS.H2a]);
});

test('keyboard: arrows, Enter switches branch, F to focus', async () => {
  const t = await setup();
  t.toggle();
  await sleep(300);
  const body = t.shadow().querySelector('.body');
  const key = (k) => body.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('Home');
  key('ArrowDown'); // H2a
  assert.equal(name[t.shadow().querySelector('.row.selected').dataset.uuid], 'H2a');
  key('Enter');
  await sleep(2500);
  assert.equal(t.shownNames()[2], 'H2a');
  t.shadow().querySelector('.panel').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  await sleep(20);
  assert.equal(t.rowOf('H2b').querySelector('.hidden-n').textContent, '+1'); // off-screen branch folded
});

test('no toolbar found → floating launcher; diagnostics report it', async () => {
  const t = await setup({ toolbar: false });
  await sleep(100);
  assert.equal(t.doc.getElementById('cbt-toolbar-btn'), null);
  assert.ok(t.shadow().querySelector('.launcher').classList.contains('show'));
  t.shadow().querySelector('.launcher').click();
  await sleep(300);
  t.shadow().querySelector('[data-act="diag"]').click();
  const text = t.shadow().querySelector('.diag').textContent;
  assert.match(text, /Your messages on page.*3 found via \[data-testid="user-message"\]/s);
  assert.match(text, /Version arrows.*1 found/s); // only the user-message fork is on screen (A2b has no retry)
  assert.match(text, /Toolbar button.*not inserted/s);
});

test('split point not rendered → switches by reload instead', async () => {
  const t = await setup();
  t.toggle();
  await sleep(300);
  // Simulate claude.ai only rendering the last turns: remove the first 2 turns from the page.
  const turns = t.doc.querySelectorAll('.turn');
  turns[0].remove(); turns[1].remove(); turns[2].remove();
  await sleep(600);
  t.rowOf('H3c').click();
  await sleep(800);
  // No arrows reachable on the page any more → falls back to reload + local view.
  assert.match(t.shadow().querySelector('.foot .st').textContent, /Reloading onto that branch/);
  const req = JSON.parse(t.w.sessionStorage.getItem('cbt-jump'));
  assert.equal(req.to, IDS.H3c);
  assert.equal(req.from, IDS.A3b);
});

test('page hook: passes fetch through untouched and marks itself', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://claude.ai/chat/x', runScripts: 'outside-only' });
  const w = dom.window;
  windows.push(w);
  const seen = [];
  w.TextEncoder = TextEncoder;
  w.fetch = async (u, init) => ({ ok: true, tag: 'original', u, m: init && init.method });
  w.eval(fs.readFileSync(path.join(EXT, 'src/page-hook.js'), 'utf8'));
  w.addEventListener('message', (e) => seen.push(e.data.kind));
  const res = await w.fetch('/api/organizations/o/chat_conversations/c/completion', { method: 'POST' });
  await sleep(20);
  assert.equal(res.tag, 'original');
  assert.equal(w.document.documentElement.getAttribute('data-cbt-hook'), '2');
  assert.deepEqual(seen, ['mutation-start', 'mutation-done']);
  await w.fetch('/api/organizations/o/chat_conversations/c?tree=True'); // GET → no signal
  await sleep(20);
  assert.equal(seen.length, 2);
});
