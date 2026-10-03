'use strict';

/** `/harness`, `/tasks`, `/verify`, `/artifacts`, `/env` — the harness at the terminal. */

const path = require('path');

/** Enough rows to see the shape of a run; never the whole flight recorder. */
const TIMELINE_ROWS = 24;
const ARTIFACT_ROWS = 20;

function harnessOf(app) { return require('./harnesslink').harnessFor(app); }

function tone(C, state) {
  if (state === 'PASSED') return C.green(state);
  if (state === 'FAILED') return C.yellow(state);
  if (state === 'INCONCLUSIVE') return C.yellow(state);
  if (state === 'RUNNING' || state === 'VERIFYING') return C.cyan(state);
  return C.dim(state);
}

function row(app, k, v) { app.render.write('  ' + String(k).padEnd(14) + v + '\n'); }

/** THE OPERATIONAL SUMMARY — what is LAIN doing, and what proves it. */
function status(app, C) {
  const h = harnessOf(app);
  const snap = h.snapshot();
  if (!snap.task) {
    app.render.write(C.dim('  No harness task yet — one opens when you ask for something.\n'));
    return;
  }
  const t = snap.task;
  app.render.write('\n' + C.bold(`LAIN TASK ${t.id}`) + '\n');
  app.render.write(C.dim('  ' + '─'.repeat(46)) + '\n');
  row(app, 'title', t.title);
  row(app, 'state', tone(C, t.state) + (t.reason ? C.dim(` — ${t.reason}`) : ''));
  if (t.causedBy) row(app, 'caused by', C.dim(t.causedBy));
  for (const p of snap.processes) {
    row(app, 'process', `${p.name} ${p.port ? `:${p.port} ` : ''}${p.status} ${p.health === 'HEALTHY' ? C.green(p.health) : C.dim(p.health)}`);
  }
  const v = t.verification;
  if (v) {
    row(app, 'verification', `${tone(C, v.verdict)}  ${v.passed} passed · ${v.failed} failed · ${v.inconclusive} inconclusive`);
    if (v.why) app.render.write(C.dim(`                 ${String(v.why).slice(0, 90)}\n`));
  } else {
    row(app, 'verification', C.dim('nothing has been proved yet — run /verify'));
  }
  row(app, 'evidence', `${t.artifacts} artifact(s) · ${t.events} event(s) · ${t.observations} observation(s)`);
  if (t.attempts > 1) row(app, 'attempts', String(t.attempts));
  if (!snap.persisted) app.render.write(C.dim('  (persistence off — nothing is being written to disk)\n'));
}

function timeline(app, C, taskId = null) {
  const h = harnessOf(app);
  const rows = h.timeline(taskId, { limit: TIMELINE_ROWS });
  if (!rows.length) { app.render.write(C.dim('  Nothing has happened yet.\n')); return; }
  app.render.write('\n' + C.bold('Timeline') + '\n');
  for (const r of rows) app.render.write(`  ${C.dim(r.time)}  ${r.text}\n`);
}

async function doctor(app, C) {
  // ONE REPORT, TWO DOORS.
  const h = harnessOf(app);
  const rows = await h.doctor();
  const { Harness } = require('./harness');
  const text = require('./harnessreport').render(rows, Harness.summarise(rows));
  for (const line of text.split(String.fromCharCode(10))) {
    // The marks carry the meaning; colour only makes them easier to scan, and
    // its absence on a pipe costs nothing.
    if (line.includes('✓')) app.render.write(line.replace('✓', C.green('✓')) + String.fromCharCode(10));
    else if (line.includes('✗') || line.startsWith('  CORE PROBLEM')) app.render.write(C.yellow(line) + String.fromCharCode(10));
    else if (line.includes('○')) app.render.write(C.dim(line) + String.fromCharCode(10));
    else app.render.write(line + String.fromCharCode(10));
  }
}

function capabilities(app, C) {
  const h = harnessOf(app);
  const groups = h.registry.byEffect(app);
  app.render.write('\n' + C.bold('Capabilities') + C.dim('  (side effect → what can do it)') + '\n');
  for (const [effect, names] of Object.entries(groups)) {
    const approval = h.registry.POLICY[effect];
    app.render.write(`  ${String(effect).padEnd(13)}${approval === 'REQUIRED' ? C.yellow('approval required') : C.dim('automatic')}\n`);
    app.render.write(C.dim(`    ${names.join(', ')}\n`));
  }
}

function surfaces(app, C) {
  app.render.write('\n' + C.bold('Surfaces') + C.dim('  — every one reads the same task state') + '\n');
  const remote = (() => { try { return require('./remotecontrol').status(); } catch { return null; } })();
  row(app, 'remote', remote && remote.connected ? C.green(`connected as ${remote.identity || 'unknown'}`) : C.dim('not connected — /runtime for the supervisor'));
}

