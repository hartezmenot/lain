'use strict';

/** `/brief` — THE ENGINEERING BRIEFING. */

const briefing = require('./briefing');
const findings = require('./findings');
const facts = require('./facts');

/** How long any one external analyser may take before it is called a timeout. */
const ANALYZER_TIMEOUT_MS = 120_000;

/** Parse the flags. */
function parseArgs(argv = '') {
  const raw = String(argv || '').trim();
  const opts = { deadCode: false, residue: null, tests: false, full: false, detail: false };
  const words = raw.split(/\s+/).filter(Boolean);
  const gone = [];
  const removed = [];
  const present = [];
  for (const w of words) {
    if (w === '--dead' || w === '--deadcode') { opts.deadCode = true; continue; }
    if (w === '--tests') { opts.tests = true; continue; }
    // The long form is still here; it stopped being the DEFAULT for a person.
    if (w === '--full' || w === '--long') { opts.full = true; continue; }
    // WHERE THE `detail` PANE WENT
    if (w === 'detail' || w === '--detail') { opts.detail = true; continue; }
    if (w.startsWith('--gone=')) { gone.push(...w.slice(7).split(',').filter(Boolean)); continue; }
    if (w.startsWith('--removed=')) { removed.push(...w.slice(10).split(',').filter(Boolean)); continue; }
    if (w.startsWith('--present=')) { present.push(...w.slice(10).split(',').filter(Boolean)); continue; }
  }
  if (gone.length || removed.length || present.length) opts.residue = { gone, removed, present };
  return opts;
}

/** Run the project's own test command, when asked. */
async function runTests(root, cfgCommand) {
  const command = cfgCommand || null;
  if (!command) return null;
  const { run } = require('./tools/shell');
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const r = await run(command, { shell, cwd: root, timeoutMs: 600_000 });
  return {
    ok: !r.isError,
    command,
    exitCode: r.exitCode,
    output: r.output,
  };
}

/** Collect and render. Shared by the command and the tool so that the two can never drift into two different briefings. */
async function build(app, { argv = '', session = null, root: explicitRoot = null } = {}) {
  // The tool path knows the working directory as `ctx.cwd` and has no `app` session to read it from, so it passes it explicitly.
  const root = explicitRoot || (app && app.session && app.session.cwd) || process.cwd();
  const opts = parseArgs(argv);
  const sess = session || (app && app.session) || null;

  let testRun = null;
  if (opts.tests) {
    let cmd = null;
    try {
      const env = require('./environment').detect(root);
      cmd = env.testRunner ? env.testRunner.command : null;
    } catch { cmd = null; }
    testRun = await runTests(root, cmd);
  }

  const survey = require('./devtool').load('survey');   // the survey is a developer tool (tools/dev, S9)
  if (!survey) { app.render.write(`  ${require('./devtool').missing('survey')}\n`); return null; }
  const s = await survey.run({
    root,
    app,
    session: sess,
    testRun,
    residue: opts.residue,
    includeDeadCode: opts.deadCode,
    timeoutMs: ANALYZER_TIMEOUT_MS,
  });

  // STABLE IDS, AND WHAT CHANGED SINCE LAST TIME
  const ledger = findings.forSession(sess);
  const delta = ledger.record(s.findings, s.ran);
  // Facts get their own ledger and their own ids for the same reason findings do — `CONTRACT #014` has to survive a regeneration — and it reports a…
  const factLedger = facts.forSession(sess);
  const factDelta = factLedger.record(s.facts || []);
  return {
    // THE LONG FORM IS THE MODEL'S.
    text: briefing.render(s, delta, factDelta),
    survey: s,
    delta,
    factDelta,
    opts,
  };
}

/** Register `/brief`. */
function register({ define, C }) {
  define('/brief', {
    // MACHINERY GOES TO THE SURFACE
    surface: true,
    flashMs: 0,
    args: '[detail] [--tests] [--dead] [--full]',
    desc: 'Full engineering briefing: health on five axes, findings with ids and evidence, root causes',
    async run(app, ctx) {
      // `rest`, not `args`: the dispatcher hands `args` over as an ARRAY of words and `rest` as the raw remainder.
      const argv = (ctx && ctx.rest) || '';
      app.render.write(C.dim('  Surveying the project…\n'));
      let out;
      try {
        out = await build(app, { argv });
      } catch (e) {
        app.render.write(C.red(`  The survey failed: ${(e && e.message) || e}\n`));
        return;
      }
      // WHAT A PERSON SEES, AND WHAT A MODEL SEES
      if (out.opts.full) {
        app.render.write(`${out.text}\n`);
      } else if (out.opts.detail) {
        // THE EVIDENCE BEHIND THE COUNTS — what the DETAIL pane used to draw.
        // Same survey, second rendering; see `parseArgs`.
        const width = (app.render && app.render.width) || 80;
        app.render.write(`${require('./ui/contextview').render('detail', out.survey, {
          width, session: app.session, cwd: app.session && app.session.cwd,
        }).join('\n')}\n`);
      } else {
        const view = require('./ui/briefview');
        const width = (app.render && app.render.width) || 80;
        app.render.write(`${view.render(out.survey, {
          width, session: app.session, cwd: app.session && app.session.cwd,
        }).join('\n')}\n`);
      }
    },
  });
}

module.exports = { register, build, parseArgs, runTests, ANALYZER_TIMEOUT_MS };
