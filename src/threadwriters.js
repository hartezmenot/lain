'use strict';

/** ONE WRITER PER EXTERNAL THREAD. */

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

/** Move a thread from one instance to another. */
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
