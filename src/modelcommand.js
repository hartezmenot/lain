'use strict';

/** Why `id` cannot be the default model (it codes), or null. See modelroles.js. */
function agentGate(app, id) {
  const roles = require('./modelroles');
  if (roles.isChatAlias(id)) return roles.check({ modelId: id }, roles.ROLE.AGENT).why;
  const rt = require('./runtimeconnections').rowFor(app, id);
  if (rt && !roles.allowed(rt, roles.ROLE.AGENT)) return `${rt.label || id} is not verified for the Coding Agent — use it as the BOT in the gear, or run its Agent test in MODEL › Local`;
  return null;
}

/** AND — browsing the catalog, and choosing from it. */

const config = require('./config');
const { search, displayName } = require('./catalog');

/** THE MODEL PICKER — the one implementation behind /models and /model. */
/** Print a refresh's generations: "Codex models updated / + GPT-6.1 Sol", or that nothing changed. */
async function refreshModels(app, { family = null, C = null, write = null } = {}) {
  const w = write || ((s) => app.render.write(s));
  const c = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const MC = require('./modelcatalog');
  w(c.dim(`  Refreshing models${family ? ` for ${family}` : ''}…\n`));
  let r;
  try { r = await MC.refresh(app, { family }); } catch (e) { w(c.yellow(`  Refresh failed: ${(e && e.message) || e}\n`)); return null; }
  const lines = r.diffs.map((d) => MC.summarize(d)).filter(Boolean);
  if (!lines.length) w(c.dim('  Up to date — no provider reported a new or removed model.\n'));
  for (const block of lines) for (const [i, l] of block.split('\n').entries()) w(i === 0 ? c.green(`  ${l}\n`) : (l.startsWith('-') ? c.yellow(`    ${l}\n`) : c.dim(`    ${l}\n`)));
  for (const n of r.notes || []) w(c.dim(`  ${n}\n`));
  w(c.dim('  Nothing was selected for you: new models are available in /model.\n'));
  return r;
}

/** `lain model refresh` — no session, no window: the Core refresh, printed, and the exit code. */
async function refreshCli({ cwd = process.cwd() } = {}) {
  const { App } = require('./app');
  const app = new App({ cwd, interactive: false });
  try { await app.prepare(); } catch { /* the refresh reports what it can reach */ }
  const r = await refreshModels(app, { write: (s) => process.stdout.write(s) });
  return r && r.ok ? 0 : 1;
}

