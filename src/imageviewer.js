'use strict';

/**
 * AN IMAGE, IN LAIN'S OWN WINDOW.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO.
 *
 * Looking at a screenshot used to mean: write an HTML page into
 * `<config>/visual/view/view-<timestamp>.html` with an `<img>` in it, then hand
 * that file to the machine's default viewer — which on Windows is a BROWSER. So
 * "show me shot.png" opened a browser tab pointed at a generated file:// page,
 * and left the page on disk afterwards. Observed in the wild as
 * `.../lain-test-home-.../visual/view/view-1789468899258.html`.
 *
 * Three things were wrong with it. It generated markup to display a PNG, which
 * needs no markup. It put a browser in the path of the NATIVE application —
 * exactly the browser-era architecture the native Harness exists to replace.
 * And it accumulated files nobody ever deleted.
 *
 * The shape now is the one the product already has for everything else:
 *
 *     an image is produced
 *       → adopted as a task ARTIFACT, where there is a task
 *       → offered to the window by REFERENCE
 *       → drawn by the native viewer
 *
 * ------------------------------------------------------------------------
 * A REFERENCE, NEVER A PATH, AND THAT IS THE SECURITY OF IT.
 *
 * The renderer asks for `img_<hex>`. It cannot ask for `C:\Users\...\id_rsa`,
 * because the only things this will serve are the ones LAIN ITSELF offered
 * during this session — a screenshot a tool just took, a file the person named
 * to `/image`. A route that took a path would be a route that reads any file on
 * the machine as long as something can be talked into calling it.
 *
 * This is the same boundary `src/cowork/artifacts.js` draws for Cowork's owned
 * files, arrived at independently for the Harness's own images. It does not
 * touch that module: Cowork's artifact authority is Cowork's.
 *
 * ------------------------------------------------------------------------
 * THE OFFER IS NOT A CLAIM THAT ANYBODY LOOKED. Nothing here records a
 * judgment, and a picture on screen is still not evidence that a person read
 * it — see src/ui/images.js, which has always said NOT SEEN out loud.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const images = require('./ui/images');

/** How many images one session keeps readable. A viewer is not an archive. */
const MAX_OFFERED = 24;

/** What the window is allowed to fetch, and what it may be told about it. */
function shelf(app) {
  if (!app) return null;
  if (!app._imageShelf) app._imageShelf = new Map();
  return app._imageShelf;
}

function mimeFor(file) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  })[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

/**
 * ADOPT IT AS A TASK ARTIFACT, if there is a task to adopt it into.
 *
 * A screenshot written to a temporary directory is evidence with no owner: the
 * directory is swept, and the thing the verification rested on is gone. Copying
 * it into the task's own artifact area is what makes it survive, and gives the
 * viewer a provenance line worth showing.
 *
 * IT IS NOT REQUIRED. `/image somefile.png` on a session with no running task
 * is a person looking at a picture, and inventing a task to hold it would be
 * worse than not adopting it. Returns null, and the viewer shows the file.
 */
function adopt(app, file, { note = '' } = {}) {
  try {
    const link = require('./harnesslink').existing(app);
    const taskId = link && link.runtime && link.runtime.activeId;
    if (!taskId) return null;
    const body = fs.readFileSync(file);
    const rec = link.runtime.keep(taskId, {
      kind: 'screenshot', name: path.basename(file), body, note: String(note || '').slice(0, 200),
    });
    return rec ? { taskId, id: rec.id, path: rec.path, bytes: rec.bytes } : null;
  } catch {
    // ADOPTION IS A BONUS, NEVER A GATE. A store that refused (capacity, a dead
    // task, a read-only workspace) must not stop a person seeing their picture.
    return null;
  }
}

/**
 * OFFER AN IMAGE TO THE WINDOW.
 *
 * @returns {{ok:true, ref, record}|{ok:false, why}}
 */
function offer(app, file, { note = '', provenance = '' } = {}) {
  const target = path.resolve(String(file || ''));
  if (!fs.existsSync(target)) return { ok: false, why: 'there is no file at that path' };
  if (!images.isImage(target)) return { ok: false, why: 'that is not an image LAIN can measure' };

  // THE SAME PICTURE TWICE IS ONE PICTURE. A screenshot the tool just offered
  // and then `/image` on the same path must not adopt a second copy into the
  // task's artifacts — that is evidence duplicated, and capacity spent on it.
  //
  // EITHER PATH IS THE SAME PICTURE. Once adopted, the screenshot tool tells
  // the model the ARTIFACT path and deletes the temp original — so the path a
  // person then hands to `/image` is the served copy, not the one it was
  // offered under. Matching only the origin re-adopted the artifact into its
  // own task and dropped the provenance on the floor. Real paths, because the
  // same file arrives spelled with and without 8.3 short names.
  const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return String(p).toLowerCase(); } };
  const want = real(target);
  const map0 = shelf(app);
  if (map0) {
    for (const [ref, rec] of map0) {
      if (real(rec.origin) === want || real(rec.file) === want) {
        map0.delete(ref);
        map0.set(ref, rec);                  // newest again
        return { ok: true, ref, record: rec, reused: true };
      }
    }
  }

  const facts = images.describe(target);
  const artifact = adopt(app, target, { note });
  // THE ARTIFACT COPY IS THE ONE TO SERVE once there is one: the temporary
  // original may be swept while the window is still showing it.
  const serve = (artifact && artifact.path && fs.existsSync(artifact.path)) ? artifact.path : target;

  const ref = 'img_' + crypto.randomBytes(12).toString('hex');
  const record = {
    ref,
    file: serve,
    origin: target,
    name: path.basename(target),
    mime: mimeFor(target),
    width: facts.ok ? facts.width : 0,
    height: facts.ok ? facts.height : 0,
    bytes: facts.ok ? facts.bytes : 0,
    kind: (path.extname(target).replace('.', '') || '?').toUpperCase(),
    artifact: artifact ? { taskId: artifact.taskId, id: artifact.id } : null,
    provenance: String(provenance || '').slice(0, 300),
    at: Date.now(),
  };

  const map = shelf(app);
  if (!map) return { ok: false, why: 'there is no session to offer it to' };
  map.set(ref, record);
  // BOUNDED. Oldest first, because the one just produced is the one wanted.
  while (map.size > MAX_OFFERED) map.delete(map.keys().next().value);
  return { ok: true, ref, record };
}