function tasks(app, C) {
  const h = harnessOf(app);
  const live = h.runtime.list();
  const stored = h.runtime.persist ? h.runtime.store.listTasks() : [];
  const seen = new Set(live.map((t) => t.id));
  const all = [...live.map((t) => t.toJSON()), ...stored.filter((t) => !seen.has(t.id))];
  if (!all.length) { app.render.write(C.dim('  No tasks in this project yet.\n')); return; }
  app.render.write('\n' + C.bold('Tasks') + C.dim('  (this project)') + '\n');
  for (const t of all.slice(0, 30)) {
    const when = new Date(t.updatedAt || 0).toISOString().slice(5, 16).replace('T', ' ');
    app.render.write(`  ${C.dim(when)}  ${String(t.id).padEnd(16)}${tone(C, t.state).padEnd(22)}${String(t.title || '').slice(0, 46)}\n`);
  }
}

function artifacts(app, C, rest) {
  const h = harnessOf(app);
  const arg = String(rest || '').trim();
  const [verb, ...more] = arg.split(/\s+/).filter(Boolean);
  // THE LATEST TASK, NOT THE ACTIVE ONE.
  const active = h.runtime.latest();
  if (verb === 'open' || verb === 'show') {
    const id = more[0];
    const taskId = more[1] || (active && active.id);
    if (!id || !taskId) { app.render.write(C.dim('  Usage: /artifacts open <artifact-id> [task-id]\n')); return; }
    const bytes = h.runtime.store.bytes(taskId, id);
    if (!bytes) { app.render.write(C.dim(`  No artifact ${id} for ${taskId}.\n`)); return; }
    // TEXT IS SHOWN; BYTES ARE NAMED. Printing a PNG into a terminal is the
    // classic way to leave a session with a broken character set.
    const rec = h.runtime.store.index(taskId).find((a) => a.id === id);
    if (rec && /screenshot|png|jpg/i.test(`${rec.kind}${rec.name}`)) {
      app.render.write(C.dim(`  ${rec.bytes} bytes of image at ${rec.path}\n`));
      return;
    }
    app.render.write('\n' + bytes.toString('utf8').slice(0, 8000) + '\n');
    return;
  }
  const taskId = verb || (active && active.id);
  if (!taskId) { app.render.write(C.dim('  No task to show artifacts for.\n')); return; }
  const list = h.runtime.store.index(taskId);
  if (!list.length) { app.render.write(C.dim(`  No artifacts kept for ${taskId} yet.\n`)); return; }
  app.render.write('\n' + C.bold(`Artifacts`) + C.dim(`  ${taskId} · ${h.runtime.store.dirFor(taskId)}`) + '\n');
  for (const a of list.slice(-ARTIFACT_ROWS)) {
    app.render.write(`  ${String(a.id).padEnd(26)}${String(a.kind).padEnd(14)}${String(a.bytes).padStart(8)}  ${path.basename(a.path)}\n`);
    if (a.note) app.render.write(C.dim(`    ${String(a.note).slice(0, 88)}\n`));
  }
  app.render.write(C.dim('  /artifacts open <id> to read one\n'));
}

async function env(app, C, rest) {
  const h = harnessOf(app);
  const what = String(rest || '').trim().toLowerCase();
  // THE EXECUTION-ENVIRONMENT SECTIONS
  const words = String(rest || '').trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'chromium' || words[0] === 'vm') {
    await require('./envcommand').sections(app, C, words);
    return;
  }
  if (!what) await require('./envcommand').sections(app, C, []);
  if (!what || what === 'processes' || what === 'ports') {
    const procs = h.processes.list();
    app.render.write('\n' + C.bold('Processes') + '\n');
    if (!procs.length) app.render.write(C.dim('  none managed by this session\n'));
    for (const p of procs) {
      const j = p.toJSON();
      app.render.write(`  ${String(j.name).padEnd(14)}${String(j.status).padEnd(10)}${j.port ? `:${j.port}` : '     '}  ${j.pid ? `pid ${j.pid}` : ''}  ${C.dim(j.healthWhy || '')}\n`);
    }
  }
  if (!what || what === 'browser') {
    const b = await h.browser.availability();
    app.render.write('\n' + C.bold('Browser') + '\n');
    app.render.write(`  ${b.available ? C.green('available') : C.dim('unavailable')}  ${C.dim(b.why)}\n`);
  }
  if (!what || what === 'health') {
    await doctor(app, C);
  }
}

