'use strict';

/**
 * WHAT EACH PROVIDER SAYS IT SERVES, GENERATION BY GENERATION (2026-10-02).
 *
 *   <config>/model-catalog.json
 *   { v:1, sources: { <source>: { gen, at, label, models: { <id>: { label, efforts, capabilities,
 *                                  firstSeen, lastSeen, status, removedAt } } } },
 *          diffs: { <source>: { gen, at, added:[{id,label}], removed:[…], changed:[{id,label,what:[…]}] } } }
 *
 * A SOURCE is a provider family (codex, claude, antigravity — the union of what its accounts' own catalogs list) or
 * one API connection (`api:<connectionId>`). Discovery is the provider's own listing, recorded where it happens:
 * an account refresh (Codex `model/list`, Claude Code `initialize`, Antigravity `fetchAvailableModels`) and an API
 * catalog refresh (`/models`). Nothing here guesses a model or a capability from a name.
 *
 * WHAT A NEW GENERATION MEANS:
 *   added      NEW — until it is selected, or for NEW_DAYS. Never on a source's first generation ("everything is new"
 *              is true and useless).
 *   removed    NOT erased: "no longer reported" (removedAt kept). Historical sessions stay readable; nothing is
 *              routed to it, because no account serves it.
 *   changed    label, effort variants or reported capabilities moved — recorded, shown only when useful.
 * NOTHING MOVES: the default model and every session's model are untouched. A model merely becomes available.
 */

const fs = require('fs');
const path = require('path');

const NEW_DAYS = 7;
const TTL_MS = 24 * 3600_000;
const BACKGROUND_DELAY_MS = 60_000;

let memo = null;

function file() { return path.join(require('./config').configDir(), 'model-catalog.json'); }

function read() {
  const f = file();
  let st = null;
  try { st = fs.statSync(f); } catch { st = null; }
  if (!st) return { v: 1, sources: {}, diffs: {} };
  if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { data = null; }
  if (!data || typeof data.sources !== 'object') data = { v: 1, sources: {}, diffs: {} };
  if (!data.diffs) data.diffs = {};
  memo = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

function write(data) {
  const f = file();
  genMemo = { at: 0, v: '' };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
  } catch { /* a catalog of observations */ }
  memo = null;
}

