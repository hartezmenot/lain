'use strict';

/**
 * WHAT IS INSTALLED (packaging pass §D). Noema CLI (Core, CLI, Model Dashboard, Preview window) is the base and is
 * always present; Noema Harness is an optional component recorded by the installer in <install>/components.json.
 * A development checkout (no launcher, no install root) has everything.
 */

const fs = require('fs');
const path = require('path');

function read() {
  const root = process.env.NOEMA_INSTALL_ROOT;
  if (!root) return { installed: false, cli: true, harness: true, root: null };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'components.json'), 'utf8')) || {};
    return { installed: true, cli: true, harness: c.harness === true, root, path: c.path === true, openWith: c.openWith === true, openFolder: c.openFolder === true };
  } catch { return { installed: true, cli: true, harness: false, root }; }
}

function harness() { return read().harness; }

const NOT_INSTALLED = 'Noema Harness is not installed. Add it with the Noema installer (Settings › Apps › Noema › Modify, or run Noema-Setup again). The CLI, the Model Dashboard (noema model) and the Preview (noema preview) work without it.';

module.exports = { read, harness, NOT_INSTALLED };
