'use strict';

/** A MIGRATION IS A STATEMENT ABOUT THE FINAL STATE, not a request for new code. */

const fs = require('fs');
const path = require('path');

const config = require('./config');

// ------------------------------------------------------------ vocabulary ---

/** WHAT A MIGRATION DOES TO A THING. */
const OP = Object.freeze({
  REPLACE: 'REPLACE',        // A stops being active, B takes its place
  MOVE: 'MOVE',              // same thing, different address
  MERGE: 'MERGE',            // several things become one, responsibilities kept
  SPLIT: 'SPLIT',            // one thing becomes several
  EXTRACT: 'EXTRACT',        // part of a thing becomes a thing of its own
  CONSOLIDATE: 'CONSOLIDATE',// several implementations of one idea become one
  KEEP: 'KEEP',              // explicitly untouched — see below, this matters
  REMOVE: 'REMOVE',          // gone, with a backup behind it
  ARCHIVE: 'ARCHIVE',        // out of the tree, retrievable, not active
});

/** KEEP IS AN OPERATION ON PURPOSE, and it is the one people leave out. */

/** WHAT HAPPENS TO A RESOURCE that is in range but is not implementation. */
const DISPOSITION = Object.freeze({
  TRANSLATE: 'TRANSLATE',    // re-expressed in the target technology
  PRESERVE: 'PRESERVE',      // byte-for-byte untouched — JSON, assets, data
  ADAPT: 'ADAPT',            // kept, but edited to fit the target
  MOVE: 'MOVE',              // same content, new location
  REMOVE: 'REMOVE',
  ARCHIVE: 'ARCHIVE',
});

/** How far along the migration is. Advanced only by evidence, never by hope. */
const STAGE = Object.freeze({
  DRAFT: 'DRAFT',            // intent parsed, ambiguity outstanding
  PLANNED: 'PLANNED',        // scope resolved, contract complete and valid
  BUILT: 'BUILT',            // the target exists
  VERIFIED: 'VERIFIED',      // the target works AND the old one is still there
  ACTIVATED: 'ACTIVATED',    // the old one has been archived or removed
  COMPLETE: 'COMPLETE',      // final state verified after activation
  ROLLED_BACK: 'ROLLED_BACK',
  FAILED: 'FAILED',
});

/** WHAT THE MIGRATION APPLIES TO. */
const SCOPE_KIND = Object.freeze({
  PROJECT: 'project',        // the whole tree — the expensive default, never assumed
  PATHS: 'paths',            // an explicit set of files or directories
  COMPONENT: 'component',    // a named part: an agent, a module, a subsystem
});

/** Operations that dispose of the source. A contract with none of these ADDS. */
const DISPOSING = new Set([OP.REPLACE, OP.MOVE, OP.MERGE, OP.SPLIT, OP.CONSOLIDATE, OP.REMOVE, OP.ARCHIVE]);

// -------------------------------------------------------------- the model --

