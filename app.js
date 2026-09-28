/* Lift Studio — vanilla JS, localStorage, no dependencies */
'use strict';

// ============================================================ state
// Shape + normalize()/freshState() live in state.js; the sync merge in sync-merge.js.
const LS_KEY = 'liftstudio.v1';

// loadProblem: saved data exists but could not be read. The raw text is kept aside and
// save() refuses to write, so a parse bug can never silently overwrite TJ's real log.
let loadProblem = null;
let saveFailed = false;
let sync = null;             // Dropbox sync engine (null when DROPBOX_APP_KEY is empty)
let applyingRemote = false;  // true while saving a merged copy that came from Dropbox
let S = load();
function load() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) { saveFailed = true; return freshState(); }
  if (!raw) return freshState();
  try {
    return normalize(JSON.parse(raw));
  } catch (e) {
    // keep one copy of the raw text aside — but not a fresh copy on every launch, which
    // would eat the ~5 MB localStorage quota while the banner is up
    try {
      let kept = false;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_KEY + '.corrupt-') === 0 && localStorage.getItem(k) === raw) { kept = true; break; }
      }
      if (!kept) localStorage.setItem(LS_KEY + '.corrupt-' + Date.now(), raw);
    } catch (e2) {}
    loadProblem = { raw, error: String((e && e.message) || e) };
    console.error('Lift Studio: saved data unreadable', e);
    return freshState();
  }
}
function save() {
  if (loadProblem) return; // never overwrite data we couldn't read
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
    if (saveFailed) { saveFailed = false; render(); }
    if (sync && !applyingRemote) sync.schedule(); // push to Dropbox 2s after the last change
  } catch (e) {
    console.error('Lift Studio: save failed', e && e.name, e);
    if (!saveFailed) { saveFailed = true; render(); toast("Couldn't save — export a backup now."); }
  }
}
// Ask the browser not to evict our storage (best-effort; Safari may ignore it).
try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch (e) {}

// ============================================================ ui state (transient)
let tab = 'workout';
let openLogger = null;        // {exId, setIdx, reps, weight, effort, note, showNote}
let progressEx = null;        // selected exercise id on progress tab
let expandedSession = null;   // session id expanded in history
let cardioKind = null;
let coachReportCache = null;
let coachReportDay = null;     // the report embeds today's date + a 14-day window

// ============================================================ helpers
const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtW = w => (w == null ? '—' : (w % 1 ? w.toFixed(1) : String(w)));
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const daysAgo = iso => Math.floor((new Date(todayISO()) - new Date(iso)) / 86400000);
const exById = id => S.exercises.find(e => e.id === id);
const dayName = id => (S.days.find(d => d.id === id) || {}).name || id;
const isCompound = ex => ex.type === 'barbell';
const uid = () => 's' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

// ---- sync bookkeeping (every mutation stamps what it changed; see sync-merge.js) ----
// the in-flight workout changed (not for rest-timer housekeeping: a device that merely
// reloads must never out-stamp sets logged on another device)
const touchActive = () => { S.activeUpdatedAt = Date.now(); };
// exercise fields changed (per-field last-write-wins)
function touchEx(ex, fields) {
  const now = Date.now();
  ex.fieldTs = ex.fieldTs || {};
  fields.forEach(f => { ex.fieldTs[f] = now; });
  ex.updatedAt = now;
}
// delete a synced record: drop it and keep a tombstone so the delete reaches other devices
function tombstone(kind, id) {
  S[kind] = S[kind].filter(r => r.id !== id);
  S.tombstones[kind] = (S.tombstones[kind] || []).filter(t => t.id !== id);
  S.tombstones[kind].push({ id, deleted: true, updatedAt: Date.now() });
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

const scrollBehavior = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
// keyboard support for non-button tap targets marked role="button"
document.addEventListener('keydown', ev => {
  const el = ev.target;
  if ((ev.key === 'Enter' || ev.key === ' ') && el && el.getAttribute && el.getAttribute('role') === 'button') {
    ev.preventDefault(); el.click();
  }
});

// ---- backup age -------------------------------------------------
function backupDays() {
  return S.lastExportAt ? Math.floor((Date.now() - S.lastExportAt) / 86400000) : null;
}
function backupAgeText() {
  const d = backupDays();
  return d == null ? 'No backup exported from this device yet.'
    : d === 0 ? 'Last backup: today.' : `Last backup: ${d} day${d > 1 ? 's' : ''} ago.`;
}
function backupOverdue() {
  // Dropbox sync is the backup: no nag while it's working
  const ss = sync && sync.signedIn() ? sync.getStatus() : null;
  if (ss && ss.lastSyncedAt && Date.now() - ss.lastSyncedAt < 14 * 86400000) return false;
  const d = backupDays();
  return S.sessions.length > 0 && (d == null || d > 14);
}
function hasPreImportBackup() {
  try { return !!localStorage.getItem(LS_KEY + '.backup-pre-import'); } catch (e) { return false; }
}

// ---- plate math -------------------------------------------------
function greedy(target, plates) {
  // plates: array of available plate values (multiset), any order
  const sorted = [...plates].sort((a, b) => b - a);
  const used = []; let rem = target;
  for (const p of sorted) { if (p <= rem + 1e-9) { used.push(p); rem = +(rem - p).toFixed(2); } }
  return { used, rem };
}
function plateText(ex, weight) {
  if (weight == null) return '';
  const st = S.settings;
  if (ex.loadLabel === 'bar') {
    const perSide = (weight - st.barWeight) / 2;
    if (perSide < 0) return `Below bar weight (${st.barWeight})`;
    if (perSide === 0) return 'Empty bar';
    const { used, rem } = greedy(perSide, st.platePairs);
    let txt = `Per side: <b>${used.map(fmtW).join(' + ') || '—'}</b>`;
    if (rem > 0.01) txt += ` <span style="color:var(--red)">(${fmtW(rem)} short — not loadable)</span>`;
    return txt;
  }
  if (ex.loadLabel === 'sleeve') {
    // landmine: one sleeve, singles available = 2 of each pair value
    const singles = S.settings.platePairs.flatMap(p => [p, p]);
    const { used, rem } = greedy(weight, singles);
    let txt = `On sleeve: <b>${used.map(fmtW).join(' + ') || '—'}</b>`;
    if (rem > 0.01) txt += ` <span style="color:var(--red)">(${fmtW(rem)} short)</span>`;
    return txt;
  }
  return '';
}
function isLoadable(ex, w) {
  const st = S.settings;
  if (ex.loadLabel === 'bar') {
    const perSide = (w - st.barWeight) / 2;
    return perSide >= 0 && greedy(perSide, st.platePairs).rem <= 0.01;
  }
  if (ex.loadLabel === 'sleeve') return greedy(w, st.platePairs.flatMap(p => [p, p])).rem <= 0.01;
  return true;
}
function loadableRound(ex, w, dir) {
  // round a weight to something actually loadable with the configured plates.
  // dir: 1 = prefer at/above w (move-ups), -1 = prefer at/below w (deloads)
  const plateLoaded = ex.loadLabel === 'bar' || ex.loadLabel === 'sleeve';
  if (!plateLoaded) return Math.round(w / 2.5) * 2.5;
  const smallest = Math.min(...S.settings.platePairs);
  const step = ex.loadLabel === 'bar' ? smallest * 2 : smallest;
  const start = (dir === -1 ? Math.floor(w / step + 1e-9) : dir === 1 ? Math.ceil(w / step - 1e-9) : Math.round(w / step)) * step;
  const dirs = dir === -1 ? [-1] : dir === 1 ? [1] : [1, -1];
  for (let k = 0; k <= 40; k++) {
    for (const d of dirs) {
      const c = +(start + d * k * step).toFixed(2);
      if (c > 0 && isLoadable(ex, c)) return c;
    }
  }
  return ex.loadLabel === 'bar' ? Math.round(w / 5) * 5 : Math.round(w / 2.5) * 2.5;
}

// ---- progression ------------------------------------------------
function exHistory(exId) {
  // completed sessions containing this exercise, oldest -> newest
  return S.sessions
    .filter(s => s.entries[exId] && s.entries[exId].sets.length)
    .map(s => ({ date: s.date, sessionId: s.id, target: s.entries[exId].target, sets: s.entries[exId].sets }));
}
function resultOf(ex, sets, target) {
  // 'top'  = every planned set logged, all at/above repHigh, none lighter than the target
  // 'miss' = any set below repLow; else 'work'
  sets = (sets || []).filter(Boolean);
  if (!sets.length) return 'none';
  if (sets.some(st => st.reps < ex.repLow)) return 'miss';
  const weighted = ex.type !== 'bodyweight' && ex.type !== 'timed' && target != null;
  const fullWeight = !weighted || sets.every(st => st.weight >= target - 1e-9);
  if (sets.length >= ex.sets && fullWeight && sets.every(st => st.reps >= ex.repHigh)) return 'top';
  return 'work';
}
function computeSuggestions(session) {
  // called at finish; returns [{exId, kind:'up'|'down', from, to, msg}]
  const out = [];
  for (const exId of Object.keys(session.entries)) {
    const ex = exById(exId); if (!ex) continue;
    const entry = session.entries[exId];
    if (!entry.sets.length) continue;

    // TBD weight: adopt what was lifted
    if (ex.weight == null) {
      const w = entry.sets[entry.sets.length - 1].weight;
      if (w != null) out.push({ exId, kind: 'set', from: null, to: w, msg: `First weight logged — set <b>${fmtW(w)} lb</b> as the working target?` });
      continue;
    }
    if (ex.bonus) continue; // bonus lifts never trigger progression rules

    const hist = [...exHistory(exId), { target: entry.target, sets: entry.sets }];

    if (ex.type === 'timed') {
      const streak = countStreak(hist, h => h.sets.length >= ex.sets && h.sets.every(st => st.reps >= ex.repHigh));
      if (streak >= S.settings.progressAfter) {
        out.push({ exId, kind: 'time', from: ex.repHigh, to: ex.repHigh + 15, msg: `${streak} straight sessions holding ${ex.repHigh}s — bump the target to <b>${ex.repHigh + 15}s</b>?` });
      }
      continue;
    }

    // Streaks run over the full date-ordered history: a session at any other target
    // weight (e.g. before a deload or move-up) breaks the streak.
    const { topStreak, missStreak } = streaks(ex, hist);

    if (topStreak >= S.settings.progressAfter) {
      const to = loadableRound(ex, ex.weight + ex.increment, 1);
      out.push({ exId, kind: 'up', from: ex.weight, to, msg: `<b>${topStreak} straight sessions</b> at the top of the range. Move up: <b>${fmtW(ex.weight)} → ${fmtW(to)} lb</b>, aim for ${ex.repLow} reps.` });
    } else if (missStreak >= S.settings.deloadAfter) {
      const to = loadableRound(ex, ex.weight * (1 - S.settings.deloadPct), -1);
      out.push({ exId, kind: 'down', from: ex.weight, to, msg: `<b>${missStreak} sessions stalled</b> at ${fmtW(ex.weight)} lb. Deload ~${Math.round(S.settings.deloadPct * 100)}%: <b>${fmtW(to)} lb</b>, build back up.` });
    }
  }
  return out;
}
function streaks(ex, hist) {
  const at = h => h.target === ex.weight;
  return {
    topStreak: countStreak(hist, h => at(h) && resultOf(ex, h.sets, h.target) === 'top'),
    missStreak: countStreak(hist, h => at(h) && resultOf(ex, h.sets, h.target) === 'miss'),
  };
}
function countStreak(arr, pred) {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i])) n++; else break; }
  return n;
}

