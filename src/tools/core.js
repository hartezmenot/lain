'use strict';

/**
 * THE FIXED TOOL SET (Simplify S2) — what a simple-mode session is described, unchanged for its whole life:
 *
 *   read_file grep glob list_dir edit_file write_file apply_patch   files (their own modules)
 *   shell                one command tool; the shell is this host's (execution.js), `background` makes it a job
 *   job_status job_stop  the jobs `shell { background }` started
 *   web_fetch ask_user   the web, the person
 *   todo_write           the model's own checklist — optional, shown to the person, never a gate
 *   Agent                a fresh-context helper that returns its final message (S6 completes it)
 *   Skill                one installed skill's instructions
 *   tool_search          every other capability — LAIN's deferred tools, skills, MCP tools — by name or need
 *   call_tool            runs what tool_search found, through the same door and gates as any tool
 *
 * Computer Control and the Preview join the set when the person enabled them (tools/index.js).
 */

const path = require('path');

const FILE_TOOLS = ['read_file', 'grep', 'glob', 'list_dir', 'edit_file', 'write_file', 'apply_patch'];
const CORE = [...FILE_TOOLS, 'shell', 'job_status', 'job_stop', 'web_fetch', 'ask_user', 'todo_write', 'exit_plan', 'memory', 'Agent', 'Skill', 'tool_search', 'call_tool'];
/** Never reachable in simple mode, not even through call_tool: ceremony, judges, and what Agent replaces. */
const RETIRED = new Set(['request_completion', 'task_contract', 'verify_task', 'plan_write', 'plan_findings', 'plan_step_done', 'report_finding',
  'delegate', 'integrate_candidate', 'ab_compare', 'request_computer', 'request_browser', 'migration_plan', 'migration_verify', 'migration_activate',
  'run_bash', 'run_powershell', 'run_cmd', 'run_background', 'job_wait', 'hand_to_coding_agent', 'search_capabilities', 'use_skill', 'mcp_call']);
/** What an `explore` agent may use: reading and searching. */
const READ_ONLY = new Set(['read_file', 'grep', 'glob', 'list_dir', 'web_fetch', 'Skill', 'tool_search', 'call_tool', 'job_status']);

let shellLabel = null;
function hostShell() {
  if (process.platform !== 'win32') return 'bash';
  return 'powershell';
}
function shellDescription() {
  if (shellLabel) return shellLabel;
  let ps = 'PowerShell';
  try { if (require('../execution').powerShellIsLegacy()) ps = 'Windows PowerShell 5.1 (no `&&`/`||` — use `;` or `if ($?)`)'; } catch { /* plain label */ }
  const here = process.platform === 'win32' ? ps : 'bash';
  shellLabel = `Run a command in ${here}${process.platform === 'win32' ? ' (or set `shell` to "bash" or "cmd")' : ''}. Returns output and exit code; a failure says what kind of failure it was. `
    + 'Use `cwd` instead of `cd`. `background: true` starts it as a job and returns at once — its result arrives in this session by itself when it ends.';
  return shellLabel;
}

function legacy() { return require('./index'); }

