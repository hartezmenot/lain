'use strict';

/** LOCATE ASSIST — "which files is this request about?", answered before the first request instead of by it (2026-09-23). */

const path = require('path');

const SHOW = 8;
const MIN_FILES = 12;          // below this, the tree itself is the cheaper answer
/** How many deterministic candidates Laya may re-rank. Core chooses the universe; Laya refines it. */
const CANDIDATES = 40;
// THE MOST A LAYA RANKING MAY ADD TO A TURN — and since 2026-09-24 it measures what it claims to: the QUERY embedding against a project index prepared…
const LAYA_DEADLINE_MS = 2000;
const STOP = new Set('the a an of to in on for and or with is it this that be are was were where what which when how why who does do did not no can should would could please make fix change add remove use using from into by at as so if then there their its my our your we you i me all any some file files code project'.split(' '));

// ---- items ----------------------------------------------------------------

/** One line per candidate file, built from the project index held IN MEMORY (layaindex.items → projectindex `persist:false`): nothing is written to the… */
function items(root) {
  try { return require('./layaindex').items(root).items; } catch { return []; }
}

/** WHAT THE REQUEST IS ABOUT, without what it forbids. */
function intentText(text) {
  const t = require('./wakeup').stripNegated(String(text || ''));
  return t.replace(/\s+/g, ' ').trim();
}

// ---- the deterministic tier -------------------------------------------------

function words(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => w.replace(/(ings?|ed|es|s)$/, '') || w);
}

/** WHAT KIND OF FILE, AND DOES THE REQUEST ASK ABOUT THAT KIND? */
const TESTY = /(^|\/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|__fixtures__|__mocks__|mocks?|snapshots?|__snapshots__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;
const DOCS = /\.(?:md|mdx|rst|txt)$/i;
const CONFIGY = /\.(?:json|ya?ml|toml)$/i;
function priorFor(q) {
  const has = (re) => q.some((t) => re.test(t));
  const tests = has(/^(?:test|spec|fixture|mock|coverage|snapshot|e2e)$/);
  const docs = has(/^(?:doc|readme|documentation|changelog|guide)$/);
  const config = has(/^(?:config|configuration|setting|manifest|package|depend[a-z]*|script|build)$/);
  // THE LAYER THE REQUEST NAMES. "The frontend renders the results" is about UI
  // source; "the endpoint/handler" about the server. A kind of file, never a name.
  const ui = has(/^(?:frontend|front|ui|render|component|view|page|screen|button|input|click|display)$/);
  const server = has(/^(?:backend|back|api|endpoint|route|server|handler|request|respons)$/);
  return (id, it) => {
    if (TESTY.test(id)) return tests ? 1 : 0.25;
    if (DOCS.test(id)) return docs ? 1 : 0.5;
    if (CONFIGY.test(id)) return config ? 1 : 0.7;
    let p = 1;
    if (ui && UI_KIND.test(id)) p *= 1.5;
    if (server && it && (it.imports || []).some((s) => SERVER_LIBS.test(String(s)))) p *= 1.3;
    return p;
  };
}
const UI_KIND = /\.(?:tsx|jsx|vue|svelte|html?)$/i;
const SERVER_LIBS = /^(?:express|fastify|koa|hono|@nestjs\/|next\/server|http|node:http|flask|fastapi|django)(?:\/|$)/i;

/** Term scoring: path hits weigh most, a term the request repeats weighs more (log term frequency), and the kind prior above. */
function lexical(query, list, root = null) {
  const own = new Set(root ? words(path.basename(path.resolve(root))) : []);
  const qAll = words(query).filter((t) => !own.has(t));
  const q = [...new Set(qAll)];
  if (!q.length) return [];
  const qtf = new Map();
  for (const t of qAll) qtf.set(t, (qtf.get(t) || 0) + 1);
  const prior = priorFor(q);
  const docs = list.map((it) => {
    const [p, ...rest] = it.text.split(' — ');
    // `flat` catches a term inside a compound name: "location" in harnesslocation.js.
    return { id: it.id, it, path: new Set(words(p)), flat: String(p).toLowerCase(), body: new Set(words(rest.join(' '))) };
  });
  const inPath = (d, t) => d.path.has(t) || (t.length >= 4 && d.flat.includes(t));
  const df = new Map(q.map((t) => [t, docs.filter((d) => inPath(d, t) || d.body.has(t)).length]));
  const N = docs.length || 1;
  const scored = docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const w = Math.log(1 + N / (1 + df.get(t))) * (1 + Math.log(qtf.get(t)));
      if (d.path.has(t)) s += 3 * w; else if (inPath(d, t)) s += 2 * w; else if (d.body.has(t)) s += w;
    }
    return { id: d.id, score: +(s * prior(d.id, d.it)).toFixed(3) };
  }).filter((r) => r.score > 0);
  return scored.sort((a, b) => b.score - a.score);
}

