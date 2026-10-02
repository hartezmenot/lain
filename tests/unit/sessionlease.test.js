'use strict';

/**
 * THE SESSION LEASE (sessionlease.js, 2026-10-02) — one writer per session across PROCESSES.
 *
 *   - a live owner in another process is never displaced; the refusal names it and says how to ask
 *   - N processes racing for one free session: exactly one wins (compare-and-swap under the mutex)
 *   - an owner whose process died is taken over, with the epoch advanced
 *   - an owner whose heartbeat is stale (a reused pid, a wedged process) is taken over
 *   - a requested hand-over happens at the owner's next idle tick, and only then
 *   - a surface that takes a session another surface wrote reloads it from disk first
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');

/** A child LAIN-like process holding (or racing for) a lease. Prints JSON lines; ends on stdin close. */
function child(id, { surface = 'harness', tickMs = 0, busy = false, race = false } = {}) {
  const code = `
    const lease = require(${JSON.stringify(path.join(SRC, 'sessionlease'))});
    const r = lease.acquire(${JSON.stringify(id)}, { surface: ${JSON.stringify(surface)}, busy: () => ${busy} });
    process.stdout.write(JSON.stringify({ ok: r.ok, took: r.took, epoch: r.lease && r.lease.epoch }) + '\\n');
    if (${race}) process.exit(0);
    if (${tickMs}) setInterval(() => { lease.tick(); }, ${tickMs});
    process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
  `;
  const p = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  p.first = new Promise((res) => { let b = ''; p.stdout.on('data', (d) => { b += d; const nl = b.indexOf('\n'); if (nl >= 0) res(JSON.parse(b.slice(0, nl))); }); });
  p.done = new Promise((res) => p.on('exit', res));
  return p;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  const lease = require('../../src/sessionlease');
  const sh = require('../../src/surfacehandoff');
  const uid = () => `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  await test('LIVE OWNER: another process holding the session is never displaced; the refusal names it and says how to ask', async () => {
    const id = uid();
    const h = child(id, { surface: 'harness' });
    try {
      assert.strictEqual((await h.first).ok, true);
      const r = lease.acquire(id, { surface: 'cli' });
      assert.strictEqual(r.ok, false);
      assert.match(r.why, /continues in the Harness/);
      assert.match(r.why, /\/takeover/);
      assert.strictEqual(lease.view(id).pid, h.pid);
    } finally { h.stdin.end(); await h.done; lease._reset(); }
  });

  await test('RACE: six processes acquiring one free session — exactly one wins', async () => {
    const id = uid();
    const kids = Array.from({ length: 6 }, () => child(id));
    const answers = await Promise.all(kids.map((k) => k.first));
    for (const k of kids) k.stdin.end();
    await Promise.all(kids.map((k) => k.done));
    assert.strictEqual(answers.filter((a) => a.ok).length, 1, JSON.stringify(answers));
    assert.strictEqual(lease.read(id).epoch, 1);
  });

  await test('DEAD OWNER: a lease whose process is gone is taken over, with the epoch advanced', async () => {
    const id = uid();
    const h = child(id);
    assert.strictEqual((await h.first).ok, true);
    h.kill(); await h.done;
    const r = lease.acquire(id, { surface: 'cli' });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.took, true);
    assert.ok(r.previous && r.previous.dead, 'the previous owner is reported dead');
    assert.strictEqual(r.lease.epoch, 2);
    lease.release(id, { surface: 'cli' }); lease._reset();
  });

  await test('STALE HEARTBEAT: a live pid whose beat is older than the limit (a reused pid, a wedged host) is taken over', async () => {
    const id = uid();
    const h = child(id);
    try {
      assert.strictEqual((await h.first).ok, true);
      const f = lease.fileOf(id);
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      d.beat = Date.now() - lease.STALE_MS - 1000;
      fs.writeFileSync(f, JSON.stringify(d));
      const r = lease.acquire(id, { surface: 'cli' });
      assert.strictEqual(r.ok, true, r.why);
    } finally { h.stdin.end(); await h.done; lease.release(id, { surface: 'cli' }); lease._reset(); }
  });

  await test('REQUEST: a busy owner keeps the session; once idle it hands over at its next tick, reserved for the asker', async () => {
    const id = uid();
    const busy = child(id, { tickMs: 50, busy: true });
    try {
      assert.strictEqual((await busy.first).ok, true);
      lease.request(id, { surface: 'cli' });
      await wait(300);
      assert.strictEqual(lease.view(id).pid, busy.pid, 'a working owner is never interrupted');
    } finally { busy.stdin.end(); await busy.done; }
    const id2 = uid();
    const idle = child(id2, { tickMs: 50, busy: false });
    try {
      assert.strictEqual((await idle.first).ok, true);
      lease.request(id2, { surface: 'cli' });
      let v = null;
      for (let i = 0; i < 40; i++) { await wait(50); v = lease.view(id2); if (!v.pid) break; }
      assert.strictEqual(v.pid, null, 'the idle owner let go');
      assert.strictEqual(v.writer, 'cli', 'reserved for the surface that asked');
      assert.strictEqual(lease.acquire(id2, { surface: 'harness' }).ok, false, 'nobody else may take the reservation');
      assert.strictEqual(lease.acquire(id2, { surface: 'cli' }).ok, true);
    } finally { idle.stdin.end(); await idle.done; lease.release(id2, { surface: 'cli' }); lease._reset(); }
  });

  await test('RELOAD: a surface taking a session another surface wrote reloads it from disk — never writes its stale copy over it', async () => {
    const { App } = require('../../src/app');
    const { Session } = require('../../src/session');
    const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };
    const harness = new App({ out, interactive: false, cwd: tmpdir('lease-h-') });
    harness._surfaceName = 'harness';
    harness.session.save();
    const id = harness.session.id;
    assert.ok(sh.claim(harness), 'the Harness takes it for its turn');
    assert.strictEqual(sh.check(Object.assign(new App({ out, interactive: false, resume: id }), { _surfaceName: 'cli' })).ok, false, 'a CLI on the same session is held while the Harness holds it');
    sh.release(harness);
    const cli = new App({ out, interactive: false, resume: id });
    cli._surfaceName = 'cli';
    assert.ok(sh.claim(cli));
    cli.session.messages.push({ role: 'user', content: 'typed in the CLI', thread: 'coding' });
    cli.session.save();
    sh.release(cli);
    assert.ok(!harness.session.messages.some((m) => m.content === 'typed in the CLI'), 'precondition: the Harness copy is stale');
    assert.ok(sh.claim(harness));
    assert.ok(harness.session.messages.some((m) => m.content === 'typed in the CLI'), 'reloaded before writing');
    sh.release(harness);
    assert.ok(Session.resume(id));
    lease._reset();
  });
};
