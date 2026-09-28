/* Lift Studio — vanilla JS, localStorage, no dependencies */
'use strict';

// ============================================================ state
const LS_KEY = 'liftstudio.v1';

function freshState() {
  return {
    settings: { ...SEED_PROGRAM.settings },
    exercises: SEED_PROGRAM.exercises.map(e => ({ ...e })),
    days: SEED_PROGRAM.days.map(d => ({ ...d })),
    sessions: [],   // completed workouts
    cardio: [],     // cardio/sport entries
    events: [],     // progression events (for coach report)
    active: null,   // in-flight workout
  };
}

let S = load();
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return freshState();
    const st = JSON.parse(raw);
    // merge any new seed exercises/settings keys (forward compat)
    const have = new Set(st.exercises.map(e => e.id));
    SEED_PROGRAM.exercises.forEach(e => { if (!have.has(e.id)) st.exercises.push({ ...e }); });
    st.settings = { ...SEED_PROGRAM.settings, ...st.settings };
    st.events = st.events || [];
    return st;
  } catch (e) { return freshState(); }
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }

// ============================================================ ui state (transient)
let tab = 'workout';
let openLogger = null;        // {exId, setIdx, reps, weight, effort, note, showNote}
let progressEx = null;        // selected exercise id on progress tab
let expandedSession = null;   // session id expanded in history
let cardioKind = null;
let coachReportCache = null;

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

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
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
function loadableRound(ex, w) {
  // round a weight to something actually loadable / sensible
  if (ex.loadLabel === 'bar') return Math.round(w / 5) * 5;          // 2.5 pair -> 5lb bar steps
  return Math.round(w / 2.5) * 2.5;
}

// ---- progression ------------------------------------------------
function exHistory(exId) {
  // completed sessions containing this exercise, oldest -> newest
  return S.sessions
    .filter(s => s.entries[exId] && s.entries[exId].sets.length)
    .map(s => ({ date: s.date, sessionId: s.id, target: s.entries[exId].target, sets: s.entries[exId].sets }));
}
function resultOf(ex, sets) {
  // 'top' = every set at/above repHigh; 'miss' = any set below repLow; else 'work'
  if (!sets.length) return 'none';
  if (sets.every(st => st.reps >= ex.repHigh)) return 'top';
  if (sets.some(st => st.reps < ex.repLow)) return 'miss';
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

    const hist = [...exHistory(exId), { target: entry.target, sets: entry.sets }];
    const res = h => resultOf(ex, h.sets);

    if (ex.type === 'timed') {
      const streak = countStreak(hist, h => h.sets.every(st => st.reps >= ex.repHigh));
      if (streak >= S.settings.progressAfter) {
        out.push({ exId, kind: 'time', from: ex.repHigh, to: ex.repHigh + 15, msg: `${streak} straight sessions holding ${ex.repHigh}s — bump the target to <b>${ex.repHigh + 15}s</b>?` });
      }
      continue;
    }

    // streaks only count sessions at the current target weight
    const atW = hist.filter(h => h.target === ex.weight);
    const topStreak = countStreak(atW, h => res(h) === 'top');
    const missStreak = countStreak(atW, h => res(h) === 'miss');

    if (topStreak >= S.settings.progressAfter) {
      const to = loadableRound(ex, ex.weight + ex.increment);
      out.push({ exId, kind: 'up', from: ex.weight, to, msg: `<b>${topStreak} straight sessions</b> at the top of the range. Move up: <b>${fmtW(ex.weight)} → ${fmtW(to)} lb</b>, aim for ${ex.repLow} reps.` });
    } else if (missStreak >= S.settings.deloadAfter) {
      const to = loadableRound(ex, ex.weight * (1 - S.settings.deloadPct));
      out.push({ exId, kind: 'down', from: ex.weight, to, msg: `<b>${missStreak} sessions stalled</b> at ${fmtW(ex.weight)} lb. Deload ~10%: <b>${fmtW(to)} lb</b>, build back up.` });
    }
  }
  return out;
}
function countStreak(arr, pred) {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i])) n++; else break; }
  return n;
}

