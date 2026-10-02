'use strict';

/**
 * WHAT IS INSTALLED (packaging pass §D). LAIN CLI (Core, CLI, Model Dashboard, Preview window) is the base and is
 * always present; LAIN Harness is an optional component recorded by the installer in <install>/components.json.
 * A development checkout (no launcher, no install root) has everything.
 */

const fs = require('fs');
const path = require('path');

function read() {
  const root = process.env.LAIN_INSTALL_ROOT;
  if (!root) return { installed: false, cli: true, harness: true, root: null };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'components.json'), 'utf8')) || {};
    return { installed: true, cli: true, harness: c.harness === true, root, path: c.path === true, openWith: c.openWith === true, openFolder: c.openFolder === true };
  } catch { return { installed: true, cli: true, harness: false, root }; }
}

function harness() { return read().harness; }

const NOT_INSTALLED = 'LAIN Harness is not installed. Add it with the LAIN installer (Settings › Apps › LAIN › Modify, or run LAIN-Setup again). The CLI, the Model Dashboard (lain model) and the Preview (lain preview) work without it.';

module.exports = { read, harness, NOT_INSTALLED };
