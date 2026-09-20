'use strict';

/**
 * `computer` — the structured desktop, as the model sees it.
 *
 * ONE NAME FOR THE MACHINE. This replaces the coordinate-only vocabulary while
 * Computer MCP is connected (tools/index.js chooses); the model is never
 * offered two ways to press the same button.
 *
 * THE SHAPE OF THE VOCABULARY IS THE SAFETY ARGUMENT:
 *
 *   observations   windows, window, ui_tree, find, read, screenshot, displays,
 *                  cursor — all reads, all structured except the screenshot
 *   actions        focus_window, click_control, type_into, key, type, click,
 *                  scroll, drag, close_window, clipboard_read/write
 *   sequence       batch — bounded, and it stops the moment the screen stops
 *                  matching what the next step assumed
 *
 * EVERY ACTION TAKES `expect`, and an action without one comes back
 * INCONCLUSIVE. That is the point: Windows accepting a click is not evidence
 * that anything happened, and this tool will not let a model report that it is.
 */

const cm = require('../computermcp');

/** What a target may name. A window TITLE is never an identity on its own. */
const TARGET = {
  type: 'object',
  description: 'which control: `window` (title) or `pid` or `handle` to scope it, then `name` '
    + '(accessible name), `automationId`, `controlType` (Button, Edit, Document, MenuItem, …). '
    + 'An ambiguous window OR CONTROL is REFUSED with the candidates listed rather than guessed '
    + 'at — `controlType` alone is rarely an identity (a shell file dialog holds forty-one Edits, '
    + 'one of them the file name box), so name it, or pass `index` to say which.',
  properties: {
    window: { type: 'string' }, pid: { type: 'number' }, handle: { type: 'number' },
    name: { type: 'string' }, automationId: { type: 'string' }, controlType: { type: 'string' },
    exact: { type: 'boolean', description: 'match `name` exactly rather than by substring' },
    index: { type: 'number', description: 'which of several matches, when they are genuinely alike' },
  },
};

const EXPECT = {
  type: 'object',
  description: 'WHAT MUST BECOME TRUE for this to have worked. Without it the result is '
    + 'INCONCLUSIVE — a delivered input is not a result. One of: `window` (a window with this '
    + 'title exists), `control` (a target that must appear), `value` (a target plus `contains`), '
    + '`gone` (a target or window that must disappear), `foreground` (this window is in front).',
  properties: {
    window: { type: 'string' },
    foreground: { type: 'string' },
    control: TARGET,
    gone: TARGET,
    value: { type: 'object', description: 'a TARGET plus `contains`: the text it must then hold' },
  },
};

const OBSERVE = ['windows', 'window', 'displays', 'ui_tree', 'find', 'read', 'screenshot', 'cursor', 'status'];
const ACT = ['focus_window', 'click_control', 'type_into', 'focus_control', 'key', 'type', 'click',
  'scroll', 'drag', 'close_window', 'clipboard_read', 'clipboard_write', 'open_app', 'wait', 'batch'];

