'use strict';

/** WATCH SOMETHING RUN, WITHOUT WATCHING IT — the tool half of observe.js. */

const observe = require('../observe');
const correlate = require('../correlate');
const computer = require('../computer');
const cap = require('../capability');
const { via, KIND } = require('./via');

/** The observatory for this session, created on first use. */
function observatoryOf(app) {
  if (!app._observatory) app._observatory = new observe.Observatory();
  return app._observatory;
}

/** TAKE A LOOK, BECAUSE A RULE ASKED FOR ONE. */
async function capture(app, rule, obs) {
  try {
    const shot = await computer.perform(app, 'screenshot', {}, { why: `${rule.name} — ${rule.why || 'worth a look'}` });
    if (shot.stage !== cap.STAGE.SUCCEEDED) {
      obs.addCapture({ rule: rule.name, kind: 'screenshot', ok: false, why: shot.why || shot.stage });
      return;
    }
    const path = (shot.result && (shot.result.path || shot.result.file)) || '';
    // OCR IS A SEPARATE CHANNEL and may be closed on its own — a machine that allows screenshots but not text extraction is a real configuration, and the…
    const read = await computer.perform(app, 'ocr', {}, { why: `read the screen for ${rule.name}` });
    const text = read.stage === cap.STAGE.SUCCEEDED
      ? String((read.result && (read.result.text || read.result.ocr)) || '')
      : '';
    obs.addCapture({ rule: rule.name, kind: 'screenshot', ok: true, path, text,
      why: text ? '' : `not read — ${read.why || read.stage}` });
  } catch (e) {
    obs.addCapture({ rule: rule.name, kind: 'screenshot', ok: false, why: (e && e.message) || 'capture failed' });
  }
}

const tools = {};

tools.observe_start = {
  mutates: true,
  schema: {
    name: 'observe_start',
    description:
      'Run something and WATCH IT WITHOUT LOOKING AT IT — a bot, a game script, a long automation. '
      + 'Say what it should do and which output lines matter; LAIN then stays quiet while it runs '
      + 'and captures the screen only when a rule you marked `capture` fires. '
      + 'DO NOT take screenshots in a loop while it runs: that costs a request per glance and still '
      + 'misses anything shorter than the gap between them. Call observe_stop ONCE when it should '
      + 'end, or when the user says stop, and read everything back then.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command that starts the run' },
        expectation: {
          type: 'array', items: { type: 'string' },
          description: 'what SHOULD happen, in order, in plain words. Recorded before the run so the '
            + 'evidence can be compared against it afterwards rather than described to fit it.',
        },
        rules: {
          type: 'array',
          description: 'lines worth noticing. Mark `capture: true` on the few that are worth a screenshot.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'what this event IS, e.g. MINIGAME_STARTED' },
              pattern: { type: 'string', description: 'a regular expression matched against each output line' },
              capture: { type: 'boolean', description: 'take a screenshot + OCR when this fires' },
              why: { type: 'string', description: 'why it matters — the user reads this' },
            },
            required: ['name', 'pattern'],
          },
        },
        shell: { type: 'string', description: 'bash | powershell | cmd' },
      },
      required: ['command'],
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    if (!app) return { output: 'observation is not available in this context', isError: true };
    const command = String(input.command || '').trim();
    if (!command) return { output: 'observe_start needs a command', isError: true };

    const rules = Array.isArray(input.rules) ? input.rules : [];
    let begun;
    try {
      begun = observatoryOf(app).begin({
        command,
        expectation: input.expectation,
        rules,
      });
    } catch (e) {
      // A BAD REGULAR EXPRESSION IS THE MODEL'S TYPO, not a crash. It is told
      // which pattern and why, so the next call can fix it.
      return { output: `that rule will not compile: ${e && e.message}`, isError: true };
    }
    if (!begun.ok) return { output: begun.why, isError: true };
    const obs = begun.observation;

    const jobsMod = require('./jobs');
    const started = jobsMod.startFor(app, ctx, { command, shell: input.shell });
    if (!started.ok) return { output: started.why, isError: true };
    started.job.kind = 'monitor';   // a watched run is a MONITOR on the activity line, not a shell

    observe.attach(obs, started.job, (rule) => capture(app, rule, obs));
    // WHEN THE RUN ENDS BY ITSELF the observation ends with it. A bot that
    // crashes must not leave LAIN believing it is still being watched.
    Promise.resolve(started.job.wait()).then((s) => {
      if (obs.running) {
        observe.finish(obs, `the run ended by itself (${s.state})`);
        obs.note(observe.SOURCE.PROCESS, 'EXIT', `exit code ${s.exitCode}`);
      }
    }).catch(() => {});

    const capturing = obs.rules.filter((r) => r.capture).map((r) => r.name);
    return {
      output: `${via(KIND.JOB)} OBSERVING ${obs.id} — ${command}\n`
        + `job ${started.job.id}. ${obs.rules.length} rule(s); `
        + (capturing.length ? `screen captured on: ${capturing.join(', ')}.` : 'no rule captures the screen.')
        + '\nLAIN is now quiet and costs nothing while it runs. Say what you are doing, answer the '
        + 'user, and call observe_stop ONCE when it should end. Do not screenshot in a loop.',
      meta: { observation: obs.id, job: started.job.id },
    };
  },
};

