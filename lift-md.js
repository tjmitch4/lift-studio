/* Lift Studio — Markdown file format for the studio-data GitHub repo. Pure: no DOM, no
   network, no globals besides LiftMd. Loaded by index.html and tests/.

   Every file is Markdown with:
     - YAML frontmatter of FLAT scalars (id, type, date, updatedAt, a few human-useful fields)
       so Obsidian shows them as properties,
     - a human-readable body (tables, notes),
     - a final section holding the full record, which is the ONLY part the app parses:
         ## Data
         ```json
         { ...full record... }
         ```
   Output is deterministic (sorted keys, fixed English date formatting, no "generated at"
   stamps), so an unchanged record always serializes to the same bytes on every device.

   Layout under lift/:
     workouts/YYYY-MM-DD-<day>-<id>.md   one finished workout (record = the session object)
     cardio/YYYY-MM-DD-<kind>-<id>.md    one cardio/sport entry (record = the cardio object)
     settings.md                         { settings, settingsTs, exercises, days, events, tombstones }
     active.md                           { active, activeUpdatedAt } — the in-progress workout
     COACH.md                            generated coach report (never parsed)
     inbox/*.csv|*.json                  Apple Watch hand-off (imported, then deleted) */
(function (root) {
  'use strict';

  const PREFIX = 'lift/';
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REST_FIELDS = ['restEndAt', 'restTotal']; // device-local rest timer, not synced

  // ---------------------------------------------------------------- helpers
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(x => (x === undefined || typeof x === 'function' ? null : sortKeys(x)));
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).sort().forEach(k => { if (v[k] !== undefined && typeof v[k] !== 'function') out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }
  const stableJson = v => JSON.stringify(sortKeys(v), null, 2);

  const slug = s => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // ids become part of a lowercase filename: keep them readable, add a hash when that is lossy
  function shortId(id) {
    const s = String(id);
    const clean = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (clean === s && clean) return clean;
    return (clean ? clean + '-' : '') + root.LiftMerge.hashString(s).slice(0, 6);
  }
  const isoDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
  function prettyDate(iso) {
    const d = isoDate(iso);
    if (!d) return String(iso || 'undated');
    const [y, m, day] = d.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    return `${WEEKDAYS[wd]} ${MONTHS[m - 1]} ${day}, ${y}`;
  }
  const isoTime = ms => { const n = Number(ms); return isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };
  const fmtW = w => (w == null || w === '' ? '—' : Number(w) % 1 ? Number(w).toFixed(1) : String(w));
  // user text inside a single table cell / line: no newlines, no pipes breaking the table
  const oneLine = s => String(s == null ? '' : s).replace(/\r?\n|\r/g, ' ⏎ ').replace(/\|/g, '\\|').trim();
  const quoteBlock = s => String(s).split(/\r?\n|\r/).map(l => '> ' + l).join('\n');

  // YAML scalar: bare when unambiguous, else a JSON string (valid YAML double-quoted scalar)
  const YAML_RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;
  function yamlScalar(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? String(v) : null;
    if (typeof v === 'boolean') return String(v);
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(s)) return s; // dates / ISO datetimes
    if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(s) && !YAML_RESERVED.test(s)) return s;
    return JSON.stringify(s);
  }
  function frontmatter(fields) {
    const lines = ['---'];
    fields.forEach(([k, v]) => { const y = yamlScalar(v); if (y !== null) lines.push(`${k}: ${y}`); });
    lines.push('---');
    return lines.join('\n');
  }
  const dataSection = rec => '## Data\n```json\n' + stableJson(rec) + '\n```\n';

  const exName = (ctx, id) => {
    const ex = ((ctx && ctx.exercises) || []).find(e => e.id === id);
    return ex ? ex.name : id;
  };
  const exOf = (ctx, id) => ((ctx && ctx.exercises) || []).find(e => e.id === id) || null;
  const dayName = (ctx, id) => {
    const d = ((ctx && ctx.days) || []).find(x => x.id === id);
    return d ? d.name : (id || 'Workout');
  };

  // ---------------------------------------------------------------- paths
  function pathFor(kind, rec) {
    const date = isoDate(rec && rec.date) || 'undated';
    if (kind === 'sessions') return `${PREFIX}workouts/${date}-${slug(rec.day) || 'workout'}-${shortId(rec.id)}.md`;
    if (kind === 'cardio') return `${PREFIX}cardio/${date}-${slug(rec.kind) || 'cardio'}-${shortId(rec.id)}.md`;
    if (kind === 'settings') return PREFIX + 'settings.md';
    if (kind === 'active') return PREFIX + 'active.md';
    throw new Error('unknown kind ' + kind);
  }
  // which parser a repo path belongs to (null = not ours to parse: COACH.md, .gitkeep, …)
  function kindOfPath(path) {
    if (String(path).indexOf(PREFIX) !== 0) return null;
    const rel = path.slice(PREFIX.length);
    if (rel === 'settings.md') return 'settings';
    if (rel === 'active.md') return 'active';
    if (/^workouts\/[^/]+\.md$/i.test(rel)) return 'sessions';
    if (/^cardio\/[^/]+\.md$/i.test(rel)) return 'cardio';
    if (/^inbox\/[^/]+\.(csv|json)$/i.test(rel)) return 'inbox';
    return null;
  }

  // ---------------------------------------------------------------- sync views
  // the in-progress workout minus the device-local rest timer
  function activeView(active) {
    if (!active) return null;
    const a = {};
    Object.keys(active).forEach(k => { if (!REST_FIELDS.includes(k)) a[k] = active[k]; });
    return a;
  }
  const settingsBundle = st => ({
    settings: st.settings, settingsTs: st.settingsTs || {}, exercises: st.exercises, days: st.days,
    events: st.events || [], tombstones: st.tombstones || {},
  });
  const activeBundle = st => (st.active ? { active: activeView(st.active), activeUpdatedAt: st.activeUpdatedAt || 0 } : null);

  // ---------------------------------------------------------------- workouts
  function setCells(ex, x) {
    const t = ex && ex.type;
    if (t === 'timed') return [`${x.reps} s`, '—'];
    if (t === 'bodyweight') return [String(x.reps), x.weight ? `BW + ${fmtW(x.weight)} lb` : 'BW'];
    return [String(x.reps), `${fmtW(x.weight)} lb`];
  }
  function sessionStats(s) {
    const entries = s.entries || {};
    const ids = Object.keys(entries);
    const sets = ids.reduce((n, k) => n + ((entries[k] && entries[k].sets) || []).length, 0);
    return { exercises: ids.length, sets };
  }
  function workoutTable(entries, ctx) {
    const rows = ['| Exercise | Set | Reps | Weight | Effort | Note |', '|---|--:|--:|--:|---|---|'];
    Object.keys(entries || {}).forEach(exId => {
      const e = entries[exId] || {};
      const ex = exOf(ctx, exId);
      const target = e.target == null ? '' : ex && ex.type === 'timed' ? '' : ` (target ${fmtW(e.target)} lb)`;
      const sets = e.sets || [];
      if (!sets.length) { rows.push(`| ${oneLine(exName(ctx, exId))}${target} | — | | | | |`); return; }
      sets.forEach((x, i) => {
        const [reps, w] = setCells(ex, x);
        rows.push(`| ${i === 0 ? oneLine(exName(ctx, exId)) + target : ''} | ${i + 1} | ${reps} | ${w} | ${oneLine(x.effort)} | ${oneLine(x.note)} |`);
      });
    });
    return rows.join('\n');
  }
  function suggestionLine(sg, ctx) {
    const name = oneLine(exName(ctx, sg.exId));
    const what = sg.kind === 'up' ? `move up to ${fmtW(sg.to)} lb` : sg.kind === 'down' ? `deload to ${fmtW(sg.to)} lb`
      : sg.kind === 'time' ? `hold target ${sg.to} s` : `working weight ${fmtW(sg.to)} lb`;
    return `- ${name}: ${what} — ${sg.applied ? 'applied' : 'not yet'}`;
  }
  function serializeSession(s, ctx) {
    const { exercises, sets } = sessionStats(s);
    const day = dayName(ctx, s.day);
    const fm = frontmatter([
      ['id', s.id], ['type', 'workout'], ['date', isoDate(s.date)], ['updatedAt', isoTime(s.updatedAt)],
      ['day', day], ['minutes', typeof s.minutes === 'number' ? s.minutes : null],
      ['exercises', exercises], ['sets', sets], ['neckShoulders', s.bodyCheck || null], ['app', 'lift-studio'],
    ]);
    const parts = [fm, '', `# ${oneLine(day)} — ${prettyDate(s.date)}`, ''];
    const meta = [];
    if (typeof s.minutes === 'number') meta.push(`**${s.minutes} min**`);
    meta.push(`${exercises} exercise${exercises === 1 ? '' : 's'}`, `${sets} set${sets === 1 ? '' : 's'}`);
    parts.push(meta.join(' · '), '', workoutTable(s.entries, ctx), '');
    if (s.bodyCheck || s.bodyNote) {
      parts.push(`**Neck/shoulders:** ${s.bodyCheck || 'not recorded'}${s.bodyNote ? ` — “${oneLine(s.bodyNote)}”` : ''}`, '');
    }
    if (Array.isArray(s.suggestions) && s.suggestions.length) {
      parts.push('**Progression check**', '', s.suggestions.map(sg => suggestionLine(sg, ctx)).join('\n'), '');
    }
    parts.push(dataSection(s));
    return parts.join('\n');
  }

  // ---------------------------------------------------------------- cardio
  function serializeCardio(c) {
    const fm = frontmatter([
      ['id', c.id], ['type', 'cardio'], ['date', isoDate(c.date)], ['updatedAt', isoTime(c.updatedAt)],
      ['kind', c.kind], ['minutes', typeof c.minutes === 'number' ? c.minutes : null],
      ['distance', c.distance || null], ['avgHr', c.hr || null], ['calories', c.cal || null],
      ['source', c.source || 'manual'], ['app', 'lift-studio'],
    ]);
    const meta = [`**${fmtW(c.minutes)} min**`];
    if (c.distance) meta.push(oneLine(c.distance));
    if (c.hr) meta.push(`avg HR ${c.hr}`);
    if (c.cal) meta.push(`${c.cal} cal`);
    if (c.source === 'watch') meta.push('Apple Watch');
    const parts = [fm, '', `# ${oneLine(c.kind)} — ${prettyDate(c.date)}`, '', meta.join(' · '), ''];
    if (c.note) parts.push(quoteBlock(c.note), '');
    parts.push(dataSection(c));
    return parts.join('\n');
  }

  // ---------------------------------------------------------------- settings / program
  function maxStamp(b) {
    let m = 0;
    const see = v => { const n = Number(v); if (isFinite(n) && n > m) m = n; };
    Object.values(b.settingsTs || {}).forEach(see);
    (b.exercises || []).forEach(e => { see(e.updatedAt); Object.values(e.fieldTs || {}).forEach(see); });
    (b.events || []).forEach(e => see(e.updatedAt));
    Object.values(b.tombstones || {}).forEach(arr => (arr || []).forEach(t => see(t.updatedAt)));
    return m;
  }
  function targetText(e) {
    if (e.type === 'timed') return [`${e.sets} × ${e.repHigh} s hold`, '—'];
    const reps = e.bonus ? `${e.sets} sets` : `${e.sets} × ${e.repLow}–${e.repHigh}`;
    if (e.type === 'bodyweight') return [reps, 'bodyweight'];
    return [reps, e.weight == null ? 'TBD' : `${fmtW(e.weight)} lb`];
  }
  function eventLine(e, ctx) {
    const name = oneLine(exName(ctx, e.exId));
    const what = e.kind === 'up' ? `moved up ${fmtW(e.from)} → ${fmtW(e.to)} lb`
      : e.kind === 'down' ? `deloaded ${fmtW(e.from)} → ${fmtW(e.to)} lb`
      : e.kind === 'time' ? `hold target now ${e.to} s`
      : `working weight set at ${fmtW(e.to)} lb`;
    return `- ${isoDate(e.date) || e.date}: ${name} ${what}`;
  }
  function serializeSettings(b) {
    const s = b.settings || {};
    const ctx = { exercises: b.exercises, days: b.days };
    const fm = frontmatter([
      ['type', 'settings'], ['updatedAt', isoTime(maxStamp(b))],
      ['exercises', (b.exercises || []).length], ['events', (b.events || []).length], ['app', 'lift-studio'],
    ]);
    const parts = [fm, '', '# Lift Studio — program & settings', '',
      '## Settings', '', '| Setting | Value |', '|---|---|',
      `| Bar weight | ${fmtW(s.barWeight)} lb |`,
      `| Plate pairs | ${(s.platePairs || []).map(fmtW).join(', ')} |`,
      `| Rest — isolation | ${s.restDefault} s |`,
      `| Rest — barbell compounds | ${s.restCompound} s |`,
      `| Move up after | ${s.progressAfter} straight top-of-range sessions |`,
      `| Deload after | ${s.deloadAfter} stalled sessions (−${Math.round((Number(s.deloadPct) || 0) * 100)}%) |`,
      '', '## Program', ''];
    (b.days || []).forEach(d => {
      parts.push(`### ${oneLine(d.name)}`, '', '| Exercise | Sets × reps | Weight | Load | Step | Note |', '|---|---|--:|---|--:|---|');
      (b.exercises || []).filter(e => e.day === d.id).forEach(e => {
        const [reps, w] = targetText(e);
        parts.push(`| ${oneLine(e.name)} | ${reps} | ${w} | ${oneLine(e.loadLabel)} | ${e.increment ? fmtW(e.increment) + ' lb' : '—'} | ${oneLine(e.coachNote)} |`);
      });
      parts.push('');
    });
    const bonus = (b.exercises || []).filter(e => e.bonus || e.day == null);
    if (bonus.length) {
      parts.push('## Bonus exercises', '', '| Exercise | Type | Weight |', '|---|---|--:|');
      bonus.forEach(e => parts.push(`| ${oneLine(e.name)} | ${oneLine(e.type)} | ${targetText(e)[1]} |`));
      parts.push('');
    }
    parts.push('## Progression events', '');
    const ev = b.events || [];
    parts.push(ev.length ? ev.map(e => eventLine(e, ctx)).join('\n') : '- none yet', '');
    parts.push(dataSection(b));
    return parts.join('\n');
  }

  // ---------------------------------------------------------------- in-progress workout
  function serializeActive(b, ctx) {
    const a = b.active;
    const { exercises, sets } = sessionStats(a);
    const day = dayName(ctx, a.day);
    const fm = frontmatter([
      ['id', a.id], ['type', 'active-workout'], ['date', isoDate(a.date)], ['updatedAt', isoTime(b.activeUpdatedAt)],
      ['day', day], ['startedAt', isoTime(a.startedAt)], ['sets', sets], ['app', 'lift-studio'],
    ]);
    const parts = [fm, '', `# In progress: ${oneLine(day)} — ${prettyDate(a.date)}`, '',
      `${sets} set${sets === 1 ? '' : 's'} logged across ${exercises} exercise${exercises === 1 ? '' : 's'} so far. Open Lift Studio on any device to keep going; this file disappears when the workout is finished or discarded.`, '',
      workoutTable(a.entries, ctx), '', dataSection(b)];
    return parts.join('\n');
  }

  function serialize(kind, rec, ctx) {
    if (kind === 'sessions') return serializeSession(rec, ctx);
    if (kind === 'cardio') return serializeCardio(rec);
    if (kind === 'settings') return serializeSettings(rec);
    if (kind === 'active') return serializeActive(rec, ctx);
    throw new Error('unknown kind ' + kind);
  }

  // ---------------------------------------------------------------- parse
  // Returns the record from the final "## Data" json block. Throws on anything else.
  function parse(text) {
    const t = '\n' + String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const at = t.lastIndexOf('\n## Data\n');
    if (at < 0) throw new Error('no "## Data" section');
    const lines = t.slice(at + 9).split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (!/^```json\s*$/.test(lines[i] || '')) throw new Error('no ```json block after "## Data"');
    const start = ++i;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) i++;
    if (i >= lines.length) throw new Error('unterminated json block');
    const rec = JSON.parse(lines.slice(start, i).join('\n'));
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('json block is not an object');
    return rec;
  }
  // parse + shape check for a given kind (so a stray file can't inject garbage into the merge)
  function parseAs(kind, text) {
    const rec = parse(text);
    if (kind === 'sessions' || kind === 'cardio') {
      if (rec.id == null || rec.id === '' || typeof rec.id === 'object') throw new Error('record has no id');
      if (kind === 'sessions' && (rec.entries == null || typeof rec.entries !== 'object')) throw new Error('workout has no entries');
    } else if (kind === 'settings') {
      if (!rec.settings || typeof rec.settings !== 'object' || !Array.isArray(rec.exercises)) throw new Error('not a settings bundle');
    } else if (kind === 'active') {
      if (!rec.active || typeof rec.active !== 'object' || rec.active.id == null) throw new Error('not an active workout');
    }
    return rec;
  }

  root.LiftMd = {
    PREFIX, pathFor, kindOfPath, serialize, parse, parseAs, stableJson, sortKeys, shortId, slug, prettyDate,
    settingsBundle, activeBundle, activeView, REST_FIELDS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
