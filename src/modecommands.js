'use strict';

/**
 * `/focus`, `/fast`, `/browser` (with `/chrome` as a hidden alias), and what
 * `/plan accept` does. One module so commands.js stays a registry.
 *
 * FOCUS and FAST are session preferences (execmode.js), not runtimes.
 */

const execmode = require('./execmode');

function toggle(app, key, arg) {
  const a = String(arg || '').toLowerCase();
  const on = a === 'on' ? true : a === 'off' ? false : !app.session[key];
  app.session[key] = on;
  try { app.session.save(); } catch { /* still applies in memory */ }
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return on;
}

/**
 * THE PLAN IS ACCEPTED: leave PLAN, and execution begins. Durable step progress
 * appears only from here — never while the plan is still being discussed.
 */
function acceptPlan(app, { C }) {
  const plan = app.session.plan;
  execmode.set(app.session, 'AUTO');
  if (plan) { plan.acceptedAt = Date.now(); plan.retiredAt = null; }
  try { app.session.save(); } catch { /* best effort */ }
  const open = plan && plan.steps ? plan.steps.filter((s) => s.status !== 'done' && s.status !== 'dropped').length : 0;
  app.render.write(C.green('  ✓ PLAN ACCEPTED') + C.dim(open ? `  · ${open} step(s) · executing in AUTO\n` : '  · executing in AUTO\n'));
  const text = 'Execute the accepted plan, starting with the first open step.';
  if (app.interactive && app.ui && app.ui.enabled && typeof app.startPrimary === 'function') {
    setImmediate(() => { try { app.startPrimary(text, { from: 'plan' }); } catch { /* the plan stays accepted */ } });
    return null;
  }
  return app.submit(text, { from: 'plan', sameTask: true });
}

async function browser(app, args, { C }) {
  const w = (s) => app.render.write(s);
  const sub = String(args[0] || '').toLowerCase();
  if (['connect', 'off', 'disconnect', 'stop'].includes(sub)) return require('./chromecommand').run(app, args, { C });
  const route = require('./browserrouter');
  const s = route.status(app);
  w('\n' + C.bold('Browser') + '\n');
  w('  ' + (s.chrome.connected ? C.green('● Chrome connected') : C.dim('○ Chrome not connected')) + '\n');
  if (s.current) w('\n  ' + C.dim('Current') + '\n  ' + (s.current.url || s.current.title) + '\n');
  w('\n  ' + C.dim(`Tabs: ${s.chrome.tabs}`) + (s.workshop ? C.dim(`  ·  Frontend: ${s.workshop}`) : '') + '\n');
  if (sub === 'tabs') for (const t of s.chrome.list) w(C.dim(`    #${t.id} ${t.title || ''} ${t.url || ''}\n`));
  if (sub === 'current' && s.current) {
    const v = await route.inspect(app, { target: s.current.url || 'current', scope: 'page' });
    for (const line of require('./ui/browserview').lines(v, 96)) w(`  ${line}\n`);
  }
  if (!s.chrome.connected) w(C.dim('\n  /browser connect starts the bridge for the LAIN for Chrome extension.\n'));
  w(C.dim('\n  [Current] /browser current   [Tabs] /browser tabs   [Disconnect] /browser disconnect\n'));
  return null;
}

