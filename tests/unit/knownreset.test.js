'use strict';

/**
 * A KNOWN RESET IS WAITED FOR, NEVER HAMMERED; AN UNKNOWN ONE IS PROBED, BOUNDED.
 *
 * Through the real turn loop, the mock provider and the real availability gate:
 * the provider is called exactly as often as the policy allows, and the route
 * stays shut — model-scoped — until the stated reset.
 */

const assert = require('assert');
const { test, tmpdir, writeScript } = require('../helpers');
const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');
const { Availability } = require('../../src/availability');
const errors = require('../../src/errors');

async function drive(steps, availability) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('reset-'), steps);
  process.env.LAIN_BACKOFF_MS = '1,1,1,1,1,1,1,1,1,1';
  const mock = require('../../src/mockprovider');
  mock._reset();
  const real = mock.chat;
  let calls = 0;
  mock.chat = function counted(pc, m, o) { calls += 1; return real.call(this, pc, m, o); };
  const session = new Session({ cwd: tmpdir('reset-cwd-') });
  let record = null;
  try {
    for await (const ev of runTurn(session, 'explain a.js', { cfg: { model: 'm' }, availability, steer: () => [], evidence: session.evidence, lifecycle: session.lifecycle })) {
      if (ev.type === 'done') record = ev.record;
    }
  } finally {
    delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; delete process.env.LAIN_BACKOFF_MS;
    mock.chat = real; mock._reset();
  }
  return { record, calls };
}

const limited = (message) => ({ error: { status: 503, message } });

module.exports = async function () {
  await test('KNOWN RESET A: an hourly reset ends the turn after ONE request — no retry ladder — and the model stays shut until then', async () => {
    const availability = new Availability();
    const msg = '[codex/m] [429]: The usage limit has been reached (reset after 1h 12m)';
    const { record, calls } = await drive([limited(msg), limited(msg), limited(msg), { text: 'never' }], availability);
    assert.strictEqual(calls, 1, `zero premature retries, got ${calls} requests`);
    assert.strictEqual(record.stopReason, 'rate-limited');
    const left = record.providerFailure.resumeAt - Date.now();
    assert.ok(left > 71 * 60000 && left <= 72 * 60000 + 1000, `resume at the stated reset: ${left}ms`);
    assert.strictEqual(availability.limitActiveFor('mock', 'm'), true, 'the route is marked until the reset');
    const again = await drive([{ text: 'must not be asked' }], availability);
    assert.strictEqual(again.calls, 0, 'the next turn costs ZERO requests before the reset');
    assert.strictEqual(availability.limitActiveFor('mock', 'other-model'), false, 'and only this model is shut');
  });

  await test('KNOWN RESET B: a weekly reset ("Reset Monday 08:00") is the same — one request, then patience', async () => {
    const availability = new Availability();
    const msg = 'Weekly quota exhausted for this account. Reset Monday 08:00';
    const { record, calls } = await drive([{ error: { status: 429, message: msg } }, { text: 'never' }], availability);
    assert.strictEqual(calls, 1);
    assert.strictEqual(record.stopReason, 'rate-limited');
    const e = new Error(msg); e.status = 429;
    const c = errors.classify(e);
    assert.strictEqual(c.limitClass, 'weekly');
    assert.ok(c.retryAfterMs > 0 && c.retryAfterMs <= 7 * 86400000);
  });

  await test('KNOWN RESET C: an UNKNOWN reset is probed with the bounded backoff, and recovers', async () => {
    const availability = new Availability();
    const rl = { error: { status: 429, message: 'Rate limit exceeded, please slow down' } };
    const { record, calls } = await drive([rl, rl, { text: 'recovered' }], availability);
    assert.strictEqual(calls, 3, 'bounded probing: two refusals, then the answer');
    assert.strictEqual(record.stopReason, 'end');
    assert.strictEqual(availability.limitActiveFor('mock', 'm'), false, 'a success clears it');
  });

  await test('KNOWN RESET: every reset shape the wire uses is read', () => {
    const now = Date.parse('2026-09-19T10:00:00Z');
    assert.strictEqual(errors.resetHintMs('reset after 1m 59s', now), 119000);
    assert.strictEqual(errors.resetHintMs('try again in 3 days', now), 3 * 86400000);
    assert.strictEqual(errors.resetHintMs('resets at 2026-09-19T12:00:00Z', now), 2 * 3600000);
    assert.strictEqual(errors.resetHintMs('{"reset": 1789820400}', now), 1789820400000 - now);
    assert.ok(errors.resetHintMs('Reset Monday 08:00', now) > 0);
    assert.strictEqual(errors.resetHintMs('no clock here', now), 0);
  });

  await test('KNOWN RESET UX: the row names the model and the reset, quietly — no durable note that outlives recovery', () => {
    // Real TTY, 2026-09-19: the row quoted the provider body ("429 Too Many Requests — Rate limit exceeded
    // for …  Resets in 4…") and a NOTE "MODEL INTERRUPTED — rate-limited" stayed under every later turn.
    const { failureRow } = require('../../src/ui/failure');
    const hour = failureRow({ kind: 'RATE_LIMITED', model: 'claude-opus-5', resumeAt: Date.now() + 42 * 60000, message: '429 {"error":…}' });
    assert.strictEqual(hour.word, 'RATE LIMITED');
    assert.match(hour.detail, /^claude-opus-5 · reset in 4[12]m \d+s · \d\d:\d\d$/);
    const week = failureRow({ kind: 'RATE_LIMITED', model: 'claude-opus-5', resumeAt: Date.now() + 4 * 86400000 + 60000 });
    assert.strictEqual(week.word, 'WEEKLY LIMIT');
    assert.match(week.detail, /reset in 4d 0h · [A-Z][a-z]+day \d\d:\d\d$/);
    const w = require('../../src/ui/status').liveState({ failed: { kind: 'RATE_LIMITED', resumeAt: Date.now() + 86400000 * 4 } }, Date.now());
    assert.strictEqual(w.actor, 'NET', 'a limit is the provider, not Noema');
    const said = [];
    require('../../src/turnevents').noteInterruption({ ui: { enabled: true, noteActor: (k, t) => said.push(t) } },
      { stopReason: 'rate-limited', providerFailure: { kind: 'RATE_LIMITED' } });
    assert.deepStrictEqual(said, [], 'no durable note: the live row and the wait/change question already say it');
  });
};
