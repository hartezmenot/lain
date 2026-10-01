'use strict';

/**
 * WHAT THE HEADER'S RIGHT HALF SAYS (§4, §11–13).
 *
 *     LAIN · toradb · GLM-5              RUNNING · 04:18 · 3/7     12.4K
 *     LAIN · toradb · GLM-5              PLAN · discussing          0
 *     LAIN · toradb · GLM-5              MANUAL · FOCUS             812
 *
 * REAL PROGRESS ONLY. `3/7` is the live plan's durable step count (the step in
 * hand of the steps not dropped). Nothing is shown while the plan is being
 * discussed — PLAN mode never carries a countdown — and there is no ETA,
 * because nothing here could know one. A plan that grows reads `3/9`.
 */

function run(ui) {
  const app = ui.app;
  const session = app.session;
  const execmode = require('../execmode');
  const mode = execmode.of(session);
  const prefs = execmode.prefs(session);
  const busy = Boolean(ui.busy || ui.phase);
  const clock = require('./workclock').reading(ui.clock);
  const tags = [prefs.focus ? 'FOCUS' : '', require('../profile').label(session)].filter(Boolean);   // FAST · ECO; NORMAL says nothing
  // AGENTS n — only while subagents actually run (the job registry, never narration).
  const agents = app.jobs && typeof app.jobs.running === 'function' ? app.jobs.running().filter((j) => j.kind === 'subagent').length : 0;
  if (agents) tags.push(`AGENTS ${agents}`);
  if (mode === 'PLAN') return { parts: ['PLAN', 'discussing', ...tags], tone: 'warn' };
  let step = null;
  const plan = require('./progress').livePlan(session);
  if (plan) {
    const p = require('./progress').progressOf(plan);
    if (p.known && p.completed < p.total) step = `${p.current}/${p.total}`;
  }
  if (busy) {
    const clockText = clock.shown ? clock.text.replace(/^00:/, '') : null;
    // NOT `RUNNING · 04:18` any more: the live row below already says what is happening and for how long, and a
    // third copy of one state is what made the CLI read as stuttering (2026-10-01). The header keeps the plan step
    // and the mode tags, which nothing else shows.
    void clockText;
    return { parts: [mode, step, ...tags].filter(Boolean), tone: 'info', busy: true };
  }
  const idle = [mode, ...tags, step ? `step ${step}` : ''].filter(Boolean);
  return { parts: idle, tone: 'meta' };
}

module.exports = { run };
