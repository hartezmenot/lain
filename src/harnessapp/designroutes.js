'use strict';

/**
 * LAIN DESIGN'S ROUTES (/api/design/*) — what the Design window reads and does. Every route but `status` goes through
 * src/design.js, which loads the engine only when Design is installed; when it is not, each says so and nothing loads.
 * The canvas's edits are the person's (actor USER), committed through the same transaction and stale-edit guard as the
 * tools'. The window never receives an instruction from here — data in, edits and observations out.
 */

const path = require('path');

const ok = (b = {}) => ({ code: 200, body: { ok: true, ...b } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why: String(why || 'refused'), ...extra } });

const DEVICES = Object.freeze([
  { id: 'iphone-15', name: 'iPhone 15', width: 393, height: 852, dpr: 3, mobile: true },
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, dpr: 2, mobile: true },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915, dpr: 2.625, mobile: true },
  { id: 'ipad', name: 'iPad', width: 820, height: 1180, dpr: 2, mobile: true },
  { id: 'desktop', name: 'Desktop', width: 1280, height: 800, dpr: 1, mobile: false },
]);

function design() { return require('../design'); }

/** The Design for the acting session's project, or a refusal. */
function forApp(app, body = {}) {
  const d = design();
  const at = d.installed();
  if (!at.ok) return { refuse: bad(at.why, 409, { notInstalled: true }) };
  if (!d.enabled(app)) return { refuse: bad('LAIN Design is turned off in Settings', 409, { disabled: true }) };
  const root = (app && app.session && app.session.cwd) || null;
  if (!root) return { refuse: bad('no project is attached', 409, { projectRequired: true }) };
  try { return { design: d.forProject(app, root), root }; } catch (e) { return { refuse: bad(e.message, 500) }; }
}

function elementsOf(project, screen) {
  return project.scanElements(screen).map((e) => ({ id: e.id, tag: e.tag, name: e.name, classes: e.classes, text: e.text, parent: e.parent, children: e.children, file: e.file, line: e.line, host: e.host !== false, elementId: e.attrs.id }));
}

