'use strict';

/** `/jobs`, `/bg` and `/cancel` — the smallest interface to work in flight. */

const { STATE } = require('./jobs');
/** How much of a job's own account `/jobs <n>` shows. Enough to judge it by. */
const MAX_DETAIL_ACTIONS = 20;
const MAX_DETAIL_SAID = 6;
// `/steer` (moved here from commands.js) resolves a routing steer through the
// same owner it always did. One implementation, one file to read.
const failover = require('./failover');

/** Marks the row so a glance finds the one that is not going to change. */
function mark(job, C) {
  if (job.state === STATE.SUCCEEDED) return C.green('✓');
  if (job.state === STATE.FAILED) return C.yellow('✗');
  if (job.state === STATE.CANCELLED) return C.dim('■');
  return job.waiting ? C.yellow('◒') : C.cyan('●');
}

/** HOW LONG A JOB HAS BEEN AT IT — `00:03:18`, the same shape as everything else. */
const elapsedOf = (ms) => require('./ui/workclock').hhmmss(ms);

/** One row per job: what it is, what it is doing, how long it has been at it. */
function rows(app, C) {
  const all = app.jobs.all();
  const shells = (app._jobs ? app._jobs.all() : []).map((j) => { const s = j.summary(); return `  ${C.dim(`#${s.id}`)} ${s.done ? (s.exitCode === 0 ? C.green('COMPLETED') : C.yellow(s.state)) : C.cyan('RUNNING')}  ${String(j.label || s.command).replace(/\s+/g, ' ').slice(0, 46)}${C.dim(' ·bg')}  ${C.dim(elapsedOf(s.elapsedMs))}`; });
  const ends = C.dim('  Background jobs end when LAIN exits.');
  if (!all.length && !shells.length) return [C.dim('  Nothing has been started yet.'), ends];
  return [...shells, ...all.map((j) => {
    const id = C.dim(`#${j.id}`);
    const state = j.state === STATE.SUCCEEDED ? C.green('COMPLETED')
      : j.state === STATE.FAILED ? C.yellow('FAILED')
        : j.state === STATE.CANCELLED ? C.dim('CANCELLED')
          : j.waiting ? C.yellow('WAITING') : C.cyan('RUNNING');
    const what = String(j.request).replace(/\s+/g, ' ').slice(0, 46);
    const where = j.primary ? '' : C.dim(' ·bg');
    return `  ${mark(j, C)} ${id} ${state}  ${what}${where}  ${C.dim(elapsedOf(j.elapsedMs))}`;
  }), ends];
}

/** Everything known about one job, for `/jobs <n>`. */
function detail(app, id, C) {
  const j = app.jobs.get(id);
  if (!j) return [C.dim(`  No job #${id}. /jobs to see what there is.`)];
  const out = [
    `  ${mark(j, C)} ${C.bold(`#${j.id}`)}  ${j.label}${j.primary ? C.dim('  (the conversation)') : C.dim('  (background)')}`,
    '',
    `  ${C.dim('request  ')} ${String(j.request).replace(/\s+/g, ' ').slice(0, 200)}`,
    `  ${C.dim('doing    ')} ${j.activity}`,
    `  ${C.dim('elapsed  ')} ${elapsedOf(j.elapsedMs)}`,
  ];
  if (j.needsInput) {
    out.push('', `  ${C.yellow('NEEDS INPUT')}  ${j.question.question}`);
    j.question.options.forEach((o, i) => out.push(`  ${C.dim(String(i + 1) + '.')} ${o}`));
    out.push('', C.dim(`  /answer ${j.id} <your answer>  — it resumes where it stopped`));
  }
  if (j.error) out.push(`  ${C.dim('why      ')} ${C.yellow(j.error)}`);
  const rec = j.result;
  if (rec) {
    const calls = rec.actions ? rec.actions.length : (rec.toolCalls || 0);
    out.push(`  ${C.dim('result   ')} ${calls} tool call(s)`);
    if (rec.text) out.push(`  ${C.dim('said     ')} ${String(rec.text).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  // THE WHOLE ACCOUNT, NOT A SUMMARY OF IT
  const acts = [];
  for (const t of (j.session && j.session.turns) || []) {
    for (const a of (t.actions || [])) acts.push(a);
  }
  if (acts.length) {
    out.push('', `  ${C.dim('WHAT IT DID')}`);
    for (const a of acts.slice(-MAX_DETAIL_ACTIONS)) {
      const mark = a.ok === false ? C.yellow('✗') : C.dim('·');
      out.push(`  ${mark} ${C.dim(String(a.name || '').padEnd(14))} ${String(a.target || '').slice(0, 60)}`);
    }
    if (acts.length > MAX_DETAIL_ACTIONS) {
      out.push(C.dim(`    … ${acts.length - MAX_DETAIL_ACTIONS} earlier operation(s) not shown`));
    }
  }
  const said = ((j.session && j.session.turns) || [])
    .flatMap((t) => (t.narration || []).map((n) => String(n.text || '')))
    .filter(Boolean);
  if (said.length) {
    out.push('', `  ${C.dim('WHAT IT SAID')}`);
    for (const line of said.slice(-MAX_DETAIL_SAID)) {
      out.push(`    ${String(line).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (j.session && j.session.id) out.push('', C.dim(`  its own session: ${j.session.id}`));
  if (!j.done) out.push('', C.dim(`  /cancel ${j.id} stops it · /steer ${j.id} <instruction> corrects it`));
  return out;
}

function register({ define, C, FLASH_MS }) {
  // /steer MOVED HERE, UNCHANGED IN MEANING
/** `/steer` — CORRECT THE WORK THAT IS ALREADY RUNNING. */
define('/steer', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '<instruction>  ·  to <provider|model>  ·  routes',
  desc: 'Correct the running task at its next model turn, or move it to another provider/model',
  run(app, { rest }) {
    if (!rest) {
      app.render.write(C.dim('  Usage: /steer stop editing files and read the logs first\n'));
      return;
    }
    // A ROUTING STEER FIRST — and only when the words genuinely name a route.
    const routed = failover.steer(app, rest);
    if (routed.handled) {
      app.render.write((routed.ok ? C.green(`  ${routed.message}`) : C.dim(`  ${routed.message}`)) + '\n');
      if (routed.detail) app.render.write(C.dim(`${routed.detail}\n`));
      return;
    }

    // `/steer <n> <instruction>` REACHES A BACKGROUND JOB
    const aimed = /^(\d+)\s+(\S[\s\S]*)$/.exec(rest);
    if (aimed) {
      const job = app.jobs.get(aimed[1]);
      if (job && !job.primary && !job.done) {
        if (!Array.isArray(job.steerQueue)) job.steerQueue = [];
        job.steerQueue.push(aimed[2]);
        app.jobs.changed();
        app.render.write(C.green(`  ⚑ STEER #${job.id}`) + C.dim(' — queued for its next model turn\n'));
        app.render.write(C.dim(`    ${aimed[2]}\n`));
        return;
      }
      if (job && job.done) {
        app.render.write(C.dim(`  #${job.id} has already ${String(job.state).toLowerCase()} — nothing to steer.\n`));
        return;
      }
      // No job by that number: fall through and treat the whole thing as an
      // ordinary instruction, which is what it almost certainly is.
    }
    const running = Boolean(app.abort && !app.abort.signal.aborted);
    if (!running) {
      app.render.write(C.dim('  No active task to steer. Type the instruction on its own to start one.\n'));
      return;
    }
    // `NOW`, BECAUSE NAMING THE COMMAND IS THE DELIBERATE ACT.
    app.queueSteer(rest, 'NOW');
    app.render.write(C.green('  ⚑ STEER') + C.dim(' — queued for the next model turn\n'));
    app.render.write(C.dim(`    ${rest}\n`));
  },
});


  define('/jobs', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[<n>]',
    desc: 'What is running, and what it is doing',
    run(app, { args }) {
      const w = (s) => app.render.write(s + '\n');
      const lines = args && args[0] ? detail(app, args[0], C) : rows(app, C);
      for (const l of lines) w(l);
    },
  });

  /** `/bg` — LAIN'S BACKGROUND WORK. */
  define('/bg', {
    surface: true,
    args: '[<instruction>]  ·  stop <id>',
    desc: 'Background work: start some, or see what is running',
    run(app, { rest }) {
      const w = (s) => app.render.write(s + '\n');
      const arg = String(rest || '').trim();

      // BARE `/bg` IS A SUMMARY, NOT A USAGE MESSAGE
      if (!arg) {
        const bg = require('./bgdetach');
        const proc = bg.running(app).length ? bg.detachProcess(app) : null;
        if (proc) {
          w(C.green(`  BACKGROUND #${proc.id}`) + C.dim(`  ·  ${String(proc.request).slice(0, 60)}  ·  pid ${proc.pid || '?'} keeps running`));
          w(C.dim('  The foreground is free — the result rejoins this task when it finishes.'));
          require('./commands').receipt();   // a confirmation: it closes itself (the Background row tracks the job)
          return;
        }
        return void summary(app, C, w);
      }

      const words = arg.split(/\s+/);
      if (words[0].toLowerCase() === 'stop') return void stop(app, C, w, words[1]);

      // ANYTHING ELSE IS THE WORK ITSELF
      const job = app.startBackground(arg);
      w(C.green(`  Background #${job.id} started`) + C.dim(`  ·  ${arg.replace(/\s+/g, ' ').slice(0, 60)}`));
      w(C.dim(`  Keep talking — /bg to check on it · /bg stop ${job.id} to end it`));
    },
  });

  define('/answer', {
    surface: true,
    args: '<n> <answer>',
    desc: 'Answer a background job that is waiting on you',
    run(app, { args, rest }) {
      const w = (t) => app.render.write(t + String.fromCharCode(10));
      const waiting = app.jobs.running().filter((j) => j.needsInput);
      // ONE WAITING JOB NEEDS NO NUMBER. Naming it is precision nobody needs
      // when there is only one thing it could mean.
      const first = args && args[0];
      const numbered = first && /^[0-9]+$/.test(first) ? app.jobs.get(first) : null;
      const job = numbered || (waiting.length === 1 ? waiting[0] : null);
      const text = numbered ? String(rest || '').replace(/^[ ]*[0-9]+[ ]*/, '') : String(rest || '');
      if (!job) {
        w(C.dim(waiting.length
          ? '  Which one? /jobs to see them, then /answer <n> <your answer>.'
          : '  Nothing is waiting on you.'));
        return;
      }
      if (!job.needsInput) { w(C.dim(`  #${job.id} is not waiting on you.`)); return; }
      if (!text.trim()) { w(C.dim(`  /answer ${job.id} <your answer>`)); return; }
      const q = job.question.question;
      job.reply(text.trim());
      app.jobs.changed();
      w(C.green(`  ✓ answered #${job.id}`) + C.dim(` — it resumes now`));
      w(C.dim(`    ${q}`));
      w(C.dim(`    ${text.trim()}`));
    },
  });

  define('/cancel', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    surface: true,
    args: '<n>',
    desc: 'Stop a running job at its next safe point',
    run(app, { args }) {
      const w = (s) => app.render.write(s + '\n');
      const running = app.jobs.running();
      if (!args || !args[0]) {
        if (running.length === 1) return void cancelOne(app, running[0], C, w);
        w(C.dim(running.length ? '  Which one? /jobs to see them, then /cancel <n>.' : '  Nothing is running.'));
        return;
      }
      const j = app.jobs.get(args[0]);
      if (!j) { w(C.dim(`  No job #${args[0]}.`)); return; }
      cancelOne(app, j, C, w);
    },
  });
}

/** BARE `/bg` — the LOGICAL background work, one row each. */
function summary(app, C, w) {
  const all = app.jobs.all().filter((j) => !j.primary);
  const shells = app._jobs ? app._jobs.all() : [];
  const ENDS = '  Background jobs end when LAIN exits.';
  for (const j of shells) {
    const s = j.summary();
    w(`  ${C.dim(`#${s.id}`)}  ${s.done ? (s.exitCode === 0 ? C.green('COMPLETED') : C.yellow(s.state)) : C.cyan('RUNNING')}  ${String(j.label || s.command).replace(/\s+/g, ' ').slice(0, 50)}  ${C.dim(elapsedOf(s.elapsedMs))}${j.logFile ? C.dim(`  ${j.logFile}`) : ''}`);
  }
  if (shells.length && !all.length) { w(C.dim(ENDS)); return; }
  if (!all.length) {
    w(C.dim('  Nothing is running in the background.'));
    w(C.dim(ENDS));
    w('');
    w(C.dim('  /bg run the integration suite      a job — it ends and yields a result'));
    w(C.dim('  /bg start the frontend dev server  a service — it stays up'));
    w(C.dim('  Plain text works the conversation; /bg works beside it.'));
    return;
  }
  w('');
  w(C.bold('  Background'));
  for (const j of all) {
    const word = j.state === STATE.SUCCEEDED ? 'COMPLETED'
      : j.state === STATE.FAILED ? 'FAILED'
        : j.state === STATE.CANCELLED ? 'CANCELLED'
          : j.needsInput ? 'NEEDS INPUT' : j.waiting ? 'WAITING' : 'RUNNING';
    const state = word === 'COMPLETED' ? C.green(word)
      : word === 'FAILED' ? C.yellow(word)
        : word === 'CANCELLED' ? C.dim(word)
          : word === 'RUNNING' ? C.cyan(word) : C.yellow(word);
    const pad = ' '.repeat(Math.max(2, 13 - word.length));
    const verdict = settledState(app, j);
    const proof = verdict ? '  ' + tone(C, `task ${verdict}`) : '';
    w(`  ${mark(j, C)} ${C.dim(`#${j.id}`)}  ${state}${pad}${String(j.request).replace(/\s+/g, ' ').slice(0, 44)}  ${C.dim(elapsedOf(j.elapsedMs))}${proof}`);
    if (j.needsInput && j.question) w(C.dim(`         ${String(j.question.question).slice(0, 60)}`));
  }
  w('');
  w(C.dim('  /jobs <n> — the whole account · /bg stop <n> — end one · /ps — its processes'));
  w(C.dim(ENDS));
}

/** The harness's verdict for the task this background work belongs to, or ''. */
function settledState(app, job) {
  try {
    const h = require('./harnesslink').existing(app);
    if (!h || !job.taskId) return '';
    const t = h.runtime.get(job.taskId);
    return t && t.terminal ? String(t.state) : '';
  } catch { return ''; }
}

function tone(C, state) {
  if (state === 'PASSED') return C.green(state);
  if (state === 'FAILED' || state === 'INCONCLUSIVE') return C.yellow(state);
  return C.dim(state);
}

/** `/bg stop <id>` — the same cooperative stop `/cancel` has always performed. */
function stop(app, C, w, id) {
  const running = app.jobs.running().filter((j) => !j.primary);
  if (!id) {
    // ONE RUNNING TASK NEEDS NO NUMBER — naming it is precision nobody needs
    // when there is only one thing it could mean. `/answer` reads the same way.
    if (running.length === 1) return void cancelOne(app, running[0], C, w);
    w(C.dim(running.length ? '  Which one? /bg to see them, then /bg stop <n>.' : '  Nothing is running in the background.'));
    return;
  }
  const j = app.jobs.get(id);
  if (!j) { w(C.dim(`  No background task #${id}. /bg to see what there is.`)); return; }
  if (j.primary) {
    // THE CONVERSATION IS NOT BACKGROUND WORK, and stopping it is Ctrl+C — which is the key a person already has their hand on.
    w(C.dim('  #' + j.id + ' is the conversation, not background work. Ctrl+C stops the turn.'));
    return;
  }
  cancelOne(app, j, C, w);
}

/** COOPERATIVE, and it says which. */
function cancelOne(app, job, C, w) {
  if (job.done) { w(C.dim(`  #${job.id} had already ${String(job.state).toLowerCase()}.`)); return; }
  job.cancel('you cancelled it');
  app.jobs.changed();
  w(C.dim(`  ■ #${job.id} cancelled`) + C.dim(' — it stops at its next safe point'));
}

module.exports = { register, rows, detail, elapsedOf, summary, stop, settledState };
