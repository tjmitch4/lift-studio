/* Lift Studio — deployment config. See README "GitHub sync" for setup. */

// Private data repo shared with Guitar Studio (Lift Studio only touches lift/).
const GITHUB_OWNER = 'tjmitch4';
const GITHUB_REPO = 'studio-data';
const GITHUB_BRANCH = 'main';
const GITHUB_PREFIX = 'lift/';

// Where the fine-grained token lives in localStorage. The SAME key in Guitar Studio: both apps
// are served from tjmitch4.github.io, so pasting the token once in a browser covers both.
const GITHUB_TOKEN_KEY = 'studioData.githubToken';
const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
