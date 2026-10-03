'use strict';

/**
 * PHASE J (2026-10-02) — the Rust Guardian's turn state, moved to where the session lives.
 *
 *   turnguard.js       a failed turn earns the NEXT sentence a briefing; a completed or cancelled one does not; a turn
 *                      still RUNNING in a session this process just loaded was lost with its host (TURN_LOST)
 *   sessionjournal.js  turn begin/end, tool start/end, coalesced visible text — to the window and to the file; never
 *                      reasoning content
 *   routehealth.js     a stated rate limit is remembered across processes without starting one; a success clears it;
 *                      a person's decision survives a success; AUTH never counts toward the breaker
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

function newApp(opts = {}) {
  const { App } = require('../../src/app');
  return new App({ out, interactive: false, cwd: tmpdir('phasej-'), ...opts });
}

async function withMock(steps, fn) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('phasej-script-'), steps);
  require('../../src/mockprovider')._reset();
  try { return await fn(); } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; }
}

module.exports = async function () {
  const guard = require('../../src/turnguard');
  const journal = require('../../src/sessionjournal');
  const health = require('../../src/routehealth');

  await test('TURNGUARD: a completed turn lets the next sentence through bare', async () => {
    await withMock([{ text: 'done' }], async () => {
      const app = newApp();
      await app.submit('say done');
      assert.strictEqual(guard.held(app), '');
      assert.strictEqual(guard.view(app.session).state, 'COMPLETED');
    });
  });
  await test('TURNGUARD: a cancellation is the person\'s own decision — the next sentence goes through bare', async () => {
    const app = newApp();
    guard.begin(app, { model: 'm' });
    guard.end(app, { stopReason: 'aborted' });
    assert.strictEqual(guard.held(app), '');
  });

  await test('TURNGUARD: a turn left RUNNING in a session another (dead) process wrote is TURN_LOST here', async () => {
    const a = newApp();
    guard.begin(a, { model: 'm' });
    a.session.save();
    const b = newApp({ resume: a.session.id });
    assert.match(guard.held(b), /^TURN_LOST:/);
  });

  await test('JOURNAL: a turn is recorded as facts — begin, tool start/end, coalesced text, end — and never reasoning content', async () => {
    await withMock([{ text: 'reading it', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] }, { text: 'all done here' }], async () => {
      const app = newApp();
      const sent = [];
      const ipc = require('../../src/harnessapp/ipc');
      const realEmit = ipc.emit;
      ipc.emit = (e) => { sent.push(e); return realEmit(e); };
      try { await app.submit('list the files in this folder'); } finally { ipc.emit = realEmit; }
      journal.flushAll();
      const rows = journal.read(app.session.id);
      const types = rows.map((r) => r.type);
      assert.ok(types.includes('turn.begin') && types.includes('turn.end'), types.join(','));
      assert.ok(types.includes('tool.start') && types.includes('tool.end'), types.join(','));
      const end = rows.find((r) => r.type === 'tool.end');
      assert.strictEqual(end.name, 'list_dir');
      assert.strictEqual(end.ok, true);
      assert.ok(rows.filter((r) => r.type === 'text').map((r) => r.text).join('').includes('all done'), 'visible text is kept (coalesced)');
      assert.ok(!rows.some((r) => r.type === 'thinking'), 'thinking is a state, never recorded');
      assert.ok(sent.some((e) => e.type === 'turn.event' && e.ev.type === 'tool.start'), 'the window got the same event, live');
      const st = journal.state(app.session.id);
      assert.strictEqual(st.running, false);
    });
  });

  await test('ROUTE HEALTH: a stated rate limit shuts the route for every process until its reset; a success clears it', async () => {
    const id = `lain:test-${Date.now()}`;
    health.note({ connectionId: id, ok: false, kind: 'RATE_LIMITED', reason: '429', resetAt: Date.now() + 3600_000 });
    health._reset();
    assert.match(require('../../src/providerhealth').routeShut(id), /^ROUTE_SHUT: .* rate limited for another \d+m/);
    health.note({ connectionId: id, ok: true });
    assert.strictEqual(health.routeShut(id), null);
    assert.strictEqual(health.get(id).status, 'AVAILABLE');
  });

  await test('ROUTE HEALTH: no stated reset is not a clock; AUTH never counts; a person\'s DISABLED survives a success', async () => {
    const id = `lain:test2-${Date.now()}`;
    health.note({ connectionId: id, ok: false, kind: 'RATE_LIMITED' });
    assert.strictEqual(health.get(id).reset_at, null);
    assert.strictEqual(health.routeShut(id), null, 'a missing reset is not a clock');
    const a = `lain:auth-${Date.now()}`;
    health.note({ connectionId: a, ok: false, kind: 'AUTH', reason: '401' });
    assert.strictEqual(health.get(a).consecutive_failures, 0);
    health.set(id, 'DISABLED', 'by hand');
    health.note({ connectionId: id, ok: true });
    assert.strictEqual(health.get(id).status, 'DISABLED');
  });

  await test('ROUTE HEALTH: the supervisor\'s old records are imported once on first use', async () => {
    const dir = path.join(require('../../src/supervisor').stateDir(), 'providers');
    fs.mkdirSync(dir, { recursive: true });
    const f = health.file();
    const saved = fs.existsSync(f) ? fs.readFileSync(f) : null;
    try {
      if (saved) fs.unlinkSync(f);
      fs.writeFileSync(path.join(dir, 'lain_legacy.json'), JSON.stringify({ id: 'lain:legacy', status: 'DISABLED', reason: 'old', rate_limited: false }));
      health._reset();
      assert.strictEqual(health.get('lain:legacy').status, 'DISABLED');
    } finally {
      try { fs.unlinkSync(path.join(dir, 'lain_legacy.json')); } catch { /* gone */ }
      if (saved) fs.writeFileSync(f, saved);
      health._reset();
    }
  });
};
