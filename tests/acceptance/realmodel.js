// REAL MODEL: GLM-5.3-Flash via the person's own configured Z.ai connection (lain:zai, key by DPAPI reference).
// Noema's own one-shot path (App.once). The model/connection choice is IN MEMORY ONLY — config.save is disabled,
// so the person's default model is untouched. Prints no secret; reports the usage receipts this run wrote.
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(ROOT);
const config = require(ROOT + '/src/config');
const which = process.argv[2] || 'text';

const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'noema-real-')));
const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head><body>
<h1>Counter</h1><p id="count">Count: 0</p><button id="add" onclick="var n=+document.getElementById('count').textContent.split(': ')[1]+1;document.getElementById('count').textContent='Count: '+n">Add one</button>
</body></html>\n`;
fs.writeFileSync(path.join(proj, 'index.html'), ORIGINAL);
fs.mkdirSync(path.join(proj, '.noema'));
fs.writeFileSync(path.join(proj, '.noema', 'preview.json'), JSON.stringify({ static: '.' }));

const realLoad = config.load;
config.save = () => {};                                   // nothing this run chooses is persisted
config.load = (...a) => {
  const c = realLoad(...a);
  c.connection = 'lain:zai'; c.model = 'glm-5.3-flash';
  c.trustedPaths = [...(c.trustedPaths || []), { path: proj, level: 'TRUSTED', at: new Date().toISOString() }];
  c.dashAutostart = false;
  return c;
};

const receipts = path.join(config.configDir(), 'usage', 'receipts-2026-10.jsonl');
const receiptsSep = path.join(config.configDir(), 'usage', 'receipts-2026-09.jsonl');
const count = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const before = { oct: count(receipts), sep: count(receiptsSep) };

const PROMPTS = {
  text: 'Reply with exactly these two words and nothing else: NOEMA OK',
  // THE EXECUTION-DISCIPLINE SCENARIOS (consolidation §59–§62): the spec's own words, no coaching on how.
  count: 'Open Preview. Click Add one twice. Verify Count becomes 2. Stop.',
  nudge: 'Move the Add one button down by 6px. Verify it in the Preview.',
  preview: 'This folder is a small web page. Test it in the Noema Preview using the preview tools only: first preview_read the page, then preview_click the "Add one" button twice, then preview_read again. Reply with only the number shown after "Count:".',
};

(async () => {
  const { App } = require(ROOT + '/src/app');
  const app = new App({ cwd: proj, interactive: false });
  const t0 = Date.now();
  const code = await app.once(PROMPTS[which]);
  const ms = Date.now() - t0;
  const all = [];
  for (const [f, n] of [[receiptsSep, before.sep], [receipts, before.oct]]) {
    try { for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').slice(n)) if (l) all.push(JSON.parse(l)); } catch { /* none */ }
  }
  const mine = all.filter((r) => r.at >= t0 - 1000);
  const sum = (k) => mine.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  process.stdout.write(`\n=== ${which}: exit ${code} in ${ms} ms · ${mine.length} request(s)\n`);
  for (const r of mine) process.stdout.write(`  ${r.provider} · account ${r.account || '-'} · route ${r.route} · model ${r.model} · effort ${r.effort || 'auto'} · ok ${r.ok} · in ${r.input} out ${r.output} reasoning ${r.reasoning || 0} cacheRead ${r.cacheRead || 0} · tools ${r.toolCalls || 0} · ${r.ms} ms\n`);
  process.stdout.write(`  total: input ${sum('input')} · output ${sum('output')} · reasoning ${sum('reasoning')} · tool calls ${sum('toolCalls')}\n`);
  // WHAT NOEMA DID WITH IT — the model's calls in order, what changed on disk, and the arbiter's decision.
  const s = app.session;
  const say = (line) => process.stdout.write(`${line}\n`);
  const calls = (s.messages || []).flatMap((m) => (m && m.tool_calls) || []).map((c) => c.name);
  say(`  tool calls in order: ${calls.join(' → ') || '(none)'}`);
  const page = fs.readFileSync(path.join(proj, 'index.html'), 'utf8');
  say(`  index.html ${page === ORIGINAL ? 'unchanged' : 'CHANGED'}`);
  const life = s.lifecycle;
  if (life) {
    const d = life.discipline;
    const arbiter = require(ROOT + '/src/discipline/arbiter');
    say(`  lifecycle: ${life.state} · generation (file changes) ${life.mutationSeq || 0}`);
    for (const c of d.checks.all()) say(`    ${c.id} ${(c.command || c.tool || '').slice(0, 50)} ${c.target ? JSON.stringify(c.target).slice(0, 50) : ''} baseline ${c.baseline} → ${c.latest && c.latest.state} · ${c.realism} · ${d.checks.discrimination(c, life.mutationSeq || 0)}`);
    const v = arbiter.evaluate(life, { cwd: proj });
    say(`  arbiter: ${v.state}${v.why ? ` — ${v.why}` : ''}`);
    const changed = page === ORIGINAL ? [] : ['index.html'];
    const req = require(ROOT + '/src/verifycontract').requirement(proj, changed, { objective: life.objective });
    say(`  verification level: ${req.level} · suite ${req.needsSuite} · packaging ${req.needsPackaging} · final smoke ${require(ROOT + '/src/finalsmoke').state(life, proj)}`);
    say(`  outcome satisfied: ${arbiter.outcomeSatisfied(life)}`);
    if (which === 'count') {
      // A CLAIM-PROVENANCE INJECTION against the real state this run produced: nothing here packaged anything.
      const said = life.contradiction('Done. Count is 2, and the Windows installer package is verified.');
      say(`  injected claim "the Windows installer package is verified" → ${said ? said.split('\n')[0] : 'NOT DOWNGRADED'}`);
    }
  }
  try { await require(ROOT + '/src/teardown').shutdown(app, { why: 'real model test done' }); } catch { /* exiting */ }
  setTimeout(() => process.exit(0), 1500).unref();
})().catch((e) => { process.stderr.write(`ERR ${e && e.stack}\n`); process.exit(1); });