/** `/verify` — RUN THE EVIDENCE. */
async function verify(app, C, rest) {
  const h = harnessOf(app);
  const arg = String(rest || '').trim();
  const active = h.runtime.latest();
  if (!active) { app.render.write(C.dim('  No task to verify. Ask for something first.\n')); return; }

  const requirements = [];
  const words = arg.split(/\s+/).filter(Boolean);
  const kind = (words[0] || 'full').toLowerCase();
  const remainder = words.slice(1).join(' ');

  if (kind === 'full') {
    // WHAT THIS PROJECT ITSELF SAYS WOULD PROVE THE WORK. Derived from its own
    // manifest — never guessed. See harness/profile.js.
    const profile = require('./harness/profile').forProject(app.cwd || process.cwd());
    if (profile.empty) {
      app.render.write(C.dim('  This project declares nothing that could prove anything — no build, no suite.\n'));
      app.render.write(C.dim('  Name the evidence yourself: /verify tests <cmd> · /verify build <cmd> · /verify api <url>\n'));
      return;
    }
    app.render.write(C.dim(`  from this project: ${profile.found.join(' · ')}\n`));
    requirements.push(...profile.requirements);
  }
  if (kind === 'tests') {
    requirements.push({
      description: 'the project test suite passes',
      checks: [{ kind: 'tests', label: 'tests', command: remainder || undefined }],
    });
  }
  // THE THREE FORMS THAT NEED AN ARGUMENT SAY SO, rather than running a check
  // that comes back INCONCLUSIVE for a reason that is the typing, not the code.
  if (['build', 'api', 'browser'].includes(kind) && !remainder) {
    app.render.write(C.dim(`  /verify ${kind} needs an argument — ${kind === 'build' ? 'the build command' : 'a URL'}` + '\n'));
    return;
  }
  if (kind === 'build') {
    requirements.push({ description: 'the build succeeds', checks: [{ kind: 'build', label: 'build', command: remainder }] });
  }
  if (kind === 'api') {
    requirements.push({ description: `${remainder} answers`, checks: [{ kind: 'http', label: 'api', url: remainder }] });
  }
  if (kind === 'browser') {
    requirements.push({
      description: `the page at ${remainder} loads with no console errors`,
      checks: [{ kind: 'browser', label: 'browser', url: remainder, no_console_errors: true }],
    });
  }
  if (!requirements.length) {
    app.render.write(C.dim('  Usage: /verify [full | tests [cmd] | build <cmd> | api <url> | browser <url>]\n'));
    return;
  }

  app.render.write(C.dim(`  running ${requirements.length} requirement(s)…\n`));
  // A TASK THAT ALREADY HAS A VERDICT IS NOT RE-SETTLED.
  const settled = active.terminal;
  const report = await h.verify({ name: `/verify ${kind}`, requirements }, { taskId: active.id, settle: !settled });
  app.render.write('\n' + require('./harness/verify').render(report) + '\n');
  const t = h.runtime.get(active.id);
  if (t && settled) app.render.write(C.dim(`  task ${t.id} already has a verdict (${t.state}) — this run is informational\n`));
  else if (t) app.render.write(`  task ${t.id} is now ${tone(C, t.state)}\n`);
}

function register({ define, DURING_TURN, C }) {
  define('/harness', {
    // MACHINERY: about LAIN, not about the work. Goes to the command panel.
    surface: true,
    args: '[status|doctor|capabilities|surfaces|timeline]',
    desc: 'The task harness: state, capabilities and the flight recorder',
    async run(app, { rest }) {
      const what = String(rest || '').trim().toLowerCase();
      if (what === 'doctor') return doctor(app, C);
      if (what === 'capabilities' || what === 'tools') return capabilities(app, C);
      if (what === 'surfaces') return surfaces(app, C);
      if (what === 'timeline') return timeline(app, C);
      status(app, C);
      return undefined;
    },
  });

  define('/tasks', {
    surface: true,
    desc: 'Every task this project has a record of, newest first',
    run(app) { tasks(app, C); },
  });

  define('/artifacts', {
    surface: true,
    args: '[<task-id>] · open <artifact-id>',
    desc: 'Durable evidence kept for a task — logs, test output, screenshots, reports',
    run(app, { rest }) { artifacts(app, C, rest); },
  });

  define('/env', {
    surface: true,
    args: '[processes|browser|health|chromium [install]|vm <id> [start|stop]]',
    desc: 'The execution environment: host or VM, the Harness browser, services and ports',
    async run(app, { rest }) { await env(app, C, rest); },
  });

  define('/verify', {
    // BLOCKED DURING A TURN, and it is the only one of these that is.
    duringTurn: DURING_TURN.BLOCKED,
    args: '[full|tests|build <cmd>|api <url>|browser <url>]',
    desc: 'Run a verification contract and settle the task from the evidence',
    async run(app, { rest }) { await verify(app, C, rest); },
  });
}

module.exports = { register, status, timeline, doctor, capabilities, tasks, artifacts, env, verify, TIMELINE_ROWS };
