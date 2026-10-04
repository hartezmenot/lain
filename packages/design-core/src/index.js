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

function open(root, opts = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return new ReadOnlyProject(abs, `${abs} is not a folder`);
  const best = detect(abs)[0];
  if (!best) return new ReadOnlyProject(abs, 'Design edits plain HTML/CSS/JS, React with Vite, and Android (Jetpack Compose / XML) projects — this one is none of those, so it is shown read-only');
  const Ctor = adapters().find((a) => a.kind === best.kind).mod();
  return new Ctor(abs, { snapshotsDir: opts.snapshotsDir || path.join(abs, '.lain', 'design', 'snapshots'), write: opts.write || null });
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
    this.project.onCommit = () => { if (this.preview) { try { this.preview.reload(); } catch { /* reload is a courtesy */ } } };
  }

  get kind() { return this.project.kind; }

  /** Start (once) the preview server for this project: { url }. */
  async startPreview() {
    if (this.preview) return this.preview;
    if (this.project.readOnly) throw new Error(this.project.why);
    if (!this._previewing) {
      this._previewing = (async () => {
        if (this.kind === 'web-react') return require('./react').startVite(this.root);
        if (this.kind === 'web-html') return require('./server').start(this.root);
        if (this.kind === 'android') return require('./android').startPreview(this.project);
        throw new Error(`no preview for ${this.kind}`);
      })();
    }
    try { this.preview = await this._previewing; } finally { this._previewing = null; }
    return this.preview;
  }

  /** The URL of a screen in the preview. */
  async screenUrl(screen) {
    const p = await this.startPreview();
    const s = this.project.scanScreens().find((x) => x.file === screen || x.id === screen) || this.project.scanScreens()[0];
    return `${p.url}${s ? s.route : '/'}`;
  }

  /** The headless page (own browser, no window), on a screen. */
  async page(screen, device = null) {
    if (!this.headless) this.headless = await new (require('./headless').Headless)().launch(device || {});
    else if (device) await this.headless.viewport(device);
    const url = await this.screenUrl(screen);
    const cur = await this.headless.page.eval('location.href').catch(() => '');
    if (cur !== url || this._dirty) { await this.headless.goto(url); this._dirty = false; }
    return this.headless;
  }

  /** Measured layout of one node, on the screen it belongs to (what a move needs). */
  async layout(node, screen = null) {
    const at = this.project.locate(node);
    if (!at) return null;
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
    if (this.relay && this.relay.attached()) return this.relay.run({ screen, steps, device, screenshots });
    const h = await this.page(screen, device);
    return require('./headless').runSteps(h, steps, { screenshots });
  }

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
  VERSION, open, detect, Design, ReadOnlyProject,
  get tools() { return require('./tools'); },
  get animations() { return require('./animations'); },
  get snap() { return require('./snap'); },
  get layout() { return require('./layout'); },
  get runtime() { return require('./runtime'); },
  get flow() { return require('./flow'); },
  get context() { return require('./context'); },
};
