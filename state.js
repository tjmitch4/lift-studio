/* Lift Studio — state shape + normalize/migrate. Pure: no DOM. Depends on SEED_PROGRAM
   (program.js) and LiftMerge (sync-merge.js). Shared by app.js and tests/. */
'use strict';

// Bump when normalize() learns a new migration. Every migration is additive: fields are only
// ever defaulted, coerced or repaired — never renamed or dropped.
//   v3: sync bookkeeping — record ids + updatedAt, tombstones, per-field timestamps.
const SCHEMA_VERSION = 3;
const EFFORTS = ['easy', 'solid', 'grind'];
const BODY_CHECKS = ['good', 'tight', 'pain'];
const TOMB_KINDS = ['sessions', 'cardio', 'events'];

function freshState() {
  return {
    settings: { ...SEED_PROGRAM.settings },
    exercises: SEED_PROGRAM.exercises.map(e => ({ ...e })),
    days: SEED_PROGRAM.days.map(d => ({ ...d })),
    sessions: [],   // completed workouts
    cardio: [],     // cardio/sport entries
    events: [],     // progression events (for coach report)
    active: null,   // in-flight workout
    tombstones: { sessions: [], cardio: [], events: [] }, // deletes, kept so they sync
    settingsTs: {},       // {settingKey: ms last changed}
    activeUpdatedAt: 0,   // ms the in-flight workout last changed (0 = never)
    schemaVersion: SCHEMA_VERSION,
  };
}

// Deterministic id for a watch-imported cardio entry: two devices importing the same CSV
// row mint the same id, and a deleted watch entry's tombstone blocks its re-import.
const watchCardioId = wkey => 'cw-' + LiftMerge.hashString(String(wkey));
// Noon UTC on an ISO date — a stable, timezone-independent stamp for date-only history.
const dateStamp = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : 0;
};

