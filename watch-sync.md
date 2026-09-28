# Apple Watch → Lift Studio sync

Workouts tracked on the watch (hoops, tennis, rows, runs) land in Apple Health.
This gets them into Lift Studio's Cardio tab — and into the Coach Report — with one tap.

## The Shortcut (build once, ~10 min)

On the iPhone, open **Shortcuts** → **+** to create a new shortcut, name it **Sync Workouts**:

1. **Find Workouts** (search "workout" — the Health action, may appear as
   *Find All Workouts where*). Add filter: **Start Date** → **is in the last** → **7 days**.
   Sort by Start Date, Latest First. Uncheck any limit.
2. **Text** — inside a *Repeat with Each* over the workouts (Shortcuts adds the repeat
   automatically when you use the repeat variable). One line, using magic variables from
   the *Repeat Item*:
   `[Start Date],[Workout Type],[Duration],[Active Energy],[Average Heart Rate]`
   - For **Start Date**: tap the variable → Format: **Custom** → `yyyy-MM-dd HH:mm`
   - Duration/Energy/Heart Rate: whatever detail names your iOS version offers is fine —
     the importer strips units and handles `mm:ss`, seconds, or minutes.
3. **Add to Variable** → variable name `lines` (still inside the repeat).
4. After the repeat: **Combine Text** — combine `lines` with **New Lines**.
5. **Save File** → the Combined Text → destination **Dropbox** (or Files → Dropbox) →
   path `TJ Mitchell/TJ/Fitness/` → name `watch-workouts.csv` → turn **Overwrite** ON
   and **Ask Where to Save** OFF.

Run it after a workout (add it as a widget/watch complication, or a personal automation
on a nightly schedule). Because it always exports the last 7 days and Lift Studio
dedupes, running it repeatedly is harmless.

## Importing

Lift Studio → **Cardio** tab → **Apple Watch → Import** → pick `watch-workouts.csv`
from Dropbox. The importer:

- maps Health types → app kinds: Basketball→Hoops, Tennis/Pickleball→Tennis,
  Rowing→Row, Running→Run, Walking/Hiking→Walk, anything else→Other (raw name kept
  as the note)
- keeps avg heart rate + active calories (shown in the list, aggregated in the
  Coach Report)
- skips anything already imported, and skips manual entries that look like the same
  workout (same day + kind, within 5 min duration)

On the Mac, the same file sits in Dropbox at `TJ Mitchell/TJ/Fitness/watch-workouts.csv`,
so Claude can read it directly during coaching even before an import.

## Alternative: Health Auto Export app

The App Store app **Health Auto Export — JSON+CSV** can do this on a schedule with no
Shortcut: create an automation exporting **Workouts** as **JSON** to Dropbox. The
importer accepts its JSON format too (`data.workouts[...]`).

## Later (GitHub backend)

Same shortcut, one change: replace **Save File** with **Get Contents of URL** (POST the
combined text to the backend). Imports then happen automatically — no file picking.
