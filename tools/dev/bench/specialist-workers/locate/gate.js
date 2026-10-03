'use strict';

/**
 * LAYA RECRUITMENT GATE — evidence narrowing over a REAL tree.
 *
 *   node bench/specialist-workers/locate/gate.js [root=<this repo>] [prefix=src/]
 *
 * The labelled set asks "where is X" about LAIN's own source (targets checked
 * by hand against the tree). Half of the queries share words with the target's
 * path or symbols, half are paraphrases that share none — the case a semantic
 * model is supposed to win. Four rankers, same items (locateassist.items):
 *
 *   lexical      the deterministic tier alone
 *   laya-cos     Laya's encoder, cosine only
 *   laya-choice  Laya's encoder shortlist + ONE choice decision (its own path)
 *   fused        what LAIN ships: lexical ⊕ laya-cos, reciprocal rank
 *
 * A query HITS@k when any acceptable target is in the top k. Writes
 * bench/specialist-workers/out/laya-locate-gate.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lain-laya-gate-'));
const la = require('../../../src/locateassist');
const rt = require('../../../src/workerruntime');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..', '..');
const PREFIX = process.argv[3] == null ? 'src/' : process.argv[3];

const Q = [
  // lexical overlap with the target
  { q: 'rate limit backoff after a 429 from the provider', t: ['src/ratelimit.js', 'src/backoff.js', 'src/providerlimits.js'], kind: 'lexical' },
  { q: 'side by side split diff rendering', t: ['src/ui/panes.js', 'src/ui/turnsections.js'], kind: 'lexical' },
  { q: 'colour palette tokens and truecolor detection', t: ['src/ui/palette.js'], kind: 'lexical' },
  { q: 'git working tree snapshot prefetch', t: ['src/gitsnapshot.js'], kind: 'lexical' },
  { q: 'shell command row with exit code', t: ['src/ui/shellrow.js'], kind: 'lexical' },
  { q: 'where the harness package location is resolved', t: ['src/harnesslocation.js'], kind: 'lexical' },
  { q: 'the /goal command', t: ['src/goalcommand.js', 'src/goal.js'], kind: 'lexical' },
  { q: 'provider failover between connections', t: ['src/failover.js'], kind: 'lexical' },
  { q: 'redact secrets', t: ['src/redact.js'], kind: 'lexical' },
  { q: 'folder trust prompt', t: ['src/trust.js', 'src/trustask.js', 'src/trustcommand.js'], kind: 'lexical' },
  { q: 'the activity box', t: ['src/ui/activitybox.js'], kind: 'lexical' },
  { q: 'final smoke before finishing', t: ['src/finalsmoke.js'], kind: 'lexical' },
  // paraphrase: no word in common with the target path
  { q: 'when the API says slow down, wait before trying again', t: ['src/ratelimit.js', 'src/backoff.js', 'src/providerlimits.js'], kind: 'paraphrase' },
  { q: 'hide API keys and passwords before they are printed or logged', t: ['src/redact.js'], kind: 'paraphrase' },
  { q: 'the model keeps calling the same tool over and over', t: ['src/looping.js'], kind: 'paraphrase' },
  { q: 'put the files back the way they were before the last edit', t: ['src/undo.js', 'src/checkpoint.js'], kind: 'paraphrase' },
  { q: 'the text box at the bottom where the person types', t: ['src/ui/inputbox.js', 'src/lineedit.js'], kind: 'paraphrase' },
  { q: 'talking to LAIN from a phone messenger', t: ['src/botcommand.js', 'src/botconnect.js', 'src/bot/telegram.js', 'src/bot/service.js'], kind: 'paraphrase' },
  { q: 'turning raw terminal escape bytes into key presses', t: ['src/keydecode.js', 'src/heldkeys.js'], kind: 'paraphrase' },
  { q: 'the conversation got too long for the model, shrink it', t: ['src/contextfit.js', 'src/compactcommand.js', 'src/msgfold.js'], kind: 'paraphrase' },
  { q: 'which colours the red and green lines of a change use', t: ['src/ui/panes.js', 'src/ui/paint.js', 'src/ui/palette.js'], kind: 'paraphrase' },
  { q: 'how long a command took and whether it succeeded, shown after it runs', t: ['src/ui/shellrow.js'], kind: 'paraphrase' },
  { q: 'the web page you open in a browser to watch LAIN, and its login', t: ['src/dash.js', 'src/dashauth.js', 'src/dashpage.js'], kind: 'paraphrase' },
  { q: 'what the tokens in each request cost and where they went', t: ['src/tokenaudit.js', 'src/tokencommand.js'], kind: 'paraphrase' },
];

const K = [1, 5, 8];

function score(rankedIds, targets) {
  const i = rankedIds.findIndex((id) => targets.includes(id));
  return { rank: i < 0 ? null : i + 1, ...Object.fromEntries(K.map((k) => [`hit${k}`, i >= 0 && i < k])) };
}

(async () => {
  for (const q of Q) for (const t of q.t) if (!fs.existsSync(path.join(ROOT, t)) && !q.t.some((x) => fs.existsSync(path.join(ROOT, x)))) throw new Error(`no target on disk for: ${q.q}`);
  const app = { cfg: { workers: {} } };
  const t0 = Date.now();
  const list = la.items(ROOT).filter((it) => it.id.startsWith(PREFIX));
  console.log(`${list.length} items in ${Date.now() - t0} ms`);
  const w = rt.info(app, 'laya');
  if (!w || !w.usable) { console.log('laya not usable on this machine:', w); }
  let tw = Date.now();
  const warmed = w && w.usable ? await rt.warm(app, 'laya') : false;
  const loadMs = Date.now() - tw;
  // The first rank embeds every item once (then cached in the worker).
  tw = Date.now();
  if (warmed) await rt.call(app, 'laya', { op: 'rank', query: 'warm up', items: list, k: 1, mode: 'cos' }, { timeoutMs: 10 * 60 * 1000 });
  const embedAllMs = Date.now() - tw;
  console.log(`laya load ${loadMs} ms · first embed of ${list.length} items ${embedAllMs} ms`);

  const rows = [];
  for (const q of Q) {
    const row = { q: q.q, kind: q.kind, targets: q.t };
    let t = Date.now();
    row.lexical = { ...score(la.lexical(q.q, list).map((r) => r.id), q.t), ms: Date.now() - t };
    if (warmed) {
      t = Date.now();
      const c = await rt.call(app, 'laya', { op: 'rank', query: q.q, items: list, k: 40, mode: 'cos' }, { timeoutMs: 60000 });
      row['laya-cos'] = { ...score(c ? c.ranked.map((r) => r.id) : [], q.t), ms: Date.now() - t };
      t = Date.now();
      const ch = await rt.call(app, 'laya', { op: 'rank', query: q.q, items: list, k: 12, mode: 'choice' }, { timeoutMs: 60000 });
      row['laya-choice'] = { ...score(ch ? ch.ranked.map((r) => r.id) : [], q.t), ms: Date.now() - t, abstain: ch ? ch.abstain : null, top: ch && ch.ranked[0] ? ch.ranked[0].p : null };
      t = Date.now();
      const f = await la.rank(app, ROOT, q.q, { laya: 'cos', list });
      row.fused = { ...score(f.ranked.map((r) => r.id), q.t), ms: Date.now() - t, by: f.by };
    }
    rows.push(row);
    console.log(`${q.kind.padEnd(10)} ${q.q.slice(0, 58).padEnd(58)} lex ${row.lexical.rank || '-'}`
      + (warmed ? ` · cos ${row['laya-cos'].rank || '-'} · choice ${row['laya-choice'].rank || '-'} (p ${row['laya-choice'].top}) · fused ${row.fused.rank || '-'}` : ''));
  }
  rt.stop(app);

  const arms = ['lexical', ...(warmed ? ['laya-cos', 'laya-choice', 'fused'] : [])];
  const agg = (sel) => Object.fromEntries(arms.map((a) => {
    const rs = rows.filter(sel).map((r) => r[a]);
    const o = { n: rs.length };
    for (const k of K) o[`hit@${k}`] = +(rs.filter((x) => x[`hit${k}`]).length / rs.length).toFixed(3);
    o.mrr = +(rs.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / rs.length).toFixed(3);
    const ms = rs.map((x) => x.ms).sort((a, b) => a - b);
    o.medianMs = ms[Math.floor(ms.length / 2)];
    return [a, o];
  }));
  const summary = { at: new Date().toISOString(), root: ROOT, prefix: PREFIX, items: list.length, layaLoadMs: loadMs, layaFirstEmbedMs: embedAllMs, all: agg(() => true), lexicalQueries: agg((r) => r.kind === 'lexical'), paraphrase: agg((r) => r.kind === 'paraphrase') };
  // Confident-and-wrong: the choice head put p ≥ 0.5 on a file that is not a target.
  if (warmed) summary.choiceConfidentWrong = rows.filter((r) => r['laya-choice'].top >= 0.5 && r['laya-choice'].rank !== 1).length;
  const out = path.join(__dirname, '..', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'laya-locate-gate.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
})();
