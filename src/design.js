'use strict';

/**
 * LAIN DESIGN, FROM CORE — THE ONE DOOR (2026-10). Design is optional and separately installed (packages/design-core in
 * a source tree, `design/` beside an installed app). Nothing in Core requires the engine except through `load()`, and
 * nothing calls `load()` unless a Design session or a /api/design route is in use — a LAIN without Design never reads
 * a line of it.
 *
 * A DESIGN SESSION IS ITS OWN KIND (`session.kind === 'design'`): the core tools plus the five design_* tools, fixed for
 * the session. An ordinary session is never offered them, and its prompt, tools and cache prefix are exactly what they
 * were before Design existed.
 *
 * Every write goes through Core's mutation transaction (provenance, checkpoint, receipt) and the engine's own stale-edit
 * guard (each file's bytes are checked against what the edit was computed from); a project that is not trusted for
 * edits is shown read-only, and the React preview — which runs the project's own Vite config — needs a trusted project.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KIND = 'design';
const NOT_INSTALLED = 'LAIN Design is not installed. Add it with the LAIN installer (Settings › Apps › LAIN › Modify, or run LAIN-Setup again and tick "LAIN Design"). Everything else works without it.';

function candidates() {
  if (process.env.LAIN_DESIGN_DIR) return [process.env.LAIN_DESIGN_DIR];
  return [path.join(ROOT, 'design'), path.join(ROOT, 'packages', 'design-core')];
}

/** Is Design installed (and usable)? { ok, dir, version } or { ok:false, why }. Reads two small files; loads nothing. */
function installed() {
  // AN INSTALLED LAIN WHOSE PERSON UNCHECKED "LAIN Design" at setup: the files may be in the version folder; it is not installed.
  try { const c = require('./components').read(); if (c.installed && c.design === false) return { ok: false, why: NOT_INSTALLED }; } catch { /* a source tree */ }
  for (const dir of candidates()) {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg || pkg.name !== '@lain/design-core') continue;
    const missing = Object.keys(pkg.dependencies || {}).filter((d) => !fs.existsSync(path.join(dir, 'node_modules', d, 'package.json')));
    if (missing.length) return { ok: false, dir, why: `LAIN Design at ${dir} is missing ${missing.join(', ')} (reinstall the Design component)` };
    return { ok: true, dir: path.resolve(dir), version: pkg.version };
  }
  return { ok: false, why: NOT_INSTALLED };
}

function enabled(app) {
  const cfg = (app && app.cfg) || {};
  return !(cfg.design && cfg.design.enabled === false);
}

let engine = null;
/** The engine. Throws when Design is not installed — callers check `installed()` first. */
function load() {
  if (engine) return engine;
  const at = installed();
  if (!at.ok) throw new Error(at.why);
  engine = require(path.join(at.dir, 'src', 'index.js'));
  return engine;
}
function loaded() { return Boolean(engine); }

function isDesignSession(s) { return Boolean(s && s.kind === KIND); }

/** Can this project be edited here? '' or why not. */
function editBlock(app, root) {
  try { if (require('./readonly').active(app && app.session)) return 'this session is read-only'; } catch { /* no read-only state */ }
  // A PROJECT MARKED READ-ONLY is never edited from Design. An undecided one is edited as anywhere else in LAIN: the
  // person's own canvas edits are theirs, and the model's go through the permission gate (execmode) like any tool.
  try { if (require('./trust').levelOf((app && app.cfg) || {}, root) === 'READ_ONLY') return 'this project is marked read-only'; } catch { /* trust unknown: the gate decides */ }
  return '';
}

/** One Design per project root, per process (the canvas and every session's tools share it — one undo stack, one preview). */
const DESIGNS = new Map();
const RELAYS = new Map();
function forProject(app, root) {
  const abs = path.resolve(root);
  let d = DESIGNS.get(abs);
  if (!d) {
    const E = load();
    const meta = sidecar(abs).read();
    const auth = (app && app.cfg && app.cfg.design && app.cfg.design.auth && app.cfg.design.auth[abs]) || null;
    d = new E.Design(abs, { relay: relayFor(abs), write: writerFor(abs), spawn: spawnFor(app), launch: meta.launch || null, auth, extraPorts: previewPorts(app, abs) });
    DESIGNS.set(abs, d);
  }
  return d;
}

/**
 * THE DEV SERVER UNDER LAIN'S PROCESS AUTHORITY (the Preview's ProcessManager): the project's own script, owned,
 * logged and stopped like the Preview's. Without one (a bare engine, tests) Design owns a process group itself.
 */
