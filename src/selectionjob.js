'use strict';

/** SELECTION JOBS — "this" is known, so simple work stays deterministic (2026-09-24). */

const fs = require('fs');
const path = require('path');

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RENAME = /\brename\s+(?:this|it|that)(?:\s+(?:function|variable|symbol|method|class|component|const|identifier))?\s+(?:to|as|into)\s+[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?/i;
const MOVE = /\bmove\s+(?:this|it|that)(?:\s+\w+)?\s+(up|down|left|right)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*px\b/i;

// "change this variable from fixButton to ButtonFix", "rename fixButton to ButtonFix":
// the other ways people say it, parsed HERE so no second parser exists (focuspacket.js reads this).
const RENAME_FROM = /\b(?:rename|change|replace)\b[^.\n]*?\bfrom\s+[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?\s+(?:to|into|->)\s+[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?/i;
// "change this to ButtonFix including…", "rename this ButtonFix", "call it FixButton": the target must END a clause and — unless the verb is "rename"…
const RENAME_THIS = /\b(rename|change|call)\s+(?:this|it|that)(?:\s+(?:name|function|variable|symbol|method|class|component|const|identifier))?\s+(?:(?:to|as|into)\s+)?[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?(?=\s*(?:$|[.,;:!?]|\s+(?:including|and|everywhere|across|throughout|with|in|plus)\b))/i;
const RENAME_NAMED = /\brename\s+[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?\s+(?:to|into|->)\s+[`'"]?([A-Za-z_$][A-Za-z0-9_$]*)[`'"]?/i;

function parse(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  let m = RENAME.exec(s);
  if (m) return { op: 'rename', to: m[1] };
  m = RENAME_FROM.exec(s);
  if (m) return { op: 'rename', from: m[1], to: m[2] };
  m = RENAME_THIS.exec(s);
  if (m && IDENT.test(m[2]) && !/^(to|as|into|this|it|that)$/i.test(m[2]) && (m[1].toLowerCase() === 'rename' || /[A-Z_$0-9]/.test(m[2]))) return { op: 'rename', to: m[2] };
  m = RENAME_NAMED.exec(s);
  if (m && !/^(this|it|that)$/i.test(m[1])) return { op: 'rename', from: m[1], to: m[2] };
  m = MOVE.exec(s);
  if (m) return { op: 'move', dir: m[1].toLowerCase(), px: Number(m[2]), words: m[0].replace(/^move\s+(?:this|it|that)\s*/i, '') };
  return null;
}

/** MAY CORE FINISH THIS SELECTION INPUT ITSELF? */
function routes(app) {
  const r = decide(app);
  try { const d = app.session.dispatch; if (d) d.selection = { direct: Boolean(r.yes), why: r.why || '', kind: r.plan ? (r.plan.kind || 'style') : null }; } catch { /* telemetry only */ }
  return r;
}

function decide(app) {
  const session = app.session;
  const d = session.dispatch;
  const ref = d && d.referent;
  const op = parse(pendingText(app));
  if (!ref || !op) {
    // "make this 10% smaller" with a Workshop node: the geometry arithmetic on the node's binding.
    if (ref && ref.kind === 'visual' && d.geometry && d.geometry.explicit) return scalePlan(app, ref, d.geometry);
    return { yes: false, why: 'not a bounded operation on the selection' };
  }
  if (op.op === 'rename') {
    if (ref.kind !== 'text') return { yes: false, why: 'rename needs a code selection' };
    const from = String(ref.head || '').trim();
    if (!IDENT.test(from) || from === op.to) return { yes: false, why: 'the selection is not one identifier' };
    const root = session.cwd;
    const renameMod = require('./rename');
    const dry = renameMod.scan(root, from, op.to);
    const clash = renameMod.scan(root, op.to, `${op.to}_`);
    const dirty = [dry.textOnly.length && `${dry.textOnly.length} string/comment/unsupported-file site(s)`, dry.memberOnly.length && `${dry.memberOnly.length} member access(es)`,
      dry.truncated && 'the scan was truncated', !dry.changed.length && `no identifier ${from} in the project`,
      clash.sites && `${op.to} is already used (${clash.sites} site(s))`].filter(Boolean);
    if (dirty.length) return { yes: false, why: `rename ${from} → ${op.to} needs judgement: ${dirty.join(', ')}` };
    return { yes: true, plan: { kind: 'rename', from, to: op.to, files: dry.changed.length, sites: dry.sites, run: runRename } };
  }
  if (op.op === 'move') return ref.kind === 'visual' ? movePlan(app, ref, op) : { yes: false, why: 'move needs a visual selection' };
  return { yes: false, why: 'no deterministic owner' };
}

/** The input being routed: identify.js has not pushed it to messages yet, the dispatch saw it. */
function pendingText(app) { const d = app.session.dispatch; return (d && d.text) || lastUser(app.session); }

function lastUser(session) {
  const m = (session.messages || []).slice().reverse().find((x) => x.role === 'user' && typeof x.content === 'string');
  return m ? m.content : '';
}

// ---- GUG edits ------------------------------------------------------------------------

function nodeOf(app, ref) {
  const g = require('./gug').get(app, app.session.cwd);
  if (!g || !ref.gugId) return { why: 'the selection is not mapped to a GUG node' };
  if (ref.gugGeneration != null && g.generation !== ref.gugGeneration) return { why: 'the page was re-measured since the selection — select it again' };
  const n = g.nodes.get(ref.gugId);
  if (!n) return { why: `${ref.gugId} is not in the current GUG` };
  if (g.stale[n.id]) return { why: `its source (${g.stale[n.id]}) changed since the page was measured` };
  if (!n.binding || n.binding.confidence !== 'EXACT') return { why: `${n.id} has no single stylesheet binding (${(n.binding && n.binding.confidence) || 'UNKNOWN'})` };
  return { g, n };
}

/** One px declaration in the bound rule, replaced on its own line — or why not. */
function editDecl(root, b, prop, next) {
  const d = b.props.find((x) => x.prop === prop);
  if (!d) return null;
  const file = path.join(root, b.file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { why: `${b.file} could not be read` }; }
  const line = text.split(/\r?\n/)[d.line - 1] || '';
  const m = new RegExp(`(${prop}\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)px`).exec(line);
  if (!m) return { why: `${b.file}:${d.line} ${prop} is not a px value` };
  const value = Number(m[2]);
  const nextValue = typeof next === 'function' ? next(value) : next;
  const newText = line.replace(m[0], `${m[1]}${Math.round(nextValue * 100) / 100}px`);
  if (text.split(line).length !== 2) return { why: `the declaration at ${b.file}:${d.line} is not unique in its file` };
  return { edit: { line: d.line, text: line, newText, changes: [{ prop, value, next: Math.round(nextValue * 100) / 100 }] } };
}

function asGeometry(app, n, g, words, delta) {
  const d = app.session.dispatch;
  d.geometry = { ...(d.geometry || {}), type: 'GEOMETRY_JOB', target: n.id, requested_delta: { ...delta, words }, explicit: true, constraints: [], gug: { id: n.id, generation: g.generation } };
  d.geometry.binding = { file: n.binding.file, name: n.binding.selector, kind: 'rule' };
}

function movePlan(app, ref, op) {
  const r = nodeOf(app, ref);
  if (!r.n) return { yes: false, why: r.why };
  const { g, n } = r;
  const b = n.binding;
  const vertical = op.dir === 'up' || op.dir === 'down';
  const sign = op.dir === 'down' || op.dir === 'right' ? 1 : -1;
  const positioned = /^(?:relative|absolute|fixed|sticky)$/.test(String(n.style.position || ''));
  const order = vertical ? (positioned ? ['top', 'margin-top'] : ['margin-top', 'top']) : (positioned ? ['left', 'margin-left'] : ['margin-left', 'left']);
  const have = order.filter((p) => b.props.some((x) => x.prop === p));
  if (!have.length) return { yes: false, why: `${b.file}:${b.line} ${b.selector} sets no ${order.join(' / ')} in px — where it should move is a layout choice` };
  const e = editDecl(app.session.cwd, b, have[0], (v) => v + sign * op.px);
  if (!e || !e.edit) return { yes: false, why: (e && e.why) || 'no editable declaration' };
  asGeometry(app, n, g, op.words, { kind: 'px', px: sign * op.px });
  return { yes: true, plan: { binding: { file: b.file, name: b.selector, kind: 'rule' }, edits: [e.edit] } };
}

function scalePlan(app, ref, job) {
  const r = nodeOf(app, ref);
  if (!r.n) return { yes: false, why: r.why };
  const { g, n } = r;
  const b = n.binding;
  const props = job.dimension === 'both' ? ['width', 'height'] : [job.dimension];
  const edits = [];
  for (const p of props) {
    const e = editDecl(app.session.cwd, b, p, (v) => require('./geometryjob').solveValue(v, job.requested_delta));
    if (e && e.why) return { yes: false, why: e.why };
    if (e && e.edit) edits.push(e.edit);
  }
  if (!edits.length) return { yes: false, why: `${b.selector} sets no ${props.join('/')} in px` };
  // Two declarations on one line are one edit (a one-line rule).
  const byLine = new Map();
  for (const e of edits) byLine.has(e.line) ? byLine.get(e.line).push(e) : byLine.set(e.line, [e]);
  const merged = [...byLine.values()].map((es) => {
    const changes = es.flatMap((e) => e.changes);
    let t = es[0].text;
    for (const c of changes) t = t.replace(new RegExp(`(${c.prop}\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)px`), `$1${c.next}px`);
    return { line: es[0].line, text: es[0].text, newText: t, changes };
  });
  asGeometry(app, n, g, job.requested_delta.words, job.requested_delta);
  return { yes: true, plan: { binding: { file: b.file, name: b.selector, kind: 'rule' }, edits: merged } };
}

// ---- the AST rename ---------------------------------------------------------------------

/** THE DIRECT RENAME. `routes` already found the dry run clean (a dirty one went to the flagship). Applied through the gated `rename_symbol` tool and… */
async function* runRename(app, text, verdict, { from = null, typed = false, plan = null } = {}) {
  const session = app.session;
  const { newRecord } = require('./turnrecord');
  const turnclose = require('./turnclose');
  const record = newRecord(session.id, text, null);
  record.from = from || null; record.typed = Boolean(typed); record.lane = 'core'; record.owner = 'deterministic:rename';
  session.messages.push({ role: 'user', content: String(text), ts: new Date().toISOString() });
  const r0 = plan || {};
  const renameMod = require('./rename');
  const root = session.cwd;
  const dry = { changed: [], sites: r0.sites || 0 };
  const dirty = [];
  let reply;
  let verified = false;
  {
    const tools = require('./tools');
    const ctx = { app, session, cwd: root, turnId: record.turnId, signal: app.abort ? app.abort.signal : null, actor: 'CORE', what: `rename ${r0.from} → ${r0.to}` };
    const input = { from: r0.from, to: r0.to };
    const id = `core-${record.turnId}-0`;
    yield { type: 'tool_start', id, name: 'rename_symbol', input };
    const r = await tools.execute('rename_symbol', input, ctx);
    record.toolCalls += 1; record.toolNames.push('rename_symbol');
    record.actions.push({ name: 'rename_symbol', target: r0.from, ok: !r.isError, ms: 0 });
    for (const m of r.mutated || []) record.mutations = [...(record.mutations || []), m];
    yield { type: 'tool_result', id, name: 'rename_symbol', input, output: r.output, isError: Boolean(r.isError), meta: r.meta || null };
    const after = renameMod.scan(root, r0.from, `${r0.from}_`);
    verified = !r.isError && after.sites === 0;
    reply = r.isError ? `The rename was refused: ${String(r.output).split('\n')[0]}`
      : [`Renamed ${r0.from} → ${r0.to} across ${r0.files} file(s), ${r0.sites} identifier site(s).`,
        verified ? `Verified: no identifier named ${r0.from} remains.` : `Not verified: ${after.sites} site(s) still name ${r0.from} — please check.`,
        'Resolved from your selection by the token-based rename; no model was asked.'].join('\n');
    dry.changed = r.mutated || [];
  }
  try { require('./dispatch').job(session, { worker: 'CORE', role: 'selection_rename', contract: 'deterministic', mode: 'DETERMINISTIC', consumed: !dirty.length, why: 'clean dry run', target: r0.from, solution: r0.to, verified }); } catch { /* telemetry only */ }
  record.text = reply; record.narration.push({ step: 0, text: reply, at: Date.now() }); record.stopReason = 'end'; record.verified = verified;
  session.messages.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
  yield { type: 'text', chunk: reply };
  turnclose.close(session, session.lifecycle || null, record);
  yield { type: 'done', record };
}

module.exports = { parse, routes, runRename, RENAME, MOVE };
