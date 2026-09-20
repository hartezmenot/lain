'use strict';

/**
 * ONE MODEL'S REFUSAL DOES NOT SHUT A ROUTER'S OTHER MODELS.
 *
 * Live, 2026-09-18, through 9router (`lain:localhost`, 939 models): codex's
 * account answered `[429] usage limit` then `[401] token revoked` (wrapped as
 * 503). Availability was keyed by connection alone, so the breaker opened for
 * the whole router: `/model kr/claude-sonnet-4.5` showed `availability
 * UNAVAILABLE`, and its turn would have been skipped with zero requests.
 *
 * Invariant: a failure the server ANSWERED is recorded against route+model; a
 * failure with no answer (refused/reset/timeout) is the route's.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { Availability, STATUS } = require('../../src/availability');
const errors = require('../../src/errors');

const wrapped = (body, status = 503) => { const e = new Error(body); e.status = status; return errors.classify(e); };

module.exports = async function () {
  await test('AVAILABILITY: server-answered failures on one model leave the router\'s other models open', () => {
    const a = new Availability();
    const conn = 'lain:localhost';
    for (let i = 0; i < 3; i++) a.noteOutcome(conn, 'cx/gpt-5.6-luna', wrapped('[codex/gpt-5.6-luna] upstream exploded'));
    assert.strictEqual(a.getFor(conn, 'cx/gpt-5.6-luna').status, STATUS.UNAVAILABLE, 'the failing model is shut');
    assert.strictEqual(a.shouldAttemptFor(conn, 'cx/gpt-5.6-luna').allow, false);
    assert.notStrictEqual(a.getFor(conn, 'kr/claude-sonnet-4.5').status, STATUS.UNAVAILABLE, 'another model on the same router is not');
    assert.strictEqual(a.shouldAttemptFor(conn, 'kr/claude-sonnet-4.5').allow, true, 'and its request is attempted');

    // A stated rate limit is model-scoped as well.
    a.noteOutcome(conn, 'cx/gpt-5.5', wrapped('[codex/gpt-5.5] [429]: The usage limit has been reached (reset after 1m 59s)'));
    assert.strictEqual(a.limitActiveFor(conn, 'cx/gpt-5.5'), true);
    assert.strictEqual(a.limitActiveFor(conn, 'kr/claude-sonnet-4.5'), false);
  });

  await test('AVAILABILITY: a transport failure (no answer) is the route\'s, for every model', () => {
    const a = new Availability();
    const conn = 'lain:localhost';
    const refused = errors.classify(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:20128'), { code: 'ECONNREFUSED' }));
    a.noteOutcome(conn, 'cx/gpt-5.6-luna', refused);
    a.noteOutcome(conn, 'cx/gpt-5.6-luna', refused);
    assert.strictEqual(a.shouldAttemptFor(conn, 'kr/claude-sonnet-4.5').allow, false, 'the router itself is down');
  });

  await test('AVAILABILITY: success clears the model scope; /provider retry clears every model on the route', () => {
    const a = new Availability();
    const conn = 'lain:localhost';
    a.noteOutcome(conn, 'm1', wrapped('[x] boom'));
    a.noteOutcome(conn, 'm1', wrapped('[x] boom'));
    assert.strictEqual(a.shouldAttemptFor(conn, 'm1').allow, false);
    a.noteOutcome(conn, 'm1', null);
    assert.strictEqual(a.shouldAttemptFor(conn, 'm1').allow, true, 'a success on that model reopens it');
    a.noteOutcome(conn, 'm2', wrapped('[x] boom'));
    a.noteOutcome(conn, 'm2', wrapped('[x] boom'));
    a.retry(conn);
    assert.strictEqual(a.shouldAttemptFor(conn, 'm2').allow, true, 'retrying the route covers its models');
  });

  await test('AVAILABILITY: the user\'s disable on the route still gates every model', () => {
    const a = new Availability();
    a.disable('lain:localhost');
    assert.strictEqual(a.shouldAttemptFor('lain:localhost', 'anything').allow, false);
  });
};
