'use strict';

/**
 * LAIN DESIGN — THE ENGINE. Loaded only by a Design session, a /api/design route or a test; LAIN Core never requires
 * it otherwise (src/design.js is the one door, and it checks the package is installed first).
 *
 *   open(root)        the project's adapter (React/Vite, plain web, Android) — or a READ-ONLY handle that says why
 *   Design            one project's live state: the adapter, its preview (started on demand), the headless driver
 *   tools             the five design_* tools (tools.js), run against a Design
 */

const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;

function adapters() {
  return [
    { kind: 'web-react', mod: () => require('./react').ReactProject },
    { kind: 'web-html', mod: () => require('./web').WebProject },
    { kind: 'android', mod: () => require('./android').AndroidProject },
  ];
}

/** Which adapter fits, best first: [{ kind, score }]. */
function detect(root) {
  const out = [];
  for (const a of adapters()) { let s = 0; try { s = a.mod().detect(root); } catch { s = 0; } if (s > 0) out.push({ kind: a.kind, score: s }); }
  return out.sort((x, y) => y.score - x.score);
}

/** A project nothing here can edit: Design shows it, read-only, and says why. */
class ReadOnlyProject {
  constructor(root, why) { this.root = root; this.kind = 'unsupported'; this.readOnly = true; this.why = why; }
  scanScreens() { return []; }
  scanElements() { return []; }
  scanFlows() { return []; }
  locate() { return null; }
  applyEdit() { return { ok: false, readOnly: true, why: this.why }; }
  commit() { return { ok: false, readOnly: true, why: this.why }; }
  undo() { return { ok: false, why: this.why }; } redo() { return this.undo(); } restore() { return this.undo(); }
  get snapshots() { return { list: () => ({ undo: [], redo: [] }) }; }
}

/** Keep Design's own state out of git without touching a tracked file: .git/info/exclude (repo-local). */
function excludeFromGit(root) {
  try {
    const info = path.join(root, '.git', 'info');
    if (!fs.existsSync(path.join(root, '.git'))) return;
    fs.mkdirSync(info, { recursive: true });
    const f = path.join(info, 'exclude');
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const want = ['.lain/design.json', '.lain/design/'].filter((l) => !cur.split(/\r?\n/).includes(l));
    if (want.length) fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}# LAIN Design's own state (layout, undo, change cards)\n${want.join('\n')}\n`);
  } catch { /* a read-only .git: the files simply show as untracked */ }
}

/**
 * THE PROJECT, AS DESIGN READS IT (D9): the detector says what the frontend is; the adapter follows.
 *   Android (gradle)            → AndroidProject
 *   plain files (root, public/) → WebProject
 *   React + Vite, no router     → ReactProject
 *   any other JS frontend       → AppProject (JSX, Vue, Svelte dialects; router screens; CSS origin by CDP)
 *   nothing runnable            → read-only, with the one-line reason and a "Set launch command" field
 */
function open(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return new ReadOnlyProject(abs, `${abs} is not a folder`);
  const snap = { snapshotsDir: opts.snapshotsDir || path.join(abs, '.lain', 'design', 'snapshots'), write: opts.write || null };
  if (require('./android').AndroidProject.detect(abs) > 0) {
    const p = new (require('./android').AndroidProject)(abs, snap);
    if (!p.layouts().length) return new ReadOnlyProject(abs, 'this Android project has no XML layouts (Jetpack Compose screens are code) — Design edits XML layouts; ask the Agent for Compose changes');
    return p;
  }
  const det = require('./detect').detect(abs);
  if (opts.launch && opts.launch.cmd) det.launch = { ...(det.launch || { cwd: abs, env: { ...require('./detect').QUIET_ENV } }), cmd: opts.launch.cmd, scriptLine: opts.launch.cmd, port: Number(opts.launch.port) || null, static: null, inProcessVite: false, configured: true };
  if (opts.launch && opts.launch.port) det.ports = [Number(opts.launch.port), ...(det.ports || [])];
  let p;
  if (det.framework === 'html') {
    const webRoot = det.launch && det.launch.static && det.launch.static !== '.' ? det.launch.static : (!fs.existsSync(path.join(abs, 'index.html')) && fs.existsSync(path.join(abs, 'public', 'index.html')) ? 'public' : '');
    det.webRoot = webRoot;
    p = new (require('./web').WebProject)(abs, { ...snap, webRoot });
  } else if (det.framework === 'react' && det.bundler === 'vite' && !det.router) p = new (require('./react').ReactProject)(abs, snap);
  else if (det.framework !== 'unknown' && det.launch) p = new (require('./app').AppProject)(abs, { ...snap, detection: det });
  else { const ro = new ReadOnlyProject(abs, `${det.why || 'Design could not tell how to run this project'} — shown read-only; set a launch command to preview it`); ro.needsLaunch = true; ro.detection = det; return ro; }
  p.detection = det;
  return p;
}