async function pickCommand(app, { args = [], rest = '' } = {}, { C, config, refreshCatalog } = {}) {
    // `refresh` is accepted on all three of /api, /model and /models because there is no way to guess which one a person will reach for, and they run the…
    if (/^refresh\b/i.test(rest.trim())) {
      const fam = rest.trim().split(/\s+/)[1] || null;
      await refreshModels(app, { family: fam, C });
      return;
    }
    // ACCOUNT FIRST (Phase 8.2)
    const intel = require('./sessionintel');
    const laneName = (() => { try { return require('./sessionviews').current(app.session) === 'chat' ? 'chat' : 'coding'; } catch { return 'coding'; } })();
    const words0 = rest.trim().split(/\s+/).filter(Boolean);
    // `/model manage` — THE MODEL DASHBOARD (Phase 8.3): accounts, APIs and keys are managed there, never here.
    if (words0[0] === 'manage') {
      const dl = require('./fabric/dashlaunch');
      const r = await dl.open(app, words0[1] || 'models');
      app.render.write(C.dim(`  ${dl.said(r, 'Models')}\n`));
      return;
    }
    if (words0[0] === 'default') {
      const r = await intel.set(app, app.session, { lane: laneName === 'chat' ? 'chat' : 'coding', field: 'model', value: words0.slice(1).join(' ') || null, scope: 'global' });
      app.render.write(r.ok ? C.dim(`  New sessions start with ${words0.slice(1).join(' ') || 'no model'} (${laneName}).\n`) : C.dim(`  ${r.why}\n`));
      return;
    }
    const browseAll = words0[0] === 'all';
    if (browseAll) { rest = words0.slice(1).join(' '); args = args.slice(1); }
    const laneNow = intel.lane(app, app.session, laneName);
    // THE PROVIDER FAMILY'S MODELS (Phase 8.3) — every backing account's routes, never one account's slice.
    const famNow = !browseAll && laneNow.family ? require('./fabric/index').family(app, laneNow.family) : null;
    const famAccounts = famNow ? new Set(famNow.accounts.map((a) => a.id)) : null;
    const A = require('./accountcatalog');
    /** Choose FAMILY + MODEL (+ effort) for this session's lane — the one write. */
    const choose = async (modelId, routeId, effort) => {
      const acct = routeId ? A.accountFor(app, routeId) : null;
      const fam = acct ? require('./fabric/index').familyOfAccount(app, acct.id) : null;
      const body = { lane: laneName, model: modelId };
      if (fam) body.family = fam.id; else if (acct) body.account = acct.id;
      if (effort !== undefined) body.effort = effort || 'auto';
      const r = await intel.choose(app, app.session, body);
      if (!r.ok) return r;
      try { app.session.save(); } catch { /* saved with the next turn */ }
      return r;
    };
    // MODELS FIRST; SOURCES ARE SECONDARY (§54–55)
    await app.ensureCatalog();
    const whole = app.catalog();
    // THE ACCOUNT'S SLICE: only its models, only its routes — a picker never
    // renders a router's thousand models to someone who chose one account.
    const inFam = (c) => { const a = A.accountFor(app, c.connectionId); return Boolean(a && famAccounts.has(a.id)); };
    const cat = famNow ? (() => {
      const models = whole.models.filter((m) => m.connections.some(inFam))
        .map((m) => ({ ...m, connections: m.connections.filter(inFam) }));
      return { models, byId: new Map(models.map((m) => [m.id, m])) };
    })() : whole;
    const w = (s) => app.render.write(s);
    if (famNow && !browseAll && !rest) w(C.dim(`  ${famNow.label} · ${famNow.models.length} model(s) · /model all for every provider\n`));
    // ONE RULE EVERYWHERE: commit when nothing is left to decide.
    const soleMatch = rest ? (() => {
      const known = new Set(app.connections().map((c) => c.id));
      const tail = args.length > 1 ? args[args.length - 1] : null;
      const conn = tail && known.has(tail) ? tail : null;
      const q = conn ? rest.slice(0, rest.length - conn.length).trim() : rest;
      const found = search(cat, q);
      return found.length === 1 ? found[0] : null;
    })() : null;

    // `/models` browses everything; `/models claude` browses what matches. Both
    // open the SAME panel — a name is a filter, not a different command.
    if (cat.models.length && !soleMatch && app.ui && app.ui.enabled) {
      const { modelsAdapter } = require('./ui/panel');
      // Readiness and availability are DIFFERENT questions and stay separate fields: one is about credentials, the other about reachability.
      const byId = new Map(app.connections().map((c) => [c.id, c]));
      const readinessOf = (c) => (byId.get(c.baseConnectionId) || {}).readiness || 'unknown';
      const availabilityOf = (c) => app.availability.getFor(c.baseConnectionId, c.modelId).status;
      // ONE builder, used both to open the browser and to rebuild it as the user types.
      const newModels = require('./newmodels');
      const isNew = newModels.all();
      let pending = null;
      const build = (filter) => modelsAdapter({
        catalog: cat,
        current: laneNow.model,
        currentConnection: laneNow.route,
        filter,
        readinessOf,
        availabilityOf,
        // THE WHOLE ENTRY, not just the word: the rate-limit countdown lives on it, and "rate limited" without "clears in 3h 59m" is the half of the fact that…
        availabilityRaw: (c) => app.availability.getFor(c.baseConnectionId, c.modelId),
        isNew,
        externalSources: externalSources(app),
        sourceIssues: require('./catalogstate').issues(app.connections()),
        onPickRoute: (model, conn, effort) => {
          // THE DEFAULT CODES: a local/runtime model not verified for AGENT is refused here (modelroles.js).
          const gate = laneName === 'coding' ? agentGate(app, model.id) : null;
          if (gate) { w(C.dim(`  ${gate}
`)); return; }
          // THE SESSION'S CHOICE, made once the panel closes (sessionintel.choose is async).
          pending = { model: model.id, route: conn.connectionId, effort };
          // Using it is the end of it being news.
          newModels.seen(model.id);
        },
      });
      // Typing narrows the list.
      app.ui.setModelFilter((text) => {
        if (app.ui.panel.stack.length !== 1) return;   // not inside a drill-down
        app.ui.panel.replace(build(text));
        app.ui.refresh();
      });
      const picked = await app.ui.ask(build(rest));
      app.ui.setModelFilter(null);
      if (pending) {
        const r = await choose(pending.model, pending.route, pending.effort);
        if (!r.ok) { if (app.input) app.input.setLine(''); else app.ui.setInput(''); w(C.dim(`  ${r.why}\n`)); return; }
      }
      // THE QUERY BELONGED TO THE PICKER, so it leaves with it.
      if (app.input) app.input.setLine('');
      else app.ui.setInput('');
      if (picked && picked.source) { await pickSource(app, picked.source); return; }
      // DID MY MODEL ACTUALLY CHANGE?
      if (picked && picked.model) {
        const chosen = (cat.models || []).find((m) => m.id === picked.model);
        const name = chosen ? chosen.displayName : picked.model;
        const conn = chosen && chosen.connections.find((c) => c.connectionId === picked.connection);
        app.render.write('\n' + C.green('  ✓ Model selected') + '\n');
        app.render.write('      ' + C.bold(name) + '\n');
        if (conn) app.render.write(C.dim(`      ${conn.provider}`) + '\n');
        const now = intel.lane(app, app.session, laneName);
        app.render.write(C.dim(`      effort ${now.effortLabel || 'not configurable'}`) + '\n');
        app.render.write(C.dim(`      ${laneName === 'chat' ? 'Chat' : 'Coding'} · ${now.familyLabel || now.accountLabel} › ${now.modelLabel} · ${now.policyLabel || ''} · this session`) + '\n');
      } else {
        // Escape. Saying so is the difference between "cancelled" and "did that
        // do anything?".
        app.render.write(C.dim('  Unchanged.\n'));
      }
      return;
    }
    if (!cat.models.length) {
      w(C.dim('\n  No models. Declare a connection in ' + config.configFile() + ':\n'));
      w(C.dim('    { "connections": { "my-gateway": { "provider": "anthropic", "via": "bridge",\n'));
      w(C.dim('        "baseUrl": "http://localhost:20128/v1" } } }\n'));
      w(C.dim('\n  A connection with a baseUrl is asked what it serves; listing "models" is optional.\n'));
      w(C.dim('  /provider refresh <id> re-reads a route\'s catalog.\n'));
      return;
    }
    // ONE row format for the full list and for a search — effort variants are collapsed, so gpt-5.5-low/-medium/-high is one model with three efforts…
    const fresh = require('./newmodels').all();
    const rows = (list) => {
      // The SAME row format the picker uses: a count is only worth showing where
      // there is a choice in it. "1 route" is not something a person can act on.
      for (const m of list) {
        const routes = m.connections.length;
        const efforts = (m.connections[0] || {}).efforts || [];
        const hint = routes > 1
          ? `${routes} providers`
          : [(m.connections[0] || {}).provider, efforts.length > 1 ? `${efforts.length} levels` : null]
            .filter(Boolean).join('  ·  ');
        const mark = laneNow.model === m.id ? C.green('● ') : '  ';
        // NEW leads the row, where the eye lands, and only for models the LAST
        // refresh actually brought in — never for one that was already there.
        const isNew = fresh.has(m.id) ? C.green('NEW ') : '    ';
        w('  ' + mark + isNew + m.displayName.padEnd(34) + C.dim(hint) + '\n');
      }
      w(C.dim('\n  /models <name> narrows this · an unambiguous name selects it outright\n'));
    };

    if (!rest) {
      w('\n' + C.bold('Models') + C.dim(`  ${cat.models.length} model(s)`) + '\n');
      rows(cat.models);
      return;
    }
    // `/models <name> <connection>` names a route explicitly.
    const known = new Set(app.connections().map((c) => c.id));
    const last = args.length > 1 ? args[args.length - 1] : null;
    const wantConn = last && known.has(last) ? last : null;
    const query = wantConn ? rest.slice(0, rest.length - wantConn.length).trim() : rest;

    // A NAME IS A SEARCH, not a selection.
    const hits = search(cat, query);
    if (!hits.length) { w(C.dim(`  No model matching "${query}".\n`)); return; }
    if (hits.length > 1) {
      w('\n' + C.bold(`Models matching "${query}"`) + C.dim(`  ${hits.length} found`) + '\n');
      rows(hits);
      return;
    }
    // EXACTLY ONE MATCH IS A CHOICE ALREADY MADE.
    const m = hits[0];
    let conn = (wantConn && m.connections.find((c) => c.connectionId === wantConn)) || null;
    if (wantConn && !conn) {
      w(C.dim(`  "${m.displayName}" is not served by "${wantConn}".\n`));
      return;
    }

    // ONE MODEL IS NOT ONE CHOICE WHEN TWO ROUTES SERVE IT
    const famOfRoute = (c) => { const a = A.accountFor(app, c.connectionId); const fm = a ? require('./fabric/index').familyOfAccount(app, a.id) : null; return fm ? fm.id : c.connectionId; };
    if (!conn && new Set(m.connections.map(famOfRoute)).size === 1) conn = m.connections[0];
    if (!conn && m.connections.length > 1 && app.ui && app.ui.enabled) {
      const { modelRoutesAdapter } = require('./ui/panel');
      const byId = new Map(app.connections().map((c) => [c.id, c]));
      let picked = null;
      await app.ui.ask(modelRoutesAdapter({
        model: m,
        currentConnection: app.cfg.connection,
        readinessOf: (c) => (byId.get(c.baseConnectionId) || {}).readiness || 'unknown',
        availabilityOf: (c) => app.availability.getFor(c.baseConnectionId, c.modelId).status,
        // THE WHOLE ENTRY, not just the word: the rate-limit countdown lives on it, and "rate limited" without "clears in 3h 59m" is the half of the fact that…
        availabilityRaw: (c) => app.availability.getFor(c.baseConnectionId, c.modelId),
        onPickRoute: (_model, c) => { picked = c; },
      }));
      // ESCAPE CHANGES NOTHING. Cancelling a question is not an instruction to
      // pick the first option on the user's behalf.
      if (!picked) { w(C.dim('  unchanged.\n')); return; }
      conn = picked;
    }
    // OFF A TTY there is nobody to ask, so the first route is taken — and said out loud below.
    if (!conn) conn = m.connections[0];
    if (!conn) {
      w(C.dim(`  "${m.displayName}" has no route that can serve it.\n`));
      return;
    }
    const gate = laneName === 'coding' ? agentGate(app, m.id) : null;
    if (gate) { w(C.dim(`  ${gate}
`)); return; }
    const chosen = await choose(m.id, conn.connectionId);
    if (!chosen.ok) { w(C.dim(`  ${chosen.why}\n`)); return; }
    if (app.ui && app.ui.enabled) app.ui.refresh();
    w('\n' + C.green(`  ${chosen.lane.familyLabel || chosen.lane.accountLabel} › ${chosen.lane.modelLabel || m.displayName}`) + C.dim(`${chosen.lane.effortLabel ? ` · ${chosen.lane.effortLabel}` : ''} · ${laneName} · this session`) + '\n');
    // Everything that was NOT chosen, so a single-match selection never hides
    // that there were other routes.
    if (m.connections.length > 1) {
      w(C.dim(`  ${m.connections.length} routes serve this model:\n`));
      // FREE/PAID IS THE ONE SPLIT §57 ASKS FOR, and only when the user's own config actually said which route is which (catalog.js `tier`) — an unset tier…
      const known = m.connections.filter((c) => c.tier).length;
      const printRow = (c) => {
        const a = app.availability.getFor(c.baseConnectionId || c.connectionId, c.modelId);
        w(C.dim(`    ${c.connectionId === conn.connectionId ? '●' : ' '} ${c.connectionId.padEnd(22)}${c.provider} · ${c.via} · ${a.status}`) + '\n');
      };
      if (known >= 2) {
        for (const tier of ['free', 'paid']) {
          const rows = m.connections.filter((c) => c.tier === tier);
          if (!rows.length) continue;
          w(C.dim(`  ${tier.toUpperCase()}\n`));
          for (const c of rows) printRow(c);
        }
        for (const c of m.connections.filter((c) => !c.tier)) printRow(c);
      } else {
        for (const c of m.connections) printRow(c);
      }
      w(C.dim(`  /models ${query} <connection> picks a different one.\n`));
    }
    if (conn.efforts.length) w(C.dim(`  efforts on this route: ${conn.efforts.join(', ')}  ·  /effort to choose\n`));
}

