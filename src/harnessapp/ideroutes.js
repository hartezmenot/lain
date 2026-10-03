'use strict';

/** THE IDE'S ROUTES — file operations, search, source control, the editor's context report, file checks, and the project's own `.vscode` settings. */

const fs = require('fs');
const path = require('path');
const sv = require('../sessionviews');
const fileops = require('./fileops');
const gitops = require('./gitops');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
function noProject() { return bad('no project is attached to this session', 409, { projectRequired: true }); }
function attached(app) { return !app.session.cowork && sv.project(app.session).attached; }
/** A refusal from an owner stays a 200 with ok:false when the page must show its fields. */
function reply(r) { return r && r.ok ? ok(r) : { code: 200, body: { ok: false, ...(r || {}), why: String((r && r.why) || 'refused') } }; }

/** Read one JSONC file of the project's .vscode folder. Comments tolerated; never written. */
function readJsonc(abs) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch { /* JSON with comments — below */ }
  try { return JSON.parse(stripJsonc(text)); } catch { return { unreadable: true }; }
}

/** COMMENTS AND TRAILING COMMAS OUT, STRINGS UNTOUCHED. */
function stripJsonc(text) { return stripPass(stripPass(text)); }

function stripPass(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i += 1;
    } else { out += c; i += 1; }
  }
  return out;
}

