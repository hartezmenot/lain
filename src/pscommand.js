'use strict';

/** `/ps` — THE PROCESSES LAIN OWNS. */

/** Full table above this width; two columns below it. */
const WIDE = 64;
/** Beyond this, a service's health and a job's exit code earn their column. */
const VERY_WIDE = 92;

/** The managed services, as plain rows. */
function serviceRows(app) {
  const h = require('./harnesslink').existing(app);
  if (!h || !h.processes) return [];
  return h.processes.list().map((p) => {
    const j = p.toJSON();
    return {
      pid: j.commandPid || j.pid || null,
      type: 'service',
      // LOWER CASE, because the STATUS vocabulary is the harness's and it is
      // shouted there for a reason — this is a table, not a verdict.
      state: String(j.status || '').toLowerCase(),
      name: j.name,
      port: j.port || null,
      owner: j.taskId || null,
      since: j.startedAt || 0,
      // UNKNOWN IS AN ANSWER AND IT IS PRINTED AS ONE. A service with no health
      // check configured is not healthy — nothing looked. See processes.js.
      extra: j.health && j.health !== 'UNKNOWN' ? j.health.toLowerCase() : '',
      done: ['stopped', 'crashed', 'failed'].includes(String(j.status || '').toLowerCase()),
    };
  });
}

/** The shell jobs, from the collection tools/jobs.js holds on the App. */
function jobRows(app) {
  const jobs = app && app._jobs;
  if (!jobs || typeof jobs.all !== 'function') return [];
  return jobs.all().map((j) => ({
    // A JOB'S PID IS ITS CHILD'S, and it is gone once the child has exited — printing the pid of a process that no longer exists would invite somebody to…
    pid: j.child && !j.done ? j.child.pid : null,
    type: 'job',
    state: String(j.state || '').toLowerCase(),
    name: String(j.command || '').replace(/\s+/g, ' '),
    port: null,
    owner: null,
    since: j.startedAt || 0,
    extra: j.done && j.exitCode != null ? `exit ${j.exitCode}` : '',
    done: Boolean(j.done),
  })).filter((r) => r.name);
}

/** Everything LAIN owns, services first — they are the ones that stay up. */
function rows(app) {
  return [...serviceRows(app), ...jobRows(app)];
}

function since(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** Colour by state, using the vocabulary the rest of LAIN already uses: running is live, a clean end is quiet, a crash is a failure. */
function tone(C, state) {
  if (state === 'running') return C.cyan(state);
  if (state === 'succeeded') return C.green(state);
  if (state === 'crashed' || state === 'failed' || state === 'timed_out') return C.yellow(state);
  return C.dim(state);
}

/** The table, as lines, at `width`. */
function render(app, C, width = 80) {
  const list = rows(app);
  const out = [];
  if (!list.length) {
    out.push(C.dim('  Nothing is running that LAIN owns.'));
    out.push(C.dim('  /bg <what you want done> starts something in the background.'));
    return out;
  }
  const w = Math.max(30, width);
  const wide = w >= WIDE;
  const veryWide = w >= VERY_WIDE;
  // NAME GETS WHAT IS LEFT. It is the only column whose content is unbounded —
  // a service is `vite`, but a job is a whole command line.
  const fixed = wide ? (veryWide ? 8 + 9 + 10 + 7 + 18 + 6 : 8 + 9 + 10) : 8 + 9;
  const nameRoom = Math.max(10, w - fixed - 4);
  const cell = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);

  if (wide) {
    let head = `  ${cell('PROCESS', 8)}${cell('TYPE', 9)}${cell('STATE', 10)}${cell('NAME', nameRoom)}`;
    if (veryWide) head += `${cell('PORT', 7)}${cell('OWNER', 18)}UP`;
    out.push(C.dim(head));
  }
  for (const r of list) {
    // A PROCESS WITH NO PID IS SAID TO HAVE NONE.
    const pid = r.pid ? String(r.pid) : '—';
    if (!wide) {
      out.push(`  ${cell(pid, 8)}${tone(C, r.state)} ${C.dim(String(r.name).slice(0, Math.max(8, w - 20)))}`);
      continue;
    }
    // COMPOSED WITH ITS PLAIN WIDTH ALONGSIDE IT.
    let line = `  ${cell(pid, 8)}${C.dim(cell(r.type, 9))}${tone(C, r.state)}${' '.repeat(Math.max(1, 10 - r.state.length))}${cell(r.name, nameRoom)}`;
    let used = 2 + 8 + 9 + Math.max(r.state.length + 1, 10) + nameRoom;
    if (veryWide) {
      line += `${C.dim(cell(r.port ? `:${r.port}` : '', 7))}${C.dim(cell(r.owner || '', 18))}${C.dim(since(r.since))}`;
      used += 7 + 18 + since(r.since).length;
    }
    // THE TRAILING FIELD IS A LUXURY AND IS DROPPED FIRST.
    if (r.extra && used + 2 + r.extra.length <= w) line += C.dim(`  ${r.extra}`);
    out.push(line);
  }
  // WHAT THIS LIST IS AND IS NOT, once, at the foot.
  out.push('');
  const T = require('./ui/text');
  const note = w >= 74
    ? 'Processes LAIN started and still owns. Host processes are not listed.'
    : 'Owned by LAIN. Host processes are not listed.';
  const doors = w >= 70
    ? '/bg — the work behind these · /bg stop <id> — end a background task'
    : '/bg — the work behind these';
  out.push(C.dim(T.clip('  ' + note, w)));
  out.push(C.dim(T.clip('  ' + doors, w)));
  return out;
}

function register({ define, C }) {
  define('/ps', {
    // MACHINERY: about LAIN's own runtime, not about the work. Goes to the
    // command panel and never into the conversation the model reads.
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'Processes and services LAIN owns — pid, type, state, name',
    run(app) {
      const width = (app.render && app.render.width) || 80;
      for (const line of render(app, C, width)) app.render.write(line + '\n');
    },
  });
}

module.exports = { register, render, rows, serviceRows, jobRows, WIDE, VERY_WIDE };