// ============================================================ rest timer
let rest = { endAt: 0, left: 0, total: 0, iv: null };
// iOS only lets audio play from a context created/resumed during a user gesture, and the
// rest timer fires from setInterval — so create + unlock one shared context on first tap.
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
document.addEventListener('touchend', unlockAudio, { passive: true });
document.addEventListener('click', unlockAudio);
function startRest(seconds) {
  runRest(Date.now() + seconds * 1000, seconds);
}
// Wall-clock based: iOS suspends timers while the phone is locked, so every tick (and every
// return to the app) recomputes what's left from endAt instead of counting ticks.
// endAt is mirrored into S.active (additive fields) so a reload or page eviction keeps it.
function runRest(endAt, total) {
  clearInterval(rest.iv);
  rest.endAt = endAt; rest.total = total;
  if (S.active) { S.active.restEndAt = endAt; S.active.restTotal = total; save(); }
  $('#restBar').classList.remove('hidden');
  document.body.classList.add('resting');
  tickRest();
  rest.iv = setInterval(tickRest, 1000);
}
function tickRest() {
  if (!rest.endAt) return;
  rest.left = Math.ceil((rest.endAt - Date.now()) / 1000);
  if (rest.left <= 0) endRest(true); else paintRest();
  paintMinutes();
}
function paintRest() {
  const left = Math.max(0, rest.left);
  const m = Math.floor(left / 60), s = left % 60;
  $('#restTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('#restFill').style.width = Math.min(100, left / rest.total * 100) + '%';
}
function paintMinutes() {
  const pill = $('#woMins');
  if (pill && S.active) pill.textContent = `${activeMinutes()} min`;
}
function endRest(ding) {
  clearInterval(rest.iv); rest.iv = null;
  const wasRunning = !!rest.endAt;
  rest.endAt = 0;
  $('#restBar').classList.add('hidden');
  document.body.classList.remove('resting');
  if (S.active && S.active.restEndAt) { delete S.active.restEndAt; delete S.active.restTotal; save(); }
  if (ding && wasRunning) {
    announce('Rest over');
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
    try {
      unlockAudio();
      const ctx = audioCtx; if (!ctx) return;
      [0, 0.25].forEach(t => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 880; g.gain.setValueAtTime(0.25, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
      });
    } catch (e) {}
  }
}
function announce(msg) {
  const el = $('#srLive'); if (!el) return;
  el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 50);
}
$('#restPlus').onclick = () => { if (rest.endAt) runRest(rest.endAt + 30000, rest.total + 30); };
$('#restSkip').onclick = () => endRest(false);
// Coming back from a locked phone / background: repaint immediately (and ding if it's over).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickRest(); paintMinutes(); } });
window.addEventListener('pageshow', () => { tickRest(); paintMinutes(); });
// keep the workout's "N min" pill fresh without a full re-render
setInterval(paintMinutes, 30000);

// ============================================================ workout tab
function suggestedDay() {
  const done = S.sessions.map(s => s.day);
  if (!done.length) return 'push';
  const order = S.days.map(d => d.id);
  const last = done[done.length - 1];
  return order[(order.indexOf(last) + 1) % order.length];
}
function lastDone(dayId) {
  for (let i = S.sessions.length - 1; i >= 0; i--) if (S.sessions[i].day === dayId) return S.sessions[i].date;
  return null;
}

function renderWorkout() {
  if (S.active) return renderActive();
  const sug = suggestedDay();
  let html = `<div class="hero">
    <h2>Ready to lift?</h2>
    <div class="muted">Weekly split — <b style="color:var(--accent)">${esc(dayName(sug))}</b> is up next in the rotation.</div>
    ${backupOverdue() ? `<div class="faint" style="margin-top:8px">${backupAgeText()} <a href="#" id="goBackup" class="link">Back up on the Coach tab</a></div>` : ''}
  </div>
  <div class="section-title">Pick your day</div>`;
  for (const d of S.days) {
    const last = lastDone(d.id);
    const exs = S.exercises.filter(e => e.day === d.id);
    html += `<button class="card day-card ${d.id === sug ? 'suggested' : ''}" data-start="${esc(d.id)}">
      <span>
        <span class="day-title">${esc(d.name)} ${d.id === sug ? '<span class="pill amber">UP NEXT</span>' : ''}</span>
        <span class="day-meta">${exs.length} exercises · ${last ? 'last: ' + fmtDate(last) + ` (${daysAgo(last)}d ago)` : 'not logged yet'}</span>
      </span>
      <span class="day-arrow" aria-hidden="true">›</span>
    </button>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-start]').forEach(el => el.onclick = () => startWorkout(el.dataset.start));
  const gb = $('#goBackup');
  if (gb) gb.onclick = ev => { ev.preventDefault(); tab = 'coach'; render(); };
}

function startWorkout(dayId) {
  S.active = { id: uid(), day: dayId, date: todayISO(), startedAt: Date.now(), entries: {} };
  S.exercises.filter(e => e.day === dayId).forEach(e => {
    S.active.entries[e.id] = { target: e.weight, sets: [] };
  });
  openLogger = null;
  touchActive(); save(); render();
}

function renderActive() {
  const a = S.active;
  const exs = S.exercises.filter(e => e.day === a.day || a.entries[e.id]);
  let html = `<div class="workout-head">
    <h2>${esc(dayName(a.day))}</h2>
    <span class="pill gray" id="woMins">${activeMinutes()} min</span>
  </div>`;
  if (a.date !== todayISO()) {
    html += `<div class="banner warn">This workout was started ${esc(fmtDate(a.date))}. Finish it to save what you logged, or discard it to start today's.</div>`;
  }
  for (const ex of exs) {
    const entry = a.entries[ex.id] || (a.entries[ex.id] = { target: ex.weight, sets: [] });
    const target = entry.target;
    const done = entry.sets;
    const isTimed = ex.type === 'timed';
    const isBody = ex.type === 'bodyweight';
    const targetTxt = isTimed ? `${ex.sets}×${ex.repHigh}s`
      : isBody ? `${ex.sets}× max reps`
      : `${target == null ? 'set weight' : fmtW(target) + ' lb'} · ${ex.sets}×${ex.repLow}–${ex.repHigh}`;
    const plates = target != null ? plateText(ex, target) : '';
    const exAttr = esc(ex.id);

    // Only logged sets and the single next slot are tappable, so a mis-tap on a later
    // slot can't leave a gap in the sets array.
    let dots = '';
    for (let i = 0; i < Math.max(ex.sets, done.length); i++) {
      const st = done[i];
      if (st) {
        const effLetter = st.effort[0].toUpperCase();
        const label = `Set ${i + 1}: ${isTimed ? st.reps + ' seconds' : st.reps + ' reps'}${isTimed || isBody ? '' : ' at ' + fmtW(st.weight) + ' lb'}, ${st.effort}. Tap to edit.`;
        dots += `<button class="set-dot done e-${st.effort}" data-ex="${exAttr}" data-idx="${i}" aria-label="${esc(label)}">
          ${isTimed ? st.reps + 's' : st.reps}<small>${isTimed || isBody ? '' : fmtW(st.weight) + ' · '}${effLetter}</small></button>`;
      } else if (i === done.length) {
        dots += `<button class="set-dot next" data-ex="${exAttr}" data-idx="${i}" aria-label="Log set ${i + 1}">LOG</button>`;
      } else {
        dots += `<span class="set-dot" aria-hidden="true">${i + 1}</span>`;
      }
    }
    if (done.length >= ex.sets) {
      dots += `<button class="set-dot extra" data-ex="${exAttr}" data-idx="${done.length}" aria-label="Add an extra set">+</button>`;
    }
    const headTap = done.length < ex.sets;

    html += `<div class="card ex-card">
      <div class="ex-head" ${headTap ? `data-ex="${exAttr}" data-idx="${done.length}" role="button" tabindex="0" aria-label="Log next set of ${esc(ex.name)}"` : ''}>
        <div class="ex-title-row">
          <div class="ex-name">${esc(ex.name)}</div>
          <div class="ex-target">${targetTxt}</div>
        </div>
        <div class="ex-sub">
          ${ex.bonus ? '<span class="pill amber">BONUS</span>' : ''}
          <span class="pill gray">${esc(ex.loadLabel === 'body' ? 'bodyweight' : ex.loadLabel)}</span>
          ${done.length ? `<span>${done.length}/${ex.sets} sets</span>` : ''}
        </div>
        ${plates ? `<div class="plate-math">${plates}</div>` : ''}
        ${ex.coachNote ? `<div class="ex-note-line">◦ ${esc(ex.coachNote)}</div>` : ''}
      </div>
      <div class="set-dots">${dots}</div>
      ${openLogger && openLogger.exId === ex.id ? loggerHTML(ex) : ''}
    </div>`;
  }
  html += `<button class="btn secondary" id="addBonus" style="margin-bottom:12px">+ Bonus exercise</button>
  <div class="btn-row" style="margin-top:6px">
    <button class="btn secondary" id="cancelWo">Discard</button>
    <button class="btn" id="finishWo">Finish workout</button>
  </div>`;
  view.innerHTML = html;
  $('#addBonus').onclick = bonusModal;

  view.querySelectorAll('[data-ex][data-idx]').forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    openSetLogger(el.dataset.ex, +el.dataset.idx);
  });
  wireLogger();
  $('#finishWo') && ($('#finishWo').onclick = finishFlow);
  $('#cancelWo') && ($('#cancelWo').onclick = () => confirmModal(
    'Discard this workout?', 'Logged sets from this session will be lost.',
    () => { S.active = null; openLogger = null; endRest(false); touchActive(); save(); render(); }));
}

