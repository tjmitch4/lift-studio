# Apple Watch → Lift Studio

Workouts tracked on the watch (hoops, tennis, rows, runs) land in Apple Health. An iOS
Shortcut exports the last week of them and uploads the file to
`lift/inbox/` in the private `tjmitch4/studio-data` GitHub repo. The next time Lift Studio
syncs on any device, it imports the file into the Cardio tab (and the Coach Report /
`lift/COACH.md`), then deletes it from the inbox in the same commit.

Running the shortcut repeatedly is harmless: imports are deduped, and a watch entry you
deleted in the app never comes back.

## 1. A token for the Shortcut (once)

Make a separate fine-grained token so the phone's Shortcut can be revoked on its own:
https://github.com/settings/personal-access-tokens/new → name **Watch shortcut** →
Repository access **Only select repositories → studio-data** → Repository permissions
**Contents: Read and write** → Generate, copy. (The token you pasted into the apps works
too, but then revoking one revokes both.) The Shortcut stores it in plain text — don't
share the Shortcut.

## 2. The Shortcut (build once, ~10 min)

On the iPhone, open **Shortcuts** → **+**, name it **Sync Workouts**:

1. **Find Workouts** (the Health action; may appear as *Find All Workouts where*). Filter:
   **Start Date** → **is in the last** → **7 days**. Sort by Start Date, Latest First. No limit.
2. **Repeat with Each** over the workouts. Inside it, a **Text** action with one line built
   from the *Repeat Item*'s details:
   `[Start Date],[Workout Type],[Duration],[Active Energy],[Average Heart Rate]`
   - **Start Date**: tap the variable → Date Format **Custom** → `yyyy-MM-dd HH:mm`
   - Duration / Energy / Heart Rate: whatever detail names your iOS version offers — the
     importer strips units and understands `1h 5m`, `mm:ss`, seconds or minutes.
3. Still inside the repeat: **Add to Variable** → `lines`.
4. After the repeat: **Combine Text** → `lines` with **New Lines**.
5. **Base64 Encode** the Combined Text (tap the action's chevron → **Line Breaks: None**).
6. **Format Date** → **Current Date** → Custom `yyyy-MM-dd-HHmm`.
7. **Get Contents of URL**:
   - URL: `https://api.github.com/repos/tjmitch4/studio-data/contents/lift/inbox/watch-[Formatted Date].csv`
   - Method: **PUT**
   - Headers:
     - `Authorization` → `Bearer <paste the token>`
     - `Accept` → `application/vnd.github+json`
     - `X-GitHub-Api-Version` → `2022-11-28`
   - Request Body: **JSON**
     - `message` (Text) → `watch: workouts export`
     - `content` (Text) → the **Base64 Encoded** result
     - `branch` (Text) → `main`

Run it after a workout — as a Home Screen / Lock Screen widget, a watch complication, or a
**Personal Automation** (e.g. every night at 21:00, *Run Immediately*).

The filename includes the time so each run creates a new file (the Contents API refuses to
overwrite an existing file without its sha). If you'd rather use a date-only name
(`watch-2026-09-28.csv`), a second run on the same day fails until Lift Studio has synced
and emptied the inbox — harmless, just run it again later.

A successful run returns JSON with `"content": { "path": "lift/inbox/…" }`. A 401 means the
token is wrong or expired; 404 means the token can't see `studio-data`; 403 means it's
read-only.

## 3. Nothing else to do

Open Lift Studio on any connected device (or wait for its 2-minute sync while open). A toast
says *Imported N Apple Watch workouts*, and the entries appear in Cardio with a *watch*
pill. The importer:

- maps Health types → app kinds: Basketball→Hoops, Tennis/Pickleball→Tennis,
  Rowing→Row, Running→Run, Walking/Hiking→Walk, anything else→Other (raw name kept as the note)
- keeps avg heart rate + active calories (shown in the list, aggregated in the Coach Report)
- skips anything already imported, and manual entries that look like the same workout
  (same day + kind, within 5 min)
- never re-imports a watch entry you deleted in the app (on any device)
- leaves a file it can't read in `lift/inbox/` and lists it in the Sync card instead of
  deleting it

## Without sync

Lift Studio → **Cardio** → **Apple Watch → Import** → pick an exported file from the Files
app. Same importer, same dedupe. Change step 7 to **Save File** (e.g. to iCloud Drive) for
this route.

## Alternative: Health Auto Export app

The App Store app **Health Auto Export — JSON+CSV** can export **Workouts** as **JSON** on a
schedule. The importer accepts its format (`data.workouts[...]`), either picked by hand in
the Cardio tab or uploaded to `lift/inbox/` with the same PUT request as above.