const ROUTES = {
  'POST /api/design/status': async (app) => ok({ ...design().status(app), devices: DEVICES, session: app && app.session ? { id: app.session.id, kind: app.session.kind || null } : null }),

  /** OPEN the project in Design: what it is, its screens and flows, the preview's address, the canvas layout. */
  'POST /api/design/open': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const { design: d, root } = f;
    const p = d.project;
    const out = { kind: p.kind, readOnly: Boolean(p.readOnly), why: p.why || null, root, devices: DEVICES, layout: design().sidecar(root).read(), editBlock: design().editBlock(app, root) || null };
    if (p.readOnly) return ok({ ...out, screens: [], flows: [], needsLaunch: Boolean(p.needsLaunch), detection: p.detection ? { framework: p.detection.framework, why: p.detection.why } : null, launch: design().sidecar(root).read().launch || null });
    // THE REACT PREVIEW RUNS THE PROJECT'S OWN VITE CONFIG: only in a trusted project.
    if (p.kind === 'web-react') {
      let lvl = 'TRUSTED';
      try { lvl = require('../trust').levelOf(app.cfg || {}, root); } catch { lvl = 'TRUSTED'; }
      if (lvl !== 'TRUSTED') return ok({ ...out, screens: p.scanScreens(), flows: p.scanFlows(), preview: null, previewWhy: 'the React preview runs this project\'s own Vite config — trust the project first' });
    }
    let preview = null; let previewWhy = null; let attached = false; let how = null;
    try { const pv = await d.startPreview(); preview = pv.url || null; previewWhy = pv.url ? null : (pv.why || null); attached = Boolean(pv.attached); how = pv.why || null; if (d.recipe) design().sidecar(root).write({ recipe: d.recipe }); } catch (e) { previewWhy = e.message; }
    const det = p.detection || null;
    return ok({ ...out, screens: p.scanScreens(), flows: p.scanFlows(), preview, previewWhy, attached, how, detection: det ? { framework: det.framework, bundler: det.bundler, styling: det.styling, router: det.router, plugin: det.plugin, why: det.why } : null, capabilities: { exact: Boolean(det && (det.plugin || det.framework === 'html')), cssOrigin: true }, auth: d.authWhy || null });
  },

  'POST /api/design/screen': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    if (!body.screen) return bad('which screen?');
    try { return ok({ screen: String(body.screen), elements: elementsOf(f.design.project, String(body.screen)) }); } catch (e) { return bad(e.message); }
  },

  /** THE INSPECTOR: one layer's source, declared styles, where a style would go, its wires. */
  'POST /api/design/inspect': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const p = f.design.project;
    const at = p.locate(String(body.node || ''));
    if (!at) return bad('that layer is no longer in the source — the canvas re-reads it', 404, { gone: true });
    const el = at.el;
    const dec = Object.fromEntries(Object.entries(p.declaredFor(at.screen, el)).map(([k, v]) => [k, { value: v.value, where: v.where, cls: v.cls || null, sheet: v.sheet || null }]));
    const plan = p.planStyle(at.screen, el, String(body.prop || 'color'));
    return ok({
      node: el.id, tag: el.tag, elementId: el.attrs.id || null, classes: el.classes, text: el.text, file: el.file || at.screen, line: el.line, col: el.col,
      declared: dec, target: plan, wires: p.scanFlows().filter((w) => w.source.node === el.id),
      uses: Object.fromEntries(el.classes.map((c) => [c, p.classUses(c).length])),
    });
  },

  /** ONE EDIT from the canvas: computed, then (unless it asks a question) committed as the person's. */
  'POST /api/design/edit': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const op = body.op && typeof body.op === 'object' ? { ...body.op } : null;
    if (!op || !op.op) return bad('which edit?');
    if (body.dryRun) { const r = f.design.project.applyEdit(op); return ok({ applied: false, preview: r.ok ? { summary: r.summary, diff: r.diff, files: r.files.map((x) => x.rel) } : null, needs: r.needs || null, why: r.why || null }); }
    // THE PROVEN PIPELINE (design-core pipeline.js): map, plan, write, measure; kept only if the canvas confirms it.
    const block = design().editBlock(app, f.root); if (block) return ok({ applied: false, why: block });
    if (typeof op.device === 'string') op.device = DEVICES.find((x) => x.id === op.device) || null;
    const r = await f.design.edit(op, { commit: (res) => design().commit(app, f.design, res, { actor: 'USER' }), undo: () => design().undoProven(app, f.design), actor: 'person' });
    if (!r.ok) return ok({ applied: false, needs: r.needs || null, why: r.why || null, reverted: Boolean(r.reverted), alternatives: r.alternatives || null, route: r.route || null, tier: r.tier || null, stale: Boolean(r.stale) });
    if (r.noop) return ok({ applied: false, noop: true, why: r.summary });
    return ok({ applied: true, summary: r.summary, diff: r.diff, files: r.files, followId: r.followId || null, wireId: (r.result && r.result.wireId) || null, snapshot: r.snapshot, card: r.card || null, tier: r.tier || null, proof: r.proof || null });
  },

  'POST /api/design/undo': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const block = design().editBlock(app, f.root); if (block) return bad(block, 409);
    const r = body.redo ? f.design.redo() : f.design.undo();
    return r.ok ? ok({ label: r.label, files: r.files }) : ok({ applied: false, why: r.why, stale: Boolean(r.stale) });
  },

  'POST /api/design/snapshots': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    if (body.restore) { const r = f.design.project.restore(String(body.restore)); return r.ok ? ok({ done: r.done }) : ok({ applied: false, why: r.why }); }
    return ok(f.design.project.snapshots.list());
  },

  'POST /api/design/flows': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const A = design().load().animations;
    return ok({ flows: f.design.project.scanFlows(), presets: Object.entries(A.PRESETS).map(([id, v]) => ({ id, label: v.label })), easings: A.EASINGS });
  },

  /** The canvas layout sidecar (screen positions in Flow, device, zoom). */
  'POST /api/design/layout': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const s = design().sidecar(f.root);
    return ok({ layout: body.set ? s.write(body.set) : s.read() });
  },

  /** A DESIGN SESSION for this project (its own kind: core tools + design_*). */
  'POST /api/design/session': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const pool = typeof app.pool === 'function' ? app.pool() : null;
    if (pool && !body.fresh) {
      for (const id of pool.ids()) { const a = pool.live(id); if (a && a.session && a.session.kind === 'design' && path.resolve(a.session.cwd) === path.resolve(f.root)) return ok({ id, existing: true }); }
    }
    const r = design().newSession(app, f.root);
    if (!r.ok) return bad(r.why);
    if (app.ui && app.ui.enabled) app.ui.refresh();
    return ok({ id: r.id });
  },

  /**
   * THE PROMPT BAR: the person's words and their selection, as facts, to the Design session's Agent. The window shows a
   * one-line status; the conversation holds the rest.
   */
  'POST /api/design/prompt': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return bad('nothing was asked');
    const pool = typeof app.pool === 'function' ? app.pool() : null;
    let target = null;
    if (body.target) target = pool && pool.live(String(body.target));
    if (!target && pool) for (const id of pool.ids()) { const a = pool.live(id); if (a && a.session && a.session.kind === 'design' && path.resolve(a.session.cwd) === path.resolve(f.root)) { target = a; break; } }
    if (!target) { const r = design().newSession(app, f.root); if (!r.ok) return bad(r.why); target = r.app || null; }
    if (!target) return bad('no Design session could be opened', 500);
    const device = DEVICES.find((x) => x.id === body.device) || null;
    const text = body.raw ? prompt : design().load().context.pack(f.design, { prompt, node: body.node || null, screen: body.screen || null, device });
    if (target.abort && !target.abort.signal.aborted) { target.queueSteer(text, 'WAIT'); return ok({ accepted: true, steered: true, session: target.session.id }); }
    Promise.resolve(require('./sessionroutes').withPort(target, () => target.handle(text, { from: 'harness-design' }))).catch(() => {});
    return ok({ accepted: true, session: target.session.id });
  },

  /** What the Design session last did, for the prompt bar's one line, diff and test result. */
  // `session` in the body is how dispatch picks the acting session (routes.js `acting`): `app` IS the Design session.
  'POST /api/design/activity': async (app, body = {}) => {
    const a = body.session && app && app.session && app.session.id === String(body.session) ? app : null;
    const s = a ? a.session : null;
    if (!s) return ok({ running: false, calls: [], reply: null });
    const msgs = s.messages || [];
    // A TOOL RESULT names its call by id; the call (on the assistant message) names the tool.
    const nameOf = new Map();
    for (const m of msgs) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) nameOf.set(c.id, c.name);
    const calls = [];
    for (let i = msgs.length - 1; i >= 0 && calls.length < 6; i--) {
      const m = msgs[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Design selection]')) break;
      const name = m.role === 'tool' ? nameOf.get(m.tool_call_id) || '' : '';
      if (/^design_/.test(name)) calls.unshift({ name, text: String(m.content || '').slice(0, 4000) });
    }
    const last = [...msgs].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    return ok({ running: Boolean(a.abort && !a.abort.signal.aborted), calls, reply: last ? String(last.content).slice(0, 600) : null });
  },

  // ---- the window's canvas drives design_interact when it is attached -------------------------------------------
  'POST /api/design/relay/next': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    return ok({ job: f.design.relay ? f.design.relay.take() : null });
  },
  'POST /api/design/relay/done': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    return ok({ taken: Boolean(f.design.relay && f.design.relay.done(String(body.id || ''), Array.isArray(body.steps) ? body.steps : [])) });
  },

  /** RUN TEST without the model: the given steps (or the last ones run) against the headless preview. */
  'POST /api/design/test': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const steps = Array.isArray(body.steps) && body.steps.length ? body.steps.slice(0, 20) : (f.design.lastSteps || []);
    if (!steps.length) return bad('no test steps yet — record some, or let the Agent run design_interact first');
    f.design.lastSteps = steps;
    const device = DEVICES.find((x) => x.id === body.device) || null;
    try {
      const r = await f.design.interact(steps, { screen: body.screen || null, device, screenshots: body.screenshots || 'last' });
      return ok({ steps: r.map((s) => ({ ...s, screenshot: s.screenshot ? `data:image/png;base64,${Buffer.from(s.screenshot).toString('base64')}` : undefined })), passed: r.every((s) => s.ok && !(s.errors || []).length) });
    } catch (e) { return bad(e.message, 500); }
  },
};

