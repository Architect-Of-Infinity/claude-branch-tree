// vault.js (page) — browse, preview and download what the vault saved.
'use strict';
(async function () {
  const CBT = globalThis.CBT;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const KINDS = [['doc', 'Documents'], ['file', 'Files Claude made'], ['upload', 'Your uploads'], ['reply', 'Claude replies']];

  let index = {};
  let selected = new URLSearchParams(location.search).get('conv');
  let tab = 'doc';
  let conv = null;

  async function loadIndex() {
    index = (await chrome.storage.local.get('vault:index'))['vault:index'] || {};
    const bytes = await chrome.storage.local.getBytesInUse(null);
    $('usage').textContent = `${Object.keys(index).length} chats · ${fmtSize(bytes)} used`;
  }

  function renderChats() {
    const q = $('q').value.trim().toLowerCase();
    const ids = Object.keys(index).sort((a, b) => index[b].updated - index[a].updated)
      .filter((id) => !q || index[id].title.toLowerCase().includes(q) || (index[id].names || '').includes(q));
    $('chats').innerHTML = ids.length
      ? ids.map((id) => `<div class="chat${id === selected ? ' sel' : ''}" data-id="${id}" tabindex="0"><div class="t">${esc(index[id].title)}</div>
          <div class="m">${index[id].items} items · ${fmtSize(index[id].bytes || 0)} · ${fmtDate(index[id].updated)}</div></div>`).join('')
      : `<div class="chats-empty">${q ? 'No chat matches.' : 'Nothing saved yet. Open a chat on claude.ai with the extension on.'}</div>`;
  }

  async function blobBytes(hash) {
    const b64 = (await chrome.storage.local.get('vault:b:' + hash))['vault:b:' + hash];
    if (!b64) return null;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function itemBytes(it) {
    if (it.blob) return blobBytes(it.blob);
    return new TextEncoder().encode(it.text || '');
  }
  function extOf(it) {
    const m = String(it.name || '').match(/\.[A-Za-z0-9]{1,8}$/);
    if (m) return '';
    if (it.kind === 'reply') return '.md';
    if (/html/.test(it.mime)) return '.html';
    if (/svg/.test(it.mime)) return '.svg';
    if (/react|jsx/.test(it.mime)) return '.jsx';
    if (/markdown|^text\/|^$/.test(it.mime || '')) return '.md';
    return '';
  }
  function fileNameFor(it) {
    const base = String(it.name || 'item').replace(/[\\/:*?"<>|]+/g, '_');
    const tag = `msg${it.turn || 0}${it.branch ? ' ' + it.branch.replace(/[^\w ,-]/g, '') : ''}`;
    const ext = extOf(it);
    const m = base.match(/^(.*?)(\.[^.]+)?$/);
    return `${m[1]} — ${tag}${m[2] || ''}${ext}`;
  }
  async function save(name, bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function selectChat(id) {
    selected = id;
    history.replaceState(null, '', `?conv=${id}`);
    conv = (await chrome.storage.local.get('vault:c:' + id))['vault:c:' + id] || { title: '?', items: [] };
    renderChats();
    renderDetail();
  }

  // Branch tag colour: same branch number → same colour everywhere.
  const HUES = [14, 200, 140, 280, 40, 330, 175, 95, 245, 0];
  function branchChip(label) {
    const m = String(label || '').match(/\d+/);
    const all = /all/.test(label || '');
    const bg = all ? 'var(--ink-3)' : m ? `hsl(${HUES[(+m[0] - 1) % HUES.length]} 55% 45%)` : 'var(--ink-3)';
    return `<span class="br" style="background:${bg}">${esc(label || 'branch ?')}</span>`;
  }
  function badgeFor(it) {
    const ext = (String(it.name || '').match(/\.([A-Za-z0-9]{1,5})$/) || [])[1];
    if (ext) return ext.toUpperCase();
    return { reply: 'TXT', doc: 'DOC', file: 'FILE', upload: 'FILE' }[it.kind];
  }
  const thumbs = new Map();
  async function thumbFor(it) {
    if (!/^image\//.test(it.mime || '') || !it.blob) return '';
    if (!thumbs.has(it.blob)) {
      const bytes = await blobBytes(it.blob);
      thumbs.set(it.blob, bytes ? URL.createObjectURL(new Blob([bytes], { type: it.mime })) : '');
    }
    const u = thumbs.get(it.blob);
    return u ? `<img class="thumb" src="${u}" alt="">` : '';
  }

  async function renderDetail() {
    if (!conv) return;
    const items = conv.items.filter((i) => i.kind === tab);
    const counts = Object.fromEntries(KINDS.map(([k]) => [k, conv.items.filter((i) => i.kind === k).length]));
    // group by document identity (path or name)
    const groups = new Map();
    for (const it of items.sort((a, b) => a.created - b.created)) {
      const key = it.kind === 'reply' ? `turn ${it.turn}` : it.path || it.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const notes = {
      doc: 'Text documents Claude wrote, rebuilt per branch from the chat history, so versions overwritten by another branch are still here.',
      file: "Files Claude shared with you (the download cards). claude.ai keeps each share as its own copy, so every branch's version is saved here, even ones the new layout no longer lets you reach.",
      upload: 'Files you attached to messages.',
      reply: "Full text of every Claude reply on every branch.",
    };
    const thumbsHtml = new Map();
    for (const it of items) thumbsHtml.set(it.id, await thumbFor(it));
    const empties = { doc: 'No documents were written in this chat.', file: 'Claude shared no files in this chat.', upload: 'You attached no files in this chat.', reply: 'Reply saving is off, or there are no replies yet.' };
    $('detail').innerHTML = `
      <div class="head"><h2>${esc(conv.title)}</h2>
        <button class="primary" id="zipAll">Download everything (.zip)</button>
        <a class="btnlink" href="https://claude.ai/chat/${selected}" target="_blank" rel="noopener">Open chat ↗</a>
        <button class="quiet" id="del">Remove</button></div>
      <div class="stats" role="tablist">${KINDS.map(([k, label]) => `<button class="stat${k === tab ? ' on' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}"><div class="n">${counts[k]}</div><div class="l">${label}</div></button>`).join('')}</div>
      <p class="note">${notes[tab]}</p>
      ${groups.size ? [...groups].map(([key, vers]) => `
        <div class="group"><div class="gh"><span class="badge">${esc(badgeFor(vers[0]))}</span><span class="name">${esc(vers[0].kind === 'reply' ? `Claude's reply to your message ${vers[0].turn}` : vers[0].name)}</span>
          <span class="n">${vers.length} version${vers.length > 1 ? 's' : ''}${vers[0].path && vers[0].path !== vers[0].name ? ' · ' + esc(vers[0].path) : ''}</span></div>
          ${vers.map((it) => `<div class="ver" data-id="${esc(it.id)}">
            ${thumbsHtml.get(it.id) || ''}${branchChip(it.branch)}
            <span class="meta">after your message ${it.turn || '?'} · ${fmtDate(it.created)} · ${fmtSize(it.size || 0)}</span>
            ${it.partial ? '<span class="pill" title="An edit in the history could not be replayed exactly">may be incomplete</span>' : ''}
            <button class="link" data-act="preview">Preview</button><button class="link" data-act="download">Download</button></div>`).join('')}
        </div>`).join('') : `<div class="empty"><h3>Nothing here</h3><p>${empties[tab]}</p></div>`}`;
  }

  $('chats').addEventListener('click', (e) => { const c = e.target.closest('.chat'); if (c) selectChat(c.dataset.id); });
  $('chats').addEventListener('keydown', (e) => { const c = e.target.closest('.chat'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectChat(c.dataset.id); } });
  $('q').addEventListener('input', renderChats);

  $('detail').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; renderDetail(); return; }
    if (e.target.id === 'zipAll') {
      e.target.disabled = true; e.target.textContent = 'Building zip…';
      const files = [];
      for (const it of conv.items) {
        const bytes = await itemBytes(it);
        if (!bytes) continue;
        const folder = { doc: 'documents', file: 'files', upload: 'uploads', reply: 'replies' }[it.kind];
        files.push({ name: `${folder}/${fileNameFor(it)}`, bytes, date: new Date(it.created || Date.now()) });
      }
      await save(`${conv.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat'}_vault.zip`, CBT.zip.makeZip(files), 'application/zip');
      e.target.disabled = false; e.target.textContent = 'Download everything (.zip)';
      return;
    }
    if (e.target.id === 'del') {
      if (!confirm(`Remove "${conv.title}" from the vault? (Files shared with other chats stay.)`)) return;
      await chrome.storage.local.remove('vault:c:' + selected);
      delete index[selected];
      await chrome.storage.local.set({ 'vault:index': index });
      await garbageCollect();
      conv = null; selected = null;
      $('detail').innerHTML = '<div class="empty">Removed.</div>';
      await loadIndex(); renderChats();
      return;
    }
    const act = e.target.dataset.act;
    if (!act) return;
    const row = e.target.closest('.ver');
    const it = conv.items.find((i) => i.id === row.dataset.id);
    if (act === 'download') { await save(fileNameFor(it), await itemBytes(it), it.mime); return; }
    if (act === 'preview') {
      const open = row.nextElementSibling && row.nextElementSibling.classList.contains('preview') && !row.nextElementSibling.classList.contains('ver');
      if (open) { row.nextElementSibling.remove(); return; }
      let el;
      if (/^image\//.test(it.mime || '')) {
        const bytes = await itemBytes(it);
        el = document.createElement('img');
        el.src = URL.createObjectURL(new Blob([bytes], { type: it.mime }));
      } else {
        el = document.createElement('pre');
        const bytes = await itemBytes(it);
        const text = new TextDecoder().decode(bytes.subarray(0, 200000));
        el.textContent = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2000)) ? `(binary file, ${fmtSize(bytes.length)} — use Download)` : text;
      }
      el.className = 'preview';
      row.after(el);
    }
  });

  // Delete blobs no chat refers to any more.
  async function garbageCollect() {
    const all = await chrome.storage.local.get(null);
    const live = new Set();
    for (const [k, v] of Object.entries(all)) if (k.startsWith('vault:c:')) for (const it of v.items || []) if (it.blob) live.add('vault:b:' + it.blob);
    const dead = Object.keys(all).filter((k) => k.startsWith('vault:b:') && !live.has(k));
    if (dead.length) await chrome.storage.local.remove(dead);
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes['vault:index']) return;
    await loadIndex(); renderChats();
    if (selected && changes['vault:index'].newValue && changes['vault:index'].newValue[selected]) {
      conv = (await chrome.storage.local.get('vault:c:' + selected))['vault:c:' + selected];
      renderDetail();
    }
  });

  await loadIndex();
  renderChats();
  if (selected && index[selected]) selectChat(selected);
})();
