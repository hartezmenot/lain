'use strict';

/** WHAT IS CURRENTLY HELD DOWN — and the promise that it comes back up. */

/** key (upper-case) -> { release, at, why } */
const held = new Map();

let armed = false;

/** Nothing may hang the exit path. A release that stalls is abandoned. */
const RELEASE_MS = 1500;

/** Record that a key went down, with the means to lift it. */
function down(key, release, why = '') {
  const k = String(key || '').trim().toUpperCase();
  if (!k || typeof release !== 'function') return null;
  held.set(k, { release, at: Date.now(), why: String(why || '') });
  arm();
  return k;
}

/** Record that a key came up. Never throws — an unknown key is simply not held. */
function up(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!k) return false;
  return held.delete(k);
}

/** What is down right now, for /status, the report and the final audit. */
function list() {
  return [...held.entries()].map(([key, v]) => ({ key, heldMs: Date.now() - v.at, why: v.why }));
}

/** LIFT EVERYTHING. The one operation the exit path needs. */
async function releaseAll(why = 'shutting down') {
  const entries = [...held.entries()];
  held.clear();
  const released = [];
  const failed = [];
  for (const [key, v] of entries) {
    try {
      await Promise.race([
        Promise.resolve(v.release(why)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('release timed out')), RELEASE_MS)),
      ]);
      released.push(key);
    } catch (e) {
      failed.push({ key, error: (e && e.message) || 'release failed' });
    }
  }
  return { released, failed };
}

/** The synchronous half, for `process.on('exit')`. */
function warnIfStillHeld() {
  if (!held.size) return '';
  const keys = [...held.keys()].join(', ');
  return `LAIN exited with ${keys} still held down. Press and release ${keys} to clear it.`;
}

/** Attach the exit handlers, once. */
function arm() {
  if (armed) return;
  armed = true;
  const flush = async (why) => {
    if (!held.size) return;
    const r = await releaseAll(why);
    if (r.failed.length) {
      process.stderr.write(`could not release ${r.failed.map((f) => f.key).join(', ')} — press them by hand\n`);
    }
  };
  // beforeExit CAN await, and is where an ordinary end-of-run lands.
  process.once('beforeExit', () => { flush('LAIN is finishing').catch(() => {}); });
  // 'exit' cannot. All that is left is to tell the person.
  process.once('exit', () => {
    const msg = warnIfStillHeld();
    if (msg) process.stderr.write(`${msg}\n`);
  });
}

/** For tests and for a fresh process: forget everything without releasing. */
function reset() { held.clear(); }

module.exports = { down, up, list, releaseAll, warnIfStillHeld, reset, RELEASE_MS };
