/* Lift Studio — Dropbox sync engine (OAuth2 PKCE + files API). No DOM rendering here: the
   app passes hooks in. Local-first: the app always reads/writes localStorage; this engine
   reconciles that copy with one JSON file in Dropbox using LiftMerge.

   One sync pass:
     resolve paths (home namespace, or team root + "/TJ Mitchell")  — cached after first run
     -> watch CSV: if its rev changed, download + run through the app's watch import
     -> data file: get_metadata; if rev and local content are unchanged since last pass, done
     -> download (or treat as missing) -> merge with local -> save local
     -> upload with mode update(rev) / add; 409 conflict -> re-download, re-merge, retry (max 3)
   Network trouble is never an alert: status goes to 'offline' and the next trigger retries. */
(function (root) {
  'use strict';

  const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const API = 'https://api.dropboxapi.com/2/';
  const CONTENT = 'https://content.dropboxapi.com/2/';
  const MAX_CONFLICT_RETRIES = 3;

  class SyncError extends Error {
    constructor(kind, message, status, summary) {
      super(message); this.kind = kind; this.status = status; this.summary = summary || '';
    }
  }

  // Dropbox-API-Arg is an HTTP header: non-ASCII must be \u-escaped JSON.
  function headerJson(obj) {
    return JSON.stringify(obj).replace(/[\u007f-￿]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
  }
  function b64url(bytes) {
    let s = '';
    bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomToken(n) {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return b64url(b);
  }
  async function pkceChallenge(verifier) {
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  function create(o) {
    const opts = Object.assign({
      appKey: '',
      storageKey: 'liftstudio.dropbox',
      storage: root.localStorage,
      fetch: (...a) => root.fetch(...a), // late-bound so tests can monkeypatch window.fetch
      dataPath: '/TJ/Fitness/Lift Studio/lift-studio-data.json',
      watchPath: '/TJ/Fitness/watch-workouts.csv',
      checkFolder: '/TJ/Fitness',
      teamPrefix: '/TJ Mitchell',
      redirectUri: () => root.location.origin + root.location.pathname.replace(/index\.html$/, ''),
      openUrl: url => { root.location.assign(url); },
      getState: () => null,          // current local state (not mutated by the engine)
      applyState: () => {},          // (merged) -> app adopts + saves it
      normalize: s => s,
      merge: (a, b) => b,
      canSync: () => true,           // false while local data is unreadable/blocked
      isBusy: () => false,           // true to postpone (e.g. finish-workout sheet open)
      importWatch: () => 0,          // (csvText) -> number of entries added
      onStatus: () => {},
      log: (...a) => { try { console.info('[sync]', ...a); } catch (e) {} },
      debounceMs: 2000,
      intervalMs: 60000,
    }, o || {});

    // ------------------------------------------------------------ persisted engine state
    let st = readStore();
    function readStore() {
      try { const v = JSON.parse(opts.storage.getItem(opts.storageKey) || '{}'); return v && typeof v === 'object' ? v : {}; }
      catch (e) { return {}; }
    }
    function writeStore() {
      try { opts.storage.setItem(opts.storageKey, JSON.stringify(st)); } catch (e) {}
    }

    const configured = () => !!opts.appKey;
    const signedIn = () => configured() && !!st.refreshToken;

    // ------------------------------------------------------------ status
    let status = { state: 'idle' };
    function computeIdle() {
      if (!configured()) return 'unconfigured';
      if (st.needsReauth) return 'reauth';
      if (!st.refreshToken) return 'signedout';
      if (st.lastError) return st.lastErrorKind === 'network' ? 'offline' : 'error';
      return st.lastSyncedAt ? 'synced' : 'idle';
    }
    function setStatus(state, extra) {
      status = Object.assign({ state }, extra || {});
      try { opts.onStatus(getStatus()); } catch (e) {}
    }
    function getStatus() {
      return {
        state: status.state === 'syncing' ? 'syncing' : computeIdle(),
        lastSyncedAt: st.lastSyncedAt || null,
        lastError: st.lastError || null,
        pathMode: st.pathMode || null,
        pendingCode: !!(st.pendingCode && st.pendingCode.opened),
        configured: configured(),
        signedIn: signedIn(),
      };
    }

    // ------------------------------------------------------------ auth
    // Two PKCE flows, each with its own pending verifier:
    //  redirect — normal browsers: Dropbox sends the browser back to redirectUri with ?code=
    //  code     — iOS home-screen apps (a redirect would land in Safari, not the app) and the
    //             "use a code instead" fallback: no redirect_uri, Dropbox shows a code, TJ pastes it.
    async function buildUrl(pending) {
      const p = new URLSearchParams({
        client_id: opts.appKey,
        response_type: 'code',
        code_challenge: await pkceChallenge(pending.verifier),
        code_challenge_method: 'S256',
        token_access_type: 'offline',
      });
      if (pending.flow === 'redirect') {
        p.set('redirect_uri', pending.redirectUri);
        p.set('state', pending.state);
      }
      return AUTH_URL + '?' + p.toString();
    }
    async function authUrl(flow) {
      if (!configured()) throw new SyncError('config', 'Sync not configured yet');
      if (flow === 'code') {
        // reuse a pending verifier so a code fetched before an app reload still works
        if (!st.pendingCode || !st.pendingCode.verifier) { st.pendingCode = { flow: 'code', verifier: randomToken(48), at: Date.now() }; writeStore(); }
        return buildUrl(st.pendingCode);
      }
      st.pending = { flow: 'redirect', verifier: randomToken(48), state: randomToken(16), redirectUri: opts.redirectUri(), at: Date.now() };
      writeStore();
      return buildUrl(st.pending);
    }
    async function beginRedirect() {
      const url = await authUrl('redirect');
      opts.openUrl(url, 'redirect');
      return url;
    }
    // The UI opens the code-flow URL itself (a real link: popup blockers), then calls this so
    // the paste box survives an app reload while TJ is over in Safari.
    function markCodeOpened() {
      if (st.pendingCode) { st.pendingCode.opened = true; writeStore(); setStatus('idle'); }
    }
    function cancelCode() {
      delete st.pendingCode; writeStore();
      setStatus('idle');
    }
    async function tokenRequest(params) {
      let res;
      try {
        res = await opts.fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
        });
      } catch (e) { throw new SyncError('network', 'Offline'); }
      let body = null;
      try { body = await res.json(); } catch (e) {}
      if (res.ok && body && body.access_token) return body;
      if (res.status >= 500 || res.status === 429) throw new SyncError('network', 'Dropbox is busy');
      const err = (body && (body.error_description || body.error)) || ('HTTP ' + res.status);
      throw new SyncError(body && body.error === 'invalid_grant' ? 'auth' : 'http', String(err), res.status);
    }
    function adoptTokens(body) {
      st.accessToken = body.access_token;
      st.accessExpiresAt = Date.now() + (Number(body.expires_in) || 14400) * 1000;
      if (body.refresh_token) st.refreshToken = body.refresh_token;
      if (body.account_id) st.accountId = body.account_id;
      delete st.needsReauth; delete st.lastError; delete st.lastErrorKind;
      writeStore();
    }
    async function exchange(code, pending) {
      const params = { grant_type: 'authorization_code', code: String(code).trim(), client_id: opts.appKey, code_verifier: pending.verifier };
      if (pending.flow === 'redirect') params.redirect_uri = pending.redirectUri;
      const body = await tokenRequest(params);
      delete st.pending; delete st.pendingCode;
      // a new sign-in may be a different account/team: re-probe paths, start rev tracking over
      delete st.pathMode; delete st.rootNs; delete st.rev; delete st.syncedHash; delete st.watchRev;
      adoptTokens(body);
      opts.log('signed in', st.accountId || '');
    }
    async function completeCode(code) {
      if (!st.pendingCode || !st.pendingCode.verifier) throw new SyncError('auth', 'Open Dropbox again to get a fresh code.');
      if (!String(code || '').trim()) throw new SyncError('auth', 'Paste the code from Dropbox first.');
      await exchange(code, st.pendingCode);
      setStatus('idle');
      return syncNow('signin');
    }
    // Call on load with location.href. Returns {handled:false} when the URL has no OAuth reply.
    async function handleRedirect(href) {
      let u;
      try { u = new URL(href); } catch (e) { return { handled: false }; }
      const code = u.searchParams.get('code'), error = u.searchParams.get('error'), state = u.searchParams.get('state');
      if (!code && !error) return { handled: false };
      ['code', 'state', 'error', 'error_description'].forEach(k => u.searchParams.delete(k));
      const cleanUrl = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash;
      if (error) {
        if (st.pending && st.pending.flow === 'redirect') { delete st.pending; writeStore(); }
        return { handled: true, cleanUrl, ok: false, message: error === 'access_denied' ? 'Dropbox access was not granted.' : 'Dropbox sign-in failed.' };
      }
      const pending = st.pending;
      if (!configured() || !pending || pending.flow !== 'redirect' || pending.state !== state) {
        return { handled: true, cleanUrl, ok: false, message: 'That sign-in link expired — tap Connect Dropbox again.' };
      }
      try {
        await exchange(code, pending);
        return { handled: true, cleanUrl, ok: true };
      } catch (e) {
        return { handled: true, cleanUrl, ok: false, message: 'Dropbox sign-in failed: ' + e.message };
      }
    }

    let refreshing = null;
    async function accessToken(force) {
      if (!force && st.accessToken && (st.accessExpiresAt || 0) > Date.now() + 60000) return st.accessToken;
      if (!st.refreshToken) throw new SyncError('auth', 'Not signed in');
      if (!refreshing) {
        refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: st.refreshToken, client_id: opts.appKey })
          .then(adoptTokens)
          .catch(e => {
            if (e.kind === 'auth') { // refresh token revoked/expired: need a fresh sign-in
              delete st.refreshToken; delete st.accessToken; st.needsReauth = true; writeStore();
            }
            throw e;
          })
          .finally(() => { refreshing = null; });
      }
      await refreshing;
      return st.accessToken;
    }

    async function signOut() {
      const had = st.refreshToken || st.accessToken;
      if (had) {
        try {
          const tok = await accessToken();
          await opts.fetch(API + 'auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
        } catch (e) { opts.log('revoke failed (ignored)', e && e.message); }
      }
      st = {}; writeStore();
      setStatus('idle');
    }

    // ------------------------------------------------------------ HTTP
    // kind: 'rpc' (JSON in/out), 'download' (arg header, text out), 'upload' (arg header, body in)
    async function call(kind, endpoint, arg, body, pathRoot, retried) {
      const tok = await accessToken();
      const headers = { Authorization: 'Bearer ' + tok };
      if (pathRoot) headers['Dropbox-API-Path-Root'] = headerJson(pathRoot);
      const init = { method: 'POST', headers };
      if (kind === 'rpc') {
        if (arg != null) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(arg); }
      } else {
        headers['Dropbox-API-Arg'] = headerJson(arg);
        if (kind === 'upload') { headers['Content-Type'] = 'application/octet-stream'; init.body = body; }
      }
      let res;
      try { res = await opts.fetch((kind === 'rpc' ? API : CONTENT) + endpoint, init); }
      catch (e) { throw new SyncError('network', 'Offline'); }
      if (res.status === 401 && !retried) {
        let summary = '';
        try { const j = await res.clone().json(); summary = (j && j.error_summary) || ''; } catch (e) {}
        if (/missing_scope/.test(summary)) throw new SyncError('http', 'Dropbox app is missing a permission (' + summary + ')', 401, summary);
        await accessToken(true);
        return call(kind, endpoint, arg, body, pathRoot, true);
      }
      if (res.ok) {
        if (kind === 'download') {
          let meta = {};
          try { meta = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}'); } catch (e) {}
          return { text: await res.text(), rev: meta.rev || null, meta };
        }
        const txt = await res.text();
        try { return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; }
      }
      if (res.status === 429 || res.status >= 500) throw new SyncError('network', 'Dropbox is busy', res.status);
      let summary = '';
      try { const t = await res.text(); try { summary = JSON.parse(t).error_summary || t; } catch (e) { summary = t; } } catch (e) {}
      summary = String(summary || '');
      if (res.status === 409 && /not_found/.test(summary)) throw new SyncError('notfound', 'Not found', 409, summary);
      if (res.status === 409 && /conflict/.test(summary)) throw new SyncError('conflict', 'Conflict', 409, summary);
      if (res.status === 401) throw new SyncError('auth', 'Dropbox sign-in expired', 401, summary);
      throw new SyncError('http', 'Dropbox error ' + res.status + (summary ? ': ' + summary.slice(0, 120) : ''), res.status, summary);
    }
    async function metadata(path, pr) {
      try { return await call('rpc', 'files/get_metadata', { path }, null, pr); }
      catch (e) { if (e.kind === 'notfound') return null; throw e; }
    }
    async function download(path, pr) {
      try { return await call('download', 'files/download', { path }, null, pr); }
      catch (e) { if (e.kind === 'notfound') return null; throw e; }
    }
    function upload(path, text, mode, pr) {
      return call('upload', 'files/upload', { path, mode, autorename: false, mute: true, strict_conflict: true }, text, pr);
    }

    // TJ's Dropbox is a Business team account. His member folder is normally the home
    // namespace (so "/TJ/Fitness" resolves). If not, fall back to the team root with his
    // member folder name as a prefix. Whichever works is cached.
    async function resolvePaths() {
      if (st.pathMode === 'home') return { pr: null, prefix: '' };
      if (st.pathMode === 'root' && st.rootNs) return { pr: { '.tag': 'root', root: String(st.rootNs) }, prefix: opts.teamPrefix };
      if (await metadata(opts.checkFolder, null)) {
        st.pathMode = 'home'; writeStore();
        opts.log('paths: home namespace works (' + opts.checkFolder + ')');
        return { pr: null, prefix: '' };
      }
      const acct = await call('rpc', 'users/get_current_account', null, null, null);
      const ns = acct && acct.root_info && acct.root_info.root_namespace_id;
      if (ns) {
        const pr = { '.tag': 'root', root: String(ns) };
        if (await metadata(opts.teamPrefix + opts.checkFolder, pr)) {
          st.pathMode = 'root'; st.rootNs = String(ns); writeStore();
          opts.log('paths: team root namespace ' + ns + ' + "' + opts.teamPrefix + '" works');
          return { pr, prefix: opts.teamPrefix };
        }
      }
      throw new SyncError('setup', 'Couldn\'t find the ' + opts.checkFolder + ' folder in Dropbox (checked your folder and the team root).');
    }

    // ------------------------------------------------------------ one sync pass
    const canon = v => root.LiftMerge.canonical(v);
    const hashOf = v => root.LiftMerge.hashString(canon(v));

    async function watchPass(p) {
      const path = p.prefix + opts.watchPath;
      let meta;
      try { meta = await metadata(path, p.pr); }
      catch (e) { if (e.kind === 'network' || e.kind === 'auth') throw e; opts.log('watch check failed (ignored)', e.message); return; }
      if (!meta || !meta.rev || meta.rev === st.watchRev) return;
      const dl = await download(path, p.pr);
      if (!dl) return;
      let added = 0;
      try { added = opts.importWatch(dl.text) || 0; }
      catch (e) { opts.log('watch import failed (ignored)', e && e.message); }
      st.watchRev = dl.rev || meta.rev; writeStore();
      opts.log('watch CSV rev ' + st.watchRev + ': ' + added + ' new');
    }

    async function dataPass(p) {
      const path = p.prefix + opts.dataPath;
      const meta = await metadata(path, p.pr);
      if (meta && meta.rev && meta.rev === st.rev && hashOf(opts.getState()) === st.syncedHash) return 'unchanged';
      let exists = !!meta;
      for (let attempt = 0; ; attempt++) {
        const dl = exists ? await download(path, p.pr) : null;
        let remote = null;
        if (dl) {
          try { remote = opts.normalize(JSON.parse(dl.text)); }
          catch (e) { throw new SyncError('remote', 'The Dropbox copy of your data is unreadable — not overwriting it.'); }
        }
        if (!opts.canSync()) throw new SyncError('blocked', 'Local data is unreadable — sync paused.');
        const current = opts.getState();
        // normalize a copy so fresh records (e.g. cardio without hr/cal yet) take the same
        // shape they'll have on the other device after its load-time normalize
        const local = opts.normalize(JSON.parse(JSON.stringify(current)));
        const merged = opts.merge(local, remote || local);
        const mergedJson = canon(merged);
        if (mergedJson !== canon(current)) opts.applyState(merged);
        if (remote && mergedJson === canon(remote)) {
          st.rev = dl.rev; st.syncedHash = root.LiftMerge.hashString(mergedJson); writeStore();
          return 'pulled';
        }
        try {
          const res = await upload(path, JSON.stringify(merged, null, 1), dl ? { '.tag': 'update', update: dl.rev } : { '.tag': 'add' }, p.pr);
          st.rev = res.rev || null; st.syncedHash = root.LiftMerge.hashString(mergedJson); writeStore();
          return dl ? 'pushed' : 'created';
        } catch (e) {
          if (e.kind === 'conflict' && attempt < MAX_CONFLICT_RETRIES) {
            opts.log('upload conflict, re-merging (attempt ' + (attempt + 1) + ')');
            exists = true;
            continue;
          }
          throw e;
        }
      }
    }

    let running = null, again = false, timer = null;
    function syncNow(reason) {
      if (!signedIn()) { setStatus('idle'); return Promise.resolve('skipped'); }
      if (running) { again = true; return running; }
      running = (async () => {
        try { return await pass(reason); }
        finally {
          running = null;
          if (again) { again = false; schedule(300); }
        }
      })();
      return running;
    }
    async function pass(reason) {
      if (opts.isBusy()) { schedule(5000); return 'busy'; }
      if (!opts.canSync()) {
        st.lastError = 'Local data is unreadable — sync paused so nothing gets overwritten.'; st.lastErrorKind = 'blocked'; writeStore();
        setStatus('idle'); return 'blocked';
      }
      if (root.navigator && root.navigator.onLine === false) {
        st.lastError = 'Offline'; st.lastErrorKind = 'network'; writeStore();
        setStatus('idle'); return 'offline';
      }
      setStatus('syncing');
      try {
        const p = await resolvePaths();
        await watchPass(p);
        const r = await dataPass(p);
        st.lastSyncedAt = Date.now(); delete st.lastError; delete st.lastErrorKind; writeStore();
        opts.log('sync ' + (reason || '') + ': ' + r);
        setStatus('idle');
        return r;
      } catch (e) {
        st.lastError = e.message || String(e); st.lastErrorKind = e.kind || 'http'; writeStore();
        if (e.kind !== 'network') opts.log('sync failed', e.kind, e.message);
        setStatus('idle');
        return 'error:' + (e.kind || 'http');
      }
    }
    function schedule(ms) {
      if (!signedIn()) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; syncNow('save'); }, ms == null ? opts.debounceMs : ms);
    }

    // triggers: visible again, back online, every minute while visible
    let attached = false;
    function attach(win, doc) {
      if (attached) return; attached = true;
      doc.addEventListener('visibilitychange', () => { if (!doc.hidden) syncNow('visible'); });
      win.addEventListener('online', () => syncNow('online'));
      win.addEventListener('offline', () => { if (signedIn()) { st.lastError = 'Offline'; st.lastErrorKind = 'network'; writeStore(); setStatus('idle'); } });
      setInterval(() => { if (!doc.hidden) syncNow('interval'); }, opts.intervalMs);
    }

    return {
      configured, signedIn, getStatus, beginRedirect, markCodeOpened, cancelCode, completeCode,
      handleRedirect, signOut, syncNow, schedule, attach, authUrl,
      _store: () => st, // tests/debug
    };
  }

  root.LiftDropbox = { create, headerJson, SyncError };
})(typeof window !== 'undefined' ? window : globalThis);
