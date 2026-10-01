'use strict';

/**
 * "SAY SOMETHING TO CHANGE…" — the preview's own command surface (Phase 8.1).
 *
 * Not a chat: a visual-edit request, scoped by what the preview shows.
 *
 *   an element is selected   the request targets THAT element and the source
 *                            that owns it (the canonical Selection's
 *                            sourceBinding: component, then style owner) —
 *                            "move this down slightly and make it wider"
 *   nothing is selected      the request targets the page currently in the
 *                            preview (its path) — "make these cards flatter"
 *                            applies to Settings when Settings is showing, not
 *                            to Home because Home is in the same bundle
 *
 * The request becomes a narrow Coding Agent task on the SAME session (the same
 * entry a person's Coding message uses): no new session, no new agent. The
 * detached preview window calls this route too — one Core, one Selection.
 *
 *   POST /api/preview/change { text, selector? }
 *   POST /api/preview/scope  { selector? }   what the request would target (no model call)
 */

const ok = (b = {}) => ({ code: 200, body: { ok: true, ...b } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why: String(why), ...extra } });

/**
 * THE FRAME PREVIEW'S SCOPE: the window already holds what it shows — the element the bridge described and the page
 * the frame is on — so nothing is read back from a browser. The owners are the canonical Selection's.
 */
function frameScope(app, fs, element, pageUrl) {
  let page = null;
  const live = pageUrl || fs.url;
  try { const u = new URL(live); page = { url: live, path: `${u.pathname}${u.hash || ''}` || '/' }; } catch { page = { url: live || null, path: null }; }
  const vp = fs.viewport ? `${fs.viewport.name} ${fs.viewport.w}×${fs.viewport.h}` : null;
  if (!element) return { ok: true, kind: 'page', page, viewport: vp, label: `This page: ${page.path || page.url || 'the current preview'}` };
  let binding = null; let hints = null;
  try { const sel = require('../harnesscontext').selection(app, app.session); binding = sel && sel.kind === 'visual' && sel.visual ? sel.visual.sourceBinding || null : null; } catch { binding = null; }
  try { const h = require('../harnesscontext').of(app.session); hints = h && h.visualSelection ? h.visualSelection.hints || null : null; } catch { hints = null; }
  const owners = [];
  const top = binding && binding.component && binding.component.candidates && binding.component.candidates[0];
  if (top && binding.component.confidence !== 'UNKNOWN') owners.push({ file: top.rel, line: (top.hits && top.hits[0] && top.hits[0].line) || null, role: 'component', confidence: binding.component.confidence });
  if (binding && binding.style && binding.style.file && ['EXACT', 'LIKELY'].includes(binding.style.confidence)) owners.push({ file: binding.style.file, line: binding.style.line || null, role: 'style', confidence: binding.style.confidence, selector: binding.style.selector || null });
  if (hints && hints.file && !owners.some((o) => o.role === 'component')) owners.push({ file: hints.file, line: hints.line || null, role: 'component', confidence: `${hints.framework || 'framework'} dev hint`, selector: hints.component || null });
  const e = element;
  const name = [e.tag, e.id ? `#${e.id}` : '', e.name ? ` "${String(e.name).slice(0, 40)}"` : ''].join('');
  return { ok: true, kind: 'element', page, viewport: vp, element: { selector: e.selector || null, tag: e.tag, id: e.id || null, name: e.name || null, role: e.role || null, rect: e.rect || null }, owners, label: `Selected: ${name}` };
}

