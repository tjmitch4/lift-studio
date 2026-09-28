/* Lift Studio — Apple Watch / Health export importer. Pure: no DOM, no globals besides
   LiftWatch. Depends on watchCardioId() + dateStamp() (state.js). Used by app.js (Cardio tab
   file picker, GitHub inbox) and by tests/. */
(function (root) {
'use strict';
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
// Merge parsed watch rows into a state's cardio list (mutates st). Deterministic ids: two
// devices importing the same row mint the same id, and a deleted entry's tombstone blocks
// its re-import.
function mergeInto(st, parsed) {
  const seen = new Set(st.cardio.filter(c => c.wkey).map(c => c.wkey));
  const deleted = new Set(((st.tombstones && st.tombstones.cardio) || []).map(t => t.id));
  let added = 0, skipped = 0;
  for (const p of parsed) {
    const kind = mapWatchKind(p.rawKind);
    const wkey = `${p.date}|${kind}|${p.minutes}`;
    const id = watchCardioId(wkey);
    // skip exact watch re-imports, and manual entries that look like the same workout
    const manualDupe = st.cardio.some(c => !c.wkey && c.date === p.date && c.kind === kind && Math.abs(c.minutes - p.minutes) <= 5);
    if (seen.has(wkey) || deleted.has(id) || manualDupe) { skipped++; continue; }
    seen.add(wkey);
    st.cardio.push({
      // deterministic stamp: two devices importing the same row produce identical records
      id, updatedAt: dateStamp(p.date),
      date: p.date, kind, minutes: p.minutes, distance: '',
      note: kind === 'Other' ? String(p.rawKind) : '',
      source: 'watch', hr: p.hr || null, cal: p.cal || null, wkey,
    });
    added++;
  }
  if (added) st.cardio.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { added, skipped };
}

root.LiftWatch = { parse: parseWatchFile, mergeInto, mapWatchKind, parseDateLoose, parseWatchDuration, localDateOf };
})(typeof window !== 'undefined' ? window : globalThis);