function find(app, ref) {
  const map = shelf(app);
  const rec = map && map.get(String(ref || ''));
  return rec || null;
}

/** The bytes, re-read at request time — and only for something we offered. */
function bytes(app, ref) {
  const rec = find(app, ref);
  if (!rec) return null;
  try { return fs.readFileSync(rec.file); } catch { return null; }
}

/** What may be told to the renderer. The absolute path is included on purpose:
 *  this is LAIN's own window, shown to the person whose machine it is — the
 *  rule about paths is that they never reach a MODEL (see harnessapp/routes.js),
 *  not that a person may not see where their own screenshot went. */
function publicRecord(rec) {
  if (!rec) return null;
  return {
    ref: rec.ref, name: rec.name, mime: rec.mime, width: rec.width, height: rec.height,
    bytes: rec.bytes, kind: rec.kind, path: rec.origin, adopted: Boolean(rec.artifact),
    taskId: rec.artifact ? rec.artifact.taskId : '', provenance: rec.provenance, at: rec.at,
  };
}

/**
 * PUT ONE ON SCREEN — and tell the window at once rather than at the next poll.
 *
 * `ipc.wake` is why this is not "eventually": a person who asked to see a
 * picture should not watch a spinner for a poll interval. See the delay pass.
 */
function show(app, ref) {
  const rec = find(app, ref);
  if (!rec) return { ok: false, why: 'that image is not on this session\'s shelf' };
  app.viewing = ref;
  try { require('./harnessapp/ipc').wake(); } catch { /* no window is connected */ }
  return { ok: true, ref };
}

function current(app) {
  if (!app || !app.viewing) return null;
  return publicRecord(find(app, app.viewing));
}

function close(app) {
  if (app) app.viewing = null;
  try { require('./harnessapp/ipc').wake(); } catch { /* no window */ }
  return { ok: true };
}

/**
 * IS THERE A WINDOW THAT WOULD ACTUALLY SHOW *THIS* SESSION'S PICTURE?
 *
 * Two questions, and only asking the first is how a false claim gets printed.
 *
 *   1. is a window connected at all
 *   2. is that window LOOKING AT THIS SESSION
 *
 * A window connected to a sibling session is a window that will never draw
 * this — `viewing` is a field on one App, and the renderer reads the one it is
 * viewing. Reporting "opened in the LAIN window" in that case would be a
 * sentence about a picture nobody can see. See sessionpool.js, where separating
 * the viewed session from the executing one was the whole point.
 */
function windowed(app) {
  try {
    if (require('./harnessapp/ipc').status().clients < 1) return false;
  } catch { return false; }
  if (!app || !app.session) return false;
  try {
    const pool = require('./sessionpool').forApp(app);
    // NO POOL YET means one session, which is the one being viewed.
    if (!pool || !pool.viewId) return true;
    return pool.viewId === app.session.id;
  } catch { return true; }
}

module.exports = { offer, find, bytes, show, close, current, publicRecord, windowed, mimeFor, MAX_OFFERED };