// ---- D9: adopting any frontend -----------------------------------------------------------------------------------
Object.assign(ROUTES, {
  /** What the person selected on the canvas, mapped to source with its tier, and how its styles resolve. */
  'POST /api/design/select': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const screen = String(body.screen || ''); const q = String(body.selector || body.node || '');
    if (!q) return bad('which element?');
    try {
      const m = await f.design.map(screen, q);
      const adopt = design().load().adopt;
      const { so } = await adopt.mirror(f.design, screen);
      const sel = m.selector || q;
      const styles = {};
      for (const prop of ['left', 'right', 'top', 'bottom', 'width', 'height', 'color', 'background-color', 'font-size', 'border-radius', 'opacity', 'padding', 'gap']) {
        try { const c = await so.cascade(sel, prop); if (c.winner) { const o = await so.origin(c.winner.styleSheetId, c.winner.range).catch(() => null); styles[prop] = { value: c.winner.value, important: c.winner.important, selector: c.winner.rule.selector, media: c.winner.rule.media, file: o && o.rel, line: o && o.line }; } } catch { /* skip */ }
      }
      const layout = await (await adopt.mirror(f.design, screen)).h.page.eval(`window.__lainDesign.layoutOf(${JSON.stringify(sel)})`).catch(() => null);
      const tokens = f.design.tokens().summary();
      return ok({ mapping: { tier: m.tier, node: m.node || null, file: m.file || null, line: m.line || null, via: m.via || null, count: m.count || 1, component: m.component || null, question: m.question || null, candidates: m.candidates || null }, selector: sel, styles, layout, tokens, offScale: Object.fromEntries(Object.entries(styles).filter(([k, v]) => f.design.tokens().offScale(k, v.value)).map(([k]) => [k, true])) });
    } catch (e) { return bad(e.message, 500); }
  },

  /** "Where is this rendered?" — to the Design session's Agent: the DOM snippet, a screenshot crop and candidate files. */
  'POST /api/design/map-ask': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const screen = String(body.screen || ''); const sel = String(body.selector || '');
    const adopt = design().load().adopt;
    const d = await adopt.describe(f.design, screen, sel).catch(() => null);
    if (!d) return bad('that element is not on the page');
    const { h } = await adopt.mirror(f.design, screen);
    let crop = null;
    try {
      const png = await h.page.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, d.rect.x - 8), y: Math.max(0, d.rect.y - 8), width: Math.max(8, d.rect.w + 16), height: Math.max(8, d.rect.h + 16), scale: 1 } });
      crop = design().saveShot(Buffer.from(png.data, 'base64'), 'map');
    } catch { crop = null; }
    const html = await h.page.eval(`(() => { const e = document.querySelector(${JSON.stringify(d.selector)}); return e ? e.outerHTML.slice(0, 1200) : ''; })()`).catch(() => '');
    const best = require(require('path').join(design().installed().dir, 'src', 'mapper.js')).fuzzy(f.design.project, d, f.design.project.sources ? f.design.project.sources() : []).slice(0, 5).map((c) => `${c.file}:${c.line}`);
    const prompt = [String(body.prompt || 'Where in the source is this element rendered?'), '\u0000', '[Design selection]', `Screen: ${screen}`, `Element: ${d.selector}`, `HTML: ${html}`, crop ? `Screenshot: ${crop}` : null, best.length ? `Candidate files: ${best.join(', ')}` : null, `To record it: design_inspect with map {selector: ${JSON.stringify(d.selector)}, file, line}`].filter(Boolean).join('\n').replace('\u0000', '');
    return ROUTES['POST /api/design/prompt'](app, { ...body, prompt, raw: true });
  },

  /** Set (or clear) the launch command and port Design uses for this project (kept in .lain/design.json). */
  'POST /api/design/launch': async (app, body = {}) => {
    const root = app && app.session && app.session.cwd; if (!root) return bad('no project is attached', 409);
    const d = design();
    d.sidecar(root).write({ launch: body.cmd ? { cmd: String(body.cmd), port: Number(body.port) || null } : null });
    await d.forget(root);
    return ok({ launch: d.sidecar(root).read().launch || null });
  },

  'POST /api/design/states': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const st = f.design.states(); const screen = String(body.screen || '');
    const a = String(body.action || 'list');
    if (a === 'list') return ok({ states: st.list(screen || null) });
    if (a === 'capture') { const r = st.capture(screen, body.name, body.steps); return r.ok ? ok(r) : bad(r.why); }
    if (a === 'delete') return ok(st.remove(screen, String(body.name || '')));
    if (a === 'replay') { const r = await f.design.replayState(screen, String(body.name || ''), { screenshots: 'last' }); return ok({ ...r, steps: (r.steps || []).map((x) => ({ ...x, screenshot: x.screenshot ? `data:image/png;base64,${Buffer.from(x.screenshot).toString('base64')}` : undefined })) }); }
    return bad(`unknown action ${a}`);
  },

  'POST /api/design/crawl': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    try { return ok({ screens: await f.design.crawl({ depth: Math.min(3, Number(body.depth) || 2), max: Math.min(40, Number(body.max) || 20) }) }); } catch (e) { return bad(e.message, 500); }
  },

  'POST /api/design/cards': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const cards = f.design.cards(); const a = String(body.action || 'list');
    if (a === 'list') return ok({ cards: cards.list(Number(body.limit) || 50) });
    const card = cards.get(String(body.id || ''));
    if (!card) return bad('no such card', 404);
    if (a === 'get') return ok({ card });
    if (a === 'image') { const b = cards.image(card.id, String(body.name || 'after.png')); return b ? ok({ data: `data:image/png;base64,${b.toString('base64')}` }) : bad('no image', 404); }
    if (a === 'restore') {
      // UNDO TO THIS CARD: every newer edit is undone, this one stays.
      const list = f.design.project.snapshots.list().undo;   // newest first
      const i = list.findIndex((x) => x.id === card.snapshot);
      if (i < 0) return bad('this card\'s edit is no longer on the undo stack');
      const newer = list.slice(0, i);
      if (!newer.length) return ok({ restored: true, undone: 0 });
      const r = f.design.project.restore(newer[newer.length - 1].id);
      return r.ok ? ok({ restored: true, undone: r.done.length }) : ok({ restored: false, why: r.why });
    }
    if (a === 'comment') {
      const text = String(body.text || '').trim(); if (!text) return bad('nothing was said');
      cards.comment(card.id, text);
      const prompt = [text, '', ...['[Design change card]', `Card: ${card.id} · ${card.actor} · ${card.summary}`, `Files: ${card.files.join(', ')}`, card.diff ? `Diff:\n${card.diff}` : null].filter(Boolean)].join('\n');
      return ROUTES['POST /api/design/prompt'](app, { prompt, raw: true, screen: card.screen, node: card.node });
    }
    return bad(`unknown action ${a}`);
  },

  'POST /api/design/tokens': async (app, body = {}) => {
    const f = forApp(app, body); if (f.refuse) return f.refuse;
    const t = f.design.tokens();
    if (body.snap) return ok({ value: t.snap(String(body.prop || ''), String(body.value || '')), offScale: t.offScale(String(body.prop || ''), String(body.value || '')) });
    return ok({ tokens: t.summary() });
  },

  /** Auth for gated pages: a cookie jar, a login script, or a test URL — PATHS in LAIN's settings, never the project. */
  'POST /api/design/auth': async (app, body = {}) => {
    const root = app && app.session && app.session.cwd; if (!root) return bad('no project is attached', 409);
    const cfg = app.cfg || {};
    cfg.design = { ...(cfg.design || {}), auth: { ...((cfg.design && cfg.design.auth) || {}) } };
    const a = { cookieFile: body.cookieFile ? String(body.cookieFile) : undefined, loginScript: body.loginScript ? String(body.loginScript) : undefined, testUrl: body.testUrl ? String(body.testUrl) : undefined };
    if (!a.cookieFile && !a.loginScript && !a.testUrl) delete cfg.design.auth[require('path').resolve(root)]; else cfg.design.auth[require('path').resolve(root)] = a;
    try { require('../config').save(cfg); } catch { /* kept in memory */ }
    await design().forget(root);
    return ok({ auth: cfg.design.auth[require('path').resolve(root)] || null });
  },
});

const QUIET = ['/api/design/select', '/api/design/tokens', '/api/design/states', '/api/design/cards', '/api/design/status', '/api/design/screen', '/api/design/inspect', '/api/design/flows', '/api/design/snapshots', '/api/design/relay/next', '/api/design/activity', '/api/design/layout'];

module.exports = { ROUTES, QUIET, DEVICES };