function activeMinutes() {
  return S.active ? Math.max(0, Math.floor((Date.now() - S.active.startedAt) / 60000)) : 0;
}

function openSetLogger(exId, setIdx) {
  const ex = exById(exId);
  const entry = S.active.entries[exId];
  if (!ex || !entry) return;
  setIdx = Math.max(0, Math.min(setIdx, entry.sets.length)); // never leave a gap
  if (openLogger && openLogger.exId === exId && openLogger.setIdx === setIdx) { openLogger = null; render(); return; }
  const existing = entry.sets[setIdx];
  const prevSet = entry.sets[setIdx - 1] || entry.sets[entry.sets.length - 1];
  const isTimed = ex.type === 'timed';
  const defaultW = ex.type === 'barbell' ? 95 : ex.type === 'dumbbell' ? 15 : 30;
  openLogger = existing ? { exId, setIdx, ...existing, showNote: !!existing.note, editing: true }
    : {
      exId, setIdx,
      reps: isTimed ? ex.repHigh : (prevSet ? prevSet.reps : (ex.repHigh > 30 ? 10 : ex.repHigh)),
      weight: isTimed || ex.type === 'bodyweight' ? 0 : (prevSet ? prevSet.weight : (entry.target != null ? entry.target : defaultW)),
      effort: 'solid', note: '', showNote: false,
    };
  render();
  const card = view.querySelector(`.logger`);
  if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
}

function loggerHTML(ex) {
  const L = openLogger;
  const isTimed = ex.type === 'timed';
  const noWeight = isTimed || ex.type === 'bodyweight';
  const unit = isTimed ? 'seconds' : 'reps';
  return `<div class="logger">
    <div class="logger-row">
      <div class="stepper">
        <button data-step="reps:-1" aria-label="Decrease ${unit}">−</button>
        <div class="stepper-val" aria-live="polite">${L.reps}<small>${isTimed ? 'SEC' : 'REPS'}</small></div>
        <button data-step="reps:1" aria-label="Increase ${unit}">+</button>
      </div>
      ${noWeight ? '' : `<div class="stepper">
        <button data-step="weight:-1" aria-label="Decrease weight">−</button>
        <div class="stepper-val" aria-live="polite">${fmtW(L.weight)}<small>LB ${esc(ex.loadLabel === 'bar' ? '' : ex.loadLabel).toUpperCase()}</small></div>
        <button data-step="weight:1" aria-label="Increase weight">+</button>
      </div>`}
    </div>
    ${!isTimed && ex.loadLabel === 'bar' ? `<div class="plate-math" style="margin:-4px 0 12px">${plateText(ex, L.weight)}</div>` : ''}
    <div class="effort-row" role="group" aria-label="Effort">
      <button class="effort-btn ${L.effort === 'easy' ? 'sel-easy' : ''}" data-eff="easy" aria-pressed="${L.effort === 'easy'}">Easy</button>
      <button class="effort-btn ${L.effort === 'solid' ? 'sel-solid' : ''}" data-eff="solid" aria-pressed="${L.effort === 'solid'}">Solid</button>
      <button class="effort-btn ${L.effort === 'grind' ? 'sel-grind' : ''}" data-eff="grind" aria-pressed="${L.effort === 'grind'}">Grind</button>
    </div>
    ${L.showNote ? `<textarea id="setNote" rows="2" aria-label="Set note" placeholder="Note — form cue, pain, anything worth telling coach…">${esc(L.note)}</textarea>` : ''}
    <div class="btn-row">
      <button class="btn-ghost" id="noteToggle">${L.showNote ? 'Hide note' : '+ Note'}</button>
      ${L.editing ? `<button class="btn-ghost danger" id="deleteSet">Delete set</button>` : ''}
      <button class="btn" id="saveSet" style="flex:2">${L.editing ? 'Save set' : 'Log set'}</button>
    </div>
  </div>`;
}

// Re-render just the open logger (stepper/effort taps) instead of the whole workout.
function refreshLogger() {
  const el = view.querySelector('.logger');
  const ex = openLogger && exById(openLogger.exId);
  if (!el || !ex) return render();
  el.outerHTML = loggerHTML(ex);
  wireLogger();
}

function wireLogger() {
  if (!openLogger) return;
  const ex = exById(openLogger.exId);
  const isTimed = ex.type === 'timed';
  const keepNote = () => { const noteEl = $('#setNote'); if (noteEl) openLogger.note = noteEl.value; };
  view.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const [field, dir] = b.dataset.step.split(':');
    keepNote();
    if (field === 'reps') openLogger.reps = Math.max(isTimed ? 5 : 1, openLogger.reps + (isTimed ? 5 : 1) * +dir);
    else openLogger.weight = Math.max(0, +(openLogger.weight + (ex.increment || 2.5) * +dir).toFixed(1));
    refreshLogger();
  });
  view.querySelectorAll('[data-eff]').forEach(b => b.onclick = () => {
    keepNote();
    openLogger.effort = b.dataset.eff; refreshLogger();
  });
  const nt = $('#noteToggle');
  if (nt) nt.onclick = () => {
    keepNote();
    openLogger.showNote = !openLogger.showNote; refreshLogger();
    const ta = $('#setNote'); if (ta) ta.focus();
  };
  const del = $('#deleteSet');
  if (del) del.onclick = () => {
    const L = openLogger;
    confirmModal('Delete this set?', `Set ${L.setIdx + 1} of ${ex.name} is removed from today's workout.`, () => {
      const entry = S.active && S.active.entries[L.exId];
      if (!entry) { openLogger = null; return render(); }
      entry.sets.splice(L.setIdx, 1);
      openLogger = null;
      touchActive(); save(); render(); toast('Set deleted.');
    });
  };
  const sv = $('#saveSet');
  if (sv) sv.onclick = () => {
    keepNote();
    const L = openLogger;
    const entry = S.active && S.active.entries[L.exId];
    if (!entry) { openLogger = null; return render(); } // workout finished on another device
    const idx = Math.min(L.setIdx, entry.sets.length); // never leave a gap
    const prior = entry.sets[idx];
    const setData = { reps: L.reps, weight: isTimed || ex.type === 'bodyweight' ? 0 : L.weight, effort: L.effort, note: (L.note || '').trim() };
    const t = prior ? prior.t : Date.now(); // when the set was first logged (additive field)
    if (t) setData.t = t;
    entry.sets[idx] = setData;
    if (entry.target == null) entry.target = setData.weight;
    openLogger = null;
    touchActive(); save(); render();
    if (!prior && entry.sets.length < ex.sets + 3) {
      startRest(isCompound(ex) ? S.settings.restCompound : S.settings.restDefault);
    }
  };
}

// ---- bonus exercises --------------------------------------------
const BONUS_PRESETS = [
  { name: 'Pushups', type: 'bodyweight' }, { name: 'Pull-ups', type: 'bodyweight' },
  { name: 'Dips', type: 'bodyweight' }, { name: 'Goblet Squat', type: 'dumbbell' },
  { name: 'Farmer Carry', type: 'dumbbell' },
];
function bonusModal() {
  const prior = S.exercises.filter(e => e.bonus).map(e => ({ name: e.name, type: e.type }));
  const picks = [...prior, ...BONUS_PRESETS.filter(p => !prior.some(x => x.name.toLowerCase() === p.name.toLowerCase()))].slice(0, 8);
  modal(`<h3>Bonus exercise</h3>
    <div class="muted">Feeling spicy? Throw something extra on today's session.</div>
    <div class="kind-row">${picks.map((p, i) => `<button class="chip" data-bpick="${i}">${esc(p.name)}</button>`).join('')}</div>
    <input type="text" id="bxName" placeholder="Exercise name…" style="margin-bottom:12px">
    <div class="effort-row">
      <button class="effort-btn sel-solid" data-btype="bodyweight">Bodyweight</button>
      <button class="effort-btn" data-btype="dumbbell">Dumbbell</button>
      <button class="effort-btn" data-btype="barbell">Barbell</button>
      <button class="effort-btn" data-btype="cable">Cable</button>
    </div>
    <div class="btn-row" style="margin-top:14px"><button class="btn" id="bxAdd">Add to workout</button></div>`);
  let btype = 'bodyweight';
  const markType = t => {
    btype = t;
    document.querySelectorAll('[data-btype]').forEach(b =>
      b.className = 'effort-btn' + (b.dataset.btype === t ? ' sel-solid' : ''));
  };
  document.querySelectorAll('[data-btype]').forEach(b => b.onclick = () => markType(b.dataset.btype));
  document.querySelectorAll('[data-bpick]').forEach(b => b.onclick = () => {
    const p = picks[+b.dataset.bpick];
    $('#bxName').value = p.name;
    markType(p.type);
  });
  $('#bxAdd').onclick = () => {
    const name = ($('#bxName').value || '').trim();
    if (!name) return toast('Name the exercise');
    addBonusExercise(name, btype);
    closeModal();
  };
}
function addBonusExercise(name, type) {
  // reuse a prior bonus lift with the same name + type; otherwise mint a unique id
  // (symbol-only names slug to '', and 'DB Row' vs 'db-row!' must not merge across types)
  let ex = S.exercises.find(e => e.bonus && e.name.toLowerCase() === name.toLowerCase() && e.type === type);
  let id = ex ? ex.id : null;
  if (!ex) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    id = 'bx-' + (slug || uid());
    const clash = exById(id);
    if (clash && clash.type !== type) id += '-' + type;
    ex = exById(id); // same slug + same type (e.g. 'Pull-ups' vs 'pull ups') -> same lift
  }
  if (!ex) {
    ex = {
      id, day: null, bonus: true, name, type,
      loadLabel: type === 'bodyweight' ? 'body' : type === 'barbell' ? 'bar' : type === 'dumbbell' ? 'per DB' : 'total',
      sets: 3, repLow: 1, repHigh: 99,
      weight: type === 'bodyweight' ? 0 : null,
      increment: type === 'barbell' ? 5 : type === 'bodyweight' ? 0 : 2.5,
    };
    touchEx(ex, Object.keys(ex).filter(k => k !== 'id'));
    S.exercises.push(ex);
  }
  if (!S.active) { save(); return render(); }
  if (!S.active.entries[ex.id]) S.active.entries[ex.id] = { target: ex.weight, sets: [] };
  openLogger = null;
  touchActive(); save(); render();
  const card = [...view.querySelectorAll('.ex-card')].pop();
  if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
}

