'use strict';

/** THE TWO TEST QUESTIONS, AS TWO TOOLS. */

const path = require('path');

const testing = require('../testing');
const shell = require('./shell');
const execution = require('../execution');
const environment = require('../environment');

/** A suite gets longer than an ordinary command: a real one takes minutes. */
const DEFAULT_TIMEOUT_MS = 600000;

/** A GREEN SUITE'S PER-TEST LINES ARE NOT EVIDENCE. */
const QUIET_PASS_MIN_CHARS = 4000;
const QUIET_PASS_MIN_LINES = 40;
/** One line that says one test passed, across the runners a project is likely to use: ✓/✔/√ (mocha, vitest, jest, this repo), TAP `ok 12 - name`… */
const PASS_LINE = /^\s*(?:[✓✔√]\s|ok\s+\d+\s|.+\s\.{3}\s+ok\s*$|\S+::\S+\s+PASSED\b)/u;

/** Drop the per-test confirmations from an output that already passed. */
function quietPass(output) {
  const text = String(output == null ? '' : output);
  if (text.length < QUIET_PASS_MIN_CHARS) return { text, dropped: 0 };
  const lines = text.split('\n');
  if (lines.length < QUIET_PASS_MIN_LINES) return { text, dropped: 0 };
  const kept = lines.filter((l) => !PASS_LINE.test(l));
  const dropped = lines.length - kept.length;
  // Nothing recognisable was found, so this runner reports in a shape these
  // patterns do not cover. Say nothing and change nothing.
  if (dropped < QUIET_PASS_MIN_LINES) return { text, dropped: 0 };
  return { text: kept.join('\n'), dropped };
}

function resolveCwd(ctx, input) {
  const base = (ctx && ctx.cwd) || process.cwd();
  const want = input && input.cwd ? String(input.cwd).trim() : '';
  if (!want) return base;
  return path.isAbsolute(want) ? want : path.resolve(base, want);
}

