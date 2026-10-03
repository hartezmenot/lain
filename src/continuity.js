'use strict';

/** WHAT SURVIVED — compaction and resume, said out loud. */

const path = require('path');

/** `189k` — sizes at the scale a person reads them. */
function k(n) {
  return `${Math.round((Number(n) || 0) / 1000)}k`;
}

/** What a compaction just did, and what it kept. */
function compactionSummary(session, fit = {}) {
  const kept = [];
  const task = session && session.task;
  const life = session && session.lifecycle;

  if (task && task.objective) kept.push('the objective');
  // The user's own corrections are the one thing that cannot be recovered by
  // re-reading the repository, so they are named first and by count.
  const steers = (task && Array.isArray(task.steers) && task.steers.length) || 0;
  if (steers) kept.push(`${steers} correction${steers === 1 ? '' : 's'} you made`);
  const plan = session && session.plan;
  if (plan && plan.steps && plan.steps.length) {
    kept.push(`the plan (${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} done)`);
  }
  if (life && life.evidence) {
    const files = [...(life.evidence.filesChanged || [])];
    if (files.length) kept.push(`${files.length} changed file${files.length === 1 ? '' : 's'}`);
    if (life.lastCommand) {
      const word = life.lastCommand.ok === true ? 'passed' : life.lastCommand.ok === false ? 'FAILED' : 'inconclusive';
      kept.push(`the last check (${word})`);
    }
  }

  const headline = `CONTEXT COMPACTION  ${k(fit.before)} → ${k(fit.after)} chars`;
  return { headline, kept };
}

/** What a resume genuinely restored, and what it could not. */
function resumeSummary(session, app = null) {
  const out = [];
  const task = session && session.task;
  const life = session && session.lifecycle;
  const plan = session && session.plan;

  const say = (ok, text) => out.push({ ok, text });

  say(true, `${(session.messages || []).length} messages, ${(session.turns || []).length} turns`);
  if (task && task.objective) say(true, `objective: ${String(task.objective).replace(/\s+/g, ' ').slice(0, 70)}`);
  else say(false, 'no objective was recorded — this session had no active task');

  const steers = (task && Array.isArray(task.steers) && task.steers.length) || 0;
  if (steers) say(true, `${steers} correction${steers === 1 ? '' : 's'} you made, still overriding the original request`);
  else say(false, 'no corrections recorded');

  if (plan && plan.steps && plan.steps.length) {
    say(true, `plan: ${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} steps done`);
  } else say(false, 'no plan — this session did not use one');

  const files = life && life.evidence ? [...(life.evidence.filesChanged || [])] : [];
  if (files.length) say(true, `files changed: ${files.slice(0, 4).map((f) => path.basename(f)).join(', ')}${files.length > 4 ? ` +${files.length - 4}` : ''}`);
  else say(false, 'no files were changed in that session');

  if (life && life.lastCommand) {
    const c = life.lastCommand;
    const text = c.ok === true ? `last check: ${c.command} — passed`
      : c.ok === false ? `last check: ${c.command} — FAILED, and it is still red`
      : `last check: ${c.command} — INCONCLUSIVE${c.note ? ` (${c.note})` : ''}, not verified either way`;
    say(c.ok === true, text);
  } else say(false, 'no check had been run, so nothing is verified');

  // WHAT ELSE THIS SESSION HAD IN FLIGHT
  if (!app) return out;


  try {
    // WHICH MODEL ANSWERS A CHAT TURN — a session fact, and one a person resuming needs: a session that was consulting ChatGPT.com and comes back silently…
    const reg = require('./modelsource/registry');
    const src = reg.selectedId(app);
    const model = ((app.session && app.session.sourceSelections) || {})[src] || null;
    const web = reg.usingWeb(app);
    say(!web || Boolean(model), web
      ? `chat source: ${reg.LABEL[src]}${model ? ` · ${model}` : ' — no model chosen yet'}`
      : 'chat source: LAIN\'s own runtime');
  } catch { /* the registry is unreadable — say nothing rather than guess */ }

  try {
    const d = app.desktop().bridge.status();
    const active = d.permissions && d.permissions.active;
    say(!active, active
      ? `desktop permission is GRANTED right now${d.target ? ` for ${d.target}` : ''} — /mcp revoke ends it`
      : 'desktop permission: nothing granted (a restart always clears it)');
  } catch { /* no bridge — nothing to say */ }

  return out;
}

/** Render either summary through a renderer. Shared so both look alike. */
function writeRows(app, rows, { C } = {}) {
  const col = C || { green: (s) => s, dim: (s) => s, yellow: (s) => s };
  for (const r of rows) {
    app.render.write((r.ok ? col.green('  ✓ ') : col.dim('  · ')) + (r.ok ? r.text : col.dim(r.text)) + '\n');
  }
}

module.exports = { compactionSummary, resumeSummary, writeRows, k };
