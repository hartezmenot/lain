'use strict';

/**
 * A USER'S `continue` IS VISIBLE AS WHAT IT IS.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT. When a turn did not finish, the runtime gate holds the next
 * sentence and inputgate.recover resubmits it with `from: 'handover'`. The feed
 * drew any `from` on the self-asked list as a caption — "continuing from what
 * LAIN observed" — and dropped the text. So the person typed `continue`, the
 * work resumed, and their word never appeared: not in the transcript, not in
 * the dashboard, and /copy labelled it "USER (via handover)". The idle steer
 * path had the same shape with `from: 'steer'`.
 *
 * A synthetic resume LAIN composes for itself (the rate-limit resume) must stay
 * a caption and must never be drawn as the user.
 */

const assert = require('assert');
const { test, tmpdir, writeScript } = require('../helpers');

const views = require('../../src/ui/views');
const T = require('../../src/ui/text');

function realApp() {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('continue-cwd-') });
}

function feedText(session) {
  return T.strip(views.activity({ session, width: 90 }).join('\n'));
}

async function withMock(steps, fn) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('continue-script-'), steps);
  try { return await fn(); } finally {
    delete process.env.LAIN_PROVIDER;
    delete process.env.LAIN_MOCK_SCRIPT;
  }
}

module.exports = async function () {
  await test('CONTINUE A: a typed `continue` held by the gate is drawn ONCE as the user, and resumes the task', async () => {
    await withMock([{ text: 'first answer' }, { text: 'carried on from step 3' }], async () => {
      const app = realApp();
      await app.submit('migrate the timer to the new clock');
      // THE HELD SENTENCE ARRIVES WITH THE VERDICT (turnguard.js) — no queue in another process to take it from.
      await require('../../src/inputgate').recover(app, { reason: 'the previous turn did not finish', state: {}, input: [{ text: 'continue', at: Date.now(), reason: 'turn-died' }] });
      const last = app.session.turns[app.session.turns.length - 1];
      assert.strictEqual(last.userInput, 'continue');
      assert.strictEqual(last.typed, true);
      assert.strictEqual(last.from, 'handover', 'the machinery still knows it was a recovery');
      assert.strictEqual(app.session.task.objective, 'migrate the timer to the new clock', 'it continued the same task');

      const text = feedText(app.session);
      assert.strictEqual((text.match(/^USER[A-Z ]* · continue\s*$/gm) || []).length, 1, `visible exactly once:\n${text}`);
      assert.ok(!/continuing from what LAIN observed/.test(text), 'not replaced by a caption');
      assert.ok(text.indexOf('migrate the timer') < text.search(/USER[A-Z ]* · continue/), 'in chronological order');

      const copied = require('../../src/copysummary').context(app, { all: true });
      assert.match(copied, /USER\ncontinue/, '/copy keeps it where ordinary user turns belong');
      assert.ok(!/USER \(via handover\)/.test(copied));

    });
  });

  await test('CONTINUE: a plain `continue` with no held turn is an ordinary user row too', async () => {
    await withMock([{ text: 'a' }, { text: 'b' }], async () => {
      const app = realApp();
      await app.submit('write the parser');
      await app.submit('continue');
      const text = feedText(app.session);
      assert.strictEqual((text.match(/USER[A-Z ]* · continue/g) || []).length, 1, text);
    });
  });

  await test('CONTINUE: LAIN\'s own synthetic resume is NOT drawn as the user', async () => {
    await withMock([{ text: 'a' }, { text: 'resumed' }], async () => {
      const app = realApp();
      await app.submit('write the parser');
      const { RESUME_PROMPT } = require('../../src/ratelimit');
      await app.submit(RESUME_PROMPT, { sameTask: true, from: 'rate-limit-resume' });
      const text = feedText(app.session);
      assert.ok(!text.includes('The rate limit has reset'), 'the composed prompt does not impersonate the user');
      assert.match(text, /continuing after the rate limit reset/);
      assert.ok(!/USER[A-Z ]* · continue\b/.test(text), 'and no synthetic USER: continue is invented');
    });
  });

  await test('CONTINUE: a steer typed while idle is delivered as the user\'s words, not a caption', () => {
    const session = { turns: [
      { userInput: 'fix the loader', text: 'done', actions: [], narration: null, errors: [] },
      { userInput: 'also handle empty files', from: 'steer', typed: true, text: 'handled', actions: [], narration: null, errors: [] },
    ] };
    const text = feedText(session);
    assert.match(text, /USER · also handle empty files/);
    assert.ok(!/continuing with what you added/.test(text));
  });
};
