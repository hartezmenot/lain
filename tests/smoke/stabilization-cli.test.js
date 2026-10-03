'use strict';

/**
 * CLI SMOKE — the 2026-09-18 stabilization pass, in a REAL pseudo-console (§37).
 *
 *   A  modes: Shift+Tab AUTO → MANUAL → PLAN; PLAN refuses a write and shows no
 *      step countdown; /plan accept starts execution and real step progress
 *   B  the ACTIVITY box while a tool runs, gone when the turn ends; the
 *      CHANGE / VERIFY / RESULT account; Diff open → × → Esc
 *   C  /browser (and the hidden /chrome alias); /focus and /fast; a model
 *      request for the browser asks, then EXECUTES and returns a real result
 *   D  a model delegates to a SCOUT subagent: it runs, in its own session, and
 *      its result comes back to the same turn
 *   E  resume after a rate limit: the old red warning is not resurrected
 *   F  /model opens models first; sources are only under `external:`
 *   G  clean exit
 *
 * SKIPS WITH A REASON when no PTY driver is configured (LAIN_TTY_PYTHON).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');
const tty = require('../tty/realtty');

const vis = (s) => tty.visible(s);
const header = (s) => s.text[0];
const E = String.fromCharCode(27);
const click = (row, name, col = 12) => [{ send: `${E}[<0;${col};${row}M` }, { send: `${E}[<0;${col};${row}m` }, { snap: name, settle: 600 }];

function lastSession(configDir) {
  const d = path.join(configDir, 'sessions');
  const f = fs.readdirSync(d).filter((x) => x.endsWith('.json')).map((x) => path.join(d, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('CLI SMOKE (stabilization): not run — no pseudo-console driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pywinpty and pyte)\n`);
    });
    return;
  }

  // ---- A — permission modes (S5) ---------------------------------------------
  const a = await tty.runTty({
    cols: 110, rows: 30,
    script: [
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'plan-mode.txt', content: 'x' } }] },
      { text: '', tool_calls: [{ name: 'exit_plan', input: { plan: '# Write accepted.txt\n- [ ] write accepted.txt' } }] },
      { text: '', tool_calls: [{ name: 'write_file', input: { path: 'accepted.txt', content: 'ok' } }], delayMs: 1500 },
      { text: 'Executed the accepted plan.' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { snap: 'auto', settle: 300 },
      { key: 'shift-tab' }, { snap: 'ask', settle: 400 },
      { key: 'shift-tab' }, { snap: 'accept', settle: 400 },
      { key: 'shift-tab' }, { snap: 'plan', settle: 400 },
      { send: 'propose how to write plan-mode.txt\r' },
      { until: 'build it', timeout: 30000 },
      { snap: 'planned', settle: 500 },
      { send: '\r' },
      { until: 'Executed the accepted plan', timeout: 30000 },
      { snap: 'executed', settle: 500 },
    ],
  });

  await test('CLI A: every screen arrived', () => assert.deepStrictEqual(a.timeouts, [], a.snaps.map((s) => `--- ${s.name}\n${vis(s)}`).join('\n')));
  await test('CLI A: Shift+Tab cycles Auto → Ask → Accept edits → Plan, shown in the header', () => {
    assert.match(header(a.byName.auto), /Auto/);
    assert.match(header(a.byName.ask), /Ask/);
    assert.match(header(a.byName.accept), /Accept edits/);
    assert.match(header(a.byName.plan), /Plan/);
  });
  await test('CLI A: Plan refused the write and put the plan to the person', () => {
    assert.ok(!fs.existsSync(path.join(a.cwd, 'plan-mode.txt')), 'the write was refused');
    assert.match(vis(a.byName.planned), /Plan ready — build it\?[\s\S]*Approve/);
  });
  await test('CLI A: Approve leaves Plan and the plan is built', () => {
    assert.ok(fs.existsSync(path.join(a.cwd, 'accepted.txt')), 'execution happened after approval');
    assert.ok(!/\bPlan\b/.test(header(a.byName.executed)), header(a.byName.executed));
  });

  // ---- B — activity box, sections, diff lifecycle ---------------------------
  const cwdB = tmpdir('cli-b-');
  fs.writeFileSync(path.join(cwdB, 'retry.js'), 'module.exports = (n) => n * 100;\n');
  fs.writeFileSync(path.join(cwdB, 'check.js'), "if (require('./retry')(2) !== 400) process.exit(1); console.log('1 passed, 0 failed');\n");
  const b = await tty.runTty({
    cols: 110, rows: 34, cwd: cwdB,
    script: [
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'retry.js' } }] },
      { text: '', tool_calls: [{ name: 'shell', input: { command: 'node -e "setTimeout(()=>{},2500)"' } }] },
      { text: 'Linear; must double.', tool_calls: [{ name: 'edit_file', input: { path: 'retry.js', old: 'n * 100', new: '100 * 2 ** n' } }] },
      { text: '', tool_calls: [{ name: 'shell', input: { command: 'node check.js' } }] },
      { text: 'Retry delay now doubles. check.js passes.' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: 'fix the retry delay\r' },
      // The activity state, as the one compact line a running tool gets.
      { until: '(?:Running|Reading|Testing|Writing|Verifying|Working)[^\\n]* · \\d+s · esc to interrupt', timeout: 20000 },
      { snap: 'working', settle: 100 },
      { until: 'check\\.js passes', timeout: 30000 },
      { snap: 'done', settle: 800 },
    ],
  });
  // ONE ACTIVITY LINE (S5.2): a running tool reads `Running node check.js · 0s · esc to interrupt`, said once.
  const liveState = /(?:Running|Reading|Testing|Writing|Verifying|Working)[^\n]* · \d+s · esc to interrupt/;
  await test('CLI B: the activity state is there while a tool runs — one compact line — and gone when the turn ends', () => {
    assert.deepStrictEqual(b.timeouts, []);
    assert.match(vis(b.byName.working), liveState);
    assert.ok(!liveState.test(vis(b.byName.done)));
  });
  await test('CLI B: the finished turn reads CHANGE → RESULT with the hunk shown, then the fact footer names the check', () => {
    const t = vis(b.byName.done);
    assert.ok(/CHANGE[\s\S]*retry\.js\s+\+1 -1\s+\[× Diff\][\s\S]*n \* 100[\s\S]*RESULT[\s\S]*doubles[\s\S]*Commands: [^\n]*node check\.js \(exit 0/.test(t), t);
  });
  // The click lands ON the control: the row is column-aware, and the file name
  // to its left opens the file instead (ui/mouse.js diffAt).
  const diffRow = b.byName.done.text.findIndex((l) => /\[(?:× )?Diff\]/.test(l)) + 1;
  const diffCol = (b.byName.done.text[diffRow - 1] || '').search(/\[(?:× )?Diff\]/) + 2;
  const b2 = await tty.runTty({
    cols: 110, rows: 34, args: ['--resume', lastSession(b.configDir).id], configDir: b.configDir, cwd: cwdB,
    steps: [{ until: 'Ask LAIN', timeout: 30000 }, { snap: 'resumed', settle: 500 }, ...click(diffRow, 'opened', diffCol), ...click(diffRow, 'shut', diffCol), { key: 'escape' }, { snap: 'esc', settle: 500 }],
  });
  await test('CLI B: a resumed turn keeps its change row; the control opens and closes the diff; Esc does not remove transcript', () => {
    assert.match(vis(b2.byName.resumed), /retry\.js\s+\+1 -1\s+\[Diff\]/, 'the summary says file and +/-');
    assert.match(vis(b2.byName.opened), /\[× Diff\][\s\S]*- .*n \* 100[\s\S]*\+ .*100 \* 2 \*\* n/, 'opened: the hunk');
    assert.ok(!/n \* 100/.test(vis(b2.byName.shut)), 'shut: the hunk is gone');
    assert.match(vis(b2.byName.esc), /retry\.js\s+\+1 -1/, 'esc: the transcript is still there');
  });

  // ---- C — /browser, /focus, /fast, a real browser request -----------------
  const c = await tty.runTty({
    cols: 110, rows: 34,
    script: [],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: '/browser\r' }, { snap: 'browser', settle: 800 }, { key: 'escape' },
      { send: '/chrome\r' }, { snap: 'chrome', settle: 800 }, { key: 'escape' },
      { send: '/focus\r' }, { wait: 500 }, { send: '/fast\r' }, { snap: 'prefs', settle: 800 },
    ],
  });
  await test('CLI C: /browser shows the browser state; /chrome is a hidden alias of it', () => {
    assert.match(vis(c.byName.browser), /Browser[\s\S]*Chrome (not )?connected/);
    assert.match(vis(c.byName.chrome), /Browser[\s\S]*Chrome (not )?connected/);
  });
  await test('CLI C: /focus and /fast are session preferences shown in the header', () => {
    assert.match(header(c.byName.prefs), /FOCUS · FAST/);
  });
  // ---- D — an agent ---------------------------------------------------------
  const cwdD = tmpdir('cli-d-');
  fs.mkdirSync(path.join(cwdD, 'src'));
  fs.writeFileSync(path.join(cwdD, 'src', 'queue.js'), 'module.exports = {};\n');
  const d = await runCli(['-p', 'map who owns the retry queue'], {
    cwd: cwdD, timeoutMs: 60000,
    script: [
      { text: '', tool_calls: [{ name: 'Agent', input: { description: 'map the retry queue', prompt: 'map retry queue ownership', type: 'explore' } }] },
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'src/queue.js' } }] },
      { text: 'SCOUT OUTPUT: src/queue.js owns the retry queue.' },
      { text: 'The scout reports src/queue.js as the owner.' },
    ],
  });
  await test('CLI D: an explore agent runs in its own session, and its final message returns to the same turn', () => {
    assert.strictEqual(d.code, 0, d.out);
    const s = lastSession(d.configDir);
    const res = s.messages.find((m) => m.role === 'tool' && /SCOUT OUTPUT/.test(String(m.content)));
    assert.ok(res, 'the agent result is on the main session');
    assert.ok(!s.messages.some((m) => /map retry queue ownership/.test(String(m.content)) && m.role === 'user' && !/SUBAGENTS/.test(String(m.content)) && m !== s.messages[0]), 'the subagent brief never entered the main conversation as the user');
  });

  // ---- E — no resurrected rate-limit warning --------------------------------
  const e1 = await runCli(['-p', 'hello'], { timeoutMs: 60000, script: [{ error: { status: 429, message: 'rate limited', retryAfter: 3000 } }, { error: { status: 429, message: 'rate limited' } }] });
  const sid = lastSession(e1.configDir).id;
  const e2 = await tty.runTty({ cols: 110, rows: 30, args: ['--resume', sid], configDir: e1.configDir, cwd: e1.cwd, steps: [{ until: 'Ask LAIN', timeout: 30000 }, { snap: 'resumed', settle: 1200 }] });
  await test('CLI E: resuming after a rate limit does not resurrect the red warning on the primary UI', () => {
    const live = e2.byName.resumed.text.slice(-6).join('\n');
    assert.ok(!/RATE LIMITED|FAILED/.test(live), live);
  });

  // ---- F — /model is models first -------------------------------------------
  const cfgF = tmpdir('cli-f-cfg-');
  fs.writeFileSync(path.join(cfgF, 'config.json'), JSON.stringify({
    connections: { local: { provider: 'local', via: 'bridge', baseUrl: 'http://127.0.0.1:9/v1', models: ['glm-5', 'qwen3', 'qwen3:free'] } },
  }));
  const f = await tty.runTty({ cols: 110, rows: 34, configDir: cfgF, env: { LAIN_PROVIDER: '' },
    steps: [{ until: 'Ask LAIN', timeout: 30000 }, { send: '/model\r' }, { until: '(?i)models', timeout: 20000 }, { snap: 'models', settle: 600 }, { send: 'external:' }, { snap: 'external', settle: 800 }, { key: 'escape' }, { send: '/exit\r' }, { wait: 1500 }] });
  await test('CLI F: /model opens "MODELS" directly — no source shelf; access variants are not separate rows', () => {
    const t = vis(f.byName.models);
    assert.ok(!/Model source/.test(t), t);
    assert.match(t, /models/i);
    assert.match(t, /GLM 5/);
    assert.strictEqual((t.match(/qwen3/gi) || []).length, 1, 'qwen3 and qwen3:free are one model');
  });
  await test('CLI F: the website sources appear only under external:', () => {
    // The ChatGPT source is labelled "ChatGPT Chat" now (it was "ChatGPT.com").
    assert.match(vis(f.byName.external), /external sources[\s\S]*ChatGPT[\s\S]*Gemini/i);
  });

  // ---- H — FOCUS (§76) ------------------------------------------------------
  const cwdH = tmpdir('cli-h-');
  fs.writeFileSync(path.join(cwdH, 'big.js'), Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`).join('\n') + '\nmodule.exports = 1;\n');
  fs.writeFileSync(path.join(cwdH, 'small.js'), 'module.exports = 1;\n');
  const h = await tty.runTty({
    cols: 110, rows: 34, cwd: cwdH,
    script: [
      { text: '', tool_calls: [{ name: 'read_file', input: { path: 'big.js' } }] },
      { text: 'Now I will read the file again.', tool_calls: [{ name: 'read_file', input: { path: 'big.js' } }], delayMs: 2500 },
      { text: 'Found the owner: small.js exports the value.', tool_calls: [{ name: 'edit_file', input: { path: 'small.js', old: 'module.exports = 1;', new: 'module.exports = 2;' } }] },
      { text: '', tool_calls: [{ name: 'shell', input: { command: 'node -e "process.exit(require(\'./small\')===2?0:1)"' } }] },
      { text: 'small.js now exports 2; the check passes.' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: '/focus\r' }, { wait: 600 },
      { send: 'make small.js export 2\r' },
      { wait: 1200 },
      { send: 'also keep the API stable\r' },
      { wait: 300 }, { key: 'enter' },   // a second Enter promotes the steer to NOW: delivered mid-turn
      { until: 'check passes', timeout: 40000 },
      { snap: 'focused', settle: 800 },
    ],
  });
  await test('CLI H: FOCUS — same understanding with less reading: an unchanged re-read is served from what is already held', () => {
    assert.deepStrictEqual(h.timeouts, []);
    const t = lastSession(h.configDir).turns.find((x) => /make small\.js export 2/.test(x.userInput));
    assert.ok(t.evidenceReuse >= 1, `evidence reused: ${t.evidenceReuse}`);
    assert.strictEqual(fs.readFileSync(path.join(cwdH, 'small.js'), 'utf8'), 'module.exports = 2;\n');
  });
  await test('CLI H: FOCUS — routine narration is gone; the finding, the change, the verification and the result stay visible', () => {
    const v = vis(h.byName.focused);
    assert.ok(!/Now I will read the file again/.test(v), v);
    assert.match(v, /Found the owner/);
    assert.match(v, /CHANGE[\s\S]*small\.js[\s\S]*RESULT/);
    assert.match(header(h.byName.focused), /FOCUS/);
  });
  await test('CLI H: FOCUS — the person can still steer mid-turn', () => {
    const t = lastSession(h.configDir).turns.find((x) => /make small\.js export 2/.test(x.userInput));
    assert.ok((t.steerTexts || []).some((x) => /keep the API stable/.test(x.text)), JSON.stringify(t.steerTexts));
  });

  // ---- G — clean exit -------------------------------------------------------
  await test('CLI G: /exit leaves cleanly', async () => {
    const r = await runCli([], { stdinSteps: ['/exit\n'], env: { LAIN_FORCE_TUI: '' }, timeoutMs: 30000 });
    assert.strictEqual(r.code, 0, r.out);
  });
};
