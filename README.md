# Lift Studio

TJ's workout tracker + coaching feedback loop. Vanilla HTML/JS/CSS, zero dependencies,
all data in browser `localStorage`. Sibling of Guitar Studio.

## Use it

**Live:** https://tjmitch4.github.io/lift-studio/

Static site, no build step: GitHub Pages serves the repo root as-is (`.nojekyll` keeps
Jekyll out of the way). All asset paths are relative, so it works from the `/lift-studio/`
subpath or any other folder.

### Run locally

Any static file server works. Python isn't installed on TJ's Windows machine, so the
simplest option is a tiny PowerShell server (save as `serve.ps1` anywhere outside the repo):

```powershell
$l = New-Object System.Net.HttpListener; $l.Prefixes.Add('http://127.0.0.1:8766/'); $l.Start()
while ($l.IsListening) { $c = $l.GetContext(); $p = $c.Request.Url.AbsolutePath.TrimStart('/'); if (!$p -or $p.EndsWith('/')) { $p += 'index.html' }
  $f = Join-Path (Get-Location) $p; if (Test-Path $f -PathType Leaf) { $b = [IO.File]::ReadAllBytes($f)
  if ($f -like '*.js') { $c.Response.ContentType = 'text/javascript' } elseif ($f -like '*.css') { $c.Response.ContentType = 'text/css' }
  $c.Response.OutputStream.Write($b, 0, $b.Length) } else { $c.Response.StatusCode = 404 }; $c.Response.Close() }
```

Run it from the repo folder (`powershell -ExecutionPolicy Bypass -File path\to\serve.ps1`),
then open http://127.0.0.1:8766. (With Python: `python -m http.server 8766`.)

### Add to iPhone home screen

1. Open the live URL in **Safari** on the iPhone.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch it from the home-screen icon: it runs full-screen (no Safari bars) with the
   dark status bar, and the tab bar clears the home indicator.

A small service worker (`sw.js`) caches the app so it opens offline at the gym. It is
network-first: when online you always get the latest version pushed to GitHub; offline it
falls back to the cached copy (and on a weak signal, after 3 seconds). Bump `CACHE_VERSION`
in `sw.js` whenever you change a cached file or add new files to
the precache list.

### Your data

Each device (home-screen app, Safari, desktop browser) keeps its own copy in
`localStorage` (key `liftstudio.v1`) and works fully offline. **GitHub sync** (below) keeps
those copies in step automatically. Without sync, **Coach → Manual backup → Export JSON /
Import JSON** still moves data by hand (on the home-screen app, Export opens the share
sheet). With sync on, Import *merges* a backup instead of replacing, and Reset asks before
wiping every device.

## GitHub sync

Local-first, automatic, no server. Your log syncs to Markdown files in the **private**
repo `tjmitch4/studio-data`, under `lift/` (Guitar Studio uses `guitar/` in the same repo).
Obsidian can open the repo as a vault; Claude reads `lift/COACH.md`.

```
lift/
  workouts/2026-09-27-push-<id>.md   one per finished workout
  cardio/2026-09-20-hoops-<id>.md    one per cardio/sport entry
  settings.md                        settings, program targets, bonus lifts, progression events
  active.md                          the workout in progress (continue it on another device)
  COACH.md                           the Coach Report, rewritten whenever data changes
  inbox/                             Apple Watch hand-off (see watch-sync.md)
```

Each file has flat YAML frontmatter (Obsidian properties), a readable body, and the full
record in a final `## Data` json block. **The app reads only that json block** — editing
the body or frontmatter by hand is harmless but gets rewritten the next time that record
changes in the app. A file the app can't parse is skipped with a warning in the Sync card,
never deleted or overwritten. Filenames never change for the life of a record.

- **When:** on launch, 5 s after each change (≈20 s when only the in-progress workout
  changed, and right away when the app goes to the background), when the app comes back
  to the foreground, when the network returns, and every 2 min while open. Offline is fine
  — changes wait and go up later (grey dot, no alerts). Rate limits and network errors
  back off and retry silently.
- **How (one commit per sync, Git Data API):** read the branch head and tree → download
  only files that changed since this device's last sync → merge → write the changed files
  plus deletions as one commit (`lift: sync (3 changed) from iPhone-k3f9`) → move `main`
  with `force: false`. If another device committed in between, it starts over (max 3×).
  An idle device makes no commits.
- **Merge rules** (`sync-merge.js`, tested by `tests/merge-test.html`): workouts, cardio
  entries and progression events merge by id — newest edit wins, app deletes are kept as
  tombstones (in `settings.md`) so they reach every device. Settings and each exercise's
  targets merge **per field**. The in-progress workout: newest wins; one finished or
  discarded on another device closes here too. A first sync never loses anything.
- **Deleting files by hand** (GitHub web, Obsidian): a record whose file disappears is
  removed on the next sync, unless it was edited on that device since its last sync (then
  it comes back). Safety net: if `settings.md` disappears, or more than 3 records and more
  than a quarter of the files vanish at once, sync treats it as a wiped/recreated repo —
  nothing is deleted locally and everything is re-uploaded.
- **Apple Watch:** any `.csv`/`.json` the *Sync Workouts* shortcut puts in `lift/inbox/`
  is imported (deduped; deleted entries stay deleted) and removed in the same commit.
- **Header dot:** green synced · blue syncing · grey offline · red problem · amber ring not
  connected. Tap it for the Sync card on the Coach tab (connect, *Sync now*, disconnect).

### Connecting (once per browser)

The app authenticates with a **fine-grained personal access token** limited to
`studio-data`. It's stored in `localStorage` under `studioData.githubToken` — the same key
Guitar Studio uses, and both apps live on `tjmitch4.github.io`, so one paste per browser
covers both (the iPhone home-screen app counts as its own browser). The token is only ever
sent to `api.github.com` in the `Authorization` header — never logged, never in a URL.

