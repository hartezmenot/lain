'use strict';

/**
 * PROCESS OWNERSHIP — only what an owner started, verified by pid AND start time.
 *
 * The defect: 83 leaked supervisors, and the tempting cleanup ("kill everything
 * named lain-supervisor") would have killed somebody's real session. Each test
 * below pins one rule of src/runtimeregistry.js.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

function sleeper() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});
  return c;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; }

module.exports = async function () {
  const reg = require('../../src/runtimeregistry');
  const saved = { dir: process.env.LAIN_RUNTIME_DIR, owner: process.env.LAIN_RUN_OWNER };
  process.env.LAIN_RUNTIME_DIR = isolation.tmp('runtime-reg-');
  process.env.LAIN_RUN_OWNER = 'harness-test:unit-owner-A';
  const extra = [];
  try {
    await test('RUNTIME: an owner stops only what it registered — a same-name unrelated process survives', async () => {
      const a1 = sleeper(); const a2 = sleeper(); const other = sleeper();
      extra.push(other);
      reg.register(a1, { purpose: 'test', policy: { onOwnerExit: 'stop' } });
      reg.register(a2, { purpose: 'test', policy: { onOwnerExit: 'stop' } });
      // Identity lands asynchronously; wait until both records carry a start time.
      assert.ok(await until(() => reg.list({ owner: 'harness-test:unit-owner-A' }).every((r) => r.start) && reg.list({ owner: 'harness-test:unit-owner-A' }).length === 2), 'identities recorded');
      const r = reg.stopOwned('harness-test:unit-owner-A');
      assert.strictEqual(r.stopped, 2);
      assert.ok(await until(() => !alive(a1.pid) && !alive(a2.pid)), 'the owned ones stopped');
      assert.ok(alive(other.pid), 'the unrelated node.exe with the same executable name is untouched');
      assert.strictEqual(reg.list({ owner: 'harness-test:unit-owner-A' }).length, 0);
    });

    await test('RUNTIME: a reused pid is not the process Noema started — never stopped', async () => {
      const other = extra[0];
      // A record naming a LIVE unrelated pid with a different start identity:
      // exactly what pid reuse looks like.
      const f = path.join(process.env.LAIN_RUNTIME_DIR, 'harness-test_unit-owner-A.json');
      fs.writeFileSync(f, JSON.stringify({ owner: 'harness-test:unit-owner-A', lease: reg.lease(), processes: [{ id: 'Rfake', pid: other.pid, start: 'w1', owner: 'harness-test:unit-owner-A', purpose: 'test', policy: { onOwnerExit: 'stop' } }] }));
      const rec = reg.list({ owner: 'harness-test:unit-owner-A' })[0];
      assert.strictEqual(rec.alive, false, 'identity mismatch reads as "our process is gone"');
      reg.stop('Rfake');
      assert.ok(alive(other.pid), 'the process now holding that pid is untouched');
    });

    await test('RUNTIME: a dead owner\'s processes are reaped only if their policy says so, and only when identity matches', async () => {
      // A real "owner" process that then dies, leaving a lease with two children.
      const ownerProc = sleeper();
      const stopMe = sleeper(); const keepMe = sleeper();
      extra.push(keepMe);
      const t = reg.startTimes([ownerProc.pid, stopMe.pid, keepMe.pid]);
      const f = path.join(process.env.LAIN_RUNTIME_DIR, 'harness-test_dead-owner.json');
      fs.writeFileSync(f, JSON.stringify({
        owner: 'harness-test:dead-owner', lease: { pid: ownerProc.pid, start: t[ownerProc.pid] },
        processes: [
          { id: 'R1', pid: stopMe.pid, start: t[stopMe.pid], owner: 'harness-test:dead-owner', purpose: 'test', policy: { onOwnerExit: 'stop' } },
          { id: 'R2', pid: keepMe.pid, start: t[keepMe.pid], owner: 'harness-test:dead-owner', purpose: 'supervisor', policy: { onOwnerExit: 'keep' } },
          { id: 'R3', pid: keepMe.pid, start: null, owner: 'harness-test:dead-owner', purpose: 'unverified', policy: { onOwnerExit: 'stop' } },
        ],
      }));
      // While the owner lives, nothing is reaped.
      assert.strictEqual(reg.reapStale({ ownerPrefix: 'harness-test:' }).reaped.length, 0, 'a live owner keeps its processes');
      ownerProc.kill();
      assert.ok(await until(() => !alive(ownerProc.pid)));
      const rep = reg.reapStale({ ownerPrefix: 'harness-test:' });
      assert.deepStrictEqual(rep.reaped.map((x) => x.pid), [stopMe.pid], JSON.stringify(rep));
      assert.ok(await until(() => !alive(stopMe.pid)), 'the stop-policy child was stopped');
      assert.ok(alive(keepMe.pid), 'a keep-policy child, and an unverifiable record, are left alone');
      assert.ok(rep.kept.some((k) => /policy keeps/.test(k.why)) && rep.kept.some((k) => /cannot be verified/.test(k.why)));
    });

    await test('RUNTIME: another owner\'s process is not stopped without an explicit person\'s action', () => {
      const c = sleeper(); extra.push(c);
      process.env.LAIN_RUN_OWNER = 'harness-test:unit-owner-B';
      const id = reg.register(c, { purpose: 'test' });
      process.env.LAIN_RUN_OWNER = 'harness-test:unit-owner-A';
      const r = reg.stop(id, { by: 'harness-test:unit-owner-A' });
      assert.ok(!r.ok && /only its owner/.test(r.why), JSON.stringify(r));
      assert.ok(alive(c.pid));
    });

    await test('RUNTIME: tests never use the real registry', () => {
      const real = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Noema', 'runtime') : null;
      assert.notStrictEqual(path.resolve(saved.dir || ''), path.resolve(real || '/nonexistent'), 'the runner set a test registry');
      assert.ok(saved.owner && saved.owner.startsWith('harness-test:'), `the run has a test owner: ${saved.owner}`);
    });
  } finally {
    for (const c of extra) { try { c.kill(); } catch { /* gone */ } }
    if (process.platform === 'win32') for (const c of extra) spawnSync('taskkill', ['/PID', String(c.pid), '/F'], { stdio: 'ignore', windowsHide: true });
    process.env.LAIN_RUNTIME_DIR = saved.dir;
    process.env.LAIN_RUN_OWNER = saved.owner;
  }
};