// ============================================================ rest timer
let rest = { left: 0, total: 0, iv: null };
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
  clearInterval(rest.iv);
  rest.left = seconds; rest.total = seconds;
  $('#restBar').classList.remove('hidden');
  paintRest();
  rest.iv = setInterval(() => {
    rest.left--;
    if (rest.left <= 0) { endRest(true); } else paintRest();
  }, 1000);
}
function paintRest() {
  const m = Math.floor(rest.left / 60), s = rest.left % 60;
  $('#restTime').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('#restFill').style.width = (rest.left / rest.total * 100) + '%';
}
function endRest(ding) {
  clearInterval(rest.iv); rest.iv = null;
  $('#restBar').classList.add('hidden');
  if (ding) {
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
$('#restPlus').onclick = () => { rest.left += 30; rest.total += 30; paintRest(); };
$('#restSkip').onclick = () => endRest(false);

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
    <div class="muted">Weekly split — <b style="color:var(--accent)">${dayName(sug)}</b> is up next in the rotation.</div>
  </div>
  <div class="section-title">Pick your day</div>`;
  for (const d of S.days) {
    const last = lastDone(d.id);
    const exs = S.exercises.filter(e => e.day === d.id);
    html += `<div class="card day-card ${d.id === sug ? 'suggested' : ''}" data-start="${d.id}">
      <div>
        <h3>${esc(d.name)} ${d.id === sug ? '<span class="pill amber">UP NEXT</span>' : ''}</h3>
        <div class="day-meta">${exs.length} exercises · ${last ? 'last: ' + fmtDate(last) + ` (${daysAgo(last)}d ago)` : 'not logged yet'}</div>
      </div>
      <div class="day-arrow">›</div>
    </div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-start]').forEach(el => el.onclick = () => startWorkout(el.dataset.start));
}

function startWorkout(dayId) {
  S.active = { id: uid(), day: dayId, date: todayISO(), startedAt: Date.now(), entries: {} };
  S.exercises.filter(e => e.day === dayId).forEach(e => {
    S.active.entries[e.id] = { target: e.weight, sets: [] };
  });
  openLogger = null;
  save(); render();
}

