'use strict';

/**
 * LOOKING AT AN IMAGE — the escape hatch from "a terminal cannot show you this".
 *
 * "ASCII representation is not visual evidence." LAIN already
 * refuses to pretend — an image in a tool result is reported as a real path,
 * real dimensions and a real format, with `NOT SEEN` said plainly (ui/images.js).
 * That is honest, and on its own it is a dead end: the one thing a person wants
 * at that moment is to LOOK, and there was no way to.
 *
 * So this SHOWS it — in LAIN's own window, which is the product the person is
 * already looking at. Where there is no window (a plain terminal session), it
 * hands the IMAGE ITSELF to the machine's viewer, which is what a person would
 * have done by hand.
 *
 * ------------------------------------------------------------------------
 * IT NO LONGER GENERATES AN HTML PAGE, AND THAT WAS THE WHOLE BUG.
 *
 * This used to write `<config>/visual/view/view-<timestamp>.html` — an `<img>`
 * tag wrapped in markup — and hand that file to the default viewer, which on
 * Windows is a BROWSER. So "show me shot.png" opened a browser tab pointed at a
 * generated file:// page, put browser-era architecture in the path of the
 * native application, and left the page on disk forever. Observed in the wild
 * as `.../lain-test-home-.../visual/view/view-1789468899258.html`.
 *
 * A PNG needs no markup to be looked at. See src/imageviewer.js.
 *
 * IT NEVER CLAIMS THE PICTURE WAS SEEN. Opening a window is not looking at one,
 * and that difference is the whole of the evidence discipline here: this gives a
 * person the CHANCE to look, and records only which window was opened. A
 * judgment, if one is wanted, is something the person says afterwards.
 *
 * IT WRITES NOTHING ANYWHERE. The image is read; nothing is generated. Where a
 * task is running the picture is ADOPTED as that task's artifact, which is a
 * copy into the project's own evidence area rather than scaffolding.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const images = require('./ui/images');

/**
 * The images LAIN has actually seen mentioned, newest first.
 *
 * Read from the OUTPUT surface that already exists rather than from a new list
 * kept for this: a second record of the same thing is a second thing to keep in
 * step, and this one is already what the user is looking at.
 */
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

/**
 * Open one image for a person to look at.
 *
 * @returns {{ok, how, file, ref, why, facts}}
 *   `how` is 'harness' when LAIN's own window is showing it, or
 *   'default-viewer' when there is no window and the machine's image viewer
 *   was handed the file. (A 'lain-chromium' value was removed with the browser
 *   in 2026-09; the generated-HTML page went in 2026-09-16.)
 */
async function open(app, file, { launch = null } = {}) {
  const target = path.resolve(String(file || ''));
  if (!fs.existsSync(target)) {
    return { ok: false, how: null, file: target, why: 'there is no file at that path' };
  }
  if (!images.isImage(target)) {
    return { ok: false, how: null, file: target, why: 'that is not an image Noema can measure' };
  }
  const facts = images.describe(target);
  if (facts.ok) facts.kind = format(target);

  // ---- LAIN'S OWN WINDOW FIRST -----------------------------------------
  //
  // It is the native product; it can fit, zoom and say where the picture came
  // from; and it does not put a browser in the path of the application.
  const viewer = require('./imageviewer');
  if (viewer.windowed(app)) {
    const offered = viewer.offer(app, target, { note: 'opened to be looked at' });
    if (offered.ok) {
      viewer.show(app, offered.ref);
      return { ok: true, how: 'harness', file: target, ref: offered.ref, facts };
    }
  }

  // ---- OTHERWISE, THE MACHINE'S OWN VIEWER, ON THE IMAGE ITSELF ---------
  //
  // Not a wrapper page: the file. Windows opens a .png in the image viewer and
  // a .html in a browser, which is how the old wrapper turned "look at this
  // screenshot" into "open a browser tab".
  // OPENING A WINDOW IS INJECTABLE, AND ONLY TESTS INJECT IT. A suite that
  // exercises this path otherwise opens a real image viewer on the developer's
  // desktop on every run — several of them, once there are several cases.
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