// ---- finish flow ------------------------------------------------
function finishFlow() {
  const a = S.active;
  const totalSets = Object.values(a.entries).reduce((n, e) => n + e.sets.length, 0);
  if (!totalSets) return confirmModal('Nothing logged', 'Log at least one set, or discard the workout.', null, true);
  endRest(false);
  const needsBodyCheck = a.day === 'push' || a.day === 'pull';
  if (needsBodyCheck) bodyCheckModal(() => progressionModal());
  else progressionModal();
}

function bodyCheckModal(next) {
  modal(`<h3>Neck &amp; shoulders check</h3>
    <div class="muted">Your program note: reassess as you go, especially on Push and Pull days.</div>
    <div class="check-row">
      <button class="effort-btn" data-bc="good">Felt good</button>
      <button class="effort-btn" data-bc="tight">Tight</button>
      <button class="effort-btn" data-bc="pain">Bothered me</button>
    </div>
    <textarea id="bcNote" rows="2" aria-label="Neck and shoulder note" placeholder="Optional — where, which exercise, how bad…"></textarea>
    <div class="btn-row" style="margin-top:14px"><button class="btn secondary" id="mBack">Back</button><button class="btn" id="bcNext">Continue</button></div>`, { dismissable: false });
  $('#mBack').onclick = closeModal;
  let choice = null;
  document.querySelectorAll('[data-bc]').forEach(b => b.onclick = () => {
    choice = b.dataset.bc;
    document.querySelectorAll('[data-bc]').forEach(x => x.className = 'effort-btn');
    b.className = 'effort-btn ' + (choice === 'good' ? 'sel-easy' : choice === 'tight' ? 'sel-solid' : 'sel-grind');
  });
  $('#bcNext').onclick = () => {
    if (!S.active) { closeModal(); return render(); }
    S.active.bodyCheck = choice;
    S.active.bodyNote = ($('#bcNote').value || '').trim();
    touchActive();
    closeModal(); next();
  };
}

function progressionModal() {
  const sugs = computeSuggestions(S.active);
  if (!sugs.length) return completeWorkout([]);
  let html = `<h3>Progression check</h3><div class="muted">Based on today plus your history:</div>`;
  sugs.forEach((sg, i) => {
    const ex = exById(sg.exId);
    const cls = sg.kind === 'down' ? 'down' : sg.kind === 'up' ? 'up' : 'info';
    html += `<div class="prog-banner ${cls}" data-sug="${i}">
      <b>${esc(ex.name)}</b><br>${sg.msg}
      <div class="prog-actions">
        <button class="btn-ghost" data-dec="${i}:skip">Not yet</button>
        <button class="btn-ghost primary" data-dec="${i}:apply">${sg.kind === 'down' ? 'Deload' : 'Apply'}</button>
      </div>
    </div>`;
  });
  html += `<div class="btn-row" style="margin-top:8px"><button class="btn secondary" id="mBack">Back</button><button class="btn" id="progDone">Save workout</button></div>`;
  modal(html, { dismissable: false });
  $('#mBack').onclick = closeModal;
  const decisions = {};
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const [i, act] = b.dataset.dec.split(':');
    decisions[i] = act;
    const banner = document.querySelector(`[data-sug="${i}"]`);
    banner.querySelectorAll('.prog-actions button').forEach(x => x.style.opacity = .35);
    b.style.opacity = 1;
  });
  $('#progDone').onclick = () => {
    if (!S.active) { closeModal(); return render(); }
    const applied = [];
    sugs.forEach((sg, i) => {
      const act = decisions[i] || (sg.kind === 'set' ? 'apply' : 'skip'); // TBD adoption defaults to apply
      if (act !== 'apply') { applied.push({ ...sg, applied: false }); return; }
      const ex = exById(sg.exId);
      if (!ex) return;
      if (sg.kind === 'time') { ex.repLow = sg.to; ex.repHigh = sg.to; touchEx(ex, ['repLow', 'repHigh']); }
      else { ex.weight = sg.to; touchEx(ex, ['weight']); }
      applied.push({ ...sg, applied: true });
      S.events.push({ id: uid(), updatedAt: Date.now(), date: S.active.date, exId: sg.exId, kind: sg.kind, from: sg.from, to: sg.to });
    });
    closeModal();
    completeWorkout(applied);
  };
}

function completeWorkout(sugResults) {
  const a = S.active;
  if (!a) { closeModal(); return render(); } // finished/discarded on another device meanwhile
  // A workout left open (e.g. overnight) shouldn't record a 900-minute session: if the last
  // logged set was 30+ min ago, end the clock there.
  const setTimes = Object.values(a.entries).flatMap(e => e.sets.map(x => x.t || 0));
  const lastSetAt = Math.max(0, ...setTimes);
  const endAt = lastSetAt && Date.now() - lastSetAt > 30 * 60000 ? lastSetAt : Date.now();
  a.minutes = Math.max(1, Math.round((endAt - a.startedAt) / 60000));
  a.suggestions = sugResults.map(s => ({ exId: s.exId, kind: s.kind, to: s.to, applied: s.applied }));
  // prune empty entries
  Object.keys(a.entries).forEach(k => { if (!a.entries[k].sets.length) delete a.entries[k]; });
  delete a.startedAt;
  delete a.restEndAt; delete a.restTotal;
  a.updatedAt = Date.now();
  S.sessions.push(a);
  S.active = null; openLogger = null; coachReportCache = null;
  touchActive();
  save(); render();
  toast('Workout saved — nice work.');
}

// ============================================================ progress tab
function renderProgress() {
  const logged = S.exercises.filter(e => exHistory(e.id).length);
  if (!S.sessions.length) {
    view.innerHTML = `<div class="hero"><h2>No workouts yet</h2>
      <div class="muted">Finish your first session and your charts start here.</div></div>`;
    return;
  }
  if (!progressEx || !logged.find(e => e.id === progressEx)) progressEx = (logged[0] || {}).id;

  let html = `<div class="ex-picker">` + logged.map(e =>
    `<button class="chip ${e.id === progressEx ? 'active' : ''}" data-pex="${esc(e.id)}">${esc(e.name)}</button>`).join('') + `</div>`;

  const ex = exById(progressEx);
  if (ex) {
    const hist = exHistory(ex.id);
    const isTimed = ex.type === 'timed';
    const byReps = isTimed || ex.type === 'bodyweight';
    const best = s => Math.max(...s.sets.map(x => byReps ? x.reps : x.weight));
    const bestEver = Math.max(...hist.map(best));
    const lastSets = hist[hist.length - 1].sets;
    const e1rm = byReps ? null : Math.max(...lastSets.map(x => x.weight * (1 + x.reps / 30)));
    const firstStat = ex.type === 'bodyweight'
      ? `<div class="stat"><div class="stat-val">${lastSets.reduce((n, x) => n + x.reps, 0)}</div><div class="stat-label">Last total reps</div></div>`
      : `<div class="stat"><div class="stat-val">${isTimed ? ex.repHigh + 's' : fmtW(ex.weight)}</div><div class="stat-label">${isTimed ? 'Target' : 'Working lb'}</div></div>`;
    html += `<div class="stat-row">
      ${firstStat}
      <div class="stat"><div class="stat-val">${fmtW(bestEver)}${isTimed ? 's' : ''}</div><div class="stat-label">Best ${isTimed ? 'hold' : byReps ? 'reps' : 'lifted'}</div></div>
      ${e1rm ? `<div class="stat"><div class="stat-val">${Math.round(e1rm)}</div><div class="stat-label">est. 1RM</div></div>` : ''}
      <div class="stat"><div class="stat-val">${hist.length}</div><div class="stat-label">Sessions</div></div>
    </div>
    <div class="chart-wrap card">${chartSVG(hist, byReps)}</div>`;
  }

  html += `<div class="section-title">History</div>`;
  [...S.sessions].reverse().forEach(s => {
    const nEx = Object.keys(s.entries).length;
    const nSets = Object.values(s.entries).reduce((n, e) => n + e.sets.length, 0);
    const open = expandedSession === s.id;
    html += `<div class="card hist-item">
      <button class="hist-head hist-toggle" data-sess="${esc(s.id)}" aria-expanded="${open}">
        <span><b>${esc(dayName(s.day))}</b> <span class="faint">· ${fmtDate(s.date)}</span></span>
        <span class="faint">${nEx} lifts · ${nSets} sets · ${s.minutes || '?'} min</span>
      </button>
      ${open ? histDetail(s) : ''}
    </div>`;
  });
  view.innerHTML = html;
  view.querySelectorAll('[data-pex]').forEach(b => b.onclick = () => { progressEx = b.dataset.pex; render(); });
  view.querySelectorAll('[data-sess]').forEach(el => el.onclick = () => {
    expandedSession = expandedSession === el.dataset.sess ? null : el.dataset.sess; render();
  });
  view.querySelectorAll('[data-delsess]').forEach(b => b.onclick = () => {
    const s = S.sessions.find(x => x.id === b.dataset.delsess); if (!s) return;
    confirmModal('Delete this workout?', `${dayName(s.day)} on ${fmtDate(s.date)} is removed from history, charts and the coach report. Weight changes you already applied stay as they are.`, () => {
      tombstone('sessions', s.id);
      expandedSession = null; coachReportCache = null;
      save(); render(); toast('Workout deleted.');
    });
  });
}