const tools = {
  shell: {
    mutates: true,
    get schema() {
      return {
        name: 'shell', description: shellDescription(),
        parameters: { type: 'object', properties: {
          command: { type: 'string' }, description: { type: 'string', description: 'a few words for the person on what this does' }, cwd: { type: 'string', description: 'directory to run in (default: the project)' },
          timeout_ms: { type: 'number' }, background: { type: 'boolean' },
          shell: { type: 'string', enum: ['powershell', 'bash', 'cmd'], description: 'optional; default is this host\'s' },
        }, required: ['command'] },
      };
    },
    async run(input = {}, ctx) {
      const which = ['powershell', 'bash', 'cmd'].includes(input.shell) ? input.shell : hostShell();
      if (input.background) return require('./jobs').tools.run_background.run({ command: input.command, shell: which, cwd: input.cwd, timeout_ms: input.timeout_ms, description: input.description }, ctx);
      return require('./shell').tools[`run_${which}`].run({ command: input.command, cwd: input.cwd, timeout_ms: input.timeout_ms }, ctx);
    },
  },

  todo_write: {
    mutates: false,
    schema: {
      name: 'todo_write',
      description: 'Your checklist for work with several steps (optional — skip it for small tasks). Send the WHOLE list each time; the person sees it. Nothing checks it for you.',
      parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: {
        content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'] } } }, required: ['todos'] },
    },
    async run(input = {}, ctx) {
      const session = (ctx && ctx.session) || (ctx && ctx.app && ctx.app.session);
      if (!session) return { output: 'no session to keep a list in', isError: true };
      const { Plan, STATUS } = require('../plan');
      const todos = (Array.isArray(input.todos) ? input.todos : []).map((t) => ({ content: String((t && t.content) || '').trim().slice(0, 300), status: String((t && t.status) || 'pending') })).filter((t) => t.content).slice(0, 50);
      const plan = new Plan('');
      plan.steps = todos.map((t, i) => ({ id: `td${i + 1}`, n: i + 1, text: t.content, status: t.status === 'completed' ? STATUS.DONE : t.status === 'in_progress' ? STATUS.ACTIVE : STATUS.TODO, note: '', completedAt: null, origin: 'model' }));
      session.plan = plan;
      session.todos = todos;
      const done = todos.filter((t) => t.status === 'completed').length;
      return { output: `${todos.length} item(s), ${done} completed`, meta: { todos: todos.length, completed: done } };
    },
  },

  memory: {
    mutates: false,
    schema: {
      name: 'memory',
      description: 'Project memory that later sessions see. save: one durable fact (a decision, a convention, where something lives) when the person asks you to remember it or you learn something lasting. forget: remove one by name.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['save', 'forget'] }, name: { type: 'string', description: 'short kebab-case name' }, fact: { type: 'string', description: 'the fact, for save' } }, required: ['action', 'name'] },
    },
    run(input = {}, ctx) {
      const session = (ctx && ctx.session) || (ctx && ctx.app && ctx.app.session);
      const m = require('../memdir');
      const r = input.action === 'forget' ? m.forget(session.cwd, input.name) : m.save(session.cwd, input.name, input.fact);
      return r.ok ? { output: input.action === 'forget' ? `forgot ${input.name}` : `saved ${r.name} — later sessions will see it` } : { output: r.why, isError: true };
    },
  },

  exit_plan: {
    mutates: false,
    schema: {
      name: 'exit_plan',
      description: 'In Plan mode: present your plan (markdown, with a checklist of steps) for the person to approve, edit or send back. On approval the mode changes and your todo list is seeded from the checklist. Outside Plan mode it does nothing.',
      parameters: { type: 'object', properties: { plan: { type: 'string', description: 'the plan, in markdown' } }, required: ['plan'] },
    },
    run(input = {}, ctx) { return require('../planmode').exitPlan(input, ctx); },
  },

  Skill: {
    mutates: false,
    schema: {
      name: 'Skill',
      description: 'Load an installed skill\'s instructions by name (tool_search lists them) and follow them. A scout skill runs in its own read-only agent and returns its result.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, request: { type: 'string', description: 'what to apply it to' } }, required: ['name'] },
    },
    run: (input, ctx) => require('./capreg').tools.use_skill.run(input, ctx),
  },

  tool_search: {
    mutates: false,
    schema: {
      name: 'tool_search',
      description: 'Find capabilities beyond the tools above — more file operations, code intelligence, tests, processes, services, downloads, skills and MCP tools — by what you need ("rename a symbol", "run the tests"). `select` returns a tool\'s full description and input schema. Run what you find with call_tool.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, select: { type: 'string', description: 'a tool name (or "server/tool" for MCP)' } } },
    },
    async run(input = {}, ctx) {
      const app = ctx && ctx.app;
      if (input.select) {
        const sel = String(input.select);
        if (sel.includes('/')) return require('./capreg').tools.search_capabilities.run({ detail: sel }, ctx);
        const t = deferred(app)[sel];
        if (!t) return { output: `no deferred tool "${sel}" — tool_search { query } lists them`, isError: true };
        return { output: `${sel} — ${t.schema.description}\ninput schema: ${JSON.stringify(t.schema.parameters || {})}\nRun it with call_tool {"name":"${sel}","arguments":{…}}.` };
      }
      const words = String(input.query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const rows = Object.entries(deferred(app)).map(([n, t]) => {
        const hay = `${n} ${t.schema.description}`.toLowerCase();
        return { n, d: String(t.schema.description).split(/(?<=\.)\s/)[0].slice(0, 160), s: words.length ? words.reduce((k, w) => k + (n.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) : 1 };
      }).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 15);
      const lines = rows.length ? ['TOOLS (select one for its schema, then call_tool)', ...rows.map((r) => `  ${r.n} — ${r.d}`)] : [];
      const rest = await require('./capreg').tools.search_capabilities.run({ query: input.query || '' }, ctx);
      if (!/^nothing installed matches/.test(rest.output)) lines.push(rest.output);
      return { output: lines.length ? lines.join('\n') : `nothing matches "${input.query || ''}"` };
    },
  },

  call_tool: {
    mutates: true,
    schema: {
      name: 'call_tool',
      description: 'Run a tool found with tool_search: a LAIN tool by name, or an MCP tool as "server/tool". The same permissions apply as to any tool.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
    },
    async run(input = {}, ctx) {
      const name = String(input.name || '');
      const args = input.arguments && typeof input.arguments === 'object' ? input.arguments : {};
      if (name.includes('/')) { const [server, tool] = name.split('/'); return require('../mcpreg').call(ctx && ctx.app, server, tool, args, { ctx }); }
      if (CORE.includes(name)) return legacy().execute(name, args, ctx);
      if (RETIRED.has(name) || !deferred(ctx && ctx.app)[name]) return { output: `no tool "${name}" — tool_search lists what exists`, isError: true };
      return legacy().execute(name, args, ctx, { deferred: true });
    },
  },

  Agent: {
    mutates: true,
    schema: {
      name: 'Agent',
      description: 'Hand a self-contained piece of work to a helper with a fresh context. It sees only your prompt (and the project rules), works with its own tools, and returns its final message. type "explore": read-only, for searching and answering questions about the code; type "general": can also edit and run commands; or a type from .lain/agents. Several Agent calls in one response run together; background: true returns at once and the result arrives later. Write a complete prompt — it knows nothing of this conversation.',
      parameters: { type: 'object', properties: { description: { type: 'string', description: '3–5 words, shown to the person' }, prompt: { type: 'string' }, type: { type: 'string', description: 'explore | general | a custom type' }, background: { type: 'boolean' } }, required: ['description', 'prompt'] },
    },
    run: (input, ctx) => require('../agentrun').run(input, ctx),
  },
};

/** Every tool tool_search can find and call_tool can run: the full registry minus the core and the retired. */
function deferred(app) {
  const all = legacy().legacyActive(app);
  const out = {};
  for (const [n, t] of Object.entries(all)) if (!CORE.includes(n) && !RETIRED.has(n) && !/^mcp__|^computer|^preview$/.test(n)) out[n] = t;
  // THE ACCESSIBILITY TREE (find, click_control, type_into…) is `computer_ui`, found with tool_search while Computer Control is on.
  if (all.computer && require('../computercontrol').enabled(app)) { const ui = require('./computermcp').tools.computer; out.computer_ui = { ...ui, schema: { ...ui.schema, name: 'computer_ui' } }; }
  return out;
}

module.exports = { tools, CORE, FILE_TOOLS, RETIRED, READ_ONLY, deferred, hostShell };
