// dom.js — everything that touches claude.ai's own page.
// claude.ai changes its HTML often, so every lookup tries several selectors
// (newest guess first) and reports which one worked in the Diagnostics view.
// When claude.ai changes, this is the only file that should need editing.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  // Checked against live claude.ai on 2026-11-07 (new "CDS" layout), with the
  // older layout's selectors kept as fallbacks.
  const SEL = {
    // Whole message rows. New layout: data-turn-key = YOUR message's uuid for
    // that turn (on both your row and Claude's reply row) — exact mapping.
    user: [
      '[data-cds="UserMessage"][data-turn-key]',
      '[data-testid="user-message"]',
      '[data-message-author-role="user"]',
      '.font-user-message',
    ],
    assistant: [
      '[data-cds="AssistantMessage"]',
      '[data-is-streaming]',
      '.font-claude-response',
      '.font-claude-message',
      '[data-message-author-role="assistant"]',
    ],
    userText: '[data-testid="user-message"]',
    assistantText: '[data-cds="Prose"], .standard-markdown, .progressive-markdown',
    streaming: '[data-is-streaming="true"], [data-cds="TurnStatus"][data-cds-state="running"]',
    // Where the toolbar button goes: [anchor, mode] — 'before' inserts before the anchor element.
    toolbar: [
      ['[data-testid="chat-header"] [data-cds="Toolbar"] button[aria-label="Activity panel"]', 'before'],
      ['[data-testid="chat-header"] [data-testid="wiggle-controls-actions"]', 'before'],
      ['div.relative.flex-1.flex.items-center.shrink.min-w-0 > div.flex.flex-row.items-center.min-w-0', 'before'],
      ['header [data-testid="chat-menu-trigger"]', 'after'],
    ],
  };

  const used = { user: null, assistant: null, toolbar: null }; // for Diagnostics

  // ---------- helpers ----------

  const textOf = (el) => (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';

  function inDocOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  // Keep only the outermost matches (a selector can match a wrapper AND its inner part).
  function outermost(list) {
    return list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  }

  function firstMatching(selectors, key) {
    for (const s of selectors) {
      let els;
      try { els = document.querySelectorAll(s); } catch (_) { continue; }
      const arr = outermost([...els]).filter((el) => !el.closest('#cbt-host'));
      if (arr.length) { used[key] = s; return arr; }
    }
    used[key] = null;
    return [];
  }

  // ---------- reading messages on the page ----------

  // Returns [{ role, el, text, uuid?, turnKey? }] in page order.
  //   uuid    (your messages, new layout) exact message id from data-turn-key
  //   turnKey (Claude's replies, new layout) id of YOUR message it answers
  function collectRendered() {
    const users = firstMatching(SEL.user, 'user').map((el) => {
      const key = el.getAttribute('data-turn-key');
      const textEl = el.matches(SEL.userText) ? el : el.querySelector(SEL.userText) || el;
      return { role: 'human', el, text: textOf(textEl), uuid: key || null };
    });
    const bots = firstMatching(SEL.assistant, 'assistant')
      .filter((el) => !users.some((u) => el.contains(u.el) || u.el.contains(el)))
      .map((el) => {
        const keyEl = el.closest('[data-turn-key]');
        return { role: 'assistant', el, text: textOf(el.querySelector(SEL.assistantText) || el), turnKey: keyEl ? keyEl.getAttribute('data-turn-key') : null };
      });
    return [...users, ...bots]
      .filter((r) => r.text.trim().length > 0 || r.role === 'assistant' || r.uuid)
      .sort((a, b) => inDocOrder(a.el, b.el));
  }

  const isStreaming = () => {
    try { return !!document.querySelector(SEL.streaming); } catch (_) { return false; }
  };

  // ---------- our own ‹ k/n › arrows, injected into claude.ai's message rows ----------

  function ensurePageStyle() {
    if (document.getElementById('cbt-page-style')) return;
    const s = document.createElement('style');
    s.id = 'cbt-page-style';
    s.textContent = `
.cbt-vnav{--a:#c2593a;display:inline-flex;align-items:center;gap:0;margin:6px 0 0;width:fit-content;user-select:none;
  font:500 12px/1 ui-monospace,Consolas,monospace;color:var(--a);border-radius:999px;padding:2px;
  background:color-mix(in srgb,var(--a) 9%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 38%,transparent);
  opacity:.82;transition:opacity .15s}
.cbt-vnav:hover{opacity:1}
html[data-mode="dark"] .cbt-vnav,.dark .cbt-vnav{--a:#e2865f}
.cbt-vnav.cbt-right{margin-left:auto}
.cbt-vnav button{all:unset;cursor:pointer;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:600 15px/1 system-ui,sans-serif}
.cbt-vnav button:hover:not([disabled]){background:color-mix(in srgb,var(--a) 18%,transparent)}
.cbt-vnav button:focus-visible{outline:2px solid var(--a);outline-offset:1px}
.cbt-vnav button[disabled]{opacity:.28;cursor:default}
.cbt-vnav span{padding:0 6px;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.cbt-vnav span small{opacity:.65;margin-left:4px;font:500 10.5px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase}
.cbt-banner{position:sticky;top:10px;z-index:30;margin:10px auto;max-width:640px;width:calc(100% - 32px);display:flex;gap:12px;align-items:center;
  padding:9px 10px 9px 14px;border-radius:12px;font:13px/1.35 system-ui,sans-serif;color:#f6f2ea;background:#26241f;
  box-shadow:0 10px 30px -8px rgba(0,0,0,.45),inset 3px 0 0 #e2865f}
.cbt-banner .dot{width:9px;height:9px;border-radius:50%;background:#e2865f;box-shadow:0 0 0 4px rgba(226,134,95,.22);flex-shrink:0}
.cbt-banner b{font-weight:650}.cbt-banner small{display:block;opacity:.72;font-size:12px;margin-top:1px}.cbt-banner .sp{flex:1}
.cbt-banner button{all:unset;cursor:pointer;background:#e2865f;color:#1f1e1c;padding:6px 12px;border-radius:8px;font-weight:650;white-space:nowrap}
.cbt-banner button.sec{background:transparent;color:#f6f2ea;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
.cbt-banner button:hover{filter:brightness(1.08)}
.cbt-banner.err{box-shadow:0 10px 30px -8px rgba(0,0,0,.45),inset 3px 0 0 #ef6b5b}.cbt-banner.err .dot{background:#ef6b5b}
.cbt-ptoast{position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:2147483646;display:flex;gap:10px;align-items:center;
  padding:10px 16px;border-radius:12px;background:#26241f;color:#f6f2ea;font:13px system-ui,sans-serif;box-shadow:0 12px 32px -8px rgba(0,0,0,.5)}
.cbt-ptoast i{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#e2865f;animation:cbtspin .7s linear infinite}
@keyframes cbtspin{to{transform:rotate(360deg)}}
#cbt-toolbar-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:none;border:0;color:inherit;cursor:pointer;opacity:.8}
#cbt-toolbar-btn:hover{opacity:1;background:rgba(128,128,128,.14)}`;
    (document.head || document.documentElement).appendChild(s);
  }

  // Puts (or updates) a "‹ k/n ›" control at the end of a message row.
  // onStep(-1|+1) is called on click. Idempotent: safe to call on every page change.
  // tips: { prev, next } short previews of the neighbouring versions (hover text).
  function upsertVersionNav(rowEl, key, cur, total, onStep, alignRight, tips) {
    ensurePageStyle();
    let nav = rowEl.querySelector(':scope > .cbt-vnav');
    const label = `${cur} / ${total}`;
    if (nav && nav.dataset.key === key && nav.dataset.label === label) return nav;
    if (!nav) {
      nav = document.createElement('div');
      nav.className = 'cbt-vnav' + (alignRight ? ' cbt-right' : '');
      nav.innerHTML = '<button type="button" aria-label="Previous version">‹</button><span></span><button type="button" aria-label="Next version">›</button>';
      for (const t of ['pointerdown', 'mousedown', 'click']) nav.addEventListener(t, (e) => e.stopPropagation());
      rowEl.appendChild(nav);
    }
    nav.dataset.key = key;
    nav.dataset.label = label;
    nav.title = '';
    const [prev, mid, next] = nav.children;
    mid.innerHTML = `${cur} / ${total}<small>versions</small>`;
    mid.title = 'Branch Tree: switching reloads this chat onto that version (this tab only)';
    prev.title = tips && tips.prev ? `Version ${cur - 1}: ${tips.prev}` : 'Previous version';
    next.title = tips && tips.next ? `Version ${cur + 1}: ${tips.next}` : 'Next version';
    prev.disabled = cur <= 1;
    next.disabled = cur >= total;
    prev.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (!prev.disabled) onStep(-1); };
    next.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (!next.disabled) onStep(+1); };
    return nav;
  }

  function removeStaleNavs(keepSet) {
    for (const n of document.querySelectorAll('.cbt-vnav')) if (!keepSet.has(n)) n.remove();
  }

  // Older-branch bar. html: main line; sub: small second line; buttons: [{ text, onClick, secondary }]
  function showBranchBar(html, sub, buttons, isError) {
    ensurePageStyle();
    let b = document.getElementById('cbt-banner');
    const host = document.querySelector('[data-testid="chat-column-body"]') || document.querySelector('main') || document.body;
    if (!b) { b = document.createElement('div'); b.id = 'cbt-banner'; host.prepend(b); }
    else if (!host.contains(b)) host.prepend(b);
    b.className = 'cbt-banner' + (isError ? ' err' : '');
    b.innerHTML = `<span class="dot"></span><span><span class="m"></span><small></small></span><span class="sp"></span>`;
    b.querySelector('.m').innerHTML = html;
    b.querySelector('small').textContent = sub || '';
    for (const bt of buttons || []) {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = bt.text; if (bt.secondary) el.className = 'sec';
      el.onclick = bt.onClick;
      b.appendChild(el);
    }
  }

  function pageToast(text) {
    ensurePageStyle();
    let t = document.getElementById('cbt-ptoast');
    if (!t) { t = document.createElement('div'); t.id = 'cbt-ptoast'; t.className = 'cbt-ptoast'; document.body.appendChild(t); }
    t.innerHTML = '<i></i><span></span>';
    t.querySelector('span').textContent = text;
  }

  function showBanner(html, buttonText, onButton) {
    ensurePageStyle();
    let b = document.getElementById('cbt-banner');
    const host = document.querySelector('[data-testid="chat-column-body"]') || document.querySelector('main') || document.body;
    if (!b) {
      b = document.createElement('div');
      b.id = 'cbt-banner';
      b.className = 'cbt-banner';
      host.prepend(b);
    } else if (!host.contains(b)) host.prepend(b);
    b.innerHTML = `<span>${html}</span><span class="sp"></span>`;
    if (buttonText) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = buttonText;
      btn.onclick = onButton;
      b.appendChild(btn);
    }
  }
  function hideBanner() { const b = document.getElementById('cbt-banner'); if (b) b.remove(); }

  // ---------- Claude's own "< 2 / 3 >" version arrows ----------
  //
  // Found by shape, not class names: a small element whose whole text is
  // "k / n", with a button just before it (previous) and just after it (next).
  const COUNTER_RE = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/;

  function findCounters() {
    const scope = document.querySelector('main') || document.body;
    const out = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.childElementCount > 2 || el.closest('.cbt-vnav')) continue; // skip our own arrows
      const t = el.textContent;
      if (!t || t.length > 12) continue;
      const m = t.match(COUNTER_RE);
      if (!m) continue;
      // Skip if a child already is the counter (we want the innermost).
      if ([...el.children].some((c) => COUNTER_RE.test(c.textContent))) continue;
      const cur = +m[1], total = +m[2];
      if (total < 2 || cur < 1 || cur > total) continue;
      const buttons = nearbyButtons(el);
      if (!buttons.prev && !buttons.next) continue;
      out.push({ el, cur, total, ...buttons });
    }
    return out;
  }

  function nearbyButtons(counterEl) {
    let box = counterEl.parentElement;
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      const btns = [...box.querySelectorAll('button')];
      if (btns.length >= 2) {
        const before = btns.filter((b) => inDocOrder(b, counterEl) < 0 && !b.contains(counterEl));
        const after = btns.filter((b) => inDocOrder(counterEl, b) < 0 && !b.contains(counterEl));
        if (before.length && after.length) return { prev: before[before.length - 1], next: after[0] };
      }
    }
    return { prev: null, next: null };
  }

  // Which message does each counter belong to? The one that contains it, else the
  // closest message before it on the page (the arrows sit under the message).
  function versionControlFor(msgEl, rendered) {
    const counters = findCounters();
    const els = rendered.map((r) => r.el);
    for (const c of counters) {
      let owner = els.find((e) => e.contains(c.el));
      if (!owner) {
        const before = els.filter((e) => inDocOrder(e, c.el) < 0);
        owner = before[before.length - 1];
      }
      if (owner === msgEl) return c;
    }
    // Also look inside the message's own turn wrapper (up to 4 levels, without
    // swallowing a neighbouring message).
    let box = msgEl.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      if (els.some((e) => e !== msgEl && box.contains(e))) break;
      const c = counters.find((k) => box.contains(k.el));
      if (c) return c;
    }
    return null;
  }

  // Resolves once the page has been quiet for `quietMs` (or after `maxMs`).
  function waitForSettle(quietMs = 250, maxMs = 2500) {
    return new Promise((resolve) => {
      const target = document.querySelector('main') || document.body;
      let quiet = setTimeout(done, quietMs);
      const hard = setTimeout(done, maxMs);
      const mo = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, quietMs); });
      mo.observe(target, { childList: true, subtree: true, characterData: true });
      function done() { mo.disconnect(); clearTimeout(quiet); clearTimeout(hard); resolve(); }
    });
  }

  function realClick(el) {
    // Some React handlers listen for pointer events, not just "click".
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // ---------- highlight / scroll ----------

  function flash(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof el.animate === 'function') {
      el.animate(
        [
          { boxShadow: '0 0 0 3px rgba(217,119,87,.85)', backgroundColor: 'rgba(217,119,87,.14)' },
          { boxShadow: '0 0 0 3px rgba(217,119,87,0)', backgroundColor: 'rgba(217,119,87,0)' },
        ],
        { duration: 1800, easing: 'ease-out' }
      );
    }
  }

  // ---------- toolbar button ----------

  function findToolbarSlot() {
    for (const [sel, mode] of SEL.toolbar) {
      let a;
      try { a = document.querySelector(sel); } catch (_) { continue; }
      if (!a || !a.parentElement) continue;
      used.toolbar = sel;
      return mode === 'after'
        ? { parent: a.parentElement, before: a.nextSibling }
        : { parent: a.parentElement, before: a };
    }
    used.toolbar = null;
    return null;
  }

  function isDarkMode() {
    const h = document.documentElement;
    const attrs = [h.dataset.mode, h.dataset.theme, document.body && document.body.dataset.theme, h.getAttribute('data-color-scheme')].filter(Boolean);
    for (const a of attrs) {
      if (a.includes('dark')) return true;
      if (a.includes('light')) return false;
    }
    if (h.classList.contains('dark') || (document.body && document.body.classList.contains('dark'))) return true;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  CBT.dom = {
    SEL, collectRendered, isStreaming, findCounters, versionControlFor,
    waitForSettle, realClick, flash, findToolbarSlot, isDarkMode,
    upsertVersionNav, removeStaleNavs, showBanner, hideBanner, showBranchBar, pageToast,
    diagnostics: () => ({ ...used }),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
