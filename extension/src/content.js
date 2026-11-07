// content.js — the controller. Owns the state, wires page events, API, storage
// and the panel together. Loaded last (see manifest.json).
(function () {
  'use strict';
  const CBT = globalThis.CBT;
  const T = CBT.tree, dom = CBT.dom, api = CBT.api, store = CBT.storage;
  if (window.top !== window) return; // never run inside iframes (artifacts etc.)
  if (document.getElementById('cbt-host')) return; // already injected

  const state = {
    settings: { ...CBT.DEFAULT_SETTINGS },
    convUuid: null,
    data: null,               // raw API response
    tree: null,
    signature: '',            // cheap "did anything change?" fingerprint
    visible: { path: [], mapping: new Map(), source: 'none', confidence: 0 },
    visibleSet: new Set(),
    rendered: [],             // last dom.collectRendered() result (mapping indexes point here)
    conv: { labels: {}, stars: new Set(), collapsed: new Set() },
    search: '',
    starredOnly: false,
    selected: null,
    emptyMessage: '',
    lastSync: 0,
    switching: false,
    jump: null,               // { to, focus, status: 'applied'|'missed', focused } after a reload-switch
    introSeen: true,          // first-run guide in the panel (loaded at start-up)
  };

  let panel = null;

  // ---------- conversation-scoped data ----------

  async function loadConvData(uuid) {
    try {
      const d = await store.loadConv(uuid);
      state.conv = { labels: d.labels || {}, stars: new Set(d.stars || []), collapsed: new Set(d.collapsed || []) };
    } catch (_) {
      state.conv = { labels: {}, stars: new Set(), collapsed: new Set() };
    }
  }
  function persistConv() {
    if (!state.convUuid) return;
    try {
      store.saveConv(state.convUuid, {
        labels: state.conv.labels, stars: [...state.conv.stars], collapsed: [...state.conv.collapsed],
      });
    } catch (_) { /* extension was reloaded; page needs a refresh */ }
  }

  // ---------- loading ----------

  function sigOf(data) {
    const m = data.chat_messages || [];
    return `${m.length}|${data.current_leaf_message_uuid}|${data.updated_at}|${m.length ? m[m.length - 1].uuid : ''}`;
  }

  let refreshing = null;
  async function refresh(userAsked) {
    if (!state.convUuid) {
      state.tree = null; state.data = null; state.signature = '';
      state.emptyMessage = 'Open a chat (claude.ai/chat/…) to see its branches.';
      panel.setStatus('');
      panel.render();
      return;
    }
    if (refreshing) return refreshing;
    const uuid = state.convUuid;
    refreshing = (async () => {
      if (!state.tree || userAsked) panel.setStatus('Loading…', 'busy');
      try {
        const data = await api.fetchConversation(uuid);
        if (uuid !== state.convUuid) return; // user navigated away meanwhile
        const sig = sigOf(data);
        state.lastSync = Date.now();
        if (sig !== state.signature || !state.tree) {
          state.data = data;
          state.signature = sig;
          state.tree = T.buildTree(data.chat_messages, data.current_leaf_message_uuid);
          state.emptyMessage = '';
          recomputeVisible(false);
          panel.render();
          if (userAsked || !state.selected) revealOnScreenTip();
        }
        focusAfterJump();
        updateStatus();
        if (userAsked) panel.toast('Up to date');
        if (state.settings.vaultAuto && !dom.isStreaming()) vaultCapture(false);
      } catch (e) {
        if (uuid !== state.convUuid) return;
        const msg = e.status === 404 ? 'Chat not found (deleted, or not saved yet).' : `Couldn't load the tree: ${e.message}`;
        if (!state.tree) { state.emptyMessage = msg; panel.render(); }
        panel.setStatus(msg, 'warn');
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // ---------- document vault ----------
  async function vaultCapture(force) {
    if (!state.tree || !state.data || !CBT.vault) return null;
    const labels = T.branchLabels(state.tree);
    const report = await CBT.vault.capture(state.tree, state.data, {
      convUuid: state.convUuid,
      orgId: await api.getOrgId(),
      saveReplies: state.settings.vaultReplies,
      branchOf: (u) => labels.get(u) || '',
      force,
    });
    state.lastVault = report;
    if (report && (report.added || report.failed) && (force || panel.isOpen())) {
      panel.toast(`Vault: ${report.added} new item${report.added === 1 ? '' : 's'} saved${report.failed ? `, ${report.failed} file${report.failed === 1 ? '' : 's'} couldn't be downloaded` : ''}`, 3500);
    } else if (force && report) panel.toast('Vault: already up to date');
    return report;
  }

  function revealOnScreenTip() {
    const p = state.visible.path;
    const tip = [...p].reverse().find((u) => state.settings.viewMode === 'full' || state.tree.nodes.get(u).sender === 'human');
    if (tip) { panel.select(tip); panel.scrollToRow(tip); }
  }

  // The tree is needed while the panel is open, or for the in-chat arrows.
  const needTree = () => !!state.convUuid && (panel.isOpen() || state.settings.inlineArrows);

  let refetchTimer = null;
  function scheduleRefetch(ms) {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => { if (needTree()) refresh(false); }, ms);
  }

  // ---------- which branch is on screen ----------

  function recomputeVisible(rerender) {
    if (!state.tree) return false;
    state.rendered = dom.collectRendered();
    const hint = state.jump && state.jump.status === 'applied' ? state.jump.to : null;
    const vis = T.detectVisiblePath(state.tree, state.rendered.map((r) => ({ role: r.role, text: r.text, uuid: r.uuid, turnKey: r.turnKey })), hint);
    const changed = vis.path.join() !== state.visible.path.join();
    state.visible = vis;
    state.visibleSet = new Set(vis.path);
    if (changed && rerender) { panel.render(); updateStatus(); }
    injectInlineNavs();
    return changed;
  }

  // Our own "‹ k/n ›" under every message that has other versions (claude.ai's
  // new layout removed its own). Idempotent — runs after every page change.
  function injectInlineNavs() {
    if (!state.settings.inlineArrows || !state.tree || state.visible.source !== 'dom') {
      dom.removeStaleNavs(new Set());
      return;
    }
    const keep = new Set();
    for (const [uuid, idx] of state.visible.mapping) {
      const n = state.tree.nodes.get(uuid);
      const r = state.rendered[idx];
      if (!n || !r || n.versionCount < 2) continue;
      // Skip if claude.ai shows its own arrows for this message (older layout).
      if (dom.versionControlFor(r.el, state.rendered)) continue;
      const sibs = T.siblingsOf(state.tree, uuid);
      const at = sibs.indexOf(uuid);
      const pv = (u) => (u ? T.preview(state.tree.nodes.get(u).text, 70) || '(no text)' : '');
      keep.add(dom.upsertVersionNav(r.el, uuid, n.versionIndex + 1, n.versionCount,
        (step) => goToSibling(uuid, step), n.sender === 'human', { prev: pv(sibs[at - 1]), next: pv(sibs[at + 1]) }));
    }
    dom.removeStaleNavs(keep);
  }

  function goToSibling(uuid, step) {
    if (!state.tree) return;
    const sibs = T.siblingsOf(state.tree, uuid);
    const target = sibs[sibs.indexOf(uuid) + step];
    if (target) app.goTo(target);
  }

  // ---------- switching by reload + local view (claude.ai's new layout) ----------

  function jumpTo(target) {
    const tree = state.tree;
    const from = state.data && state.data.current_leaf_message_uuid;
    const to = T.latestLeafOf(tree, target);
    if (!from || !tree.nodes.has(from)) {
      panel.toast("Can't switch: claude.ai didn't say which branch is current.", 5000);
      return;
    }
    if (state.settings.confirmSwitch && !window.confirm('Reload this chat showing the other branch? (Only this tab; nothing on your account changes.)')) return;
    try {
      if (to === from) sessionStorage.setItem('cbt-focus', JSON.stringify({ conv: state.convUuid, focus: target, ts: Date.now() }));
      else sessionStorage.setItem('cbt-jump', JSON.stringify({ conv: state.convUuid, from, to, focus: target, ts: Date.now() }));
    } catch (_) {
      panel.toast("Can't switch: this tab blocks session storage.", 5000);
      return;
    }
    panel.setStatus('Reloading onto that branch…', 'busy');
    const n = tree.nodes.get(target);
    dom.pageToast(to === from ? 'Going back to the latest branch…'
      : `Switching to ${n.sender === 'human' ? 'version' : "Claude's reply version"} ${n.versionIndex + 1} of ${n.versionCount}…`);
    location.reload();
  }

  // Called at start-up and whenever the page hook reports on a jump.
  function checkJump() {
    const attr = document.documentElement.getAttribute('data-cbt-jump');
    let done = null;
    try { done = JSON.parse(sessionStorage.getItem('cbt-jump-done') || 'null'); } catch (_) {}
    let focusOnly = null;
    try { focusOnly = JSON.parse(sessionStorage.getItem('cbt-focus') || 'null'); sessionStorage.removeItem('cbt-focus'); } catch (_) {}
    if (focusOnly && focusOnly.conv === state.convUuid && Date.now() - focusOnly.ts < 60000) {
      state.jump = { status: 'latest', focus: focusOnly.focus, focused: false };
    }
    if (!done || done.conv !== state.convUuid || Date.now() - done.ts > 60000) return;
    if (attr !== 'applied' && attr !== 'missed') return;
    try { sessionStorage.removeItem('cbt-jump-done'); } catch (_) {}
    if (done.missed) {
      state.jump = null;
      dom.showBranchBar("<b>Couldn't switch branch</b>", "claude.ai may have changed how chats load. You're on the latest branch. Panel → ⋯ → Diagnostics.", [{ text: 'Dismiss', secondary: true, onClick: () => dom.hideBanner() }], true);
      return;
    }
    state.jump = { status: 'applied', to: done.to, focus: done.focus, focused: false };
    showJumpBanner();
  }

  function showJumpBanner() {
    dom.showBranchBar(
      '<b>Viewing an older branch</b> · only in this tab',
      'To continue from here, Edit a message on this branch. A new message at the bottom may go to the latest branch.',
      [
        { text: 'Show map', secondary: true, onClick: () => { if (!panel.isOpen()) app.open(); } },
        { text: 'Back to latest', onClick: () => { try { sessionStorage.removeItem('cbt-jump'); } catch (_) {} dom.pageToast('Going back to the latest branch…'); location.reload(); } },
      ]
    );
  }

  function focusAfterJump() {
    if (!state.jump || state.jump.focused || !state.tree || state.visible.source !== 'dom') return;
    const idx = state.visible.mapping.get(state.jump.focus);
    if (idx == null) return;
    state.jump.focused = true;
    setTimeout(() => dom.flash(state.rendered[idx].el), 300);
    if (panel.isOpen()) { panel.select(state.jump.focus); panel.scrollToRow(state.jump.focus); }
  }

  function updateStatus() {
    if (!state.tree) return;
    const v = state.visible;
    const ago = state.lastSync ? Math.round((Date.now() - state.lastSync) / 1000) : null;
    const synced = ago == null ? '' : ago < 5 ? ' · synced just now' : ` · synced ${ago}s ago`;
    if (state.jump && state.jump.status === 'applied') {
      panel.setStatus(`On screen: an older branch (local view in this tab)${synced}`);
      return;
    }
    if (v.source === 'dom') {
      const pct = Math.round(v.confidence * 100);
      panel.setStatus(`On screen: matched from the page${pct < 100 ? ` (${pct}% of turns checked)` : ''}${synced}`, pct < 50 ? 'warn' : '');
    } else {
      panel.setStatus(`Couldn't read the page — highlighting the server's latest branch${synced}`, 'warn');
    }
  }

  // ---------- go to / switch branch ----------

  function scrollToMessage(uuid) {
    recomputeVisible(true);
    const idx = state.visible.mapping.get(uuid);
    const r = idx != null ? state.rendered[idx] : null;
    if (r) { dom.flash(r.el); return true; }
    panel.toast("That message isn't loaded on the page yet. Scroll up in the chat, then click again.", 4500);
    return false;
  }

  function hoverReveal(el) {
    // claude.ai may only render the ‹ › arrows while the message is hovered.
    for (const t of [el, el.parentElement]) {
      if (!t) continue;
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
        try { t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true })); } catch (_) {}
      }
    }
  }

  async function switchBranch(target) {
    // New layout (exact ids on the page, no native arrows): reload-switch.
    if (state.visible.exact || !dom.findCounters().length) { jumpTo(target); return; }
    if (state.settings.confirmSwitch && !window.confirm('Switch the chat to this branch? (Same as clicking Claude\'s ‹ › arrows.)')) return;
    state.switching = true;
    panel.setStatus('Switching branch…', 'busy');
    let lastKey = '', stuck = 0;
    try {
      for (let step = 0; step < 60; step++) {
        recomputeVisible(false);
        const div = T.firstDivergence(state.tree, state.visible.path, target);
        if (!div) {
          panel.render();
          updateStatus();
          scrollToMessage(target);
          panel.toast(step ? 'Switched branch' : 'Already on screen');
          return;
        }
        if (state.visible.source !== 'dom') throw new Error("Can't read the chat on the page, so can't switch. See ⋯ → Diagnostics.");
        const curUuid = div.current;
        const r = curUuid != null ? state.rendered[state.visible.mapping.get(curUuid)] : null;
        if (!r) throw new Error("The message where this branch splits off isn't loaded on the page. Scroll up in the chat and try again.");

        hoverReveal(r.el);
        const ctl = dom.versionControlFor(r.el, state.rendered);
        if (!ctl) { state.switching = false; jumpTo(target); return; } // no native arrows here → reload-switch

        // Trust Claude's own "k / n" counter for where we are now.
        const delta = div.wantedIndex - (ctl.cur - 1);
        const key = `${div.depth}:${ctl.cur}`;
        stuck = key === lastKey ? stuck + 1 : 0;
        lastKey = key;
        if (stuck >= 2) throw new Error('The arrows did not respond. Try clicking them once by hand, then retry.');
        if (delta === 0) {
          // Counter says we're there but the page text hasn't caught up yet.
          await dom.waitForSettle(300, 1500);
          continue;
        }
        const btn = delta > 0 ? ctl.next : ctl.prev;
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
          throw new Error(`Claude's ${delta > 0 ? 'next' : 'previous'} arrow is disabled — the page shows ${ctl.cur}/${ctl.total}, the tree expects ${div.siblingCount} versions.`);
        }
        dom.realClick(btn);
        await dom.waitForSettle(250, 2500);
      }
      throw new Error('Gave up after 60 arrow clicks.');
    } catch (e) {
      panel.setStatus(e.message, 'warn');
      panel.toast(e.message, 6000);
      setTimeout(updateStatus, 8000); // keep the error readable, then go back to normal
    } finally {
      state.switching = false;
      recomputeVisible(false);
      panel.render();
    }
  }

  // ---------- app (what the panel calls) ----------

  const app = {
    state,
    toggle() { panel.isOpen() ? app.close() : app.open(); },
    open() {
      panel.open();
      ensureLauncher();
      // Tree may already be loaded for the in-chat arrows; don't refetch it right away.
      const fresh = state.tree && Date.now() - state.lastSync < 15000;
      (fresh ? Promise.resolve() : refresh(false)).then(() => { recomputeVisible(true); panel.render(); updateStatus(); revealOnScreenTip(); });
    },
    close() { panel.close(); },
    refresh(userAsked) { return refresh(userAsked); },
    goTo(uuid) {
      if (!state.tree || state.switching) return;
      state.selected = uuid;
      recomputeVisible(true);
      if (state.visibleSet.has(uuid)) scrollToMessage(uuid);
      else switchBranch(uuid);
    },
    toggleCollapse(uuid) {
      const c = state.conv.collapsed;
      c.has(uuid) ? c.delete(uuid) : c.add(uuid);
      persistConv();
      panel.render();
    },
    expandAll() { state.conv.collapsed.clear(); persistConv(); panel.render(); },
    collapseAll() {
      if (!state.tree) return;
      const mode = state.settings.viewMode;
      for (const u of state.tree.nodes.keys()) {
        if (T.displayChildren(state.tree, u, mode).length > 1) state.conv.collapsed.add(u);
      }
      persistConv(); panel.render();
    },
    focusVisible() {
      if (!state.tree) return;
      recomputeVisible(false);
      const mode = state.settings.viewMode;
      state.conv.collapsed.clear();
      for (const u of state.tree.nodes.keys()) {
        if (!state.visibleSet.has(u) && T.displayChildren(state.tree, u, mode).length) state.conv.collapsed.add(u);
      }
      persistConv(); panel.render(); revealOnScreenTip();
    },
    setLabel(uuid, text) {
      if (text) state.conv.labels[uuid] = text; else delete state.conv.labels[uuid];
      persistConv();
    },
    toggleStar(uuid) {
      const s = state.conv.stars;
      s.has(uuid) ? s.delete(uuid) : s.add(uuid);
      persistConv(); panel.render();
    },
    setSearch(q) { state.search = q; panel.render(); },
    setStarredOnly(on) { state.starredOnly = on; panel.render(); },
    async toggleMode() {
      state.settings.viewMode = state.settings.viewMode === 'full' ? 'human' : 'full';
      panel.render();
      try { await CBT.saveSettings({ viewMode: state.settings.viewMode }); } catch (_) {}
    },
    saveGeometry(g) { try { store.saveGeometry(g); } catch (_) {} },
    menuAction(act) {
      if (act === 'options') { safeSend({ type: 'cbt-open-options' }); return; }
      if (act === 'vault-open') { safeSend({ type: 'cbt-open-vault', conv: state.convUuid }); return; }
      if (act === 'vault-now') { vaultCapture(true); return; }
      if (!state.tree) { panel.toast('Nothing loaded yet'); return; }
      const title = state.data.name || 'Claude conversation';
      const base = (title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'conversation');
      recomputeVisible(false);
      if (act === 'copy-branch') {
        navigator.clipboard.writeText(T.branchToMarkdown(state.tree, state.visible.path, title))
          .then(() => panel.toast('Branch copied as Markdown'), () => panel.toast('Clipboard blocked by the browser'));
      } else if (act === 'dl-branch') {
        download(`${base}_branch.md`, T.branchToMarkdown(state.tree, state.visible.path, title), 'text/markdown');
      } else if (act === 'dl-all') {
        download(`${base}_all_branches.md`, T.allBranchesToMarkdown(state.tree, title, state.conv.labels), 'text/markdown');
      } else if (act === 'dl-outline') {
        download(`${base}_tree.md`, T.outlineToMarkdown(state.tree, state.settings.viewMode, state.conv.labels, title, 120), 'text/markdown');
      } else if (act === 'dl-json') {
        download(`${base}.json`, JSON.stringify(state.data, null, 2), 'application/json');
      }
    },
    diagnostics,
    dismissIntro() {
      state.introSeen = true;
      panel.render();
      try { chrome.storage.local.set({ introSeen: true }); } catch (_) {}
    },
  };

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    panel.toast('Saved ' + name);
  }

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) { panel.toast('Extension was updated — reload this tab'); }
  }

  function diagnostics() {
    const d = dom.diagnostics();
    const a = api.diagnostics();
    const rendered = dom.collectRendered();
    const users = rendered.filter((r) => r.role === 'human').length;
    const bots = rendered.length - users;
    const counters = dom.findCounters().length;
    const v = state.visible;
    let version = '?';
    try { version = chrome.runtime.getManifest().version; } catch (_) {}
    return {
      extension: version,
      page: location.pathname.replace(/[0-9a-f-]{36}/g, '<id>'),
      checks: {
        'Page hook (auto-refresh + switching)': { ok: document.documentElement.hasAttribute('data-cbt-hook'), detail: document.documentElement.hasAttribute('data-cbt-hook') ? 'active' : 'not active — reload the tab' },
        'Conversation API': { ok: /^ok/.test(a.lastStatus), detail: a.lastStatus },
        'Organisation': { ok: !!a.orgId, detail: a.orgId ? `${a.orgId} (from ${a.orgSource})` : 'not resolved yet' },
        'Your messages on page': { ok: users > 0, detail: `${users} found via ${d.user || 'no selector matched'}` },
        "Claude's replies on page": { ok: bots > 0, detail: `${bots} found via ${d.assistant || 'no selector matched'}` },
        'On-screen branch': { ok: v.source === 'dom', detail: v.source === 'dom' ? (v.exact ? 'exact (message ids on page)' : `matched by text (${Math.round(v.confidence * 100)}% confidence)`) : 'fell back to server leaf' },
        'Switching method': { ok: true, detail: counters ? "clicks claude.ai's own ‹ › arrows" : 'reload + local view (new layout has no arrows)' },
        'Last switch': { ok: (document.documentElement.getAttribute('data-cbt-jump') || 'none') !== 'missed', detail: document.documentElement.getAttribute('data-cbt-jump') || 'none this page load' },
        'Version arrows (‹ k/n ›)': { ok: counters > 0 || !(state.tree && T.stats(state.tree).forks), detail: `${counters} found on page${state.tree && T.stats(state.tree).forks && !counters ? ' — chat has forks, so arrows should exist (they may only appear on hover)' : ''}` },
        'Document vault': { ok: !(state.lastVault && state.lastVault.error), detail: !state.settings.vaultAuto ? 'off' : state.lastVault ? (state.lastVault.error ? 'error: ' + state.lastVault.error : `last run: +${state.lastVault.added} items, ${state.lastVault.files} files downloaded, ${state.lastVault.failed} failed`) : 'not run yet this page' },
        'Toolbar button': { ok: !!document.getElementById('cbt-toolbar-btn') || state.settings.launcher !== 'auto', detail: document.getElementById('cbt-toolbar-btn') ? `inserted via ${d.toolbar || 'earlier match'}` : `not inserted (launcher setting: ${state.settings.launcher})` },
      },
      tree: state.tree ? T.stats(state.tree) : null,
      settings: state.settings,
    };
  }

  // ---------- launcher (toolbar button or floating button) ----------

  function ensureLauncher() {
    const onChat = !!api.convUuidFromUrl();
    const mode = state.settings.launcher;
    let btn = document.getElementById('cbt-toolbar-btn');
    if (mode === 'none' || mode === 'floating' || !onChat) {
      if (btn) btn.closest('.cbt-btn-wrap')?.remove();
      panel.showLauncher(onChat && mode === 'floating');
      return;
    }
    if (!btn) {
      const slot = dom.findToolbarSlot();
      if (slot) {
        const wrap = document.createElement('div');
        wrap.className = 'relative shrink-0 cbt-btn-wrap';
        btn = document.createElement('button');
        btn.id = 'cbt-toolbar-btn';
        btn.type = 'button';
        btn.title = 'Branch Tree (Alt+B)';
        btn.setAttribute('aria-label', 'Branch Tree');
        btn.className = CBT.TOOLBAR_BUTTON_CLASS;
        btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:none;border:0;color:inherit;cursor:pointer;opacity:.8';
        btn.innerHTML = CBT.ICON_SVG;
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); app.toggle(); });
        wrap.appendChild(btn);
        slot.parent.insertBefore(wrap, slot.before);
      }
    }
    panel.showLauncher(!btn && mode === 'auto');
  }

  // ---------- watching the page ----------

  function onUrlMaybeChanged() {
    const uuid = api.convUuidFromUrl();
    if (uuid === state.convUuid) return;
    state.convUuid = uuid;
    state.tree = null; state.data = null; state.signature = '';
    state.visible = { path: [], mapping: new Map(), source: 'none', confidence: 0 };
    state.visibleSet = new Set();
    state.selected = null;
    state.search = ''; panel.setSearchBox('');
    state.emptyMessage = uuid ? 'Loading…' : 'Open a chat (claude.ai/chat/…) to see its branches.';
    if (state.jump && state.jump.convFor !== uuid) { state.jump = null; dom.hideBanner(); }
    dom.removeStaleNavs(new Set());
    panel.render();
    ensureLauncher();
    (uuid ? loadConvData(uuid) : Promise.resolve()).then(() => {
      if (uuid !== state.convUuid) return;
      checkJump();
      if (state.jump) state.jump.convFor = uuid;
      if (uuid && state.settings.openOnLoad && !panel.isOpen()) app.open();
      else if (needTree()) refresh(false);
    });
  }

  let wasStreaming = false;
  let mutTimer = null;
  function onMutations() {
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      ensureLauncher();
      onUrlMaybeChanged();
      if (!needTree() || state.switching) return;
      const streaming = dom.isStreaming();
      if (wasStreaming && !streaming && state.settings.autoRefresh) scheduleRefetch(900); // reply finished
      wasStreaming = streaming;
      if (!streaming) { recomputeVisible(true); focusAfterJump(); } // page re-rendered, etc.
      if (state.jump && state.jump.status === 'applied' && !document.getElementById('cbt-banner')) showJumpBanner();
    }, 400);
  }

  async function init() {
    try { state.settings = await CBT.loadSettings(); } catch (_) {}
    try { state.introSeen = !!(await chrome.storage.local.get('introSeen')).introSeen; } catch (_) {}
    panel = CBT.createPanel(app);
    panel.setTheme(dom.isDarkMode());
    try { panel.restoreGeometry(await store.loadGeometry()); } catch (_) {}

    new MutationObserver(onMutations).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-is-streaming'],
    });
    new MutationObserver(() => panel.setTheme(dom.isDarkMode()))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode', 'data-theme', 'data-color-scheme'] });
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => panel.setTheme(dom.isDarkMode()));

    // SPA navigation: claude.ai changes the URL without reloading.
    window.addEventListener('popstate', onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, 1000);

    // Signals from page-hook.js: something was sent / edited / retried.
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.source !== 'cbt-page-hook') return;
      if (e.data.kind === 'jump-applied' || e.data.kind === 'jump-missed') { checkJump(); if (state.jump) state.jump.convFor = state.convUuid; return; }
      if (state.settings.autoRefresh && needTree()) scheduleRefetch(e.data.kind === 'mutation-done' ? 1200 : 4000);
    });

    // Slow safety poll (only while open, tab visible, and not mid-reply).
    setInterval(() => {
      const sec = state.settings.fallbackPollSec;
      if (!sec || !panel.isOpen() || document.hidden || dom.isStreaming() || state.switching) return;
      if (Date.now() - state.lastSync >= sec * 1000) refresh(false);
      else updateStatus();
    }, 5000);

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'cbt-toggle') app.toggle();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) {
        state.settings = { ...CBT.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        ensureLauncher();
        panel.render();
      }
    });

    onUrlMaybeChanged();
    ensureLauncher();
  }

  init();
})();
