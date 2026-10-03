'use strict';

/**
 * THE CAPABILITY SURFACE, ASKED FOR WHEN NEEDED (Phase CAP, 2026-10-02).
 *
 *   search_capabilities { query, detail? }   skills and MCP tools by name/description — from the index and the MCP
 *                                            catalog, starting nothing; `detail` returns one tool's input schema
 *   use_skill           { name, request? }   one skill's instructions, read now (a `context: scout` skill runs in an
 *                                            isolated read-only SCOUT and only its result comes back)
 *   mcp_call            { server, tool, arguments }   a lazily described MCP tool, under the person's trust
 *
 * REGISTERED ONLY WHEN THERE IS SOMETHING TO FIND (tools/index.js): no skills and no lazy MCP server cost a request
 * nothing at all — three small schemas appear only once something is installed.
 */

function skills() { return require('../skills'); }
function mcp() { return require('../mcpreg'); }

const tools = {
  search_capabilities: {
    mutates: false,
    schema: {
      name: 'search_capabilities',
      description: 'Find installed skills and MCP tools by what they do. Returns names and one-line descriptions; give `detail` ("server/tool" or a skill name) for one entry\'s full description and input schema. Starts nothing.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, detail: { type: 'string' } } },
    },
    async run(input = {}, ctx) {
      const app = ctx && ctx.app;
      if (input.detail) {
        const d = String(input.detail);
        const slash = d.indexOf('/');
        if (slash > 0) {
          const r = mcp().describe(app, d.slice(0, slash), d.slice(slash + 1));
          if (!r) return { output: `no MCP tool ${d}`, isError: true };
          return { output: [`MCP ${r.serverName} › ${r.tool}${r.readOnly ? ' (read-only)' : ''} — ${r.health.state}${r.health.why ? `: ${r.health.why}` : ''}`, r.allowed ? (r.asks ? 'Runs after the person approves it.' : 'Runs without asking.') : 'Not allowed by the person\'s trust setting.', r.description, `input schema: ${JSON.stringify(r.inputSchema)}`, `Call it with mcp_call {"server":"${r.server}","tool":"${r.tool}","arguments":{…}}.`].join('\n') };
        }
        const k = skills().find(app, d, ctx && ctx.session);
        if (!k || k.manualOnly) return { output: `no skill named ${d}`, isError: true };
        return { output: `skill ${k.name} (${k.scope}${k.context === 'scout' ? ', runs as a scout' : ''}): ${k.description}${k.argumentHint ? `\nargument: ${k.argumentHint}` : ''}\nLoad it with use_skill {"name":"${k.name}"}.` };
      }
      const q = String(input.query || '');
      const ks = skills().search(app, q, { session: ctx && ctx.session });
      const m = mcp().search(app, q);
      const lines = [];
      if (ks.length) lines.push('SKILLS', ...ks.map((k) => `  ${k.name} — ${k.description.slice(0, 140)}${k.context === 'scout' ? ' [scout]' : ''}`));
      if (m.hits.length) lines.push('MCP TOOLS (detail "server/tool" for the schema)', ...m.hits.map((h) => `  ${h.server}/${h.tool} — ${h.description}${h.readOnly ? ' (read-only)' : ''}${h.state === 'IDLE' ? ' [starts on first call]' : ''}`));
      const down = m.servers.filter((s) => s.state === 'UNAVAILABLE');
      if (down.length) lines.push('UNAVAILABLE', ...down.map((s) => `  ${s.name}: capability unavailable — ${s.why}`));
      return { output: lines.length ? lines.join('\n') : `nothing installed matches "${q}"` };
    },
  },

  use_skill: {
    mutates: false,
    schema: {
      name: 'use_skill',
      description: 'Load one installed skill\'s instructions (by name, from the Skills list or search_capabilities) and follow them for the current task. A scout skill runs in an isolated read-only scout and returns its result.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, request: { type: 'string', description: 'what to apply it to (a scout skill receives this as its task)' } }, required: ['name'] },
    },
    async run(input = {}, ctx) {
      const app = ctx && ctx.app;
      const k = skills().find(app, input.name, ctx && ctx.session);
      if (!k) return { output: `no skill named "${input.name}" — search_capabilities lists what is installed`, isError: true };
      if (k.manualOnly) return { output: `${k.name} is manual-only: the person runs it with /skill ${k.name}`, isError: true };
      if (k.context === 'scout') return runScout(app, k, String(input.request || ''), ctx);
      const b = skills().body(k);
      if (!b.ok) return { output: b.why, isError: true };
      return { output: [`SKILL ${k.name} (${k.scope}) — follow these instructions:`, b.text, b.files.length ? `\nFiles beside it (${k.dir}): ${b.files.join(', ')}` : ''].join('\n') };
    },
  },

  mcp_call: {
    mutates: false,
    schema: {
      name: 'mcp_call',
      description: 'Call a tool of a connected or installed MCP server (found with search_capabilities). The person\'s trust setting decides whether it runs, asks first, or is refused; a server that cannot start says "capability unavailable".',
      parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'] },
    },
    async run(input = {}, ctx) {
      return mcp().call(ctx && ctx.app, String(input.server || ''), String(input.tool || ''), input.arguments || {}, { ctx });
    },
  },
};

/** A `context: scout` skill: an isolated, read-only SCOUT with the skill as its instructions; only the result returns. */
async function runScout(app, k, request, ctx) {
  const b = skills().body(k);
  if (!b.ok) return { output: b.why, isError: true };
  if (!app || !app.jobs || !app.session) return { output: `${k.name} runs as a scout, and there is no session to run one from here`, isError: true };
  // AN EXPLORE AGENT (agentrun.js) with the skill as its task: read-only, its final message is the result.
  const prompt = `${request || 'Apply this skill to the current task'}\n\nFollow the skill "${k.name}":\n${b.text.slice(0, 12000)}\n\nAnswer with findings, each with the file and line it came from.`;
  const parent = (ctx && ctx.session) || app.session;
  const r = await require('../agentrun').runOne(app, parent, require('../agenttypes').BUILT_IN.explore, prompt, { description: `skill ${k.name}`, signal: ctx && ctx.signal });
  if (!r.ok) return { output: `${k.name} (explore agent) did not finish: ${r.text}`, isError: true };
  return { output: `SKILL RESULT · ${k.name}\n${String(r.text || '').slice(0, 8000)}` };
}

/** Which of these the registry offers right now (tools/index.js). */
function active(app) {
  const out = {};
  let hasSkills = false;
  try { hasSkills = skills().invocable(skills().forApp(app)).length > 0; } catch { hasSkills = false; }
  let lazy = false;
  try { lazy = mcp().lazyActive(app); } catch { lazy = false; }
  if (hasSkills || lazy) out.search_capabilities = tools.search_capabilities;
  if (hasSkills) out.use_skill = tools.use_skill;
  if (lazy) out.mcp_call = tools.mcp_call;
  return out;
}

module.exports = { tools, active, runScout };
