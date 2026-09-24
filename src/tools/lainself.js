'use strict';

/**
 * LAIN, DESCRIBING ITSELF — so the BOT can answer questions about the
 * workspace from the same state the window draws.
 *
 * "Which model is my coding agent using?", "what percentage is my Claude
 * account at?", "where are the MCP settings?" are questions about LAIN, not
 * about the project, and the only honest answer is a READ of the owners the
 * window already reads: modelinventory for the roles, usagewindows for what a
 * provider said about usage, availability for rate limits, mcp.js for the
 * servers, the bot config for the channels. harnessapp/accounts.js is the one
 * projection; this tool renders it as text.
 *
 * `open` asks the window to show a view. It is NAVIGATION, recorded on the
 * shared root App as `_uiNavigate` and applied once by the window — it runs
 * nothing, changes no setting and grants nothing, which is why the tool does
 * not mutate and is allowed in the Chat view.
 */

const SURFACES = Object.freeze({
  home: 'Home',
  ide: 'IDE',
  chat: 'Chat',
  bot: 'Bot',
  model: 'Model',
  session: 'Session',
  settings: 'Settings',
});

/** Where each thing a person might look for lives in the window. */
const MAP = Object.freeze([
  ['model providers, accounts, quota and usage', 'model', 'providers'],
  ['which model the BOT and the Coding Agent use', 'model', 'roles'],
  ['MCP servers', 'settings', 'mcp'],
  ['skills', 'settings', 'skills'],
  ['Telegram, Discord and WhatsApp connections', 'bot', 'connections'],
  ['who may message the bot (allowlist)', 'bot', 'permissions'],
  ['notifications', 'settings', 'notifications'],
  ['trusted folders and privacy', 'settings', 'privacy'],
  ['paths, default project folder, Node.js', 'settings', 'paths'],
  ['previous work and sessions', 'session', null],
  ['opening or creating a project', 'ide', null],
]);

function pct(n) { return `${Math.round(n)}%`; }

