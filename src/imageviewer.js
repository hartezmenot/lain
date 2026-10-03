'use strict';

/** AN IMAGE, IN LAIN'S OWN WINDOW. */

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

/** ADOPT IT AS A TASK ARTIFACT, if there is a task to adopt it into. */
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

/** OFFER AN IMAGE TO THE WINDOW. */
function offer(app, file, { note = '', provenance = '' } = {}) {
  const target = path.resolve(String(file || ''));
  if (!fs.existsSync(target)) return { ok: false, why: 'there is no file at that path' };
  if (!images.isImage(target)) return { ok: false, why: 'that is not an image LAIN can measure' };

  // THE SAME PICTURE TWICE IS ONE PICTURE.
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

/** What may be told to the renderer. */
function publicRecord(rec) {
  if (!rec) return null;
  return {
    ref: rec.ref, name: rec.name, mime: rec.mime, width: rec.width, height: rec.height,
    bytes: rec.bytes, kind: rec.kind, path: rec.origin, adopted: Boolean(rec.artifact),
    taskId: rec.artifact ? rec.artifact.taskId : '', provenance: rec.provenance, at: rec.at,
  };
}

/** PUT ONE ON SCREEN — and tell the window at once rather than at the next poll. */
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

/** IS THERE A WINDOW THAT WOULD ACTUALLY SHOW *THIS* SESSION'S PICTURE? */
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
