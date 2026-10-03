'use strict';

/**
 * WARM UNCACHED INPUT — a focused steady-state measurement (2026-09-24).
 *
 *   node bench/cache-warm/run.js --tag <new> [--mode forward|canned] [--cap 40]
 *        [--upstream http://127.0.0.1:4570] [--key-from lain:127.0.0.1]
 *        [--model openai-codex/gpt-6-luna] [--protocol responses] [--effort low]
 *
 * NOT a provider benchmark. One session, one route, one model, four small
 * Harness-shaped scenarios, and the billed receipt of every request:
 *
 *   A  a repeated project question with the project unchanged
 *   B  an operation on selected code (an IDE selection is Core state)
 *   C  a Workshop / GUG selection (the pick is a semantic node, sliced)
 *   D  one tool-result continuation (read a file, answer from it)
 *   +  a deterministic GUG edit ("move this down 6px") — expected 0 requests
 *
 * Every row comes from cacheledger (the provider's own cached-token figure;
 * "not reported" stays null). COLD and EPOCH_RESET rows are listed apart and
 * never counted as warm. The proxy enforces a hard request cap and keeps every
 * request body and raw response. The fixture is a temp copy; the isolated home
 * (which holds the router key) is deleted afterwards.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const TAG = arg('tag', `warm-${Date.now()}`);
const MODE = arg('mode', 'forward');
const CAP = Number(arg('cap', '40'));
const UPSTREAM = arg('upstream', 'http://127.0.0.1:4570');
const KEY_FROM = arg('key-from', 'lain:127.0.0.1');
const MODEL = arg('model', 'openai-codex/gpt-6-luna');
const PROTOCOL = arg('protocol', MODE === 'canned' ? 'chat' : 'responses');
const EFFORT = arg('effort', 'low');
const ONLY = arg('only', '');
const OUT = path.join(REPO, 'tools', 'dev', 'bench', 'out', 'cache-warm', TAG);

const base = path.join(os.tmpdir(), 'lain-cache-warm', TAG);
if (fs.existsSync(base)) { console.error(`${base} exists — use a new --tag`); process.exit(2); }
const home = path.join(base, 'home');
const work = path.join(base, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- the fixture: a small search UI, the shape of Harness work ----------------------
const FILES = {
  'package.json': '{"name":"searchapp","version":"1.0.0","private":true}\n',
  'src/App.tsx': "import { SearchBar } from './SearchBar';\nimport { Results } from './Results';\nimport { fetchResults } from './api';\n\nexport function App() {\n  const [items, setItems] = useState([]);\n  const onSearch = async (q: string) => setItems(await fetchResults(q));\n  return (<main className=\"view\"><SearchBar onSearch={onSearch} /><Results items={items} /></main>);\n}\n",
  'src/SearchBar.tsx': "export function SearchBar({ onSearch }: { onSearch: (q: string) => void }) {\n  const [q, setQ] = useState('');\n  return (\n    <form className=\"composer\" onSubmit={(e) => { e.preventDefault(); onSearch(q); }}>\n      <input className=\"search-input\" value={q} onChange={(e) => setQ(e.target.value)} placeholder=\"Search\" />\n      <button className=\"submit\" type=\"submit\">Send</button>\n    </form>\n  );\n}\n",
  'src/Results.tsx': "export function Results({ items }: { items: { id: string; title: string }[] }) {\n  return <div className=\"results\">{items.map((i) => <div className=\"result\" key={i.id}>{i.title}</div>)}</div>;\n}\n",
  'src/api.ts': "export async function fetchResults(q: string) {\n  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);\n  if (!r.ok) throw new Error(`search failed: ${r.status}`);\n  return (await r.json()).items;\n}\n",
  'src/styles.css': ":root {\n  --submit-size: 40px;\n}\n.composer {\n  display: flex;\n  align-items: center;\n  height: 68px;\n}\n.search-input {\n  height: 48px;\n}\n.composer .submit {\n  width: var(--submit-size);\n  height: var(--submit-size);\n  margin-top: 0px;\n}\n.results {\n  margin-top: 8px;\n}\n",
};
for (const [rel, body] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), body); }

// The measured page for the Workshop scenario (what inspect.js gugExpr returns for this layout).
const DOM = [
  { tag: 'main', classes: 'view', selector: 'main.view', rect: { x: 0, y: 0, w: 1280, h: 800 }, parent: -1, style: {} },
  { tag: 'form', classes: 'composer', selector: 'form.composer', rect: { x: 300, y: 100, w: 660, h: 68 }, parent: 0, style: { display: 'flex', 'align-items': 'center' } },
  { tag: 'input', classes: 'search-input', selector: 'input.search-input', label: 'Search', rect: { x: 310, y: 110, w: 580, h: 48 }, parent: 1, style: { height: '48px' } },
  { tag: 'button', classes: 'submit', selector: 'button.submit', label: 'Send', rect: { x: 902, y: 114, w: 40, h: 40 }, parent: 1, style: { width: '40px', height: '40px', position: 'static' } },
  { tag: 'div', classes: 'results', selector: 'div.results', rect: { x: 300, y: 176, w: 660, h: 300 }, parent: 0, style: { 'margin-top': '8px' } },
];

(async () => {
  const userCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lain-v2', 'config.json'), 'utf8'));
  const KEY = MODE === 'canned' || MODE === 'mock' ? 'canned' : ((userCfg.connections || {})[KEY_FROM] || {}).apiKey;
  if (!KEY) throw new Error(`no apiKey on connections["${KEY_FROM}"]`);
  // MOCK: the real wire assembly and budgeter, a scripted model with real tool calls —
  // a STRUCTURAL (byte-prefix) estimate, never a provider measurement.
  if (MODE === 'mock') {
    const steps = [
      { text: 'Reading it.', tool_calls: [{ name: 'read_file', input: { path: 'src/SearchBar.tsx' } }] }, { text: 'SearchBar renders the query form and calls onSearch on submit.' },
      { text: 'Unchanged: it renders the form and submits the query.' },
      { text: 'It fetches /api/search and returns the items.' },
      { text: 'Looking.', tool_calls: [{ name: 'grep', input: { pattern: 'fetchResults', path: 'src' } }] }, { text: 'src/App.tsx calls it.' },
      { text: 'No: 40px vs 48px.' },
      { text: 'No — the composer centres it with align-items.' },
      { text: 'Reading it.', tool_calls: [{ name: 'read_file', input: { path: 'src/styles.css' } }] }, { text: '--submit-size is 40px.' },
    ];
    const sp = path.join(base, 'mock-script.json');
    fs.writeFileSync(sp, JSON.stringify(steps));
    Object.assign(process.env, { LAIN_PROVIDER: 'mock', LAIN_MOCK_SCRIPT: sp });
  }
  const proxy = await require('../readonly-diagnostic/proxy').start({ dir: path.join(OUT, 'wire'), mode: MODE === 'mock' ? 'canned' : MODE, cap: CAP, upstream: UPSTREAM });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: MODEL, connection: 'live', maxSteps: 8, ...(EFFORT ? { effort: EFFORT } : {}),
    trustedPaths: [{ path: work, level: 'TRUSTED', at: new Date().toISOString() }],
    connections: { live: { provider: 'lainrouter', via: 'native', auth: 'api_key', protocol: PROTOCOL, baseUrl: `http://127.0.0.1:${proxy.port}/v1`, apiKey: KEY, models: [MODEL] } },
    workers: { policy: 'off' },
  }, null, 2));
  Object.assign(process.env, { LAIN_CONFIG_DIR: home, LAIN_HOME: path.join(base, 'lainhome'), LAIN_V1_CONFIG: path.join(home, 'no-v1.json'), LAIN_AGENTS_HOME: home, LAIN_WATCH: '0', LAIN_WORKERS: 'off', LAIN_REQTRACE: path.join(OUT, 'reqtrace.jsonl') });
  const { App } = require(path.join(REPO, 'src/app'));
  const hc = require(path.join(REPO, 'src/harnesscontext'));
  const cl = require(path.join(REPO, 'src/cacheledger'));
  const routes = require(path.join(REPO, 'src/harnessapp/routes'));
  const app = new App({ out: { write() {}, on() {}, columns: 120, rows: 40, isTTY: false }, interactive: false, cwd: work });
  const turns = [];
  const say = async (scenario, text) => {
    const before = proxy.count();
    const rowsBefore = cl.rows(app.session).length;
    const t0 = Date.now();
    try { await app.handle(text, { from: 'harness-app' }); } catch (e) { turns.push({ scenario, text, error: String(e && e.message) }); return; }
    const rec = app.session.turns[app.session.turns.length - 1] || {};
    turns.push({ scenario, text, requests: proxy.count() - before, rows: cl.rows(app.session).slice(rowsBefore).length, ms: Date.now() - t0, reply: String(rec.text || '').slice(0, 300) });
    console.log(`[${scenario}] ${proxy.count() - before} request(s) · ${Math.round((Date.now() - t0) / 1000)} s · ${String(rec.text || '').replace(/\s+/g, ' ').slice(0, 100)}`);
  };
  const run = (s) => !ONLY || ONLY.split(',').includes(s);
  const RO = 'READ-ONLY — do not change any file. ';
  // E FIRST: a deterministic GUG edit, before any read-only declaration (expected: 0 requests).
  if (run('E')) {
    const ws0 = { measure: async () => ({ ok: true, url: 'http://localhost:5173/', viewport: { w: 1280, h: 800 }, elements: DOM }) };
    await hc.workshopPicked(app, app.session, ws0, { selector: 'button.submit', tag: 'button' });
    await say('E1', 'move this down 6px');
  }
  if (run('A')) {
    await say('A1', `${RO}In two sentences: what does SearchBar do in this project?`);
    await say('A2', `${RO}Again, unchanged project: what does SearchBar do? Two sentences.`);
  }
  if (run('B')) {
    await routes.dispatch(app, 'POST', '/api/ide/context', { file: 'src/api.ts', selection: { text: 'fetchResults', startLine: 1, endLine: 1 } });
    await say('B1', `${RO}In one sentence, what does this do?`);
    await say('B2', `${RO}Which file calls this? One line.`);
  }
  if (run('C')) {
    const ws = { measure: async () => ({ ok: true, url: 'http://localhost:5173/', viewport: { w: 1280, h: 800 }, elements: DOM }) };
    const g = await hc.workshopPicked(app, app.session, ws, { selector: 'button.submit', tag: 'button' });
    console.log(`[C] Workshop pick → ${g && g.id} (GUG generation ${g && g.generation}, binding ${g && g.binding && g.binding.confidence})`);
    await say('C1', `${RO}Is this the same height as the search input? Answer with the two heights.`);
    await say('C2', `${RO}Would making this 4px taller break its vertical centring in the composer? One sentence.`);
  }
  if (run('D')) {
    await say('D1', `${RO}Read src/styles.css and tell me the value of --submit-size.`);
  }

  await proxy.close();
  const rows = cl.rows(app.session);
  const summary = cl.summary(rows);
  const table = rows.map((r, i) => ({
    n: i + 1, warmth: r.warmth, epoch: r.epoch, epochReason: r.epochReason, band: r.band,
    input: r.actual.total, cached: r.actual.cached, uncached: r.actual.uncached, ratio: r.actual.ratio == null ? null : +(r.actual.ratio * 100).toFixed(2),
    output: r.actual.output, cacheWrite: r.actual.cacheWrite, expectedRatio: +(r.expected.ratio * 100).toFixed(2), promptChars: r.expected.chars,
    owners: r.owners.slice(0, 3).map((o) => `${o.owner}:${o.chars}`).join(' '), reductions: r.reductions.map((x) => x.owner).join(' '), exception: r.exception ? r.exception.reason : null,
  }));
  // THE STRUCTURAL ESTIMATE: the budgeter's expected ratio for the same rows (char-based, not billed).
  const expectedWarm = rows.filter((r) => r.warmth === 'WARM').map((r) => r.expected.ratio).sort((a, b) => a - b);
  const q = (p) => (expectedWarm.length ? expectedWarm[Math.min(expectedWarm.length - 1, Math.ceil(p * expectedWarm.length) - 1)] : null);
  const structural = { warm: expectedWarm.length, median: q(0.5), p90: expectedWarm.length >= 10 ? q(0.9) : null, worst: expectedWarm.length ? expectedWarm[expectedWarm.length - 1] : null, meanPromptChars: rows.length ? Math.round(rows.reduce((n, r) => n + r.expected.chars, 0) / rows.length) : null, note: 'expected from the byte prefix shared with the previous request — NOT a provider receipt' };
  console.log('STRUCTURAL ESTIMATE', JSON.stringify(structural));
  const out = { tag: TAG, mode: MODE, structural, model: MODEL, protocol: PROTOCOL, effort: EFFORT, upstream: UPSTREAM, cap: CAP, requests: proxy.count(), turns, table, summary, wire: proxy.log };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 1));
  console.table(table.map((r) => ({ n: r.n, warmth: r.warmth, epoch: r.epoch, input: r.input, cached: r.cached, uncached: r.uncached, 'unc%': r.ratio, out: r.output, 'exp%': r.expectedRatio, owners: r.owners })));
  console.log(JSON.stringify(summary, null, 1));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort — the key must not outlive the run */ }
  process.exit(0);
})().catch((e) => { console.error('fatal:', (e && e.stack) || e); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
