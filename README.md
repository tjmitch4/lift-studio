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
then open http://127.0.0.1:8766. (With Python: `python -m http.server 8766`.) For Dropbox
sign-in locally, use `http://localhost:<port>/` and add that exact URL to the Dropbox
app's Redirect URIs.

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
`localStorage` (key `liftstudio.v1`) and works fully offline. **Dropbox sync** (below) keeps
those copies in step automatically. Without sync, **Coach → Manual backup → Export JSON /
Import JSON** still moves data by hand (on the home-screen app, Export opens the share
sheet). With sync on, Import *merges* a backup instead of replacing, and Reset asks before
wiping every device.

## Dropbox sync

Local-first, automatic, no server. Every device signs in to Dropbox once; after that the
app syncs one JSON file, `/TJ/Fitness/Lift Studio/lift-studio-data.json`:

- **When:** on launch, 2 s after every change, when the app comes back to the foreground,
  when the network returns, and every 60 s while open. Offline is fine — changes wait
  and go up on the next sync (the header dot turns grey, no alerts).
- **How:** download → merge with this device → save locally → upload with Dropbox's
  `rev` check. If another device uploaded in between (409 conflict), it re-downloads,
  re-merges and retries (up to 3×).
- **Merge rules** (`sync-merge.js`, tested by `tests/merge-test.html`): workouts, cardio
  entries and progression events merge by id — newest edit wins, deletes are kept as
  tombstones so they reach other devices. Settings and each exercise's targets merge
  **per field** (change bench weight on the phone and a rest time on the PC — both
  survive). The in-progress workout: newest wins; one finished on another device closes
  here too. A first sync never loses anything: a phone with history + a PC with different
  history end up with the union.
- **Apple Watch:** each sync checks `/TJ/Fitness/watch-workouts.csv` (written by the
  *Sync Workouts* shortcut, see `watch-sync.md`); when it changes, new workouts are
  imported automatically, deduped, and deleted ones stay deleted.
- **Header dot:** green synced · blue syncing · grey offline · red problem · amber ring
  not connected. Tap it for the Sync card on the Coach tab (connect, *Sync now*, sign out).
  Signing out revokes the token and keeps everything on the device.

### Setting up the Dropbox app (once — shared with Guitar Studio)

1. https://www.dropbox.com/developers/apps → **Create app** → *Scoped access* →
   **Full Dropbox** (the data lives in your existing `/TJ/Fitness` folder, not an app
   folder) → name it e.g. *TJ Studio Sync*.
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`,
   `files.content.write` (`account_info.read` is always on — used to find the team root
   if needed). Click **Submit**.
3. **Settings** tab:
   - **OAuth 2 → Allow public clients (Implicit Grant & PKCE): Allow.**
   - **Redirect URIs** — add all of these:
     - `https://tjmitch4.github.io/lift-studio/`
     - `https://tjmitch4.github.io/guitar-studio/`
     - `http://localhost:8781/` (and any other local port you test on, e.g.
       `http://localhost:8766/`, plus whatever Guitar Studio uses locally)
   - Copy the **App key** (not the secret — PKCE needs no secret).
4. Paste the key into `config.js`: `const DROPBOX_APP_KEY = 'xxxxxxxxxxxxxxx';`, commit,
   push. (The app key is public by design; never commit the app secret.)
5. On each device: Coach tab → **Connect Dropbox** → allow. On the iPhone **home-screen
   app**, the button opens Dropbox in Safari and shows a code — copy it, switch back, paste
   it into *Paste the code from Dropbox*. (A redirect from Dropbox would land in Safari,
   not the home-screen app, so the app uses the no-redirect code flow there.) *Having
   trouble? Use a code instead* offers the same flow in any browser.

While the app is still in Dropbox's *development* status it allows up to 500 users — plenty.

**Paths.** TJ's Dropbox is a Business team account; his member folder is the API's home
namespace, so `/TJ/Fitness/...` resolves directly. On first sync the app checks that
`/TJ/Fitness` exists; if not, it looks up the team root namespace and retries with the
`Dropbox-API-Path-Root` header and a `/TJ Mitchell` prefix. Whichever works is cached (the
Sync card shows the path in use). All paths are constants in `config.js`.

**Tokens** live in `localStorage` under `liftstudio.dropbox` (refresh token; access tokens
auto-refresh). Nothing about sync is ever sent anywhere but Dropbox.

### Testing sync locally

- `tests/merge-test.html` — the merge rules (disjoint devices, same record edited on both,
  delete vs edit, old data without ids/timestamps, settings, seeded program, first sync…).
- `tests/sync-test.html` — the whole engine against an in-memory mock Dropbox with two
  simulated devices: sign-in URLs, first sync, two-device merge, 409 retry, offline →
  online, watch CSV import, team-root path fallback, token refresh/revocation, sign out.

Open either from the local server (e.g. http://localhost:8781/tests/merge-test.html);
every row should say PASS.

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
  plus Apple Watch import (see `watch-sync.md`): with Dropbox sync on, the CSV a Shortcuts
  automation saves to Dropbox is imported automatically; without it, pick the file (or
  Health Auto Export JSON) via the iOS file picker. Maps Health types to app kinds, keeps
  avg HR + calories, dedupes against prior imports and manual entries.
- **Coach tab** — one-tap markdown Coach Report (targets, recent sessions, progression
  events, cardio, auto-flags for stalls/grinds/pain) to paste to Claude; Dropbox sync;
  settings (bar weight, plate inventory, rest times); manual JSON backup.

## Files

- `index.html` — shell, tab bar, rest-timer bar
- `styles.css` — dark, mobile-first
- `program.js` — `SEED_PROGRAM`: TJ's split, weights, increments, settings defaults
- `config.js` — Dropbox app key + sync paths
- `state.js` — state shape, `normalize()` load/import migration (schema v3)
- `sync-merge.js` — pure merge of two states (no DOM/network)
- `dropbox-sync.js` — Dropbox OAuth (PKCE) + sync engine
- `app.js` — progression logic, rendering, coach report, sync UI
- `sw.js` — service worker (network-first offline cache; never touches Dropbox calls)
- `tests/` — merge + sync engine test pages
- `manifest.webmanifest`, `icons/` — home-screen install metadata + icons

Storage key: `liftstudio.v1`. Seed merges forward: new exercises added to `program.js`
appear for existing users without wiping data. Schema changes are additive only: v3 added
record `id`/`updatedAt`, `tombstones`, `settingsTs`, per-exercise `fieldTs` and
`activeUpdatedAt`; older data is upgraded on load (records without ids get a
deterministic content-hash id, so the same old record on two devices doesn't duplicate).

## Planned

- Auto-sync workout logs into the Obsidian vault (`_Projects/Fitness Coach & Tracker.md`
  living-document plan) so Claude reads history without a manual copy step. (Claude can
  already read the synced JSON straight from Dropbox.)
