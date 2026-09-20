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
  // THE EXECUTION PROFILE — FAST · NORMAL · ECO (profile.js). Strategy and
  // spend, never the correctness bar; orthogonal to AUTO/MANUAL/PLAN and FOCUS.
  const profileCmd = (name, target, desc, hidden = false) => define(name, {
    surface: true, flashMs: 1500, hidden, args: name === '/fast' ? '[on|off]' : '',
    desc,
    run(app, { args }) {
      const off = name === '/fast' && String(args[0] || '').toLowerCase() === 'off';
      const p = require('./profile').set(app.session, off ? 'NORMAL' : target);
      try { app.session.save(); } catch { /* still applies in memory */ }
      if (app.ui && app.ui.enabled) app.ui.refresh();
      app.render.write(C.dim(`  ${p}${p === 'ECO' ? ' (token economy)' : ''} · ${execmode.label(app.session)}\n`));
    },
  });
  profileCmd('/fast', 'FAST', 'FAST profile: finish quickly — parallel independent reads, disjoint subagents, bigger budget; same verification bar');
  profileCmd('/normal', 'NORMAL', 'NORMAL profile (default): main agent first, subagents only when clearly useful');
  profileCmd('/slow', 'ECO', 'ECO profile — token economy: one agent, serial, deterministic tools first, smaller context; same verification bar');
  profileCmd('/eco', 'ECO', 'Alias of /slow', true);
  // SUBAGENTS — one small setting, not a panel: AUTO (recommended) or OFF, and
  // how many may run at once. The counter itself lives in the run state.
  define('/subagents', {
    surface: true, flashMs: 1500, args: '[auto|off|max N]',
    desc: 'Subagents: AUTO (the model delegates when work partitions) or OFF; max concurrent workers',
    run(app, { args }) {
      const sub = require('./subagents');
      const a = String(args[0] || '').toLowerCase();
      const cur = { ...((app.cfg && app.cfg.subagents) || {}) };
      if (a === 'auto' || a === 'on') cur.mode = 'auto';
      else if (a === 'off') cur.mode = 'off';
      else if (a === 'max' && Number(args[1]) > 0) cur.maxConcurrent = Math.min(8, Math.floor(Number(args[1])));
      if (a) { app.cfg.subagents = cur; try { require('./config').save(app.cfg); } catch { /* applies in memory */ } }
      const s = sub.settings(app);
      const live = sub.running(app).length;
      const prof = require('./profile').of(app.session, app.cfg);
      app.render.write(C.dim(`  SUBAGENTS ${s.mode.toUpperCase()} · max ${s.maxConcurrent} at once · ${live} running · profile ${prof}`
        + `${prof === 'ECO' && s.mode === 'auto' ? ' (ECO: only when you ask for them)' : ''}\n`));
    },
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

module.exports = { register, acceptPlan, toggle, browser };
