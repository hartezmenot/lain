'use strict';

/**
 * ONE SPELLING OF A PROJECT'S FOLDER. Windows hands out the same folder as an 8.3 short name (C:\Users\HARTEZ~1\…, the
 * default TEMP) and as its long name; a dev server's file watcher (libuv fs-event: Next, Vite's chokidar) compares the
 * folder it was started in with the long names its events carry, and asserts or misses when they differ. So every
 * root Design keeps is the long real path — resolved once, where a project is opened.
 */

const fs = require('fs');
const path = require('path');

function longPath(p) {
  const abs = path.resolve(String(p == null ? '.' : p));
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

module.exports = { longPath };
