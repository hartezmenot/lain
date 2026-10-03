'use strict';

/** THE REPORT COMMANDS — read something and say what is true of it. */

/** passed in rather than imported back. */
function register({ define, C, config }) {
  /** WHAT SURVIVED THE REWRITE, AND WHAT QUIETLY DID NOT. */
  define('/compare', {
    // MACHINERY: LAIN talking about itself, not about the work. Goes to the
    // command panel, never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    args: '[<folder|github-url> | add <capability>]',
    desc: 'Compare this project against another version, capability by capability',
    run(app, ctx) { const cmp = require('./devtool').load('compare'); if (!cmp) { app.render.write(`  ${require('./devtool').missing('compare')}\n`); return null; } return cmp.runCommand(app, ctx, { C, config }); },
  });

  /** TWO HEALTH QUESTIONS, TWO COMMANDS. */
  define('/health', {
    surface: true,
    flashMs: 0,
    args: '[folder]',
    desc: 'Is THIS project healthy? Structure, code health, work state, next action',
    run(app, ctx) { return require('./projecthealth').runCommand(app, ctx, { C }); },
  });

  define('/ready', {
    surface: true,
    flashMs: 0,
    desc: 'Is LAIN ready? RC-readiness for the CLI itself (not the project)',
    run(app, ctx) { return require('./health').runCommand(app, ctx, { C }); },
  });

  /** WHY DID THAT COST SEVEN REQUESTS? */
  define('/requests', {
    surface: true,
    flashMs: 0,
    desc: 'Every provider request this session made, with the reason for each',
    run(app) {
      const reqtrace = require('./reqtrace');
      const rows = reqtrace.all();
      app.render.write('\n' + C.bold('Provider requests') + '\n');
      if (!rows.length) {
        app.render.write('  ' + C.dim('none yet — no request has reached the wire this session') + '\n');
        return;
      }
      const turns = (app.session.turns || []).map((t) => t.turnId).filter(Boolean);
      for (const id of turns) {
        const e = reqtrace.explain(id);
        if (!e) continue;
        const flag = e.duplicated ? C.yellow(`  ⚠ ${e.duplicated} repeated step(s)`) : '';
        app.render.write(`\n  ${C.bold(id)}  ${e.requests} request(s) · ${e.steps} model step(s)${flag}\n`);
        for (const r of e.rows) {
          const mark = r.ok === null ? '·' : r.ok ? '✓' : '✗';
          const where = r.step == null ? '' : ` step ${r.step}`;
          const why = r.ok === false ? `  ${C.red(r.failure.slice(0, 60))}` : '';
          app.render.write(`    ${mark} ${r.id.padEnd(5)} ${r.reason.padEnd(17)}${where.padEnd(8)} ${String(r.ms).padStart(6)}ms${why}\n`);
        }
      }
      // Requests with no turn are the machinery: catalog discovery, a review.
      const loose = rows.filter((r) => !r.turn);
      if (loose.length) {
        app.render.write(`\n  ${C.bold('not part of a turn')}\n`);
        for (const r of loose) {
          app.render.write(`    ${r.ok === false ? '✗' : '✓'} ${r.id.padEnd(5)} ${r.reason.padEnd(17)}${String(r.ms).padStart(6)}ms\n`);
        }
      }
    },
  });

  /** WHAT NOTHING REACHES — the capability the design names as missing. */
  define('/deadcode', {
    surface: true,
    flashMs: 0,
    args: '[all]',
    desc: 'Find code nothing reaches — graded, with the evidence',
    run(app, { args } = {}) {
      const dead = require('./devtool').load('deadcode');
      if (!dead) { app.render.write(`  ${require('./devtool').missing('deadcode')}\n`); return null; }
      const w = (s) => app.render.write(s);
      const all = String(args[0] || '').toLowerCase() === 'all';
      w('\n' + C.bold('  Reading every reference in this tree…') + '\n');
      const r = dead.sweep(app.cwd, {});
      // THE CONFIDENT ONES FIRST AND ALONE, unless asked otherwise. Two hundred
      // rows of "this export is unused" is how the six that matter get missed.
      const rows = all ? r.findings : r.findings.filter((f) => f.confidence === dead.CONFIDENCE.CONFIRMED);
      if (!rows.length) {
        w(C.green('  Nothing unreachable was found.')
          + C.dim(` ${r.looked} exported name(s) across ${r.modules} module(s).\n`));
        return;
      }
      w(C.dim(`  ${r.looked} exported name(s) across ${r.modules} module(s)`)
        + C.dim(all ? '\n' : ` · ${r.findings.length - rows.length} lower-confidence row(s) hidden — /deadcode all\n`));
      for (const f of rows) {
        const colour = f.verdict === dead.VERDICT.UNREFERENCED ? C.yellow : C.dim;
        w('\n  ' + colour(f.verdict) + '  ' + C.bold(`${f.module} · ${f.name}`) + '\n');
        w(C.dim(`      ${f.why}\n`));
        for (const t of f.testRefs.slice(0, 2)) w(C.dim(`      test: ${t.file}:${t.line}\n`));
      }
      if (r.truncated) w(C.dim(`\n  stopped after ${r.looked} names — there are more\n`));
    },
  });

  /** The environment report. The checks themselves live in diagnose.js. */
  // CACHE AND TEMPORARY FILES (cachecare.js) — the same owner as `lain cache` and Settings › Storage.
  define('/cache', {
    surface: true,
    flashMs: 0,
    args: '[inspect | clear [ids…] [--yes]]',
    desc: 'Show or clear LAIN\'s disposable cache and temporary files — sessions, accounts and settings stay',
    async run(app, { args = [] } = {}) {
      const verb = args[0] || 'inspect';
      const out = { write: (s) => app.render.write(s) };
      await require('./cachecare').cli([verb === 'clear' || verb === 'inspect' ? verb : 'help', ...args.slice(1)], { out, app });
    },
  });

  define('/update', {
    surface: true,
    flashMs: 0,
    args: '[now | after-checkpoint | after-task | later | check]',
    desc: 'Check for a LAIN update, or choose when a downloaded one restarts LAIN — never in the middle of a step',
    async run(app, { args = [] } = {}) {
      app.render.write(`  ${await require('./update/cli').command(app, args[0] || '')}
`);
    },
  });

  define('/doctor', {
    surface: true,
    flashMs: 0,
    desc: 'Check the environment LAIN is running in',
    async run(app) {
      app.render.write('\n' + C.bold('Doctor') + '\n');
      app.render.write(require('./bot/service').describe(await require('./bot/service').control()) + '\n');
      for (const c of require('./diagnose').checks(app)) {
        app.render.write((c.ok ? C.green('  ✓ ') : C.yellow('  ⚠ ')) + c.text + '\n');
      }
      // ARCHITECTURE vs DISK, re-measured now — one of the four places reconciliation is allowed to run (session start, here, explicit inspection, handover)…
      const root = app.session ? app.session.cwd : process.cwd();
      const lainstore = require('./lainstore');
      if (lainstore.has(root, 'architecture')) {
        const reconcile = require('./reconcile');
        const { model, report } = reconcile.run(root);
        for (const l of reconcile.say(model, report).split('\n')) {
          if (l.trim()) app.render.write((/discrepanc|MISSING|DAMAGED|DRIFTED/i.test(l) ? C.yellow('  ⚠ ') : C.dim('  · ')) + l + '\n');
        }
      }
    },
  });
}

module.exports = { register };
