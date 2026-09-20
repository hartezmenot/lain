'use strict';

/**
 * THE TURN BOUNDARY, in the three places a finished turn could leak into the next.
 *
 * The real-terminal proof is tests/smoke/sequentialturns.test.js; these lock
 * each rule down where it lives, so a regression names its file.
 *
 *   FEED       two user messages in a row are two blocks, never one
 *   CLOCK      a new prompt after a SETTLED turn starts at 00:00:00; only a
 *              paused or blocked attempt carries its time on
 *   COMPOSER   the /goal and /plan hint lives exactly as long as the composer
 */

const assert = require('assert');
const { test } = require('../helpers');
const feed = require('../../src/ui/feed');
const alert = require('../../src/ui/alert');
const workclock = require('../../src/ui/workclock');
const compose = require('../../src/composemode');
const { KIND } = require('../../src/task');

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function clockUi() {
  return { clock: workclock.create(), waitingUntil: 0, interrupted: false, interrupting: false, retryCancelled: false, failed: false };
}

module.exports = async function () {
  await test('FEED: two consecutive user messages draw as two USER blocks', () => {
    // What an empty-reply turn between them used to produce: one block, with
    // the second prompt drawn as a continuation line of the first.
    const out = [];
    feed.pushUser(out, 'reply with second');
    feed.pushUser(out, 'reply with third');
    const rows = feed.renderFeed(out, 90).map(plain);
    assert.strictEqual(rows.filter((r) => /^USER · /.test(r)).length, 2, rows.join('\n'));
    assert.ok(rows.some((r) => /^USER · reply with third/.test(r)), 'the second message carries its own anchor');
  });

  await test('FEED: one multi-line message is still ONE anchor row', () => {
    const out = [];
    feed.pushUser(out, 'line one\nline two');
    const rows = feed.renderFeed(out, 90).map(plain);
    assert.deepStrictEqual(rows.filter((r) => /^USER/.test(r)).map((r) => r.trim()), ['USER · line one line two'], rows.join('\n'));
  });

  await test('CLOCK: a follow-up after DONE is a new attempt from zero', () => {
    const ui = clockUi();
    workclock.start(ui.clock, 1000);
    workclock.settle(ui.clock, 9000);                  // DONE after 8 s
    assert.strictEqual(alert.attemptFor(ui, { sameTask: true, kind: KIND.STEER }), alert.ATTEMPT.RESTART);
  });

  await test('CLOCK: an interruption carries on only for `continue`', () => {
    const ui = clockUi();
    workclock.start(ui.clock, 1000);
    workclock.settle(ui.clock, 3000);
    ui.interrupted = true;
    assert.strictEqual(alert.attemptFor(ui, { sameTask: true, kind: KIND.STEER }), alert.ATTEMPT.RESTART);
    assert.strictEqual(alert.attemptFor(ui, { sameTask: true, kind: KIND.CONTINUATION }), alert.ATTEMPT.CONTINUE);
  });

  await test('CLOCK: a rate-limit wait carries on whatever is typed', () => {
    const ui = clockUi();
    ui.waitingUntil = Date.now() + 60_000;
    assert.strictEqual(alert.attemptFor(ui, { sameTask: true, kind: KIND.STEER }), alert.ATTEMPT.CONTINUE);
  });

  await test('CLICK: a cached feed frame still knows which row names which file', () => {
    // Dropped by the copy, every settled screen lost click-to-open; the old
    // animation's constant redraws were all that kept the cache out of the way.
    const lines = ['a', 'b'];
    Object.defineProperty(lines, 'fileAt', { value: { 1: 'src/loader.js' }, enumerable: false, writable: true });
    const copy = require('../../src/ui/feedcache').copyOf(lines);
    assert.strictEqual(copy.fileAt && copy.fileAt[1], 'src/loader.js');
  });

  await test('COMPOSER: the hint is dropped when the composer is cancelled or committed', () => {
    const notes = [];
    const app = {
      session: { save() {} },
      ui: { story: { notes } },
      transient: (level, text) => notes.push({ text, level }),
      input: null,
    };
    compose.open(app, compose.KIND.GOAL, { hint: 'What are you trying to achieve? Enter commits, Esc cancels.' });
    assert.strictEqual(notes.length, 1, 'the hint is shown while the composer is open');
    compose.cancel(app);
    assert.strictEqual(notes.length, 0, 'Esc takes it away');
    compose.open(app, compose.KIND.GOAL, { hint: 'What are you trying to achieve? Enter commits, Esc cancels.' });
    compose.take(app, '');
    assert.strictEqual(notes.filter((n) => /achieve/.test(n.text)).length, 0, 'and so does Enter');
  });
};
