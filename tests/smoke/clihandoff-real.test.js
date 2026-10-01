'use strict';

/**
 * CLI ↔ HARNESS CONTINUATION, REAL PROCESSES (the four-gate spec §111) — the real CLI binary and the real window,
 * one config directory, the scripted model. The model is fake; the processes, the files and the handoff are real.
 *
 *   A  start a planned task in the CLI → close the CLI mid-plan → the Harness shows "Paused · CLI closed" →
 *      ▶ Continue (real click) → the SAME task finishes: same task id, the plan continues from the committed step
 *   B  start a planned task in the Harness → close the Harness mid-plan → `lain --resume` + /continue in the CLI →
 *      the SAME task finishes: same task id, same plan, the checkpoint continues
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');

const write = (n) => ({ name: 'write_file', input: { path: `part${n}.txt`, content: `part ${n}` } });
const done = (note) => ({ name: 'plan_step_done', input: { note } });
const readSession = (configDir, id) => JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', fs.readdirSync(path.join(configDir, 'sessions')).find((f) => f.startsWith(id) && f.endsWith('.json'))), 'utf8'));

module.exports = async function () {
  await test('CLI ↔ HARNESS (§111): a CLI task paused by closing the CLI continues in the Harness; a Harness task resumes in the CLI — same task, plan, checkpoint', async () => {
    const drv = require('../harness/appdriver');
    const configDir = require('../../src/config').configDir();
    const cwd = tmpdir('handoff-');

    // ---- A1: START IN THE CLI, CLOSE IT MID-PLAN ------------------------------------------------------------------
    const r1 = await runCli([], {
      cwd, configDir,
      stdinSteps: ['build the report generator in three steps\n', '/exit\n'],
      stepDelayMs: 7000,
      script: [
        { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['read the CSV input', 'build the summary table', 'render the HTML report'] } }] },
        { text: 'The CSV reader.', tool_calls: [write(1), done('reads quoted fields')] },
        { text: 'The summary table is next.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r1.code, 0, `the CLI exits cleanly:\n${r1.stdout.slice(-1200)}`);
    const id = fs.readdirSync(path.join(configDir, 'sessions')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
      .sort().pop();
    const a1 = readSession(configDir, id);
    const taskA = a1.task && a1.task.id;
    assert.ok(taskA, 'the CLI task has an id');
    assert.strictEqual(a1.checkpoint && a1.checkpoint.done, 1, `one step committed in the CLI: ${JSON.stringify(a1.checkpoint)}`);
    assert.strictEqual(a1.workbench && a1.workbench.surface && a1.workbench.surface.pausedBy, 'cli-closed', 'closing the CLI paused the task, it did not end it');

    // ---- A2: THE HARNESS SHOWS IT PAUSED; ▶ CONTINUE (REAL CLICK) FINISHES THE SAME TASK --------------------------
    let d = await drv.open({
      cwd, resume: id, width: 1600, height: 900,
      script: [
        { text: 'The summary table.', tool_calls: [write(2), done('totals per region')] },
        { text: 'The HTML report.', tool_calls: [write(3), done('report.html renders the table')] },
        { text: 'All three parts are done.' },
        { text: 'Planning the exporter.', tool_calls: [{ name: 'plan_write', input: { steps: ['define the export schema', 'write the JSON exporter', 'write the CSV exporter'] } }] },
        { text: 'The schema.', tool_calls: [write(4), done('schema v1')] },
        { text: 'The JSON exporter is next.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    let taskB = null; let idB = null;
    try {
      await d.until("!document.getElementById('app').hidden");
      await d.surface('ide');
      assert.strictEqual(await d.js('LAIN.state().current.id'), id, 'the Harness opened the CLI\'s session');
      await d.until("/Paused · CLI closed/.test((document.getElementById('agentTask') || {}).innerText || '')", 20000);
      assert.match(await d.js("document.getElementById('agentTask').innerText"), /Phase 2 \/ 3/, 'at the committed step');
      await R.click("document.querySelector('#agentTask [data-task-continue]')");
      await d.until("(() => { const p = LAIN.state().plan; return !!(p && p.steps && p.steps.filter((s) => s.status === 'done').length === 3); })()", 60000);
      const a2 = d.app.session;
      assert.strictEqual(a2.task.id, taskA, 'the SAME task finished in the Harness');
      assert.strictEqual(a2.checkpoint.done, 3, 'the checkpoint continued: 3/3');
      for (const n of [1, 2, 3]) assert.strictEqual(fs.readFileSync(path.join(cwd, `part${n}.txt`), 'utf8'), `part ${n}`);

      // ---- B1: START A TASK IN THE HARNESS, CLOSE THE HARNESS MID-PLAN ------------------------------------------
      // The turn finishes first (while it runs, Send is Stop — a person waits for the answer too).
      await d.until("LAIN.state().conversation.some((m) => /All three parts are done/.test(m.text)) && !(LAIN.state().workbench && LAIN.state().workbench.running)", 30000);
      await d.type('#ask', 'write the data exporter in three steps');
      await d.click('#send');
      await d.until('(() => { const s = LAIN.state(); const p = s.plan; return !!(p && p.steps && p.steps.length === 3 && p.steps.filter((x) => x.status === \'done\').length === 1 && !(s.workbench && s.workbench.running)); })()', 60000)
        .catch(async (e) => { throw new Error(`${e.message}\n  state: ${await d.js("JSON.stringify({ plan: LAIN.state().plan && LAIN.state().plan.steps.map((x) => x.status + ':' + x.text), running: LAIN.state().workbench && LAIN.state().workbench.running, lane: document.querySelector('#ideBotHost [aria-selected=true], #ideBotHost .seg .on') && document.querySelector('#ideBotHost [aria-selected=true], #ideBotHost .seg .on').textContent, said: LAIN.state().conversation.slice(-6).map((m) => m.role + '/' + (m.thread || '') + ': ' + String(m.text).slice(0, 60)) })").catch((x) => x.message)}`); });
      taskB = d.app.session.task.id;
      idB = d.app.session.id;
      assert.notStrictEqual(taskB, taskA, 'a new task');
    } finally {
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }

    // ---- B2: RESUME IT FROM THE CLI -----------------------------------------------------------------------------------
    const b1 = readSession(configDir, idB);
    assert.strictEqual(b1.task.id, taskB);
    assert.strictEqual(b1.checkpoint && b1.checkpoint.done, 1, 'the Harness committed step 1');
    const r2 = await runCli(['--resume', idB], {
      cwd, configDir,
      stdinSteps: ['/continue\n', '/plan\n', '/exit\n'],
      stepDelayMs: 6000,
      script: [
        { text: 'The JSON exporter.', tool_calls: [write(5), done('json export with schema v1')] },
        { text: 'The CSV exporter.', tool_calls: [write(6), done('csv export, header row')] },
        { text: 'The exporter is done.' },
      ],
      timeoutMs: 45000,
    });
    assert.strictEqual(r2.code, 0, `the CLI resumes and exits cleanly:\n${r2.stdout.slice(-1500)}`);
    assert.match(r2.stdout, /3\/3 done/, 'the plan finished in the CLI');
    const b2 = readSession(configDir, idB);
    assert.strictEqual(b2.task.id, taskB, 'the SAME task finished in the CLI');
    assert.strictEqual(b2.checkpoint.done, 3);
    assert.ok(b2.checkpoint.generation > b1.checkpoint.generation, 'the checkpoint continued the Harness\'s lineage');
    for (const n of [4, 5, 6]) assert.ok(fs.existsSync(path.join(cwd, `part${n}.txt`)), `part${n} written`);
  });
};
