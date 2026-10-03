'use strict';

/** `/token` — WHAT THIS CONVERSATION HAS COST, AND WHAT IT IS MADE OF. */

const { C } = require('./render');

/** A literal newline, written this way for the reason commands.js states. */
const EOL = String.fromCharCode(10);

function register({ define }) {
  /** `/tokens` — WHERE THE INPUT WENT, for the requests this turn actually made. */
  const EOL = String.fromCharCode(10);

  /** `/token` — THE WHOLE OF THE TOKEN ACCOUNTING, on demand. */
  define('/token', {
    flashMs: 0,
    surface: true,
    desc: 'The full token account: session totals, context occupancy, and what the last requests carried',
    run(app) {
      const w = (s) => app.render.write(s);
      const turns = (app.session && app.session.turns) || [];

      // 1. HOW MUCH OF THE WINDOW IS OCCUPIED
      try {
        let pc = {};
        try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
        const ctx = require('./ui/projection').contextUsage(app, pc);
        w(EOL + C.bold('Context window') + C.dim('  — estimated; what a new request would carry') + EOL);
        if (ctx) {
          const pct = Math.round((ctx.used / ctx.window) * 100);
          w(`  ${ctx.used.toLocaleString('en-US')} of ${ctx.window.toLocaleString('en-US')} tokens  ${C.dim(`(${pct}%)`)}` + EOL);
        } else {
          w(C.dim('  unknown — this route states no context length, so there is no denominator' + EOL));
        }
        // WHAT THE LAST COMPACTION KEPT
        const kept = require('./continuity').compactionSummary(app.session).kept;
        if (kept.length) w(C.dim('  kept through compaction: ' + kept.join(' · ') + EOL));
      } catch { /* the sections below still stand */ }

      // 2. WHERE THE LAST REQUEST'S INPUT WENT
      const audits = (turns.length && turns[turns.length - 1].audits) || [];
      w(EOL + C.bold('Token accounting') + C.dim('  — estimated from characters; see src/tokenaudit.js') + EOL);
      if (!audits.length) {
        w(C.dim('  no request has been measured yet in this session.' + EOL));
      } else {
        const ta = require('./devtool').load('tokenaudit') || { report: () => [require('./devtool').missing('tokenaudit')] };
        // THE LAST FEW, NEWEST LAST, because the question is always about the
        // request that just happened and how it compares with the one before.
        for (let i = 0; i < audits.length; i++) {
          for (const line of ta.report(audits[i], { n: i + 1 })) w(C.dim('  ' + line) + EOL);
          w(EOL);
        }
        const last = audits[audits.length - 1];
        // AMPLIFICATION, MEASURED NOT ENFORCED: real provider requests the session made per turn it recorded.
        const turnsAll = turns.filter((x) => x.usage && x.usage.requests > 0);
        if (turnsAll.length) {
          const reqs = turnsAll.reduce((a, x) => a + x.usage.requests, 0);
          const steps = turnsAll.reduce((a, x) => a + (x.steps || 1), 0);
          w(C.dim(`  amplification: ${reqs} request(s) over ${turnsAll.length} turn(s), ${steps} model step(s)`)
            + (reqs > steps ? C.yellow(` — ${reqs - steps} retry/fold attempt(s)`) : '') + EOL);
        }
        if (last && last.overBudget) {
          w('  ' + C.yellow('this request was over budget and was compacted before it was sent') + EOL);
        }
      }

      // 2b. WARM UNCACHED INPUT (cacheledger.js)
      {
        const cl = require('./cacheledger');
        const rows = cl.rows(app.session);
        if (rows.length) {
          const s = cl.summary(rows);
          const p = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
          w(EOL + C.bold('Uncached input') + C.dim(`  — warm target ≤ ${p(s.target)}, ceiling ≤ ${p(s.ceiling)}`) + EOL);
          w(C.dim(`  ${s.warm} warm · ${s.cold} cold · ${s.epochResets} epoch reset(s) · ${s.unreported} not reported`) + EOL);
          w(`  median ${p(s.median)} · p90 ${p(s.p90)} · worst normal ${p(s.worstNormal)} · over ceiling ${s.overCeiling}` + EOL);
          w(C.dim(`  warm totals: input ${s.totals.input.toLocaleString('en-US')} · cached ${s.totals.cached.toLocaleString('en-US')} · uncached ${s.totals.uncached.toLocaleString('en-US')} · mean prompt ${s.meanPrompt == null ? '—' : s.meanPrompt.toLocaleString('en-US')}`) + EOL);
          const last = rows[rows.length - 1];
          w(C.dim(`  last: ${last.warmth}${last.epochReason ? ` (${last.epochReason})` : ''} · epoch ${last.epoch} · billed ${p(last.actual.ratio)} · expected ${p(last.expected.ratio)}`
            + `${last.owners.length ? ` · new bytes: ${last.owners.slice(0, 3).map((o) => `${o.owner} ${o.chars}`).join(', ')}` : ''}`) + EOL);
          for (const e of s.exceptions.slice(-3)) w(C.yellow(`  exception ${p(e.ratio)}: ${e.reason} — ${e.owners.map((o) => o.owner).join(', ')}`) + EOL);
        }
      }

      // 3. THE SESSION LEDGER
      const ui = app.ui || {};
      for (const line of require('./ui/tokenview').render({
        usage: (app.session && app.session.usage) || null,
        live: ui.liveUsage || null,
        audit: ui.lastAudit || null,
        requests: (app.session && app.session.usage && app.session.usage.requests) || 0,
        open: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
        model: app.cfg.model || '',
        width: (app.render && app.render.width) || 80,
      })) w(line + EOL);
    },
  });
}

module.exports = { register };