async function scope(app, selector) {
  const ws = require('../workshop').forApp(app);
  const cwd = app.session.cwd;
  const obs = ws.observations(cwd);
  if (!obs || !obs.ok) return { ok: false, why: 'the preview is not open — open it first' };
  // THE PAGE ON SCREEN NOW (Phase 8.2): the preview is interactive, so the person may have
  // navigated inside it; its own location is the answer, not the URL it was opened at.
  const live = (typeof ws.pageUrl === 'function' ? await ws.pageUrl(cwd).catch(() => null) : null) || obs.url;
  let page = null;
  try { const u = new URL(live); page = { url: live, path: `${u.pathname}${u.hash || ''}` || '/' }; } catch { page = { url: live || null, path: null }; }
  if (!selector) return { ok: true, kind: 'page', page, viewport: obs.viewport, label: `This page: ${page.path || page.url || 'the current preview'}` };
  let el = null;
  try { el = await ws.element(cwd, String(selector)); } catch { el = null; }
  if (!el || !el.ok || !el.element) return { ok: false, why: 'the selected element is no longer on the page — pick it again, or clear the selection to change this page' };
  let binding = null;
  try { const sel = require('../harnesscontext').selection(app, app.session); binding = sel && sel.kind === 'visual' && sel.visual ? sel.visual.sourceBinding || null : null; } catch { binding = null; }
  const owners = [];
  const top = binding && binding.component && binding.component.candidates && binding.component.candidates[0];
  if (top && binding.component.confidence !== 'UNKNOWN') owners.push({ file: top.rel, line: (top.hits && top.hits[0] && top.hits[0].line) || null, role: 'component', confidence: binding.component.confidence });
  if (binding && binding.style && binding.style.file && ['EXACT', 'LIKELY'].includes(binding.style.confidence)) owners.push({ file: binding.style.file, line: binding.style.line || null, role: 'style', confidence: binding.style.confidence, selector: binding.style.selector || null });
  const e = el.element;
  const name = [e.tag, e.id ? `#${e.id}` : '', e.name ? ` "${String(e.name).slice(0, 40)}"` : ''].join('');
  return { ok: true, kind: 'element', page, viewport: obs.viewport, element: { selector: e.selector || selector, tag: e.tag, id: e.id || null, name: e.name || null, role: e.role || null, rect: e.rect || null }, owners, label: `Selected: ${name}` };
}

function compose(text, sc) {
  const lines = ['VISUAL CHANGE REQUEST from the preview.', '', `Change: ${text}`, ''];
  if (sc.kind === 'element') {
    const e = sc.element;
    lines.push('TARGET — the element I selected in the preview:');
    lines.push(`  selector   ${e.selector}`);
    if (e.role || e.name) lines.push(`  accessible ${[e.role, e.name].filter(Boolean).join(' — ')}`);
    if (e.rect) lines.push(`  box        ${e.rect.w}×${e.rect.h} at ${e.rect.x},${e.rect.y}`);
    if (sc.page && sc.page.path) lines.push(`  on page    ${sc.page.path}`);
    if (sc.owners.length) {
      lines.push('  owned by:');
      for (const o of sc.owners) lines.push(`    ${o.role.padEnd(9)} ${o.file}${o.line ? `:${o.line}` : ''} (${o.confidence}${o.selector ? `, ${o.selector}` : ''})`);
    }
    lines.push('', 'SCOPE: change only what owns this element. Do not restyle other elements or other pages.');
  } else {
    lines.push(`TARGET — the page currently shown in the preview: ${(sc.page && (sc.page.path || sc.page.url)) || 'the current page'}${sc.viewport ? ` (${sc.viewport} viewport)` : ''}.`);
    lines.push('', 'SCOPE: change only this page/view and the components it renders. Shared components used by other pages change only if the request clearly means them; say so if it does.');
  }
  lines.push('After the change the preview reloads; check the result there.');
  return lines.join('\n');
}

/** CAN THIS PROJECT BE PREVIEWED? Answered from the project's files — nothing is started. */
function available(app) {
  const p = require('../sessionviews').project(app.session);
  if (!p.attached || p.missing) return { available: false, why: 'Open a project to preview it.', projectRequired: true };
  const d = require('../workshop/devserver').detect(p.root);
  return d.ok ? { available: true, why: d.why, command: d.command, static: Boolean(d.static), configured: Boolean(d.configured), port: d.declaredPort || null }
    : { available: false, why: 'No preview target detected for this project.', detail: d.why };
}

// (deadline.js: the timer goes with the answer — this runs for every frame and hover while the preview streams)
const within = (p, ms) => require('../deadline').race(p, ms, () => ({ ok: false, why: 'the preview did not answer in time' }));

