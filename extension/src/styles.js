// styles.js — panel CSS (lives in a Shadow DOM, so claude.ai's styles can't
// break it and it can't leak into claude.ai) + shared icons.
//
// Look: a metro map. The branch on screen is a bold terracotta line, other
// branches are quiet grey lines, every message is a stop. Type borrows
// claude.ai's own faces (Anthropic Serif / Sans) so the panel feels native.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  CBT.LANE_W = 14;   // px between branch lines
  CBT.DOT_Y = 13;    // px from row top to the centre of a stop

  CBT.PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.wrap {
  --paper: #fbfaf6; --paper-2: #f3f0e7; --paper-3: #e9e5d8; --ink: #1f1e1a; --ink-2: #5e5a4f; --ink-3: #959083;
  --rule: #e2ddcf; --lane: #cbc4b3; --accent: #c2593a; --accent-ink: #fff; --accent-soft: rgba(194,89,58,.10);
  --accent-mid: rgba(194,89,58,.45); --gold: #a86f13; --focus: #2f6fdb; --mark: rgba(245,190,60,.42);
  --ok: #3f8a57; --warn: #c2593a; --shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 18px 50px -12px rgba(40,30,10,.35), 0 2px 6px rgba(40,30,10,.08);
  --serif: "Anthropic Serif", "Tiempos Text", Georgia, "Times New Roman", serif;
  --sans: "Anthropic Sans", ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", monospace;
  font: 13.5px/1.45 var(--sans);
  color: var(--ink);
}
.wrap[data-theme="dark"] {
  --paper: #1f1e1c; --paper-2: #282725; --paper-3: #33322f; --ink: #efece4; --ink-2: #b7b2a6; --ink-3: #85817a;
  --rule: #3a3936; --lane: #55534d; --accent: #e2865f; --accent-ink: #1f1e1c; --accent-soft: rgba(226,134,95,.14);
  --accent-mid: rgba(226,134,95,.5); --gold: #f0c35a; --focus: #7aa7ff; --mark: rgba(245,190,60,.3);
  --ok: #7bc896; --warn: #e2865f; --shadow: 0 18px 50px -10px rgba(0,0,0,.7), 0 2px 6px rgba(0,0,0,.35);
}

/* ---------- floating launcher (used when the chat header slot isn't found) ---------- */
.launcher { position: fixed; right: 18px; bottom: 96px; z-index: 2; display: none; align-items: center; gap: 7px;
  height: 38px; padding: 0 14px 0 12px; border-radius: 19px; border: 1px solid var(--rule);
  background: var(--paper); color: var(--accent); box-shadow: var(--shadow); cursor: pointer; font: 600 12.5px var(--sans); }
.launcher.show { display: inline-flex; }
.launcher:hover { background: var(--paper-2); }
.launcher span { color: var(--ink-2); }

/* ---------- panel shell ---------- */
.panel { position: fixed; top: 72px; right: 16px; width: 430px; height: 600px; min-width: 320px; min-height: 260px; z-index: 3;
  display: flex; flex-direction: column; overflow: hidden; background: var(--paper);
  border: 1px solid var(--rule); border-radius: 14px; box-shadow: var(--shadow);
  opacity: 0; transform: translateY(-8px) scale(.985); transform-origin: top right; pointer-events: none;
  transition: opacity .2s ease, transform .22s cubic-bezier(.2,.9,.3,1.2); }
.panel.open { opacity: 1; transform: none; pointer-events: auto; }

button.ic { all: unset; box-sizing: border-box; width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center;
  justify-content: center; color: var(--ink-2); cursor: pointer; flex-shrink: 0; }
button.ic svg { width: 16px; height: 16px; }
button.ic:hover { background: var(--paper-3); color: var(--ink); }
button.ic.on { color: var(--accent); background: var(--accent-soft); }
button.ic:focus-visible, .seg button:focus-visible, .rowact:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

/* header */
.hdr { display: flex; align-items: flex-start; gap: 10px; padding: 12px 10px 10px 14px; cursor: grab; user-select: none; flex-shrink: 0;
  background: linear-gradient(180deg, var(--paper-2), var(--paper)); border-bottom: 1px solid var(--rule); }