function renderActive() {
  const a = S.active;
  const exs = S.exercises.filter(e => e.day === a.day || a.entries[e.id]);
  const mins = Math.floor((Date.now() - a.startedAt) / 60000);
  let html = `<div class="workout-head">
    <h2>${esc(dayName(a.day))}</h2>
    <span class="pill gray">${mins} min</span>
  </div>`;
  for (const ex of exs) {
    const entry = a.entries[ex.id];
    const target = entry.target;
    const done = entry.sets;
    const isTimed = ex.type === 'timed';
    const isBody = ex.type === 'bodyweight';
    const targetTxt = isTimed ? `${ex.sets}×${ex.repHigh}s`
      : isBody ? `${ex.sets}× max reps`
      : `${target == null ? 'set weight' : fmtW(target) + ' lb'} · ${ex.sets}×${ex.repLow}–${ex.repHigh}`;
    const plates = target != null ? plateText(ex, target) : '';

    let dots = '';
    for (let i = 0; i < Math.max(ex.sets, done.length); i++) {
      const st = done[i];
      if (st) {
        dots += `<button class="set-dot done e-${st.effort}" data-log="${ex.id}:${i}">
          ${isTimed ? st.reps + 's' : st.reps}<small>${isTimed || isBody ? '' : fmtW(st.weight)}</small></button>`;
      } else {
        const isNext = i === done.length;
        dots += `<button class="set-dot ${isNext ? 'next' : ''}" data-log="${ex.id}:${i}">${isNext ? 'LOG' : i + 1}</button>`;
      }
    }

    html += `<div class="card ex-card">
      <div class="ex-head" data-log="${ex.id}:${done.length < ex.sets ? done.length : done.length}">
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

  view.querySelectorAll('[data-log]').forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    const [exId, idx] = el.dataset.log.split(':');
    openSetLogger(exId, +idx);
  });
  wireLogger();
  $('#finishWo') && ($('#finishWo').onclick = finishFlow);
  $('#cancelWo') && ($('#cancelWo').onclick = () => confirmModal(
    'Discard this workout?', 'Logged sets from this session will be lost.',
    () => { S.active = null; openLogger = null; endRest(false); save(); render(); }));
}

function openSetLogger(exId, setIdx) {
  const ex = exById(exId);
  const entry = S.active.entries[exId];
  if (openLogger && openLogger.exId === exId && openLogger.setIdx === setIdx) { openLogger = null; render(); return; }
  const existing = entry.sets[setIdx];
  const prevSet = entry.sets[setIdx - 1] || entry.sets[entry.sets.length - 1];
  const isTimed = ex.type === 'timed';
  const defaultW = ex.type === 'barbell' ? 95 : ex.type === 'dumbbell' ? 15 : 30;
  openLogger = existing ? { exId, setIdx, ...existing, showNote: !!existing.note }
    : {
      exId, setIdx,
      reps: isTimed ? ex.repHigh : (prevSet ? prevSet.reps : (ex.repHigh > 30 ? 10 : ex.repHigh)),
      weight: isTimed || ex.type === 'bodyweight' ? 0 : (prevSet ? prevSet.weight : (entry.target != null ? entry.target : defaultW)),
      effort: 'solid', note: '', showNote: false,
    };
  render();
  const card = view.querySelector(`.logger`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function loggerHTML(ex) {
  const L = openLogger;
  const isTimed = ex.type === 'timed';
  const noWeight = isTimed || ex.type === 'bodyweight';
  return `<div class="logger">
    <div class="logger-row">
      <div class="stepper">
        <button data-step="reps:-1">−</button>
        <div class="stepper-val">${L.reps}<small>${isTimed ? 'SEC' : 'REPS'}</small></div>
        <button data-step="reps:1">+</button>
      </div>
      ${noWeight ? '' : `<div class="stepper">
        <button data-step="weight:-1">−</button>
        <div class="stepper-val">${fmtW(L.weight)}<small>LB ${esc(ex.loadLabel === 'bar' ? '' : ex.loadLabel).toUpperCase()}</small></div>
        <button data-step="weight:1">+</button>
      </div>`}
    </div>
    ${!isTimed && ex.loadLabel === 'bar' ? `<div class="plate-math" style="margin:-4px 0 12px">${plateText(ex, L.weight)}</div>` : ''}
    <div class="effort-row">
      <button class="effort-btn ${L.effort === 'easy' ? 'sel-easy' : ''}" data-eff="easy">Easy</button>
      <button class="effort-btn ${L.effort === 'solid' ? 'sel-solid' : ''}" data-eff="solid">Solid</button>
      <button class="effort-btn ${L.effort === 'grind' ? 'sel-grind' : ''}" data-eff="grind">Grind</button>
    </div>
    ${L.showNote ? `<textarea id="setNote" rows="2" placeholder="Note — form cue, pain, anything worth telling coach…">${esc(L.note)}</textarea>` : ''}
    <div class="btn-row">
      <button class="btn-ghost" id="noteToggle">${L.showNote ? 'Hide note' : '+ Note'}</button>
      <button class="btn" id="saveSet" style="flex:2">Log set</button>
    </div>
  </div>`;
}

function wireLogger() {
  if (!openLogger) return;
  const ex = exById(openLogger.exId);
  const isTimed = ex.type === 'timed';
  view.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const [field, dir] = b.dataset.step.split(':');
    const noteEl = $('#setNote'); if (noteEl) openLogger.note = noteEl.value;
    if (field === 'reps') openLogger.reps = Math.max(isTimed ? 5 : 1, openLogger.reps + (isTimed ? 5 : 1) * +dir);
    else openLogger.weight = Math.max(0, +(openLogger.weight + ex.increment * +dir).toFixed(1));
    render();
  });
  view.querySelectorAll('[data-eff]').forEach(b => b.onclick = () => {
    const noteEl = $('#setNote'); if (noteEl) openLogger.note = noteEl.value;
    openLogger.effort = b.dataset.eff; render();
  });
  const nt = $('#noteToggle');
  if (nt) nt.onclick = () => {
    const noteEl = $('#setNote'); if (noteEl) openLogger.note = noteEl.value;
    openLogger.showNote = !openLogger.showNote; render();
  };
  const sv = $('#saveSet');
  if (sv) sv.onclick = () => {
    const noteEl = $('#setNote'); if (noteEl) openLogger.note = noteEl.value;
    const L = openLogger;
    const entry = S.active.entries[L.exId];
    const setData = { reps: L.reps, weight: isTimed || ex.type === 'bodyweight' ? 0 : L.weight, effort: L.effort, note: (L.note || '').trim() };
    const isEdit = !!entry.sets[L.setIdx];
    entry.sets[L.setIdx] = setData;
    if (entry.target == null) entry.target = setData.weight;
    openLogger = null;
    save(); render();
    if (!isEdit && entry.sets.length < exById(L.exId).sets + 3) {
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
  const id = 'bx-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let ex = exById(id);
  if (!ex) {
    ex = {
      id, day: null, bonus: true, name, type,
      loadLabel: type === 'bodyweight' ? 'body' : type === 'barbell' ? 'bar' : type === 'dumbbell' ? 'per DB' : 'total',
      sets: 3, repLow: 1, repHigh: 99,
      weight: type === 'bodyweight' ? 0 : null,
      increment: type === 'barbell' ? 5 : type === 'bodyweight' ? 0 : 2.5,
    };
    S.exercises.push(ex);
  }
  if (!S.active.entries[ex.id]) S.active.entries[ex.id] = { target: ex.weight, sets: [] };
  openLogger = null;
  save(); render();
  const card = [...view.querySelectorAll('.ex-card')].pop();
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    <textarea id="bcNote" rows="2" placeholder="Optional — where, which exercise, how bad…"></textarea>
    <div class="btn-row" style="margin-top:14px"><button class="btn" id="bcNext">Continue</button></div>`);
  let choice = null;
  document.querySelectorAll('[data-bc]').forEach(b => b.onclick = () => {
    choice = b.dataset.bc;
    document.querySelectorAll('[data-bc]').forEach(x => x.className = 'effort-btn');
    b.className = 'effort-btn ' + (choice === 'good' ? 'sel-easy' : choice === 'tight' ? 'sel-solid' : 'sel-grind');
  });
  $('#bcNext').onclick = () => {
    S.active.bodyCheck = choice;
    S.active.bodyNote = ($('#bcNote').value || '').trim();
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
  html += `<div class="btn-row" style="margin-top:8px"><button class="btn" id="progDone">Save workout</button></div>`;
  modal(html);
  const decisions = {};
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const [i, act] = b.dataset.dec.split(':');
    decisions[i] = act;
    const banner = document.querySelector(`[data-sug="${i}"]`);
    banner.querySelectorAll('.prog-actions button').forEach(x => x.style.opacity = .35);
    b.style.opacity = 1;
  });
  $('#progDone').onclick = () => {
    const applied = [];
    sugs.forEach((sg, i) => {
      const act = decisions[i] || (sg.kind === 'set' ? 'apply' : 'skip'); // TBD adoption defaults to apply
      if (act !== 'apply') { applied.push({ ...sg, applied: false }); return; }
      const ex = exById(sg.exId);
      if (sg.kind === 'time') { ex.repLow = sg.to; ex.repHigh = sg.to; }
      else ex.weight = sg.to;
      applied.push({ ...sg, applied: true });
      S.events.push({ date: S.active.date, exId: sg.exId, kind: sg.kind, from: sg.from, to: sg.to });
    });
    closeModal();
    completeWorkout(applied);
  };
}

