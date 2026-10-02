'use strict';

/**
 * Real-model bench for the Simplify pass: runs `lain -p` tasks on a fresh fixture project in an isolated home that
 * holds only the chosen connection (its credential copied as the encrypted DPAPI blob — never plaintext), then records
 * per task: model requests, tokens in/out/cached, cache %, wall time, correctness, the final text, and the request
 * sizes. Usage: node tools/dev/simplebench.js <label> [taskIds=1,2,3,4,5] [--model glm-5.3] [--connection lain:zai]
 * Output: docs/simplify/bench-<label>.json plus one stdout log per task beside it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const label = argv[0] || 'run';
const ids = String(argv[1] && !argv[1].startsWith('--') ? argv[1] : '1,2,3,4,5').split(',').map(Number);
const MODEL = flag('--model', 'glm-5.3');
const CONN = flag('--connection', 'lain:zai');
const EXTRA = JSON.parse(flag('--cfg', '{}'));

function realHome() {
  for (const d of ['.lain', '.noema']) { const p = path.join(os.homedir(), d); try { if (fs.statSync(path.join(p, 'config.json')).isFile()) return p; } catch { /* next */ } }
  throw new Error('no LAIN home with config.json');
}

function benchHome() {
  const src = realHome();
  const cfg = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'));
  const conn = cfg.connections && cfg.connections[CONN];
  if (!conn) throw new Error(`no connection ${CONN}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bench-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ connections: { [CONN]: conn }, connection: CONN, model: MODEL, ...EXTRA }, null, 2));
  if (conn.credentialRef) {
    const blob = `${conn.credentialRef.replace(/:/g, '.')}.dpapi`;
    fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
    fs.copyFileSync(path.join(src, 'secrets', blob), path.join(home, 'secrets', blob));
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'credentials.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ ...meta, refs: { [conn.credentialRef]: meta.refs[conn.credentialRef] } }, null, 2));
  }
  // THE CATALOG for this connection only (model families and ids) — no other account's data.
  for (const f of ['model-catalog.json', path.join('catalog', `${CONN.replace(/[:]/g, '_')}.json`), path.join('catalog', `${CONN.replace(/[:]/g, '_')}.state.json`)]) {
    if (!fs.existsSync(path.join(src, f))) continue;
    fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(home, f));
  }
  return home;
}

// ---- the fixture: a tiny to-do app with one known bug ---------------------------------------------------------------
const FIXTURE = {
  'package.json': JSON.stringify({ name: 'todo-fixture', version: '1.0.0', private: true, scripts: { test: 'node test/run.js' } }, null, 2),
  'index.html': '<!doctype html>\n<html>\n<head><link rel="stylesheet" href="style.css"><title>Todo</title></head>\n<body>\n  <h1>Todo</h1>\n  <input id="title" placeholder="What needs doing?">\n  <button id="add" class="primary">Add task</button>\n  <ul id="list"></ul>\n  <p id="count"></p>\n  <script src="src/app.js" type="module"></script>\n</body>\n</html>\n',
  'style.css': 'body { font-family: system-ui, sans-serif; margin: 2rem; }\n.primary { font-size: 16px; padding: 10px 20px; border-radius: 6px; background: #2b6cb0; color: white; border: 0; }\nli.done { text-decoration: line-through; color: #888; }\n',
  'src/store.js': "'use strict';\n\nfunction createStore() { return { tasks: [], nextId: 1 }; }\n\nfunction addTask(store, title) {\n  const t = { id: store.nextId++, title: String(title).trim(), done: false };\n  if (!t.title) throw new Error('a task needs a title');\n  store.tasks.push(t);\n  return t;\n}\n\nfunction toggle(store, id) {\n  const t = store.tasks.find((x) => x.id === id);\n  if (t) t.done = !t.done;\n  return t;\n}\n\nfunction removeTask(store, id) { store.tasks = store.tasks.filter((t) => t.id !== id); }\n\n/** How many tasks are done. */\nfunction countDone(store) {\n  return store.tasks.filter((t) => t.title).length;\n}\n\nmodule.exports = { createStore, addTask, toggle, removeTask, countDone };\n",
  'src/format.js': "'use strict';\n\n/** \"1 task left\" / \"3 tasks left\" — the counter under the list. */\nfunction formatCount(n) {\n  return `${n} ${n === 1 ? 'task' : 'tasks'} left`;\n}\n\nmodule.exports = { formatCount };\n",
  'src/app.js': "import { createStore, addTask, toggle, countDone } from './store.js';\nimport { formatCount } from './format.js';\n\nconst store = createStore();\n\nfunction render() {\n  const list = document.getElementById('list');\n  list.innerHTML = '';\n  for (const t of store.tasks) {\n    const li = document.createElement('li');\n    li.textContent = t.title;\n    if (t.done) li.className = 'done';\n    li.onclick = () => { toggle(store, t.id); render(); };\n    list.appendChild(li);\n  }\n  document.getElementById('count').textContent = formatCount(store.tasks.length - countDone(store));\n}\n\ndocument.getElementById('add').onclick = () => {\n  const input = document.getElementById('title');\n  addTask(store, input.value);\n  input.value = '';\n  render();\n};\n\nrender();\n",
  'test/run.js': "'use strict';\nconst assert = require('assert');\nconst s = require('../src/store');\nconst { formatCount } = require('../src/format');\nlet n = 0;\nfunction t(name, fn) { fn(); n += 1; console.log('ok -', name); }\nt('add', () => { const st = s.createStore(); s.addTask(st, 'a'); assert.strictEqual(st.tasks.length, 1); });\nt('toggle', () => { const st = s.createStore(); const a = s.addTask(st, 'a'); s.toggle(st, a.id); assert.strictEqual(a.done, true); });\nt('countDone', () => { const st = s.createStore(); const a = s.addTask(st, 'a'); s.addTask(st, 'b'); s.toggle(st, a.id); assert.strictEqual(s.countDone(st), 1); });\nt('formatCount', () => { assert.strictEqual(formatCount(1), '1 task left'); assert.strictEqual(formatCount(2), '2 tasks left'); });\nconsole.log(`${n} passed`);\n",
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bench-proj-'));
  for (const [f, text] of Object.entries(FIXTURE)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
function testsPass(dir) { const r = require('child_process').spawnSync(process.execPath, ['test/run.js'], { cwd: dir, encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout + r.stderr).trim().split('\n').pop() }; }
function unchanged(dir, except = []) { return Object.keys(FIXTURE).filter((f) => !except.includes(f) && read(dir, f) !== FIXTURE[f]); }

const TASKS = {
  1: { name: 'rename a UI label', prompt: 'Rename the "Add task" button label to "New task".',
    check: (d) => { const h = read(d, 'index.html'); const other = unchanged(d, ['index.html']); return { ok: />New task</.test(h) && !/>Add task</.test(h) && !other.length, why: other.length ? `also changed ${other}` : '' }; } },
  2: { name: 'make a button 10% smaller', prompt: 'Make the primary button 10% smaller.',
    check: (d) => { const c = read(d, 'style.css'); const fs1 = /\.primary\s*\{[^}]*font-size:\s*([\d.]+)px/.exec(c); const sc = /\.primary\s*\{[^}]*(?:transform:\s*scale\(0?\.9\)|scale:\s*0?\.9)/.test(c); const ok = sc || (fs1 && Math.abs(Number(fs1[1]) - 14.4) < 0.6); return { ok, why: fs1 ? `font-size ${fs1[1]}px` : (sc ? 'scale(0.9)' : 'no change found') }; } },
  3: { name: 'fix a known small bug', prompt: 'countDone() in src/store.js returns the wrong number. Fix it.',
    check: (d) => { const t = testsPass(d); return { ok: t.ok && /t\.done/.test(read(d, 'src/store.js')), why: t.out }; } },
  4: { name: 'answer a question (read-only)', prompt: 'Which function decides whether the counter says "task" or "tasks", and where is it called from? Do not change any files.',
    check: (d, text) => { const ch = unchanged(d); return { ok: !ch.length && /formatCount/.test(text) && /app\.js/.test(text), why: ch.length ? `changed ${ch}` : '' }; } },
  5: { name: 'several files and steps', prompt: 'Add a "Clear completed" feature: a clearCompleted(store) function in src/store.js that removes done tasks, a "Clear completed" button in index.html wired up in src/app.js, and a test for clearCompleted in test/run.js. Run the tests.',
    check: (d) => { const t = testsPass(d); const ok = t.ok && /clearCompleted/.test(read(d, 'src/store.js')) && /Clear completed/.test(read(d, 'index.html')) && /clearCompleted/.test(read(d, 'src/app.js')) && /clearCompleted/.test(read(d, 'test/run.js')); return { ok, why: t.out }; } },
};

function runTask(id, home) {
  return new Promise((resolve) => {
    const task = TASKS[id];
    const dir = fixture();
    const trace = path.join(home, `req-${id}.jsonl`);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAIN_') && !k.startsWith('NOEMA_'))),
      LAIN_CONFIG_DIR: home, LAIN_HOME: path.join(home, 'sup'), LAIN_REQTRACE: trace, LAIN_NO_COLOR: '1', LAIN_NO_DESKTOP: '1', LAIN_NO_UPDATE_CHECK: '1', LAIN_TEMP_ROOT: path.join(home, 'tmp') };
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'lain.js'), '-p', task.prompt], { cwd: dir, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
    const kill = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const ms = Date.now() - t0;
      const reqs = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const model = reqs.filter((q) => q.systemChars != null);
      const sum = (k) => model.reduce((n, q) => n + ((q.receipt && q.receipt[k]) || 0), 0);
      const input = sum('inputTokens'); const cached = sum('cacheReadTokens');
      const v = task.check(dir, out);
      resolve({ id, task: task.name, exit: code, ms, requests: reqs.length, modelRequests: model.length, reasons: [...new Set(reqs.map((q) => q.reason))],
        inputTokens: input, outputTokens: sum('outputTokens'), cachedTokens: cached, cachePct: input ? Math.round((100 * cached) / input) : null,
        systemChars: model.length ? model[0].systemChars : null, toolCount: model.length ? model[0].toolCount : null, toolSchemaChars: model.length ? Math.max(...model.map((q) => q.toolSchemaChars || 0)) : null,
        toolSetChanged: new Set(model.map((q) => q.toolSchemaChars)).size > 1, correct: v.ok, why: v.why, project: dir, log: out });
    });
  });
}

(async () => {
  const home = benchHome();
  const results = [];
  for (const id of ids) {
    process.stdout.write(`task ${id} (${TASKS[id].name}) … `);
    const r = await runTask(id, home);
    fs.writeFileSync(path.join(ROOT, 'docs', 'simplify', `bench-${label}-task${id}.log`), r.log);
    delete r.log;
    results.push(r);
    console.log(`${r.correct ? 'correct' : 'WRONG'} · ${r.modelRequests} model requests · in ${r.inputTokens} out ${r.outputTokens} cached ${r.cachedTokens} (${r.cachePct}%) · ${(r.ms / 1000).toFixed(1)}s${r.why ? ` · ${r.why}` : ''}`);
  }
  fs.mkdirSync(path.join(ROOT, 'docs', 'simplify'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'simplify', `bench-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), model: MODEL, connection: CONN, cfg: EXTRA, results }, null, 2));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
