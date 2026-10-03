'use strict';

/** WHAT THE HEADER'S RIGHT HALF SAYS (§4, §11–13). */

function run(ui) {
  const app = ui.app;
  const session = app.session;
  const execmode = require('../execmode');
  const mode = execmode.of(session);
  // THE PERMISSION MODE, in words; Auto in an untrusted project says what applies instead.
  const eff = execmode.effective(app, session);
  const modeText = eff === mode ? execmode.WORD[mode] : `${execmode.WORD[mode]} → ${execmode.WORD[eff]} until trusted`;
  const prefs = execmode.prefs(session);
  const busy = Boolean(ui.busy || ui.phase);
  const clock = require('./workclock').reading(ui.clock);
  const tags = [prefs.focus ? 'FOCUS' : '', require('../profile').label(session)].filter(Boolean);   // FAST · ECO; NORMAL says nothing
  // AGENTS n — only while subagents actually run (the job registry, never narration).
  const agents = app.jobs && typeof app.jobs.running === 'function' ? app.jobs.running().filter((j) => j.kind === 'subagent').length : 0;
  if (agents) tags.push(`AGENTS ${agents}`);
  // COMPUTER CONTROL IS NEVER SILENT (Phase CU): "● Computer · Minecraft" first among the tags while it is on — the
  // header keeps the first two parts when it is short of room — and the row turns to the warning tone.
  const cu = require('../computercontrol').label(app);
  if (cu) tags.unshift(cu);
  // AN UPDATE, in the words every surface uses (update/ux.js) — cached state, never the network.
  try { const up = require('../update/ux').view(app); if (up.label) tags.push(up.label); } catch { /* no updater state */ }
  if (mode === 'PLAN') return { parts: ['Plan', 'read-only', ...tags], tone: 'warn' };
  let step = null;
  const plan = require('./progress').livePlan(session);
  if (plan) {
    const p = require('./progress').progressOf(plan);
    if (p.known && p.completed < p.total) step = `${p.current}/${p.total}`;
  }
  if (busy) {
    const clockText = clock.shown ? clock.text.replace(/^00:/, '') : null;
    // NOT `RUNNING · 04:18` any more: the live row below already says what is happening and for how long, and a third copy of one state is what made the…
    void clockText;
    return { parts: [modeText, step, ...tags].filter(Boolean), tone: cu ? 'warn' : 'info', busy: true };
  }
  const idle = [modeText, ...tags, step ? `step ${step}` : ''].filter(Boolean);
  return { parts: idle, tone: cu ? 'warn' : 'meta' };
}

module.exports = { run };
