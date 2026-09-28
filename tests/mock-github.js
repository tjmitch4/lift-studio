/* In-memory mock of the GitHub REST endpoints Lift Studio uses (repo lookup + Git Data API),
   for tests/sync-test.html and for driving the real app in a browser without a token:
     const mock = mockGitHub(); window.fetch = mock.install(window.fetch);
   Tokens: GOOD (read+write), READONLY (permissions.push false), SNEAKYRO (claims push, but
   writes get 403 — how a read-only fine-grained token on your own repo behaves), OTHERREPO
   (can't see studio-data -> 404), anything else -> 401. Blob/tree/commit ids are real git
   blob shas for blobs, fake-but-stable shas for trees/commits. */
(function (root) {
  'use strict';
  const REPO = '/repos/tjmitch4/studio-data';

  async function sha1hex(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function blobSha(text) {
    const body = new TextEncoder().encode(text);
    const head = new TextEncoder().encode('blob ' + body.length + '\0');
    const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
    return sha1hex(all);
  }
  const strSha = s => sha1hex(new TextEncoder().encode(s));
  function b64(text) {
    const bytes = new TextEncoder().encode(text);
    let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/(.{60})/g, '$1\n'); // GitHub wraps base64 at 60 chars
  }

  function mockGitHub(opt) {
    opt = opt || {};
    const m = {
      calls: [], offline: false, beforePatch: null, rejectedPatches: 0, rateLimitNext: 0,
      blobs: new Map(), trees: new Map(), commits: new Map(), ref: null, history: [],
      tokens: {
        GOOD: { see: true, push: true, write: true },
        READONLY: { see: true, push: false, write: false },
        SNEAKYRO: { see: true, push: true, write: false },
        OTHERREPO: { see: false },
      },
      latencyMs: opt.latencyMs || 0,
    };
    let n = 0;
    async function putTree(map) {
      const sha = await strSha('tree:' + [...map.entries()].sort().map(e => e.join(' ')).join('\n'));
      m.trees.set(sha, new Map(map));
      return sha;
    }
    async function putCommit(tree, parents, message) {
      const sha = await strSha('commit:' + tree + ':' + parents.join(',') + ':' + message + ':' + (++n));
      m.commits.set(sha, { sha, tree, parents, message });
      return sha;
    }
    async function putBlob(text) { const sha = await blobSha(text); m.blobs.set(sha, text); return sha; }

    m.ready = (async () => {
      const files = opt.files || { 'README.md': '# studio-data\n', 'lift/.gitkeep': '', 'guitar/.gitkeep': '' };
      const map = new Map();
      for (const p of Object.keys(files)) map.set(p, await putBlob(files[p]));
      m.ref = await putCommit(await putTree(map), [], 'Initial commit');
      m.history.push(m.ref);
    })();
    m.headTree = () => m.trees.get(m.commits.get(m.ref).tree);
    m.files = () => { const out = {}; m.headTree().forEach((sha, p) => { out[p] = m.blobs.get(sha); }); return out; };
    m.commitCount = () => m.history.length;
    m.lastMessage = () => m.commits.get(m.ref).message;
    m.revoke = tok => { delete m.tokens[tok]; };
    // another client (GitHub web UI, the iOS Shortcut, Obsidian git, the other app) commits
    m.commitExternal = async (changes, message) => {
      await m.ready;
      const map = new Map(m.headTree());
      for (const p of Object.keys(changes)) {
        if (changes[p] === null) map.delete(p); else map.set(p, await putBlob(changes[p]));
      }
      m.ref = await putCommit(await putTree(map), [m.ref], message || 'external');
      m.history.push(m.ref);
    };

    const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
    m.fetch = async (url, init) => {
      init = init || {};
      await m.ready;
      const method = (init.method || 'GET').toUpperCase();
      const headers = init.headers || {};
      m.calls.push({ url, method, headers: Object.assign({}, headers), cache: init.cache, body: init.body || null });
      if (m.latencyMs) await new Promise(r => setTimeout(r, m.latencyMs));
      if (m.offline) throw new TypeError('Failed to fetch');
      const u = new URL(url);
      if (u.origin !== 'https://api.github.com') return json(404, { message: 'Not Found' });
      const tok = m.tokens[String(headers.Authorization || '').replace(/^Bearer /, '')];
      if (!tok) return json(401, { message: 'Bad credentials' });
      if (m.rateLimitNext > 0) {
        m.rateLimitNext--;
        return json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) });
      }
      const rl = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };
      if (!tok.see || u.pathname.indexOf(REPO) !== 0) return json(404, { message: 'Not Found' });
      const path = u.pathname.slice(REPO.length);
      const body = init.body ? JSON.parse(init.body) : null;
      let mm;
      if (method === 'GET' && path === '') {
        return json(200, { full_name: 'tjmitch4/studio-data', private: true, default_branch: 'main', permissions: { admin: false, maintain: false, push: tok.push, triage: tok.push, pull: true } }, rl);
      }
      if (method === 'GET' && path === '/git/ref/heads/main') return json(200, { ref: 'refs/heads/main', object: { sha: m.ref, type: 'commit' } }, rl);
      if (method === 'GET' && (mm = /^\/git\/commits\/([0-9a-f]+)$/.exec(path))) {
        const c = m.commits.get(mm[1]);
        return c ? json(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message }, rl) : json(404, { message: 'Not Found' });
      }
      if (method === 'GET' && (mm = /^\/git\/trees\/([0-9a-f]+)$/.exec(path))) {
        const t = m.trees.get(mm[1]);
        if (!t) return json(404, { message: 'Not Found' });
        const out = [], dirs = new Set();
        [...t.keys()].sort().forEach(p => {
          const parts = p.split('/');
          for (let i = 1; i < parts.length; i++) {
            const d = parts.slice(0, i).join('/');
            if (!dirs.has(d)) { dirs.add(d); out.push({ path: d, mode: '040000', type: 'tree', sha: 'd'.repeat(40) }); }
          }
          out.push({ path: p, mode: '100644', type: 'blob', sha: t.get(p), size: (m.blobs.get(t.get(p)) || '').length });
        });
        return json(200, { sha: mm[1], tree: u.searchParams.get('recursive') ? out : out.filter(e => e.path.indexOf('/') < 0), truncated: false }, rl);
      }
      if (method === 'GET' && (mm = /^\/git\/blobs\/([0-9a-f]+)$/.exec(path))) {
        if (!m.blobs.has(mm[1])) return json(404, { message: 'Not Found' });
        const text = m.blobs.get(mm[1]);
        return json(200, { sha: mm[1], encoding: 'base64', content: b64(text), size: new TextEncoder().encode(text).length }, rl);
      }
      if (method !== 'GET' && !tok.write) return json(403, { message: 'Resource not accessible by personal access token' });
      if (method === 'POST' && path === '/git/trees') {
        const baseT = m.trees.get(body.base_tree);
        if (!baseT) return json(422, { message: 'base_tree not found' });
        const map = new Map(baseT);
        for (const e of body.tree) {
          if (!e.path || e.mode !== '100644' || e.type !== 'blob') return json(422, { message: 'bad tree entry' });
          if (e.sha === null) { if (!map.has(e.path)) return json(422, { message: 'GitHub: path not in tree ' + e.path }); map.delete(e.path); }
          else if (typeof e.content === 'string') map.set(e.path, await putBlob(e.content));
          else if (e.sha) map.set(e.path, e.sha);
        }
        const sha = await putTree(map);
        return json(201, { sha, tree: [...map.keys()].filter(p => p.indexOf('/') < 0).map(p => ({ path: p, type: 'blob', sha: map.get(p) })) }, rl);
      }
      if (method === 'POST' && path === '/git/commits') {
        if (!m.trees.has(body.tree)) return json(422, { message: 'tree not found' });
        const sha = await putCommit(body.tree, body.parents || [], body.message || '');
        return json(201, { sha, tree: { sha: body.tree }, message: body.message }, rl);
      }
      if (method === 'PATCH' && path === '/git/refs/heads/main') {
        if (m.beforePatch) await m.beforePatch();
        const c = m.commits.get(body.sha);
        if (!c) return json(422, { message: 'Object does not exist' });
        if (!body.force && c.parents[0] !== m.ref) { m.rejectedPatches++; return json(422, { message: 'Update is not a fast forward' }); }
        m.ref = body.sha; m.history.push(m.ref);
        return json(200, { ref: 'refs/heads/main', object: { sha: m.ref } }, rl);
      }
      return json(404, { message: 'Not Found (mock: ' + method + ' ' + path + ')' });
    };
    // browser use: route only api.github.com through the mock
    m.install = realFetch => (url, init) => (String(url).indexOf('https://api.github.com/') === 0 ? m.fetch(String(url), init) : realFetch(url, init));
    return m;
  }
  root.mockGitHub = mockGitHub;
})(typeof window !== 'undefined' ? window : globalThis);