1. Open https://github.com/settings/personal-access-tokens/new
2. **Token name:** `Studio apps`. **Expiration:** your call (when it expires, the Sync card
   turns red and asks for a new one; nothing is lost meanwhile).
3. **Resource owner:** `tjmitch4`. **Repository access:** *Only select repositories* →
   `studio-data`.
4. **Permissions → Repository permissions → Contents: Read and write.** (GitHub adds
   *Metadata: Read-only* automatically.) Nothing else.
5. **Generate token**, copy it.
6. In the app: Coach tab → Sync → paste → **Connect**. The app checks the token can see
   `studio-data` and push to it, then syncs. Errors say exactly what to fix (wrong/expired
   token, repo not selected, read-only).

**Disconnect** removes the token from that browser (Guitar Studio stops syncing there too)
and keeps all local data; the repo is untouched.

### Testing sync locally

- `tests/merge-test.html` — the merge rules.
- `tests/format-test.html` — the Markdown format: lossless round trips (unicode, quotes,
  newlines, fences, pipes), deterministic output, flat frontmatter, corrupt-file handling.
- `tests/sync-test.html` — the whole engine against an in-memory mock of the GitHub API
  (`tests/mock-github.js`) with simulated devices: connect errors, first sync, convergence,
  remote/local deletes, edit vs delete, non-fast-forward retry, corrupt files, watch inbox,
  active-workout hand-off, idle = no commit, offline/rate limits, wiped-repo safety.

Open them from a local server (e.g. http://localhost:8783/tests/sync-test.html); every row
should say PASS. No token needed. To try the real app against the mock, load `index.html`,
then in the console: load `tests/mock-github.js`, `const m = mockGitHub(); window.fetch =
m.install(window.fetch.bind(window));` and connect with the token `GOOD`.

## What it does

- **Workout tab** — PPL split (seeded from TJ's program in `program.js`), tap-to-log sets
  with reps/weight/effort (Easy·Solid·Grind)/notes, per-side plate math for barbell lifts
  (standard 300lb set, editable in settings), landmine sleeve math, auto rest timer
  (150s barbell compounds / 90s everything else).
- **Progression engine** — top of rep range on all sets, 2 sessions in a row at the same
  weight → suggests +increment (5lb barbell / 2.5–5 DB & cable) and reset to bottom of
  range. 3 straight stalled sessions → suggests ~10% deload rounded to loadable plates.
  Suggestions are offered at workout finish; TJ applies or skips. Planks progress by hold
  time (+15s). TBD lifts adopt the first logged weight.
- **Bonus exercises** — "+ Bonus exercise" mid-workout adds an ad-hoc lift (preset chips:
  Pushups, Pull-ups, Dips, Goblet Squat, Farmer Carry — or any name; bodyweight/DB/barbell/
  cable). Bonus lifts are reusable: history accumulates in Progress, weighted ones adopt
  their first logged weight as the prefill, none of them trigger progression rules.
- **Neck/shoulders check** — quick good/tight/bothered prompt when finishing Push or Pull
  days (program note: reassess as you go); flows into the coach report.
- **Progress tab** — per-exercise weight chart, working/best/est-1RM stats, full history.
- **Cardio tab** — Hoops/Tennis/Row/Run/Walk logging with a gentle conditioning-mix nudge,
  plus Apple Watch import (see `watch-sync.md`): with GitHub sync on, the export the
  *Sync Workouts* shortcut uploads to `lift/inbox/` is imported automatically; without it,
  pick the file (or Health Auto Export JSON) via the iOS file picker. Maps Health types to app kinds, keeps
  avg HR + calories, dedupes against prior imports and manual entries.
- **Coach tab** — the Coach Report (program rules, targets with last results, recent
  sessions, progression events, 4-week rhythm, cardio, auto-flags for stalls/grinds/pain).
  With sync on, Claude reads it as `lift/COACH.md` in `studio-data`; a copy button remains
  for pasting. Also: GitHub sync card;
  settings (bar weight, plate inventory, rest times); manual JSON backup.

## Files

- `index.html` — shell, tab bar, rest-timer bar
- `styles.css` — dark, mobile-first
- `program.js` — `SEED_PROGRAM`: TJ's split, weights, increments, settings defaults
- `config.js` — GitHub repo + token key constants
- `state.js` — state shape, `normalize()` load/import migration (schema v3)
- `sync-merge.js` — pure merge of two states (no DOM/network)
- `lift-md.js` — Markdown file format: record ⇄ file, paths (pure)
- `github-sync.js` — GitHub sync engine (Git Data API, one commit per sync)
- `watch-import.js` — Apple Watch / Health export parser + dedupe (pure)
- `app.js` — progression logic, rendering, coach report, sync UI
- `sw.js` — service worker (network-first offline cache; never touches api.github.com)
- `tests/` — merge, file-format and sync-engine test pages + GitHub API mock
- `manifest.webmanifest`, `icons/` — home-screen install metadata + icons

Storage key: `liftstudio.v1`. Seed merges forward: new exercises added to `program.js`
appear for existing users without wiping data. Schema changes are additive only: v3 added
record `id`/`updatedAt`, `tombstones`, `settingsTs`, per-exercise `fieldTs` and
`activeUpdatedAt`; older data is upgraded on load (records without ids get a
deterministic content-hash id, so the same old record on two devices doesn't duplicate).

## Planned

- Point the Obsidian vault at a clone of `studio-data` (or add it as a vault) so workout
  notes show up next to `_Projects/Fitness Coach & Tracker.md`.