function register({ define, C }) {
  define('/focus', {
    surface: true, flashMs: 1500, args: '[on|off]',
    desc: 'Focus: stricter quiet — reuse fresh project state, show only changes, blockers, verification',
    run(app, { args }) { const on = toggle(app, 'focus', args[0]); app.render.write(C.dim(`  FOCUS ${on ? 'on' : 'off'} · ${execmode.label(app.session)}\n`)); },
  });
  // MEMORY (memdir.js): one fact per file under ~/.lain/projects/<id>/memory/, MEMORY.md the index every session loads.
  define('/memory', {
    surface: true, args: '[edit [name] | forget <name>]',
    desc: 'Project memory: list the facts later sessions see; edit one (or the folder) in $EDITOR; forget one',
    run(app, { args }) {
      const w = (s) => app.render.write(s);
      const m = require('./memdir');
      const cwd = app.session.cwd;
      const [sub, name] = [String(args[0] || '').toLowerCase(), args[1]];
      if (sub === 'forget' && name) { const r = m.forget(cwd, name); w(C.dim(`  ${r.ok ? `forgot ${name}` : r.why}\n`)); return; }
      if (sub === 'edit') {
        const file = name ? require('path').join(m.dir(cwd), `${name}.md`) : require('path').join(m.dir(cwd), m.INDEX);
        require('fs').mkdirSync(m.dir(cwd), { recursive: true });
        if (!require('fs').existsSync(file)) require('fs').writeFileSync(file, '');
        require('./planmode').edit(app, file);
        m.reindex(cwd);
        return;
      }
      const facts = m.list(cwd);
      w(`  ${C.bold('Memory')} ${C.dim(`· ${m.dir(cwd)}`)}\n`);
      if (!facts.length) w(C.dim('  Nothing remembered for this project yet. Ask LAIN to remember something.\n'));
      for (const f of facts) w(`  ${f.name}  ${C.dim(f.line.slice(0, 100))}\n`);
    },
  });
  // THE PERMISSION MODE (execmode.js): Ask · Accept edits · Plan · Auto — Shift+Tab cycles it too.
  define('/mode', {
    surface: true, args: '[ask|accept-edits|plan|auto]',
    desc: 'Permission mode: Ask, Accept edits, Plan (read-only) or Auto; shows the allow/deny rules in force',
    run(app, { args }) {
      const w = (s) => app.render.write(s);
      if (args[0]) {
        const want = require('./permrules').modeName(args[0]);
        if (!want) { w(C.dim('  /mode ask | accept-edits | plan | auto\n')); return; }
        execmode.set(app.session, want);
        try { app.session.save(); } catch { /* still applies in memory */ }
        if (app.ui && app.ui.enabled) app.ui.refresh();
      }
      const mode = execmode.of(app.session);
      const eff = execmode.effective(app);
      w(`  ${C.bold(execmode.WORD[mode])}${eff !== mode ? C.dim(` — ${execmode.WORD[eff]} applies until this folder is trusted (/trust)`) : ''}\n`);
      const r = require('./permrules').of(app.cfg, app.session.cwd);
      if (r.allow.length) w(C.dim(`  allow: ${r.allow.join(', ')}\n`));
      if (r.deny.length) w(C.dim(`  deny:  ${r.deny.join(', ')}\n`));
      if (r.ignored.length) w(C.dim(`  ignored (a project file cannot widen): ${r.ignored.join(', ')}\n`));
    },
  });
  // THE EXECUTION PROFILE — FAST · NORMAL · ECO (profile.js): spend only, never behaviour.
  // `/fast` and `/eco` TOGGLE their profile (profile.toggle); `/normal` resets.
  const profileCmd = (name, target, desc, hidden = false) => define(name, {
    surface: true, flashMs: 1500, hidden, args: target === 'NORMAL' ? '' : '[on|off]',
    desc,
    run(app, { args }) {
      const prof = require('./profile');
      // WHILE THE AGENT WORKS the change is QUEUED to its next checkpoint (runstrategy.queueProfile).
      const want = prof.toggle(prof.of(app.session, app.cfg), target, args[0]);
      const r = require('./runstrategy').queueProfile(app, want);
      try { app.session.save(); } catch { /* still applies in memory */ }
      if (app.ui && app.ui.enabled) app.ui.refresh();
      const p = r.queued ? `${want} queued — applies at the next checkpoint` : prof.of(app.session, app.cfg);
      app.render.write(C.dim(`  ${p}${p === 'ECO' ? ' (token economy)' : ''} · ${execmode.label(app.session)}\n`));
    },
  });
  profileCmd('/fast', 'FAST', 'FAST (toggle): lowest native effort unless you chose one; up to 4 read-only calls at once');
  profileCmd('/normal', 'NORMAL', 'NORMAL (default): the model\'s default effort; up to 2 read-only calls at once');
  profileCmd('/eco', 'ECO', 'ECO (toggle): lowest native effort unless you chose one; 2 read-only calls at once; tighter tool output; compacts earlier');
  // THE RUN STRATEGY (runstrategy.js) — separate from the profile and from effort.
  define('/strategy', {
    surface: true, args: '[normal|phased|long] [confirm]',
    desc: 'Run strategy: Normal, Phased (review each phase) or Long Context Phasing (continue phase after phase)',
    run(app, { args }) {
      const rs = require('./runstrategy');
      if (!args[0]) { const s = rs.get(app.session); app.render.write(C.dim(`  ${rs.LABEL[s.kind]}${s.kind !== 'NORMAL' ? ` · review ${s.review.toLowerCase().replace(/_/g, ' ')}` : ''}\n`)); return; }
      const r = rs.request(app, args[0], { review: args[2] || null });
      if (!r.ok) { app.render.write(C.dim(`  ${r.why}\n`)); return; }
      if (r.needsConfirm) {
        if (args[1] !== 'confirm') { app.render.write(`  ${r.offer.text}\n  ${r.offer.estimate.text}\n  Type /strategy long confirm to continue, or /eco first.\n`); return; }
        rs.confirm(app, r.offer.id, 'continue');
      }
      try { app.session.save(); } catch { /* in memory */ }
      app.render.write(C.dim(`  ${rs.LABEL[rs.get(app.session).kind]}\n`));
    },
  });
  // HAND THE SESSION BACK TO THE HARNESS (surfacehandoff.js): same task, no transcript replay.
  define('/handback', {
    surface: true, args: '',
    desc: 'Hand this session back to the LAIN Harness (it continues the same task there)',
    run(app) {
      const r = require('./surfacehandoff').handoff(app, 'harness');
      app.render.write(r.ok ? '  Handed to the Harness — it picks this session up. This terminal stops writing to it.\n' : `  ${r.why}\n`);
    },
  });
  // TAKE THE SESSION OVER (sessionlease.js): a free or reserved session now; a live host is ASKED and hands it over
  // at its next idle moment — never displaced mid-turn.
  define('/takeover', {
    surface: true, args: '',
    desc: 'Take this session over from the Harness (it hands over between turns)',
    run(app) {
      const sh = require('./surfacehandoff');
      const r = sh.takeBack(app);
      if (r.ok) { app.render.write('  This terminal now runs this session — reloaded as the other surface left it.\n'); return; }
      app.render.write(`  ${r.why}\n`);
      if (!r.pending) return;
      const until = Date.now() + 120_000;
      const t = setInterval(() => {
        const v = sh.persisted(app.session.id);
        if (v && v.writer === sh.surfaceOf(app) && !v.pid) {
          clearInterval(t);
          const r2 = sh.takeBack(app);
          try { app.render.notice(r2.ok ? 'info' : 'warn', r2.ok ? 'Took over — this terminal now runs this session.' : r2.why); } catch { /* no renderer */ }
        } else if (Date.now() > until) {
          clearInterval(t);
          try { app.render.notice('warn', 'The other surface did not hand this session over (it is still working). /takeover asks again.'); } catch { /* no renderer */ }
        }
      }, 1000);
      if (t.unref) t.unref();
    },
  });
  // SUBAGENTS — one small setting, not a panel: AUTO (recommended) or OFF, and
  // how many may run at once. The counter itself lives in the run state.
  define('/agents', {
    surface: true, args: '',
    desc: 'Agents: the types available, the agents of this session, and where each transcript is',
    run(app, { args }) {
      // THE AGENTS OF THIS SESSION (agentrun.js): what runs now, what ran, and where each transcript is.
      const all = (app.jobs ? app.jobs.all() : []).filter((j) => j.kind === 'subagent').map((j) => j.summary());
      const types = Object.keys(require('./agenttypes').all(app.session.cwd));
      app.render.write(C.dim(`  AGENTS · types: ${types.join(', ')} · ${all.filter((j) => j.state === 'RUNNING').length} running\n`));
      for (const j of all.slice(-12)) app.render.write(C.dim(`  ${j.id} ${j.word.padEnd(9)} ${j.agentType || ''} · ${j.agentLabel || j.request}${j.childSession ? `  · transcript: /resume ${j.childSession}` : ''}\n`));
      void args;
    },
  });
  // DIAGNOSTIC ONLY (workers.js): the narrow workers, whether any model is
  // recruited, and what they measurably saved. Never shown during normal work.
  define('/workers', {
    surface: true, args: '[status|auto|off|locate on|off|laya [auto|on|off]]',
    desc: 'Diagnostics: specialist workers (Laya roles, Jev excluded, Violetto retired) — installed, loaded, per-role mode, invoked',
    run(app, { args }) { return require('./workerscommand').run(app, args || [], { C, gateResults }); },
  });
  define('/workspaces', {
    surface: true, args: '[clean <id>|reconcile]',
    desc: 'Diagnostics: temporary subagent/A-B workspaces — state, what cleanup waits for, retained failures',
    run(app, { args }) { return require('./workspacecommand').run(app, args || [], { C }); },
  });
  define('/browser', {
    surface: true, args: '[current|tabs|connect|disconnect]',
    desc: 'The browser LAIN can see: your Chrome, the frontend dev server, or an isolated one',
    run(app, { args }) { return browser(app, args, { C }); },
  });
  define('/chrome', {
    surface: true, hidden: true, args: '[status|connect|disconnect]', desc: 'Alias of /browser',
    run(app, { args }) { return String(args[0] || '').toLowerCase() === 'status' ? browser(app, [], { C }) : browser(app, args, { C }); },
  });
}

/** The recorded recruitment-gate runs (bench/workergate/out), newest facts only. */
function gateResults() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'bench', 'workergate', 'out');
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!r.baseUrl) continue;   // the deterministic-only baseline is not a candidate
      const m = r.metrics || {};
      out.push({ contract: 'decision_intent', model: r.model, pass: Boolean(r.gate && r.gate.pass),
        detail: `uncertain ${Math.round((m.detAccuracyUncertain || 0) * 100)}%→${Math.round((m.cascadeAccuracyUncertain || 0) * 100)}% · wrong-when-answering ${Math.round((m.answeredWrongRate || 0) * 100)}% · ${m.medianMs} ms` });
    }
  } catch { /* no runs recorded */ }
  return out;
}

module.exports = { register, acceptPlan, toggle, browser, gateResults };
