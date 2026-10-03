'use strict';

/**
 * Is the system prompt byte-identical across the requests of one session? Runs two turns (three requests) against
 * the mock provider in an isolated home and compares the system message and the tool list of every request.
 * Usage: node tools/dev/promptstable.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ps-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ps-proj-'));
fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');
const script = path.join(home, 'script.json');
fs.writeFileSync(script, JSON.stringify([
  { text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
  { text: 'It says hello.' },
  { text: 'Still hello.' },
]));
Object.assign(process.env, { LAIN_CONFIG_DIR: home, LAIN_HOME: path.join(home, 'sup'), LAIN_PROVIDER: 'mock', LAIN_MOCK_SCRIPT: script, LAIN_ISOLATED: '1', LAIN_NO_UPDATE_CHECK: '1', LAIN_NO_DESKTOP: '1' });
if (process.argv[2]) process.env.LAIN_EXECUTION = process.argv[2];

const ROOT = path.join(__dirname, '..', '..');
const provider = require(path.join(ROOT, 'src', 'provider'));
const seen = [];
const chat = provider.chat;
provider.chat = function wrapped(pc, wire, opts) {
  const sys = wire.find((m) => m.role === 'system');
  const text = sys ? (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)) : '';
  seen.push({ sys: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12), sysChars: text.length, tools: crypto.createHash('sha256').update(JSON.stringify((opts && opts.tools) || [])).digest('hex').slice(0, 12), toolCount: ((opts && opts.tools) || []).length });
  return chat.apply(this, arguments);
};
const { App } = require(path.join(ROOT, 'src', 'app'));
(async () => {
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
  await app.submit('what does a.txt say?');
  await new Promise((r) => setTimeout(r, 1100));
  await app.submit('and now?');
  const same = new Set(seen.map((s) => s.sys)).size === 1 && new Set(seen.map((s) => s.tools)).size === 1;
  console.log(JSON.stringify({ requests: seen.length, identical: same, seen }));
  process.exit(same ? 0 : 1);
})().catch((e) => { console.error(e.stack); process.exit(2); });
