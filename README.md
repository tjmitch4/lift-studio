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

Data still lives **per device, per browser** in `localStorage` (key `liftstudio.v1`).
The home-screen app, Safari on the phone, and the desktop browser each have their own
separate log. Use **Coach → Export JSON / Import JSON** to move data between devices
(on the home-screen app, Export opens the share sheet — pick *Save to Files* or AirDrop).
Cross-device sync is a planned next step. The Coach tab shows when you last exported a
backup, and the Workout tab nudges you when it has been more than 14 days.

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
  plus Apple Watch import (see `watch-sync.md`): picks the CSV a Shortcuts automation saves to
  Dropbox/iCloud Drive via the iOS file picker (or Health Auto Export JSON), maps Health types to app kinds, keeps avg HR +
  calories, dedupes against prior imports and manual entries.
- **Coach tab** — one-tap markdown Coach Report (targets, recent sessions, progression
  events, cardio, auto-flags for stalls/grinds/pain) to paste to Claude; JSON backup;
  settings (bar weight, plate inventory, rest times).

## Files

- `index.html` — shell, tab bar, rest-timer bar
- `styles.css` — dark, mobile-first
- `program.js` — `SEED_PROGRAM`: TJ's split, weights, increments, settings defaults
- `app.js` — state, progression logic, rendering, coach report
- `sw.js` — service worker (network-first offline cache)
- `manifest.webmanifest`, `icons/` — home-screen install metadata + icons

Storage key: `liftstudio.v1`. Seed merges forward: new exercises added to `program.js`
appear for existing users without wiping data.

## Planned (with the GitHub backend)

- Auto-sync workout logs into the Obsidian vault (`_Projects/Fitness Coach & Tracker.md`
  living-document plan) so Claude reads history without a manual copy step.
- Cross-device sync (phone ↔ Mac).
