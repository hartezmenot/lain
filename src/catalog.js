'use strict';

/** MODEL · CONNECTION · EFFORT — three orthogonal things, modelled as three things. */

const providerMod = require('./provider');

// -------------------------------------------------------------- effort ------

/** The effort vocabulary. */
const EFFORT_WORDS = [
  'extra-high', 'extra-low', 'minimal', 'xhigh', 'none', 'medium', 'high', 'low', 'max', 'thinking', 'agentic',
];
const EFFORT_ORDER = {
  none: 0, minimal: 1, low: 2, 'extra-low': 3, medium: 4, high: 5, xhigh: 6, 'extra-high': 7, max: 8,
  agentic: 9, thinking: 10,
};

/** Suffixes that are MODEL IDENTITY, never effort. */
const IDENTITY_SUFFIX = /-(fast|flash|pro|lite|mini|nano|preview|latest|instruct|turbo)$/i;

const EFFORT_RE = new RegExp(
  '^(.*?)-(' + EFFORT_WORDS.slice().sort((a, b) => b.length - a.length).join('|') + ')$', 'i'
);

/** Split an upstream id into { base, effort } when it ends in an effort word. */
function splitEffort(id) {
  const s = String(id || '');
  let axis = '';
  let core = s;
  const ax = IDENTITY_SUFFIX.exec(core);
  if (ax) { axis = ax[0]; core = core.slice(0, -axis.length); }
  const m = EFFORT_RE.exec(core);
  if (!m) return null;
  return { base: m[1] + axis, effort: m[2].toLowerCase() };
}

