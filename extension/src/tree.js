// tree.js — pure conversation-tree logic. No DOM, no chrome.* calls, so it
// can be unit-tested in Node (tests/tree.test.js).
//
// Vocabulary used throughout:
//   node      one message (yours = 'human', Claude's = 'assistant')
//   parent    the message it replies to (parent_message_uuid in the API)
//   fork      a node with 2+ children = a place where you edited or retried
//   version   one child of a fork; Claude's "< 2 / 3 >" arrows pick the version
//   leaf      a node with no children = the end of one branch
//   path      the list of nodes from the first message down to some node
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  // claude.ai uses this all-zeros-ish UUID as the parent of the first message.
  const ROOT_UUID = '00000000-0000-4000-8000-000000000000';

  // ---------- text helpers ----------

  // All text blocks of a message joined. Tool calls, thinking and files are skipped.
  function fullText(msg) {
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      if (parts.length) return parts.join('\n\n');
    }
    return typeof msg.text === 'string' ? msg.text : '';
  }

  // For comparing API text with on-screen text: markdown symbols differ between
  // the raw API text and what claude.ai renders, so strip them before comparing.
  function normForMatch(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[*_`#>~|\\[\]()!-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Two texts "match" if their first 48 normalised characters agree.
  // Prefix-only on purpose: the screen may truncate or add trailing UI text.
  // loose=true also accepts "API text's start appears somewhere on screen" —
  // used for Claude's replies, where a "Thought process" header or tool card
  // can sit above the reply text.
  function matchText(a, b, loose) {
    const na = normForMatch(a);
    const nb = normForMatch(b);
    if (!na || !nb) return false;
    const k = Math.min(48, na.length, nb.length);
    if (k < 4) return na === nb;
    if (na.slice(0, k) === nb.slice(0, k)) return true;
    return !!loose && na.length >= 12 && nb.includes(na.slice(0, Math.min(48, na.length)));
  }

  // Preview that counts CJK characters as 2 columns (kept from the original).
  // Light markdown → plain text for previews ("**bold**" → "bold", links → their text).
  function plain(s) {
    return String(s || '')
      .replace(/```[\s\S]*?```/g, ' ⟨code⟩ ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '');
  }

  function preview(text, len) {
    const t = plain(text).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    let w = 0;
    let out = '';
    for (const ch of t) {
      const cw = /[　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
      if (w + cw > len) return out + '…';
      out += ch;
      w += cw;
    }
    return out;
  }

  // ---------- building ----------

  // messages: data.chat_messages from the API. serverLeaf: data.current_leaf_message_uuid.
  function buildTree(messages, serverLeaf) {
    const nodes = new Map();
    for (const m of messages || []) {
      if (!m || !m.uuid || nodes.has(m.uuid)) continue;
      const text = fullText(m);
      nodes.set(m.uuid, {
        uuid: m.uuid,
        parent: m.parent_message_uuid && m.parent_message_uuid !== ROOT_UUID ? m.parent_message_uuid : null,
        sender: m.sender === 'human' ? 'human' : 'assistant',
        text,
        textLower: text.toLowerCase(),
        created: Date.parse(m.created_at) || 0,
        hasFiles: !!((m.files && m.files.length) || (m.attachments && m.attachments.length) || (m.files_v2 && m.files_v2.length)),
        children: [],
        versionIndex: 0,  // 0-based position among same-sender siblings (Claude's "k / n" minus 1)
        versionCount: 1,
        turn: 0,          // how many of YOUR messages are on the path down to here (incl. this one)
      });
    }

    const roots = [];
    for (const n of nodes.values()) {
      // A parent we never received (deleted / not returned) → treat as a root so nothing vanishes.
      if (n.parent && nodes.has(n.parent)) nodes.get(n.parent).children.push(n.uuid);
      else { n.parent = null; roots.push(n.uuid); }
    }

    const byCreated = (a, b) => nodes.get(a).created - nodes.get(b).created || (a < b ? -1 : 1);
    roots.sort(byCreated);
    for (const n of nodes.values()) n.children.sort(byCreated);

    // Version numbers + turn numbers, iteratively (no recursion → no stack limit on long chats).
    const assignVersions = (list) => {
      for (const sender of ['human', 'assistant']) {
        const same = list.filter((u) => nodes.get(u).sender === sender);
        same.forEach((u, i) => {
          const n = nodes.get(u);
          n.versionIndex = i;
          n.versionCount = same.length;
        });
      }
    };
    assignVersions(roots);
    const stack = roots.map((u) => [u, 0]);
    while (stack.length) {
      const [u, parentTurn] = stack.pop();
      const n = nodes.get(u);
      n.turn = parentTurn + (n.sender === 'human' ? 1 : 0);
      assignVersions(n.children);
      for (const c of n.children) stack.push([c, n.turn]);
    }

    const leaf = serverLeaf && nodes.has(serverLeaf) ? serverLeaf : latestLeafOf({ nodes, roots }, null);
    const tree = { nodes, roots, serverLeaf: leaf };
    tree.serverPath = pathTo(tree, leaf);
    tree.serverPathSet = new Set(tree.serverPath);
    return tree;
  }

  // root → uuid (inclusive). Guards against cycles in malformed data.
  function pathTo(tree, uuid) {
    const out = [];
    const seen = new Set();
    let u = uuid;
    while (u && tree.nodes.has(u) && !seen.has(u)) {
      seen.add(u);
      out.push(u);
      u = tree.nodes.get(u).parent;
    }
    return out.reverse();
  }

  // Follow the newest child down to a leaf. uuid=null → start from the newest root.
  function latestLeafOf(tree, uuid) {
    let u = uuid || tree.roots[tree.roots.length - 1] || null;
    while (u) {
      const kids = tree.nodes.get(u).children;
      if (!kids.length) break;
      u = kids[kids.length - 1];
    }
    return u;
  }

  function siblingsOf(tree, uuid) {
    const n = tree.nodes.get(uuid);
    const list = n.parent ? tree.nodes.get(n.parent).children : tree.roots;
    return list.filter((u) => tree.nodes.get(u).sender === n.sender);
  }

  // ---------- display (what the panel draws) ----------

  // In 'human' mode Claude's replies are hidden and your messages hang
  // directly under your previous message.
  function displayRoots(tree, mode) {
    return mode === 'full' ? tree.roots.slice() : nearestHumans(tree, tree.roots);
  }
  function displayChildren(tree, uuid, mode) {
    const kids = tree.nodes.get(uuid).children;
    return mode === 'full' ? kids.slice() : nearestHumans(tree, kids);
  }
  function nearestHumans(tree, list) {
    const out = [];
    const stack = list.slice().reverse();
    while (stack.length) {
      const u = stack.pop();
      const n = tree.nodes.get(u);
      if (n.sender === 'human') out.push(u);
      else for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return out;
  }

  // ---------- which branch is on screen? ----------
  //
  // claude.ai's version arrows only change the page, not the server's
  // current_leaf_message_uuid, so we work out the on-screen branch by matching
  // the messages rendered on the page against the tree.
  //
  // rendered: [{ role: 'human'|'assistant', text }] in page order. The page may
  // only render part of a long chat, so we anchor on the LAST rendered message
  // of yours and check backwards how many earlier ones agree.
  // hintLeaf (optional): the leaf the page was told to show (jump view) — used to
  // pick which of Claude's retry versions is on screen when the page can't say.
  function detectVisiblePath(tree, rendered, hintLeaf) {
    const fallback = {
      path: hintLeaf && tree.nodes.has(hintLeaf) ? pathTo(tree, hintLeaf) : tree.serverPath.slice(),
      mapping: new Map(), source: 'server', confidence: 0,
    };
    if (!rendered || !rendered.length || !tree.nodes.size) return fallback;
    const hintSet = hintLeaf && tree.nodes.has(hintLeaf) ? new Set(pathTo(tree, hintLeaf)) : tree.serverPathSet;

    // ---- exact mode: the page tells us the uuid of each of your messages ----
    const exact = [];
    rendered.forEach((r, i) => { if (r.role === 'human' && r.uuid && tree.nodes.has(r.uuid)) exact.push(i); });
    if (exact.length) {
      const lastIdx = exact[exact.length - 1];
      const anchor = rendered[lastIdx].uuid;
      const path = pathTo(tree, anchor);
      const mapping = new Map();
      for (const i of exact) mapping.set(rendered[i].uuid, i);
      let cur = anchor;
      for (let ri = lastIdx + 1; ri < rendered.length; ri++) {
        const r = rendered[ri];
        if (r.uuid && !tree.nodes.has(r.uuid)) break; // just sent, tree not refreshed yet
        const kids = tree.nodes.get(cur).children.filter((u) => tree.nodes.get(u).sender === r.role);
        if (!kids.length) break;
        const pick =
          (r.uuid && kids.includes(r.uuid) && r.uuid) ||
          kids.find((u) => hintSet.has(u)) ||
          kids.find((u) => matchText(tree.nodes.get(u).text, r.text, r.role === 'assistant')) ||
          kids[kids.length - 1];
        path.push(pick);
        mapping.set(pick, ri);
        cur = pick;
      }
      // Claude's replies between your messages: row whose turnKey = its parent.
      rendered.forEach((r, i) => {
        if (r.role !== 'assistant' || !r.turnKey) return;
        const u = path.find((p) => tree.nodes.get(p).sender === 'assistant' && tree.nodes.get(p).parent === r.turnKey);
        if (u && !mapping.has(u)) mapping.set(u, i);
      });
      return { path, mapping, source: 'dom', confidence: 1, exact: true };
    }

    const humanIdx = [];
    rendered.forEach((r, i) => { if (r.role === 'human') humanIdx.push(i); });
    if (!humanIdx.length) return fallback;

    const humanNodes = [...tree.nodes.values()].filter((n) => n.sender === 'human');

    for (let k = humanIdx.length - 1; k >= 0; k--) {
      const anchorText = rendered[humanIdx[k]].text;
      const candidates = humanNodes.filter((n) => matchText(n.text, anchorText));
      if (!candidates.length) continue; // e.g. a just-sent message not in the tree yet

      let best = null;
      for (const c of candidates) {
        const mapping = new Map();
        let score = 0;
        let ri = k;
        let u = c.uuid;
        while (u && ri >= 0) {
          const n = tree.nodes.get(u);
          if (n.sender === 'human') {
            if (!matchText(n.text, rendered[humanIdx[ri]].text)) break;
            mapping.set(u, humanIdx[ri]);
            score++;
            ri--;
          }
          u = n.parent;
        }
        const tie = (tree.serverPathSet.has(c.uuid) ? 0.5 : 0) + c.created / 1e15;
        const total = score + tie;
        if (!best || total > best.total) best = { node: c, mapping, score, total };
      }

      // Extend downward through whatever is rendered after the anchor.
      const path = pathTo(tree, best.node.uuid);
      const mapping = best.mapping;
      // Claude's replies between your matched messages: the reply sits right
      // after its parent message on the page. Needed to find its retry arrows.
      for (const u of path) {
        const n = tree.nodes.get(u);
        if (n.sender !== 'assistant' || !n.parent || !mapping.has(n.parent)) continue;
        const ri = mapping.get(n.parent) + 1;
        if (rendered[ri] && rendered[ri].role === 'assistant') mapping.set(u, ri);
      }
      let cur = best.node.uuid;
      let ri = humanIdx[k] + 1;
      while (ri < rendered.length) {
        const r = rendered[ri];
        const kids = tree.nodes.get(cur).children.filter((u) => tree.nodes.get(u).sender === r.role);
        if (!kids.length) break;
        const pick =
          kids.find((u) => matchText(tree.nodes.get(u).text, r.text, r.role === 'assistant')) ||
          kids.find((u) => hintSet.has(u)) ||
          kids[kids.length - 1];
        path.push(pick);
        mapping.set(pick, ri);
        cur = pick;
        ri++;
      }

      const expected = Math.min(humanIdx.length, tree.nodes.get(best.node.uuid).turn);
      return {
        path,
        mapping,
        source: 'dom',
        confidence: expected ? Math.min(1, best.score / expected) : 0,
      };
    }
    return fallback;
  }

  // First place where the on-screen path and the wanted path differ.
  // Returns null when the target is already on screen.
  function firstDivergence(tree, visiblePath, targetUuid) {
    const want = pathTo(tree, targetUuid);
    for (let i = 0; i < want.length; i++) {
      if (visiblePath[i] !== want[i]) {
        const wanted = want[i];
        const current = visiblePath[i];
        const sibs = siblingsOf(tree, wanted);
        return {
          depth: i,
          wanted,
          current: current && sibs.includes(current) ? current : null,
          wantedIndex: sibs.indexOf(wanted),
          currentIndex: current ? sibs.indexOf(current) : -1,
          siblingCount: sibs.length,
        };
      }
    }
    return null;
  }

  // ---------- search, stats, export ----------

  function search(tree, query, labels) {
    const q = String(query || '').trim().toLowerCase();
    const hits = new Set();
    if (!q) return hits;
    for (const n of tree.nodes.values()) {
      const label = labels && labels[n.uuid] ? String(labels[n.uuid]).toLowerCase() : '';
      if (n.textLower.includes(q) || label.includes(q)) hits.add(n.uuid);
    }
    return hits;
  }

  // Hits plus every ancestor, so matches stay reachable in the tree.
  function withAncestors(tree, set) {
    const out = new Set();
    for (const u of set) for (const a of pathTo(tree, u)) out.add(a);
    return out;
  }

  function stats(tree) {
    let human = 0, forks = 0, leaves = 0, maxTurn = 0;
    for (const n of tree.nodes.values()) {
      if (n.sender === 'human') human++;
      if (n.children.length > 1) forks++;
      if (!n.children.length) leaves++;
      if (n.turn > maxTurn) maxTurn = n.turn;
    }
    return { messages: tree.nodes.size, human, assistant: tree.nodes.size - human, forks, leaves, maxTurn };
  }

  function versionTag(n) {
    return n.versionCount > 1 ? `v${n.versionIndex + 1}/${n.versionCount}` : '';
  }

  function branchToMarkdown(tree, path, title) {
    const lines = [`# ${title || 'Claude conversation'} (one branch)`, ''];
    for (const u of path) {
      const n = tree.nodes.get(u);
      const who = n.sender === 'human' ? 'You' : 'Claude';
      const tag = versionTag(n);
      lines.push(`## ${who}${tag ? ` (${tag})` : ''}`, '', n.text || '_(no text: files or tool output only)_', '');
    }
    return lines.join('\n');
  }

  // uuid → "Branch 2" / "Branches 1, 3" / "all branches" (numbered by when each branch ended)
  function branchLabels(tree) {
    const leaves = [...tree.nodes.values()].filter((n) => !n.children.length).sort((a, b) => a.created - b.created);
    const sets = new Map();
    leaves.forEach((l, i) => { for (const u of pathTo(tree, l.uuid)) { if (!sets.has(u)) sets.set(u, []); sets.get(u).push(i + 1); } });
    const out = new Map();
    for (const [u, nums] of sets) {
      out.set(u, nums.length === leaves.length && leaves.length > 1 ? 'all branches' : nums.length === 1 ? `Branch ${nums[0]}` : `Branches ${nums.join(', ')}`);
    }
    return out;
  }

  // Every branch, full text, without repeating shared history: each branch
  // after the first starts at the point where it splits off an earlier one.
  function allBranchesToMarkdown(tree, title, labels) {
    const leaves = [...tree.nodes.values()].filter((n) => !n.children.length).sort((a, b) => a.created - b.created);
    const paths = leaves.map((l) => pathTo(tree, l.uuid));
    const lines = [`# ${title || 'Claude conversation'} (all ${paths.length} branches)`, ''];
    const firstSeenIn = new Map(); // uuid → branch number where it was first written out
    paths.forEach((p, bi) => {
      const n = bi + 1;
      const tip = tree.nodes.get(p[p.length - 1]);
      const label = labels && [...p].reverse().map((u) => labels[u]).find(Boolean);
      lines.push(`---`, '', `# Branch ${n}${label ? ` — ${label}` : ''}${tree.serverPathSet.has(tip.uuid) ? ' (latest on server)' : ''}`, '');
      let k = 0;
      while (k < p.length && firstSeenIn.has(p[k])) k++;
      if (k > 0) {
        const lastShared = tree.nodes.get(p[k - 1]);
        lines.push(`_Messages up to your message ${lastShared.turn} are the same as Branch ${firstSeenIn.get(p[k - 1])}._`, '');
      }
      for (let i = k; i < p.length; i++) {
        const node = tree.nodes.get(p[i]);
        firstSeenIn.set(p[i], n);
        const who = node.sender === 'human' ? `You (message ${node.turn})` : 'Claude';
        const tag = versionTag(node);
        const lab = labels && labels[p[i]] ? ` — ${labels[p[i]]}` : '';
        lines.push(`## ${who}${tag ? ` (${tag})` : ''}${lab}`, '', node.text || '_(no text: files or tool output only)_', '');
      }
    });
    return lines.join('\n');
  }

  function outlineToMarkdown(tree, mode, labels, title, previewLen) {
    const lines = [`# ${title || 'Claude conversation'} (branch outline)`, ''];
    const walk = (list, depth) => {
      for (const u of list) {
        const n = tree.nodes.get(u);
        const who = n.sender === 'human' ? `${n.turn}` : 'Claude';
        const tag = versionTag(n);
        const text = (labels && labels[u]) || preview(n.text, previewLen || 80) || '(no text)';
        const onPath = tree.serverPathSet.has(u) ? ' ◆' : '';
        lines.push(`${'  '.repeat(depth)}- **${who}${tag ? ' ' + tag : ''}** ${text}${onPath}`);
        walk(displayChildren(tree, u, mode), depth + 1);
      }
    };
    walk(displayRoots(tree, mode), 0);
    lines.push('', '◆ = latest branch saved on the server');
    return lines.join('\n');
  }

  CBT.tree = {
    ROOT_UUID, fullText, normForMatch, matchText, preview,
    buildTree, pathTo, latestLeafOf, siblingsOf,
    displayRoots, displayChildren,
    detectVisiblePath, firstDivergence,
    search, withAncestors, stats, versionTag,
    branchToMarkdown, outlineToMarkdown, allBranchesToMarkdown, branchLabels,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CBT.tree;
})(typeof globalThis !== 'undefined' ? globalThis : this);