function completeWorkout(sugResults) {
  const a = S.active;
  a.minutes = Math.max(1, Math.round((Date.now() - a.startedAt) / 60000));
  a.suggestions = sugResults.map(s => ({ exId: s.exId, kind: s.kind, to: s.to, applied: s.applied }));
  // prune empty entries
  Object.keys(a.entries).forEach(k => { if (!a.entries[k].sets.length) delete a.entries[k]; });
  delete a.startedAt;
  S.sessions.push(a);
  S.active = null; openLogger = null; coachReportCache = null;
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
    `<button class="chip ${e.id === progressEx ? 'active' : ''}" data-pex="${e.id}">${esc(e.name)}</button>`).join('') + `</div>`;

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
      : `<div class="stat"><div class="stat-val">${fmtW(ex.weight)}${isTimed ? 's' : ''}</div><div class="stat-label">${isTimed ? 'Target' : 'Working lb'}</div></div>`;
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
    html += `<div class="card hist-item" data-sess="${s.id}">
      <div class="hist-head">
        <div><b>${esc(dayName(s.day))}</b> <span class="faint">· ${fmtDate(s.date)}</span></div>
        <div class="faint">${nEx} lifts · ${nSets} sets · ${s.minutes || '?'} min</div>
      </div>
      ${open ? histDetail(s) : ''}
    </div>`;
  });
  view.innerHTML = html;
  view.querySelectorAll('[data-pex]').forEach(b => b.onclick = () => { progressEx = b.dataset.pex; render(); });
  view.querySelectorAll('[data-sess]').forEach(el => el.onclick = () => {
    expandedSession = expandedSession === el.dataset.sess ? null : el.dataset.sess; render();
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
function parseWatchDuration(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
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
        const start = w.start || w.startDate || w.date;
        if (!start) return;
        const d = new Date(start);
        if (isNaN(d)) return;
        let mins = parseWatchDuration(w.duration);
        const end = w.end || w.endDate;
        if (!mins && end) mins = Math.round((new Date(end) - d) / 60000);
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
    const d = new Date(parts[0].includes('T') ? parts[0] : parts[0].replace(' ', 'T'));
    if (isNaN(d)) return;
    const mins = parseWatchDuration(parts[2]);
    if (!mins) return;
    out.push({ date: localDateOf(d), rawKind: parts[1], minutes: mins, cal: numOnly(parts[3]), hr: numOnly(parts[4]) });
  });
  return out;
}
function mergeWatchEntries(parsed) {
  const seen = new Set(S.cardio.filter(c => c.wkey).map(c => c.wkey));
  let added = 0, skipped = 0;
  for (const p of parsed) {
    const kind = mapWatchKind(p.rawKind);
    const wkey = `${p.date}|${kind}|${p.minutes}`;
    // skip exact watch re-imports, and manual entries that look like the same workout
    const manualDupe = S.cardio.some(c => !c.wkey && c.date === p.date && c.kind === kind && Math.abs(c.minutes - p.minutes) <= 5);
    if (seen.has(wkey) || manualDupe) { skipped++; continue; }
    seen.add(wkey);
    S.cardio.push({
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
  const last14 = S.cardio.filter(c => daysAgo(c.date) <= 14);
  const sports = last14.filter(c => c.kind === 'Hoops' || c.kind === 'Tennis');
  const engine = last14.filter(c => c.kind === 'Row' || c.kind === 'Run');
  let nudge;
  if (!last14.length) nudge = 'Nothing logged in two weeks — even 20 minutes of hoops counts. Log it!';
  else if (sports.length && !engine.length) nudge = `${sports.length} sport session${sports.length > 1 ? 's' : ''} in 2 weeks — love it. One easy 15-min row on a rest day would round out the engine work.`;
  else if (sports.length && engine.length) nudge = `Nice mix: ${sports.length} sport + ${engine.length} row/run in 2 weeks. Keep that balance.`;
  else nudge = `${engine.length} row/run session${engine.length > 1 ? 's' : ''} in 2 weeks. Sports count too — hoops and tennis are conditioning.`;

  let html = `<div class="hero"><h2>Cardio &amp; sports</h2><div class="muted">${esc(nudge)}</div></div>
  <div class="card cardio-form">
    <div class="kind-row">${SEED_PROGRAM.cardioKinds.map(k =>
      `<button class="chip ${cardioKind === k ? 'active' : ''}" data-kind="${k}">${k}</button>`).join('')}</div>
    <div class="form-row">
      <div><label>Minutes</label><input type="number" id="cMin" inputmode="numeric" placeholder="30"></div>
      <div><label>Distance (optional)</label><input type="text" id="cDist" placeholder="e.g. 2 mi / 2000 m"></div>
    </div>
    <label>Note (optional)</label>
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
    const meta = [`${c.minutes} min`];
    if (c.distance) meta.push(esc(c.distance));
    if (c.hr) meta.push(`${c.hr} bpm`);
    if (c.cal) meta.push(`${c.cal} cal`);
    html += `<div class="card">
      <div class="hist-head"><div><b>${esc(c.kind)}</b> <span class="faint">· ${fmtDate(c.date)}</span>${c.source === 'watch' ? ' <span class="pill blue">watch</span>' : ''}</div>
      <div class="faint">${meta.join(' · ')}</div></div>
      ${c.note ? `<div class="faint" style="margin-top:4px">“${esc(c.note)}”</div>` : ''}
    </div>`;
  });
  view.innerHTML = html;
  view.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    cardioKind = b.dataset.kind;
    view.querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('active', x.dataset.kind === cardioKind));
  });
  $('#watchImport').onclick = () => $('#watchFile').click();
  $('#watchFile').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
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
    if (!mins) return toast('How many minutes?');
    S.cardio.push({ date: todayISO(), kind: cardioKind, minutes: mins, distance: ($('#cDist').value || '').trim(), note: ($('#cNote').value || '').trim() });
    cardioKind = null; coachReportCache = null;
    save(); render(); toast('Logged.');
  };
}

// ============================================================ coach tab
function coachReport() {
  if (coachReportCache) return coachReportCache;
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

  const c14 = S.cardio.filter(c => daysAgo(c.date) <= 14);
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
    const hist = exHistory(ex.id).filter(h => h.target === ex.weight);
    const missStreak = countStreak(hist, h => resultOf(ex, h.sets) === 'miss');
    if (missStreak >= 2) flags.push(`${ex.name} has stalled ${missStreak} sessions at ${fmtW(ex.weight)} lb`);
    const last = hist[hist.length - 1];
    if (last && last.sets.filter(x => x.effort === 'grind').length >= 2) flags.push(`${ex.name}: multiple grind sets last session`);
  });
  S.sessions.slice(-4).forEach(s => {
    if (s.bodyCheck === 'pain') flags.push(`${s.date} (${dayName(s.day)}): neck/shoulders bothered TJ${s.bodyNote ? ` — "${s.bodyNote}"` : ''}`);
  });
  L.push(`\n## Flags for coaching`);
  L.push(flags.length ? flags.map(f => `- ${f}`).join('\n') : `- nothing flagged`);

  coachReportCache = L.join('\n');
  return coachReportCache;
}

function renderCoach() {
  const report = coachReport();
  let html = `<div class="hero"><h2>Coach hand-off</h2>
    <div class="muted">Copy the report below and paste it to Claude for a coaching review. Vault auto-sync arrives with the GitHub backend.</div></div>
  <div class="btn-row" style="margin-bottom:12px">
    <button class="btn" id="copyReport">Copy coach report</button>
  </div>
  <div class="coach-pre">${esc(report)}</div>

  <div class="section-title">Backup</div>
  <div class="card">
    <div class="btn-row">
      <button class="btn secondary" id="exportJson">Export JSON</button>
      <button class="btn secondary" id="importJson">Import JSON</button>
    </div>
    <input type="file" id="importFile" accept=".json,application/json" class="hidden">
  </div>

  <div class="section-title">Settings</div>
  <div class="card">
    <div class="settings-row"><div><div class="s-label">Bar weight</div></div>
      <input id="setBar" type="number" value="${S.settings.barWeight}"></div>
    <div class="settings-row"><div><div class="s-label">Plate pairs</div><div class="s-sub">comma-separated, one entry per pair you own</div></div>
      <input id="setPlates" type="text" value="${S.settings.platePairs.join(', ')}"></div>
    <div class="settings-row"><div><div class="s-label">Rest — isolation</div><div class="s-sub">seconds</div></div>
      <input id="setRest" type="number" value="${S.settings.restDefault}"></div>
    <div class="settings-row"><div><div class="s-label">Rest — barbell compounds</div><div class="s-sub">seconds</div></div>
      <input id="setRestC" type="number" value="${S.settings.restCompound}"></div>
  </div>
  <div class="btn-row" style="margin-bottom:20px"><button class="btn secondary" id="saveSettings">Save settings</button></div>
  <button class="btn danger" id="resetAll">Reset all data</button>`;
  view.innerHTML = html;

  $('#copyReport').onclick = async () => {
    try { await navigator.clipboard.writeText(report); toast('Report copied — paste it to Claude.'); }
    catch (e) { toast('Copy failed — select the text manually.'); }
  };
  $('#exportJson').onclick = async () => {
    const name = `lift-studio-${todayISO()}.json`;
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    // Home-screen (standalone) iOS apps handle <a download> poorly — use the share sheet
    // ("Save to Files", AirDrop, Mail…) when available.
    const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (standalone && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Lift Studio backup' });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); // Safari needs the URL alive after click
  };
  $('#importJson').onclick = () => $('#importFile').click();
  $('#importFile').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.exercises || !data.sessions) throw new Error('bad file');
        S = data; coachReportCache = null; save(); render(); toast('Imported.');
      } catch (e) { toast('That file did not look like a Lift Studio backup.'); }
    };
    r.readAsText(f);
  };
  $('#saveSettings').onclick = () => {
    S.settings.barWeight = parseFloat($('#setBar').value) || 45;
    const plates = $('#setPlates').value.split(',').map(x => parseFloat(x.trim())).filter(x => x > 0);
    if (plates.length) S.settings.platePairs = plates;
    S.settings.restDefault = parseInt($('#setRest').value, 10) || 90;
    S.settings.restCompound = parseInt($('#setRestC').value, 10) || 150;
    save(); toast('Settings saved.');
  };
  $('#resetAll').onclick = () => confirmModal('Reset everything?', 'All workouts, cardio, and settings are wiped. Export a JSON backup first if unsure.',
    () => { S = freshState(); coachReportCache = null; save(); render(); toast('Fresh start.'); });
}

// ============================================================ modal helpers
function modal(inner) {
  $('#modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal">${inner}</div></div>`;
  $('#modalRoot .modal-backdrop').addEventListener('click', ev => { if (ev.target.classList.contains('modal-backdrop')) closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
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
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'workout') renderWorkout();
  else if (tab === 'progress') renderProgress();
  else if (tab === 'cardio') renderCardio();
  else renderCoach();
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; openLogger = null; render(); });
render();