function histDetail(s) {
  let html = '<div class="hist-detail">';
  for (const exId of Object.keys(s.entries)) {
    const ex = exById(exId); if (!ex) continue;
    const e = s.entries[exId];
    const isTimed = ex.type === 'timed';
    const sets = e.sets.map(x => isTimed ? `${x.reps}s` : ex.type === 'bodyweight' ? `${x.reps}` : `${x.reps}×${fmtW(x.weight)}`).join(', ');
    const grinds = e.sets.filter(x => x.effort === 'grind').length;
    const notes = e.sets.filter(x => x.note).map(x => x.note).join(' · ');
    html += `<div><b style="color:var(--text)">${esc(ex.name)}</b> — ${sets}${grinds ? ` <span style="color:var(--red)">(${grinds} grind${grinds > 1 ? 's' : ''})</span>` : ''}${notes ? `<br><span class="faint">“${esc(notes)}”</span>` : ''}</div>`;
  }
  if (s.bodyCheck) html += `<div style="margin-top:6px">Neck/shoulders: <b style="color:${s.bodyCheck === 'good' ? 'var(--green)' : s.bodyCheck === 'tight' ? 'var(--blue)' : 'var(--red)'}">${s.bodyCheck}</b>${s.bodyNote ? ` — “${esc(s.bodyNote)}”` : ''}</div>`;
  html += `<div class="hist-actions"><button class="btn-ghost danger" data-delsess="${esc(s.id)}">Delete workout</button></div>`;
  return html + '</div>';
}

function chartSVG(hist, isTimed) {
  const W = 520, H = 190, P = { l: 38, r: 14, t: 16, b: 26 };
  const vals = hist.map(h => Math.max(...h.sets.map(x => isTimed ? x.reps : x.weight)));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.2, isTimed ? 10 : 5);
  const y0 = lo - pad, y1 = hi + pad;
  const X = i => hist.length === 1 ? W / 2 : P.l + (W - P.l - P.r) * i / (hist.length - 1);
  const Y = v => P.t + (H - P.t - P.b) * (1 - (v - y0) / (y1 - y0));
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const dots = vals.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="var(--accent)"/>`).join('');
  const first = hist[0].date ? fmtDate(hist[0].date) : '';
  const last = hist[hist.length - 1].date ? fmtDate(hist[hist.length - 1].date) : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="progress chart">
    <line x1="${P.l}" y1="${H - P.b}" x2="${W - P.r}" y2="${H - P.b}" stroke="var(--line)"/>
    <text x="${P.l - 6}" y="${Y(hi) + 4}" text-anchor="end" fill="var(--text-faint)" font-size="11">${fmtW(hi)}</text>
    <text x="${P.l - 6}" y="${Y(lo) + 4}" text-anchor="end" fill="var(--text-faint)" font-size="11">${fmtW(lo)}</text>
    ${vals.length > 1 ? `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>` : ''}
    ${dots}
    <text x="${P.l}" y="${H - 8}" fill="var(--text-faint)" font-size="11">${first}</text>
    <text x="${W - P.r}" y="${H - 8}" text-anchor="end" fill="var(--text-faint)" font-size="11">${last}</text>
  </svg>`;
}

// ============================================================ apple watch import
const WATCH_KIND_MAP = {
  basketball: 'Hoops', tennis: 'Tennis', pickleball: 'Tennis', paddle: 'Tennis',
  row: 'Row', run: 'Run', walk: 'Walk', hik: 'Walk',
};
function mapWatchKind(name) {
  const k = String(name || '').toLowerCase();
  for (const key of Object.keys(WATCH_KIND_MAP)) if (k.includes(key)) return WATCH_KIND_MAP[key];
  return 'Other';
}
function localDateOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Safari's Date parser rejects 'yyyy-MM-dd HH:mm:ss -0400' (Health Auto Export) and treats a
// bare 'yyyy-MM-dd' as UTC midnight (the previous day in Boston). Normalize before parsing.
function parseDateLoose(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return new Date(s);
  const [, y, mo, d, hh, mm, ss, tz] = m;
  if (hh == null) return new Date(+y, +mo - 1, +d, 12); // date only -> local noon
  const iso = `${y}-${mo}-${d}T${hh.padStart(2, '0')}:${mm}:${ss || '00'}`;
  if (!tz) return new Date(+y, +mo - 1, +d, +hh, +mm, +(ss || 0)); // no zone -> local time
  const zone = tz.toUpperCase() === 'Z' ? 'Z' : tz.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  return new Date(iso + zone);
}
function parseWatchDuration(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  // unit words, e.g. '1 hr 5 min', '45 min', '1h 5m 30s', '2 hours'
  const unit = re => { const m = s.match(re); return m ? parseFloat(m[1]) : 0; };
  // (?![a-z]) rather than \b so compact forms like '1h5m' still split: \b fails between 'h' and '5'
  if (/\d\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)(?![a-z])/.test(s)) {
    const h = unit(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?![a-z])/);
    const m = unit(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)(?![a-z])/);
    const sec = unit(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)(?![a-z])/);
    const total = Math.round(h * 60 + m + sec / 60);
    return total > 0 ? total : null;
  }
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    if (p.some(isNaN)) return null;
    return p.length === 3 ? p[0] * 60 + p[1] + Math.round(p[2] / 60) : p[0] + Math.round(p[1] / 60);
  }
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  if (isNaN(n) || n <= 0) return null;
  return n > 300 ? Math.round(n / 60) : Math.round(n); // >300 assume seconds
}
function numOnly(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}
function parseWatchFile(text) {
  const out = [];
  // 1) JSON — Health Auto Export shape, or any {workouts:[...]} / bare array
  try {
    const j = JSON.parse(text);
    const ws = (j && j.data && j.data.workouts) || (j && j.workouts) || (Array.isArray(j) ? j : null);
    if (ws && Array.isArray(ws)) {
      ws.forEach(w => {
        if (!w || typeof w !== 'object') return;
        const start = w.start || w.startDate || w.date;
        if (!start) return;
        const d = parseDateLoose(start);
        if (isNaN(d)) return;
        let mins = parseWatchDuration(w.duration);
        const end = w.end || w.endDate;
        if (!mins && end) { const e = parseDateLoose(end); if (!isNaN(e)) mins = Math.round((e - d) / 60000); }
        if (!mins || mins <= 0) return;
        out.push({
          date: localDateOf(d),
          rawKind: w.name || w.workoutActivityType || w.type || 'Other',
          minutes: mins,
          cal: numOnly(w.activeEnergyBurned && w.activeEnergyBurned.qty != null ? w.activeEnergyBurned.qty : (w.activeEnergy ?? w.calories)),
          hr: numOnly(w.heartRateData && w.heartRateData.average != null ? w.heartRateData.average : (w.avgHeartRate ?? w.heartRateAvg)),
        });
      });
      return out;
    }
  } catch (e) { /* not JSON — fall through to line format */ }
  // 2) line format from the Shortcut: datetime,type,duration,calories,avgHR
  text.split(/\r?\n/).forEach(line => {
    const parts = line.split(/[,|;\t]/).map(x => x.trim());
    if (parts.length < 3) return;
    const d = parseDateLoose(parts[0]);
    if (isNaN(d)) return;
    const mins = parseWatchDuration(parts[2]);
    if (!mins) return;
    out.push({ date: localDateOf(d), rawKind: parts[1], minutes: mins, cal: numOnly(parts[3]), hr: numOnly(parts[4]) });
  });
  return out;
}
function mergeWatchEntries(parsed) {
  const seen = new Set(S.cardio.filter(c => c.wkey).map(c => c.wkey));
  // entries deleted here (or on another device) stay deleted: their tombstone id matches
  const deleted = new Set((S.tombstones.cardio || []).map(t => t.id));
  let added = 0, skipped = 0;
  for (const p of parsed) {
    const kind = mapWatchKind(p.rawKind);
    const wkey = `${p.date}|${kind}|${p.minutes}`;
    const id = watchCardioId(wkey);
    // skip exact watch re-imports, and manual entries that look like the same workout
    const manualDupe = S.cardio.some(c => !c.wkey && c.date === p.date && c.kind === kind && Math.abs(c.minutes - p.minutes) <= 5);
    if (seen.has(wkey) || deleted.has(id) || manualDupe) { skipped++; continue; }
    seen.add(wkey);
    S.cardio.push({
      // deterministic stamp: two devices importing the same row produce identical records
      id, updatedAt: dateStamp(p.date),
      date: p.date, kind, minutes: p.minutes, distance: '',
      note: kind === 'Other' ? String(p.rawKind) : '',
      source: 'watch', hr: p.hr || null, cal: p.cal || null, wkey,
    });
    added++;
  }
  if (added) {
    S.cardio.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    coachReportCache = null;
    save();
  }
  return { added, skipped };
}

