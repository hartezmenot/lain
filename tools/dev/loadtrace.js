'use strict';

/**
 * Runtime load trace: runs one real CLI turn (`lain -p`) against the scripted mock provider in an isolated home and
 * lists every src/ module that was actually loaded. Usage: node tools/dev/loadtrace.js <out.json>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-trace-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-trace-proj-'));
fs.writeFileSync(path.join(proj, 'app.js'), "const label = 'Save';\nmodule.exports = { label };\n");
const script = path.join(home, 'mock-script.json');
fs.writeFileSync(script, JSON.stringify([
  { text: 'Reading it.', tool_calls: [{ name: 'read_file', input: { path: 'app.js' } }] },
  { text: 'Changing the label.', tool_calls: [{ name: 'edit_file', input: { path: 'app.js', old: "'Save'", new: "'Store'" } }] },
  { text: 'Changed the label from Save to Store in app.js.' },
]));
const pre = path.join(home, 'pre.js');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'simplify', 'loadtrace.json'));
fs.writeFileSync(pre, `process.on('exit', () => { const src = ${JSON.stringify(path.join(ROOT, 'src'))}.toLowerCase(); const mods = Object.keys(require.cache).filter((f) => f.toLowerCase().startsWith(src)).map((f) => f.slice(src.length + 1).replace(/\\\\/g, '/')).sort(); require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(mods)); });`);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAIN_') && !k.startsWith('NOEMA_'))),
  LAIN_CONFIG_DIR: home, LAIN_HOME: path.join(home, 'sup'), LAIN_PROVIDER: 'mock', LAIN_MOCK_SCRIPT: script, LAIN_NO_COLOR: '1', LAIN_NO_DESKTOP: '1', LAIN_NO_UPDATE_CHECK: '1', LAIN_ISOLATED: '1', LAIN_TEMP_ROOT: path.join(home, 'tmp'), LAIN_REQTRACE: path.join(home, 'req.jsonl') };
const t0 = Date.now();
const r = spawnSync(process.execPath, ['-r', pre, path.join(ROOT, 'bin', 'lain.js'), '-p', 'rename the Save label to Store'], { cwd: proj, env, encoding: 'utf8', timeout: 120000 });
const mods = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
const linesOf = (m) => { try { return fs.readFileSync(path.join(ROOT, 'src', m), 'utf8').split('\n').length; } catch { return 0; } };
const total = mods.reduce((n, m) => n + linesOf(m), 0);
const reqFile = path.join(home, 'req.jsonl');
const requests = (fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  .filter((q) => q.systemChars != null)
  .map((q) => ({ reason: q.reason, systemChars: q.systemChars, toolSchemaChars: q.toolSchemaChars, toolCount: q.toolCount, messageChars: q.messageChars, tools: q.tools }));
const edited = fs.readFileSync(path.join(proj, 'app.js'), 'utf8').includes("'Store'");
fs.writeFileSync(out, JSON.stringify({ ms: Date.now() - t0, exit: r.status, edited, requests, modules: mods.length, lines: total, list: mods.map((m) => [m, linesOf(m)]) }, null, 1));
console.log(JSON.stringify({ ms: Date.now() - t0, exit: r.status, modules: mods.length, lines: total }));
if (process.env.TRACE_SHOW) console.log(String(r.stdout).slice(-2500), String(r.stderr).slice(-800));