function newId() {
  const at = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  return `${at}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A contract with every field present, so nothing downstream tests for null. */
function create({
  id = null, intent = '', source = null, target = null, scope = null,
  operations = [], resources = [], dependencies = null, verification = null,
  open = [], answers = {}, stage = STAGE.DRAFT, root = '',
} = {}) {
  return {
    id: id || newId(),
    at: new Date().toISOString(),
    root: String(root || ''),
    stage,
    intent: String(intent || '').slice(0, 600),
    source,
    target,
    scope: scope || { kind: null, label: '', paths: [], components: [], resolved: false },
    operations: operations.map(normaliseOp).filter(Boolean),
    resources: resources.map(normaliseResource).filter(Boolean),
    dependencies: dependencies || { direct: [], affected: [] },
    verification: verification || { required: [], negative: [] },
    open,
    answers: { ...answers },
    /** Set by migrationcheck.activate; the way back if the target fails. */
    backup: null,
    /** `[{ from, to }]` — what was moved out of the tree, and where it went. */
    archived: [],
    history: [],
  };
}

function normaliseOp(op) {
  if (!op || !OP[op.type]) return null;
  return {
    type: op.type,
    source: op.source == null ? '' : String(op.source),
    sources: Array.isArray(op.sources) ? op.sources.map(String) : [],
    target: op.target == null ? '' : String(op.target),
    targets: Array.isArray(op.targets) ? op.targets.map(String) : [],
    scope: op.scope == null ? '' : String(op.scope),
    why: op.why == null ? '' : String(op.why).slice(0, 300),
    structure: op.structure || null,
  };
}

function normaliseResource(r) {
  if (!r || !r.path || !DISPOSITION[r.disposition]) return null;
  return {
    path: String(r.path).replace(/\\/g, '/'),
    disposition: r.disposition,
    why: r.why == null ? '' : String(r.why).slice(0, 200),
    target: r.target == null ? '' : String(r.target).replace(/\\/g, '/'),
  };
}

/** Record what happened, so the manifest tells the story and not just the plan. */
function note(contract, stage, what) {
  contract.history.push({ at: new Date().toISOString(), stage, what: String(what || '').slice(0, 300) });
  if (stage) contract.stage = stage;
  return contract;
}

// -------------------------------------------------------------- validation --

/** IS THIS A MIGRATION, OR IS IT AN ADDITION WEARING THE WORD? */
function validate(contract) {
  const problems = [];
  const c = contract || {};

  if (!c.target) problems.push('no target — a migration must say what the final state is');
  if (!c.scope || !c.scope.kind) {
    problems.push('NO SCOPE. A migration without one is a project-wide migration by accident: '
      + 'name the files, the component or the whole project explicitly.');
  } else if (c.scope.kind !== SCOPE_KIND.PROJECT && !c.scope.paths.length && !c.scope.components.length) {
    problems.push(`scope is "${c.scope.kind}" but names nothing — resolve it before planning any work`);
  }
  if (c.open && c.open.length) {
    problems.push(`${c.open.length} question(s) about intent are still open — settle them before building anything`);
  }

  // THE ADDITIVE-MIGRATION RULE
  const disposing = c.operations.filter((o) => DISPOSING.has(o.type));
  if (c.source && !disposing.length) {
    problems.push(`ADDITIVE: nothing in this contract disposes of ${labelOf(c.source)}. `
      + '"Migrate X to Y" means the final state contains Y and NOT X — an operation that '
      + 'only creates the target is an addition, not a migration.');
  }

  // Every source a REPLACE names must have somewhere to go afterwards.
  for (const op of c.operations) {
    if (op.type !== OP.REPLACE) continue;
    if (!op.source) problems.push('a REPLACE operation names no source');
    if (!op.target) problems.push(`REPLACE ${op.source} has no target`);
  }

  // And the negative half of verification cannot be empty when something is
  // being disposed of, or nothing will ever check that it went.
  if (disposing.length && !(c.verification.negative || []).length) {
    problems.push('nothing is listed under negative verification, so no check will notice '
      + 'if the old implementation is still active when this is called done');
  }

  return { ok: !problems.length, problems };
}

function labelOf(tech) {
  if (!tech) return 'the source';
  return tech.label || tech.id || 'the source';
}

// --------------------------------------------------------- replacement map --

/** THE MAP THAT STOPS THINGS BEING FORGOTTEN. */
function replacementMap(contract) {
  const rows = [];
  const c = contract || {};
  for (const op of c.operations || []) {
    if (op.type === OP.KEEP) {
      rows.push({ from: op.source || op.scope, to: '', fate: OP.KEEP, why: op.why });
      continue;
    }
    const froms = op.sources.length ? op.sources : (op.source ? [op.source] : []);
    const tos = op.targets.length ? op.targets : (op.target ? [op.target] : []);
    for (const from of froms) {
      rows.push({
        from,
        to: tos.join(', '),
        fate: fateOf(c, from, op),
        why: op.why,
        op: op.type,
      });
    }
    if (!froms.length && tos.length) rows.push({ from: '', to: tos.join(', '), fate: 'NEW', op: op.type, why: op.why });
  }
  // A RESOURCE THAT AN OPERATION ALREADY NAMED IS ALREADY ON THE MAP.
  const mapped = new Set();
  for (const op of c.operations || []) {
    for (const f of (op.sources.length ? op.sources : [op.source])) if (f) mapped.add(f);
  }
  for (const r of c.resources || []) {
    if (r.disposition === DISPOSITION.TRANSLATE) continue;      // already an operation
    if (mapped.has(r.path)) continue;
    rows.push({ from: r.path, to: r.target || '', fate: r.disposition, why: r.why });
  }
  const seen = new Set();
  return rows.filter((r) => {
    const k = [r.from, r.to, r.fate].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What the contract says happens to `from` once the target is verified. */
function fateOf(contract, from, op) {
  const res = (contract.resources || []).find((r) => r.path === from);
  if (res && (res.disposition === DISPOSITION.REMOVE || res.disposition === DISPOSITION.ARCHIVE)) return res.disposition;
  if (op.type === OP.REMOVE) return OP.REMOVE;
  if (op.type === OP.ARCHIVE) return OP.ARCHIVE;
  if (DISPOSING.has(op.type)) return OP.ARCHIVE;
  return OP.KEEP;
}

/** The map as text, in the shape the brief asks for. */
function describeMap(contract) {
  const rows = replacementMap(contract);
  if (!rows.length) return 'REPLACEMENT MAP\n  (nothing mapped yet)';
  const lines = ['REPLACEMENT MAP'];
  for (const r of rows) {
    if (r.fate === OP.KEEP) { lines.push(`  ${r.from || '(unnamed)'}`, `      -> KEEP${r.why ? ` (${r.why})` : ''}`); continue; }
    if (r.fate === DISPOSITION.PRESERVE) { lines.push(`  ${r.from}`, `      -> PRESERVE${r.why ? ` (${r.why})` : ''}`); continue; }
    lines.push(`  ${r.from || '(new)'}`);
    if (r.to) lines.push(`      -> ${r.to}`);
    lines.push(`      -> ${r.fate}${r.fate === OP.ARCHIVE || r.fate === OP.REMOVE ? ' after verification' : ''}`);
  }
  return lines.join('\n');
}

/** What must be true when this is finished. Derived, never stored twice. */
function finalState(contract) {
  const c = contract || {};
  const active = [];
  const inactive = [];
  const preserved = [];
  for (const op of c.operations || []) {
    if (op.type === OP.KEEP) { active.push(op.source || op.scope); continue; }
    const tos = op.targets.length ? op.targets : (op.target ? [op.target] : []);
    const froms = op.sources.length ? op.sources : (op.source ? [op.source] : []);
    for (const t of tos) if (t) active.push(t);
    if (DISPOSING.has(op.type)) for (const f of froms) if (f) inactive.push(f);
  }
  for (const r of c.resources || []) {
    if (r.disposition === DISPOSITION.PRESERVE) preserved.push(r.path);
    else if (r.disposition === DISPOSITION.ADAPT) active.push(r.path);
    else if (r.disposition === DISPOSITION.REMOVE || r.disposition === DISPOSITION.ARCHIVE) inactive.push(r.path);
  }
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  return { active: uniq(active), inactive: uniq(inactive), preserved: uniq(preserved) };
}

// ---------------------------------------------------------------- manifest --

/** The machine-readable form. Everything derived is derived HERE, once. */
function manifest(contract) {
  const c = contract || {};
  return {
    migration: {
      id: c.id,
      at: c.at,
      // THE PROJECT THIS IS ABOUT.
      root: c.root,
      stage: c.stage,
      intent: c.intent,
      source: c.source ? { id: c.source.id, label: c.source.label, kind: c.source.kind, known: c.source.known } : null,
      target: c.target ? { id: c.target.id, label: c.target.label, kind: c.target.kind, known: c.target.known } : null,
      scope: c.scope,
      operations: c.operations,
      resources: c.resources,
      replacement_map: replacementMap(c),
      dependencies: c.dependencies,
      verification: c.verification,
      final_state: finalState(c),
      open_questions: c.open,
      answers: c.answers,
      backup: c.backup,
      archived: c.archived,
      history: c.history,
    },
  };
}

/** WHERE THE MANIFEST LIVES, and why it is not in the project. */
function dir() { return path.join(config.configDir(), 'migrations'); }
function fileFor(id) { return path.join(dir(), `${id}.json`); }

function save(contract) {
  listMemo = null;
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileFor(contract.id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(manifest(contract), null, 2), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
  return f;
}

/** Read one back. A manifest that cannot be read is null, never a throw. */
function load(id) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    const m = j && j.migration;
    if (!m) return null;
    const c = create({
      id: m.id, root: m.root || '', intent: m.intent, source: m.source, target: m.target, scope: m.scope,
      operations: m.operations, resources: m.resources, dependencies: m.dependencies,
      verification: m.verification, open: m.open_questions || [], answers: m.answers || {},
      stage: m.stage,
    });
    c.at = m.at || c.at;
    c.backup = m.backup || null;
    c.archived = m.archived || [];
    c.history = m.history || [];
    return c;
  } catch { return null; }
}

/** Every manifest, newest first. */
let listMemo = null;
function list() {
  let st = null;
  try { st = fs.statSync(dir()); } catch { return []; }
  const sig = `${dir()}|${st.mtimeMs}`;
  if (listMemo && listMemo.sig === sig) return listMemo.value.slice();
  const value = listUncached();
  listMemo = { sig, value };
  return value.slice();
}
function listUncached() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const c = load(n.replace(/\.json$/, ''));
    if (c) out.push(c);
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The migration currently being worked on, or null. */
function latest(root = '') {
  const all = list();
  const live = all.filter((c) => c.stage !== STAGE.COMPLETE && c.stage !== STAGE.ROLLED_BACK && c.stage !== STAGE.FAILED);
  const pick = (rows) => (root ? rows.find((c) => c.root === root) : rows[0]) || null;
  return pick(live) || pick(all);
}

module.exports = {
  OP, DISPOSITION, STAGE, SCOPE_KIND, DISPOSING,
  create, validate, note, replacementMap, describeMap, finalState, manifest,
  save, load, list, latest, dir, fileFor, labelOf, newId,
};