function spawnFor(app) {
  if (!app) return null;
  return async ({ command, cwd, env, port }) => {
    let pm = null;
    try { pm = require('./workshop').forApp(app).processes; } catch { pm = null; }
    if (!pm) return null;
    const proc = pm.start({ name: 'design:dev', command, cwd, env, port });
    let fn = null; let seen = 0;
    const t = setInterval(() => { const log = String(proc.log || ''); if (fn && log.length > seen) { fn(log.slice(seen)); seen = log.length; } }, 200);
    if (t.unref) t.unref();
    return { child: { get exitCode() { return proc.alive ? null : (proc.exitCode == null ? -1 : proc.exitCode); } }, onLog: (f) => { fn = f; }, close: async () => { clearInterval(t); try { await pm.stop(proc.processId); } catch { /* already gone */ } } };
  };
}

/** The Preview's own dev server for this project, if the Preview has one open (attach to it first). */
function previewPorts(app, root) {
  try {
    const ws = require('./workshop').forApp(app);
    const out = [];
    for (const [p, o] of ws._open || []) if (path.resolve(p) === path.resolve(root) && o && o.url) { const m = /:(\d{2,5})/.exec(o.url); if (m) out.push(Number(m[1])); }
    return out;
  } catch { return []; }
}
/** Drop one project's Design (its preview, mirror and dev server stop); the next call opens it afresh. */
async function forget(root) { const abs = path.resolve(root); const d = DESIGNS.get(abs); DESIGNS.delete(abs); if (d) { try { await d.close(); } catch { /* closing */ } } }
async function closeAll() { const all = [...DESIGNS.values()]; DESIGNS.clear(); RELAYS.clear(); for (const d of all) { try { await d.close(); } catch { /* closing */ } } }

/** The engine's writer: inside the project (realpath) and still the bytes the edit was computed from. */
function writerFor(root) {
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  return (rel, text, expectSha) => {
    const abs = path.resolve(root, rel);
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir)) dir = path.dirname(dir);
    const realDir = fs.realpathSync(dir);
    const r = path.relative(realRoot, realDir);
    if (r.startsWith('..') || path.isAbsolute(r)) return { ok: false, why: `${rel} is outside the project` };
    if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) {
      const t = path.relative(realRoot, fs.realpathSync(abs));
      if (t.startsWith('..') || path.isAbsolute(t)) return { ok: false, why: `${rel} links outside the project` };
    }
    let cur = null;
    try { cur = fs.readFileSync(abs, 'utf8'); } catch { cur = null; }
    const sha = cur == null ? null : require('crypto').createHash('sha1').update(cur).digest('hex');
    if (expectSha !== undefined && sha !== expectSha) return { ok: false, stale: true, why: `${rel} changed on disk since Design read it — nothing was written; the canvas re-reads it` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return { ok: true };
  };
}

/**
 * COMMIT a computed edit through Core's mutation transaction. `actor` USER for the canvas, MODEL for the tools (whose
 * ctx carries the turn, so LAIN's own checkpoint covers it too).
 */
/** UNDO a write the proof did not confirm (or the person's Undo), as a transaction like the write was. */
async function undoProven(app, design) {
  let out = null;
  const files = ((design.project.snapshots.undo || []).slice(-1)[0] || { files: [] }).files.map((f) => path.resolve(design.root, f.rel));
  await require('./mutation').change(app, { actor: 'USER', name: 'design.undo', targets: files, write: () => { out = design.undo(); return { ok: out.ok, why: out.why, output: out.ok ? `undid ${out.label}` : out.why }; } });
  return out || { ok: false, why: 'nothing was undone' };
}

async function commit(app, design, result, { ctx = null, actor = 'USER', label = null } = {}) {
  const block = editBlock(app, design.root);
  if (block) return { ok: false, why: `NOT CHANGED: ${block}` };
  const targets = [...(result.files || []).map((f) => f.rel), ...(result.binary || []).map((b) => b.rel)].map((rel) => path.resolve(design.root, rel));
  let out = null;
  const apply = async () => {
    out = design.commit(result, { label });
    return { output: out.ok ? out.summary : out.why, ok: out.ok, why: out.why, isError: !out.ok, mutated: out.ok ? targets : [] };
  };
  const mutation = require('./mutation');
  if (ctx) await mutation.transact({ name: 'design_edit', input: {}, ctx: { ...ctx, cwd: ctx.cwd || design.root }, targets, apply });
  else await mutation.change(app, { actor, name: 'design.edit', targets, write: apply, what: result.summary || '' });
  return out || { ok: false, why: 'the edit was not applied' };
}

// ---- the Design window's relay: design_interact drives the visible canvas when one is attached ------------------

/** A queue the Design window polls: Core puts an interaction in, the window runs it on its canvas and posts the result. */
function relayFor(root) {
  let r = RELAYS.get(root);
  if (r) return r;
  r = {
    seen: 0, queue: [], waiting: new Map(), seq: 0,
    attached() { return Date.now() - this.seen < 4000; },
    run(job) {
      const id = `j${++this.seq}`;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('the Design window did not finish the test in 60 s')); }, 60000);
        this.waiting.set(id, (res) => { clearTimeout(t); resolve(res); });
        this.queue.push({ id, ...job });
      });
    },
    take() { this.seen = Date.now(); return this.queue.shift() || null; },
    done(id, steps) { const w = this.waiting.get(id); if (w) { this.waiting.delete(id); w((steps || []).map((s) => ({ ...s, screenshot: s.screenshot ? Buffer.from(String(s.screenshot).replace(/^data:image\/png;base64,/, ''), 'base64') : undefined }))); return true; } return false; },
  };
  RELAYS.set(root, r);
  return r;
}