const schema = {
  name: 'computer',
  description:
    'Use this computer through its ACCESSIBILITY TREE: list windows, read a window\'s controls by '
    + 'name and type, press them, and type into them. '
    + `Observations: ${OBSERVE.join(', ')}. Actions: ${ACT.join(', ')}. `
    + 'PREFER STRUCTURE OVER PIXELS: `find`/`click_control`/`type_into` name a control the way a '
    + 'person would ("the Save button"), and can be verified afterwards; `click` at an x,y cannot. '
    + 'Take a screenshot when a PERSON needs to see something, not to locate a control. '
    + 'EVERY ACTION SHOULD CARRY `expect`: what must be true afterwards. Without it the verdict is '
    + 'INCONCLUSIVE, because the operating system accepting input proves nothing. '
    + 'A WINDOW TITLE IS NOT AN IDENTITY — two windows can share one, and an ambiguous target is '
    + 'refused rather than guessed; aim by `pid` or `handle` when you started the application. '
    + 'There is no OCR and no access to process memory.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: OBSERVE.concat(ACT), description: 'what to do' },
      target: TARGET,
      expect: EXPECT,
      start: { ...EXPECT, description: 'a precondition checked BEFORE acting; a mismatch means nothing is done' },
      text: { type: 'string', description: 'for type_into, type and clipboard_write' },
      append: { type: 'boolean', description: 'for type_into: add to what is there instead of replacing it' },
      key: { type: 'string', description: 'for key: one key, e.g. "enter" or "f5"' },
      keys: { type: 'array', items: { type: 'string' }, description: 'for key: a chord, e.g. ["ctrl","shift","s"]' },
      x: { type: 'number' }, y: { type: 'number' },
      fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' },
      button: { type: 'string', description: 'left | right | middle' },
      count: { type: 'number', description: 'click count: 2 for a double click' },
      clicks: { type: 'number', description: 'for scroll: negative scrolls down' },
      command: { type: 'string', description: 'for open_app: the executable, e.g. "notepad.exe"' },
      args: { type: 'array', items: { type: 'string' }, description: 'for open_app' },
      depth: { type: 'number', description: 'for ui_tree (default 3)' },
      maxNodes: { type: 'number', description: 'for ui_tree (default 300)' },
      timeoutMs: { type: 'number', description: 'how long an expectation may take to come true' },
      steps: {
        type: 'array',
        description: 'for batch: up to 20 of these same specs, run in order. It STOPS at the first '
          + 'step whose expectation fails — the screen is not where the next step assumed.',
        items: { type: 'object' },
      },
      continueUnverified: { type: 'boolean', description: 'for batch: carry on past steps that have no `expect` (default false)' },
      why: { type: 'string', description: 'one short sentence the USER will read explaining why' },
    },
    required: ['op'],
  },
};

function lines(title, rows) { return [title, ...rows].join('\n'); }

function describeWindow(w) {
  if (!w) return '(none)';
  return `"${w.title}" · ${w.process || '?'} pid ${w.pid} · ${w.rect.width}×${w.rect.height} at ${w.rect.x},${w.rect.y}`
    + `${w.foreground ? ' · IN FRONT' : ''}${w.minimized ? ' · minimized' : ''} · handle ${w.handle}`;
}

function describeElement(e, indent = '') {
  if (!e) return '';
  const bits = [`${indent}${e.controlType}`];
  if (e.name) bits.push(JSON.stringify(String(e.name).slice(0, 60)));
  if (e.automationId) bits.push(`#${e.automationId}`);
  if (e.rect) bits.push(`${e.rect.width}×${e.rect.height} at ${e.rect.x},${e.rect.y}`);
  if (e.value) bits.push(`= ${JSON.stringify(String(e.value).slice(0, 60))}`);
  if (!e.enabled) bits.push('disabled');
  if (e.offscreen) bits.push('offscreen');
  return bits.join('  ');
}