const tools = {
  discover_tests: {
    mutates: false,
    schema: {
      name: 'discover_tests',
      description: 'Find out whether this project has tests, and how they are run — WITHOUT running them. '
        + 'Reads manifests (package.json scripts, pytest.ini, Cargo.toml, go.mod, Makefile targets, CI workflows) '
        + 'and walks the tree for test files. Returns NO_TESTS_FOUND or TESTS_FOUND_NOT_RUN, the exact commands, '
        + 'the file counts, and — when nothing is found — where it looked. '
        + 'Call this before saying anything about a project\'s tests: "there are no tests" is a claim that needs '
        + 'a search behind it, and this is the search. It costs nothing and spawns no process.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'directory to inspect; defaults to the working directory' },
        },
      },
    },
    async run(input, ctx) {
      const cwd = resolveCwd(ctx, input);
      let report;
      try { report = testing.discover(cwd); } catch (e) {
        return { output: `could not inspect ${cwd}: ${(e && e.message) || e}`, isError: true };
      }
      const out = testing.lines(report).join('\n');
      return {
        output: out,
        meta: {
          testState: report.state,
          suites: report.suites.map((s) => s.command),
          testFiles: report.files.count,
        },
      };
    },
  },

  run_tests: {
    // A suite runs the project's own code, which may write anything.
    mutates: true,
    schema: {
      name: 'run_tests',
      description: 'Actually run this project\'s tests and report a CLASSIFIED result. '
        + 'Discovers the command if you do not pass one. Returns one of TESTS_PASSED, TESTS_FAILED, '
        + 'TESTS_BLOCKED (something outside the code stopped it — a rate limit, a quota, a missing dependency, '
        + 'a runner that is not installed), TESTS_PARTIAL (some ran, some were skipped or blocked) or '
        + 'NO_TESTS_FOUND. A BLOCKED result is NOT a failing test and is not a reason to change code — '
        + 'it names the layer that stopped the run. Use this rather than reading an exit code yourself.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the exact command to run; omit to use the discovered one' },
          which: {
            type: 'string',
            description: '"project" (default) for the real suite, "smoke" for a quick start-up check',
          },
          cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
          force: { type: 'boolean',
          description: 'run the suite even if fast diagnostics report an error in a file you changed (default false)' },
        timeout_ms: { type: 'number', description: 'optional timeout in milliseconds' },
        },
      },
    },
    async run(input, ctx) {
      const cwd = resolveCwd(ctx, input);

      // THE CHEAP CHECK GOES FIRST
      const gate = await require('../pretest').guard(ctx, cwd, input);
      const advisory = gate.advisory ? `${gate.advisory}\n\n` : '';

      const report = testing.discover(cwd);

      let command = String((input && input.command) || '').trim();
      let chosen = null;
      if (!command) {
        const which = String((input && input.which) || 'project').toLowerCase();
        const wantSmoke = which === 'smoke';
        chosen = wantSmoke
          ? report.suites.find((s) => s.kind === testing.KIND.SMOKE) || testing.primary(report)
          : testing.primary(report);
        if (!chosen) {
          // NOT A FAILURE OF THE TOOL, and the difference matters: the model asked a reasonable question and the honest answer is that this tree does not say how…
          return {
            output: testing.lines(report).join('\n')
              + '\n\nNothing was run — no command was given and none could be discovered.',
            meta: { testState: report.state },
          };
        }
        command = chosen.command;
      }

      const preferred = environment.detectShell().preferred;
      const sh = preferred === 'powershell' ? 'powershell' : (preferred === 'cmd' ? 'cmd' : 'bash');

      const r = await shell.run(command, {
        shell: sh,
        cwd,
        timeoutMs: Number(input && input.timeout_ms) || DEFAULT_TIMEOUT_MS,
        signal: ctx && ctx.signal,
        detach: ctx && ctx.app ? { app: ctx.app, label: command, tool: 'run_tests', turnId: ctx.turnId, cwd, input: input || {} } : null,
      });

      // The user stopping it is the user's decision, not a verdict about tests.
      if (r.interrupted) return { output: r.output, isError: true, meta: { testState: null } };
      if (r.detached) return { output: r.output, meta: { testState: null, detached: true, jobId: r.jobId } };

      // `r` already carries `exitCode`, which is the field execution.classify reads.
      const { text, verdict } = execution.annotate({ ...r, shell: sh, cwd, command });
      const v = testing.classifyRun({
        output: r.output,
        stderr: r.stderr,
        code: r.exitCode,
        timedOut: r.timedOut,
        classification: verdict.class,
      });

      const head = [
        v.state,
        `  command: ${command}${chosen ? `   (${chosen.from})` : ''}`,
        `  ${v.why}`,
        v.counts.seen
          ? `  counts: ${v.counts.passed} passed, ${v.counts.failed} failed`
            + (v.counts.skipped ? `, ${v.counts.skipped} skipped` : '')
          : '  counts: the runner printed none',
      ];
      // KEYED ON THE LAYER, NOT ON THE STATE.
      if (v.layer) {
        head.push(`  THIS IS NOT A CODE FAILURE — the layer that stopped it is ${v.layer}.`);
        head.push('  Do not change code to "fix" it. Say what is blocked and why.');
      } else if (v.state === testing.STATE.TESTS_PARTIAL) {
        head.push('  Some tests were SKIPPED. What ran passed; what was skipped was not measured.');
      }

      // ONLY THE GREEN PATH IS QUIETENED — see quietPass. A failing, blocked or
      // partial run returns every byte it produced.
      let body = r.output;
      if (v.state === testing.STATE.TESTS_PASSED) {
        const q = quietPass(r.output);
        if (q.dropped) {
          // THE ADVICE HERE IS THE TARGETED ONE, deliberately.
          body = `${q.text}\n\n[${q.dropped} individually passing test line(s) removed from this result — `
            + `the counts above are the complete verdict. To see one test by name, run the suite `
            + `with the runner's own filter for it (e.g. \`-t\`/\`--filter\`/\`-k\`) rather than `
            + `re-running everything.]`;
        }
      }

      // THE RUN IS VERIFICATION EVIDENCE, recorded against the contract with the evidence state its runner earns (a unit tier is FIXTURE, not LIVE).
      if (v.state !== testing.STATE.TESTS_BLOCKED && ctx && ctx.session) {
        try {
          const contract = require('../verifycontract');
          const c = contract.contractFor(ctx.session);
          contract.record(ctx.session, { command, ok: v.state === testing.STATE.TESTS_PASSED, level: c.level });
        } catch { /* the result stands without the record */ }
      }

      return {
        output: `${advisory}${head.join('\n')}\n\n${execution.leadWith(body, text)}`,
        // A BLOCKED RUN IS AN ERROR RESULT and a PASSED one is not; PARTIAL is
        // not an error either, because the tests that ran really did pass.
        isError: v.state === testing.STATE.TESTS_FAILED || v.state === testing.STATE.TESTS_BLOCKED,
        exitCode: r.exitCode == null ? null : r.exitCode,
        meta: {
          testState: v.state,
          counts: v.counts,
          layer: v.layer,
          command,
          shell: sh,
          cwd,
          classification: verdict.class,
        },
      };
    },
  },
};

module.exports = { tools, DEFAULT_TIMEOUT_MS, quietPass, PASS_LINE };
