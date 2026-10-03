'use strict';

/** LAIN, DESCRIBING ITSELF — so the BOT can answer questions about the workspace from the same state the window draws. */

const SURFACES = Object.freeze({
  home: 'Home',
  ide: 'IDE',
  chat: 'Chat',
  bot: 'Bot',
  model: 'Model',
  usage: 'Usage',
  session: 'Session',
  settings: 'Settings',
});

/** Where each thing a person might look for lives in the window. */
const MAP = Object.freeze([
  ['accounts (Codex, API keys, websites) and runtimes', 'model', 'instances'],
  ['model providers', 'model', 'providers'],
  ['token usage, cost and provider limits', 'usage', null],
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

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

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
  const bits = (u.windows || []).map((w) => `${w.label}${w.percent != null ? ` ${pct(100 - w.percent)} remaining` : ''}${w.resetAt ? `, resets ${when(w.resetAt)}` : ''}`);
  return `usage: ${h ? `${pct(100 - h.percent)} of the ${h.label} window remaining` : 'reported without a percentage'} (${bits.join('; ')}) — read ${age} min ago from the provider's own headers`;
}

async function describe(app, topic) {
  const a = await require('../harnessapp/accounts').read(app);
  const out = [];
  const want = (t) => !topic || topic === 'all' || topic === t;
  if (want('models') || want('quota')) {
    const r = a.roles;
    out.push('MODEL ROLES');
    // CHAT and the BOT are separate: ChatGPT Chat (the chatgpt.com website session) is CHAT ONLY.
    const ro = require('../modelroles');
    if (r.chat) out.push(`  CHAT view: ${r.chat.source === 'lain' ? `LAIN · ${r.chat.modelId || 'default'}` : `${ro.labelFor(r.chat.source, r.chat.source)} (CHAT ONLY${r.chat.source === ro.CHATGPT_CHAT.source ? `, ${ro.CHATGPT_CHAT.origin}, LAIN alias ${ro.CHATGPT_CHAT.alias} — a LAIN route name, not an OpenAI model id` : ''})`}`);
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
    for (const s of a.sources.filter((x) => x.kind === 'WEB')) out.push(`  website session ${s.label}: ${s.state}${s.why ? ` — ${s.why}` : ''} (a signed-in site, not an API key)`);
  }
  if (want('accounts') || want('quota')) {
    // EACH ACCOUNT ON ITS OWN, as its provider reported it. No credential is
    // read here — there is none to read: this is accountinstances.js's view.
    const maskEmail = (e) => (e ? String(e).replace(/^(.).*(@.*)$/, '$1…$2') : null);
    out.push('ACCOUNTS (Model › Accounts)');
    let rows = [];
    try { rows = require('../accountinstances').list(app); } catch { rows = []; }
    if (!rows.length) out.push('  none');
    for (const v of rows) {
      const who = v.identity ? [maskEmail(v.identity.email), v.identity.planType].filter(Boolean).join(' ') : '';
      out.push(`  ${v.display_name} · ${v.driver_id} · ${v.source_type} · ${v.authentication_state || '—'}${who ? ` · ${who}` : ''}${v.sameIdentityAs ? ` · same sign-in as ${v.sameIdentityAs} (kept separate)` : ''}`);
      const ws = (v.limits && v.limits.windows) || [];
      if (!ws.length) { if (v.source_type === 'runtime') out.push(`    limits: ${v.limits_error || 'not reported'}`); continue; }
      for (const w of ws) {
        const pctUsed = w.usedPercent != null ? w.usedPercent : w.percent;
        const expired = w.expired || (w.resetsAt && Date.now() >= w.resetsAt);
        out.push(`    ${w.label || w.name}: ${expired ? 'reset expected, not yet confirmed' : pctUsed == null ? 'not reported' : pct(100 - pctUsed) + ' remaining'}${w.resetsAt && !expired ? `, resets ${when(w.resetsAt)}` : ''} (provider-reported)`);
      }
    }
    out.push('  Windows are never combined into one figure; nothing switches accounts on its own.');
  }
  if (want('usage')) {
    const usage = require('../usage');
    const rows = usage.read({ from: Date.now() - 7 * 864e5 });
    const t = usage.sum(rows, (app._sibling || app).cfg || {});
    out.push('USAGE, LAST 7 DAYS (Usage)');
    out.push(`  ${t.requests} request(s) · input ${t.input} · output ${t.output} · cache read ${t.cacheRead}${t.reported.tokens < t.requests ? ` · ${t.requests - t.reported.tokens} without a usage report` : ''}`);
    for (const g of usage.aggregate(rows, 'model', {}).slice(0, 6)) out.push(`  ${g.key}: ${g.requests} req, in ${g.input}, out ${g.output}`);
    out.push(`  cost: ${t.cost.actualRows ? '$' + t.cost.actualUsd + ' reported by providers' : 'no provider-reported cost'}${t.cost.estimatedRows ? `; Estimated $${t.cost.estimatedUsd} from configured prices` : ''}`);
  }
  if (want('local')) {
    // LOCAL MODELS — from LAIN's own registries (modeldirs, llama-server table, Ollama cache).
    out.push('LOCAL MODELS (Model › Local) — no provider quota');
    const md = require('../local/modeldirs').list();
    const llama = require('../local/llamacpp');
    const verify = require('../localagent');
    out.push(`  llama.cpp: ${llama.binary(app) ? `installed (${llama.version(app) || 'version unknown'})` : 'not installed'} · ${md.dirs.length} model director(ies) · ${md.dirs.reduce((n, d) => n + d.counts.gguf, 0)} GGUF file(s) found · ${md.models.length} text model(s) · ${md.projectors.length} projector(s) · ${md.other.length} other`);
    for (const d of md.dirs) out.push(`    directory ${d.path}: ${d.counts.gguf} GGUF (${d.counts.text} text, ${d.counts.projector} projector, ${d.counts.other} other)${d.exists ? '' : ' — folder not found'}`);
    for (const m of md.models) {
      const v = verify.current(app, m.id);
      out.push(`    ${m.modelName || m.name} [${m.id}] ${m.quantization || ''} ${m.sizeBytes ? (m.sizeBytes / 1073741824).toFixed(1) + ' GB' : ''} ctx ${m.contextLength || '?'}${m.vision ? ' · VISION (projector paired)' : ''} · Agent: ${v ? v.result : 'not verified'}`);
    }
    const running = llama.status();
    if (!running.length) out.push('    running: none (LAIN starts llama-server when a local model is used)');
    for (const s of running) out.push(`    RUNNING: ${s.model} · pid ${s.pid} · port ${s.port} · ctx ${s.ctx} · ${s.state}${llama.processMemory(s.pid) ? ` · process memory ${(llama.processMemory(s.pid) / 1073741824).toFixed(1)} GB (working set, not VRAM)` : ''}`);
    const o = require('../local/ollama').cached();
    out.push(`  Ollama: ${o ? (o.running ? `running ${o.version || ''} at ${o.endpoint}, ${(o.models || []).length} model(s)` : `not running at ${o.endpoint}${o.binary ? '' : ' (not installed)'}`) : 'not checked yet'}`);
    for (const m of ((o && o.models) || []).slice(0, 20)) out.push(`    ${m.name} ${m.parameterSize || ''} ${m.quantization || ''} · Agent: ${(verify.current(app, m.id) || {}).result || 'not verified'}`);
  }
  if (want('runtimes') || want('plans')) {
    const ra = require('../runtimeadapters');
    if (want('runtimes')) {
      out.push('RUNTIMES (Model › Runtimes) — discovery / telemetry / execution, each on its own');
      for (const a of ra.all()) {
        // eslint-disable-next-line no-await-in-loop -- a handful, from cache
        const r = await ra.report(app, a.id);
        out.push(`  ${r.label}: ${r.state} · discovery ${r.discovery.ok ? 'yes' : 'no'} · telemetry ${r.telemetry.ok ? 'yes' : `no (${r.telemetry.why || 'not read'})`} · execution BOT ${r.execution.chat.ok ? 'yes' : `no (${r.execution.chat.why})`}, Agent ${r.execution.agent.ok ? 'yes' : `no (${r.execution.agent.why})`}`);
      }
    }
    if (want('plans')) {
      out.push('PLANS AND CREDITS');
      // Z.AI IS API-ONLY IN LAIN (2026-09-29): its windows come from Z.ai's monitor (fabric/quotaread.js), shown under MODEL › API.
      out.push('  Z.ai: through its API only — quota from Z.ai\'s monitor, under MODEL › API. (ZCode\'s Start Plan is not used by LAIN.)');
    }
  }
  if (want('project')) {
    // THIS PROJECT'S USAGE — and how much of the input was tool schema, fixed prompt, conversation.
    const usage = require('../usage');
    const pid = app.session && app.session.cwd ? require('../journey').projectId(app.session.cwd) : null;
    const rows = usage.filter(usage.read({ from: 0 }), pid ? { project: pid } : {});
    const t = usage.sum(rows, (app._sibling || app).cfg || {});
    const e = usage.efficiency(rows);
    out.push(`THIS PROJECT (${app.session && app.session.cwd ? app.session.cwd : 'no project'}), all time`);
    out.push(`  ${t.requests} request(s) · input ${t.input} · output ${t.output} tokens (as reported) · cache read ${t.cacheRead} · cache write ${t.cacheWrite}${t.estimated.rows ? ` · website ${t.estimated.input + t.estimated.output} tokens Estimated by LAIN` : ''}`);
    if (e.lain.requests) {
      const parts = { tool: e.lain.avgToolSchemaChars || 0, sys: e.lain.avgSystemChars || 0, conv: e.lain.avgMessageChars || 0 };
      const tot = parts.tool + parts.sys + parts.conv;
      out.push(`  per API request on average: tool schemas ${parts.tool} chars (${tot ? Math.round((parts.tool / tot) * 100) : 0}%), fixed prompt ${parts.sys} chars (${tot ? Math.round((parts.sys / tot) * 100) : 0}%), conversation ${parts.conv} chars (${tot ? Math.round((parts.conv / tot) * 100) : 0}%) — measured by LAIN from what it sent`);
    } else out.push('  no API requests to break down');
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
    for (const [name, v] of rows) {
      out.push(`  ${name}: ${v.enabled ? 'enabled' : v.disconnectedAt ? `disconnected ${v.disconnectedAt}` : 'not enabled'}, ${(v.allowUsers || []).length} approved user(s)`);
      // WHERE THE LAST MESSAGE GOT TO — the channel's own receipts (bot/trace.js).
      try {
        const tr = require('../bot/trace').summary(require('../bot/trace').read(), name, v.accountId || 'default');
        if (tr.lastRoundTrip) out.push(`    last full round trip ${ago(tr.lastRoundTrip.at)}`);
        if (tr.lastMessage && tr.lastMessage.stoppedAt) out.push(`    last message stopped at ${tr.lastMessage.stoppedAt.stage}${tr.lastMessage.stoppedAt.why ? `: ${tr.lastMessage.stoppedAt.why}` : ''}`);
      } catch { /* no receipts yet */ }
    }
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
        + 'use, accounts and how much of each provider window they have used, rate limits, token usage, MCP servers, bot '
        + 'channels, local models (llama.cpp, Ollama), runtimes, plans and credits, this project\'s token use, and where a setting lives in the LAIN window. action "describe" reads (topic: models, '
        + 'quota, providers, accounts, usage, project, local, runtimes, plans, mcp, bot, where, all). action "open" shows a view in the LAIN window (surface: '
        + 'home, ide, chat, bot, model, usage, session, settings; optional section such as mcp, skills, providers, '
        + 'connections) — navigation only, it changes nothing. action "doors" lists the capabilities of LAIN; action '
        + '"do" walks through one by id with `args` — e.g. settings.open_mcp, ide.open_file {path}, ide.open_symbol '
        + '{name}, ide.get_diagnostics, session.open {when:"yesterday"}, model.assign {role:"coding", model:"opus"}, '
        + 'task.status, changes.who {source:"USER"|"LAIN"}. A navigate door moves the window; model.assign changes '
        + 'the model assignment of this session (a setting, never a file). Never guess a percentage: if the tool says a '
        + 'provider has not reported usage, say that.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['describe', 'open', 'doors', 'do'] },
          id: { type: 'string', description: 'for action "do": the capability id, from action "doors"' },
          args: { type: 'object', description: 'for action "do": the arguments of the capability' },
          topic: { type: 'string', enum: ['models', 'quota', 'providers', 'accounts', 'usage', 'project', 'local', 'runtimes', 'plans', 'mcp', 'bot', 'where', 'all'] },
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
      // THE HOUSE DOORS (house.js): the same registry the window's own menus use.
      if (action === 'doors') {
        return { output: require('../house').list().map((d) => `${d.id} [${d.kind}] — ${d.what}`).join('\n') };
      }
      if (action === 'do') {
        const r = await require('../house').run(app, input && input.id, (input && input.args) || {});
        if (!r.ok) return { output: `${input && input.id}: ${r.why}${r.candidates ? `\ncandidates: ${r.candidates.join(', ')}` : ''}`, isError: true };
        if (r.kind === 'navigate') {
          return { output: `${r.windows ? 'Opened' : 'No LAIN window is open; it will show'} ${r.navigated.surface}${r.navigated.section ? ` › ${r.navigated.section}` : ''}${r.opened ? `: ${r.opened.title} (${r.opened.project || 'no project'})${r.others && r.others.length ? `. ${r.others.length} other match(es): ${r.others.map((o) => o.title).join('; ')}` : ''}` : ''}${r.declared ? ` (declared at ${r.declared.join(', ')})` : ''}.` };
        }
        return { output: r.text || 'done' };
      }
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
