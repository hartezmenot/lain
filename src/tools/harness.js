'use strict';

/** THE HARNESS TOOLS — what the model can ask the harness to do. */

const { EVENT, busOf } = require('../events');

/** Bounded, because a tool result rides in the context window. */
const MAX_OUTPUT = 6000;
/** A receipt page is bounded by rows (observationstore.SHOW), not cut mid-row at 6,000 chars. */
const RECEIPT_OUTPUT = 20000;

function harnessOf(ctx) {
  const app = ctx && ctx.app;
  if (app) return require('../harnesslink').harnessFor(app);
  // NO APP IS NOT AN ERROR.
  const { Harness } = require('../harness');
  if (!ctx._harness) ctx._harness = new Harness({ workspace: (ctx && ctx.cwd) || process.cwd(), persist: false });
  return ctx._harness;
}

function clip(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n… (truncated; the whole thing is kept as an artifact)` : t;
}

const tools = {};

tools.service_start = {
  mutates: true,
  schema: {
    name: 'service_start',
    description:
      'Start a long-running service — a dev server, an API, a worker — that STAYS UP and is owned by '
      + 'this task. Unlike run_bash it does not wait for the command to finish (a server never '
      + 'finishes) and unlike run_background it is not a job with a result: it has a port, a health '
      + 'check, restartable state, and it is stopped automatically when the session ends. Use this '
      + 'for anything you then want to point a browser or an HTTP check at.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'a short name you will refer to it by, e.g. "frontend"' },
        command: { type: 'string', description: 'the command line, e.g. "npm run dev"' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        port: { type: 'number', description: 'the port it will listen on — this is how health is checked' },
        wait_ms: { type: 'number', description: 'wait up to this long for it to become healthy before returning; default 15000, 0 to return at once' },
      },
      required: ['name', 'command'],
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const name = String(input.name || '').trim();
    const command = String(input.command || '').trim();
    if (!name || !command) return { output: 'service_start needs a name and a command', isError: true };
    const taskId = h.runtime.activeId;
    const already = h.processes.named(taskId, name);
    if (already && already.alive) {
      return { output: `a service called "${name}" is already running (pid ${already.pid}${already.port ? `, port ${already.port}` : ''}). Use service_check, or stop it first.`, isError: true };
    }
    const p = h.processes.start({
      taskId, name, command, cwd: input.cwd || ctx.cwd, port: input.port == null ? null : Number(input.port),
    });
    busOf(ctx.app).emit(EVENT.PROCESS_STARTED, { processId: p.processId, name, port: p.port == null ? -1 : p.port });
    const waitMs = input.wait_ms == null ? 15000 : Number(input.wait_ms);
    if (waitMs > 0) {
      const health = await h.processes.waitUntilHealthy(p.processId, waitMs);
      const tail = p.tail(12);
      return {
        output: `${name} (${p.processId}) — ${p.status}, ${health.health}: ${health.why}`
          + (tail ? `\n--- last output ---\n${clip(tail)}` : ''),
        isError: health.health === 'UNHEALTHY',
        meta: { processId: p.processId, pid: p.pid, port: p.port, status: p.status, health: health.health },
      };
    }
    return {
      output: `${name} (${p.processId}) started, pid ${p.pid}. Nothing has checked whether it is up yet — call service_check.`,
      meta: { processId: p.processId, pid: p.pid, port: p.port, status: p.status },
    };
  },
};

tools.service_check = {
  mutates: false,
  schema: {
    name: 'service_check',
    description:
      'Is a managed service actually up, and what has it printed? Probes its port or URL now, and can '
      + 'WAIT until it answers rather than guessing with a sleep. With no name it lists every service '
      + 'this task owns. A service with no health check configured reports UNKNOWN — never HEALTHY, '
      + 'because nothing looked.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the service name given to service_start; omit to list all' },
        wait_ms: { type: 'number', description: 'wait up to this long for it to become healthy; default 0 (one probe, now)' },
        lines: { type: 'number', description: 'how many lines of its output to include; default 20' },
      },
    },
  },
  async run(input, ctx) {
    const h = harnessOf(ctx);
    const taskId = h.runtime.activeId;
    if (!input.name) {
      const all = h.processes.list(taskId);
      if (!all.length) return { output: 'no managed services are running for this task' };
      return { output: all.map((p) => { const j = p.toJSON(); return `${j.name}  ${j.status}  ${j.health}  ${j.port ? `port ${j.port}` : ''}  ${j.healthWhy}`; }).join('\n') };
    }
    const p = h.processes.named(taskId, String(input.name));
    if (!p) return { output: `no managed service called "${input.name}" — service_check with no name lists them`, isError: true };
    const waitMs = Number(input.wait_ms) || 0;
    const r = waitMs > 0 ? await h.processes.waitUntilHealthy(p.processId, waitMs) : await h.processes.check(p.processId);
    const tail = p.tail(Number(input.lines) || 20);
    return {
      output: `${p.name} — ${p.status}, ${r.health}: ${r.why}` + (tail ? `\n--- last output ---\n${clip(tail)}` : ''),
      isError: r.health === 'UNHEALTHY',
      meta: { processId: p.processId, status: p.status, health: r.health, port: p.port },
    };
  },
};

tools.observe = {
  mutates: false,
  schema: {
    name: 'observe',
    description:
      'Find out what is actually true, without deciding HOW to look. State the goal — element, page, '
      + 'errors, requests, screen, file, code, changes, process, logs, endpoint, system — and the '
      + 'router picks the cheapest source that can answer it, structured before visual: the DOM '
      + 'before a screenshot, git before reading files. It reports which source answered, and says '
      + 'plainly when nothing could. Prefer this over taking a screenshot to read something a page '
      + 'already knows.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'element | page | errors | requests | screen | file | code | changes | process | logs | endpoint | system' },
        selector: { type: 'string', description: 'for element/page — a CSS selector' },
        url: { type: 'string', description: 'for element/page/endpoint — where to look' },
        path: { type: 'string', description: 'for file/code — which file' },
        name: { type: 'string', description: 'for process/logs — the managed service name' },
        lines: { type: 'number', description: 'for logs — how many lines' },
        receipt: { type: 'string', description: 'an observation receipt (obs_…): answer page/element/requests/errors/system from that captured live observation instead of looking again' },
        ref: { type: 'string', description: 'with receipt, for element — one node by its ref (e.g. "n42"): the node, its path and its children' },
        query: { type: 'string', description: 'with receipt, for element — words to match against node roles, names, text, ids and classes' },
        offset: { type: 'number', description: 'with receipt, for page — the node to start the page at' },
      },
      required: ['goal'],
    },
  },
  async run(input, ctx) {
    const goal = String(input.goal || '').toLowerCase();
    // A CAPTURED OBSERVATION answers from its receipt (observationstore.js):
    // the same state every time, every node reachable by ref, reads measured.
    if (input.receipt) {
      const session = (ctx && ctx.session) || (ctx && ctx.app && ctx.app.session) || null;
      const r = require('../observationstore').answer(goal, input, session);
      if (!r.ok) return { output: `nothing could answer "${goal}": ${r.why}`, isError: true, meta: { goal, ok: false } };
      const v = String(r.value);
      return { output: `[${r.source}] ${r.summary}\n${v.length > RECEIPT_OUTPUT ? `${v.slice(0, RECEIPT_OUTPUT)}…` : v}`, meta: { goal, source: r.source, receipt: input.receipt } };
    }
    const h = harnessOf(ctx);
    const r = await h.observe(goal, input, h.runtime.activeId);
    if (!r.ok) {
      return {
        output: `nothing could answer "${goal}": ${r.why}`
          + (r.tried && r.tried.length ? `\ntried: ${r.tried.map((t) => t.source).join(', ')}` : ''),
        isError: true,
        meta: { goal, ok: false },
      };
    }
    return {
      output: `[${r.source}] ${r.summary}\n${clip(r.value)}`,
      meta: { goal, source: r.source, coarse: r.coarse },
    };
  },
};

module.exports = { tools, MAX_OUTPUT };
