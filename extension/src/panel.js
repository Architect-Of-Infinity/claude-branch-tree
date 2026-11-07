// panel.js — the floating panel UI (inside a Shadow DOM). It only draws
// app.state and forwards clicks/keys to app.* methods (defined in content.js).
//
// The tree is drawn like a metro map / git graph: every message is a stop, the
// first child of a stop continues straight down its line, other children branch
// off to the right onto their own line. The branch on screen is drawn bold.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function appendHighlighted(parent, text, q) {
    if (!q) { parent.appendChild(document.createTextNode(text)); return; }
    const lower = text.toLowerCase();
    let i = 0;
    for (;;) {
      const j = lower.indexOf(q, i);
      if (j < 0) break;
      if (j > i) parent.appendChild(document.createTextNode(text.slice(i, j)));
      parent.appendChild(h('mark', null, text.slice(j, j + q.length)));
      i = j + q.length;
    }
    if (i < text.length) parent.appendChild(document.createTextNode(text.slice(i)));
  }

  // Preview centred on the first search hit, so the match is actually visible.
  function previewAround(text, q, len) {
    const T = CBT.tree;
    const flat = T.preview(text, 100000);
    if (!q) return T.preview(text, len);
    const j = flat.toLowerCase().indexOf(q);
    if (j < 0 || j < len / 2) return T.preview(text, len);
    return '…' + T.preview(flat.slice(Math.max(0, j - 15)), len);
  }

  // ---------- metro-map layout ----------
  // rows: [{ uuid|null(pseudo start), kids:[uuids shown] }] in display order.
  // Returns per-row { lane, segs:[...] } and the number of lanes used.
  function layoutLanes(rows, isOn) {
    const rowOf = new Map(rows.map((r, i) => [r.uuid, i]));
    const active = [];               // lane → { child, on } edge waiting to reach `child`
    const out = rows.map(() => ({ lane: 0, segs: [] }));
    let maxLane = 0;
    const freeLaneRightOf = (l) => { let k = l + 1; while (active[k]) k++; return k; };
    rows.forEach((r, i) => {
      // lane of this row = where an edge is waiting for it (roots: lane 0 or a free one)
      let lane = active.findIndex((e) => e && e.child === r.uuid);
      let incoming = null;
      if (lane >= 0) { incoming = active[lane]; active[lane] = null; }
      else { lane = 0; while (active[lane]) lane++; }
      out[i].lane = lane;
      // lines passing through this row
      active.forEach((e, l) => { if (e) out[i].segs.push({ k: 'pass', lane: l, on: e.on }); });
      if (incoming) out[i].segs.push({ k: 'in', lane, on: incoming.on });
      // edges to this row's children (only those actually drawn)
      const kids = r.kids.filter((c) => rowOf.has(c));
      kids.forEach((c, n) => {
        const on = isOn(r.uuid, c);
        if (n === 0) { active[lane] = { child: c, on }; out[i].segs.push({ k: 'out', lane, on }); }
        else {
          const l = freeLaneRightOf(lane);
          active[l] = { child: c, on };
          out[i].segs.push({ k: 'elbow', from: lane, lane: l, on });
          maxLane = Math.max(maxLane, l);
        }
      });
      maxLane = Math.max(maxLane, lane);
    });
    return { rows: out, lanes: maxLane + 1 };
  }

  const ICON = (n) => CBT.ICONS[n];

  CBT.createPanel = function createPanel(app) {
    const T = CBT.tree;
    const LW = CBT.LANE_W, DY = CBT.DOT_Y;

    const host = document.createElement('div');
    host.id = 'cbt-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CBT.PANEL_CSS}</style>
<div class="wrap">
  <button class="launcher" title="Branch Tree (Alt+B)" aria-label="Open Branch Tree">${ICON('branch')}<span>Branches</span></button>
  <div class="panel" role="dialog" aria-label="Branch tree">
    <div class="hdr">
      <div class="logo">${ICON('branch')}</div>
      <div class="ttl"><div class="k">Branch Tree</div><div class="name">No chat open</div><div class="sub"></div></div>
      <div class="hbtns">
        <button class="ic" data-act="refresh" title="Refresh (R)" aria-label="Refresh">${ICON('refresh')}</button>
        <button class="ic" data-act="menu" title="Export, vault & more" aria-label="More">${ICON('more')}</button>
        <button class="ic" data-act="close" title="Close (Esc)" aria-label="Close">${ICON('close')}</button>
      </div>
    </div>
    <div class="menu" hidden role="menu">
      <div class="mh">Export</div>
      <button data-act="copy-branch">${ICON('copy')}Copy on-screen branch<small>.md</small></button>
      <button data-act="dl-branch">${ICON('file')}Download on-screen branch<small>.md</small></button>
      <button data-act="dl-all">${ICON('layers')}Download every branch<small>.md</small></button>
      <button data-act="dl-outline">${ICON('list')}Download tree outline<small>.md</small></button>
      <button data-act="dl-json">${ICON('code')}Download raw data<small>.json</small></button>
      <div class="mh">Document vault</div>
      <button data-act="vault-open">${ICON('vault')}Open the vault</button>
      <button data-act="vault-now">${ICON('save')}Save this chat's documents now</button>
      <div class="mh">More</div>
      <button data-act="help">${ICON('help')}Shortcuts &amp; legend<small>?</small></button>
      <button data-act="diag">${ICON('pulse')}Diagnostics</button>
      <button data-act="options">${ICON('gear')}Settings</button>
    </div>
    <div class="ctl">
      <div class="seg" role="radiogroup" aria-label="What to show">
        <button data-act="mode" data-mode="human" role="radio" title="Only your messages (M)">Yours</button>
        <button data-act="mode" data-mode="full" role="radio" title="Your messages and Claude's replies (M)">All</button>
      </div>
      <label class="search">${ICON('search')}<input type="search" placeholder="Search messages & labels" aria-label="Search (/)"></label>
      <span class="count"></span>
      <button class="ic" data-act="starred" title="Only starred" aria-label="Only starred">${ICON('star')}</button>
      <button class="ic" data-act="focus" title="Focus on the branch on screen (F)" aria-label="Focus">${ICON('target')}</button>
      <button class="ic" data-act="expand" title="Expand all" aria-label="Expand all">${ICON('expand')}</button>
      <button class="ic" data-act="collapse" title="Fold all forks" aria-label="Fold all">${ICON('collapse')}</button>
    </div>
    <div class="intro" hidden>
      <h4>Every version of this chat, as a map</h4>
      <ol>
        <li><b>Orange line</b> = the branch on screen. Grey lines = other versions.</li>
        <li><b>Click a stop</b> to jump there. If it's on another branch, the chat reloads onto it (this tab only).</li>
        <li>Use the <b>‹ 2/3 ›</b> arrows under messages in the chat to flip versions.</li>
        <li>The <b>vault</b> keeps every branch's documents and files, even after you edit.</li>
      </ol>
      <div class="row2"><button class="btn" data-act="intro-ok">Got it</button></div>
    </div>
    <div class="body" tabindex="0" role="tree" aria-label="Conversation branches"></div>
    <div class="diag" hidden></div>
    <div class="foot">
      <span class="st"></span>
      <button class="fbtn" data-act="vault-open" title="Document vault">${ICON('vault')}Vault</button>
      <button class="fbtn" data-act="help" title="Shortcuts & legend (?)" aria-label="Help">${ICON('help')}</button>
    </div>
    <div class="toast" role="status"></div>
    ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="rz ${d}" data-dir="${d}"></div>`).join('')}
  </div>
</div>`;
    document.body.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    const wrap = $('.wrap'), panel = $('.panel'), body = $('.body'), diag = $('.diag'), intro = $('.intro');
    const menu = $('.menu'), searchInput = $('.search input');
    const statusEl = $('.foot .st'), subEl = $('.sub'), nameEl = $('.ttl .name'), countEl = $('.count'), toastEl = $('.toast');
    const launcher = $('.launcher');

    let flat = [];
    let renaming = null;
    let renderQueued = false;
    let clickTimer = null;

    for (const type of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(type, (e) => e.stopPropagation());

    function setTheme(dark) { wrap.dataset.theme = dark ? 'dark' : 'light'; }

    // ---------- rendering ----------

    function render() {
      if (renaming) { renderQueued = true; return; }
      renderQueued = false;
      const s = app.state;
      const scroll = body.scrollTop;
      body.textContent = '';
      for (const b of shadow.querySelectorAll('[data-act="mode"]')) {
        const on = b.dataset.mode === s.settings.viewMode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      $('[data-act="starred"]').classList.toggle('on', !!s.starredOnly);
      nameEl.textContent = s.convUuid ? (s.data && s.data.name) || 'Untitled chat' : 'No chat open';
      intro.hidden = !(s.tree && !s.introSeen);

      if (!s.tree) {
        subEl.textContent = ''; countEl.textContent = ''; flat = [];
        if (s.convUuid && /Loading/.test(s.emptyMessage || '')) {
          body.innerHTML = '<div class="skel"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
        } else {
          body.innerHTML = `<div class="empty">${ICON('branch')}<b>${s.convUuid ? 'Nothing to show yet' : 'Open a chat'}</b></div>`;
          body.querySelector('.empty').appendChild(document.createTextNode(s.emptyMessage || 'Branches of the chat you open appear here.'));
        }
        return;
      }

      const tree = s.tree;
      const mode = s.settings.viewMode;
      const q = s.search.trim().toLowerCase();
      const labels = s.conv.labels;

      let show = null;
      if (q) {
        const hits = T.search(tree, q, labels);
        countEl.textContent = hits.size ? `${hits.size} hit${hits.size > 1 ? 's' : ''}` : 'none';
        show = T.withAncestors(tree, hits);
        show.hits = hits;
      } else countEl.textContent = '';
      if (s.starredOnly) {
        const stars = T.withAncestors(tree, [...s.conv.stars].filter((u) => tree.nodes.has(u)));
        const hits = show && show.hits;
        show = show ? new Set([...show].filter((u) => stars.has(u))) : stars;
        show.hits = hits || new Set([...s.conv.stars].filter((u) => tree.nodes.has(u)));
      }
      const filtering = !!show;

      const st = T.stats(tree);
      subEl.textContent = `${st.human} msgs · ${st.forks} fork${st.forks === 1 ? '' : 's'} · ${st.leaves} branch${st.leaves === 1 ? '' : 'es'}`;

      const sp = tree.serverPath;
      let tip = sp[sp.length - 1];
      if (mode !== 'full') for (let i = sp.length - 1; i >= 0; i--) if (tree.nodes.get(sp[i]).sender === 'human') { tip = sp[i]; break; }
      const vp = s.visible.path.filter((u) => mode === 'full' || tree.nodes.get(u).sender === 'human');
      const here = vp[vp.length - 1];

      // Depth-first order; record which children are drawn (for the lines).
      flat = [];
      const roots = T.displayRoots(tree, mode).filter((u) => !show || show.has(u));
      if (roots.length > 1) flat.push({ uuid: null, kids: roots }); // "start of chat" stop joins several first messages
      const stack = roots.slice().reverse();
      while (stack.length) {
        const u = stack.pop();
        const kidsAll = T.displayChildren(tree, u, mode).filter((c) => !show || show.has(c));
        const collapsed = !filtering && kidsAll.length > 0 && s.conv.collapsed.has(u);
        const item = { uuid: u, kids: collapsed ? [] : kidsAll, nKids: kidsAll.length, collapsed };
        flat.push(item);
        if (!collapsed) for (let i = kidsAll.length - 1; i >= 0; i--) stack.push(kidsAll[i]);
      }

      const isOn = (p, c) => s.visibleSet.has(c) && (p == null || s.visibleSet.has(p));
      const lay = layoutLanes(flat, isOn);
      const railW = lay.lanes * LW + 12;

      const frag = document.createDocumentFragment();
      flat.forEach((item, i) => frag.appendChild(buildRow(item, lay.rows[i], railW, { tree, mode, q, labels, show, tip, here })));
      if (!flat.length) {
        const e = h('div', 'empty');
        e.innerHTML = `${ICON('search')}<b>No matches</b>`;
        e.appendChild(document.createTextNode(filtering ? 'Try another word, or clear the filter.' : '(empty conversation)'));
        frag.appendChild(e);
      }
      body.appendChild(frag);
      body.scrollTop = scroll;
    }

    function buildRail(geo, railW, dotCls) {
      const rail = h('div', 'rail');
      rail.style.width = railW + 'px';
      const x = (l) => 10 + l * LW;
      // muted lines first, on-screen lines on top
      for (const sgm of geo.segs.slice().sort((a, b) => a.on - b.on)) {
        if (sgm.k === 'elbow') {
          const e = h('div', 'elb' + (sgm.on ? ' on' : ''));
          e.style.left = x(sgm.from) + 'px';
          e.style.top = DY - 1 + 'px';
          e.style.width = x(sgm.lane) - x(sgm.from) + (sgm.on ? 1.5 : 1) + 'px';
          e.style.bottom = '0';
          rail.appendChild(e);
          continue;
        }
        const l = h('div', 'seg-l' + (sgm.on ? ' on' : ''));
        l.style.left = x(sgm.lane) - (sgm.on ? 1.5 : 1) + 'px';
        if (sgm.k === 'pass') { l.style.top = '0'; l.style.bottom = '0'; }
        else if (sgm.k === 'in') { l.style.top = '0'; l.style.height = DY + 'px'; }
        else { l.style.top = DY + 'px'; l.style.bottom = '0'; }
        rail.appendChild(l);
      }
      const d = h('span', 'dot' + dotCls);
      const size = /here/.test(dotCls) ? 14 : 10;
      d.style.left = x(geo.lane) - size / 2 + 'px';
      d.style.top = DY - size / 2 + 'px';
      rail.appendChild(d);
      return rail;
    }

    function buildRow(item, geo, railW, ctx) {
      const s = app.state;
      const { tree, mode, q, labels, show, tip, here } = ctx;

      if (item.uuid == null) { // "start of chat"
        const row = h('div', 'row start');
        row.appendChild(buildRail(geo, railW, ' on'));
        const m = h('div', 'main');
        m.appendChild(h('span', 'txt', 'Start of chat — the first message was edited'));
        row.appendChild(m);
        return row;
      }

      const u = item.uuid;
      const n = tree.nodes.get(u);
      const onScreen = s.visibleSet.has(u);
      const row = h('div', 'row');
      row.dataset.uuid = u;
      row.setAttribute('role', 'treeitem');
      if (n.sender === 'assistant') row.classList.add('assistant');
      if (onScreen) row.classList.add('onscreen');
      if (s.selected === u) row.classList.add('selected');
      if (show && show.hits && !show.hits.has(u)) row.classList.add('dim');
      if (item.nKids) row.setAttribute('aria-expanded', String(!item.collapsed));

      row.appendChild(buildRail(geo, railW,
        (onScreen ? ' on' : '') + (u === here ? ' here' : '') + (n.sender === 'assistant' ? ' bot' : '') + (item.collapsed ? ' col' : '')));

      const m = h('div', 'main');
      if (item.nKids) {
        const tog = h('span', 'tog has' + (item.collapsed ? ' closed' : ''));
        tog.innerHTML = ICON('chevron');
        tog.title = item.collapsed ? 'Unfold' : 'Fold what comes after';
        m.appendChild(tog);
      }
      if (n.sender === 'human') m.appendChild(h('span', 'num', String(n.turn)));
      else m.appendChild(h('span', 'chip claude', 'Claude'));
      const ver = T.versionTag(n);
      if (ver) {
        const c = h('span', 'chip ver', ver);
        c.title = `Version ${n.versionIndex + 1} of ${n.versionCount}`;
        m.appendChild(c);
      }
      if (mode !== 'full' && n.sender === 'human' && n.parent) {
        const p = tree.nodes.get(n.parent);
        if (p.sender === 'assistant' && p.versionCount > 1) {
          const c = h('span', 'chip', `↻${p.versionIndex + 1}/${p.versionCount}`);
          c.title = `Follows version ${p.versionIndex + 1} of ${p.versionCount} of Claude's reply (Retry)`;
          m.appendChild(c);
        }
      }
      if (u === tip) {
        const d = h('span', 'chip latest', '◆');
        d.title = "Latest branch on claude.ai's server (a page reload opens this)";
        m.appendChild(d);
      }
      const txt = h('span', 'txt');
      const label = labels[u];
      if (label) { const l = h('span', 'lbl'); appendHighlighted(l, label, q); txt.appendChild(l); }
      if (!label || s.settings.previewLength > 0) {
        const pv = h('span', 'pv');
        appendHighlighted(pv, previewAround(n.text, q, s.settings.previewLength) || (n.hasFiles ? '(files only)' : '(no text)'), q);
        txt.appendChild(pv);
      }
      m.appendChild(txt);
      if (item.collapsed) m.appendChild(h('span', 'chip hidden-n', '+' + countHidden(tree, u, mode)));
      if (s.settings.showTimestamps && n.created) m.appendChild(h('span', 'time', shortTime(n.created)));
      if (s.conv.stars.has(u)) m.appendChild(h('span', 'starred', '★'));
      row.appendChild(m);

      const acts = h('div', 'acts');
      const star = h('button', 'rowact star' + (s.conv.stars.has(u) ? ' on' : ''));
      star.innerHTML = ICON('star'); star.title = s.conv.stars.has(u) ? 'Unstar (S)' : 'Star (S)'; star.type = 'button';
      const ren = h('button', 'rowact rename');
      ren.innerHTML = ICON('pencil'); ren.title = 'Label (F2)'; ren.type = 'button';
      const go = h('button', 'rowact go');
      go.innerHTML = ICON('go'); go.title = onScreen ? 'Scroll to it' : 'Switch to this branch'; go.type = 'button';
      acts.append(star, ren, go);
      row.appendChild(acts);

      row.title = (n.text ? T.preview(n.text, 300) + '\n\n' : '') + (n.created ? new Date(n.created).toLocaleString() : '') +
        (onScreen ? ' · on screen' : ' · click to switch to this branch');
      return row;
    }

    function countHidden(tree, u, mode) {
      let c = 0;
      const st = T.displayChildren(tree, u, mode);
      while (st.length) { const x = st.pop(); c++; st.push(...T.displayChildren(tree, x, mode)); }
      return c;
    }

    function shortTime(ms) {
      const d = new Date(ms);
      return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function select(uuid, scroll) {
      app.state.selected = uuid;
      for (const r of body.querySelectorAll('.row.selected')) r.classList.remove('selected');
      const row = body.querySelector(`.row[data-uuid="${uuid}"]`);
      if (row) { row.classList.add('selected'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
    }
    function scrollToRow(uuid) {
      const row = body.querySelector(`.row[data-uuid="${uuid}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
    }

    // ---------- rename ----------

    function startRename(uuid) {
      const row = body.querySelector(`.row[data-uuid="${uuid}"]`);
      if (!row || renaming) return;
      renaming = uuid;
      const txt = row.querySelector('.txt');
      const n = app.state.tree.nodes.get(uuid);
      const input = document.createElement('input');
      input.className = 'edit';
      input.value = app.state.conv.labels[uuid] || '';
      input.placeholder = 'Label… (' + (T.preview(n.text, 40) || 'empty') + ')';
      input.maxLength = 200;
      txt.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        renaming = null;
        if (commit) app.setLabel(uuid, input.value.trim());
        render();
        body.focus();
        select(uuid, true);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      for (const t of ['click', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
    }

    // ---------- events ----------

    body.addEventListener('click', (e) => {
      const row = e.target.closest('.row[data-uuid]');
      if (!row) return;
      const u = row.dataset.uuid;
      if (e.target.closest('.tog.has')) { app.toggleCollapse(u); return; }
      if (e.target.closest('.rowact.star')) { app.toggleStar(u); return; }
      if (e.target.closest('.rowact.rename')) { select(u); startRename(u); return; }
      if (e.target.closest('.rowact.go')) { select(u); app.goTo(u); return; }
      select(u);
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => app.goTo(u), 230);
    });
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row[data-uuid]');
      if (!row || e.target.closest('.tog,.acts')) return;
      clearTimeout(clickTimer);
      startRename(row.dataset.uuid);
    });

    body.addEventListener('keydown', (e) => {
      const rows = flat.filter((f) => f.uuid);
      if (renaming || !rows.length) return;
      const s = app.state;
      const i = rows.findIndex((f) => f.uuid === s.selected);
      const cur = rows[i];
      const go = (j) => { j = Math.max(0, Math.min(rows.length - 1, j)); select(rows[j].uuid, true); };
      switch (e.key) {
        case 'ArrowDown': go(i < 0 ? 0 : i + 1); break;
        case 'ArrowUp': go(i < 0 ? 0 : i - 1); break;
        case 'Home': go(0); break;
        case 'End': go(rows.length - 1); break;
        case 'PageDown': go(i + 10); break;
        case 'PageUp': go(i - 10); break;
        case 'ArrowRight':
          if (!cur) go(0);
          else if (cur.collapsed) app.toggleCollapse(cur.uuid);
          else if (cur.nKids) go(i + 1);
          break;
        case 'ArrowLeft': {
          if (!cur) break;
          if (cur.nKids && !cur.collapsed) { app.toggleCollapse(cur.uuid); break; }
          let p = s.tree.nodes.get(cur.uuid).parent;
          while (p && !rows.some((f) => f.uuid === p)) p = s.tree.nodes.get(p).parent;
          if (p) select(p, true);
          break;
        }
        case 'Enter': if (cur) app.goTo(cur.uuid); break;
        case 'F2': if (cur) startRename(cur.uuid); break;
        case 's': case 'S': if (cur) app.toggleStar(cur.uuid); break;
        default: return;
      }
      e.preventDefault();
    });

    panel.addEventListener('keydown', (e) => {
      const typing = e.target.matches && e.target.matches('input');
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!menu.hidden) { menu.hidden = true; return; }
        if (!diag.hidden) { showTree(); return; }
        if (app.state.search) { searchInput.value = ''; app.setSearch(''); body.focus(); return; }
        app.close();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === '/') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
      else if (e.key === '?') showHelp();
      else if (k === 'm') app.toggleMode();
      else if (k === 'f') app.focusVisible();
      else if (k === 'r') app.refresh(true);
    });

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => app.setSearch(searchInput.value), 120);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        body.focus();
        const first = body.querySelector('.row[data-uuid]:not(.dim)');
        if (first) select(first.dataset.uuid, true);
      }
    });

    shadow.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) { if (!e.target.closest('.menu')) menu.hidden = true; return; }
      const act = b.dataset.act;
      if (act !== 'menu') menu.hidden = true;
      switch (act) {
        case 'menu': menu.hidden = !menu.hidden; break;
        case 'close': app.close(); break;
        case 'refresh': app.refresh(true); break;
        case 'mode': if (b.dataset.mode !== app.state.settings.viewMode) app.toggleMode(); break;
        case 'starred': app.setStarredOnly(!app.state.starredOnly); break;
        case 'focus': app.focusVisible(); break;
        case 'expand': app.expandAll(); break;
        case 'collapse': app.collapseAll(); break;
        case 'intro-ok': app.dismissIntro(); break;
        case 'diag': showDiag(app.diagnostics()); break;
        case 'help': showHelp(); break;
        case 'back': showTree(); break;
        case 'copy-diag': navigator.clipboard.writeText(JSON.stringify(app.diagnostics(), null, 2)).then(() => toast('Copied'), () => toast('Copy failed')); break;
        default: app.menuAction(act);
      }
    });
    launcher.addEventListener('click', () => app.toggle());

    // ---------- help / diagnostics views ----------

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function showHtml(html) {
      diag.innerHTML = '<button class="linkbtn" data-act="back">← Back to the map</button>' + html;
      diag.hidden = false;
      body.style.display = 'none';
      intro.hidden = true;
    }
    function showTree() {
      diag.hidden = true;
      body.style.display = '';
      render();
      body.focus();
    }
    function showHelp() {
      showHtml(`
<h3>Reading the map</h3>
<table>
<tr><td><b style="color:var(--accent)">Orange line</b></td><td>The branch on screen right now. The big dot is where you are</td></tr>
<tr><td>Grey lines</td><td>Other versions. Click any stop to switch there</td></tr>
<tr><td><b>3</b></td><td>Your 3rd message on that branch</td></tr>
<tr><td><span class="chip ver">v2/3</span></td><td>Version 2 of 3 of that message (you edited it)</td></tr>
<tr><td><span class="chip">↻2/3</span></td><td>Follows version 2 of 3 of Claude's reply (you pressed Retry)</td></tr>
<tr><td><span style="color:var(--gold)">◆</span></td><td>Latest branch on claude.ai's server: what a page reload shows</td></tr>
</table>
<h3 style="margin-top:14px">Switching</h3>
<p style="margin:0;color:var(--ink-2)">claude.ai's new layout has no version arrows and won't switch branches on its server, so the extension reloads the chat and shows the branch you picked, <b>in this tab only</b>. A normal reload goes back to the latest. To continue an older branch, <b>Edit</b> one of its messages.</p>
<h3 style="margin-top:14px">Keyboard</h3>
<table>
<tr><td><kbd>Alt</kbd>+<kbd>B</kbd></td><td>Open / close (change at chrome://extensions/shortcuts)</td></tr>
<tr><td><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></td><td>Move · fold / unfold</td></tr>
<tr><td><kbd>Enter</kbd></td><td>Go to the message</td></tr>
<tr><td><kbd>F2</kbd> / double-click</td><td>Label it</td></tr>
<tr><td><kbd>S</kbd></td><td>Star</td></tr>
<tr><td><kbd>/</kbd> · <kbd>M</kbd> · <kbd>F</kbd> · <kbd>R</kbd></td><td>Search · yours/all · focus · refresh</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Clear search, close menu, close panel</td></tr>
</table>`);
    }
    function showDiag(d) {
      const rows = Object.entries(d.checks)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="${v.ok ? 'ok' : 'bad'}">${v.ok ? '✓' : '✗'} ${esc(v.detail)}</td></tr>`).join('');
      showHtml(`<h3>Diagnostics</h3><table>${rows}</table>
        <p style="margin:10px 0 6px;color:var(--ink-2)">If something shows ✗ after claude.ai changes its layout, copy this and paste it to Claude with <code>src/dom.js</code>.</p>
        <button class="linkbtn" data-act="copy-diag">Copy as JSON</button>
        <pre>${esc(JSON.stringify(d, null, 2))}</pre>`);
    }

    // ---------- status / toast ----------

    function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = 'st' + (kind ? ' ' + kind : ''); }
    let toastTimer = null;
    function toast(text, ms = 2200) {
      toastEl.textContent = text;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
    }

    // ---------- open / close ----------

    function open() { panel.classList.add('open'); clampIntoView(); setTimeout(() => body.focus({ preventScroll: true }), 60); }
    function close() { panel.classList.remove('open'); menu.hidden = true; }
    const isOpen = () => panel.classList.contains('open');
    function showLauncher(on) { launcher.classList.toggle('show', !!on); }

    // ---------- drag + resize ----------

    const MIN_W = 320, MIN_H = 260;
    function applyGeo(g) {
      panel.style.left = g.left + 'px'; panel.style.top = g.top + 'px';
      panel.style.width = g.width + 'px'; panel.style.height = g.height + 'px';
      panel.style.right = 'auto';
    }
    function currentGeo() {
      const r = panel.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
    function clampIntoView() {
      if (!panel.style.left) return;
      const g = currentGeo();
      g.width = Math.min(Math.max(MIN_W, g.width), window.innerWidth - 8);
      g.height = Math.min(Math.max(MIN_H, g.height), window.innerHeight - 8);
      g.left = Math.min(Math.max(0, g.left), window.innerWidth - 120);
      g.top = Math.min(Math.max(0, g.top), window.innerHeight - 40);
      applyGeo(g);
    }
    window.addEventListener('resize', clampIntoView);
    function startPointer(e, onMove) {
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, g: currentGeo() };
      const move = (ev) => onMove(ev.clientX - start.x, ev.clientY - start.y, start.g);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.documentElement.style.userSelect = '';
        clampIntoView();
        app.saveGeometry(currentGeo());
      };
      document.documentElement.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    $('.hdr').addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      startPointer(e, (dx, dy, g) => applyGeo({ ...g, left: g.left + dx, top: g.top + dy }));
    });
    for (const rz of shadow.querySelectorAll('.rz')) {
      rz.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const dir = rz.dataset.dir;
        startPointer(e, (dx, dy, g) => {
          const n = { ...g };
          if (dir.includes('e')) n.width = Math.max(MIN_W, g.width + dx);
          if (dir.includes('s')) n.height = Math.max(MIN_H, g.height + dy);
          if (dir.includes('w')) { n.width = Math.max(MIN_W, g.width - dx); n.left = g.left + g.width - n.width; }
          if (dir.includes('n')) { n.height = Math.max(MIN_H, g.height - dy); n.top = g.top + g.height - n.height; }
          applyGeo(n);
        });
      });
    }
    function restoreGeometry(g) { if (g && g.width >= MIN_W && g.height >= MIN_H) { applyGeo(g); clampIntoView(); } }

    return {
      host, render, select, scrollToRow, setStatus, toast, open, close, isOpen,
      setTheme, showLauncher, restoreGeometry,
      isRenaming: () => !!renaming,
      flushRender: () => { if (renderQueued) render(); },
      setSearchBox: (v) => { searchInput.value = v; },
    };
  };

  CBT.layoutLanes = layoutLanes; // exported for tests
})(typeof globalThis !== 'undefined' ? globalThis : this);
