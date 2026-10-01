'use strict';

/**
 * THE ROUTE COMMANDS — which model, through which connection, at what effort,
 * and which model reviews an investigation.
 *
 * Split out of commands.js, which had grown past the god-object guard. The seam
 * is not arbitrary: every command here is a question about the CATALOG — what is
 * served, by whom, how to reach it, and which of them plays reviewer — while
 * commands.js keeps the session, the workspace and the reports.
 *
 * There is still exactly ONE registry. This file does not own a second one: it
 * is handed `define` and registers into the same map, at load time, from the
 * bottom of commands.js. That is also why it requires nothing back from
 * commands.js — a cycle here would be a second dispatch path waiting to happen.
 */

const config = require('./config');
const catalogMod = require('./catalog');
const connectionsMod = require('./connections');

/**
 * @param {object} api  { define, REGISTRY, C } — the registry's own vocabulary,
 *                      passed in rather than imported back.
 */
function register({ define, REGISTRY, C, FLASH_MS }) {
  /** Re-read what the routes serve. The implementation lives in catalog.js. */
  const refreshCatalog = (app, opts) => catalogMod.refreshAndReport(app, opts, { C });
  /**
   * ---- `/external` IS RETIRED, AND IT IS NOT COMING BACK ------------------
   *
   * It lived here and was a DRAFT-AND-DISPATCH verb: compose a packet, preview
   * it, confirm it, send it once, print the reply, hand it back as advice. Four
   * files of machinery — external.js, actors.js, externalrequest.js and
   * investigation.js's relay — and a person who wanted a second opinion had to
   * remember a command to get one.
   *
   * THE USEFUL HALF OF IT WAS NEVER THE COMMAND. It was "a model other than
   * LAIN's own looks at this", and that is a PROPERTY OF THE SESSION, not a verb:
   * once ChatGPT.com is the selected chat source, the next ordinary sentence goes
   * to it and the answer lands in the same session history as everything else.
   * See src/modelsource and `/source`.
   *
   * WHAT WAS REUSED rather than rewritten:
   *   · the bounded, redacted session-facts packet   -> modelsource/context.js
   *   · the call ledger (dispatched / responded /    -> externalstate.js, kept
   *     failed / timed out, and RESPONDED REQUIRES      whole and now written by
   *     A RESPONSE)                                     the web sources
   *   · the overclaim check — a consulted model that -> modelsource/contract.js
   *     claims to have ACTED is flagged
   *   · "advisory input, not a result, and not from  -> chatdispatch.js
   *     the user"
   *
   * WHAT WAS RETIRED: the actor taxonomy (API / HUMAN / REVERSE), the clipboard
   * relay, the draft/confirm/send state machine, and the bounded LAIN → EXTERNAL
   * → LAIN investigation relay — which had been unreachable since `/troubleshoot`
   * was removed and was recorded as orphaned in docs/STATUS.md.
   *
   * TWO CONSULTATION SYSTEMS WOULD BE WORSE THAN EITHER. That is the whole
   * argument for removing rather than keeping this beside the new one.
   */

  /**
   * ONE MODEL COMMAND, AND IT IS THE SINGULAR ONE.
   *
   * ------------------------------------------------------------------------
   * THE HISTORY, because the end state only makes sense against it.
   *
   * There were two commands with two BEHAVIOURS: `/models` browsed, and `/model`
   * selected the first fuzzy match without showing what else matched. A previous
   * pass fixed the dangerous half of that by making `/model` forward to the one
   * picker — but it left both names advertised, so a person still had to know
   * two words for one thing and still had to choose between them every time.
   *
   * `/model` is now THE command. `/models` survives as a hidden compatibility
   * alias: it still runs when typed, for anyone with it in their fingers or in a
   * script, and it appears in neither `/help` nor the palette. See commands.js
   * `define` for what `hidden` means and what it must never be used for.
   *
   * The graphical picker is the Harness application's; this is the terminal's.
   */
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
    /**
     * EFFORT BELONGS TO THE MODEL (Phase 8.3). The levels offered are exactly the
     * ones the lane's model declares (fabric/effortcaps.js) — Opus might offer
     * High and XHigh, another model Low/Medium/High, another none at all — and
     * the choice is the same Core write the window's effort control and
     * Telegram's /effort make: this session's lane (sessionintel.choose).
     */
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
        const picked = await app.ui.ask(effortAdapter({ available: levels, current }));
        if (picked) args = [picked];
      }
      if (!args[0]) {
        if (!lane.effortKnown) { app.render.write(`  effort: ${current || C.dim('default')}` + C.dim('  ·  choose a model first (/model)\n')); return; }
        app.render.write(`  ${lane.modelLabel}: ${lane.effortLabel || C.dim('not configurable')}`
          + (levels.length ? C.dim(`  ·  offers ${labels.join(', ')}`) : C.dim('  ·  this model has no configurable effort')) + '\n');
        return;
      }
      const want = String(args[0]).toLowerCase();
      // `auto` / `default` is the absence of a pin: the model's own default level.
      if (want === 'auto' || want === 'default' || want === 'none') {
        const r = await choose('auto');
        if (!r.ok) { app.render.write(C.yellow(`  ${r.why}`) + '\n'); return; }
        app.render.write(C.green(`  effort: ${r.lane.effortLabel || 'default'}`) + C.dim(' — the model\'s default\n'));
        return;
      }
      const r = await choose(want);
      if (!r.ok) { app.render.write(C.yellow(`  ${r.why}`) + '\n'); return; }
      app.render.write(C.green(`  ${r.lane.modelLabel} · ${r.lane.effortLabel}`) + '\n');
    },
  });

  define('/api', {
    // AN INSPECTOR, despite also performing actions: `/api status` lists what the routes serve,
    // which is the last thing that should vanish on a timer. STAY is the default
    // and this comment is here so it is not "tidied" into a receipt later.
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[add|<provider>|<connection>|refresh [id]|status]  — keys are entered in the Model Dashboard',
    desc: 'Add or replace an API source in the Model Dashboard, or re-read what the APIs serve',
    /**
     * THE TERMINAL NEVER TAKES A KEY (Phase 8.3).
     *
     * `/api`, `/api add`, `/api <provider>` and `/api <route>` (re-key) open the
     * Model Dashboard at API — the one secure place a credential is entered. It
     * never appears in the terminal, its input history, a conversation, a log
     * or a model's context. The terminal hears back only the safe completion
     * event: "API added: DeepSeek API (lain:deepseek) · 12 models".
     *
     * A KEY PASTED HERE ANYWAY is not stored: it is registered with the
     * redactor, taken back out of the input history, and the person is told
     * where keys go. `refresh` and `status` are unchanged.
     */
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
        app.render.write(C.yellow('  Noema never takes a key in the terminal.') + ' /api add opens the Model Dashboard, where keys go.\n');
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
    // AN INSPECTOR, despite also performing actions: `/provider` defaults to a status listing, read exactly when a route is dead,
    // which is the last thing that should vanish on a timer. STAY is the default
    // and this comment is here so it is not "tidied" into a receipt later.
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[status|refresh [id]|disable <id>|enable <id>|maintenance <id>|retry <id>]',
    desc: 'Connection availability and catalog. Works while a provider is dead.',
    async run(app, { args }) {
      const sub = (args[0] || 'status').toLowerCase();
      const id = args[1];
      const w = (s) => app.render.write(s);

      // The one command that DOES contact a route — and only its catalog
      // endpoint, never a completion. Without an id it refreshes every route that
      // does not declare its own models.
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
        // ---- A LIMIT IS A CLOSED DOOR WITH A CLOCK ON IT, AND IT SAYS SO ----
        //
        // Not folded into the availability line above: `DEGRADED — rate
        // limited` is the status of a route somebody might reasonably try, and
        // the one thing that decides whether trying is pointless is the time.
        // A limit hydrated from an earlier session is marked, because "LAIN
        // learned this before you started it" is the answer to "why does it
        // think that when I have not called anything yet".
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
        // WHERE the model list came from. "declared" and "discovered" fail in
        // different ways and are fixed in different places, so they are never
        // collapsed into one number.
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
