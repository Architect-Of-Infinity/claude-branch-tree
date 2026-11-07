// page-hook.js — runs in the PAGE's JavaScript world (MAIN) at document_start,
// before claude.ai's own code. Two jobs:
//
// 1. NOTICE (passive): when claude.ai sends / edits / retries, post a tiny
//    "something changed" signal so the extension refreshes its tree.
//
// 2. JUMP VIEW (only when you asked to switch branch): claude.ai's new layout
//    has no version arrows, and the server ignores "set current branch" for
//    new-style chats. So to show another branch we reload the page and, while
//    it loads, swap ONE value in the chat's load data — the id of the branch's
//    last message (current_leaf_message_id) — for the branch you picked.
//    UUIDs are always 36 characters, so the swap is byte-for-byte the same
//    length and nothing else in the data moves. Only this tab sees it; nothing
//    is sent to the server; a normal reload goes back to the latest branch.
(function () {
  'use strict';
  if (window.__cbtHookInstalled) return;
  window.__cbtHookInstalled = true;

  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') return;
  const html = document.documentElement;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function signal(kind, extra) {
    try { window.postMessage({ source: 'cbt-page-hook', kind, ...(extra || {}) }, location.origin); } catch (_) {}
  }

  // ---------- jump request left by the extension just before it reloaded ----------
  let jump = null;
  try {
    const raw = sessionStorage.getItem('cbt-jump');
    if (raw) {
      sessionStorage.removeItem('cbt-jump'); // one-shot: a manual reload returns to latest
      const j = JSON.parse(raw);
      const conv = (location.pathname.match(/^\/chat\/([0-9a-f-]{36})/) || [])[1];
      if (j && j.conv === conv && UUID_RE.test(j.from) && UUID_RE.test(j.to) && j.from !== j.to && Date.now() - j.ts < 120000) {
        jump = { ...j, hits: 0 };
        html.setAttribute('data-cbt-jump', 'pending');
      }
    }
  } catch (_) {}

  const enc = new TextEncoder();
  const LOAD_RPC = /ConversationService\/(StreamTimeline|ReadConversation)\b/; // URL: …v1alpha.ConversationService/StreamTimeline

  // Pattern in the binary (protobuf) data: tag byte 0x3A (= field 7, a string),
  // length byte 0x24 (= 36), then the 36 characters of the old leaf id.
  function byteRewriter(from, to) {
    const pat = new Uint8Array([0x3a, 0x24, ...enc.encode(from)]);
    const rep = enc.encode(to);
    let carry = new Uint8Array(0);
    const find = (buf, start) => {
      outer: for (let i = start; i <= buf.length - pat.length; i++) {
        for (let k = 0; k < pat.length; k++) if (buf[i + k] !== pat[k]) continue outer;
        return i;
      }
      return -1;
    };
    return {
      push(chunk) {
        const buf = new Uint8Array(carry.length + chunk.length);
        buf.set(carry); buf.set(chunk, carry.length);
        let i = find(buf, 0);
        while (i >= 0) { buf.set(rep, i + 2); jump.hits++; i = find(buf, i + pat.length); }
        // Hold back the tail in case the pattern is split across two chunks.
        const keep = Math.min(buf.length, pat.length - 1);
        carry = buf.slice(buf.length - keep);
        return buf.subarray(0, buf.length - keep);
      },
      flush() { const c = carry; carry = new Uint8Array(0); return c; },
    };
  }

  // Connect streaming responses are a series of frames: 1 flag byte (bit 0 =
  // gzip-compressed, bit 1 = end-of-stream), 4-byte big-endian length, payload.
  // Uncompressed frames: swap in place. Compressed frames (if the page managed to
  // ask for gzip anyway): unzip, swap, and pass on UNcompressed (flag cleared) —
  // Connect clients accept that.
  function frameRewriter(from, to) {
    const pat = new Uint8Array([0x3a, 0x24, ...enc.encode(from)]);
    const rep = enc.encode(to);
    let buf = new Uint8Array(0);
    const swap = (u8) => {
      outer: for (let i = 0; i <= u8.length - pat.length; i++) {
        for (let k = 0; k < pat.length; k++) if (u8[i + k] !== pat[k]) continue outer;
        u8.set(rep, i + 2); jump.hits++; i += pat.length - 1;
      }
      return u8;
    };
    const gunzip = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const frame = (flags, payload) => {
      const out = new Uint8Array(5 + payload.length);
      out[0] = flags; new DataView(out.buffer).setUint32(1, payload.length); out.set(payload, 5);
      return out;
    };
    return {
      async push(chunk) {
        const n = new Uint8Array(buf.length + chunk.length); n.set(buf); n.set(chunk, buf.length); buf = n;
        const out = [];
        while (buf.length >= 5) {
          const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
          if (buf.length < 5 + len) break;
          const flags = buf[0];
          let payload = buf.slice(5, 5 + len);
          buf = buf.slice(5 + len);
          if (flags & 2) { out.push(frame(flags, payload)); continue; }       // end-of-stream trailer
          if (flags & 1) {
            try { payload = swap(await gunzip(payload)); out.push(frame(flags & ~1, payload)); }
            catch (_) { out.push(frame(flags, payload)); }                     // couldn't unzip: pass through
          } else out.push(frame(flags, swap(payload)));
        }
        return out;
      },
      flush() { const c = buf; buf = new Uint8Array(0); return c.length ? [c] : []; },
    };
  }

  function markApplied() {
    if (html.getAttribute('data-cbt-jump') === 'applied') return;
    html.setAttribute('data-cbt-jump', 'applied');
    try { sessionStorage.setItem('cbt-jump-done', JSON.stringify({ conv: jump.conv, to: jump.to, focus: jump.focus, ts: Date.now() })); } catch (_) {}
    signal('jump-applied');
  }

  function rewriteResponse(res) {
    if (!res.body) return res;
    const ctype = res.headers.get('content-type') || '';
    const isJson = /json/.test(ctype);
    if (/connect\+proto/.test(ctype)) {
      const fr = frameRewriter(jump.from, jump.to);
      const before = jump.hits;
      const stream = res.body.pipeThrough(new TransformStream({
        async transform(chunk, ctl) {
          for (const f of await fr.push(chunk)) ctl.enqueue(f);
          if (jump.hits > before) markApplied();
        },
        flush(ctl) { for (const f of fr.flush()) ctl.enqueue(f); },
      }));
      const headers = new Headers(res.headers);
      headers.delete('connect-content-encoding'); // frames we emit are uncompressed
      return new Response(stream, { status: res.status, statusText: res.statusText, headers });
    }
    let rw;
    if (isJson) {
      // JSON flavour of the same API: swap the id inside "currentLeafMessageId":"…"
      const a = enc.encode(`"currentLeafMessageId":"${jump.from}"`);
      const b = enc.encode(`"currentLeafMessageId":"${jump.to}"`);
      rw = (() => { // same length → same byte trick, different pattern
        const pat = a, rep = b; let carry = new Uint8Array(0);
        return {
          push(chunk) {
            const buf = new Uint8Array(carry.length + chunk.length); buf.set(carry); buf.set(chunk, carry.length);
            for (let i = 0; i <= buf.length - pat.length; i++) {
              let ok = true; for (let k = 0; k < pat.length; k++) if (buf[i + k] !== pat[k]) { ok = false; break; }
              if (ok) { buf.set(rep, i); jump.hits++; i += pat.length - 1; }
            }
            const keep = Math.min(buf.length, pat.length - 1);
            carry = buf.slice(buf.length - keep);
            return buf.subarray(0, buf.length - keep);
          },
          flush() { const c = carry; carry = new Uint8Array(0); return c; },
        };
      })();
    } else {
      rw = byteRewriter(jump.from, jump.to);
    }
    const before = jump.hits;
    const stream = res.body.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        const out = rw.push(chunk);
        if (out.length) ctl.enqueue(out);
        if (jump.hits > before) markApplied();
      },
      flush(ctl) { const c = rw.flush(); if (c.length) ctl.enqueue(c); },
    }));
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  // ---------- fetch wrapper ----------
  const INTERESTING = /\/chat_conversations\/|completion|PerformAction|SendAndSettle/i;

  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (_) {}

    if (jump && LOAD_RPC.test(url)) {
      try {
        // Ask for uncompressed frames so the id is visible to swap (verified live:
        // with "connect-accept-encoding: gzip" the server gzips each frame).
        // HTTP-level gzip is undone by the browser before we see the bytes.
        const strip = (hs) => { const h = new Headers(hs); h.delete('connect-accept-encoding'); return h; };
        if (init && init.headers) init = { ...init, headers: strip(init.headers) };
        else if (typeof Request !== 'undefined' && input instanceof Request && input.headers.has('connect-accept-encoding')) {
          input = new Request(input, { headers: strip(input.headers) });
        }
      } catch (_) {}
      return origFetch.call(this, input, init).then((res) => {
        try { return rewriteResponse(res); } catch (_) { return res; }
      });
    }

    const p = origFetch.apply(this, arguments);
    try {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (INTERESTING.test(url) && method !== 'GET' && !/ReportViewing/.test(url)) {
        signal('mutation-start');
        p.then(() => signal('mutation-done'), () => {});
      }
    } catch (_) {}
    return p;
  };
  try { Object.defineProperty(window.fetch, 'name', { value: 'fetch' }); } catch (_) {}

  // The extension's own scripts can't see page variables, but they share the DOM.
  try { html.setAttribute('data-cbt-hook', '2'); } catch (_) {}

  // If a jump never matched anything, tell the extension (claude.ai changed something).
  if (jump) {
    setTimeout(() => {
      if (html.getAttribute('data-cbt-jump') === 'pending') {
        html.setAttribute('data-cbt-jump', 'missed');
        try { sessionStorage.setItem('cbt-jump-done', JSON.stringify({ conv: jump.conv, missed: true, ts: Date.now() })); } catch (_) {}
        signal('jump-missed');
      }
    }, 15000);
  }
})();