const ROUTES = {
  'POST /api/files/raw': (app, body = {}) => (attached(app) ? reply(require('./source').raw(app, body.path)) : noProject()),
  'POST /api/files/create': async (app, body = {}) => (attached(app) ? reply(await fileops.createFile(app, body.path, body.body)) : noProject()),
  'POST /api/files/mkdir': (app, body = {}) => (attached(app) ? reply(fileops.createFolder(app, body.path)) : noProject()),
  'POST /api/files/rename': async (app, body = {}) => (attached(app) ? reply(await fileops.rename(app, body.from, body.to)) : noProject()),
  'POST /api/files/delete': async (app, body = {}) => (attached(app) ? reply(await fileops.remove(app, body.path)) : noProject()),
  'POST /api/files/saveas': async (app, body = {}) => (attached(app)
    ? reply(await fileops.saveAs(app, body.path, body.body, { encoding: body.encoding || 'utf8', overwrite: Boolean(body.overwrite) }))
    : noProject()),
  'POST /api/files/search': (app, body = {}) => (attached(app) ? reply(fileops.search(app, body)) : noProject()),
  'POST /api/files/replace': async (app, body = {}) => (attached(app) ? reply(await fileops.replace(app, body)) : noProject()),

  /** SYNTAX CHECK of one saved file — the same checker a model's edit gets. */
  'POST /api/files/check': async (app, body = {}) => {
    if (!attached(app)) return noProject();
    const at = require('./source').locate(app, body.path);
    if (!at.ok) return bad(at.why);
    const r = await require('../diagnostics').checkFile(at.abs);
    return ok({ path: at.rel, clean: Boolean(r.ok), inconclusive: Boolean(r.inconclusive), line: r.line || null, message: r.ok ? '' : String(r.message || r.why || r.error || 'syntax error') });
  },

  /** GO TO DEFINITION for any language: the project index's declarations first (projectindex.js), then the model search tool's own declaration pattern… */
  'POST /api/ide/definition': (app, body = {}) => {
    if (!attached(app)) return noProject();
    const name = String(body.name || '').trim();
    if (!/^[A-Za-z_$][\w$]{0,80}$/.test(name)) return ok({ name, locations: [] });
    const root = app.session.cwd;
    const out = [];
    try {
      const pi = require('../projectindex');
      for (const d of pi.definitionsOf(pi.load(root), name).slice(0, 20)) out.push({ path: d.file, line: d.line || 1, kind: d.kind || null, via: 'index' });
    } catch { /* the scan below still answers */ }
    if (!out.length) {
      const { walk, looksBinary, defineRe } = require('../tools/search');
      const re = defineRe(name);
      for (const f of walk(root)) {
        let buf;
        try { buf = fs.readFileSync(f.abs); } catch { continue; }
        if (buf.length > 2_000_000 || looksBinary(buf)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) out.push({ path: f.rel, line: i + 1, via: 'pattern' });
          if (out.length >= 20) break;
        }
        if (out.length >= 20) break;
      }
    }
    return ok({ name, locations: out });
  },

  /** WHICH PROJECT FILES A FILE'S RELATIVE IMPORTS NAME — so the editor's TypeScript service can see them. */
  'POST /api/ide/resolve': (app, body = {}) => {
    if (!attached(app)) return noProject();
    const src = require('./source');
    const from = src.locate(app, body.from);
    if (!from.ok) return bad(from.why);
    const dir = path.posix.dirname(from.rel === '.' ? '' : from.rel);
    const exts = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];
    const out = [];
    for (const spec of (Array.isArray(body.specs) ? body.specs : []).slice(0, 30)) {
      const s = String(spec || '');
      if (!s.startsWith('./') && !s.startsWith('../')) continue;
      const base = path.posix.normalize(path.posix.join(dir, s.replace(/\.js$/, '')));
      for (const e of [...exts, '.js']) {
        const cand = e === '.js' && s.endsWith('.js') ? path.posix.normalize(path.posix.join(dir, s)) : base + e;
        const at = src.locate(app, cand);
        if (!at.ok) continue;
        try { if (fs.statSync(at.abs).isFile()) { out.push({ spec: s, path: at.rel }); break; } } catch { /* next candidate */ }
      }
    }
    return ok({ files: out });
  },

  // ------------------------------------------------------------ git --
  'POST /api/git/status': async (app) => (attached(app) ? reply(await gitops.status(app)) : noProject()),
  'POST /api/git/diff': async (app, body = {}) => (attached(app) ? reply(await gitops.diff(app, body.path, { staged: Boolean(body.staged) })) : noProject()),
  'POST /api/git/show': async (app, body = {}) => (attached(app) ? reply(await gitops.show(app, body.path, { ref: body.ref === ':' ? ':' : 'HEAD' })) : noProject()),
  'POST /api/git/stage': async (app, body = {}) => (attached(app) ? reply(await gitops.stage(app, body.paths)) : noProject()),
  'POST /api/git/unstage': async (app, body = {}) => (attached(app) ? reply(await gitops.unstage(app, body.paths)) : noProject()),
  'POST /api/git/commit': async (app, body = {}) => (attached(app) ? reply(await gitops.commit(app, body.message)) : noProject()),
  'POST /api/git/branches': async (app) => (attached(app) ? reply(await gitops.branches(app)) : noProject()),
  'POST /api/git/checkout': async (app, body = {}) => (attached(app) ? reply(await gitops.checkout(app, body.branch)) : noProject()),

  /** THE EDITOR'S REPORT — what is in front of the person. In memory only. */
  'POST /api/ide/context': (app, body = {}) => {
    const r = require('../idecontext').record(app.session, body);
    // THE HARNESS CONTEXT (harnesscontext.js): surface, selection range, dirty
    // buffers and recent actions, with a generation — Core's state for "this".
    if (r) { try { require('../harnesscontext').fromIde(app, app.session, body); } catch { /* context only */ } }
    return ok({ at: r ? r.at : null });
  },

  /** THE PROJECT'S OWN .vscode FOLDER, read and never written: settings, recommended extensions, launch configurations and tasks. */
  'POST /api/workspace/vscode': (app) => {
    if (!attached(app)) return noProject();
    const dir = path.join(app.session.cwd, '.vscode');
    if (!fs.existsSync(dir)) return ok({ present: false });
    const settings = readJsonc(path.join(dir, 'settings.json'));
    const ext = readJsonc(path.join(dir, 'extensions.json'));
    const launch = readJsonc(path.join(dir, 'launch.json'));
    const tasks = readJsonc(path.join(dir, 'tasks.json'));
    return ok({
      present: true,
      settings: settings && !settings.unreadable ? settings : null,
      recommendations: ext && Array.isArray(ext.recommendations) ? ext.recommendations.map(String).slice(0, 100) : [],
      launch: launch && Array.isArray(launch.configurations) ? launch.configurations.map((c) => ({ name: String(c.name || ''), type: String(c.type || ''), request: String(c.request || '') })).slice(0, 50) : [],
      tasks: tasks && Array.isArray(tasks.tasks) ? tasks.tasks.map((t) => ({ label: String(t.label || t.taskName || ''), type: String(t.type || ''), command: typeof t.command === 'string' ? t.command.slice(0, 300) : '' })).slice(0, 50) : [],
      unreadable: [settings, ext, launch, tasks].some((x) => x && x.unreadable),
    });
  },
};

module.exports = { ROUTES, readJsonc, stripJsonc };