/** One project's Design state: the adapter, the preview (lazy), the headless driver (lazy). */
class Design {
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.opts = opts;
    this.project = open(this.root, opts);
    this.preview = null;
    this._previewing = null;
    this.headless = null;
    this.relay = opts.relay || null;   // the Design window, when one is attached: drives its own visible canvas
    excludeFromGit(this.root);
    this.project.onCommit = () => { if (this.preview) { try { this.preview.reload(); } catch { /* reload is a courtesy */ } } };
  }

  get kind() { return this.project.kind; }

  /**
   * THE PREVIEW (D9): attach to the person's running dev server, or start one (launch.js), then serve it through the
   * Design proxy on its own origin (proxy.js) — the one instrumentation path for every framework. { url, why, … }
   */
  async startPreview() {
    if (this.preview) return this.preview;
    if (this.project.readOnly) throw new Error(this.project.why);
    if (!this._previewing) {
      this._previewing = (async () => {
        if (this.kind === 'android') return require('./android').startPreview(this.project);
        const det = this.project.detection || require('./detect').detect(this.root);
        const target = await require('./launch').open(det, { spawnFn: this.opts.spawn || null, timeoutMs: this.opts.launchTimeoutMs || 120000, extraPorts: this.opts.extraPorts || [] });
        if (!target.ok) throw new Error(target.why);
        let px;
        try { px = await require('./proxy').start(target.url, { transformHtml: (pathname, body) => this.transformHtml(pathname, body) }); } catch (e) { await target.close(); throw e; }
        this.recipe = { cmd: det.launch && !det.launch.static ? det.launch.cmd : null, port: target.port, attached: Boolean(target.attached), why: target.why };
        return {
          url: px.url, target: target.url, attached: Boolean(target.attached), why: target.why, proxy: px,
          reload: () => px.reload(),
          close: async () => { const t = (pr) => Promise.race([pr, new Promise((r) => setTimeout(r, 2000))]); await t(px.close()); if (!target.attached) await t(target.close()); },
        };
      })();
    }
    try { this.preview = await this._previewing; } finally { this._previewing = null; }
    return this.preview;
  }

  /** Plain HTML pages get data-lain-id on the way out — only when the page served IS the file on disk (exact). */
  transformHtml(pathname, body) {
    if (this.kind !== 'web-html') return body;
    const webRoot = this.project.webRoot || '';
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    rel = webRoot ? `${webRoot}/${rel}` : rel;
    let src = null; try { src = fs.readFileSync(path.join(this.root, rel), 'utf8'); } catch { return body; }
    if (src !== body) return body;
    return require('./html').instrument(src, rel, { runtime: false });
  }

  /** The URL of a screen in the preview. */
  async screenUrl(screen) {
    const p = await this.startPreview();
    const s = this.project.scanScreens().find((x) => x.file === screen || x.id === screen || x.route === screen) || this.project.scanScreens()[0];
    return `${p.url}${s ? s.route : '/'}`;
  }

  /** The headless page (own browser, no window), on a screen. */
  async page(screen, device = null) {
    if (!this.headless) { this.headless = await new (require('./headless').Headless)().launch(device || {}); await this.signIn(this.headless); }
    else if (device) await this.headless.viewport(device);
    const url = await this.screenUrl(screen);
    const cur = await this.headless.page.eval('location.href').catch(() => '');
    if (cur !== url || this._dirty) { await this.headless.goto(url); this._dirty = false; }
    return this.headless;
  }

  /**
   * AUTH-GATED APPS: the person's own cookie jar (a JSON array of cookies, or a Netscape cookies.txt), a login script
   * (design_interact steps in a JSON file) or a test-mode URL — named in LAIN's settings for this project, read here,
   * never copied into the project or .lain/design.json. One browser profile, so every screen shares the session.
   */
  async signIn(h) {
    const a = this.opts.auth; if (!a) return;
    const pv = await this.startPreview();
    if (a.cookieFile) {
      try {
        const raw = fs.readFileSync(a.cookieFile, 'utf8');
        const host = new URL(pv.url).hostname;
        const list = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => { const c = l.split('\t'); return c.length >= 7 ? { name: c[5], value: c[6], path: c[2] } : null; }).filter(Boolean);
        await h.page.send('Network.enable');
        await h.page.send('Network.setCookies', { cookies: list.map((c) => ({ name: c.name, value: String(c.value), domain: host, path: c.path || '/' })) });
      } catch (e) { this.authWhy = `the cookie jar could not be read: ${e.message}`; }
    }
    if (a.testUrl) { try { await h.goto(new URL(a.testUrl, pv.url).href); } catch { /* the screen loads next */ } }
    if (a.loginScript) {
      try { const steps = JSON.parse(fs.readFileSync(a.loginScript, 'utf8')); await h.goto(`${pv.url}${(steps.start || '/')}`); await require('./headless').runSteps(h, steps.steps || steps, { screenshots: 'none' }); } catch (e) { this.authWhy = `the login script failed: ${e.message}`; }
    }
  }

  /** The device (Android): adb, made once. */
  adb() { if (!this._adb) this._adb = new (require('./android').Adb)(this.opts.adb || {}); return this._adb; }

  /** Measured layout of one node, on the screen it belongs to (what a move needs). */
  async layout(node, screen = null) {
    const at = this.project.locate(node);
    if (!at) return null;
    if (this.kind === 'android') return require('./android').measure(this.adb(), this.project, at);
    const scr = screen || this.screenOf(node, at.screen);
    const h = await this.page(scr);
    return h.page.eval(`window.__lainDesign ? window.__lainDesign.layoutOf(${JSON.stringify(node)}) : null`);
  }

  /** The screen a node shows on: its own file for a page, the first screen that renders its component otherwise. */
  screenOf(node, file) {
    const screens = this.project.scanScreens();
    if (screens.some((s) => s.file === file)) return file;
    for (const s of screens) if (this.project.scanElements(s.file).some((e) => e.id === node)) return s.file;
    return screens[0] ? screens[0].file : null;
  }

  /** Steps against the preview — the attached window's canvas when there is one, else headless. */
  async interact(steps, { screen = null, device = null, screenshots = 'last' } = {}) {
    this.lastSteps = steps;   // what "Run test" replays
    if (this.relay && this.relay.attached() && this.kind !== 'android') return this.relay.run({ screen, steps, device, screenshots });
    if (this.kind === 'android') return require('./android').runSteps(this.adb(), this.project, steps, { screenshots });
    const h = await this.page(screen, device);
    return require('./headless').runSteps(h, steps, { screenshots });
  }

  /** The project's design language (tokens.js), scanned once (and again after a reload of the project). */
  tokens() { if (!this._tokens) this._tokens = new (require('./tokens').Tokens)(this.root); return this._tokens; }
  /** Named screen states (states.js). */
  states() { if (!this._states) this._states = new (require('./states').States)(this.root); return this._states; }
  /** Replay a named state headless: the screen, then its steps; returns the step observations. */
  async replayState(screen, name, { screenshots = 'last' } = {}) {
    const st = this.states().get(screen, name);
    if (!st) return { ok: false, why: `no state "${name}" on ${screen}` };
    const h = await this.page(screen);
    await h.goto(await this.screenUrl(screen));
    const steps = await require('./headless').runSteps(h, st.steps, { screenshots });
    return { ok: steps.every((s) => s.ok), steps };
  }
  /** Screens found by crawling the running app (when no router declares them). */
  async crawl(opts) {
    await this.startPreview();
    const h = await this.page(null);
    const found = await require('./crawl').crawl(h, this.preview.url, opts);
    if (typeof this.project.setScreens === 'function' && !this.project.scanScreens().length) this.project.setScreens(found);
    return found;
  }
  /** The change cards (cards.js). */
  cards() { if (!this._cards) this._cards = new (require('./cards').Cards)(this.root); return this._cards; }
  /** ONE PROVEN EDIT (pipeline.js): map, plan, prove, card. hooks: { commit, undo, actor }. */
  edit(op, hooks) { return require('./pipeline').edit(this, op, hooks); }
  /** The mapping ladder for an element on a screen ({ tier, file, line, node, … }). */
  map(screen, q) { return require('./adopt').mapNode(this, screen, q); }

  /** Commit a computed edit; the next headless look reloads. */
  commit(result, opts) { const r = this.project.commit(result, opts); if (r && r.ok) this._dirty = true; return r; }
  undo() { const r = this.project.undo(); if (r.ok) this._dirty = true; return r; }
  redo() { const r = this.project.redo(); if (r.ok) this._dirty = true; return r; }

  async close() {
    if (this.headless) { this.headless.close(); this.headless = null; }
    if (this.preview) { const p = this.preview; this.preview = null; await p.close(); }
  }
}

module.exports = {
  VERSION, open, detect, Design, ReadOnlyProject, excludeFromGit,
  get tools() { return require('./tools'); },
  get animations() { return require('./animations'); },
  get snap() { return require('./snap'); },
  get layout() { return require('./layout'); },
  get runtime() { return require('./runtime'); },
  get flow() { return require('./flow'); },
  get context() { return require('./context'); },
  get adopt() { return require('./adopt'); },
  get detector() { return require('./detect'); },
};