// ============================================================ cardio tab
function renderCardio() {
  const recent = [...S.cardio].reverse().slice(0, 30);
  const last14 = S.cardio.filter(c => daysAgo(c.date) < 14);
  const sports = last14.filter(c => c.kind === 'Hoops' || c.kind === 'Tennis');
  const engine = last14.filter(c => c.kind === 'Row' || c.kind === 'Run');
  let nudge;
  if (!last14.length) nudge = 'Nothing logged in two weeks — even 20 minutes of hoops counts. Log it!';
  else if (sports.length && !engine.length) nudge = `${sports.length} sport session${sports.length > 1 ? 's' : ''} in 2 weeks — love it. One easy 15-min row on a rest day would round out the engine work.`;
  else if (sports.length && engine.length) nudge = `Nice mix: ${sports.length} sport + ${engine.length} row/run in 2 weeks. Keep that balance.`;
  else nudge = `${engine.length} row/run session${engine.length > 1 ? 's' : ''} in 2 weeks. Sports count too — hoops and tennis are conditioning.`;

  let html = `<div class="hero"><h2>Cardio &amp; sports</h2><div class="muted">${esc(nudge)}</div></div>
  <div class="card cardio-form">
    <div class="kind-row" role="group" aria-label="Activity">${SEED_PROGRAM.cardioKinds.map(k =>
      `<button class="chip ${cardioKind === k ? 'active' : ''}" data-kind="${esc(k)}" aria-pressed="${cardioKind === k}">${esc(k)}</button>`).join('')}</div>
    <div class="form-row">
      <div><label for="cMin">Minutes</label><input type="number" id="cMin" inputmode="numeric" placeholder="30"></div>
      <div><label for="cDate">Date</label><input type="date" id="cDate" value="${todayISO()}" max="${todayISO()}"></div>
    </div>
    <label for="cDist">Distance (optional)</label>
    <input type="text" id="cDist" placeholder="e.g. 2 mi / 2000 m" style="margin-bottom:12px">
    <label for="cNote">Note (optional)</label>
    <textarea id="cNote" rows="2" placeholder="How it felt, who won…"></textarea>
    <div class="btn-row" style="margin-top:12px"><button class="btn" id="cSave">Log it</button></div>
  </div>
  <div class="card">
    <div class="hist-head">
      <div><b>Apple Watch</b><div class="faint" style="margin-top:2px">Pick the file your Sync Workouts shortcut saves (Files → Dropbox or iCloud Drive)</div></div>
      <button class="btn-ghost" id="watchImport">Import</button>
    </div>
    <input type="file" id="watchFile" accept=".csv,.txt,.json,text/csv,text/plain,application/json" class="hidden">
  </div>
  <div class="section-title">Recent</div>`;
  if (!recent.length) html += `<div class="card muted">No entries yet.</div>`;
  recent.forEach(c => {
    const meta = [`${esc(c.minutes)} min`];
    if (c.distance) meta.push(esc(c.distance));
    if (c.hr) meta.push(`${esc(c.hr)} bpm`);
    if (c.cal) meta.push(`${esc(c.cal)} cal`);
    html += `<div class="card cardio-item">
      <div class="hist-head"><div><b>${esc(c.kind)}</b> <span class="faint">· ${fmtDate(c.date)}</span>${c.source === 'watch' ? ' <span class="pill blue">watch</span>' : ''}</div>
      <div class="faint">${meta.join(' · ')}</div></div>
      ${c.note ? `<div class="faint" style="margin-top:4px">“${esc(c.note)}”</div>` : ''}
      <div class="hist-actions"><button class="btn-ghost" data-delcardio="${esc(c.id)}" aria-label="Delete ${esc(c.kind)} on ${esc(fmtDate(c.date))}">Delete</button></div>
    </div>`;
  });
  view.innerHTML = html;
  view.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    cardioKind = b.dataset.kind;
    view.querySelectorAll('[data-kind]').forEach(x => {
      x.classList.toggle('active', x.dataset.kind === cardioKind);
      x.setAttribute('aria-pressed', String(x.dataset.kind === cardioKind));
    });
  });
  view.querySelectorAll('[data-delcardio]').forEach(b => b.onclick = () => {
    const c = S.cardio.find(x => x.id === b.dataset.delcardio); if (!c) return;
    confirmModal('Delete this entry?', `${c.kind} · ${c.minutes} min on ${fmtDate(c.date)} is removed.`, () => {
      tombstone('cardio', c.id);
      coachReportCache = null;
      save(); render(); toast('Entry deleted.');
    });
  });
  $('#watchImport').onclick = () => $('#watchFile').click();
  $('#watchFile').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    ev.target.value = ''; // allow re-picking the same file
    const r = new FileReader();
    r.onload = () => {
      const parsed = parseWatchFile(String(r.result));
      if (!parsed.length) return toast('No workouts found in that file.');
      const { added, skipped } = mergeWatchEntries(parsed);
      render();
      toast(added ? `Imported ${added} workout${added > 1 ? 's' : ''}${skipped ? `, ${skipped} already logged` : ''}.` : 'All of those were already logged.');
    };
    r.readAsText(f);
  };
  $('#cSave').onclick = () => {
    const mins = parseInt($('#cMin').value, 10);
    if (!cardioKind) return toast('Pick an activity');
    if (!mins || mins <= 0) return toast('How many minutes?');
    const dv = $('#cDate').value;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dv) && dv <= todayISO() ? dv : todayISO();
    S.cardio.push({ id: uid(), updatedAt: Date.now(), date, kind: cardioKind, minutes: mins, distance: ($('#cDist').value || '').trim(), note: ($('#cNote').value || '').trim() });
    S.cardio.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0); // stable: same-day order kept
    cardioKind = null; coachReportCache = null;
    save(); render(); toast('Logged.');
  };
}

// ============================================================ coach tab
function coachReport() {
  if (coachReportCache && coachReportDay === todayISO()) return coachReportCache;
  const L = [];
  L.push(`# Lift Studio — Coach Report`);
  L.push(`Generated ${todayISO()} · ${S.sessions.length} workouts logged\n`);

  L.push(`## Current targets`);
  for (const d of S.days) {
    L.push(`\n### ${d.name}`);
    S.exercises.filter(e => e.day === d.id).forEach(e => {
      const w = e.weight == null ? 'TBD' : e.type === 'timed' ? `${e.repHigh}s target` : `${fmtW(e.weight)} lb (${e.loadLabel})`;
      const reps = e.type === 'timed' ? `${e.sets} holds` : `${e.sets}×${e.repLow}–${e.repHigh}`;
      L.push(`- ${e.name} — ${reps} @ ${w}`);
    });
  }

  const recent = S.sessions.slice(-6);
  if (recent.length) {
    L.push(`\n## Recent sessions`);
    recent.forEach(s => {
      L.push(`\n### ${s.date} — ${dayName(s.day)} (${s.minutes || '?'} min)`);
      for (const exId of Object.keys(s.entries)) {
        const ex = exById(exId); if (!ex) continue;
        const e = s.entries[exId];
        const isTimed = ex.type === 'timed';
        const sets = e.sets.map(x => isTimed ? `${x.reps}s` : ex.type === 'bodyweight' ? `${x.reps}` : `${x.reps}×${fmtW(x.weight)}`).join(', ');
        const efforts = e.sets.map(x => x.effort);
        const effTxt = efforts.every(x => x === efforts[0]) ? efforts[0] : efforts.join('/');
        const notes = e.sets.filter(x => x.note).map(x => `"${x.note}"`).join('; ');
        L.push(`- ${ex.name}: ${sets} (${effTxt})${notes ? ` — ${notes}` : ''}`);
      }
      if (s.bodyCheck) L.push(`- Neck/shoulders: ${s.bodyCheck}${s.bodyNote ? ` — "${s.bodyNote}"` : ''}`);
    });
  }

  const ev = S.events.slice(-12);
  if (ev.length) {
    L.push(`\n## Progression events`);
    ev.forEach(e => {
      const ex = exById(e.exId);
      const what = e.kind === 'up' ? `moved up ${fmtW(e.from)} → ${fmtW(e.to)} lb`
        : e.kind === 'down' ? `deloaded ${fmtW(e.from)} → ${fmtW(e.to)} lb`
        : e.kind === 'time' ? `hold target now ${e.to}s`
        : `working weight set at ${fmtW(e.to)} lb`;
      L.push(`- ${e.date}: ${ex ? ex.name : e.exId} ${what}`);
    });
  }

  const c14 = S.cardio.filter(c => daysAgo(c.date) < 14);
  L.push(`\n## Cardio & sports (last 14 days)`);
  if (!c14.length) L.push(`- none logged`);
  else {
    const byKind = {};
    c14.forEach(c => {
      const b = byKind[c.kind] = byKind[c.kind] || { n: 0, min: 0, hrs: [] };
      b.n++; b.min += c.minutes; if (c.hr) b.hrs.push(c.hr);
    });
    Object.keys(byKind).forEach(k => {
      const b = byKind[k];
      const hr = b.hrs.length ? `, avg HR ${Math.round(b.hrs.reduce((a, x) => a + x, 0) / b.hrs.length)}` : '';
      L.push(`- ${k}: ${b.n}× (${b.min} min total${hr})`);
    });
  }

  // flags
  const flags = [];
  S.exercises.forEach(ex => {
    if (ex.type === 'timed' || ex.weight == null) return;
    const hist = exHistory(ex.id);
    const { missStreak } = streaks(ex, hist);
    if (missStreak >= 2) flags.push(`${ex.name} has stalled ${missStreak} sessions at ${fmtW(ex.weight)} lb`);
    const last = hist[hist.length - 1];
    if (last && last.sets.filter(x => x.effort === 'grind').length >= 2) flags.push(`${ex.name}: multiple grind sets last session`);
  });
  S.sessions.slice(-4).forEach(s => {
    if (s.bodyCheck === 'pain') flags.push(`${s.date} (${dayName(s.day)}): neck/shoulders bothered TJ${s.bodyNote ? ` — "${s.bodyNote}"` : ''}`);
  });
  L.push(`\n## Flags for coaching`);
  L.push(flags.length ? flags.map(f => `- ${f}`).join('\n') : `- nothing flagged`);

  coachReportCache = L.join('\n'); coachReportDay = todayISO();
  return coachReportCache;
}

