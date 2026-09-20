'use strict';

/**
 * THE IMAGE VIEWER'S ROUTES.
 *
 * Three verbs, and deliberately no fourth:
 *
 *   read      the bytes of an image THIS SESSION OFFERED, by reference
 *   external  hand that same image to the machine's own viewer, on request
 *   close     put the viewer away
 *
 * THERE IS NO "read this path". The renderer names `img_<hex>`, never a file,
 * and the only references that resolve are ones LAIN itself put on the shelf —
 * a screenshot a tool just took, a file the person named to `/image`. A route
 * that accepted a path would read any file on the machine for anything that
 * could reach it. See src/imageviewer.js.
 *
 * `external` is the SECONDARY action. The native viewer is where a picture is
 * looked at; opening it elsewhere is a thing a person may ask for, not the
 * default, and never something LAIN does on its own.
 */

const viewer = require('../imageviewer');

const ok = (body = {}) => ({ code: 200, body: { ok: true, ...body } });
const bad = (why, code = 400) => ({ code, body: { ok: false, why } });

const ROUTES = {
  /**
   * THE BYTES, BASE64, WITH WHAT IS KNOWN ABOUT THEM.
   *
   * Base64 in a JSON reply rather than a file:// URL or a static file server:
   * the renderer has no file access and LAIN is not serving a directory. It is
   * the same arrangement `/api/cowork/artifact` uses for Cowork's own files.
   */
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

  // ---- THE CLIPBOARD, AND THERE IS ONLY ONE OF THEM --------------------
  //
  // The window's context menu needs Copy and Paste (see pagemenu.js for why the
  // release build has no menu of its own). It does NOT get them from the
  // renderer: `execCommand('paste')` is blocked in Chromium, and
  // `navigator.clipboard` depends on a permission prompt this window should
  // never show. Both would also be a second clipboard authority beside
  // `src/copy.js`, which is the one place text is sanitised on the way out —
  // the invisible characters that make a pasted command fail to run.
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
