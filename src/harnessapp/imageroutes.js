'use strict';

/** THE IMAGE VIEWER'S ROUTES. */

const viewer = require('../imageviewer');

const ok = (body = {}) => ({ code: 200, body: { ok: true, ...body } });
const bad = (why, code = 400) => ({ code, body: { ok: false, why } });

const ROUTES = {
  /** THE BYTES, BASE64, WITH WHAT IS KNOWN ABOUT THEM. */
  'POST /api/image/read': async (app, body = {}) => {
    const rec = viewer.find(app, body.ref);
    if (!rec) return bad('that image is not on this session\'s shelf', 404);
    const bytes = viewer.bytes(app, body.ref);
    if (!bytes) return bad('the image could not be read — it may have been swept', 410);
    return ok({ image: { ...viewer.publicRecord(rec), data: bytes.toString('base64') } });
  },

  'POST /api/image/external': async (app, body = {}) => {
    const rec = viewer.find(app, body.ref);
    if (!rec) return bad('that image is not on this session\'s shelf', 404);
    const { spawn } = require('child_process');
    try {
      if (process.platform === 'win32') {
        // The empty title argument is required: `start "path"` treats a single
        // quoted argument as the window title and opens nothing.
        spawn('cmd', ['/c', 'start', '', rec.file], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [rec.file], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [rec.file], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) {
      return bad(`no viewer could be opened: ${(e && e.message) || e}`);
    }
    return ok({ how: 'default-viewer' });
  },

  'POST /api/image/close': async (app) => { viewer.close(app); return ok(); },

  // THE CLIPBOARD, AND THERE IS ONLY ONE OF THEM
  'POST /api/clipboard/read': async () => {
    const r = require('../copy').fromClipboard();
    return r.ok ? ok({ text: r.text }) : bad(r.error || 'the clipboard could not be read');
  },
  'POST /api/clipboard/write': async (app, body = {}) => {
    const r = require('../copy').toClipboard(String(body.text == null ? '' : body.text));
    return r.ok ? ok({ how: r.how }) : bad(r.error || 'the clipboard could not be written');
  },
};

module.exports = { ROUTES };
