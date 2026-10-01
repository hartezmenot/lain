'use strict';

/**
 * THE COMMAND SHELVES IN A REAL TERMINAL — /goal, /plan, /model.
 *
 * Evidence tier: REAL_TTY_VERIFIED (tests/tty/realtty.js). SKIPS, and says so,
 * without a pseudo-console driver.
 *
 * Drives the whole goal lifecycle through keys a person would press — empty
 * composer, commit, shelf, Edit, New (by its letter), selection between two
 * goals, Delete with the in-place question — then /plan's composer and shelf,
 * /model's source shelf, and an ordinary prompt afterwards to prove none of it
 * held the input path. The saved session is read back at the end.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const tty = require('../tty/realtty');

const text = (snap) => tty.visible(snap);

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('SHELVES: skipped — no pseudo-console driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }

  await test('SHELVES: /goal, /plan and /model are compact action shelves, driven by keys', async () => {
    const out = await tty.runTty({
      cols: 110, rows: 34,
      // A captured goal EXECUTES (2026-09-23): each gets a reply that changes something.
      script: [
        { text: '', tool_calls: [{ name: 'write_file', input: { path: 'g1.txt', content: '1' } }] }, { text: 'R_GOAL1' },
        { text: '', tool_calls: [{ name: 'write_file', input: { path: 'g2.txt', content: '2' } }] }, { text: 'R_GOAL2' },
        { text: 'R_AFTER_SHELVES' },
      ],
      steps: [
        { until: 'Ask Noema', timeout: 40000 },
        // No goal: straight into the composer.
        { send: '/goal\r' }, { until: 'GOAL ›', timeout: 10000 }, { snap: 'goalEmpty', settle: 400 },
        { send: 'Finish Noema Harness\r' }, { until: 'R_GOAL1', timeout: 30000 }, { wait: 900 },
        // A goal: the shelf is `/goal show` (bare /goal captures a NEW goal).
        { send: '/goal show\r' }, { until: 'Continue', timeout: 10000 }, { snap: 'goalShelf', settle: 400 },
        { key: 'right' }, { key: 'enter' }, { until: 'GOAL ›', timeout: 10000 }, { snap: 'goalEdit', settle: 400 },
        { send: ' and desktop control\r' }, { wait: 900 },
        // New, by its letter.
        { send: '/goal show\r' }, { until: 'Continue', timeout: 10000 }, { send: 'n' }, { until: 'GOAL ›', timeout: 10000 },
        { send: 'Fix the release blocker\r' }, { until: 'R_GOAL2', timeout: 30000 }, { wait: 900 },
        // Two goals: choose the paused one, Delete, answer the in-place question.
        { send: '/goal show\r' }, { until: 'active', timeout: 10000 }, { snap: 'goalTwo', settle: 400 },
        { key: 'down' }, { key: 'left' }, { key: 'enter' }, { snap: 'goalConfirm', settle: 400 },
        { key: 'left' }, { key: 'enter' }, { wait: 900 },
        { send: '/goal show\r' }, { until: 'Continue', timeout: 10000 }, { snap: 'goalAfterDelete', settle: 400 },
        { key: 'escape' }, { snap: 'goalClosed', settle: 500 },
        // /plan: composer, then the shelf.
        { send: '/plan\r' }, { until: 'PLAN ›', timeout: 10000 }, { snap: 'planEmpty', settle: 400 },
        { send: 'stabilize CLI → build Harness → Computer MCP\r' }, { wait: 900 },
        { send: '/plan\r' }, { until: 'Delete', timeout: 10000 }, { snap: 'planShelf', settle: 400 },
        { key: 'escape' }, { wait: 400 },
        // /model: MODELS first (§54–55) — sources are secondary (external:, /source).
        { send: '/model\r' }, { until: '(?i)models', timeout: 15000 }, { snap: 'modelShelf', settle: 400 },
        { key: 'escape' }, { wait: 400 },
        // And the input path is free.
        { send: 'reply after shelves\r' }, { until: 'R_AFTER_SHELVES', timeout: 20000 }, { snap: 'after', settle: 800 },
      ],
    });
    assert.deepStrictEqual(out.timeouts, [], `every screen was reached:\n${out.snaps.map((s) => `== ${s.name}\n${text(s)}`).join('\n')}`);
    const s = out.byName;

    assert.match(text(s.goalEmpty), /GOAL ›/);
    assert.ok(!/Continue/.test(text(s.goalEmpty)), 'no shelf when there is no goal');

    const shelf = text(s.goalShelf);
    assert.match(shelf, /Finish Noema Harness/);
    assert.match(shelf, /Continue\s+Edit\s+New\s+Delete/, 'the actions on one row');
    assert.ok(!/you can type \/goal/i.test(shelf), 'no narration');

    assert.match(text(s.goalEdit), /GOAL ›\s*Finish Noema Harness/, 'Edit puts the goal back on the line');

    const two = text(s.goalTwo);
    assert.match(two, /Fix the release blocker\s+· active/);
    assert.match(two, /Finish Noema Harness and desktop control/, 'New kept the previous goal');

    assert.match(text(s.goalConfirm), /Delete this goal\?/, 'Delete asks in place');
    const after = text(s.goalAfterDelete);
    assert.ok(!/Finish Noema Harness/.test(after), 'the selected paused goal is gone');
    assert.match(after, /Fix the release blocker/, 'and the active one remains');
    assert.ok(!/Continue\s+Edit/.test(text(s.goalClosed)), 'Esc closes the shelf');

    assert.match(text(s.planEmpty), /PLAN ›/);
    const plan = text(s.planShelf);
    assert.match(plan, /1\. stabilize CLI/);
    assert.match(plan, /3\. Computer MCP/);
    assert.match(plan, /Continue\s+Edit\s+Add\s+New\s+Delete/);

    const model = text(s.modelShelf);
    assert.ok(!/Model source/.test(model), 'no source shelf in front of the models');
    assert.match(model, /models/i);

    assert.match(text(s.after), /R_AFTER_SHELVES/, 'a prompt after the shelves is answered');

    // THE RECORD AGREES WITH THE SCREEN.
    const dir = path.join(out.configDir || '', 'sessions');
    if (out.configDir && fs.existsSync(dir)) {
      const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
      const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      assert.strictEqual(saved.goal && saved.goal.text, 'Fix the release blocker');
      assert.deepStrictEqual(saved.pausedGoals, [], 'the deleted paused goal is not on disk');
      // (Until 2026-09-23 no goal ran a turn, so the last prompt was the first
      // task and the plan was asserted gone. Captured goals now EXECUTE, so a
      // task is live and identify.js may read the last line as part of it. A NEW
      // task still drops the plan: identify.js `if (!sameTask) session.plan = null`.)
      assert.ok(fs.existsSync(path.join(out.cwd, 'g1.txt')) && fs.existsSync(path.join(out.cwd, 'g2.txt')), 'both captured goals executed');
    }
  });

  // ---------------------------------------------------------------------
  // CONTINUE MEANS CONTINUE — pressed with real keys, in a real terminal.
  //
  // The Goal shelf's Continue used to select the goal and wait for the person
  // to type "continue" at it; the Plan shelf's matched no branch and did what
  // Escape did. Here each is pressed with Enter and NOTHING ELSE IS TYPED — the
  // model's answer arriving is the proof that a turn really started, and the
  // user block on screen is the proof of what it was told.
  await test('SHELVES: Continue on the Goal and Plan shelves starts the work, with nothing typed', async () => {
    const out = await tty.runTty({
      cols: 120, rows: 40,
      script: [
        // `/goal <text>` executes at once (2026-09-23).
        { text: '', tool_calls: [{ name: 'write_file', input: { path: 'g.txt', content: 'g' } }] }, { text: 'R_GOAL_SET' },
        { text: 'R_GOAL_CONTINUED' }, { text: 'R_PLAN_CONTINUED' },
      ],
      steps: [
        { until: 'Ask Noema', timeout: 40000 },
        { send: '/goal Finish fixture frontend\r' }, { until: 'R_GOAL_SET', timeout: 30000 }, { wait: 900 },
        { send: '/plan\r' }, { until: 'PLAN ›', timeout: 10000 },
        { send: 'change heading → verify mobile → capture evidence\r' }, { wait: 900 },

        // GOAL → Continue. Continue is the first action, so Enter presses it.
        { send: '/goal show\r' }, { until: 'Continue', timeout: 10000 }, { snap: 'goalShelf', settle: 400 },
        { key: 'enter' },
        { until: 'R_GOAL_CONTINUED', timeout: 30000 }, { snap: 'goalRan', settle: 900 },

        // PLAN → Continue, the same way.
        { send: '/plan\r' }, { until: 'Delete', timeout: 10000 }, { snap: 'planShelf', settle: 400 },
        { key: 'enter' },
        { until: 'R_PLAN_CONTINUED', timeout: 30000 }, { snap: 'planRan', settle: 900 },
      ],
    });
    assert.deepStrictEqual(out.timeouts, [], `every screen was reached:\n${out.snaps.map((s) => `== ${s.name}\n${text(s)}`).join('\n')}`);
    const s = out.byName;

    assert.match(text(s.goalShelf), /Continue\s+Edit\s+New\s+Delete/);

    const goalRan = text(s.goalRan);
    assert.match(goalRan, /R_GOAL_CONTINUED/, 'pressing Continue on the goal started a turn');
    // WHAT IT WAS TOLD, READ OFF THE SCREEN — not the word "continue".
    assert.match(goalRan, /Continue working toward this goal: Finish fixture frontend/,
      'the turn carried the goal, not a bare "continue"');
    assert.match(goalRan, /plan step 1 of 3: change heading/, 'and the step it resumes at');
    assert.ok(!/Continue\s+Edit\s+New\s+Delete/.test(goalRan), 'and the shelf closed');

    const planRan = text(s.planRan);
    assert.match(planRan, /R_PLAN_CONTINUED/, 'pressing Continue on the plan started a turn too');
    assert.match(planRan, /Resume at plan step \d of 3/, 'resuming the plan rather than restarting it');
  });
};