function renderCoach() {
  const report = coachReport();
  const synced = !!(sync && sync.signedIn());
  let html = `<div class="hero"><h2>Coach hand-off</h2>
    <div class="muted">Copy the report below and paste it to Claude for a coaching review. ${synced
      ? 'Your log syncs to Dropbox automatically.'
      : sync ? 'Data lives only on this device until you connect Dropbox sync below.'
      : 'Data lives only on this device — use Export JSON below to back it up.'}</div></div>
  <div class="btn-row" style="margin-bottom:12px">
    <button class="btn" id="copyReport">Copy coach report</button>
  </div>
  <div class="coach-pre">${esc(report)}</div>

  <div class="section-title">Sync</div>
  <div class="card sync-card" id="syncCard">${syncCardHTML()}</div>

  <div class="section-title">Settings</div>
  <div class="card">
    <div class="settings-row"><div><div class="s-label">Bar weight</div></div>
      <input id="setBar" type="number" inputmode="decimal" aria-label="Bar weight" value="${S.settings.barWeight}"></div>
    <div class="settings-row"><div><div class="s-label">Plate pairs</div><div class="s-sub">comma-separated, one entry per pair you own</div></div>
      <input id="setPlates" type="text" aria-label="Plate pairs" value="${S.settings.platePairs.join(', ')}"></div>
    <div class="settings-row"><div><div class="s-label">Rest — isolation</div><div class="s-sub">seconds</div></div>
      <input id="setRest" type="number" inputmode="numeric" aria-label="Rest for isolation, seconds" value="${S.settings.restDefault}"></div>
    <div class="settings-row"><div><div class="s-label">Rest — barbell compounds</div><div class="s-sub">seconds</div></div>
      <input id="setRestC" type="number" inputmode="numeric" aria-label="Rest for barbell compounds, seconds" value="${S.settings.restCompound}"></div>
  </div>
  <div class="btn-row" style="margin-bottom:20px"><button class="btn secondary" id="saveSettings">Save settings</button></div>

  <div class="section-title">Manual backup</div>
  <div class="card backup-card">
    <div class="faint" style="margin-bottom:10px">${synced ? 'Not needed with sync on — a JSON file is still handy as an extra copy.' : backupAgeText()}</div>
    <div class="btn-row">
      <button class="btn-ghost" id="exportJson">Export JSON</button>
      <button class="btn-ghost" id="importJson">Import JSON</button>
    </div>
    ${hasPreImportBackup() && !synced ? `<button class="btn-ghost" id="undoImport" style="margin-top:10px;width:100%">Undo last import</button>` : ''}
    <input type="file" id="importFile" accept=".json,application/json" class="hidden">
  </div>
  <button class="btn danger" id="resetAll">Reset all data</button>`;
  view.innerHTML = html;
  wireSyncCard();

  $('#copyReport').onclick = async () => {
    try { await navigator.clipboard.writeText(report); toast('Report copied — paste it to Claude.'); }
    catch (e) { toast('Copy failed — select the text manually.'); }
  };
  $('#exportJson').onclick = async () => {
    const ok = await downloadFile(`lift-studio-${todayISO()}.json`, JSON.stringify(S, null, 2));
    if (ok) { S.lastExportAt = Date.now(); save(); render(); }
  };
  $('#importJson').onclick = () => $('#importFile').click();
  $('#importFile').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    ev.target.value = ''; // allow picking the same file again
    const r = new FileReader();
    r.onload = () => {
      let data;
      try {
        data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.exercises) || !Array.isArray(data.sessions)) throw new Error('bad file');
        data = normalize(data);
      } catch (e) { return toast('That file did not look like a Lift Studio backup.'); }
      const here = loadProblem ? 'unreadable data' : `${S.sessions.length} workouts and ${S.cardio.length} cardio entries${S.active ? ' plus the workout in progress' : ''}`;
      if (sync && sync.signedIn() && !loadProblem) {
        // With sync on, "replace" would be undone by the next sync anyway: merge instead.
        return confirmModal('Merge this backup?',
          `This device has ${here}. The file has ${data.sessions.length} workouts and ${data.cardio.length} cardio entries. They're combined (nothing here is removed) and the result syncs to your other devices.`,
          () => {
            try { localStorage.setItem(LS_KEY + '.backup-pre-import', JSON.stringify(S)); } catch (e) {}
            applyMerged(LiftMerge.mergeStates(S, data, { seed: SEED_PROGRAM }), true);
            toast('Backup merged.');
          });
      }
      confirmModal('Replace all data?',
        `This device has ${here}. The file has ${data.sessions.length} workouts and ${data.cardio.length} cardio entries. Everything here is replaced; you can undo once from this screen.`,
        () => {
          if (!loadProblem) { try { localStorage.setItem(LS_KEY + '.backup-pre-import', JSON.stringify(S)); } catch (e) {} }
          endRest(false);
          S = data; loadProblem = null; openLogger = null; coachReportCache = null;
          save(); render(); toast('Imported.');
        });
    };
    r.readAsText(f);
  };
  const undo = $('#undoImport');
  if (undo) undo.onclick = () => confirmModal('Undo last import?', 'Restores the data this device had right before the last import. Anything logged since the import is lost.', () => {
    try {
      S = normalize(JSON.parse(localStorage.getItem(LS_KEY + '.backup-pre-import')));
      localStorage.removeItem(LS_KEY + '.backup-pre-import');
    } catch (e) { return toast('No usable backup found.'); }
    endRest(false); openLogger = null; coachReportCache = null; save(); render(); toast('Import undone.');
  });
  $('#saveSettings').onclick = () => {
    const before = { ...S.settings };
    S.settings.barWeight = parseFloat($('#setBar').value) || 45;
    const plates = $('#setPlates').value.split(',').map(x => parseFloat(x.trim())).filter(x => x > 0);
    if (plates.length) S.settings.platePairs = plates;
    S.settings.restDefault = parseInt($('#setRest').value, 10) || 90;
    S.settings.restCompound = parseInt($('#setRestC').value, 10) || 150;
    // stamp only the fields that changed, so a setting changed on another device survives
    const now = Date.now();
    Object.keys(S.settings).forEach(k => {
      if (JSON.stringify(before[k]) !== JSON.stringify(S.settings[k])) S.settingsTs[k] = now;
    });
    save(); toast('Settings saved.');
  };
  $('#resetAll').onclick = () => {
    if (sync && sync.signedIn()) {
      return confirmModal('Reset everywhere?', 'Sync is on, so this wipes all workouts, cardio and settings here, in Dropbox and on your other devices. Export a JSON backup first if unsure.',
        () => { endRest(false); S = wipedState(); loadProblem = null; openLogger = null; coachReportCache = null; save(); render(); toast('Fresh start.'); });
    }
    confirmModal('Reset everything?', 'All workouts, cardio, and settings are wiped. Export a JSON backup first if unsure.',
      () => { endRest(false); S = freshState(); loadProblem = null; openLogger = null; coachReportCache = null; save(); render(); toast('Fresh start.'); });
  };
}

// A fresh state that *wins* a sync merge: every record becomes a tombstone and every
// setting/target is re-stamped, so the reset reaches the other devices.
function wipedState() {
  const now = Date.now();
  const f = normalize(freshState());
  ['sessions', 'cardio', 'events'].forEach(k => {
    const ids = new Set([...S[k].map(r => r.id), ...(S.tombstones[k] || []).map(t => t.id)]);
    f.tombstones[k] = [...ids].map(id => ({ id, deleted: true, updatedAt: now }));
  });
  Object.keys(f.settings).forEach(k => { f.settingsTs[k] = now; });
  f.exercises.forEach(ex => touchEx(ex, Object.keys(ex).filter(k => k !== 'id' && k !== 'fieldTs' && k !== 'updatedAt')));
  f.activeUpdatedAt = now;
  return f;
}

// ============================================================ dropbox sync (ui)
const isStandalone = () => window.navigator.standalone === true ||
  !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
// Code-flow authorize URL, prepared ahead of time so "use a code" can be a real link:
// iOS blocks window.open() that happens after an await.
let codeUrl = null;
function prepareCodeUrl() {
  if (!sync || sync.signedIn() || codeUrl) return;
  sync.authUrl('code').then(u => { codeUrl = u; paintSync(); }).catch(() => {});
}