/** A relative import, resolved against the index's own file list. */
function resolveImport(from, spec, known) {
  if (!/^\.\.?\//.test(String(spec))) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'].map((e) => base + e), `${base}/index.ts`, `${base}/index.js`]) if (known.has(c)) return c;
  return null;
}

/** THE CANDIDATE UNIVERSE — Core's, deterministic, bounded. */
function candidates(query, list, max = CANDIDATES, root = null) {
  const lex = lexical(query, list, root);
  const byId = new Map(list.map((it) => [it.id, it]));
  const score = new Map(lex.map((r) => [r.id, r.score]));
  for (const r of lex.slice(0, 8)) {
    for (const spec of (byId.get(r.id) || {}).imports || []) {
      const to = resolveImport(r.id, spec, byId);
      if (!to || to === r.id) continue;
      const via = +(r.score * 0.5).toFixed(3);
      if ((score.get(to) || 0) < via) score.set(to, via);
    }
  }
  const out = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id, s]) => ({ id, score: s, textHash: (byId.get(id) || {}).textHash }));
  // WHEN THE WORDS FIND LITTLE, Laya's job is exactly the part they missed: the universe is filled to its bound with the files that scored nothing…
  if (out.length < max) {
    const prior = priorFor([]);
    const have = new Set(out.map((c) => c.id));
    const rest = list.filter((it) => !have.has(it.id)).sort((a, b) => prior(b.id, b) - prior(a.id, a) || a.id.localeCompare(b.id));
    for (const it of rest.slice(0, max - out.length)) out.push({ id: it.id, score: 0, textHash: it.textHash });
  }
  return out;
}

// ---- the cascade --------------------------------------------------------------

/** RANK ONE REQUEST. `{ ranked:[{id}], by, ms, abstain, rawChars, candidates, laya }`. `laya` is `'off'` (deterministic only), or the adapter mode… */
async function rank(app, root, query, { laya = 'cos', list = null, generation = null } = {}) {
  const t0 = Date.now();
  const all = list || items(root);
  const cands = candidates(query, all, CANDIDATES, root);
  const scored = cands.filter((c) => c.score > 0);
  let ranked = scored.slice(0, SHOW).map((r) => ({ id: r.id, score: r.score }));
  let by = 'deterministic';
  let layaInfo = null;
  let abstain = !scored.length;
  const rt = require('./workerruntime');
  if (laya !== 'off' && cands.length >= 2 && app && rt.info(app, 'laya') && rt.info(app, 'laya').usable) {
    const st = rt.stats(app, 'laya');
    const before = { bypasses: st.bypasses || 0, timeouts: st.timeouts || 0 };
    const deadline = Number((((app.cfg || {}).workers || {}).laya || {}).deadlineMs) || LAYA_DEADLINE_MS;
    const q = String(query).slice(0, 600);
    const project = rt.hosted(app);
    // THE RESULT CACHE KEY: the question, the candidate set and the exact state of the files it names.
    const cacheKey = require('crypto').createHash('sha1').update(JSON.stringify([q, laya, project ? cands.map((c) => [c.id, c.textHash]) : all])).digest('hex');
    const req = project
      ? { op: 'rank_project', root, query: q, candidates: cands.map((c) => ({ id: c.id, textHash: c.textHash })), k: SHOW, generation }
      : { op: 'rank', query: q, items: all, k: SHOW, mode: laya };
    const r = await rt.call(app, 'laya', req, { timeoutMs: deadline, cacheKey });
    // NOT READY IS NOT A FAILURE: a bypassed Laya (model loading, index building)
    // leaves the deterministic tier to answer alone, and says why.
    layaInfo = r ? { cached: Boolean(r.cached), ms: r.cached ? 0 : r.ms, usage: r.usage || null, ranked: (r.ranked || []).map((x) => ({ id: x.id, cos: x.cos })), stale: r.stale || 0, index: r.index || null }
      : (st.bypasses || 0) > before.bypasses ? { bypass: (st.bypassStates || []).slice(-1)[0] || 'LOADING' }
        : (st.timeouts || 0) > before.timeouts ? { timedOut: true, deadlineMs: deadline } : { failed: true };
    if (r && Array.isArray(r.ranked) && r.ranked.length && !r.abstain) {
      // FUSION, not replacement: a file both tiers rank high leads. Reciprocal
      // rank over the two lists — no tuned weights to be wrong about.
      const fused = new Map();
      const add = (lst, w) => lst.forEach((x, i) => fused.set(x.id, (fused.get(x.id) || 0) + w / (3 + i)));
      add(scored.slice(0, 20), 1);
      add(r.ranked, 1);
      ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHOW).map(([id, s]) => ({ id, score: +s.toFixed(3) }));
      by = 'laya';
      abstain = false;
    }
  }
  const rawChars = all.reduce((s, it) => s + it.text.length + 1, 0);
  return { ranked, by, ms: Date.now() - t0, abstain, n: all.length, rawChars, candidates: cands.map((c) => c.id), laya: layaInfo };
}

module.exports = { items, intentText, lexical, candidates, priorFor, words, rank, SHOW, MIN_FILES, CANDIDATES };
