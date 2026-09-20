'use strict';

const assert = require('assert');
const { test } = require('../helpers');
const errors = require('../../src/errors');

module.exports = async function () {
  await test('ECONNREFUSED is UNAVAILABLE and retriable', () => {
    // V1 used \bECONN\b, which cannot match inside ECONNREFUSED — a dead local
    // bridge was never classified as transient and took the REPL down.
    const e = new Error('connect ECONNREFUSED 127.0.0.1:20128');
    e.code = 'ECONNREFUSED';
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.UNAVAILABLE);
    assert.strictEqual(c.retriable, true);
    assert.strictEqual(errors.isProviderFailure(e), true);
  });

  await test('every transport errno is a retriable provider failure', () => {
    // Asserting the INVARIANT that matters rather than the exact label:
    // ETIMEDOUT legitimately classifies as TIMEOUT and ECONNRESET as
    // UNAVAILABLE. What the turn loop and (phase 6) the availability breaker
    // need from all of them is identical — retriable, and not our bug.
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']) {
      const e = new Error(`socket error ${code}`);
      e.code = code;
      const c = errors.classify(e);
      assert.strictEqual(errors.isProviderFailure(e), true, `${code} must be a provider failure`);
      assert.strictEqual(c.retriable, true, `${code} must be retriable`);
      assert.notStrictEqual(c.kind, errors.KIND.UNKNOWN, `${code} must be classified`);
    }
  });

  await test('429 is RATE_LIMITED and retriable', () => {
    const e = new Error('too many requests'); e.status = 429;
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.RATE_LIMITED);
    assert.strictEqual(c.retriable, true);
  });

  await test('Retry-After is clamped — an epoch timestamp is not a delta', () => {
    // V1 turned an absolute epoch into a ~26-day wait.
    const sane = new Error('rl'); sane.status = 429; sane.retryAfter = 30;
    assert.strictEqual(errors.classify(sane).retryAfterMs, 30000);
    const epoch = new Error('rl'); epoch.status = 429; epoch.retryAfter = 1786000000;
    assert.strictEqual(errors.classify(epoch).retryAfterMs, 0, 'absurd Retry-After must be discarded');
  });

  await test('401/403 is AUTH, not an outage, and is not retriable', () => {
    const e = new Error('unauthorized'); e.status = 401;
    const c = errors.classify(e);
    assert.strictEqual(c.kind, errors.KIND.AUTH);
    assert.strictEqual(c.retriable, false);
  });

  await test('5xx is UNAVAILABLE and retriable; 400 is BAD_REQUEST and is not', () => {
    const s = new Error('bad gateway'); s.status = 502;
    assert.strictEqual(errors.classify(s).kind, errors.KIND.UNAVAILABLE);
    assert.strictEqual(errors.classify(s).retriable, true);
    const b = new Error('nope'); b.status = 400;
    assert.strictEqual(errors.classify(b).kind, errors.KIND.BAD_REQUEST);
    assert.strictEqual(errors.classify(b).retriable, false);
  });

  await test('a plain programming error is NOT a provider failure (it must keep throwing)', () => {
    assert.strictEqual(errors.isProviderFailure(new TypeError("x is not a function")), false);
  });

  await test('abort is its own kind and is not a provider failure', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    assert.strictEqual(errors.classify(e).kind, errors.KIND.ABORTED);
    assert.strictEqual(errors.isProviderFailure(e), false);
  });

  await test('QUOTA: the exact 429 that was retried five times in a real session', () => {
    // ---- CAPTURED OFF THE WIRE, not paraphrased ---------------------------
    //
    // This is the body omniroute actually returned, taken from a recorded
    // session. Nothing in the quota pattern matched it, so it fell through to
    // the plain `status === 429` branch and came back RETRIABLE — and the run
    // shows `retry 1/5` through `retry 5/5` against a provider that had just
    // said the account had no requests left. Five more refusals at an exhausted
    // cap, and a wait that could not help.
    //
    // The discriminator is WHICH limit, not the word "limit": a RATE limit
    // clears on its own and is still retried.
    const errors = require('../../src/errors');
    const body = 'omniroute: 429 Too Many Requests — {"error":{"message":"[tokenrouter/z-ai/'
      + 'glm-5.3-free] [429]: {\\"error\\":{\\"code\\":\\"\\",\\"message\\":\\"You have reached the '
      + 'request limit[z-ai/glm-5.3-free]: Maximum';
    const err = new Error(body);
    err.status = 429;
    const c = errors.classify(err);
    assert.strictEqual(c.kind, 'QUOTA', 'an exhausted request cap is not a rate limit');
    assert.strictEqual(c.retriable, false, 'and waiting for it is waiting forever');

    // The other half, which must NOT change: a genuine rate limit still retries.
    const rate = new Error('Rate limit exceeded, please slow down');
    rate.status = 429;
    const r = errors.classify(rate);
    assert.strictEqual(r.kind, 'RATE_LIMITED');
    assert.strictEqual(r.retriable, true, 'a rate limit clears on its own — retrying is correct');
  });

  await test('RATE LIMIT: a gateway-wrapped upstream 429 with a stated reset waits that reset', () => {
    // Captured through 9router, 2026-09-18: the router answered 503, so LAIN
    // showed `Network 503` and retried at 5s/10s/15s inside a named 2m window.
    const e = new Error('503 Service Unavailable — {"error":{"message":"[codex/gpt-5.6-luna] [429]: The usage limit has been reached (reset after 1m 59s)"}}');
    e.status = 503;
    const c = errors.classify(e);
    assert.strictEqual(c.kind, 'RATE_LIMITED', 'the body carries the upstream status; it wins over the wrapper');
    assert.strictEqual(c.retriable, true);
    assert.strictEqual(c.retryAfterMs, 119000, 'the stated reset is the wait');
    assert.strictEqual(require('../../src/backoff').backoffFor(1, c.retryAfterMs), 119000, 'and the first retry honours it');

    // A long reset is a limit with a clock: not sat through inside the turn, but
    // handed to WAIT / change model with the route shut until then (ratelimit.js).
    const long = new Error('[codex/gpt-5.6-luna] [429]: The usage limit has been reached (reset after 4h 12m)');
    long.status = 503;
    const l = errors.classify(long);
    assert.strictEqual(l.kind, 'RATE_LIMITED');
    assert.strictEqual(l.retryAfterMs, (4 * 60 + 12) * 60000);
    assert.strictEqual(require('../../src/ratelimit').worthAsking(l), true, 'the turn ends and offers WAIT');

    // A wrapped [429] with no reset is still a rate limit, not an outage.
    const bare = new Error('[x/y] [429]: Too many requests'); bare.status = 502;
    assert.strictEqual(errors.classify(bare).kind, 'RATE_LIMITED');
    // A wrapped upstream credential refusal is AUTH, even with the router's cooldown suffix.
    const lic = new Error('[github/claude-sonnet-4.6] [403]: unauthorized: not licensed to use Copilot\n (reset after 25s)'); lic.status = 503;
    assert.strictEqual(errors.classify(lic).kind, errors.KIND.AUTH);
    assert.strictEqual(errors.classify(lic).retriable, false);
    const revoked = new Error('[codex/gpt-5.6-luna] [401]: {"error":{"message":"Encountered invalidated oauth token","code":"token_revoked"}} (reset after 2m)'); revoked.status = 503;
    assert.strictEqual(errors.classify(revoked).kind, errors.KIND.AUTH);
    // Every upstream 4xx a router wraps is classified by the upstream's status (bodies captured live).
    const w = (m) => { const x = new Error(m); x.status = 503; return errors.classify(x); };
    assert.strictEqual(w('[kimchi/kimi-k3] [402]: {"error": "the provider for model kimi-k3 has exhausted its credits"}').kind, errors.KIND.QUOTA);
    assert.strictEqual(w('[codebuddy-intl/glm-5.2] [429]: {"error":{"data":{"code":14018,"msg":"Credits exhausted. Please"}}}').kind, errors.KIND.QUOTA);
    const gone = w('[nvidia/z-ai/glm-5.2] [410]: {"type":"about:blank","title":"Gone","status":410}');
    assert.strictEqual(gone.retriable, false, 'a 410 behind a router is not an outage to wait out');
    // An ordinary 503 is untouched.
    const down = new Error('upstream connect error'); down.status = 503;
    assert.strictEqual(errors.classify(down).kind, errors.KIND.UNAVAILABLE);
  });
};
