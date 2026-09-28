/* Lift Studio — deployment config. See README "Dropbox sync" for setup. */

// Dropbox app key ("App key" on the app's Settings page at dropbox.com/developers/apps).
// It is a public client id (PKCE, no secret), safe to commit. Empty = sync switched off:
// the app shows "Sync not configured yet" and works exactly as a local-only app.
const DROPBOX_APP_KEY = '';

// Where the data lives in TJ's Dropbox (his member folder = the API's home namespace).
// If "/TJ/Fitness" isn't found there, sync retries against the team root under "/TJ Mitchell".
const DROPBOX_CHECK_FOLDER = '/TJ/Fitness';
const DROPBOX_DATA_PATH = '/TJ/Fitness/Lift Studio/lift-studio-data.json';
const DROPBOX_WATCH_PATH = '/TJ/Fitness/watch-workouts.csv';
const DROPBOX_TEAM_PREFIX = '/TJ Mitchell';
