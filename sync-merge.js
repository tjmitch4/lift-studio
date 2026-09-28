/* Lift Studio — pure sync merge. No DOM, no network, no globals besides LiftMerge.
   Loaded by index.html (before state.js/app.js) and by tests/merge-test.html.

   Inputs are two *normalized* Lift Studio states (see normalize() in state.js); the output is
   a new state object (inputs are never mutated). The merge is a deterministic function of the
   two inputs' content: merge(a, b) and merge(b, a) produce byte-identical canonical JSON, and
   merge(m, m) === m. That property is what stops two devices ping-ponging uploads forever.

   Semantics per data type:
   - sessions / cardio / events: union by id. Same id on both sides -> higher updatedAt wins;
     tie -> a tombstone beats a live record, then the canonically larger JSON wins.
     Deletes are tombstones {id, deleted:true, updatedAt} in state.tombstones.<collection>;
     a tombstone newer than (or tied with) the live record removes it everywhere.
   - exercises: union by id, then per-FIELD last-write-wins using ex.fieldTs[field]
     (so a bench weight change on the phone and a rep-range change on the PC both survive).
     Equal timestamps with different values: prefer the value that differs from the seeded
     program default (i.e. the one somebody actually changed), then non-null, then canonical.
   - settings: per-field last-write-wins using state.settingsTs[field], same tie rule.
   - days: union by id, whole-record LWW on updatedAt (they're static seed data today).
   - active (in-progress workout): whole-object LWW on state.activeUpdatedAt. An active
     workout whose id already exists as a finished session (or a deleted one) is dropped:
     another device finished it.
   - lastExportAt: max. schemaVersion: max. Unknown top-level keys: kept (canonical tie-break).
*/
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- canonical JSON + hash
  function canonical(v) {
    if (v === null || typeof v !== 'object') {
      const s = JSON.stringify(v);
      return s === undefined ? 'null' : s;
    }
    if (Array.isArray(v)) return '[' + v.map(x => (x === undefined || typeof x === 'function' ? 'null' : canonical(x))).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }

  // cyrb53-style 53-bit string hash -> 14 hex chars. Deterministic across devices/browsers.
  function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0').slice(-6) + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  // Deterministic id for a record that has none: hash of its content minus id/updatedAt.
  function contentId(prefix, rec) {
    const copy = {};
    Object.keys(rec || {}).forEach(k => { if (k !== 'id' && k !== 'updatedAt') copy[k] = rec[k]; });
    return prefix + hashString(canonical(copy));
  }

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const ts = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---------------------------------------------------------------- record collections
  // true when record a should replace record b (same id)
  function recWins(a, b) {
    const ua = ts(a.updatedAt), ub = ts(b.updatedAt);
    if (ua !== ub) return ua > ub;
    if (!!a.deleted !== !!b.deleted) return !!a.deleted;
    return canonical(a) > canonical(b);
  }

  // Merge live arrays + tombstone arrays from both sides. Returns { live, tombs }.
  function mergeCollection(liveA, tombA, liveB, tombB) {
    const best = new Map();
    const consider = r => {
      if (!r || typeof r !== 'object' || r.id == null) return;
      const id = String(r.id);
      const cur = best.get(id);
      if (!cur || recWins(r, cur)) best.set(id, r);
    };
    [liveA, tombA, liveB, tombB].forEach(arr => (Array.isArray(arr) ? arr : []).forEach(consider));
    const live = [], tombs = [];
    best.forEach((r, id) => {
      if (r.deleted) tombs.push({ id, deleted: true, updatedAt: ts(r.updatedAt) });
      else live.push(clone(r));
    });
    tombs.sort((x, y) => cmpStr(x.id, y.id));
    return { live, tombs };
  }

  // ---------------------------------------------------------------- per-field LWW
  const eq = (a, b) => canonical(a) === canonical(b);
  // pick between two values stamped at the same time
  function tieBreak(va, vb, seedV, hasSeed) {
    if (va === undefined) return vb;
    if (vb === undefined) return va;
    if (hasSeed) {
      const aSeed = eq(va, seedV), bSeed = eq(vb, seedV);
      if (aSeed && !bSeed) return vb;
      if (bSeed && !aSeed) return va;
    }
    if (va === null && vb !== null) return vb;
    if (vb === null && va !== null) return va;
    return canonical(va) >= canonical(vb) ? va : vb;
  }

  // Merge two flat objects field by field. tsA/tsB: {field: ms}. seed: default values (optional).
  // skip: keys that are bookkeeping, not data.
  function mergeFields(a, b, tsA, tsB, seed, skip) {
    a = a || {}; b = b || {}; tsA = tsA || {}; tsB = tsB || {};
    const out = {}, outTs = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    [...keys].sort().forEach(k => {
      if (skip && skip.includes(k)) return;
      const ta = ts(tsA[k]), tb = ts(tsB[k]);
      const va = a[k], vb = b[k];
      let v;
      if (ta !== tb) v = ta > tb ? (k in a ? va : vb) : (k in b ? vb : va);
      else if (eq(va, vb)) v = va;
      else v = tieBreak(va, vb, seed ? seed[k] : undefined, !!seed && k in seed);
      if (v !== undefined) out[k] = clone(v);
      const t = Math.max(ta, tb);
      if (t) outTs[k] = t;
    });
    return { value: out, ts: outTs };
  }

  // ---------------------------------------------------------------- ordering (deterministic)
  function firstSetT(s) {
    let t = Infinity;
    Object.values((s && s.entries) || {}).forEach(e => ((e && e.sets) || []).forEach(x => { if (x && x.t && x.t < t) t = x.t; }));
    return t === Infinity ? 0 : t;
  }
  const bySession = (x, y) => cmpStr(String(x.date), String(y.date)) || (firstSetT(x) - firstSetT(y)) || cmpStr(String(x.id), String(y.id));
  const byDated = (x, y) => cmpStr(String(x.date), String(y.date)) || (ts(x.updatedAt) - ts(y.updatedAt)) || cmpStr(String(x.id), String(y.id));

  function orderBySeed(list, seedList) {
    const seedIdx = new Map((seedList || []).map((e, i) => [String(e.id), i]));
    return list.sort((x, y) => {
      const ix = seedIdx.has(x.id) ? seedIdx.get(x.id) : Infinity;
      const iy = seedIdx.has(y.id) ? seedIdx.get(y.id) : Infinity;
      if (ix !== iy) return ix < iy ? -1 : 1;
      return cmpStr(String(x.id), String(y.id));
    });
  }

  // ---------------------------------------------------------------- whole state
  const COLLECTIONS = ['sessions', 'cardio', 'events'];
  const KNOWN = new Set(['settings', 'settingsTs', 'exercises', 'days', 'sessions', 'cardio', 'events',
    'tombstones', 'active', 'activeUpdatedAt', 'lastExportAt', 'schemaVersion']);
  const EX_SKIP = ['id', 'fieldTs', 'updatedAt'];

  // opts.seed: SEED_PROGRAM (for tie-breaks + ordering). Optional.
  function mergeStates(A, B, opts) {
    const seed = (opts && opts.seed) || null;
    A = A || {}; B = B || {};
    const out = {};
    const tA = A.tombstones || {}, tB = B.tombstones || {};
    out.tombstones = {};

    COLLECTIONS.forEach(c => {
      const m = mergeCollection(A[c], tA[c], B[c], tB[c]);
      out[c] = m.live.sort(c === 'sessions' ? bySession : byDated);
      out.tombstones[c] = m.tombs;
    });
    // any other tombstone collections a newer app version might add: union, LWW
    new Set([...Object.keys(tA), ...Object.keys(tB)]).forEach(c => {
      if (COLLECTIONS.includes(c)) return;
      out.tombstones[c] = mergeCollection([], tA[c], [], tB[c]).tombs;
    });

    // settings (per field)
    const sm = mergeFields(A.settings, B.settings, A.settingsTs, B.settingsTs, seed && seed.settings, null);
    out.settings = sm.value; out.settingsTs = sm.ts;

    // exercises (per exercise, per field)
    const seedEx = new Map(((seed && seed.exercises) || []).map(e => [String(e.id), e]));
    const exA = new Map((A.exercises || []).filter(e => e && e.id != null).map(e => [String(e.id), e]));
    const exB = new Map((B.exercises || []).filter(e => e && e.id != null).map(e => [String(e.id), e]));
    const exIds = new Set([...exA.keys(), ...exB.keys()]);
    const exercises = [];
    exIds.forEach(id => {
      const a = exA.get(id), b = exB.get(id);
      if (!a || !b) { exercises.push(clone(a || b)); return; }
      const fm = mergeFields(a, b, a.fieldTs, b.fieldTs, seedEx.get(id), EX_SKIP);
      const ex = { id, ...fm.value, fieldTs: fm.ts, updatedAt: Math.max(ts(a.updatedAt), ts(b.updatedAt)) };
      exercises.push(ex);
    });
    out.exercises = orderBySeed(exercises, seed && seed.exercises);

    // days (whole-record LWW)
    const dm = mergeCollection(A.days, [], B.days, []);
    out.days = orderBySeed(dm.live, seed && seed.days);

    // active workout (whole-object LWW)
    const aa = ts(A.activeUpdatedAt), ab = ts(B.activeUpdatedAt);
    let active;
    if (aa !== ab) active = aa > ab ? A.active : B.active;
    else if (eq(A.active || null, B.active || null)) active = A.active;
    else active = canonical(A.active || null) >= canonical(B.active || null) ? A.active : B.active;
    active = active ? clone(active) : null;
    if (active) {
      const done = out.sessions.some(s => s.id === active.id) || out.tombstones.sessions.some(s => s.id === active.id);
      if (done) active = null;
    }
    out.active = active;
    out.activeUpdatedAt = Math.max(aa, ab);

    // scalars
    const le = Math.max(ts(A.lastExportAt), ts(B.lastExportAt));
    if (le) out.lastExportAt = le;
    out.schemaVersion = Math.max(Number(A.schemaVersion) || 0, Number(B.schemaVersion) || 0);

    // unknown top-level keys (forward compatibility)
    new Set([...Object.keys(A), ...Object.keys(B)]).forEach(k => {
      if (KNOWN.has(k)) return;
      if (!(k in B)) out[k] = clone(A[k]);
      else if (!(k in A)) out[k] = clone(B[k]);
      else out[k] = clone(canonical(A[k]) >= canonical(B[k]) ? A[k] : B[k]);
    });
    return out;
  }

  root.LiftMerge = { canonical, hashString, contentId, mergeStates, mergeCollection, mergeFields };
})(typeof window !== 'undefined' ? window : globalThis);