function agoText(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const SYNC_LABEL = {
  unconfigured: 'Sync not configured yet', signedout: 'Not connected', reauth: 'Dropbox sign-in expired',
  idle: 'Connected', syncing: 'Syncing…', synced: 'Synced', offline: 'Offline — will retry', error: 'Sync problem',
};
function syncCardHTML() {
  if (!sync) {
    return `<div class="sync-line"><span class="sync-dot-inline s-unconfigured" aria-hidden="true"></span><b>Sync not configured yet</b></div>
      <div class="faint">Dropbox sync switches on once the app key is added to <code>config.js</code>. Until then, use the manual backup below.</div>`;
  }
  const st = sync.getStatus();
  const codeLink = (cls, id, text) =>
    `<a class="${cls}" id="${id}" data-codelink href="${esc(codeUrl || '#')}" target="_blank" rel="noopener">${text}</a>`;
  if (!st.signedIn) {
    const expired = st.state === 'reauth';
    let body;
    if (st.pendingCode) {
      body = `<label for="dbxCode" class="sync-code-label">Paste the code from Dropbox</label>
        <input type="text" id="dbxCode" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Code from the Dropbox page">
        <div class="btn-row" style="margin-top:10px">
          <button class="btn-ghost" id="dbxCodeCancel">Cancel</button>
          <button class="btn" id="dbxCodeSubmit" style="flex:2">Connect</button>
        </div>
        ${codeLink('link-btn', 'dbxCodeAgain', 'Open Dropbox again for a new code')}`;
    } else if (isStandalone()) {
      // home-screen app: a redirect would come back in Safari, not here — code flow it is
      body = `${codeLink('btn', 'dbxCodeOpen', expired ? 'Reconnect Dropbox' : 'Connect Dropbox')}
        <div class="faint sync-hint">Dropbox opens, you allow access, then copy the code it shows back into this app.</div>`;
    } else {
      body = `<button class="btn" id="dbxConnect">${expired ? 'Reconnect Dropbox' : 'Connect Dropbox'}</button>
        ${codeLink('link-btn', 'dbxUseCode', 'Having trouble? Use a code instead')}`;
    }
    return `<div class="sync-line"><span class="sync-dot-inline s-${expired ? 'error' : 'signedout'}" aria-hidden="true"></span><b>${expired ? 'Dropbox sign-in expired' : 'Dropbox sync is off'}</b></div>
      <div class="faint" style="margin-bottom:12px">Connect once on each device (phone, PC…) and your log stays in step automatically. What's already on this device is kept and merged — nothing is overwritten.</div>
      ${body}`;
  }
  const label = SYNC_LABEL[st.state] || 'Connected';
  const err = st.state === 'error' && st.lastError ? `<div class="sync-err">${esc(st.lastError)}</div>` : '';
  return `<div class="sync-line"><span class="sync-dot-inline s-${esc(st.state)}" aria-hidden="true"></span><b>${label}</b>
      <span class="faint sync-when">Last synced: ${agoText(st.lastSyncedAt)}</span></div>
    ${err}
    <div class="faint sync-path">Dropbox: ${esc((st.pathMode === 'root' ? DROPBOX_TEAM_PREFIX : '') + DROPBOX_DATA_PATH)}</div>
    <div class="faint sync-path">Apple Watch workouts import automatically from ${esc(DROPBOX_WATCH_PATH.split('/').pop())}.</div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn-ghost" id="dbxSignOut">Sign out</button>
      <button class="btn secondary" id="dbxSyncNow" style="flex:2" ${st.state === 'syncing' ? 'disabled' : ''}>${st.state === 'syncing' ? 'Syncing…' : 'Sync now'}</button>
    </div>`;
}
function wireSyncCard() {
  if (!sync) return;
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  view.querySelectorAll('[data-codelink]').forEach(a => a.onclick = ev => {
    if (!codeUrl) { ev.preventDefault(); prepareCodeUrl(); return toast('One moment — try again.'); }
    // let the link open Dropbox in a new tab/Safari, then show the paste box here
    setTimeout(() => { sync.markCodeOpened(); const box = $('#dbxCode'); if (box) box.focus(); }, 0);
  });
  on('dbxConnect', async () => {
    try { await sync.beginRedirect(); } catch (e) { toast(e.message); }
  });
  on('dbxCodeCancel', () => { sync.cancelCode(); codeUrl = null; prepareCodeUrl(); paintSync(); });
  on('dbxCodeSubmit', async () => {
    const code = ($('#dbxCode').value || '').trim();
    if (!code) return toast('Paste the code from Dropbox first.');
    const btn = $('#dbxCodeSubmit'); btn.disabled = true; btn.textContent = 'Connecting…';
    try { $('#dbxCode').blur(); } catch (e) {}
    try {
      const pending = sync.completeCode(code);
      await pending; codeUrl = null;
      paintSync(); toast('Dropbox connected.');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Connect';
      toast(e.kind === 'network' ? 'No connection — try again.' : 'That code didn\'t work — open Dropbox again for a new one.');
    }
  });
  on('dbxSyncNow', () => sync.syncNow('manual'));
  on('dbxSignOut', () => confirmModal('Sign out of Dropbox?', 'Sync stops on this device. Everything logged here stays here, and your Dropbox copy is untouched.', async () => {
    await sync.signOut(); codeUrl = null; prepareCodeUrl(); render(); toast('Signed out of Dropbox.');
  }));
}
// Repaint the header dot and (if visible) the sync card — never the whole view.
function paintSync() {
  const dot = $('#syncDot');
  if (dot) {
    const st = sync ? sync.getStatus() : { state: 'unconfigured' };
    dot.classList.toggle('hidden', !sync);
    [...dot.classList].filter(c => c.indexOf('s-') === 0).forEach(c => dot.classList.remove(c));
    dot.classList.add('s-' + st.state);
    const label = SYNC_LABEL[st.state] || 'Sync';
    dot.setAttribute('aria-label', `Sync: ${label}. Open sync settings.`);
    dot.title = st.lastSyncedAt ? `${label} · last synced ${agoText(st.lastSyncedAt)}` : label;
  }
  const card = $('#syncCard');
  if (card) {
    // don't wipe a half-typed code
    const stillPasting = sync && !sync.signedIn() && sync.getStatus().pendingCode;
    const typing = stillPasting && document.activeElement && document.activeElement.id === 'dbxCode';
    if (!typing) {
      const box = $('#dbxCode'), kept = box ? box.value : '';
      card.innerHTML = syncCardHTML(); wireSyncCard();
      const nb = $('#dbxCode'); if (nb && kept) nb.value = kept;
    }
  }
}

// Adopt a merged state (from Dropbox or a merged backup import) and repaint carefully.
let renderDeferred = false;
function applyMerged(merged, fromImport) {
  S = merged;
  coachReportCache = null;
  applyingRemote = !fromImport;
  try { save(); } finally { applyingRemote = false; }
  if (!S.active) { openLogger = null; if (rest.endAt) endRest(false); }
  else if (openLogger && !S.active.entries[openLogger.exId]) openLogger = null;
  // re-rendering would wipe a field TJ is typing in: wait until he leaves it
  const a = document.activeElement;
  if (a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
    if (!renderDeferred) {
      renderDeferred = true;
      view.addEventListener('focusout', function once() {
        view.removeEventListener('focusout', once);
        setTimeout(() => { renderDeferred = false; render(); }, 0);
      });
    }
  } else render();
}

function initSync() {
  if (typeof DROPBOX_APP_KEY === 'undefined' || !DROPBOX_APP_KEY) { paintSync(); return; }
  sync = LiftDropbox.create({
    appKey: DROPBOX_APP_KEY,
    storageKey: LS_KEY.replace(/\.v1$/, '') + '.dropbox',
    dataPath: DROPBOX_DATA_PATH,
    watchPath: DROPBOX_WATCH_PATH,
    checkFolder: DROPBOX_CHECK_FOLDER,
    teamPrefix: DROPBOX_TEAM_PREFIX,
    getState: () => S,
    applyState: merged => applyMerged(merged, false),
    normalize,
    merge: (a, b) => LiftMerge.mergeStates(a, b, { seed: SEED_PROGRAM }),
    canSync: () => !loadProblem && !saveFailed,
    isBusy: () => !!(modalOpts && !modalOpts.dismissable), // finish-workout sheets
    importWatch: text => {
      const parsed = parseWatchFile(String(text || ''));
      if (!parsed.length) return 0;
      const { added } = mergeWatchEntries(parsed);
      if (added) { render(); toast(`Imported ${added} Apple Watch workout${added > 1 ? 's' : ''}.`); }
      return added;
    },
    onStatus: paintSync,
    // redirect flow: plain navigation (the code flow uses a real link, see prepareCodeUrl)
    openUrl: url => { location.assign(url); },
  });
  paintSync();
  prepareCodeUrl();
  sync.attach(window, document);
  sync.handleRedirect(location.href).then(r => {
    if (r.handled) {
      try { history.replaceState(null, '', r.cleanUrl); } catch (e) {}
      if (r.ok) { toast('Dropbox connected.'); tab = 'coach'; render(); }
      else if (r.message) toast(r.message);
    }
    return sync.syncNow(r.handled ? 'signin' : 'load');
  });
}


// ============================================================ modal helpers
// opts.dismissable=false: backdrop taps and Escape are ignored (finish-flow sheets, where a
// stray tap would otherwise silently cancel saving the workout).
let modalOpts = null;
let modalReturnFocus = null;
function modal(inner, opts = {}) {
  modalOpts = { dismissable: true, ...opts };
  if (!$('#modalRoot').innerHTML) modalReturnFocus = document.activeElement;
  $('#modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" tabindex="-1">${inner}</div></div>`;
  const m = $('#modalRoot .modal');
  const h = m.querySelector('h3');
  if (h) { h.id = 'mTitle'; m.setAttribute('aria-labelledby', 'mTitle'); }
  $('#modalRoot .modal-backdrop').addEventListener('click', ev => {
    if (ev.target.classList.contains('modal-backdrop') && modalOpts.dismissable) closeModal();
  });
  document.body.style.overflow = 'hidden';
  const first = m.querySelector('button, input, textarea');
  try { (first || m).focus({ preventScroll: true }); } catch (e) {}
}
function closeModal() {
  $('#modalRoot').innerHTML = '';
  document.body.style.overflow = '';
  modalOpts = null;
  if (modalReturnFocus && document.contains(modalReturnFocus)) { try { modalReturnFocus.focus({ preventScroll: true }); } catch (e) {} }
  modalReturnFocus = null;
}
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && modalOpts && modalOpts.dismissable) closeModal();
});
function confirmModal(title, body, onYes, okOnly) {
  modal(`<h3>${esc(title)}</h3><div class="muted">${esc(body)}</div>
    <div class="btn-row" style="margin-top:14px">
      ${okOnly ? `<button class="btn" id="mOk">OK</button>`
      : `<button class="btn secondary" id="mNo">Cancel</button><button class="btn danger" id="mYes">Yes, do it</button>`}
    </div>`);
  if (okOnly) { $('#mOk').onclick = closeModal; return; }
  $('#mNo').onclick = closeModal;
  $('#mYes').onclick = () => { closeModal(); onYes && onYes(); };
}

// ============================================================ shell
function render() {
  $('#topbarDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    b.classList.toggle('live', b.dataset.tab === 'workout' && !!S.active);
  });
  if (tab === 'workout') renderWorkout();
  else if (tab === 'progress') renderProgress();
  else if (tab === 'cardio') renderCardio();
  else renderCoach();
  renderBanner();
  paintSync();
}

// Data-safety banners pinned to the top of every tab.
function renderBanner() {
  let html = '';
  if (loadProblem) {
    html = `<div class="banner danger" role="alert"><b>Your saved data couldn't be read.</b>
      Nothing has been overwritten, and saving is paused so it stays that way. Export the raw data and send it to Claude to repair, or import a backup.
      <div class="btn-row" style="margin-top:10px">
        <button class="btn secondary" id="bnExportRaw">Export raw</button>
        <button class="btn danger" id="bnFresh">Start fresh</button>
      </div></div>`;
  } else if (saveFailed) {
    html = `<div class="banner danger" role="alert"><b>Couldn't save to this device.</b>
      Storage is full or blocked (private browsing?). New sets only live in memory — export a backup from the Coach tab now.</div>`;
  }
  if (!html) return;
  view.insertAdjacentHTML('afterbegin', html);
  const ex = $('#bnExportRaw');
  if (ex) ex.onclick = () => downloadFile(`lift-studio-raw-${todayISO()}.json`, loadProblem.raw);
  const fr = $('#bnFresh');
  if (fr) fr.onclick = () => confirmModal('Start fresh?',
    'The unreadable data stays stored under a separate backup key on this device, but the app will start empty. Export raw first if unsure.',
    () => { loadProblem = null; S = freshState(); coachReportCache = null; save(); render(); });
}

// Save a text file: share sheet in the iOS home-screen app, <a download> elsewhere.
async function downloadFile(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  // Home-screen (standalone) iOS apps handle <a download> poorly — use the share sheet
  // ("Save to Files", AirDrop, Mail…) when available.
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (standalone && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Lift Studio backup' });
      return true;
    }
  } catch (e) { if (e && e.name === 'AbortError') return false; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); // Safari needs the URL alive after click
  return true;
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; openLogger = null; render(); });
render();
// resume a rest timer that was running before a reload / iOS page eviction
if (S.active && S.active.restEndAt) {
  if (S.active.restEndAt > Date.now()) runRest(S.active.restEndAt, S.active.restTotal || 90);
  else { delete S.active.restEndAt; delete S.active.restTotal; save(); }
}
// header sync dot -> sync card on the Coach tab
$('#syncDot').onclick = () => {
  tab = 'coach'; openLogger = null; render();
  const card = $('#syncCard');
  if (card) card.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
};
initSync();
