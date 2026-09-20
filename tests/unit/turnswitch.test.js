'use strict';

/**
 * A MODEL CHOSEN MID-TURN SERVES THE NEXT STEP, CONTINUING FROM THE SAME STATE.
 *
 * Live, 2026-09-18: /model kr/claude-haiku-4.5 while sonnet was working. The
 * header switched at once; the rest of that turn (seven more requests) still
 * went to sonnet, because runTurn resolved its provider once, before step 1.
 */

const assert = require('assert');
const { test, tmpdir, writeScript } = require('../helpers');
const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');
const turnswitch = require('../../src/turnswitch');

module.exports = async function () {
  await test('SWITCH: the step after a mid-turn /model uses the new model, with the full wire history', async () => {
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('switch-'), [
      { text: 'reading', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'reading more', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'done' },
    ]);
    const mockprovider = require('../../src/mockprovider');
    mockprovider._reset();
    const realChat = mockprovider.chat;
    const seen = [];
    mockprovider.chat = function patched(pc, messages, opts) { seen.push({ model: pc.model, n: messages.length }); return realChat.call(this, pc, messages, opts); };
    try {
      const session = new Session({ cwd: tmpdir('switch-cwd-') });
      let current = { model: 'model-A' };
      const notices = [];
      const opts = {
        cfg: { model: 'model-A' },
        cfgNow: () => current,
        steer: () => [],
        evidence: session.evidence,
        lifecycle: session.lifecycle,
      };
      let steps = 0;
      for await (const ev of runTurn(session, 'look around', opts)) {
        if (ev.type === 'notice') notices.push(ev.message);
        if (ev.type === 'tool_result' && ++steps === 1) current = { model: 'model-B' };   // the person switches during step 1
      }
      assert.deepStrictEqual(seen.map((s) => s.model), ['model-A', 'model-B', 'model-B'], JSON.stringify(seen));
      assert.ok(seen[1].n > seen[0].n, 'B receives the conversation so far, not a fresh start');
      assert.ok(notices.some((m) => /Model switched · model-A → model-B/.test(m)), notices.join(' | '));
    } finally {
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
      mockprovider.chat = realChat;
      mockprovider._reset();
    }
  });

  await test('ABORT: Ctrl+C during a request is the person stopping it — no provider_failure, no availability strike', async () => {
    // Live, 2026-09-18: Ctrl+C while waiting for the model drew "ERROR — aborted",
    // "PROVIDER REFUSED — the provider stopped answering" and a "Provider
    // localhost is not answering: aborted" panel, and counted against the route.
    const mockprovider = require('../../src/mockprovider');
    const realChat = mockprovider.chat;
    const ac = new AbortController();
    mockprovider.chat = async function* hung() {
      ac.abort();
      const e = new Error('aborted'); throw e;   // what the transport surfaces once the socket is torn down
    };
    process.env.LAIN_PROVIDER = 'mock';
    try {
      const { Availability } = require('../../src/availability');
      const availability = new Availability();
      const session = new Session({ cwd: tmpdir('abort-cwd-') });
      const events = [];
      let record = null;
      for await (const ev of runTurn(session, 'fix it', { cfg: { model: 'm' }, signal: ac.signal, availability, steer: () => [], evidence: session.evidence, lifecycle: session.lifecycle })) {
        events.push(ev.type);
        if (ev.type === 'done') record = ev.record;
      }
      assert.ok(!events.includes('provider_failure'), events.join(','));
      assert.strictEqual(record.stopReason, 'aborted');
      assert.strictEqual(availability.getFor('mock', 'm').consecutiveFailures, 0, 'the route was not blamed');
    } finally {
      delete process.env.LAIN_PROVIDER;
      mockprovider.chat = realChat;
    }
  });

  await test('SWITCH: an unchanged selection is not a switch', () => {
    assert.strictEqual(turnswitch.next({ cfgNow: () => ({ model: 'a', effort: null }) }, { model: 'a' }, { model: 'a' }), null);
    assert.strictEqual(turnswitch.next({}, { model: 'a' }, { model: 'a' }), null, 'no reader, no switch');
  });
};