/** THE SOURCE SHELF, then — for a website — its account's models. */
/** The website sources, as secondary rows for the `external:` filter. */
function externalSources(app) {
  try {
    const { SOURCE, LABEL } = require('./modelsource/contract');
    const current = require('./modelsource/registry').selectedId(app);
    return [SOURCE.CHATGPT_WEB, SOURCE.GEMINI_WEB].map((id) => ({ id, label: LABEL[id] || id, current: id === current }));
  } catch { return []; }
}

async function pickSource(app, preset = null) {
  const registry = require('./modelsource/registry');
  const { SOURCE, LABEL, MODEL_STATE } = require('./modelsource/contract');
  const { shelf } = require('./ui/shelf');
  const current = registry.selectedId(app);
  const ids = [SOURCE.LAIN, SOURCE.CHATGPT_WEB, SOURCE.GEMINI_WEB];
  const picked = preset ? { choice: preset } : await app.ui.ask(shelf({
    title: 'Model source',
    choices: ids.map((id) => ({ label: LABEL[id] || id, value: id, detail: id === current ? '· current' : '' })),
    cursor: Math.max(0, ids.indexOf(current)),
    actions: [{ label: 'Choose model', value: 'choose' }],
    footer: '↑↓ source · Enter choose model · Esc close',
  }));
  if (!picked || !picked.choice) return null;
  const r = registry.selectSource(app, picked.choice);
  if (!r.ok) { app.transient('warn', r.why); return null; }
  try { app.session.save(); } catch { /* the selection still holds for this run */ }
  if (picked.choice === SOURCE.LAIN) return 'lain';

  const src = registry.get(app, picked.choice);
  let inv = await src.discoverModels({});
  if (!inv.ok && inv.authRequired) {
    // CONNECT IS A DELIBERATE ACT: it opens the persistent WebModel browser for
    // a human login, so it is offered, never started by itself.
    const again = await app.ui.ask(shelf({
      title: LABEL[picked.choice],
      context: [String(inv.why || 'Sign in is required to read this account\'s models.')],
      actions: [{ label: 'Connect', value: 'connect' }],
    }));
    if (!again) return 'web';
    const st = await src.connect();
    if (st.state !== 'READY') { app.transient('warn', `${LABEL[picked.choice]}: ${st.state}${st.why ? ` — ${st.why}` : ''}`); return 'web'; }
    inv = await src.discoverModels({ refresh: true });
  }
  if (!inv.ok) { app.transient('warn', `${LABEL[picked.choice]}: ${inv.why}`); return 'web'; }
  const chosen = src.selectedModel();
  const models = inv.models.filter((m) => m.state !== MODEL_STATE.UNAVAILABLE);
  const m = await app.ui.ask(shelf({
    title: `${LABEL[picked.choice]} models`,
    choices: models.map((x) => ({ label: x.label && x.label !== x.id ? `${x.label}  (${x.id})` : x.id, value: x.id, detail: x.id === chosen ? '· current' : '' })),
    cursor: Math.max(0, models.findIndex((x) => x.id === chosen)),
    actions: [{ label: 'Use', value: 'use' }],
    footer: '↑↓ model · Enter use · Esc close',
  }));
  if (!m || !m.choice) return 'web';
  const sel = await src.selectModel(m.choice);
  if (sel && sel.ok === false) app.transient('warn', sel.why || 'that model could not be selected');
  else app.transient('info', `${LABEL[picked.choice]} · ${m.choice}`);
  try { app.session.save(); } catch { /* the selection still holds for this run */ }
  return 'web';
}

module.exports = { pickCommand, pickSource, externalSources, refreshModels, refreshCli };