function when(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  const m = Math.round(d / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

function usageLine(u) {
  if (!u) return 'usage: not reported by this provider yet (no rate-limit headers seen on a response this run)';
  const h = u.headline;
  const age = Math.max(0, Math.round((Date.now() - u.at) / 60000));
  const bits = (u.windows || []).map((w) => `${w.label}${w.percent != null ? ` ${pct(w.percent)} used` : ''}${w.resetAt ? `, resets ${when(w.resetAt)}` : ''}`);
  return `usage: ${h ? `${pct(h.percent)} of the ${h.label} window` : 'reported without a percentage'} (${bits.join('; ')}) — read ${age} min ago from the provider's own headers`;
}

async function describe(app, topic) {
  const a = await require('../harnessapp/accounts').read(app);
  const out = [];
  const want = (t) => !topic || topic === 'all' || topic === t;
  if (want('models') || want('quota')) {
    const r = a.roles;
    out.push('MODEL ROLES');
    out.push(`  BOT (conversation): ${r.bot.source === 'lain' ? (r.bot.modelId || 'LAIN default') : `${r.bot.source}${r.bot.modelId ? ` · ${r.bot.modelId}` : ''}`} (${r.bot.scope === 'session' ? 'this session' : 'default'})`);
    out.push(`  Coding Agent: ${r.coding.modelId || 'not set'} (${r.coding.scope === 'session' ? 'this session' : 'default'})`);
    for (const role of ['chat', 'coding']) {
      const u = a.usage && a.usage[role];
      if (!u) continue;
      out.push(`  ${role === 'chat' ? 'BOT' : 'Coding Agent'} route ${u.connectionId || '(not resolved yet)'} — ${usageLine(u.reading)}`);
      if (u.availability && u.availability.rateLimited) out.push(`    RATE LIMITED${u.availability.resumeAt ? `, clears ${when(u.availability.resumeAt)}` : ''}: ${u.availability.reason}`);
    }
  }
  if (want('providers') || want('quota')) {
    out.push('PROVIDERS');
    if (!a.providers.length) out.push('  none configured');
    for (const p of a.providers) {
      for (const c of p.connections) {
        out.push(`  ${p.label} · ${c.id} (${c.via}, ${c.auth}) readiness ${c.readiness}, ${c.modelCount} model(s)${c.availability && c.availability.rateLimited ? ', RATE LIMITED' : ''}`);
        out.push(`    ${usageLine(c.usage)}`);
      }
    }
    for (const s of a.sources.filter((x) => x.kind === 'WEB')) out.push(`  website account ${s.label}: ${s.state}${s.why ? ` — ${s.why}` : ''}`);
  }
  if (want('mcp')) {
    out.push('MCP SERVERS (Settings › MCP)');
    for (const s of require('../harnessapp/workspaceroutes').mcpServers(app)) {
      out.push(`  ${s.name}${s.builtIn ? ' (built in)' : ''}: ${s.state}${s.tools.length ? `, ${s.tools.length} tools` : ''}${s.why ? ` — ${s.why}` : ''}`);
    }
  }
  if (want('bot')) {
    const cfg = ((app._sibling || app).cfg) || {};
    const plats = (cfg.bot && cfg.bot.platforms) || {};
    out.push('BOT CHANNELS (Bot › Connections)');
    const rows = Object.entries(plats).filter(([, v]) => v && typeof v === 'object');
    if (!rows.length) out.push('  none configured');
    for (const [name, v] of rows) out.push(`  ${name}: ${v.enabled ? 'enabled' : 'not enabled'}, ${(v.allowUsers || []).length} approved user(s)`);
    out.push('  (live connection state is read in the Bot view)');
  }
  if (want('where') || !topic || topic === 'all') {
    out.push('WHERE THINGS ARE IN THE WINDOW');
    for (const [what, s, sec] of MAP) out.push(`  ${what}: ${SURFACES[s]}${sec ? ` › ${sec}` : ''}`);
  }
  return out.join('\n');
}

const tools = {
  lain_workspace: {
    mutates: false,
    schema: {
      name: 'lain_workspace',
      description:
        'Questions about LAIN ITSELF, answered from its live state: which model the BOT and the Coding Agent '
        + 'use, provider accounts and how much quota/usage each has reported, rate limits, MCP servers, bot '
        + 'channels, and where a setting lives in the LAIN window. action "describe" reads (topic: models, '
        + 'quota, providers, mcp, bot, where, all). action "open" shows a view in the LAIN window (surface: '
        + 'home, ide, chat, bot, model, session, settings; optional section such as mcp, skills, providers, '
        + 'connections) — navigation only, it changes nothing. Never guess a percentage: if the tool says a '
        + 'provider has not reported usage, say that.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['describe', 'open'] },
          topic: { type: 'string', enum: ['models', 'quota', 'providers', 'mcp', 'bot', 'where', 'all'] },
          surface: { type: 'string', enum: Object.keys(SURFACES) },
          section: { type: 'string', description: 'a part of that view, e.g. mcp, skills, providers, connections' },
        },
        required: ['action'],
      },
    },
    async run(input, ctx) {
      const app = ctx && ctx.app;
      if (!app) return { output: 'LAIN state is not available in this run', isError: true };
      const action = String((input && input.action) || 'describe');
      if (action === 'open') {
        const surface = String((input && input.surface) || '').toLowerCase();
        if (!SURFACES[surface]) return { output: `unknown surface "${surface}" — one of ${Object.keys(SURFACES).join(', ')}`, isError: true };
        const section = input && input.section ? String(input.section).toLowerCase().slice(0, 40) : null;
        const root = app._sibling || app;
        const prev = root._uiNavigate;
        root._uiNavigate = { seq: (prev && prev.seq ? prev.seq : 0) + 1, surface, section, at: Date.now() };
        let windows = 0;
        try { windows = require('../harnessapp/ipc').status().clients; } catch { windows = 0; }
        return { output: windows ? `Opened ${SURFACES[surface]}${section ? ` › ${section}` : ''} in the LAIN window.` : `No LAIN window is open; ${SURFACES[surface]}${section ? ` › ${section}` : ''} will show when it is.` };
      }
      const topic = input && input.topic ? String(input.topic) : 'all';
      try { return { output: await describe(app, topic) }; } catch (e) { return { output: `could not read LAIN state: ${(e && e.message) || e}`, isError: true }; }
    },
  },
};

module.exports = { tools, describe, SURFACES };