.hdr:active { cursor: grabbing; }
.logo { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; flex-shrink: 0; margin-top: 1px; }
.logo svg { width: 17px; height: 17px; }
.ttl { flex: 1; min-width: 0; }
.ttl .k { font: 600 10.5px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; color: var(--accent); }
.ttl .name { font: 600 15.5px/1.25 var(--serif); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ttl .sub { font: 11.5px/1.3 var(--mono); color: var(--ink-3); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hbtns { display: flex; gap: 2px; }

/* controls */
.ctl { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--rule); flex-shrink: 0; }
.seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--paper-3); flex-shrink: 0; }
.seg button { all: unset; padding: 3px 9px; border-radius: 7px; font: 500 12px/18px var(--sans); color: var(--ink-2); cursor: pointer; }
.seg button.on { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.search { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
.search svg { position: absolute; left: 8px; width: 14px; height: 14px; color: var(--ink-3); pointer-events: none; }
.search input { all: unset; box-sizing: border-box; width: 100%; height: 28px; padding: 0 8px 0 27px; border-radius: 8px;
  border: 1px solid var(--rule); background: var(--paper); color: var(--ink); font: 12.5px var(--sans); }
.search input::placeholder { color: var(--ink-3); }
.search input:focus { border-color: var(--focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 18%, transparent); }
.count { font: 11px var(--mono); color: var(--ink-3); white-space: nowrap; }
.count:empty { display: none; }

/* menu */
.menu { position: absolute; top: 52px; right: 10px; z-index: 6; width: 262px; padding: 6px; background: var(--paper);
  border: 1px solid var(--rule); border-radius: 12px; box-shadow: var(--shadow); }
.menu[hidden] { display: none; }
.menu .mh { font: 600 10px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); padding: 9px 9px 5px; }
.menu button { all: unset; box-sizing: border-box; display: flex; gap: 9px; align-items: center; width: 100%; padding: 6px 9px; border-radius: 7px; cursor: pointer; font: 13px var(--sans); }
.menu button svg { width: 15px; height: 15px; color: var(--ink-3); flex-shrink: 0; }
.menu button:hover, .menu button:focus-visible { background: var(--paper-2); }
.menu button small { margin-left: auto; color: var(--ink-3); font: 11px var(--mono); }

/* intro card */
.intro { margin: 10px 10px 2px; padding: 12px 14px; border-radius: 11px; border: 1px solid var(--accent-mid);
  background: linear-gradient(135deg, var(--accent-soft), transparent 70%); flex-shrink: 0; }
.intro[hidden] { display: none; }
.intro h4 { margin: 0 0 6px; font: 600 14px var(--serif); }
.intro ol { margin: 0; padding-left: 18px; color: var(--ink-2); font-size: 12.5px; }
.intro li { margin: 3px 0; } .intro b { color: var(--ink); }
.intro .row2 { display: flex; justify-content: flex-end; margin-top: 8px; }
.btn { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font: 600 12px var(--sans); }
.btn:hover { filter: brightness(1.06); }
.btn.ghost { background: transparent; color: var(--ink-2); border: 1px solid var(--rule); }

/* body / tree */
.body { flex: 1; overflow: auto; padding: 6px 4px 12px 2px; outline: none; scrollbar-width: thin; scrollbar-color: var(--paper-3) transparent; }
.empty { text-align: center; color: var(--ink-3); padding: 42px 22px; font-size: 13px; }
.empty svg { width: 30px; height: 30px; color: var(--lane); display: block; margin: 0 auto 10px; }
.empty b { display: block; color: var(--ink-2); font: 600 14px var(--serif); margin-bottom: 4px; }

.skel { padding: 10px 14px; }
.skel i { display: block; height: 12px; margin: 13px 0; border-radius: 6px; background: linear-gradient(90deg, var(--paper-2), var(--paper-3), var(--paper-2)); background-size: 200% 100%; animation: sh 1.2s linear infinite; }
.skel i:nth-child(2n) { width: 70%; margin-left: 18px; } .skel i:nth-child(3n) { width: 55%; margin-left: 32px; }
@keyframes sh { to { background-position: -200% 0; } }

.row { position: relative; display: flex; align-items: flex-start; min-height: 26px; padding: 3px 6px 3px 0; border-radius: 8px; cursor: pointer; }
.row:hover { background: var(--paper-2); }
.row.selected { box-shadow: inset 0 0 0 1.5px var(--focus); }
.row.dim .main { opacity: .42; }
.row.onscreen .main .txt { color: var(--ink); }

.rail { position: relative; flex-shrink: 0; align-self: stretch; margin: -3px 0; }
.seg-l { position: absolute; width: 2px; background: var(--lane); border-radius: 1px; }
.seg-l.on { background: var(--accent); width: 3px; z-index: 1; }
.elb { position: absolute; border-top: 2px solid var(--lane); border-right: 2px solid var(--lane); border-top-right-radius: 10px; }
.elb.on { border-color: var(--accent); border-top-width: 3px; border-right-width: 3px; z-index: 1; }
.dot { position: absolute; width: 10px; height: 10px; border-radius: 50%; background: var(--paper); border: 2px solid var(--lane); z-index: 2; }
.dot.on { border-color: var(--accent); background: var(--accent); }
.dot.bot { border-radius: 3px; width: 9px; height: 9px; }
.dot.here { width: 14px; height: 14px; box-shadow: 0 0 0 4px var(--accent-soft); }
.dot.col { border-style: dashed; }

.main { flex: 1; min-width: 0; display: flex; gap: 5px; align-items: flex-start; padding-top: 2px; }
.tog { flex-shrink: 0; width: 14px; height: 20px; display: grid; place-items: center; color: var(--ink-3); border-radius: 4px; }
.tog svg { width: 11px; height: 11px; transition: transform .15s; }
.tog.closed svg { transform: rotate(-90deg); }
.tog.has { cursor: pointer; } .tog.has:hover { color: var(--ink); background: var(--paper-3); }
.num { flex-shrink: 0; font: 500 11.5px/20px var(--mono); color: var(--ink-3); min-width: 14px; }
.row.onscreen .num { color: var(--accent); }
.chip { flex-shrink: 0; font: 500 10.5px/16px var(--mono); margin-top: 2px; padding: 0 6px; border-radius: 9px; white-space: nowrap; background: var(--paper-3); color: var(--ink-2); }
.chip.ver { background: transparent; box-shadow: inset 0 0 0 1px var(--accent-mid); color: var(--accent); }
.chip.claude { font-family: var(--sans); font-weight: 600; background: transparent; color: var(--ink-3); padding: 0; }
.chip.hidden-n { background: transparent; box-shadow: inset 0 0 0 1px var(--rule); color: var(--ink-3); }
.chip.latest { background: transparent; color: var(--gold); padding: 0 2px; }
.txt { min-width: 0; flex: 1; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; color: var(--ink-2); line-height: 20px; }
.row.assistant .txt { font-style: italic; color: var(--ink-3); }
.txt .lbl { font-weight: 600; color: var(--ink); }
.txt .lbl + .pv::before { content: " · "; color: var(--ink-3); }
.txt mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
.time { flex-shrink: 0; font: 11px/20px var(--mono); color: var(--ink-3); }
.starred { flex-shrink: 0; color: var(--gold); font-size: 12px; line-height: 20px; }
.acts { position: absolute; right: 4px; top: 2px; display: none; gap: 1px; padding: 1px; border-radius: 8px; background: var(--paper-2); box-shadow: -10px 0 10px var(--paper-2); }
.row:hover .acts, .row.selected .acts { display: flex; }
.rowact { all: unset; width: 24px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--ink-3); cursor: pointer; }
.rowact svg { width: 14px; height: 14px; }
.rowact:hover { background: var(--paper-3); color: var(--ink); }
.rowact.star.on { color: var(--gold); }
.rowact.go { color: var(--accent); }
.edit { flex: 1; min-width: 0; font: inherit; color: var(--ink); background: var(--paper); border: 1.5px solid var(--focus); border-radius: 6px; padding: 1px 6px; outline: none; }