// ---- the tools ----------------------------------------------------------------------------------------------------

/** The five design_* tools in Core's tool shape — only ever added to a Design session's list (tools/index.js). */
function tools() {
  const E = load();
  const out = {};
  for (const name of E.tools.NAMES) {
    out[name] = {
      mutates: E.tools.MUTATES[name],
      schema: E.tools.SCHEMAS[name],
      async run(input, ctx) {
        const app = (ctx && ctx.app) || null;
        const session = (ctx && ctx.session) || (app && app.session) || null;
        const root = (session && (session.designRoot || session.cwd)) || process.cwd();
        const design = forProject(app, root);
        const shotsDir = path.join(require('./config').configDir(), 'design', 'shots');
        const r = await E.tools.run(design, name, input || {}, {
          shotsDir,
          commit: (res) => commit(app, design, res, { ctx: { ...(ctx || {}), cwd: root }, actor: 'MODEL' }),
          undo: () => undoProven(app, design),
        });
        return { output: r.output, isError: Boolean(r.isError), ...(r.meta ? { meta: r.meta } : {}) };
      },
    };
  }
  return out;
}

/** A NEW DESIGN SESSION for a project: its own kind, its tools fixed from its first request. */
function newSession(app, cwd) {
  const at = installed();
  if (!at.ok) return { ok: false, why: at.why };
  const pool = app && typeof app.pool === 'function' ? app.pool() : null;
  if (pool) {
    const r = pool.create({ cwd: path.resolve(cwd), kind: KIND });
    if (!r.ok) return r;
    r.app.session.title = `Design · ${path.basename(path.resolve(cwd))}`;
    try { r.app.session.save(); } catch { /* an unsaved empty session is still empty */ }
    return { ok: true, id: r.id, app: r.app, session: r.app.session };
  }
  const { Session } = require('./session');
  const s = new Session({ cwd: path.resolve(cwd) });
  s.kind = KIND;
  s.title = `Design · ${path.basename(path.resolve(cwd))}`;
  return { ok: true, id: s.id, session: s };
}

/**
 * THE SIDECAR (.lain/design.json): the canvas's own layout — screen positions in Flow, the device, the zoom. Never
 * anything about the code (the code is the source of truth); LAIN's state, like the rest of .lain/.
 */
function sidecar(root) {
  const file = path.join(root, '.lain', 'design.json');
  return {
    read() { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } },
    write(meta = {}) {
      const prev = this.read();
      const launch = meta.launch === null ? undefined : meta.launch && typeof meta.launch === 'object'
        ? { cmd: typeof meta.launch.cmd === 'string' ? meta.launch.cmd.slice(0, 400) : undefined, port: Number(meta.launch.port) || undefined }
        : prev.launch;
      const clean = {
        ...prev,
        launch,
        device: typeof meta.device === 'string' ? meta.device.slice(0, 40) : prev.device,
        zoom: Number.isFinite(meta.zoom) ? Math.max(0.1, Math.min(4, meta.zoom)) : prev.zoom,
        screens: meta.screens && typeof meta.screens === 'object' ? Object.fromEntries(Object.entries(meta.screens).slice(0, 200).map(([k, v]) => [String(k).slice(0, 300), { x: Math.round(Number(v && v.x) || 0), y: Math.round(Number(v && v.y) || 0) }])) : prev.screens,
        // HOW IT LAST OPENED (no credentials, ever): the command and port, attached or started.
        recipe: meta.recipe && typeof meta.recipe === 'object' ? { cmd: meta.recipe.cmd || null, port: Number(meta.recipe.port) || null, attached: Boolean(meta.recipe.attached) } : prev.recipe,
      };
      for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
      return clean;
    },
  };
}

function status(app) {
  const at = installed();
  return { installed: at.ok, enabled: enabled(app), version: at.version || null, dir: at.dir || null, why: at.ok ? null : at.why, loaded: loaded() };
}

function _reset() { engine = null; }

/** A picture for the Agent (the map-ask crop), kept with Design's other shots in LAIN's home — never in the project. */
function saveShot(png, prefix = 'shot') {
  const f = path.join(require('./config').configDir(), 'design', 'shots', `${prefix}-${Date.now().toString(36)}.png`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, png);
  return f;
}

module.exports = { saveShot, forget, undoProven, spawnFor, NOT_INSTALLED, sidecar, closeAll, KIND, installed, enabled, load, loaded, isDesignSession, forProject, commit, tools, newSession, status, editBlock, writerFor, relayFor, candidates, _reset };
