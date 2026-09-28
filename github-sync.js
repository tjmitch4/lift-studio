/* Lift Studio — GitHub sync engine. Syncs the local log with Markdown files under lift/ in
   the private tjmitch4/studio-data repo, one commit per sync, via the Git Data API.
   No DOM rendering here: the app passes hooks in. Local-first: the app always reads and
   writes localStorage; this engine reconciles that copy with the repo using LiftMerge.

   One sync pass (restarted from the top on a non-fast-forward, max 3 tries):
     1. ref -> head commit -> its tree (recursive), filtered to lift/
        (fast path: head unchanged since our last sync and no local change -> done, 1 request)
     2. fetch only blobs that changed since the last sync (cached path -> sha map), or whose
        local counterpart changed (so the merge always sees the real remote record)
     3. inbox/*.csv|json -> app's watch import (dedupes); scheduled for deletion
     4. files gone remotely that weren't edited here since the last sync -> deleted here
     5. merge (LiftMerge: updatedAt wins, tombstones, per-field settings) -> app adopts it
     6. serialize every record; upload only records whose content differs from the repo;
        tombstoned records -> tree entry with sha null; COACH.md regenerated when data changed
     7. POST trees (base_tree + inline content) -> POST commits -> PATCH ref (force:false)
   Network trouble and rate limits are never alerts: status goes to 'offline' and a backoff
   timer retries. The token is only ever sent in the Authorization header. */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const MAX_TRIES = 3;
  const FETCH_CONCURRENCY = 6;

  class SyncError extends Error {
    constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
  }

  // ------------------------------------------------------------ encoding helpers
  function b64ToUtf8(b64) {
    const bin = root.atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function utf8ToB64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return root.btoa(s);
  }
  // git's blob id: sha1("blob <byte length>\0" + bytes) — lets us know the repo's sha for
  // content we uploaded without another request
  async function gitBlobSha(text) {
    const body = new TextEncoder().encode(String(text));
    const head = new TextEncoder().encode('blob ' + body.length + '\0');
    const all = new Uint8Array(head.length + body.length);
    all.set(head, 0); all.set(body, head.length);
    const d = new Uint8Array(await root.crypto.subtle.digest('SHA-1', all));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  }
  function platformOf(ua) {
    ua = String(ua || '');
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return 'browser';
  }

  function create(o) {
    const opts = Object.assign({
      owner: 'tjmitch4', repo: 'studio-data', branch: 'main', prefix: 'lift/', appName: 'lift',
      tokenKey: 'studioData.githubToken',   // shared with Guitar Studio (same origin)
      storageKey: 'liftstudio.github',      // this app's sync bookkeeping
      deviceKey: 'liftstudio.deviceId',
      storage: root.localStorage,
      fetch: (...a) => root.fetch(...a),    // late-bound so tests can monkeypatch window.fetch
      userAgent: (root.navigator && root.navigator.userAgent) || '',
      getState: () => null,                 // current local state (not mutated by the engine)
      applyState: () => {},                 // (merged) -> app adopts + saves it
      normalize: s => s,
      merge: (a, b) => b,
      canSync: () => true,                  // false while local data is unreadable/blocked
      isBusy: () => false,                  // true to postpone (e.g. finish-workout sheet open)
      importInbox: () => ({ parsed: 0, added: 0 }), // (text, path) -> counts; mutates app state
      coachMarkdown: () => '',              // COACH.md body, generated from the adopted state
      onStatus: () => {},
      log: (...a) => { try { console.info('[sync]', ...a); } catch (e) {} },
      debounceMs: 5000,
      activeDebounceMs: 20000,
      intervalMs: 120000,
    }, o || {});
    const LM = root.LiftMerge, MD = root.LiftMd;
    const base = `/repos/${opts.owner}/${opts.repo}`;

    // ------------------------------------------------------------ persisted engine state
    let st = readStore();
    function readStore() {
      try { const v = JSON.parse(opts.storage.getItem(opts.storageKey) || '{}'); return v && typeof v === 'object' ? v : {}; }
      catch (e) { return {}; }
    }
    function writeStore() { try { opts.storage.setItem(opts.storageKey, JSON.stringify(st)); } catch (e) {} }
    function getToken() {
      try { return String(opts.storage.getItem(opts.tokenKey) || '').trim(); } catch (e) { return ''; }
    }
    const connected = () => !!getToken();
    function deviceLabel() {
      let id = '';
      try { id = opts.storage.getItem(opts.deviceKey) || ''; } catch (e) {}
      if (!/^[a-z0-9]{4,8}$/.test(id)) {
        id = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
        try { opts.storage.setItem(opts.deviceKey, id); } catch (e) {}
      }
      return platformOf(opts.userAgent) + '-' + id;
    }

    // ------------------------------------------------------------ status
    let syncing = false;
    function computeState() {
      if (!connected()) return 'signedout';
      if (syncing) return 'syncing';
      if (st.lastError) return st.lastErrorKind === 'network' || st.lastErrorKind === 'ratelimit' ? 'offline' : 'error';
      return st.lastSyncedAt ? 'synced' : 'idle';
    }
    function getStatus() {
      return {
        state: computeState(), connected: connected(),
        lastSyncedAt: st.lastSyncedAt || null, lastError: st.lastError || null, lastErrorKind: st.lastErrorKind || null,
        warnings: (st.warnings || []).slice(), notice: st.notice || '', device: deviceLabel(),
        repoUrl: `https://github.com/${opts.owner}/${opts.repo}/tree/${opts.branch}/${opts.prefix.replace(/\/$/, '')}`,
      };
    }
    function emit() { try { opts.onStatus(getStatus()); } catch (e) {} }
    function setError(e) {
      st.lastError = (e && e.message) || String(e); st.lastErrorKind = (e && e.kind) || 'http'; writeStore();
    }
    function clearError() { delete st.lastError; delete st.lastErrorKind; }

    // ------------------------------------------------------------ HTTP
    let backoffUntil = 0;
    function noteRateHeaders(res) {
      const h = n => (res.headers && res.headers.get ? res.headers.get(n) : null);
      const remaining = h('x-ratelimit-remaining'), reset = Number(h('x-ratelimit-reset'));
      if (remaining === '0' && reset) backoffUntil = Math.max(backoffUntil, reset * 1000 + 1000);
      const ra = Number(h('retry-after'));
      if (ra > 0) backoffUntil = Math.max(backoffUntil, Date.now() + ra * 1000);
    }
    async function gh(method, path, body, token) {
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const init = { method, headers, cache: 'no-store' };
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      let res;
      try { res = await opts.fetch(API + path, init); }
      catch (e) { throw new SyncError('network', 'Offline — will retry'); }
      noteRateHeaders(res);
      if (res.ok) {
        const t = await res.text();
        try { return t ? JSON.parse(t) : {}; } catch (e) { throw new SyncError('network', 'Garbled reply from GitHub — will retry'); }
      }
      let msg = '';
      try { const j = await res.json(); msg = (j && j.message) || ''; } catch (e) {}
      const remaining = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
      if (res.status === 429 || (res.status === 403 && (remaining === '0' || /rate limit/i.test(msg)))) {
        if (backoffUntil < Date.now()) backoffUntil = Date.now() + 60000;
        throw new SyncError('ratelimit', 'GitHub rate limit — will retry', res.status);
      }
      if (res.status >= 500) throw new SyncError('network', 'GitHub is having trouble — will retry', res.status);
      if (res.status === 401) throw new SyncError('auth', 'GitHub token expired or revoked — paste a new one in the Sync card.', 401);
      if (res.status === 403) {
        throw new SyncError('forbidden', /not accessible|permission/i.test(msg)
          ? `This token can't write to ${opts.repo}. Edit it on GitHub: Repository permissions → Contents → Read and write.`
          : 'GitHub refused the request' + (msg ? ': ' + msg : ''), 403);
      }
      if (res.status === 404) {
        throw new SyncError('notfound', `This token can't see ${opts.owner}/${opts.repo}. Edit it on GitHub: Repository access → Only select repositories → ${opts.repo}.`, 404);
      }
      if (res.status === 409 || res.status === 422) throw new SyncError('conflict', msg || 'Conflict', res.status);
      throw new SyncError('http', 'GitHub error ' + res.status + (msg ? ': ' + msg : ''), res.status);
    }

    // ------------------------------------------------------------ connect / disconnect
    // Validates a pasted token against the data repo before storing it.
    async function connect(rawToken) {
      const token = String(rawToken || '').trim();
      if (!token) throw new SyncError('input', 'Paste your GitHub token first.');
      if (/\s/.test(token)) throw new SyncError('input', 'That doesn\'t look like a token — it has spaces in it.');
      let repo;
      try { repo = await gh('GET', base, undefined, token); }
      catch (e) {
        if (e.kind === 'auth') throw new SyncError('auth', 'GitHub rejected that token. Check you copied all of it and that it hasn\'t expired.', 401);
        if (e.kind === 'network') throw new SyncError('network', 'No connection to GitHub — try again.');
        throw e;
      }
      if (repo && repo.permissions && repo.permissions.push === false) {
        throw new SyncError('readonly', `That token can only read ${opts.repo}. Edit it on GitHub: Repository permissions → Contents → Read and write.`);
      }
      try { opts.storage.setItem(opts.tokenKey, token); } catch (e) { throw new SyncError('storage', 'Couldn\'t save the token on this device.'); }
      clearError(); delete st.lastCommit; delete st.localSig; delete st.files; delete st.notice; writeStore();
      emit();
      return syncNow('connect');
    }
    function disconnect() {
      try { opts.storage.removeItem(opts.tokenKey); } catch (e) {}
      clearTimeout(timer); timer = null; timerDue = 0;
      clearError(); delete st.lastCommit; delete st.localSig; delete st.files; delete st.notice; writeStore();
      emit();
    }

    // ------------------------------------------------------------ hashing / views
    const canon = v => LM.canonical(v);
    const hashOf = v => LM.hashString(canon(v));
    // everything that syncs (the rest timer is device-local)
    function syncView(s) {
      const v = Object.assign({}, s);
      v.active = MD.activeView(s.active);
      return v;
    }
    const localSig = s => hashOf(syncView(s));
    function nonActiveSig(s) {
      const v = Object.assign({}, s);
      delete v.active; delete v.activeUpdatedAt;
      return hashOf(v);
    }
    // per-file content hashes of a (normalized) state, keyed by kind + id
    function recordHashes(s) {
      const out = { sessions: new Map(), cardio: new Map(), settings: hashOf(MD.settingsBundle(s)), active: null, activeId: null };
      (s.sessions || []).forEach(r => out.sessions.set(String(r.id), hashOf(r)));
      (s.cardio || []).forEach(r => out.cardio.set(String(r.id), hashOf(r)));
      const ab = MD.activeBundle(s);
      if (ab) { out.active = hashOf(ab); out.activeId = String(ab.active.id); }
      return out;
    }
    const tombIds = (s, kind) => new Set((((s.tombstones || {})[kind]) || []).map(t => String(t.id)));

    async function mapLimit(items, n, fn) {
      const out = new Array(items.length);
      let i = 0;
      const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
      return out;
    }

    // ------------------------------------------------------------ one attempt
    async function attempt(token) {
      const ref = await gh('GET', `${base}/git/ref/heads/${opts.branch}`, undefined, token);
      const head = ref && ref.object && ref.object.sha;
      if (!head) throw new SyncError('http', 'GitHub returned no branch head');
      if (head === st.lastCommit && st.localSig && st.localSig === localSig(opts.getState())) return 'unchanged';

      const commit = await gh('GET', `${base}/git/commits/${head}`, undefined, token);
      const treeSha = commit && commit.tree && commit.tree.sha;
      const tree = await gh('GET', `${base}/git/trees/${treeSha}?recursive=1`, undefined, token);
      if (tree.truncated) opts.log('warning: repo tree listing truncated by GitHub');
      const remote = new Map(); // path -> blob sha (our prefix only)
      (tree.tree || []).forEach(e => { if (e && e.type === 'blob' && String(e.path).indexOf(opts.prefix) === 0) remote.set(e.path, e.sha); });

      const cache = st.files || {};
      const warnings = [];
      const pre = recordHashes(opts.normalize(JSON.parse(JSON.stringify(opts.getState()))));
      const preTombs = { sessions: tombIds(opts.getState(), 'sessions'), cardio: tombIds(opts.getState(), 'cardio') };

      // ---- 2. decide what to download
      const toFetch = [], inbox = [];
      remote.forEach((sha, path) => {
        const kind = MD.kindOfPath(path);
        if (!kind) return;
        if (kind === 'inbox') { inbox.push({ path, sha }); return; }
        const c = cache[path];
        if (c && c.sha === sha) {
          if (c.bad) { warnings.push(path); return; } // known-unreadable, unchanged: leave it alone
          let localH;
          if (kind === 'settings') localH = pre.settings;
          else if (kind === 'active') localH = pre.active;
          else localH = pre[kind].get(String(c.id));
          const deletedHere = (kind === 'sessions' || kind === 'cardio') && preTombs[kind].has(String(c.id));
          if (localH === c.h || deletedHere) return; // both sides as of the last sync (or deleted here)
        }
        toFetch.push({ path, sha, kind });
      });
      const texts = await mapLimit(toFetch.concat(inbox), FETCH_CONCURRENCY, async f => {
        const blob = await gh('GET', `${base}/git/blobs/${f.sha}`, undefined, token);
        return blob.encoding === 'base64' ? b64ToUtf8(blob.content) : String(blob.content || '');
      });
      const fetched = []; // {path, sha, kind, rec}
      const badFiles = {};
      toFetch.forEach((f, i) => {
        try { fetched.push(Object.assign({}, f, { rec: MD.parseAs(f.kind, texts[i]) })); }
        catch (e) {
          badFiles[f.path] = f.sha; warnings.push(f.path);
          opts.log('skipping unreadable file', f.path, e && e.message);
        }
      });
      const inboxTexts = inbox.map((f, i) => Object.assign({}, f, { text: texts[toFetch.length + i] }));

      // ================= synchronous section: snapshot -> merge -> adopt (no awaits) =========
      if (!opts.canSync()) throw new SyncError('blocked', 'Local data is unreadable — sync paused so nothing gets overwritten.');
      // ---- 3. Apple Watch inbox
      const inboxDelete = [];
      let inboxAdded = 0;
      inboxTexts.forEach(f => {
        let r = { parsed: 0, added: 0 };
        try { r = opts.importInbox(f.text, f.path) || r; }
        catch (e) { opts.log('inbox import failed', f.path, e && e.message); }
        if (r.parsed > 0 || !String(f.text || '').trim()) { inboxDelete.push(f.path); inboxAdded += r.added || 0; }
        else { warnings.push(f.path); opts.log('inbox file had no workouts; left in place', f.path); }
      });

      const current = opts.getState();
      const L = opts.normalize(JSON.parse(JSON.stringify(current)));
      const localRest = L.active ? { id: L.active.id, restEndAt: L.active.restEndAt, restTotal: L.active.restTotal } : null;
      if (L.active) { MD.REST_FIELDS.forEach(k => { delete L.active[k]; }); }
      const Lh = recordHashes(L);

      // remote records, by kind
      const remoteSettings = fetched.find(f => f.kind === 'settings');
      const remoteActive = fetched.find(f => f.kind === 'active');
      const remoteTombs = remoteSettings ? {
        sessions: new Set(((remoteSettings.rec.tombstones || {}).sessions || []).map(t => String(t.id))),
        cardio: new Set(((remoteSettings.rec.tombstones || {}).cardio || []).map(t => String(t.id))),
      } : { sessions: new Set(), cardio: new Set() };

      // ---- 4. deletions made elsewhere (file gone from the repo since our last sync)
      // A delete made in the app elsewhere also leaves a tombstone in settings.md. Files that
      // vanish WITHOUT one were deleted by hand (GitHub web, Obsidian). If that happens to
      // lots of files at once — or settings.md itself is gone — the repo was more likely
      // wiped, recreated or force-pushed: then nothing is deleted here and it all re-uploads.
      let remoteDeleted = 0;
      let notice = '';
      const cachedRecs = Object.keys(cache).filter(p => cache[p] && !cache[p].bad && (cache[p].kind === 'sessions' || cache[p].kind === 'cardio'));
      const unexplained = cachedRecs.filter(p => !remote.has(p) && !remoteTombs[cache[p].kind].has(String(cache[p].id))).length;
      const settingsGone = !!cache[MD.pathFor('settings')] && !remote.has(MD.pathFor('settings'));
      const repoReset = settingsGone || (unexplained > 3 && unexplained > cachedRecs.length * 0.25);
      if (repoReset) {
        notice = (`${unexplained} file${unexplained === 1 ? '' : 's'} vanished from the repo at once — kept here and re-uploaded (delete in the app to delete everywhere).`);
        opts.log('repo looks reset/wiped: not applying ' + unexplained + ' remote deletions');
      }
      Object.keys(cache).forEach(path => {
        const c = cache[path];
        if (remote.has(path) || !c || c.bad) return;
        if (c.kind === 'sessions' || c.kind === 'cardio') {
          const id = String(c.id);
          const rec = L[c.kind].find(r => String(r.id) === id);
          if (!rec || Lh[c.kind].get(id) !== c.h) return; // gone already, or edited here since: keep
          if (repoReset && !remoteTombs[c.kind].has(id)) return;
          L[c.kind] = L[c.kind].filter(r => String(r.id) !== id);
          if (!remoteTombs[c.kind].has(id)) {
            L.tombstones[c.kind] = (L.tombstones[c.kind] || []).filter(t => String(t.id) !== id);
            L.tombstones[c.kind].push({ id, deleted: true, updatedAt: Math.max(Date.now(), (Number(rec.updatedAt) || 0) + 1) });
          }
          remoteDeleted++;
        } else if (c.kind === 'active') {
          // finished or discarded on another device (unless this device logged more since)
          if (L.active && Lh.active === c.h && !settingsGone) { L.active = null; remoteDeleted++; }
        }
      });

      // ---- 5. merge
      const R = JSON.parse(JSON.stringify(L));
      R.sessions = fetched.filter(f => f.kind === 'sessions').map(f => f.rec);
      R.cardio = fetched.filter(f => f.kind === 'cardio').map(f => f.rec);
      if (remoteSettings) {
        const b = remoteSettings.rec;
        R.settings = b.settings; R.settingsTs = b.settingsTs || {};
        R.exercises = b.exercises; R.days = Array.isArray(b.days) ? b.days : R.days;
        R.events = Array.isArray(b.events) ? b.events : [];
        R.tombstones = b.tombstones && typeof b.tombstones === 'object' ? b.tombstones : {};
      }
      if (remoteActive) { R.active = remoteActive.rec.active; R.activeUpdatedAt = remoteActive.rec.activeUpdatedAt; }
      let Rn;
      try { Rn = opts.normalize(R); }
      catch (e) { throw new SyncError('remote', 'Couldn\'t read the data in GitHub — nothing was changed.'); }
      const M = opts.merge(L, Rn);
      if (M.active && localRest && M.active.id === localRest.id) {
        if (localRest.restEndAt != null) M.active.restEndAt = localRest.restEndAt;
        if (localRest.restTotal != null) M.active.restTotal = localRest.restTotal;
      }
      if (canon(M) !== canon(current)) opts.applyState(M);
      const mergedSig = localSig(M);
      // ================= end synchronous section ================================================

      // ---- 6. what the repo should contain
      const Mv = syncView(M);
      const Rh = recordHashes(Rn);
      const fetchedByPath = new Map(fetched.map(f => [f.path, f]));
      // id -> remote paths (from fetched + cache for unchanged files)
      const remoteIdx = { sessions: new Map(), cardio: new Map() };
      remote.forEach((sha, path) => {
        const kind = MD.kindOfPath(path);
        if (kind !== 'sessions' && kind !== 'cardio') return;
        const f = fetchedByPath.get(path);
        const id = f ? String(f.rec.id) : (cache[path] && cache[path].sha === sha && !cache[path].bad ? String(cache[path].id) : null);
        if (id == null) return;
        const list = remoteIdx[kind].get(id) || [];
        list.push(path); list.sort();
        remoteIdx[kind].set(id, list);
      });
      const cacheIdx = { sessions: new Map(), cardio: new Map() };
      Object.keys(cache).forEach(p => { const c = cache[p]; if (c && !c.bad && cacheIdx[c.kind]) cacheIdx[c.kind].set(String(c.id), p); });
      const remoteHashOf = (path, kind, id) => {
        const f = fetchedByPath.get(path);
        if (f) {
          if (kind === 'settings') return Rh.settings;
          if (kind === 'active') return String(f.rec.active.id) === Rh.activeId ? Rh.active : null;
          return Rh[kind].get(String(id)) || null;
        }
        const c = cache[path];
        return c && c.sha === remote.get(path) ? c.h : null;
      };

      const uploads = [];   // {path, content, kind, id, h}
      const deletes = [];   // paths
      const kept = {};      // path -> cache entry for files we leave as they are
      const taken = new Set(remote.keys());
      const Mh = recordHashes(Mv);
      ['sessions', 'cardio'].forEach(kind => {
        (Mv[kind] || []).forEach(rec => {
          const id = String(rec.id);
          const h = Mh[kind].get(id);
          const paths = remoteIdx[kind].get(id) || [];
          let path = paths[0];
          paths.slice(1).forEach(p => deletes.push(p)); // duplicate files for one record
          if (!path) {
            path = cacheIdx[kind].get(id); // deleted remotely but edited here: same name again
            if (!path || taken.has(path)) {
              path = MD.pathFor(kind, rec);
              for (let n = 2; taken.has(path); n++) path = MD.pathFor(kind, rec).replace(/\.md$/, '-' + n + '.md');
            }
          }
          taken.add(path);
          if (remote.has(path) && remoteHashOf(path, kind, id) === h) { kept[path] = { sha: remote.get(path), kind, id, h }; return; }
          uploads.push({ path, kind, id, h, content: MD.serialize(kind, rec, Mv) });
        });
        const dead = tombIds(Mv, kind);
        dead.forEach(id => (remoteIdx[kind].get(id) || []).forEach(p => deletes.push(p)));
      });
      const settingsPath = MD.pathFor('settings');
      if (remote.has(settingsPath) && remoteHashOf(settingsPath, 'settings') === Mh.settings) {
        kept[settingsPath] = { sha: remote.get(settingsPath), kind: 'settings', id: 'settings', h: Mh.settings };
      } else if (!badFiles[settingsPath] && !(cache[settingsPath] && cache[settingsPath].bad && cache[settingsPath].sha === remote.get(settingsPath))) {
        uploads.push({ path: settingsPath, kind: 'settings', id: 'settings', h: Mh.settings, content: MD.serialize('settings', MD.settingsBundle(Mv), Mv) });
      }
      const activePath = MD.pathFor('active');
      const ab = MD.activeBundle(Mv);
      if (ab) {
        if (remote.has(activePath) && remoteHashOf(activePath, 'active') === Mh.active) {
          kept[activePath] = { sha: remote.get(activePath), kind: 'active', id: String(ab.active.id), h: Mh.active };
        } else uploads.push({ path: activePath, kind: 'active', id: String(ab.active.id), h: Mh.active, content: MD.serialize('active', ab, Mv) });
      } else if (remote.has(activePath) && !badFiles[activePath]) deletes.push(activePath);
      inboxDelete.forEach(p => deletes.push(p));

      const delSet = [...new Set(deletes)].filter(p => remote.has(p) && !uploads.some(u => u.path === p));
      const nChanged = uploads.length + delSet.length;

      // new cache: files that stay, plus known-bad ones (so they aren't re-downloaded)
      const nextFiles = {};
      remote.forEach((sha, path) => {
        if (delSet.includes(path)) return;
        const kind = MD.kindOfPath(path);
        if (!kind || kind === 'inbox') return;
        if (kept[path]) { nextFiles[path] = kept[path]; return; }
        if (badFiles[path]) { nextFiles[path] = { sha, bad: true }; return; }
        const c = cache[path];
        if (c && c.sha === sha) nextFiles[path] = c;
      });
      st.warnings = [...new Set(warnings)].sort();
      if (notice) st.notice = notice; // sticky until a manual "Sync now"

      if (!nChanged) {
        st.files = nextFiles; st.lastCommit = head; st.localSig = mergedSig; writeStore();
        return fetched.length || remoteDeleted ? 'pulled' : 'unchanged';
      }

      // COACH.md rides along whenever data changed
      const entries = uploads.map(u => ({ path: u.path, mode: '100644', type: 'blob', content: u.content }));
      delSet.forEach(p => entries.push({ path: p, mode: '100644', type: 'blob', sha: null }));
      const coachPath = opts.prefix + 'COACH.md';
      let coach = '';
      try { coach = String(opts.coachMarkdown() || ''); } catch (e) { opts.log('coach report failed', e && e.message); }
      if (coach) {
        if (!coach.endsWith('\n')) coach += '\n';
        if ((await gitBlobSha(coach)) !== remote.get(coachPath)) entries.push({ path: coachPath, mode: '100644', type: 'blob', content: coach });
      }

      const newTree = await gh('POST', `${base}/git/trees`, { base_tree: treeSha, tree: entries }, token);
      const newCommit = await gh('POST', `${base}/git/commits`, {
        message: `${opts.appName}: sync (${nChanged} changed) from ${deviceLabel()}`,
        tree: newTree.sha, parents: [head],
      }, token);
      await gh('PATCH', `${base}/git/refs/heads/${opts.branch}`, { sha: newCommit.sha, force: false }, token);

      for (const u of uploads) nextFiles[u.path] = { sha: await gitBlobSha(u.content), kind: u.kind, id: u.id, h: u.h };
      st.files = nextFiles; st.lastCommit = newCommit.sha; st.localSig = mergedSig; writeStore();
      opts.log(`committed ${nChanged} change(s)` + (inboxAdded ? `, ${inboxAdded} watch workout(s) imported` : ''));
      return 'pushed';
    }

    // ------------------------------------------------------------ pass / scheduling
    let running = null, again = false, timer = null, timerDue = 0, failures = 0, disposed = false;
    function syncNow(reason) {
      if (disposed || !connected()) { emit(); return Promise.resolve('skipped'); }
      if (running) { again = true; return running; }
      clearTimeout(timer); timer = null; timerDue = 0;
      running = (async () => {
        try { return await pass(reason); }
        finally {
          running = null;
          if (again) { again = false; schedule(300, true); }
        }
      })();
      return running;
    }
    async function pass(reason) {
      const token = getToken();
      if (opts.isBusy()) { schedule(5000, true); return 'busy'; }
      if (!opts.canSync()) {
        setError(new SyncError('blocked', 'Local data is unreadable — sync paused so nothing gets overwritten.'));
        emit(); return 'blocked';
      }
      if (root.navigator && root.navigator.onLine === false) {
        setError(new SyncError('network', 'Offline — will retry')); emit(); return 'offline';
      }
      const manual = reason === 'manual' || reason === 'connect';
      if (reason === 'manual') delete st.notice;
      if (!manual && backoffUntil > Date.now()) { schedule(backoffUntil - Date.now() + 50, true); return 'backoff'; }
      syncing = true; emit();
      try {
        let r;
        for (let n = 1; ; n++) {
          try { r = await attempt(token); break; }
          catch (e) {
            if (e.kind === 'conflict' && n < MAX_TRIES) { opts.log('repo moved on while syncing — retrying (' + n + ')'); continue; }
            throw e;
          }
        }
        st.lastSyncedAt = Date.now(); clearError(); writeStore();
        failures = 0;
        lastNonActive = nonActiveSig(opts.getState());
        if (r !== 'unchanged') opts.log('sync ' + (reason || '') + ': ' + r);
        return r;
      } catch (e) {
        setError(e);
        if (e.kind === 'network' || e.kind === 'ratelimit') {
          failures++;
          const wait = Math.max(backoffUntil - Date.now(), Math.min(600000, 15000 * Math.pow(2, failures - 1)));
          schedule(wait, true);
        } else opts.log('sync failed', e.kind, e.message);
        return 'error:' + (e.kind || 'http');
      } finally {
        syncing = false; emit();
      }
    }
    // after a local save: 5s for data changes, ~20s when only the in-progress workout changed
    let lastNonActive = null;
    const initialState = opts.getState();
    if (initialState) { try { lastNonActive = nonActiveSig(initialState); } catch (e) {} }
    function schedule(ms, exact) {
      if (disposed || !connected()) return;
      let due;
      if (exact) due = Date.now() + (ms || 0);
      else {
        const sig = nonActiveSig(opts.getState());
        const dataChanged = sig !== lastNonActive;
        lastNonActive = sig;
        if (dataChanged) due = Date.now() + (ms == null ? opts.debounceMs : ms); // debounce: each data save resets it
        else if (timer) return; // active-only change: an earlier pending sync covers it
        else due = Date.now() + opts.activeDebounceMs;
      }
      clearTimeout(timer);
      timerDue = due;
      timer = setTimeout(() => { timer = null; timerDue = 0; syncNow('save'); }, Math.max(0, due - Date.now()));
    }
    const hasPending = () => !!timer;

    // triggers: visible again / hidden with pending changes, back online, every 2 min while visible
    let attached = false;
    function attach(win, doc) {
      if (attached) return; attached = true;
      doc.addEventListener('visibilitychange', () => {
        if (!doc.hidden) syncNow('visible');
        else if (hasPending()) syncNow('hidden');
      });
      win.addEventListener('online', () => syncNow('online'));
      win.addEventListener('offline', () => { if (connected()) { setError(new SyncError('network', 'Offline — will retry')); emit(); } });
      // another tab (e.g. Guitar Studio) pasted or removed the shared token
      win.addEventListener('storage', ev => { if (ev.key === opts.tokenKey) { emit(); if (connected()) syncNow('token'); } });
      setInterval(() => { if (!doc.hidden) syncNow('interval'); }, opts.intervalMs);
    }

    // tests: stop timers so a finished simulated device can't fire a late sync
    function dispose() { disposed = true; clearTimeout(timer); timer = null; timerDue = 0; }

    return {
      connected, getStatus, connect, disconnect, syncNow, schedule, attach, hasPending, deviceLabel, dispose,
      _store: () => st, // tests/debug
    };
  }

  root.LiftGitHub = { create, SyncError, gitBlobSha, b64ToUtf8, utf8ToB64, platformOf };
})(typeof window !== 'undefined' ? window : globalThis);