// Forward-migrate + sanitize a stored or imported state object. Used by load(), Import JSON
// and sync (on the downloaded copy). Throws only when the input is not a Lift Studio state.
function normalize(st) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('not a Lift Studio state');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = (v, d = 0) => { const n = Number(v); return v !== null && v !== '' && isFinite(n) ? n : d; };
  const numOrNull = v => num(v, null);
  const str = v => (v == null ? '' : String(v));
  const tsOf = v => Math.max(0, num(v, 0));
  const tsMap = v => {
    const out = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach(k => { const n = tsOf(v[k]); if (n) out[k] = n; });
    return out;
  };
  // ids for records that never had one: content hash, plus an occurrence counter so two
  // identical entries (e.g. two 30-min walks on one day) stay two records
  const idMinter = prefix => {
    const seen = {};
    return rec => {
      const base = LiftMerge.contentId(prefix, rec);
      const n = seen[base] = (seen[base] || 0) + 1;
      return n > 1 ? base + '-' + n : base;
    };
  };

  // settings: seed defaults + stored values
  const set = { ...SEED_PROGRAM.settings, ...(st.settings && typeof st.settings === 'object' ? st.settings : {}) };
  Object.keys(SEED_PROGRAM.settings).forEach(k => {
    if (k !== 'platePairs') set[k] = num(set[k], SEED_PROGRAM.settings[k]);
  });
  set.platePairs = arr(set.platePairs).map(Number).filter(x => isFinite(x) && x > 0);
  if (!set.platePairs.length) set.platePairs = [...SEED_PROGRAM.settings.platePairs];
  st.settings = set;
  st.settingsTs = tsMap(st.settingsTs);

  // events first: v3 uses them to date weight changes made before sync existed
  const eventId = idMinter('e');
  st.events = arr(st.events).filter(e => e && typeof e === 'object').map(e => {
    const o = { ...e, updatedAt: tsOf(e.updatedAt) };
    if (o.id == null || o.id === '') o.id = eventId(o); else o.id = str(o.id);
    return o;
  });
  const lastEventAt = {}; // exId -> {weight: ms, reps: ms}
  st.events.forEach(e => {
    const at = e.updatedAt || dateStamp(e.date);
    const slot = lastEventAt[e.exId] = lastEventAt[e.exId] || {};
    const f = e.kind === 'time' ? 'reps' : 'weight';
    if (at > (slot[f] || 0)) slot[f] = at;
  });

  // exercises: keep stored ones (coerced), merge any new seed exercises
  st.exercises = arr(st.exercises).filter(e => e && typeof e === 'object' && e.id != null).map(e => {
    const o = {
      ...e,
      id: str(e.id), name: str(e.name || e.id), type: str(e.type), loadLabel: str(e.loadLabel),
      day: e.day == null ? null : str(e.day),
      sets: Math.max(1, num(e.sets, 3)), repLow: num(e.repLow, 8), repHigh: num(e.repHigh, 10),
      weight: numOrNull(e.weight), increment: num(e.increment, 0),
      fieldTs: tsMap(e.fieldTs), updatedAt: tsOf(e.updatedAt),
    };
    // v3: a weight/hold target changed by a progression event before sync existed is dated
    // by that event, so it beats an untouched seed value on another device.
    const ev = lastEventAt[o.id];
    if (ev && ev.weight && !o.fieldTs.weight) o.fieldTs.weight = ev.weight;
    if (ev && ev.reps) {
      if (!o.fieldTs.repLow) o.fieldTs.repLow = ev.reps;
      if (!o.fieldTs.repHigh) o.fieldTs.repHigh = ev.reps;
    }
    return o;
  });
  const have = new Set(st.exercises.map(e => e.id));
  SEED_PROGRAM.exercises.forEach(e => { if (!have.has(e.id)) st.exercises.push({ ...e, fieldTs: {}, updatedAt: 0 }); });

  st.days = arr(st.days).filter(d => d && d.id != null).map(d => ({ ...d, id: str(d.id), name: str(d.name || d.id), updatedAt: tsOf(d.updatedAt) }));
  if (!st.days.length) st.days = SEED_PROGRAM.days.map(d => ({ ...d, updatedAt: 0 }));

  // sessions / active workout. Repairs sets arrays holding null (out-of-order set taps
  // in older versions left holes that JSON saved as null).
  const normEntries = entries => {
    const out = {};
    if (!entries || typeof entries !== 'object') return out;
    Object.keys(entries).forEach(k => {
      const e = entries[k];
      if (!e || typeof e !== 'object') return;
      out[k] = {
        ...e,
        target: numOrNull(e.target),
        sets: arr(e.sets).filter(x => x && typeof x === 'object').map(x => ({
          ...x,
          reps: num(x.reps), weight: num(x.weight),
          effort: EFFORTS.includes(x.effort) ? x.effort : 'solid',
          note: typeof x.note === 'string' ? x.note : '',
        })),
      };
    });
    return out;
  };
  const sessionId = idMinter('s');
  const normSession = s => {
    const o = { ...s, day: str(s.day), date: str(s.date), entries: normEntries(s.entries), updatedAt: tsOf(s.updatedAt) };
    if (o.bodyCheck != null && !BODY_CHECKS.includes(o.bodyCheck)) o.bodyCheck = null;
    if (o.bodyNote != null) o.bodyNote = str(o.bodyNote);
    if (o.minutes != null) o.minutes = num(o.minutes, null);
    o.id = o.id == null || o.id === '' ? sessionId(o) : str(o.id);
    return o;
  };
  st.sessions = arr(st.sessions).filter(s => s && typeof s === 'object').map(normSession);
  st.active = st.active && typeof st.active === 'object' ? normSession(st.active) : null;
  if (st.active) {
    delete st.active.updatedAt; // the active workout is stamped by st.activeUpdatedAt
    st.active.startedAt = num(st.active.startedAt, Date.now());
    if (st.active.restEndAt != null) st.active.restEndAt = num(st.active.restEndAt, 0);
  }
  st.activeUpdatedAt = tsOf(st.activeUpdatedAt);
  if (st.active && !st.activeUpdatedAt) {
    // pre-v3 in-flight workout: date it by its last logged set (or its start)
    const sets = Object.values(st.active.entries).flatMap(e => e.sets.map(x => num(x.t, 0)));
    st.activeUpdatedAt = Math.max(st.active.startedAt, ...sets);
  }

  const cardioId = idMinter('c');
  st.cardio = arr(st.cardio).filter(c => c && typeof c === 'object').map(c => {
    const o = {
      ...c,
      date: str(c.date), kind: str(c.kind || 'Other'), minutes: num(c.minutes),
      distance: str(c.distance), note: str(c.note),
      hr: numOrNull(c.hr), cal: numOrNull(c.cal), updatedAt: tsOf(c.updatedAt),
    };
    if (o.id == null || o.id === '') o.id = o.wkey ? watchCardioId(o.wkey) : cardioId(o);
    else o.id = str(o.id);
    return o;
  });

  const tb = st.tombstones && typeof st.tombstones === 'object' && !Array.isArray(st.tombstones) ? st.tombstones : {};
  const tombs = {};
  Object.keys(tb).concat(TOMB_KINDS).forEach(k => {
    tombs[k] = arr(tb[k]).filter(t => t && t.id != null).map(t => ({ id: str(t.id), deleted: true, updatedAt: tsOf(t.updatedAt) }));
  });
  st.tombstones = tombs;
  // a record and its own tombstone on the same device: the newer one wins (tie -> deleted)
  TOMB_KINDS.forEach(k => {
    const dead = new Map(tombs[k].map(t => [t.id, t.updatedAt]));
    if (dead.size) st[k] = st[k].filter(r => !(dead.has(r.id) && dead.get(r.id) >= r.updatedAt));
  });

  if (st.lastExportAt != null) st.lastExportAt = tsOf(st.lastExportAt) || undefined;
  st.schemaVersion = SCHEMA_VERSION;
  return st;
}
