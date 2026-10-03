'use strict';

/**
 * THE MODEL'S POINTER AND KEYBOARD — for the LAIN Preview, and nothing else (packaging pass §L).
 *
 *   tool call (preview click …) ──▶ this queue ──▶ the Preview surface that is open (the Harness, or the standalone
 *   Preview window a CLI opens) fetches it (POST /api/preview/input/next) ──▶ posts it to the page's bridge
 *   (workshop/bridge.js `act`) ──▶ DOM events inside the preview document ──▶ the result comes back
 *   (POST /api/preview/input/result) and the tool call returns it.
 *
 * THE BOUNDARY IS STRUCTURAL: there is no OS input here at all — no SendInput, no window messages, no other process.
 * The only thing that can execute an action is the bridge script inside the project's own page, which refuses what
 * would leave the Preview (system file pickers, downloads, other sites, new windows, credential fields).
 * Every action is marked MODEL and recorded; the person's own input makes the model wait (bridge.js).
 */

const crypto = require('crypto');

const ACTIONS = Object.freeze(['pointer_move', 'click', 'double_click', 'pointer_down', 'pointer_up', 'drag', 'scroll', 'key', 'key_chord', 'type_text', 'read']);
const WAIT_MS = 40000;   // the window waits up to 20 s for a loading page, then 15 s for the answer
const SURFACE_MS = 15000;

function stateOf(app) {
  if (!app._previewInput) app._previewInput = { queue: [], waiting: new Map(), pollers: [], log: [], surfaceAt: 0 };
  return app._previewInput;
}

/** A Preview surface is attached when one asked for input recently (it long-polls while open). */
function attached(app, now = Date.now()) { const s = stateOf(app); return s.pollers.length > 0 || now - s.surfaceAt < 5000; }

/** THE MODEL ASKS: resolves with the bridge's answer, or a structured failure. */
function run(app, action, { timeoutMs = WAIT_MS } = {}) {
  const s = stateOf(app);
  if (!ACTIONS.includes(action.action)) return Promise.resolve({ ok: false, why: `unknown preview action ${action.action}` });
  const cmd = { ...action, id: crypto.randomBytes(8).toString('hex'), origin: 'MODEL', at: Date.now() };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { s.waiting.delete(cmd.id); s.queue = s.queue.filter((q) => q.id !== cmd.id); resolve({ ok: false, why: 'the Preview did not answer — is it open and showing the page?' }); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    s.waiting.set(cmd.id, (r) => { clearTimeout(timer); resolve(r); });
    const poller = s.pollers.shift();
    if (poller) poller(cmd); else s.queue.push(cmd);
  });
}

/** THE SURFACE ASKS for the next action (long-poll, bounded). */
function next(app, { waitMs = SURFACE_MS } = {}) {
  const s = stateOf(app);
  s.surfaceAt = Date.now();
  if (s.queue.length) return Promise.resolve(s.queue.shift());
  return new Promise((resolve) => {
    const done = (cmd) => { clearTimeout(t); resolve(cmd); };
    const t = setTimeout(() => { s.pollers = s.pollers.filter((p) => p !== done); resolve(null); }, waitMs);
    if (typeof t.unref === 'function') t.unref();
    s.pollers.push(done);
  });
}

/** THE SURFACE ANSWERS. */
function result(app, id, r) {
  const s = stateOf(app);
  const w = s.waiting.get(String(id || ''));
  if (!w) return false;
  s.waiting.delete(String(id));
  s.log.push({ at: Date.now(), origin: 'MODEL', ok: Boolean(r && r.ok), why: r && r.why ? String(r.why).slice(0, 160) : null });
  if (s.log.length > 100) s.log.shift();
  w(r || { ok: false, why: 'empty answer' });
  return true;
}

module.exports = { ACTIONS, run, next, result, attached, stateOf };