const strip = (id) => String(id || '').replace(/^(claude-code|codex|antigravity|runtime:[^/]+)\//, '');
const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
const capsKey = (c) => JSON.stringify(Object.keys(c || {}).sort().map((k) => [k, c[k]]));

/**
 * A SOURCE'S CURRENT LISTING. `models`: [{ id, label, efforts?, capabilities? }]. Returns the diff (null when nothing
 * changed — no write).
 */
function observe(source, models, { label = null, now = Date.now() } = {}) {
  const key = String(source || '');
  if (!key || !Array.isArray(models)) return null;
  const data = JSON.parse(JSON.stringify(read()));
  const prev = data.sources[key] || null;
  const first = !prev;
  const src = prev || { gen: 0, at: 0, label: label || key, models: {} };
  if (label) src.label = label;
  const seen = new Set();
  const added = []; const changed = []; const removed = [];
  for (const m of models) {
    const id = strip(m && m.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cur = src.models[id];
    const efforts = Array.isArray(m.efforts) ? m.efforts.map(String) : [];
    const capabilities = m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : null;
    const lbl = String(m.label || id);
    if (!cur || cur.status === 'no-longer-reported') {
      src.models[id] = { label: lbl, efforts, capabilities, firstSeen: cur ? cur.firstSeen : now, lastSeen: now, status: first ? 'active' : 'new', ...(cur ? { returnedAt: now } : {}) };
      if (!first) added.push({ id, label: lbl });
      continue;
    }
    const what = [];
    if (cur.label !== lbl) what.push('name');
    if (!sameList(cur.efforts, efforts)) what.push('effort variants');
    if (capabilities && capsKey(cur.capabilities) !== capsKey(capabilities)) what.push('capabilities');
    src.models[id] = { ...cur, label: lbl, efforts, capabilities: capabilities || cur.capabilities || null, lastSeen: now, status: cur.status === 'new' && newStill(cur, now) ? 'new' : 'active' };
    if (what.length) changed.push({ id, label: lbl, what });
  }
  for (const [id, cur] of Object.entries(src.models)) {
    if (seen.has(id) || cur.status === 'no-longer-reported') continue;
    src.models[id] = { ...cur, status: 'no-longer-reported', removedAt: now };
    removed.push({ id, label: cur.label });
  }
  const anything = first || added.length || removed.length || changed.length;
  src.at = now;
  if (!anything) { data.sources[key] = src; write(data); return null; }
  src.gen += 1;
  data.sources[key] = src;
  const diff = { source: key, label: src.label, gen: src.gen, at: now, first, added, removed, changed };
  if (!first) data.diffs[key] = diff;
  write(data);
  return diff;
}

function newStill(m, now = Date.now()) { return m && m.status === 'new' && now - (m.firstSeen || 0) < NEW_DAYS * 86400_000; }

/** The model's catalog status in a source: 'new' | 'active' | 'no-longer-reported' | null (never seen). */
function status(source, id, now = Date.now()) {
  const s = read().sources[String(source || '')];
  const m = s && s.models[strip(id)];
  if (!m) return null;
  if (m.status === 'new' && !newStill(m, now)) return 'active';
  return m.status;
}

/** It was selected, so it is no longer news. */
function seen(source, id) {
  const data = JSON.parse(JSON.stringify(read()));
  const s = data.sources[String(source || '')];
  const m = s && s.models[strip(id)];
  if (!m || m.status !== 'new') return false;
  m.status = 'active';
  write(data);
  return true;
}

/** Models a source reported once and no longer does — kept, labelled, never routed. */
function gone(source) {
  const s = read().sources[String(source || '')];
  return s ? Object.entries(s.models).filter(([, m]) => m.status === 'no-longer-reported').map(([id, m]) => ({ id, label: m.label, removedAt: m.removedAt || null })) : [];
}

/** The latest generation change of every source (for "Codex models updated + GPT-6.1 Sol"). */
function diffs({ since = 0 } = {}) { return Object.values(read().diffs || {}).filter((d) => d.at > since).sort((a, b) => b.at - a.at); }

/** How many models are NEW now, across sources. */
function newCount(now = Date.now()) {
  let n = 0;
  for (const s of Object.values(read().sources)) for (const m of Object.values(s.models)) if (newStill(m, now)) n += 1;
  return n;
}

function sourceAt(source) { const s = read().sources[String(source || '')]; return s ? s.at || 0 : 0; }

// ---------------------------------------------------------------- discovery --

const FAMILY_OF_DRIVER = Object.freeze({ 'claude-code': 'claude', codex: 'codex', antigravity: 'antigravity' });
const LABEL = Object.freeze({ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' });

/**
 * A FAMILY'S LISTING: the union of what every one of its accounts reported (a disabled account still counts — it is
 * kept), plus Claude Code's default profile for Claude. Called after an account's catalog was refreshed.
 */
function observeFamily(app, family) {
  const drivers = Object.entries(FAMILY_OF_DRIVER).filter(([, f]) => f === family).map(([d]) => d);
  const byId = new Map();
  let recs = [];
  try { recs = require('./accountinstances').records(); } catch { recs = []; }
  for (const r of recs) {
    if (!drivers.includes(r.driver_id)) continue;
    for (const m of r.models || []) if (m && m.id && !byId.has(strip(m.id))) byId.set(strip(m.id), m);
  }
  if (family === 'claude') {
    try {
      const t = require('./runtimeadapters').cachedTelemetry('claude-code');
      for (const m of (t && t.models) || []) if (m && m.id && !byId.has(strip(m.id))) byId.set(strip(m.id), { ...m, label: String(m.label || m.id).replace(/ · Claude Code$/, '') });
    } catch { /* no runtime profile */ }
  }
  if (!byId.size) return null;   // nothing reported yet: no generation (never "everything was removed")
  return observe(family, [...byId.values()], { label: LABEL[family] || family });
}

/** API CONNECTIONS: each connection's own listing, from the catalog it just refreshed. */
function observeApi(app, { only = null } = {}) {
  const out = [];
  let cat = null;
  try { cat = app.catalog(); } catch { cat = null; }
  if (!cat || !Array.isArray(cat.models)) return out;
  const per = new Map();
  for (const m of cat.models) {
    for (const c of m.connections || []) {
      const id = c.baseConnectionId || c.connectionId;
      if (!id || !/^lain:/.test(id) || (only && id !== only)) continue;
      if (!per.has(id)) per.set(id, []);
      per.get(id).push({ id: c.upstreamId || m.id, label: m.label || m.id });
    }
  }
  for (const [id, models] of per) { const d = observe(`api:${id}`, models, { label: id.replace(/^lain:/, '') }); if (d) out.push(d); }
  return out;
}

/**
 * REFRESH MODELS — the one Core act behind MODEL › Refresh models, a provider's own Refresh models, `/model refresh`
 * and `lain model refresh`. Scoped: `family` ('codex' | 'claude' | 'antigravity' | 'api' | 'api:<id>') or all.
 * Disabled accounts are not asked (their last listing still counts). Returns the generation diffs.
 */
async function refresh(app, { family = null } = {}) {
  const ai = require('./accountinstances');
  const notes = [];
  const diffsOut = [];
  const enabled = (instId) => {
    try { const a = require('./fabric/index').families(app).flatMap((f) => f.accounts).find((x) => x.instanceId === instId || x.id === instId); return !a || a.enabled !== false; } catch { return true; }
  };
  const fams = family ? [family] : ['codex', 'claude', 'antigravity', 'api'];
  // WHAT THIS REFRESH CHANGED: a generation may be recorded on the way (an account's refresh observes its family), so
  // the answer is every source whose generation moved between here and the end.
  const genBefore = Object.fromEntries(Object.entries(read().sources).map(([k, s]) => [k, s.gen || 0]));
  for (const fam of fams) {
    if (fam === 'api' || String(fam).startsWith('api:')) {
      const only = String(fam).startsWith('api:') ? String(fam).slice(4) : null;
      try { await app.ensureCatalog({ force: true, only, announce: false }); } catch (e) { notes.push(`API: ${e.message}`); }
      observeApi(app, { only });
      continue;
    }
    if (fam === 'claude') { try { await require('./runtimeadapters').report(app, 'claude-code', { refresh: true }); } catch (e) { notes.push(`Claude Code: ${e.message}`); } }
    const drivers = Object.entries(FAMILY_OF_DRIVER).filter(([, f]) => f === fam).map(([d]) => d);
    for (const v of ai.list(app).filter((x) => drivers.includes(x.driver_id))) {
      if (!enabled(v.id)) continue;
      // eslint-disable-next-line no-await-in-loop -- one account at a time, each in its own directory
      try { await ai.refresh(app, v.id); } catch (e) { notes.push(`${v.display_name}: ${e.message}`); }
    }
    observeFamily(app, fam);
  }
  const after = read();
  for (const [k, s] of Object.entries(after.sources)) {
    if ((s.gen || 0) > (genBefore[k] || 0) && after.diffs[k] && after.diffs[k].gen === s.gen) diffsOut.push(after.diffs[k]);
  }
  try { require('./appcatalog').invalidate(); const r = app._sibling || app; r._acctMemo = null; r._catMemo = null; } catch { /* rebuilt on the next read */ }
  return { ok: true, diffs: diffsOut.filter((d) => !d.first), notes, newCount: newCount() };
}

/** "Codex models updated  + GPT-6.1 Sol  − GPT-5.9 Preview" — or '' when nothing worth saying changed. */
function summarize(d) {
  if (!d || d.first) return '';
  const lines = [`${d.label} models updated`];
  for (const a of d.added.slice(0, 6)) lines.push(`+ ${a.label}`);
  for (const r of d.removed.slice(0, 6)) lines.push(`- ${r.label}`);
  const more = d.added.length + d.removed.length - Math.min(6, d.added.length) - Math.min(6, d.removed.length);
  if (more > 0) lines.push(`… ${more} more`);
  if (!d.added.length && !d.removed.length && d.changed.length) lines.push(`${d.changed.length} model(s) changed: ${d.changed.slice(0, 3).map((c) => `${c.label} (${c.what.join(', ')})`).join('; ')}`);
  return lines.join('\n');
}

/**
 * A LIGHT BACKGROUND REFRESH after start: only sources older than TTL_MS, one minute after the process settled, never
 * blocking anything, never repeated in this process. No polling.
 */
let scheduled = false;
function scheduleBackground(app, { delayMs = BACKGROUND_DELAY_MS } = {}) {
  if (scheduled || process.env.LAIN_ISOLATED === '1' && !process.env.LAIN_MODEL_REFRESH_IN_TESTS) return false;
  scheduled = true;
  const t = setTimeout(async () => {
    for (const fam of ['codex', 'claude', 'antigravity']) {
      if (Date.now() - sourceAt(fam) < TTL_MS) continue;
      // eslint-disable-next-line no-await-in-loop -- one provider at a time, in the background
      try { await refresh(app, { family: fam }); } catch { /* the next start tries again */ }
    }
  }, delayMs);
  if (t.unref) t.unref();
  return true;
}

/** The catalog's generation, for readers that memoise on it (fabric/index.js). A stat at most every 200 ms. */
let genMemo = { at: 0, v: '' };
function generation() {
  const now = Date.now();
  if (now - genMemo.at < 200) return genMemo.v;
  let v = 'none';
  try { const st = fs.statSync(file()); v = `${st.mtimeMs}:${st.size}`; } catch { v = 'none'; }
  genMemo = { at: now, v };
  return v;
}

function _reset() { memo = null; scheduled = false; genMemo = { at: 0, v: '' }; }

module.exports = { generation, observe, observeFamily, observeApi, refresh, status, seen, gone, diffs, newCount, summarize, scheduleBackground, file, strip, NEW_DAYS, TTL_MS, _reset };
