'use strict';

/** THE ROUTE COMMANDS — which model, through which connection, at what effort, and which model reviews an investigation. */

const config = require('./config');
const catalogMod = require('./catalog');
const connectionsMod = require('./connections');

/** passed in rather than imported back. */
function register({ define, REGISTRY, C, FLASH_MS }) {
  /** Re-read what the routes serve. The implementation lives in catalog.js. */
  const refreshCatalog = (app, opts) => catalogMod.refreshAndReport(app, opts, { C });
  /** `/external` IS RETIRED, AND IT IS NOT COMING BACK */

  /** ONE MODEL COMMAND, AND IT IS THE SINGULAR ONE. */
  define('/model', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[name|refresh]',
    desc: 'Model picker — type to filter, Enter to use',
    run(app, ctx) { return require('./modelcommand').pickCommand(app, ctx, { C, config, refreshCatalog }); },
  });

  define('/models', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    surface: true,
    // HIDDEN: runs when typed, offered nowhere. One name is advertised.
    hidden: true,
    args: '[name|refresh]',
    desc: 'Compatibility alias for /model',
    run(app, ctx) { return REGISTRY.get('/model').run(app, ctx); },
  });

  // ONE effort command. V1 shipped /effort AND /efforts; there is no alias here.
  define('/effort', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[level]',
    desc: 'Show or set the reasoning effort — the levels the lane\'s model declares',
    /** EFFORT BELONGS TO THE MODEL (Phase 8.3). */
    async run(app, { args }) {
      const si = require('./sessionintel');
      const laneName = si.currentLane(app.session);
      const lane = si.lane(app, app.session, laneName);
      const levels = lane.efforts || [];
      const labels = lane.effortLabels || [];
      const current = lane.effort || null;
      const choose = async (value) => {
        const r = await si.choose(app, app.session, { lane: laneName, effort: value });
        try { app.session.save(); } catch { /* in memory */ }
        return r;
      };
      // Bare /effort on a TTY opens the ONE interaction panel with the model's own levels.
      if (!args[0] && app.ui && app.ui.enabled && levels.length) {
        const { effortAdapter } = require('./ui/panel');
        const picked = await app.ui.ask(effortAdapter({ available: levels, current, source: lane.effortSource }));
        if (picked) args = [picked];
      }
      if (!args[0]) {
        if (!lane.effortKnown) { app.render.write(`  effort: ${current || C.dim('default')}` + C.dim('  ·  choose a model first (/model)\n')); return; }
        // ONE CONTROL, TWO HONEST MEANINGS (2026-10-02): a model with native effort gets the provider's own levels;
        // one without gets LAIN's execution depth — never presented as hidden model reasoning.
        const kind = lane.effortSource === 'lain' ? 'LAIN effort' : 'Provider effort';
        const what = lane.effortSource === 'lain' ? C.dim('  ·  this model has no native effort; LAIN sets how much context, exploration and delegation it uses') : '';
        const shown = lane.effortSource === 'lain' ? `${lane.effectiveLabel}${lane.effortDefaultWhy ? C.dim(` (${lane.effortDefaultWhy})`) : lane.effortExplicit ? '' : C.dim(' (default)')}`
          : (lane.effortLabel && lane.effortLabel !== 'Default' ? lane.effortLabel : C.dim(`Default (${(require('./profile').of(app.session, app.cfg) || 'NORMAL')})`));
        app.render.write(`  ${lane.modelLabel}\n  ${kind}: ${shown}`
          + (levels.length ? C.dim(`  ·  ${labels.join(' / ')}`) : '') + what + '\n');
        return;
      }
      const want = String(args[0]).toLowerCase();
      // `auto` / `default` is the absence of a pin: the model's own default level.
      if (want === 'auto' || want === 'default' || want === 'none') {
        const r = await choose('auto');
        if (!r.ok) { app.render.write(C.yellow(`  ${r.why}`) + '\n'); return; }
        app.render.write(C.green(`  ${r.lane.effortKind || 'effort'}: ${r.lane.effortSource === 'lain' ? r.lane.effectiveLabel : (r.lane.effortLabel || 'default')}`) + C.dim(' — the default\n'));
        return;
      }
      const r = await choose(want);
      if (!r.ok) { app.render.write(C.yellow(`  ${r.why}`) + '\n'); return; }
      app.render.write(C.green(`  ${r.lane.modelLabel} · ${r.lane.effortSource === 'lain' ? 'LAIN' : 'Provider'} effort: ${r.lane.effortLabel}`) + '\n');
    },
  });

  define('/api', {
    // AN INSPECTOR, despite also performing actions: `/api status` lists what the routes serve, which is the last thing that should vanish on a timer.
    surface: true,
    args: '[add|<provider>|<connection>|refresh [id]|status]  — keys are entered in the Model Dashboard',
    desc: 'Add or replace an API source in the Model Dashboard, or re-read what the APIs serve',
    /** THE TERMINAL NEVER TAKES A KEY (Phase 8.3). */
    async run(app, { args }) {
      const apiMod = require('./apicommand');
      const first = args[0] || '';
      const sub = String(first).toLowerCase();
      if (sub === 'refresh') { await refreshCatalog(app, { only: args[1] || null }); return; }
      if (sub === 'status') return REGISTRY.get('/provider').run(app, { args: ['status'], rest: '' });
      const named = first && (['add', 'manage'].includes(sub) || apiMod.connectionByName(app, first) || apiMod.providerNamed(app, first));
      if (first && !named && apiMod.looksLikeCredential(first, app.cfg)) {
        const redact = require('./redact');
        redact.register(String(first).trim());
        redact.scrubHistory(app.input);
        // WHERE KEYS GO comes first: a narrow command surface shows the first row or two.
        app.render.write(C.yellow('  LAIN never takes a key in the terminal.') + ' /api add opens the Model Dashboard, where keys go.\n');
        app.render.write(C.dim('  It was not stored, and it is gone from the input history. The dashboard keeps keys in the Windows secret store.\n'));
        return;
      }
      if (first && !named) return REGISTRY.get('/provider').run(app, { args: ['status'], rest: '' });
      const dl = require('./fabric/dashlaunch');
      const since = Date.now();
      const r = await dl.open(app, 'api');
      if (!r.ok) { app.render.write(C.yellow(`  The Model Dashboard did not open: ${r.why}\n`)); return; }
      app.render.write(`  ${dl.said(r, 'API')} Add or replace the key there.\n`);
      app.render.write(C.dim('  The key is never shown here, and never enters a conversation.\n'));
      dl.watch(since, (e) => { const t = dl.describe(e); if (app.ui && app.ui.enabled) app.ui.noteActor('note', t); else app.render.write(`  ${t}\n`); });
    },
  });

  define('/provider', {
    // AN INSPECTOR, despite also performing actions: `/provider` defaults to a status listing, read exactly when a route is dead, which is the last thing…
    surface: true,
    args: '[status|refresh [id]|disable <id>|enable <id>|maintenance <id>|retry <id>]',
    desc: 'Connection availability and catalog. Works while a provider is dead.',
    async run(app, { args }) {
      const sub = (args[0] || 'status').toLowerCase();
      const id = args[1];
      const w = (s) => app.render.write(s);

      // The one command that DOES contact a route — and only its catalog endpoint, never a completion.
      if (sub === 'refresh') {
        const results = await app.ensureCatalog({ force: true, only: id || null, announce: false });
        if (!results.length) {
          w(C.dim(`  Nothing to refresh${id ? ` for "${id}"` : ''} — routes that declare their own models are left alone.\n`));
          return;
        }
        for (const r of results) {
          if (r.ok) w(C.green(`  ${r.id}`) + C.dim(`  ${r.count} model(s) from ${r.url}\n`));
          else w(C.yellow(`  ${r.id}`) + C.dim(`  no catalog — ${r.error}\n`));
        }
        const cat = app.catalog();
        w(C.dim(`\n  ${cat.models.length} canonical model(s). /model to browse.\n`));
        return;
      }

      if (sub !== 'status') {
        if (!id) { w(C.dim(`  Usage: /provider ${sub} <connection-id>\n`)); return; }
        // NONE of these contact the provider. That is the point: a dead provider
        // must not be able to stop you managing it.
        const r = sub === 'disable' ? app.availability.disable(id)
          : sub === 'enable' ? app.availability.enable(id)
            : sub === 'maintenance' ? app.availability.maintenance(id)
              : sub === 'retry' ? app.availability.retry(id) : null;
        if (!r) { w(C.dim('  Usage: /provider status|disable|enable|maintenance|retry <id>\n')); return; }
        w(C.green(`  ${id} → ${r.status}`) + C.dim(' (no request was sent)\n'));
        return;
      }

      const conns = app.connections();
      // The SAME interaction panel every other interactive surface uses.
      if (app.ui && app.ui.enabled) {
        const { providerAdapter } = require('./ui/panel');
        await app.ui.ask(providerAdapter({
          connections: conns,
          availabilityOf: (cid) => app.availability.get(cid).status,
        }));
        return;
      }
      w('\n' + C.bold('Connections') + '\n');
      if (!conns.length) { w(C.dim('  none configured\n')); return; }
      for (const c of conns) {
        const a = app.availability.get(c.id);
        w('  ' + c.id.padEnd(22)
          + C.dim(`${c.provider} · ${c.via} · auth=${c.auth}`) + '\n');
        w('    ' + C.dim(`readiness ${c.readiness}  ·  availability ${a.status}${a.reason ? ' — ' + a.reason : ''}`) + '\n');
        // A LIMIT IS A CLOSED DOOR WITH A CLOCK ON IT, AND IT SAYS SO
        if (a.rateLimited) {
          const left = a.resumeAt ? a.resumeAt - Date.now() : 0;
          const rl = require('./ratelimit');
          // NEVER AN INVENTED COUNTDOWN. With no stated reset the honest row is
          // that nobody said when — a number here would be planned around.
          const when = a.resumeAt > 0
            ? (left > 0 ? `clears in ${rl.human(left)} — around ${rl.at(a.resumeAt)}` : 'should have cleared')
            : 'UNKNOWN RESET — the provider did not say when';
          const from = app.availability.hydrated && app.availability.hydrated.has(c.id)
            ? ' (from an earlier session)' : '';
          w('    ' + C.dim(`rate limited · ${when}${from}`) + '\n');
        } else if (a.historicalLimit && a.historicalLimit.resumeAt > Date.now()) {
          w('    ' + C.dim(`earlier session: rate limited until ${require('./ratelimit').at(a.historicalLimit.resumeAt)} · not assumed now`) + '\n');
        }
        // WHERE the model list came from.
        const origin = c.declaredModels ? 'declared in config'
          : c.discoveredAt ? `discovered ${new Date(c.discoveredAt).toISOString().slice(0, 16).replace('T', ' ')}`
            : 'not yet discovered';
        w('    ' + C.dim(`catalog ${c.models.length} model(s) — ${origin}`) + '\n');
      }
      w(C.dim('\n  readiness is about credentials; availability is about reachability. They are separate.\n'));
      w(C.dim('  /provider refresh [id] re-reads a route\'s catalog (no completion is requested).\n'));
    },
  });

  define('/oauth', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[provider]',
    desc: 'Authentication routes per provider — never fakes OAuth',
    run(app, { rest }) {
      const conns = app.connections();
      const w = (s) => app.render.write(s);
      const providers = rest ? [rest] : [...new Set(conns.map((c) => c.provider))];
      if (!providers.length) { w(C.dim('  No connections configured.\n')); return; }
      for (const p of providers) {
        w('\n' + C.bold(p) + '\n');
        const rows = connectionsMod.authRoutes(p, conns);
        if (!rows.length) { w(C.dim('  no routes\n')); continue; }
        for (const r of rows) {
          const status = r.enabled ? r.status : C.yellow(r.status);
          w('  ' + r.label.padEnd(30) + status + '\n');
          if (r.detail) w(C.dim('      ' + r.detail) + '\n');
        }
        if (connectionsMod.hasKeylessRoute(p, conns)) {
          w(C.green('  ✓ a keyless route is already authenticated — no API key needed for this provider\n'));
        }
      }
    },
  });
}

module.exports = { register };