/* diagnostics / help */
.diag { flex: 1; overflow: auto; padding: 12px 14px; font-size: 12.5px; }
.diag[hidden] { display: none; }
.diag h3 { margin: 6px 0 8px; font: 600 15px var(--serif); }
.diag pre { white-space: pre-wrap; word-break: break-word; background: var(--paper-2); padding: 9px; border-radius: 8px; font: 11.5px/1.45 var(--mono); }
.diag kbd { font: 11px var(--mono); padding: 0 5px; border: 1px solid var(--rule); border-bottom-width: 2px; border-radius: 4px; background: var(--paper-2); }
.diag table { border-collapse: collapse; width: 100%; }
.diag td { padding: 5px 4px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.diag td:first-child { color: var(--ink-2); width: 42%; }
.diag .ok { color: var(--ok); } .diag .bad { color: var(--warn); }
.linkbtn { all: unset; color: var(--accent); cursor: pointer; font-weight: 600; font-size: 12.5px; }
.linkbtn:hover { text-decoration: underline; }

/* footer */
.foot { display: flex; gap: 8px; align-items: center; padding: 6px 8px 6px 12px; border-top: 1px solid var(--rule); background: var(--paper-2); flex-shrink: 0; min-height: 36px; }
.foot .st { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--ink-3); display: flex; align-items: center; gap: 7px; }
.foot .st::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
.foot .st.warn { color: var(--warn); } .foot .st.warn::before { background: var(--warn); }
.foot .st.busy::before { background: var(--gold); animation: pulse 1s ease-in-out infinite; }
.foot .st:empty::before { display: none; }
@keyframes pulse { 50% { opacity: .3; } }
.fbtn { all: unset; display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 7px; font: 500 12px var(--sans); color: var(--ink-2); cursor: pointer; }
.fbtn svg { width: 14px; height: 14px; }
.fbtn:hover { background: var(--paper-3); color: var(--ink); }