function treeLines(node, depth, out) {
  if (!node || out.length > 200) return out;
  out.push(describeElement(node, '  '.repeat(depth)));
  for (const kid of node.children || []) treeLines(kid, depth + 1, out);
  return out;
}

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const c = cm.existing(app);
  const op = String((input && input.op) || '');
  if (!c || !c.connected) {
    return { output: 'Computer MCP is not connected. The user runs `/mcp computer` to connect and authorize it; it cannot be started from here.', isError: true };
  }
  if (!c.authorized && op !== 'status') {
    return { output: 'the computer is not authorized for this session — the user runs `/mcp computer`. Nothing was attempted.', isError: true };
  }
  const target = (input && input.target) || {};

  try {
    switch (op) {
      case 'status': {
        const s = c.status();
        return { output: lines('COMPUTER MCP', [
          `connected: ${s.connected}`, `authorized: ${s.authorized}`,
          `operations: ${s.capabilities.join(', ') || 'none'}`,
        ]), meta: { computer: op } };
      }
      case 'displays': {
        const r = await c.displays();
        if (!r.ok) return { output: r.why, isError: true };
        return { output: lines('DISPLAYS', r.result.displays.map((d) => `${d.name}${d.primary ? ' (primary)' : ''}  ${d.bounds.width}×${d.bounds.height} at ${d.bounds.x},${d.bounds.y}`)), meta: { computer: op } };
      }
      case 'windows': {
        const r = await c.windows();
        if (!r.ok) return { output: r.why, isError: true };
        const rows = (r.result.windows || []).map((w) => `  ${describeWindow(w)}`);
        return { output: lines(`WINDOWS (${rows.length})`, rows), meta: { computer: op } };
      }
      case 'window': {
        const r = await c.active();
        if (!r.ok) return { output: r.why, isError: true };
        return { output: `IN FRONT: ${describeWindow(r.result.window)}`, meta: { computer: op } };
      }
      case 'cursor': {
        const r = await c.call('cursor.get');
        return r.ok ? { output: `cursor at ${r.result.x},${r.result.y}`, meta: { computer: op } } : { output: r.why, isError: true };
      }
      case 'ui_tree': {
        const r = await c.tree({ ...target, depth: input.depth, maxNodes: input.maxNodes });
        if (!r.ok) return { output: r.why, isError: true };
        const rows = treeLines(r.result.tree, 0, []);
        return {
          output: lines(`UI TREE · ${r.result.nodes} node(s)${r.result.truncated ? ' (truncated)' : ''}`, rows).slice(0, 20000),
          meta: { computer: op },
        };
      }
      case 'find': {
        const r = await c.find(target);
        if (!r.ok) return { output: r.why, isError: true };
        const rows = (r.result.matches || []).map((m) => `  ${describeElement(m)}`);
        if (!rows.length) return { output: `nothing matches ${cm.describeTarget(target)}`, isError: true, meta: { computer: op } };
        return { output: lines(`MATCHES (${r.result.count})`, rows).slice(0, 20000), meta: { computer: op } };
      }
      case 'read': {
        const r = await c.value(target);
        if (!r.ok) return { output: r.why, isError: true };
        return { output: `${cm.describeTarget(target) || 'it'} reads:\n${String(r.result.value == null ? '' : r.result.value).slice(0, 8000)}`, meta: { computer: op } };
      }
      case 'screenshot': {
        const r = await c.capture(target.window || target.pid || target.handle ? target : {});
        if (!r.ok) return { output: r.why, isError: true };
        // ---- THE PICTURE BECOMES EVIDENCE, NOT A FILE IN A TEMP FOLDER ----
        //
        // The bridge writes the capture to a temporary path. That path is swept
        // eventually, and a verification that rested on it then rests on
        // nothing — so where a task is running, the image is ADOPTED as that
        // task's artifact, and it is offered to LAIN's own window by reference.
        //
        // NEITHER CAN FAIL THE SCREENSHOT. Adoption with no running task, or a
        // full artifact store, still leaves a real picture at a real path.
        let shown = null;
        try {
          const viewer = require('../imageviewer');
          const offered = viewer.offer(app, r.result.path, {
            note: 'computer screenshot',
            provenance: `computer screenshot · region ${r.result.region.width}×${r.result.region.height}`,
          });
          if (offered.ok) shown = offered;
        } catch { /* looking at it is a courtesy; the capture stands either way */ }

        // ---- THE TEMP ORIGINAL GOES ONCE THE EVIDENCE HAS AN OWNER --------
        //
        // create → adopt → reference → clean. Adopted, the artifact copy is the
        // authoritative one: the model is told THAT path, and the capture in
        // %TEMP% is deleted rather than left to accumulate one file per
        // screenshot for the life of the machine. NOT adopted (no running
        // task), the temp file is the only copy there is, so it stays.
        let where = r.result.path;
        const adopted = shown && shown.record && shown.record.artifact;
        if (adopted && shown.record.file && shown.record.file !== r.result.path) {
          where = shown.record.file;
          try { require('fs').unlinkSync(r.result.path); } catch { /* already gone, or held — harmless */ }
        }
        return {
          output: `screenshot: ${where}\nregion ${r.result.region.width}×${r.result.region.height} at ${r.result.region.x},${r.result.region.y}\n`
            + (adopted ? `kept as an artifact of task ${adopted.taskId}\n` : '')
            + 'It is a PICTURE — use `find`/`read` for what a control says.',
          meta: { computer: op, path: where, ref: shown ? shown.ref : '' },
        };
      }
      case 'open_app': {
        const r = await c.openApp(String(input.command || ''), { args: input.args || null, waitTitle: input.text || null });
        if (!r.ok) return { output: r.why, isError: true };
        return {
          output: r.window
            ? `started ${input.command} · pid ${r.pid}\nits window: ${describeWindow(r.window)}\nAim later actions by pid or handle, never by title alone.`
            : `started ${input.command} · pid ${r.pid}\n${r.why} — a single-instance application may have merged into a copy that was already running, and LAIN will not adopt somebody else's window.`,
          isError: !r.window,
          meta: { computer: op, pid: r.pid },
        };
      }
      case 'wait': {
        const got = await c.observe(input.expect || {}, { timeoutMs: input.timeoutMs || 10000 });
        if (got.ok === null) return { output: 'nothing was expected, so nothing was waited for', isError: true };
        return { output: `${got.ok ? 'PASSED' : 'FAILED'} — ${got.why}`, isError: !got.ok, meta: { computer: op, verdict: got.ok ? 'PASSED' : 'FAILED' } };
      }
      case 'batch': {
        // §24/§25 — EVERY STEP IS "THESE SAME SPECS" (the schema's own words),
        // so a step is written with `op`, exactly like a single call. The
        // single-action path below translates `op` -> the internal `action`
        // field before calling `c.act()`; batch must do the same translation
        // for each step, or ComputerMCP.act() reads `spec.action` as undefined
        // and reports "there is no action \"\"" — the exact regression this
        // guards. Malformed or empty steps are rejected HERE, ordered and
        // fail-fast, before any of them reaches the bridge.
        const raw = Array.isArray(input.steps) ? input.steps : [];
        if (!raw.length) return { output: 'batch needs at least one step', isError: true };
        if (raw.length > 20) return { output: `batch takes at most 20 steps, got ${raw.length}`, isError: true };
        const bad = [];
        const steps = raw.map((s, i) => {
          const action = String((s && (s.action || s.op)) || '');
          if (!action) bad.push(`step ${i + 1}: no op given — empty step`);
          // A batch step performs an ACTION, not an observation or a top-level
          // op like `wait`/`open_app`/`batch` that this outer switch owns —
          // see cm.PERFORM_ACTIONS's doc comment for why this is not `ACT`.
          else if (!cm.PERFORM_ACTIONS.has(action)) bad.push(`step ${i + 1}: "${action}" is not a valid batch action`);
          return { ...s, action, target: (s && s.target) || {} };
        });
        if (bad.length) return { output: `batch refused before it ran:\n${bad.join('\n')}`, isError: true };
        const r = await c.batch(steps, { continueUnverified: Boolean(input.continueUnverified) });
        const rows = (r.steps || []).map((s) => `  ${s.step}. ${s.action} — ${s.verdict}: ${s.why}`);
        return {
          output: lines(`BATCH ${r.verdict} — ${r.why}`, rows).slice(0, 20000),
          isError: r.verdict === cm.VERDICT.FAILED,
          meta: { computer: op, verdict: r.verdict },
        };
      }
      default: {
        if (!ACT.includes(op)) return { output: `there is no operation "${op}"`, isError: true };
        const r = await c.act({ ...input, action: op, target });
        const rows = (r.trail || []).map((t) => `  ${t.text}`);
        return {
          output: lines(`${r.verdict} — ${r.why}`, rows).slice(0, 20000),
          isError: r.verdict === cm.VERDICT.FAILED,
          meta: { computer: op, verdict: r.verdict },
        };
      }
    }
  } catch (e) {
    return { output: `computer.${op} failed: ${(e && e.message) || e}`, isError: true, meta: { computer: op } };
  }
}

module.exports = { tools: { computer: { mutates: true, schema, run } }, schema, OBSERVE, ACT };
