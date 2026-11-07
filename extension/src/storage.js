// storage.js — per-conversation labels, stars and collapsed state, plus panel geometry.
// Stored in chrome.storage.local (on this computer only; ~10 MB budget).
// Each conversation is its own key ("conv:<uuid>") so one write never rewrites everything.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  const INDEX_KEY = 'convIndex';      // { [convUuid]: lastTouchedMs } — for pruning
  const MAX_CONVS = 500;              // forget collapsed state of the oldest chats beyond this
  const GEOMETRY_KEY = 'geometry';

  const empty = () => ({ labels: {}, stars: [], collapsed: [] });

  async function loadConv(convUuid) {
    const key = 'conv:' + convUuid;
    const got = await chrome.storage.local.get(key);
    return { ...empty(), ...(got[key] || {}) };
  }

  // Debounced per conversation, so rapid clicks (collapse, star) cost one write.
  const pending = new Map();
  function saveConv(convUuid, data) {
    clearTimeout(pending.get(convUuid));
    pending.set(convUuid, setTimeout(async () => {
      pending.delete(convUuid);
      const key = 'conv:' + convUuid;
      const hasContent = Object.keys(data.labels).length || data.stars.length || data.collapsed.length;
      try {
        if (hasContent) await chrome.storage.local.set({ [key]: data });
        else await chrome.storage.local.remove(key);
        await touchIndex(convUuid, !!hasContent);
      } catch (e) {
        console.warn('[Branch Tree] save failed', e);
      }
    }, 300));
  }

  async function touchIndex(convUuid, keep) {
    const got = await chrome.storage.local.get(INDEX_KEY);
    const index = got[INDEX_KEY] || {};
    if (keep) index[convUuid] = Date.now();
    else delete index[convUuid];
    const ids = Object.keys(index);
    if (ids.length > MAX_CONVS) {
      // Prune oldest chats that have NO labels or stars (never throw away your labels).
      ids.sort((a, b) => index[a] - index[b]);
      for (const id of ids.slice(0, ids.length - MAX_CONVS)) {
        const k = 'conv:' + id;
        const d = (await chrome.storage.local.get(k))[k];
        if (d && !Object.keys(d.labels || {}).length && !(d.stars || []).length) {
          await chrome.storage.local.remove(k);
          delete index[id];
        }
      }
    }
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }

  async function loadGeometry() {
    const got = await chrome.storage.local.get(GEOMETRY_KEY);
    return got[GEOMETRY_KEY] || null;
  }
  async function saveGeometry(geo) {
    await chrome.storage.local.set({ [GEOMETRY_KEY]: geo });
  }

  // Backup / restore of everything (used by the options page).
  async function exportAll() {
    const all = await chrome.storage.local.get(null);
    const out = { format: 'claude-branch-tree-backup', version: 1, exported: new Date().toISOString(), conversations: {} };
    for (const [k, v] of Object.entries(all)) if (k.startsWith('conv:')) out.conversations[k.slice(5)] = v;
    return out;
  }
  async function importAll(backup, merge) {
    if (!backup || backup.format !== 'claude-branch-tree-backup' || typeof backup.conversations !== 'object') {
      throw new Error('Not a Branch Tree backup file');
    }
    let count = 0;
    for (const [id, data] of Object.entries(backup.conversations)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const current = merge ? await loadConv(id) : empty();
      const next = {
        labels: { ...current.labels, ...(data.labels || {}) },
        stars: [...new Set([...(current.stars || []), ...(data.stars || [])])],
        collapsed: [...new Set([...(current.collapsed || []), ...(data.collapsed || [])])],
      };
      await chrome.storage.local.set({ ['conv:' + id]: next });
      await touchIndex(id, true);
      count++;
    }
    return count;
  }

  CBT.storage = { loadConv, saveConv, loadGeometry, saveGeometry, exportAll, importAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