const ROUTES = {
  // ---- the live, interactive preview (Phase 8.2) --------------------------------------
  'POST /api/preview/available': async (app) => ok(available(app)),
  /** Configure Preview…: the command (and port) that serves this project, kept in the project (.lain/preview.json). */
  'POST /api/preview/configure': async (app, body = {}) => {
    const p = require('../sessionviews').project(app.session);
    if (!p.attached || p.missing) return bad('open a project first', 409);
    // A PROJECT FILE — written by Core, through the transaction (devserver.configure), never here.
    const r = await require('../workshop/devserver').configure(app, p.root, { command: body.command, port: body.port });
    if (!r || r.isError || r.ok === false) return bad((r && (r.why || r.output)) || 'the preview command was not saved', 409);
    return ok({ ...available(app), cleared: Boolean(r.cleared) });
  },
  // ---- THE FRAME PREVIEW (2026-09-30): real frontend in the window, backend dormant --------------------
  'POST /api/preview/start': async (app, body = {}) => {
    const p = require('../sessionviews').project(app.session);
    if (!p.attached || p.missing) return bad('open a project to preview it', 409, { projectRequired: true });
    const a = available(app);
    if (!a.available) return bad(a.why, 409, { detail: a.detail || null, configure: true });
    const r = await require('../deadline').race(require('../workshop').forApp(app).frameOpen(p.root, { taskId: body.taskId || null }), 120000, () => ({ ok: false, why: 'the dev server did not start in time' }));
    return r.ok ? ok({ preview: r }) : bad(r.why, 409, { devServer: r.devServer || null });
  },
  'POST /api/preview/stop': async (app) => ok(await require('../workshop').forApp(app).frameClose(app.session.cwd)),
  'POST /api/preview/state': async (app) => ok({ preview: require('../workshop').forApp(app).frameState(app.session.cwd) }),
  'POST /api/preview/set': async (app, body = {}) => {
    const r = require('../workshop').forApp(app).frameSet(app.session.cwd, { viewport: body.viewport || null, page: typeof body.page === 'string' ? body.page : null });
    return r.ok ? ok({ preview: r }) : bad(r.why, 409);
  },
  'POST /api/preview/capability': async (app, body = {}) => {
    const r = require('../workshop').forApp(app).frameCapability(app.session.cwd, body.name, body.mode);
    return r.ok ? ok(r) : bad(r.why, 409);
  },
  /** A SELECTION FROM THE FRAME: the bridge's element and measurement become the canonical Selection (GUG + sourceBinding). */
  'POST /api/preview/select': async (app, body = {}) => {
    const el = body.element && typeof body.element === 'object' ? body.element : null;
    if (!el) return bad('nothing was selected');
    const hc = require('../harnesscontext');
    let gug = null;
    try { gug = hc.framePicked(app, app.session, el, body.measure || null); } catch (e) { return bad(`the selection could not be mapped: ${e.message}`, 409); }
    let sel = null;
    try { sel = hc.selection(app, app.session); } catch { sel = null; }
    const binding = sel && sel.kind === 'visual' && sel.visual ? sel.visual.sourceBinding || null : null;
    const wsy = require('../workshop').forApp(app);
    const fs = typeof wsy.frameState === 'function' ? wsy.frameState(app.session.cwd) : null;
    const sc = fs ? frameScope(app, fs, el, body.url || null) : null;
    return ok({ gug, binding, selection: sel ? sel.id : null, projectGeneration: sel ? sel.projectGeneration : null, owners: sc && sc.owners ? sc.owners : [], label: sc ? sc.label : null });
  },
  // THE MODEL'S POINTER AND KEYBOARD (workshop/previewinput.js): the open Preview surface long-polls for the next action
  // and answers with what the page's bridge did. Nothing here reaches outside the preview document.
  'POST /api/preview/input/next': async (app, body = {}) => ok({ action: await require('../workshop/previewinput').next(app, { waitMs: Math.min(15000, Number(body.waitMs) || 15000) }) }),
  'POST /api/preview/input/result': async (app, body = {}) => ok({ accepted: require('../workshop/previewinput').result(app, body.id, body.result && typeof body.result === 'object' ? body.result : null) }),
  'POST /api/preview/change': async (app, body = {}) => {
    const text = String(body.text || '').trim();
    if (!text) return bad('say what to change');
    const p = require('../sessionviews').project(app.session);
    if (!p.attached || p.missing) return bad('Coding requires a project directory — attach the project first', 409, { projectRequired: true });
    // THE FRAME PREVIEW says what it shows (element and page); the streamed Workshop is asked.
    const wsx = require('../workshop').forApp(app);
    const fstate = typeof wsx.frameState === 'function' ? wsx.frameState(p.root) : null;
    const s = fstate ? frameScope(app, fstate, body.element && typeof body.element === 'object' ? body.element : null, typeof body.url === 'string' ? body.url : null) : await scope(app, body.selector || null);
    if (!s.ok) return bad(s.why, 409);
    const composed = compose(text, s);
    const r = require('./viewroutes').submit(app, { view: 'coding', text: composed, direct: true, fromPreview: true, classText: text });
    return { code: r.code, body: { ...(r.body || {}), scope: s, sent: composed } };
  },
};

module.exports = { ROUTES, scope, frameScope, compose, available };