tools.observe_stop = {
  mutates: true,
  schema: {
    name: 'observe_stop',
    description:
      'Stop the run and read back everything that was collected: the log events, the screen '
      + 'captures, and how the two compare. ONE call — this is where the investigation happens. '
      + 'Stopping the run does NOT stop the investigation; the evidence is kept and is the point.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the observation id; the current one by default' },
        claims: {
          type: 'array', items: { type: 'string' },
          description: 'event names that ASSERT something about the screen, e.g. ROUND_COMPLETE',
        },
        expect: {
          type: 'object',
          description: 'per claim, what the screen should and should not show if it is true: '
            + '{"ROUND_COMPLETE": {"present": ["score"], "absent": ["minigame"]}}',
        },
        watch_for: {
          type: 'array', items: { type: 'string' },
          description: 'words whose appearance on screen is notable even with no log line',
        },
        reason: { type: 'string', description: 'why it is stopping — the user reads this' },
      },
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    if (!app) return { output: 'observation is not available in this context', isError: true };
    const yard = observatoryOf(app);
    const obs = input.id ? yard.find(String(input.id)) : yard.current;
    if (!obs) return { output: 'nothing is being observed', isError: true };

    obs.state = observe.STATE.STOP_REQUESTED;
    // THE PROCESS FIRST, then the reading.
    if (obs.job && typeof obs.job.cancel === 'function' && !obs.job.done) {
      try { obs.job.cancel('you stopped the run'); } catch { /* already gone */ }
    }
    observe.finish(obs, String(input.reason || 'you stopped it'));
    obs.state = observe.STATE.ANALYZING;

    const result = correlate.compare(obs, {
      claims: Array.isArray(input.claims) ? input.claims : [],
      expect: input.expect && typeof input.expect === 'object' ? input.expect : {},
      watchFor: Array.isArray(input.watch_for) ? input.watch_for : [],
    });

    const s = obs.summary();
    const out = [];
    out.push(`${via(KIND.JOB)} STOPPED ${obs.id} — ${obs.stopReason}`);
    out.push(`ran ${Math.round(s.elapsedMs / 1000)}s · ${s.lines} output line(s) · ${s.events} event(s) · `
      + `${s.captures} capture(s)${s.capturesRefused ? `, ${s.capturesRefused} refused` : ''}`);
    if (s.expectation.length) {
      out.push('', 'EXPECTED (recorded before the run):');
      s.expectation.forEach((e, i) => out.push(`  ${i + 1}. ${e}`));
    }
    if (s.kinds.length) {
      out.push('', 'WHAT HAPPENED:');
      for (const k of s.kinds) out.push(`  ${k.kind} ×${k.n}`);
    }
    const lines = correlate.lines(result);
    if (lines.length) {
      out.push('', 'LOG AGAINST SCREEN:');
      for (const l of lines) out.push(`  ${l}`);
    } else {
      out.push('', 'LOG AGAINST SCREEN: nothing to compare — no claim had a capture near it.');
    }
    if (result.question) {
      // A CONTRADICTION IS A QUESTION FOR THE USER, and it is stated as one.
      // LAIN does not get to decide which source is wrong.
      out.push('', 'CONTRADICTION — ask the user before concluding anything:',
        `  ${result.question.why}`,
        '  Use ask_user: they know what that screen is supposed to look like and you do not.');
    }
    // CHANNELS THAT WERE SHUT are part of the evidence: a claim nothing could check is unresolved BECAUSE of a permission decision, not because the bot…
    const shut = computer.channelsOf(app);
    const brief = shut ? shut.brief() : '';
    if (brief) out.push('', brief);

    obs.state = result.question ? observe.STATE.WAITING_FOR_USER : observe.STATE.COMPLETED;
    yard.retire(obs);
    return { output: out.join('\n'), meta: { observation: obs.id, counts: result.counts } };
  },
};

module.exports = { tools, capture, observatoryOf };
