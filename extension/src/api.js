// api.js — read-only calls to claude.ai's internal (unofficial) web API.
// Uses your existing login (same-origin fetch sends your cookies). Never writes
// anything to your account: no branch/leaf changes, no messages, no deletes.
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  const TIMEOUT_MS = 15000;
  let orgId = null;
  let orgSource = 'none';      // shown in Diagnostics: 'cookie' | 'api' | 'none'
  let lastStatus = 'idle';     // shown in Diagnostics
  const inflight = new Map();  // convUuid → Promise, so overlapping refreshes share one request

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('claude.ai did not answer within 15 s');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Your active organisation. The lastActiveOrg cookie is what claude.ai itself
  // uses; /api/organizations is the fallback (pick the one that can chat, not just [0]).
  async function getOrgId(forceApi) {
    if (orgId && !forceApi) return orgId;
    const fromCookie = !forceApi && readCookie('lastActiveOrg');
    if (fromCookie && /^[0-9a-f-]{36}$/.test(fromCookie)) {
      orgId = fromCookie;
      orgSource = 'cookie';
      return orgId;
    }
    const orgs = await getJson('/api/organizations');
    const chatOrg = (orgs || []).find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || (orgs || [])[0];
    if (!chatOrg) throw new Error('No organisation found — are you logged in?');
    orgId = chatOrg.uuid;
    orgSource = 'api';
    return orgId;
  }

  function convUuidFromUrl() {
    const m = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/);
    return m ? m[1] : null;
  }

  async function fetchConversation(convUuid) {
    if (inflight.has(convUuid)) return inflight.get(convUuid);
    const p = (async () => {
      lastStatus = 'loading';
      const build = (org) =>
        `/api/organizations/${org}/chat_conversations/${convUuid}?tree=True&rendering_mode=messages&render_all_tools=true`;
      try {
        let data;
        try {
          data = await getJson(build(await getOrgId()));
        } catch (e) {
          // Cookie pointed at the wrong org (e.g. you switched accounts) → ask the API once.
          if (e.status === 403 || e.status === 404) data = await getJson(build(await getOrgId(true)));
          else throw e;
        }
        if (!data || !Array.isArray(data.chat_messages)) throw new Error('Unexpected API response (no chat_messages)');
        lastStatus = `ok (${data.chat_messages.length} messages)`;
        return data;
      } catch (e) {
        lastStatus = 'error: ' + e.message;
        throw e;
      } finally {
        inflight.delete(convUuid);
      }
    })();
    inflight.set(convUuid, p);
    return p;
  }

  CBT.api = {
    getOrgId,
    convUuidFromUrl,
    fetchConversation,
    diagnostics: () => ({ orgSource, orgId: orgId ? orgId.slice(0, 8) + '…' : null, lastStatus }),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