.toast { position: absolute; left: 50%; bottom: 46px; transform: translate(-50%, 6px); padding: 7px 13px; border-radius: 9px; max-width: 88%;
  background: var(--ink); color: var(--paper); font-size: 12.5px; box-shadow: var(--shadow); pointer-events: none; opacity: 0; transition: opacity .18s, transform .18s; z-index: 7; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }

.rz { position: absolute; z-index: 8; }
.rz.n, .rz.s { left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
.rz.e, .rz.w { top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
.rz.n { top: 0; } .rz.s { bottom: 0; } .rz.e { right: 0; } .rz.w { left: 0; }
.rz.ne, .rz.nw, .rz.se, .rz.sw { width: 14px; height: 14px; }
.rz.ne { top: 0; right: 0; cursor: nesw-resize; } .rz.sw { bottom: 0; left: 0; cursor: nesw-resize; }
.rz.nw { top: 0; left: 0; cursor: nwse-resize; } .rz.se { bottom: 0; right: 0; cursor: nwse-resize; }

@media (prefers-reduced-motion: reduce) { .panel, .toast, .tog svg { transition: none; } .skel i, .foot .st.busy::before { animation: none; } }
`;

  // Toolbar button in claude.ai's own header borrows its classes to look native.
  CBT.TOOLBAR_BUTTON_CLASS =
    'inline-flex items-center justify-center relative shrink-0 can-focus select-none ' +
    'border border-transparent transition font-base duration-300 h-8 w-8 rounded-md active:scale-95 !rounded-lg ' +
    'hover:!bg-bg-200 active:!scale-100 !pointer-events-auto !outline-offset-1 text-text-300';

  // 24×24 stroke icons (drawn for this extension).
  const I = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  CBT.ICONS = {
    branch: I('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 10.2c0 4-4 4.8-10.6 7.6"/>'),
    refresh: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    more: I('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
    close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: I('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    star: I('<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>'),
    target: I('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>'),
    expand: I('<path d="M7 9l5-5 5 5M7 15l5 5 5-5"/>'),
    collapse: I('<path d="M7 4l5 5 5-5M7 20l5-5 5 5"/>'),
    help: I('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17.2h.01"/>'),
    pencil: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
    go: I('<path d="M5 12h13M13 6l6 6-6 6"/>'),
    chevron: I('<path d="M6 9l6 6 6-6"/>'),
    vault: I('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V7M12 17v-1.8M8.8 12H7M17 12h-1.8"/>'),
    copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    file: I('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    layers: I('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
    list: I('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
    code: I('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
    save: I('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    pulse: I('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
    gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z"/>'),
  };
  CBT.ICON_SVG = CBT.ICONS.branch.replace('<svg ', '<svg width="16" height="16" ');
})(typeof globalThis !== 'undefined' ? globalThis : this);
