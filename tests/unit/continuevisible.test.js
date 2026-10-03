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
