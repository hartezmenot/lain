'use strict';

/**
 * ONE WRITER PER EXTERNAL THREAD.
 *
 * A native Codex thread in a shared session store is visible to every account
 * instance that reads that store. Two app-servers both resumed on it would both
 * write turns into it — interleaved, and each believing it owns the history.
 * So exactly one instance holds a thread at a time, and moving it is a handoff:
 *
 *   1. both are blocked         the record says `handoff`
 *   2. detach                   the holder unsubscribes (thread/unsubscribe)
 *   3. confirm released         the holder's runtime no longer lists it loaded
 *   4. attach                   the new instance resumes it (thread/resume)
 *
 * If 3 cannot be confirmed, nothing moves and the holder keeps it. If 4 fails,
 * the old holder is re-attached. A handoff is only possible between instances
 * of the same driver that read the same store (same session-store key).
 *
 * HELD IN MEMORY, MIRRORED TO DISK so another LAIN process sees who holds what.
 * A record from a process that is gone is stale and can be taken over.
 */

const fs = require('fs');
const path = require('path');

function file() { return path.join(require('./config').configDir(), 'accounts', 'writers.json'); }
function read() { try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); return d && d.threads ? d : { version: 1, threads: {} }; } catch { return { version: 1, threads: {} }; } }
function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(d, null, 2));
  fs.renameSync(`${file()}.tmp`, file());
}
function alive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function keyOf(storeKey, threadId) { return `${storeKey}#${threadId}`; }

function holder(storeKey, threadId) {
  const r = read().threads[keyOf(storeKey, threadId)];
  if (!r) return null;
  if (!alive(r.pid)) return { ...r, stale: true };
  return r;
}

/** Take a thread for an instance, or say who has it. */
function acquire(threadId, inst) {
  const d = read();
  const k = keyOf(inst.storeKey, threadId);
  const r = d.threads[k];
  if (r && alive(r.pid) && r.instanceId !== inst.id) return { ok: false, why: r.state === 'handoff' ? 'this thread is being handed over' : `another account (${r.instanceId}) is writing to this thread`, holder: r.instanceId };
  d.threads[k] = { threadId, instanceId: inst.id, driver: inst.driver, storeKey: inst.storeKey, pid: process.pid, since: Date.now(), state: 'attached' };
  write(d);
  return { ok: true };
}

function release(threadId, inst) {
  const d = read();
  const k = keyOf(inst.storeKey, threadId);
  if (d.threads[k] && d.threads[k].instanceId === inst.id) { delete d.threads[k]; write(d); return true; }
  return false;
}

/**
 * Move a thread from one instance to another. `from`/`to` are
 * { id, driver, storeKey, handle } where handle has detachThread,
 * loaded and attachThread (the Codex instance handle does).
 */
async function handoff(threadId, from, to, { confirmMs = 5000 } = {}) {
  if (from.driver !== to.driver) return { ok: false, why: 'a thread moves only between accounts of the same runtime' };
  if (from.storeKey !== to.storeKey) return { ok: false, why: 'these accounts do not read the same session store; the thread cannot continue there' };
  const d = read();
  const k = keyOf(from.storeKey, threadId);
  const r = d.threads[k];
  // ONLY THE HOLDER HANDS OVER. A "handoff" from an account that does not hold
  // the thread would be a second writer attaching under another name.
  if (!r || r.instanceId !== from.id || !alive(r.pid)) {
    if (r && alive(r.pid)) return { ok: false, why: `the thread is held by ${r.instanceId}, not ${from.id}` };
    return { ok: false, why: `${from.id} does not hold this thread; nothing to hand over` };
  }
  d.threads[k] = { threadId, instanceId: from.id, to: to.id, driver: from.driver, storeKey: from.storeKey, pid: process.pid, since: Date.now(), state: 'handoff' };
  write(d);
  const steps = [];
  const back = (why) => {
    const d2 = read(); d2.threads[k] = { threadId, instanceId: from.id, driver: from.driver, storeKey: from.storeKey, pid: process.pid, since: Date.now(), state: 'attached' }; write(d2);
    return { ok: false, why, steps };
  };
  try { await from.handle.detachThread(threadId); steps.push('detached'); }
  catch (e) { return back(`the current account did not let go: ${e.message}`); }
  const end = Date.now() + confirmMs;
  let released = false;
  while (Date.now() < end) {
    let loaded = [];
    try { loaded = await from.handle.loaded(); } catch { loaded = []; }
    if (!loaded.includes(threadId)) { released = true; break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!released) {
    try { await from.handle.attachThread(threadId); } catch { /* it never let go */ }
    return back('the current account still has the thread loaded; nothing moved');
  }
  steps.push('confirmed released');
  try { await to.handle.attachThread(threadId); steps.push('attached'); }
  catch (e) {
    try { await from.handle.attachThread(threadId); steps.push('re-attached to the original'); } catch { steps.push('the original could not re-attach'); }
    return back(`the new account could not resume it: ${e.message}`);
  }
  const d3 = read();
  d3.threads[k] = { threadId, instanceId: to.id, driver: to.driver, storeKey: to.storeKey, pid: process.pid, since: Date.now(), state: 'attached', from: from.id };
  write(d3);
  return { ok: true, steps, holder: to.id };
}

function list() { return Object.values(read().threads).map((r) => ({ ...r, stale: !alive(r.pid) })); }

module.exports = { acquire, release, handoff, holder, list };