/** A readable name for a canonical model id. */
function displayName(base) {
  const raw = String(base || '');
  const segments = raw.split('/');
  const last = segments.pop();
  // Leading segments are a QUALIFIER (`no-think/gh/…`, `anthropic/…`).
  const qualifier = segments.join('/');
  const [name, variant] = last.split(':');
  const words = String(name || last)
    .replace(/[_]+/g, ' ')
    .replace(/-/g, ' ')
    .trim()
    .split(/\s+/);
  // A VERSION SPELLED WITH DASHES (`claude-opus-5-5`, `gemini-2-5-pro`) reads as one:
  // "5.5", "2.5". Only short numbers join — a date (`2024-08-06`) is left as it is.
  const joined = [];
  for (const w of words) {
    const prev = joined[joined.length - 1];
    if (prev != null && /^[1-9]\d?(\.\d{1,2})*$/.test(prev) && /^\d{1,2}$/.test(w) && !/^0\d/.test(w)) joined[joined.length - 1] = `${prev}.${w}`;
    else joined.push(w);
  }
  const pretty = joined
    .map((w) => {
      if (/\d/.test(w)) return w;
      if (w.length <= 3 && !/^(pro|max|air|sol)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
  const tags = [qualifier, variant].filter(Boolean).join(' · ');
  return tags ? `${pretty} (${tags})` : pretty;
}

// ------------------------------------------------------------- catalog ------

/** Build the canonical catalog from configured connections. */
/** Strip a ROUTING NAMESPACE from an upstream id. */
function stripRoutingNamespace(id, ownConnectionId = null) {
  const parts = String(id || '').split('/');
  if (parts.length >= 2 && ownConnectionId && foldKey(parts[0]) === foldKey(ownConnectionId)) {
    // NO NAMESPACE TO REPORT: the stripped segment was the connection's own id, not a distinguishable sub-route within it — reporting it as one built the…
    return { key: parts.slice(1).join('/'), namespace: null };
  }
  if (parts.length < 3) return { key: String(id || ''), namespace: null };
  return { key: parts.slice(1).join('/'), namespace: parts[0] };
}

/** A connection's `models` entry may be a bare id or a catalog record. */
function normalizeEntry(m) {
  if (typeof m === 'string') return { id: m, root: null, parent: null, ownedBy: null };
  if (!m || typeof m !== 'object' || !m.id) return null;
  return {
    id: String(m.id),
    root: m.root ? String(m.root) : null,
    parent: m.parent ? String(m.parent) : null,
    ownedBy: m.owned_by ? String(m.owned_by) : (m.ownedBy ? String(m.ownedBy) : null),
  };
}

/** The identity key for a model, and the route that reaches it. */
/** THE SAME MODEL, SPELLED DIFFERENTLY. */
function foldKey(id) {
  // `\s` (whitespace), NOT a literal `s` — a dropped backslash here silently deletes every lowercase `s` from every id
  return String(id || '').toLowerCase().replace(/[-_.\s]+/g, '-');
}

/** Which spelling to keep when two are the same model. */
function preferredId(a, b) {
  const conventional = (m) => (/^[a-z0-9/:.-]+$/.test(m.id) ? 0 : 1);
  if (conventional(a) !== conventional(b)) return conventional(a) < conventional(b) ? a : b;
  if (a.connections.length !== b.connections.length) return a.connections.length > b.connections.length ? a : b;
  return a.id <= b.id ? a : b;
}

function identityOf(entry, ownConnectionId = null) {
  if (entry.root) {
    return { key: entry.root, route: entry.ownedBy || stripRoutingNamespace(entry.id, ownConnectionId).namespace };
  }
  const { key, namespace } = stripRoutingNamespace(entry.id, ownConnectionId);
  return { key, route: entry.ownedBy || namespace };
}

function build(connections = []) {
  const models = new Map(); // baseId -> model

  for (const conn of connections) {
    if (!conn || !conn.id) continue;
    // ALIASES. A record whose `parent` names another id in the same catalog is the provider telling us the two are the same route under two names…
    const declaredIds = new Set();
    for (const raw of conn.models || []) {
      const e = normalizeEntry(raw);
      if (e) declaredIds.add(splitEffort(e.id) ? splitEffort(e.id).base : e.id);
    }

    // A base may be offered at several efforts by ONE connection.
    const byBase = new Map();
    for (const raw of conn.models || []) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      if (entry.parent) {
        const parentBase = splitEffort(entry.parent) ? splitEffort(entry.parent).base : entry.parent;
        if (declaredIds.has(parentBase)) continue; // an alias of something we already have
      }
      const sp = splitEffort(entry.id);
      const base = sp ? sp.base : entry.id;
      if (!byBase.has(base)) byBase.set(base, { efforts: new Map(), plain: null, entry });
      const slot = byBase.get(base);
      if (sp) { if (!slot.efforts.has(sp.effort)) slot.efforts.set(sp.effort, entry.id); }
      else slot.plain = entry.id;
    }

    for (const [base, slot] of byBase) {
      // CONSERVATIVE: one effort sibling is not a variant family.
      const isFamily = slot.efforts.size >= 2;
      const realBase = isFamily ? base : (slot.plain || [...slot.efforts.values()][0] || base);

      // Identity comes from the provider's metadata when it supplied any, and from the routing-namespace heuristic otherwise.
      const { key: modelId, route: namespace } = identityOf({ ...slot.entry, id: realBase }, conn.id);
      // A MODEL WHOSE CATALOG ID NAMES A RETIRED ROUTER is not listed — retired.selection refuses exactly that id, whatever route serves it, so the picker…
      if (require('./retired').modelSystem(modelId)) continue;

      if (!models.has(modelId)) {
        models.set(modelId, { id: modelId, displayName: displayName(modelId), connections: [] });
      }
      const efforts = isFamily
        ? [...slot.efforts.keys()].sort((a, b) => (EFFORT_ORDER[a] ?? 99) - (EFFORT_ORDER[b] ?? 99))
        : [];
      const connectionId = namespace ? `${conn.id}:${namespace}` : conn.id;
      // ONE ROW PER ROUTE THE USER CAN ACTUALLY CHOOSE BETWEEN.
      const already = models.get(modelId).connections.find((c) => c.connectionId === connectionId);
      if (already) {
        // Keep the richer entry: a route that exposes effort levels tells the
        // user more than one that does not.
        if (!already.efforts.length && efforts.length) {
          already.efforts = efforts;
          already.upstreamByEffort = isFamily ? Object.fromEntries(slot.efforts) : {};
          already.upstreamId = isFamily ? (slot.plain || null) : realBase;
        }
        continue;
      }
      models.get(modelId).connections.push({
        connectionId,
        // `connectionId` is what the user selects and what /models shows.
        baseConnectionId: conn.id,
        provider: conn.provider || conn.id,
        route: namespace,
        via: conn.via || 'native',
        auth: conn.auth || 'none',
        // OPTIONAL, AND NEVER GUESSED.
        tier: conn.tier === 'free' || conn.tier === 'paid' ? conn.tier : null,
        // A route to this machine (a local server) — the `local:` filter.
        local: /^https?:\/\/(?:localhost|127\.|\[::1\])/i.test(String(conn.baseUrl || '')),
        efforts,
        upstreamByEffort: isFamily ? Object.fromEntries(slot.efforts) : {},
        // A FAMILY THAT ALSO HAS A PLAIN ID keeps it: "no effort chosen" means
        // that model, not a silently picked -thinking/-agentic sibling (2026-09-23).
        upstreamId: isFamily ? (slot.plain || null) : realBase,
      });
    }
  }

  // ONE ROW PER MODEL, whatever the routes chose to call it.
  const byFold = new Map();
  for (const m of models.values()) {
    const k = foldKey(m.id);
    const prev = byFold.get(k);
    if (!prev) { byFold.set(k, m); continue; }
    const keep = preferredId(prev, m);
    const drop = keep === prev ? m : prev;
    for (const c of drop.connections) {
      if (!keep.connections.some((x) => x.connectionId === c.connectionId)) keep.connections.push(c);
    }
    keep.aliases = [...new Set([...(keep.aliases || []), ...(drop.aliases || []), drop.id])];
    byFold.set(k, keep);
  }

  familyFold(byFold);

  const canonical = new Map();
  for (const m of byFold.values()) {
    // WHICH MODEL A ROUTE ROW SERVES, after every fold — availability keys a
    // server-answered refusal by route AND model (availability.noteOutcome).
    for (const c of m.connections) c.modelId = m.id;
    canonical.set(m.id, m);
    for (const a of m.aliases || []) canonical.set(a, m);
  }
  const list = [...byFold.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { models: list, byId: canonical };
}

/** ONE ROW PER MODEL FAMILY (§56–57). */
const ACCESS_SUFFIX = /(?:[-:](tiered|free|paid|priority|batch|flex))$/i;

function familyFold(byFold) {
  const byBare = new Map();
  for (const [k, m] of byFold) byBare.set(k, m);
  const absorb = (keep, drop, { access = null } = {}) => {
    for (const c of drop.connections) {
      const connectionId = access && keep.connections.some((x) => x.connectionId === c.connectionId) ? `${c.connectionId}#${access}` : c.connectionId;
      if (keep.connections.some((x) => x.connectionId === connectionId)) continue;
      const tier = c.tier || (/^(free|paid)$/i.test(access || '') ? access.toLowerCase() : null);
      keep.connections.push({ ...c, connectionId, access: access || c.access || null, tier });
    }
    keep.aliases = [...new Set([...(keep.aliases || []), ...(drop.aliases || []), drop.id])];
  };
  for (const [k, m] of [...byFold]) {
    const s = ACCESS_SUFFIX.exec(m.id);
    if (!s) continue;
    const base = byBare.get(foldKey(m.id.slice(0, -s[0].length)));
    if (!base || base === m) continue;
    absorb(base, m, { access: s[1].toLowerCase() });
    byFold.delete(k);
  }
  const vendors = new Map();
  for (const [k, m] of byFold) {
    const parts = m.id.split('/');
    if (parts.length !== 2) continue;
    const tail = foldKey(parts[1]);
    if (!vendors.has(tail)) vendors.set(tail, []);
    vendors.get(tail).push(k);
  }
  for (const [tail, keys] of vendors) {
    const bare = byFold.get(tail);
    if (!bare || keys.length !== 1) continue;
    absorb(bare, byFold.get(keys[0]));
    byFold.delete(keys[0]);
  }
}

/** (model, connection, effort) → the EXACT upstream id to put on the wire. */
function resolve(catalog, { model, connectionId = null, effort = null }) {
  const m = catalog.byId.get(model);
  if (!m) return { ok: false, error: `unknown model "${model}"` };
  // A STORED BASE CONNECTION ID (a selection saved before routes carried namespaces) still
  // resolves — but only when exactly ONE of the model's routes goes through it, never a guess.
  const exact = connectionId ? m.connections.find((c) => c.connectionId === connectionId) : null;
  const viaBase = connectionId && !exact ? m.connections.filter((c) => c.baseConnectionId === connectionId) : [];
  const conn = connectionId ? (exact || (viaBase.length === 1 ? viaBase[0] : null)) : m.connections[0];
  if (!conn) return { ok: false, error: `model "${model}" is not served by connection "${connectionId}"` };

  if (!conn.efforts.length) {
    return { ok: true, model: m.id, connection: conn, effort: null, upstreamId: conn.upstreamId || m.id };
  }
  const want = String(effort || '').toLowerCase();
  if (!want && conn.upstreamId) return { ok: true, model: m.id, connection: conn, effort: null, upstreamId: conn.upstreamId };
  const chosen = conn.upstreamByEffort[want]
    ? want
    : conn.efforts.includes('medium') ? 'medium' : conn.efforts[Math.floor(conn.efforts.length / 2)];
  return {
    ok: true, model: m.id, connection: conn, effort: chosen,
    upstreamId: conn.upstreamByEffort[chosen],
    effortFallback: want && chosen !== want ? `"${want}" not offered here; using "${chosen}"` : null,
  };
}

/** The model to use when the user has not chosen one — or null when choosing would be guessing. */
function chooseDefault(catalog, cfg = {}) {
  if (!catalog || !catalog.models.length) return null;
  const declared = cfg.connections && typeof cfg.connections === 'object' ? cfg.connections : {};

  for (const [connId, c] of Object.entries(declared)) {
    const want = c && c.default;
    if (!want) continue;
    const m = find(catalog, String(want));
    if (!m) return { error: `${connId}: default model "${want}" is not in this route's catalog` };
    // Prefer the route that declared it, when that route actually serves it.
    const conn = m.connections.find((x) => x.baseConnectionId === connId) || m.connections[0];
    return { model: m, connection: conn, source: 'declared' };
  }

  if (catalog.models.length === 1) {
    return { model: catalog.models[0], connection: catalog.models[0].connections[0], source: 'only' };
  }
  return null;
}

/** Search by display name or by raw upstream id — both must find the model. */
function find(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  for (const m of catalog.models) if (m.id.toLowerCase() === q) return m;
  for (const m of catalog.models) if (m.displayName.toLowerCase() === q) return m;
  for (const m of catalog.models) {
    if (m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)) return m;
    for (const c of m.connections) {
      if (Object.values(c.upstreamByEffort).some((u) => String(u).toLowerCase() === q)) return m;
      if (c.upstreamId && String(c.upstreamId).toLowerCase() === q) return m;
    }
  }
  return null;
}

const { search } = require('./modelsearch');

/** WHAT CHANGED between two catalogs. */
function diff(before, after, currentModel = null) {
  const ids = (cat) => new Set(((cat && cat.models) || []).map((m) => m.id));
  const was = ids(before);
  const now = ids(after);
  const added = [...now].filter((id) => !was.has(id));
  const removed = [...was].filter((id) => !now.has(id));
  const current = currentModel ? String(currentModel) : null;
  return {
    before: was.size,
    after: now.size,
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
    // `null` means "you had not chosen one", which is not the same as "the one
    // you chose is gone" and must not be reported as though it were.
    currentModel: current,
    currentSurvived: current ? now.has(current) || Boolean(find(after, current)) : null,
  };
}

/** RE-READ WHAT THE ROUTES SERVE, without restarting. */
async function refreshAndReport(app, { only = null } = {}, { C } = {}) {
  const w = (s) => app.render.write(s);
  const before = app.catalog();
  const current = providerMod.resolve(app.cfg).model;

  w(C.dim('  Refreshing…\n'));
  let results;
  try {
    results = await app.ensureCatalog({ force: true, only, announce: false });
  } catch (e) {
    app.render.notice('error', `Refresh failed: ${(e && e.message) || e}`);
    return null;
  }

  if (!results.length) {
    w(C.dim(`  Nothing to refresh${only ? ` for "${only}"` : ''} — every route declares its own model list, so there is nothing to ask.\n`));
    return null;
  }

  let failures = 0;
  for (const r of results) {
    if (r.ok) w(C.green('  ✓ ') + r.id + C.dim(`  ${r.count} model(s) from ${r.url}\n`));
    else {
      // ASKED FOR, SO SHOWN IN FULL: the verdict, then what the provider said.
      failures += 1;
      const label = require('./catalogstate').LABEL[r.state] || 'failed';
      w(C.yellow('  ✕ ') + r.id + C.dim(`  ${label} · ${r.error}\n`));
      if (r.raw) w(C.dim(`      ${String(r.raw).replace(/\s+/g, ' ').slice(0, 300)}\n`));
    }
  }

  const after = app.catalog();
  const d = diff(before, after, current);
  // EACH CONNECTION'S OWN GENERATION (modelcatalog.js) — the same record the Harness's Refresh models writes.
  try { require('./modelcatalog').observeApi(app, { only }); } catch { /* recorded on the next refresh */ }
  // WHICH ONES WERE NEW, remembered past the end of this sentence.
  require('./newmodels').record(d.added, { firstCatalog: d.before === 0 });
  if (!d.changed) {
    w(C.dim(`  Already up to date — ${d.after} model(s), nothing added or removed.\n`));
  } else {
    w(C.green(`  ✓ ${d.after} model(s)`) + C.dim(`  (was ${d.before})\n`));
    if (d.added.length) w(C.green(`  ✓ ${d.added.length} new`) + C.dim(`: ${d.added.slice(0, 5).join(', ')}${d.added.length > 5 ? ' …' : ''}\n`));
    if (d.removed.length) w(C.yellow(`  ✕ ${d.removed.length} gone`) + C.dim(`: ${d.removed.slice(0, 5).join(', ')}${d.removed.length > 5 ? ' …' : ''}\n`));
  }
  // The one consequence that changes what happens next.
  if (d.currentSurvived === false) {
    app.render.notice('warn',
      `The model you were using (${d.currentModel}) is no longer served by any route. `
      + 'Pick another with /models — nothing has been chosen for you.');
  } else if (d.currentSurvived === true) {
    w(C.dim(`  Current model kept: ${d.currentModel}\n`));
  }
  if (failures) w(C.dim(`  ${failures} route(s) could not be reached; the rest were refreshed.\n`));
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return d;
}


// THE `/models` COMMAND LIVES IN modelcommand.js — the thing that ASKS these questions, kept apart from the catalog that answers them.

module.exports = { build, foldKey, resolve, find, search, chooseDefault, diff, refreshAndReport, splitEffort, displayName, EFFORT_WORDS, EFFORT_ORDER, IDENTITY_SUFFIX };
