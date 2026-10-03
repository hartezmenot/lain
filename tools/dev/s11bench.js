'use strict';

/**
 * S11: the ten real tasks on one model (GLM 5.3 via lain:zai by default), one run each, a fresh fixture per task.
 * Records per task: requests, tokens in/out/cached, cache %, effort sent, first-byte and thinking time, wall time,
 * correctness, and every guard that fired. Usage: node tools/dev/s11bench.js <label> [ids=1..10]
 * Output: docs/simplify/bench-<label>.json, plus one log per task beside it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const sb = require('./simplebench');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'simplify');
const label = process.argv[2] || 's11';
const ids = String(process.argv[3] || '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
const TTY_PY = process.env.LAIN_TTY_PYTHON || path.join(os.homedir(), '.lain-ttyenv', 'Scripts', 'python.exe');

// ---- environment -----------------------------------------------------------------------------------------------------
const homes = [];
function home(patch = {}) {
  const h = sb.benchHome();
  homes.push(h);
  const cfgFile = path.join(h, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, ...patch }, null, 2));
  return h;
}
function envFor(h, trace, extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAIN_') && !k.startsWith('NOEMA_'))),
    LAIN_CONFIG_DIR: h, LAIN_HOME: path.join(h, 'sup'), LAIN_REQTRACE: trace, LAIN_NO_DESKTOP: '1', LAIN_NO_UPDATE_CHECK: '1', LAIN_TEMP_ROOT: path.join(h, 'tmp'), ...extra, ...JSON.parse(process.env.S11_EXTRA || '{}') };   // S11_EXTRA: a dry run's mock provider
}
const SLOW = "'use strict';\nsetTimeout(() => { console.log('slow suite: 3 passed'); }, 25000);\n";
function fixture() { const d = sb.fixture(); fs.writeFileSync(path.join(d, 'test', 'slow.js'), SLOW); return d; }
function trust(h, dir) {
  const f = path.join(h, 'config.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.trustedPaths = [...(c.trustedPaths || []), { path: dir, level: 'TRUSTED', at: new Date().toISOString() }];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

// ---- running ---------------------------------------------------------------------------------------------------------
function runP(args, dir, env, { killWhen = null, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'lain.js'), ...args], { cwd: dir, env, windowsHide: true });
    let out = ''; let killed = false;
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
    const watch = killWhen ? setInterval(() => { if (!killed && killWhen()) { killed = true; setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1500); } }, 300) : null;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); if (watch) clearInterval(watch); resolve({ code, out, ms: Date.now() - t0, killed }); });
  });
}

function runTty(scenario) {
  const file = path.join(os.tmpdir(), `s11-tty-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(scenario));
  const t0 = Date.now();
  const r = spawnSync(TTY_PY, [path.join(ROOT, 'tests', 'tty', 'ptydrive.py'), file], { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  let res = {};
  try { res = JSON.parse(r.stdout); } catch { res = { error: (r.stderr || r.stdout || '').slice(-2000) }; }
  return { ...res, ms: Date.now() - t0 };
}

function sessions(h) {
  const d = path.join(h, 'sessions');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ---- measuring -------------------------------------------------------------------------------------------------------
const GUARD = /^(DENIED|Denied by your permission rules|Plan mode: read-only|unknown tool|The person did not allow|.*needs the person's yes|Computer Control is off|.*refused|.*not offered|the computer (was|is) not authorized)/i;
function measure(trace, h) {
  const reqs = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const model = reqs.filter((q) => q.systemChars != null);
  const sum = (k) => model.reduce((n, q) => n + ((q.receipt && q.receipt[k]) || 0), 0);
  const input = sum('inputTokens'); const cached = sum('cacheReadTokens');
  const fb = model.map((q) => q.firstByteMs).filter((x) => x != null);
  const guards = [];
  for (const s of sessions(h)) for (const t of s.turns || []) for (const a of t.actions || []) {
    if (a.denied || (!a.ok && GUARD.test(String(a.note || '')))) guards.push(`${a.name}: ${String(a.note || '').slice(0, 120)}`);
  }
  return {
    requests: reqs.length, modelRequests: model.length, inputTokens: input, outputTokens: sum('outputTokens'), cachedTokens: cached,
    cachePct: input ? Math.round((100 * cached) / input) : null,
    effort: [...new Set(model.map((q) => (q.effort == null ? 'none' : String(q.effort))))],
    firstByteMs: fb.length ? fb[0] : null, firstByteAvgMs: fb.length ? Math.round(fb.reduce((a, b) => a + b, 0) / fb.length) : null,
    thinkingMs: model.reduce((n, q) => n + (q.reasoningMs || 0), 0), reasoningTokens: model.reduce((n, q) => n + (q.reasoningTokens || 0), 0),
    toolCount: model.length ? model[0].toolCount : null, toolSchemaChars: model.length ? Math.max(...model.map((q) => q.toolSchemaChars || 0)) : null,
    systemChars: model.length ? model[0].systemChars : null, guards,
  };
}
const actions = (h) => sessions(h).flatMap((s) => (s.turns || []).flatMap((t) => t.actions || []));
const lastText = (h) => { const s = sessions(h).pop(); const t = s && (s.turns || []).slice(-1)[0]; return (t && t.text) || ''; };

// ---- the tasks -------------------------------------------------------------------------------------------------------
const P = (prompt, check) => ({ kind: 'p', prompt, check });
const TASKS = {
  1: { name: 'rename a UI label', ...P(sb.TASKS[1].prompt, (d, text) => sb.TASKS[1].check(d, text)) },
  2: { name: 'make a button 10% smaller', ...P(sb.TASKS[2].prompt, (d, text) => sb.TASKS[2].check(d, text)) },
  3: { name: 'fix a small bug', ...P(sb.TASKS[3].prompt, (d, text) => sb.TASKS[3].check(d, text)) },
  4: { name: 'a read-only question', ...P(sb.TASKS[4].prompt, (d, text) => sb.TASKS[4].check(d, text)) },
  5: { name: 'several files and steps', ...P(sb.TASKS[5].prompt, (d, text) => sb.TASKS[5].check(d, text)) },
  6: { name: 'a long background test while continuing',
    ...P('Start the slow suite `node test/slow.js` (it takes about 25 seconds) in the background. While it runs, rename the "Add task" button label to "New task". Then wait for the slow suite and tell me its result.',
      (d, text, h) => { const bg = actions(h).some((a) => /^(shell|bash|Bash)$/.test(a.name) && /slow\.js/.test(a.target || '') && (a.job || /background|job/i.test(a.note || ''))); const lbl = />New task</.test(sb.read(d, 'index.html')); const res = /3 passed/.test(text); return { ok: bg && lbl && res, why: `background:${bg} label:${lbl} result-reported:${res}` }; }) },
  7: { name: 'two explore agents in parallel',
    ...P('Use two explore agents in parallel: one finds where completed tasks are counted, the other finds how the "Add task" button is wired to the store. Then give me both answers. Do not change any files.',
      (d, text, h) => { const ag = actions(h).filter((a) => a.name === 'Agent'); const steps = new Set(ag.map((a) => a.step)); const ch = sb.unchanged(d); const ok = ag.length >= 2 && steps.size < ag.length && !ch.length && /countDone/.test(text) && /addTask|onclick|app\.js/.test(text); return { ok, why: `agents:${ag.length} sameStep:${steps.size < ag.length} changed:${ch.join(',') || 'none'}` }; }) },
  8: { name: 'Plan → edit → Build', kind: 'tty-plan' },
  9: { name: 'resume after killing LAIN mid-task', kind: 'resume' },
  10: { name: 'Computer Control in Auto (Calculator)', kind: 'computer' },
};

async function taskP(id, t) {
  const h = home(); const d = fixture(); const trace = path.join(h, `req-${id}.jsonl`);
  const r = await runP(['-p', t.prompt], d, envFor(h, trace, { LAIN_NO_COLOR: '1' }));
  const v = t.check(d, r.out + '\n' + lastText(h), h);
  return { log: r.out, wallMs: r.ms, exit: r.code, correct: v.ok, why: v.why || '', ...measure(trace, h) };
}

// 8: Plan mode in a real terminal: Shift+Tab into Plan, the plan is proposed, the person EDITS it ($EDITOR adds a step), approves, and it is built.
async function taskPlan(id) {
  const h = home({ permissions: { defaultMode: 'acceptEdits', allow: ['shell(node:*)', 'shell(npm:*)'] } }); const d = fixture(); trust(h, d);
  const trace = path.join(h, `req-${id}.jsonl`);
  const editor = path.join(h, 'editplan.js');
  fs.writeFileSync(editor, "const fs=require('fs');const f=process.argv[2];fs.appendFileSync(f,'\\n- [ ] Name the new test exactly: clearCompleted removes done tasks\\n');\n");
  const steps = [
    { until: 'Ask LAIN', timeout: 60000 },
    { key: 'shift-tab' }, { until: 'Plan', timeout: 10000 }, { snap: 'plan', settle: 400 },
    { send: 'Plan adding a clearCompleted(store) function to src/store.js that removes done tasks, with a test for it in test/run.js. Then build it and run the tests.\r' },
    { until: 'build it\\?', timeout: 600000 }, { snap: 'proposed', settle: 800 },
    { key: 'down' }, { send: '\r' },
    { until: 'build it\\?', timeout: 60000 }, { snap: 'edited', settle: 800 },
    { send: '\r' },
    { until: 'DONE|CUT OFF|STOPPED|FAILED', timeout: 900000 }, { snap: 'built', settle: 1500 },
    { send: '/exit\r' }, { wait: 1500 },
  ];
  const r = runTty({ argv: [process.execPath, path.join(ROOT, 'bin', 'lain.js')], cwd: d, env: envFor(h, trace, { EDITOR: `"${process.execPath}" "${editor}"`, VISUAL: `"${process.execPath}" "${editor}"` }), cols: 120, rows: 40, steps });
  // FUNCTIONAL, not the suite's exit code: the fixture's own countDone bug stops test/run.js before an appended test runs.
  const probe = "const s=require('./src/store');const st=s.createStore();const a=s.addTask(st,'a');s.addTask(st,'b');s.toggle(st,a.id);"
    + "const r=s.clearCompleted(st);const t=Array.isArray(r)?r:(r&&r.tasks)||st.tasks;console.log(t.length===1&&t[0].title==='b'?'OK':'BAD '+JSON.stringify(t))";
  const fn = spawnSync(process.execPath, ['-e', probe], { cwd: d, encoding: 'utf8' });
  const t = { ok: /^OK/.test((fn.stdout || '').trim()), out: ((fn.stdout || '') + (fn.stderr || '')).trim().split(/\r?\n/).pop() };
  const named = /clearCompleted removes done tasks/.test(sb.read(d, 'test/run.js'));
  const plans = fs.existsSync(path.join(d, '.lain', 'plans')) ? fs.readdirSync(path.join(d, '.lain', 'plans')) : [];
  const ok = t.ok && /clearCompleted/.test(sb.read(d, 'src/store.js')) && named && plans.length > 0 && !(r.timeouts || []).length;
  return { log: JSON.stringify({ timeouts: r.timeouts, error: r.error, snaps: (r.snaps || []).map((s) => ({ name: s.name, text: s.text })) }, null, 1), wallMs: r.ms, exit: r.exit == null ? null : r.exit,
    correct: ok, why: `clearCompleted:${t.out} editHonoured:${named} planFile:${plans.length} timeouts:${(r.timeouts || []).join('|') || 'none'}${r.error ? ` error:${String(r.error).slice(0, 200)}` : ''}`, ...measure(trace, h) };
}

// 9: the multi-step task, LAIN killed (TerminateProcess) right after its first edit lands, then `--resume <id> -p continue`.
async function taskResume(id) {
  const h = home(); const d = fixture(); const trace = path.join(h, `req-${id}.jsonl`);
  const changed = () => sb.unchanged(d, ['test/slow.js']).length > 0;
  const a = await runP(['-p', sb.TASKS[5].prompt], d, envFor(h, trace, { LAIN_NO_COLOR: '1' }), { killWhen: changed });
  const s = sessions(h).pop();
  if (!s) return { log: a.out, wallMs: a.ms, exit: a.code, correct: false, why: 'no session to resume', ...measure(trace, h) };
  const b = await runP(['--resume', s.id, '-p', 'continue'], d, envFor(h, trace, { LAIN_NO_COLOR: '1' }));
  const v = sb.TASKS[5].check(d, b.out);
  return { log: `${a.out}\n===== KILLED (${a.killed}) — RESUMED ${s.id} =====\n${b.out}`, wallMs: a.ms + b.ms, exit: b.code, correct: v.ok && a.killed, why: `killed:${a.killed} ${v.why || ''}`, ...measure(trace, h) };
}

// 10: a Calculator window this script opens; Computer Control in Auto; the desktop authorization answered in LAIN's own terminal.
function ps(cmd) { const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000, windowsHide: true }); return (r.stdout || '').trim(); }
async function taskComputer(id) {
  const userNotepad = () => ps("(Get-Process -Id 34072 -ErrorAction SilentlyContinue).MainWindowTitle");
  if (ps("(Get-Process CalculatorApp -ErrorAction SilentlyContinue | Measure-Object).Count") !== '0') return { correct: false, why: 'NOT RUN: a Calculator is already running — it may be the person\'s', skipped: true };
  const before = userNotepad();
  spawnSync('cmd.exe', ['/c', 'start', '', 'calc.exe'], { windowsHide: true });
  let hwnd = '';
  for (let i = 0; i < 40 && !hwnd; i++) { await new Promise((r) => setTimeout(r, 500)); hwnd = ps("Add-Type -AssemblyName UIAutomationClient; $c=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Calculator'))); if($c){$c.Current.NativeWindowHandle}"); }
  if (!hwnd) return { correct: false, why: 'NOT RUN: the Calculator window did not appear', skipped: true };
  const h = home({ permissions: { defaultMode: 'auto' } }); const d = fixture(); trust(h, d);
  const trace = path.join(h, `req-${id}.jsonl`);
  const steps = [
    { until: 'Ask LAIN', timeout: 60000 },
    { send: `Use Computer Control on the Calculator window (title "Calculator", window handle ${hwnd}) — only that window: compute 123 * 4 by clicking or typing in it, then read the result from its display and tell me the number.\r` },
    { until: '(?i)allow lain to observe and control this computer', timeout: 300000 }, { snap: 'authorize', settle: 600 }, { send: '\r' },
    { until: 'DONE|CUT OFF|STOPPED|FAILED', timeout: 600000 }, { snap: 'done', settle: 1500 },
    { send: '/exit\r' }, { wait: 1500 },
  ];
  const r = runTty({ argv: [process.execPath, path.join(ROOT, 'bin', 'lain.js')], cwd: d, env: envFor(h, trace), cols: 120, rows: 40, steps });
  const readDisplay = () => ps(`Add-Type -AssemblyName UIAutomationClient; $w=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}); $r=$w.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'CalculatorResults'))); if($r){$r.Current.Name}`);
  let display = readDisplay();
  if (!display) { await new Promise((res) => setTimeout(res, 1500)); display = readDisplay(); }
  // CLOSE WHAT THIS SCRIPT OPENED, by its window (WindowPattern.Close) — never by process id.
  ps(`Add-Type -AssemblyName UIAutomationClient; $w=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}); $p=$w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern); $p.Close()`);
  const after = userNotepad();
  const text = lastText(h);
  const ok = /492/.test(display) && /492/.test(text);
  return { log: JSON.stringify({ timeouts: r.timeouts, error: r.error, display, notepadBefore: before, notepadAfter: after, snaps: (r.snaps || []).map((s) => ({ name: s.name, text: s.text })) }, null, 1), wallMs: r.ms,
    correct: ok, why: `display:"${display}" answer492:${/492/.test(text)} userNotepadUnchanged:${before === after} timeouts:${(r.timeouts || []).join('|') || 'none'}`, ...measure(trace, h) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const id of ids) {
    const t = TASKS[id];
    process.stdout.write(`task ${id} (${t.name}) … `);
    let r;
    try { r = t.kind === 'p' ? await taskP(id, t) : t.kind === 'tty-plan' ? await taskPlan(id) : t.kind === 'resume' ? await taskResume(id) : await taskComputer(id); } catch (e) { r = { correct: false, why: `harness error: ${e.message}` }; }
    for (const h of homes.splice(0)) { try { await require('../../src/supervisor').shutdownIn(path.join(h, 'sup')); } catch { /* none started */ } }
    if (r.log) fs.writeFileSync(path.join(OUT, `bench-${label}-task${id}.log`), r.log);
    delete r.log;
    results.push({ id, task: t.name, ...r });
    console.log(`${r.skipped ? 'NOT RUN' : r.correct ? 'correct' : 'WRONG'} · ${r.modelRequests ?? '-'} req · in ${r.inputTokens ?? '-'} out ${r.outputTokens ?? '-'} cached ${r.cachedTokens ?? '-'} (${r.cachePct ?? '-'}%) · effort ${(r.effort || []).join('/')} · ${((r.wallMs || 0) / 1000).toFixed(1)}s · guards ${(r.guards || []).length}${r.why ? ` · ${r.why}` : ''}`);
    fs.writeFileSync(path.join(OUT, `bench-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), model: sb.MODEL, connection: sb.CONN, results }, null, 2));
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
