// vault.js — Document vault. Keeps every version of every document from EVERY
// branch, on this computer (chrome.storage.local, "unlimitedStorage").
//
// Why it's needed: files Claude makes live in ONE folder per chat
// (/mnt/user-data/outputs/). If branch A and branch B both write "report.docx",
// B overwrites A on claude.ai — A's version is gone from the download link.
//
// What is kept, per chat:
//   doc     text files Claude wrote, rebuilt per branch from the file-tool calls
//           kept in the chat history (create_file / str_replace / artifacts / write
//           / edit). Works for old chats too, even after the file was overwritten.
//   file    the actual bytes of files Claude made (docx, pdf, zip, images…),
//           downloaded as soon as the extension sees them — so each branch's
//           version is captured before another branch overwrites it.
//   upload  files you attached (never overwritten on claude.ai, saved anyway).
//   reply   the full text of every Claude reply on every branch.
//
// Storage keys:
//   vault:index        { [conv]: { title, updated, items, bytes } }
//   vault:c:<conv>     { title, items: [VaultItem] }
//   vault:b:<sha256>   base64 bytes (content-addressed, so duplicates cost nothing)
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  const INLINE_TEXT_MAX = 200 * 1024;      // text bigger than this goes to a blob
  const FILE_MAX_BYTES = 25 * 1024 * 1024; // don't download files bigger than this
  const OUTPUT_DIR = '/mnt/user-data/outputs/';

  // ---------- pure part: work out every document version from the API data ----------

  const asText = (v) => (typeof v === 'string' ? v : '');
  const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || 'untitled');

  // One file-tool call → an operation on a path. Covers claude.ai's file tools,
  // Claude-Code-style tools, and the older "artifacts" tool.
  function toolOp(block) {
    if (!block || block.type !== 'tool_use' || !block.input || typeof block.input !== 'object') return null;
    // Live claude.ai (2026-11) uses "Write" / "SendUserFile"; older chats use
    // create_file / str_replace / present_files. Compare names lower-case,
    // without underscores, after stripping any mcp__server__ prefix.
    const name = String(block.name || '').replace(/^.*__/, '').toLowerCase().replace(/[^a-z]/g, '');
    const i = block.input;
    const path = asText(i.path) || asText(i.file_path) || asText(i.filepath);
    switch (name) {
      case 'createfile':
      case 'write':
      case 'writefile':
        if (path && typeof (i.file_text ?? i.content) === 'string') return { op: 'set', path, text: i.file_text ?? i.content };
        return null;
      case 'strreplace':
      case 'strreplaceeditor':
      case 'edit':
      case 'updatefile': {
        if (name === 'strreplaceeditor' && i.command === 'create') return path ? { op: 'set', path, text: asText(i.file_text) } : null;
        const o = i.old_str ?? i.old_string, n = i.new_str ?? i.new_string;
        if (path && typeof o === 'string' && typeof n === 'string') return { op: 'replace', path, old: o, new: n, all: !!i.replace_all };
        return null;
      }
      case 'multiedit':
        if (path && Array.isArray(i.edits)) return { op: 'multi', path, edits: i.edits };
        return null;
      case 'artifacts': {
        const id = asText(i.id) || 'artifact';
        const key = `artifact:${id}`;
        const title = asText(i.title) || undefined; // updates usually omit it — keep the earlier one
        if (i.command === 'create' || i.command === 'rewrite') return { op: 'set', path: key, text: asText(i.content), title: title || id, mime: asText(i.type) };
        if (i.command === 'update') return { op: 'replace', path: key, old: asText(i.old_str), new: asText(i.new_str), title };
        return null;
      }
      case 'presentfiles':
      case 'senduserfile': {
        const list = i.filepaths || i.files || i.paths || (i.path ? [i.path] : []);
        const paths = Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x && (x.path || x.file_path))).filter(Boolean) : [];
        return paths.length ? { op: 'present', paths } : null;
      }
      default:
        return null;
    }
  }

  function applyReplace(text, o, n, all) {
    if (o === '') return null;
    const idx = text.indexOf(o);
    if (idx < 0) return null;
    return all ? text.split(o).join(n) : text.slice(0, idx) + n + text.slice(idx + o.length);
  }

  // Returns { docs: [...], presented: [...] }.
  //   docs:      one entry per (message that wrote it, path) — the full text of
  //              the document right after that message, on that message's branch.
  //   presented: files that a message shared or wrote (candidates for byte capture).
  function extractDocVersions(tree, data) {
    const msgs = new Map((data.chat_messages || []).map((m) => [m.uuid, m]));
    const docs = new Map();      // `${msg}|${path}` → version
    const presented = new Map(); // `${msg}|${path}` → { msg, path }
    const T = CBT.tree;

    // Walk every branch root→leaf, replaying file operations in order.
    const leaves = [...tree.nodes.values()].filter((n) => !n.children.length);
    for (const leaf of leaves) {
      const files = new Map(); // path → { text, broken }
      for (const u of T.pathTo(tree, leaf.uuid)) {
        const m = msgs.get(u);
        if (!m || m.sender !== 'assistant' || !Array.isArray(m.content)) continue;
        const touched = new Map();
        for (const b of m.content) {
          const op = toolOp(b);
          if (!op) continue;
          if (op.op === 'present') {
            for (const p of op.paths) presented.set(`${u}|${p}`, { msg: u, path: p });
            continue;
          }
          const cur = files.get(op.path) || { text: '', broken: false, title: op.title, mime: op.mime };
          if (op.op === 'set') { cur.text = op.text; cur.broken = false; }
          else if (op.op === 'replace') {
            const next = applyReplace(cur.text, op.old, op.new, op.all);
            if (next == null) cur.broken = true; else cur.text = next;
          } else if (op.op === 'multi') {
            for (const e of op.edits) {
              const next = applyReplace(cur.text, asText(e.old_string ?? e.old_str), asText(e.new_string ?? e.new_str), !!e.replace_all);
              if (next == null) cur.broken = true; else cur.text = next;
            }
          }
          if (op.title) cur.title = op.title;
          if (op.mime) cur.mime = op.mime;
          files.set(op.path, cur);
          touched.set(op.path, cur);
          if (!op.path.startsWith('artifact:')) presented.set(`${u}|${op.path}`, { msg: u, path: op.path });
        }
        for (const [path, f] of touched) {
          const key = `${u}|${path}`;
          if (docs.has(key)) continue; // shared history: same version on several branches
          const n = tree.nodes.get(u);
          docs.set(key, {
            kind: 'doc', path, name: f.title || basename(path), msg: u, turn: n.turn,
            created: n.created, text: f.text, partial: f.broken, mime: f.mime || '',
          });
        }
      }
    }
    return { docs: [...docs.values()], presented: [...presented.values()] };
  }

  // Files attached to messages (files_v2 preferred, like claude.ai itself):
  //   on YOUR messages   → uploads
  //   on CLAUDE's messages → files Claude shared. Each share is its own copy on
  //   claude.ai (own file_uuid), so every branch's version is still downloadable.
  // Plus text attachments (extracted_content) on your messages.
  function extractUploads(tree, data) {
    const out = [];
    for (const m of data.chat_messages || []) {
      const n = tree.nodes.get(m.uuid);
      const files = (m.files_v2 && m.files_v2.length ? m.files_v2 : m.files) || [];
      for (const f of files) {
        const id = f.file_uuid || f.uuid;
        if (!id || f.success === false) continue;
        out.push({
          kind: m.sender === 'human' ? 'upload' : 'file',
          name: f.file_name || f.name || id, msg: m.uuid, turn: n ? n.turn : 0, created: n ? n.created : 0,
          fileUuid: id, fileKind: f.file_kind || '', path: f.path || '', size: f.size_bytes || 0,
        });
      }
      if (m.sender !== 'human') continue;
      for (const a of m.attachments || []) {
        if (typeof a.extracted_content !== 'string') continue;
        out.push({ kind: 'upload', name: a.file_name || 'attachment.txt', msg: m.uuid, turn: n ? n.turn : 0, created: n ? n.created : 0, text: a.extracted_content, mime: a.file_type || 'text/plain' });
      }
    }
    return out;
  }

  function extractReplies(tree) {
    const out = [];
    for (const n of tree.nodes.values()) {
      if (n.sender !== 'assistant' || !n.text) continue;
      out.push({ kind: 'reply', name: `Claude reply — message ${n.turn}${n.versionCount > 1 ? ` v${n.versionIndex + 1}` : ''}`, msg: n.uuid, turn: n.turn, created: n.created, text: n.text, mime: 'text/markdown' });
    }
    return out;
  }

  // ---------- storage helpers ----------

  async function sha256Hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const enc = new TextEncoder();

  async function putBlob(bytes) {
    const hash = await sha256Hex(bytes);
    const key = 'vault:b:' + hash;
    const got = await chrome.storage.local.get(key);
    if (!got[key]) await chrome.storage.local.set({ [key]: toBase64(bytes) });
    return { hash, size: bytes.length };
  }

  async function loadConv(conv) {
    const k = 'vault:c:' + conv;
    return (await chrome.storage.local.get(k))[k] || { title: '', items: [] };
  }

  // ---------- capture (runs in the content script on claude.ai) ----------

  const busy = new Set();
  const lastSig = new Map();

  // opts: { orgId, convUuid, saveReplies, branchOf(uuid) → label }
  async function capture(tree, data, opts) {
    const conv = opts.convUuid;
    if (!conv || busy.has(conv)) return null;
    const sig = `${(data.chat_messages || []).length}|${data.updated_at}|${opts.saveReplies}`;
    if (lastSig.get(conv) === sig && !opts.force) return null;
    busy.add(conv);
    const report = { added: 0, files: 0, failed: 0 };
    try {
      const store = await loadConv(conv);
      const have = new Set(store.items.map((it) => it.id));
      const add = (it) => { if (!have.has(it.id)) { store.items.push(it); have.add(it.id); report.added++; } };

      const { docs, presented } = extractDocVersions(tree, data);
      // (uploads also holds the files Claude shared — kind 'file')
      const uploads = extractUploads(tree, data);
      const replies = opts.saveReplies ? extractReplies(tree) : [];

      for (const d of [...docs, ...replies, ...uploads.filter((u) => u.text != null)]) {
        const bytes = enc.encode(d.text);
        const hash = await sha256Hex(bytes);
        const it = { ...d, id: `${d.kind}|${d.msg}|${d.path || d.name}|${hash.slice(0, 12)}`, hash, size: bytes.length, savedAt: Date.now() };
        if (bytes.length > INLINE_TEXT_MAX) { await putBlob(bytes); delete it.text; it.blob = hash; }
        add(it);
      }

      // Bytes of files Claude made — captured per writing message, so each
      // branch's version is kept. Old messages: whatever is on disk now.
      const latestWriter = new Map();
      for (const p of presented) {
        const prev = latestWriter.get(p.path);
        if (!prev || tree.nodes.get(p.msg).created > tree.nodes.get(prev).created) latestWriter.set(p.path, p.msg);
      }
      const docKeys = new Set(docs.map((d) => `${d.msg}|${d.path}`));
      const sharedCopy = new Set(uploads.filter((u) => u.kind === 'file').map((u) => `${u.msg}|${u.name}`));
      const BINARY = /\.(docx?|pdf|xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg|mp[34]|wav|csv)$/i;
      for (const p of presented) {
        if (!p.path.startsWith('/mnt/') && !p.path.startsWith('computer://')) continue;
        if (docKeys.has(`${p.msg}|${p.path}`) && !BINARY.test(p.path)) continue; // text already saved from history
        if (sharedCopy.has(`${p.msg}|${basename(p.path)}`)) continue;              // permanent copy fetched below
        const capId = `file|${p.msg}|${p.path}`;
        if (store.items.some((it) => it.capId === capId)) continue;
        // Only the newest writer's version is on disk; for older writers we can
        // only save it if we're seeing it live (i.e. it IS the newest writer).
        if (latestWriter.get(p.path) !== p.msg) continue;
        const clean = p.path.replace(/^computer:\/\//, '');
        const url = `/api/organizations/${opts.orgId}/conversations/${conv}/wiggle/download-file?path=${encodeURIComponent(clean)}`;
        const r = await download(url);
        if (!r) { report.failed++; continue; }
        const { hash, size } = await putBlob(r.bytes);
        const n = tree.nodes.get(p.msg);
        add({ id: `file|${p.msg}|${clean}|${hash.slice(0, 12)}`, capId, kind: 'file', name: basename(clean), path: clean, msg: p.msg, turn: n.turn, created: n.created, mime: r.mime, blob: hash, hash, size, savedAt: Date.now() });
        report.files++;
      }

      for (const u of uploads.filter((x) => x.fileUuid)) {
        const capId = `${u.kind}|${u.fileUuid}`;
        if (store.items.some((it) => it.capId === capId)) continue;
        const r = await download(`/api/organizations/${opts.orgId}/files/${encodeURIComponent(u.fileUuid)}/contents`);
        if (!r) { report.failed++; continue; }
        const { hash, size } = await putBlob(r.bytes);
        add({ ...u, id: capId, capId, mime: r.mime || guessMime(u.name), blob: hash, hash, size, savedAt: Date.now() });
        report.files++;
      }

      // Label each item with the branch(es) it belongs to (for the vault page).
      for (const it of store.items) if (opts.branchOf && tree.nodes.has(it.msg)) it.branch = opts.branchOf(it.msg);

      store.title = data.name || store.title || 'Untitled chat';
      store.updated = Date.now();
      await chrome.storage.local.set({ ['vault:c:' + conv]: store });
      const idx = (await chrome.storage.local.get('vault:index'))['vault:index'] || {};
      idx[conv] = { title: store.title, updated: store.updated, items: store.items.length, bytes: store.items.reduce((s, i) => s + (i.size || 0), 0) };
      await chrome.storage.local.set({ 'vault:index': idx });
      lastSig.set(conv, sig);
      return report;
    } catch (e) {
      console.warn('[Branch Tree] vault capture failed', e);
      report.error = e.message;
      return report;
    } finally {
      busy.delete(conv);
    }
  }

  function guessMime(name) {
    const ext = String(name).toLowerCase().split('.').pop();
    return ({ md: 'text/markdown', txt: 'text/plain', html: 'text/html', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' })[ext] || '';
  }

  async function download(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const len = +res.headers.get('content-length') || 0;
      if (len > FILE_MAX_BYTES) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > FILE_MAX_BYTES) return null;
      return { bytes: buf, mime: (res.headers.get('content-type') || '').split(';')[0] };
    } catch (_) {
      return null;
    }
  }

  CBT.vault = { toolOp, extractDocVersions, extractUploads, extractReplies, capture, OUTPUT_DIR };
  if (typeof module !== 'undefined' && module.exports) module.exports = CBT.vault;
})(typeof globalThis !== 'undefined' ? globalThis : this);
