'use strict';

/**
 * A RATE LIMIT OUTLIVES THE PROCESS THAT LEARNED IT (routehealth.js, 2026-10-02 — Node's own file, no supervisor).
 *
 * Measured live against a real router: `retry in 4 hours`. Restart Noema five minutes later and, without a durable
 * copy, that number is gone: the next turn calls the closed route and is refused, the picker shows the shut door as
 * untried, and nothing in the handover can tell a replacement model which road not to take.
 *
 * The property under test is that the fact survives the death of the process that recorded it, so the writer below
 * is a SEPARATE PROCESS that exits before the reader looks.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('../helpers');
const health = require('../../src/routehealth');
const { Availability } = require('../../src/availability');

const HOUR = 3600_000;
const SRC = path.join(__dirname, '..', '..', 'src');

/** Another Noema process records something, then exits. */
function inAnotherProcess(code) {
  const r = spawnSync(process.execPath, ['-e', `const h = require(${JSON.stringify(path.join(SRC, 'routehealth'))}); ${code}`], { env: process.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  health._reset();
}

module.exports = async function () {
  const uid = (t) => `lain:${t}-${Date.now().toString(36)}`;

  await test('HEALTH: a four-hour limit learned by one process is known to the next', async () => {
    const id = uid('survive');
    const resetAt = Date.now() + 4 * HOUR;
    inAnotherProcess(`h.note({ connectionId: ${JSON.stringify(id)}, ok: false, kind: 'RATE_LIMITED', reason: '429 too many requests', provider: 'omniroute', model: 'gemini', resetAt: ${resetAt} });`);
    const fresh = new Availability();
    assert.strictEqual(fresh.shouldAttempt(id).allow, true, 'a brand-new Availability starts knowing nothing — that is the bug');
    const took = fresh.hydrate(health.list());
    assert.ok(took.limited >= 1, 'the limit was still there to be read');
    const e = fresh.get(id);
    assert.ok(e.historicalLimit && e.historicalLimit.resumeAt - Date.now() > 3.9 * HOUR, 'the real time left is kept for /provider');
    assert.strictEqual(fresh.shouldAttempt(id).allow, true, 'a restarted runtime does not shut the door on it (§48) …');
    assert.match(require('../../src/providerhealth').routeShut(id), /ROUTE_SHUT/, '… but the request path refuses it until the stated reset');
  });

  await test('HEALTH: a limit with no stated reset never grows a countdown in transit', async () => {
    const id = uid('nostated');
    inAnotherProcess(`h.note({ connectionId: ${JSON.stringify(id)}, ok: false, kind: 'RATE_LIMITED', reason: '429' });`);
    const row = health.get(id);
    assert.strictEqual(row.reset_at, null);
    assert.strictEqual(health.routeShut(id), null);
  });

  await test('HEALTH: only a request that WORKED clears the flag — time passing does not', async () => {
    const id = uid('clears');
    health.note({ connectionId: id, ok: false, kind: 'RATE_LIMITED', resetAt: Date.now() + HOUR });
    assert.strictEqual(health.get(id).rate_limited, true);
    inAnotherProcess(`h.note({ connectionId: ${JSON.stringify(id)}, ok: true });`);
    assert.strictEqual(health.get(id).rate_limited, false);
    assert.strictEqual(health.get(id).status, 'AVAILABLE');
  });

  await test('HEALTH: /provider retry is not undone by the next launch', async () => {
    const id = uid('retry');
    health.note({ connectionId: id, ok: false, kind: 'RATE_LIMITED', resetAt: Date.now() + HOUR });
    health.clear(id);
    inAnotherProcess(`if (h.get(${JSON.stringify(id)}).rate_limited) process.exit(3);`);
    assert.strictEqual(health.routeShut(id), null);
  });

  await test('HEALTH: a route a person disabled stays disabled after a restart, and a success does not re-enable it', async () => {
    const id = uid('disabled');
    inAnotherProcess(`h.set(${JSON.stringify(id)}, 'DISABLED', 'by hand');`);
    assert.strictEqual(health.get(id).status, 'DISABLED');
    health.note({ connectionId: id, ok: true });
    assert.strictEqual(health.get(id).status, 'DISABLED');
    const a = new Availability();
    a.hydrate(health.list());
    assert.strictEqual(a.shouldAttempt(id).allow, false, 'a person\'s decision is adopted on start');
  });

  await test('HEALTH: a note with no connection id is refused, not filed under ""', async () => {
    assert.strictEqual(health.note({ ok: false, kind: 'RATE_LIMITED' }), null);
    assert.ok(!health.list().some((r) => r.id === ''));
  });

  await test('HANDOVER-14: the model taking over is told which road is closed, and until when', async () => {
    const id = 'omniroute-main';
    health.note({ connectionId: id, ok: false, kind: 'RATE_LIMITED', reason: '429', provider: 'omniroute', model: 'model-a', resetAt: Date.now() + 3 * HOUR });
    const packet = require('../../src/handover').build({
      cwd: process.cwd(),
      task: { objective: 'finish the data loader' },
      turns: [{ model: 'model-a', stopReason: 'provider', steps: 4, actions: [] }],
    }, { toModel: 'model-b', providers: health.list() });
    assert.ok(/continuing this task from a different model/.test(packet), 'model B must be told whose work it is continuing');
    assert.match(packet, /provenance, not ownership/i);
    assert.ok(/Routes that are closed right now/.test(packet), 'the section is present');
    assert.ok(/omniroute-main/.test(packet), 'and names the route');
    assert.ok(/clears in (2h|3h)/.test(packet), `with a real clock: ${packet}`);
    assert.ok(/Noema observed these/.test(packet));
    health.clear(id);
  });
};
