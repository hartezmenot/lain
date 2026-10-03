'use strict';

/** LOOKING AT AN IMAGE — the escape hatch from "a terminal cannot show you this". */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const images = require('./ui/images');

/** The images LAIN has actually seen mentioned, newest first. */
function recent(app, limit = 10) {
  const panes = require('./ui/panes');
  const outputs = (app && app.ui && app.ui.outputs) || [];
  const found = [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    for (const f of panes.imagesIn(outputs[i])) {
      if (!found.includes(f)) found.push(f);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** What the file claims to be. `describe` measures the pixels; this names the kind. */
function format(file) {
  return (path.extname(String(file)).replace('.', '') || '?').toUpperCase();
}

/** Open one image for a person to look at. */
async function open(app, file, { launch = null } = {}) {
  const target = path.resolve(String(file || ''));
  if (!fs.existsSync(target)) {
    return { ok: false, how: null, file: target, why: 'there is no file at that path' };
  }
  if (!images.isImage(target)) {
    return { ok: false, how: null, file: target, why: 'that is not an image LAIN can measure' };
  }
  const facts = images.describe(target);
  if (facts.ok) facts.kind = format(target);

  // LAIN'S OWN WINDOW FIRST
  const viewer = require('./imageviewer');
  if (viewer.windowed(app)) {
    const offered = viewer.offer(app, target, { note: 'opened to be looked at' });
    if (offered.ok) {
      viewer.show(app, offered.ref);
      return { ok: true, how: 'harness', file: target, ref: offered.ref, facts };
    }
  }

  // OTHERWISE, THE MACHINE'S OWN VIEWER, ON THE IMAGE ITSELF
  try {
    if (launch) launch(target);
    else if (process.platform === 'win32') {
      // The empty title argument is required: `start "path"` treats a single
      // quoted argument as the window title and opens nothing.
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, how: 'default-viewer', file: target, facts };
  } catch (e) {
    return {
      ok: false, how: null, file: target, facts,
      why: `no viewer could be opened (${e.message}) — the file is at the path above`,
    };
  }
}

module.exports = { open, recent, format };
