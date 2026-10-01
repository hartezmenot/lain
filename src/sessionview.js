'use strict';

/**
 * `/session` — every Noema session on this machine that has been run, and what it is doing (2026-10-02).
 *
 * Read from the stores that own it: the session lease (sessionlease.js — who runs it, alive or not) and the session
 * journal (sessionjournal.js — its last turn). Sessions in OTHER terminals and in the Harness are listed too, because
 * both write the same files. No process is asked; nothing is started.
 *
 * A PERCENTAGE APPEARS ONLY WHERE SOMETHING COUNTED ONE: the plan's own steps, recorded in the journal's phase events.
 */

const path = require('path');

function rows() { return require('./runtimefeed').sessionRows({ limit: 30 }); }

function titleOf(id) {
  try {
    const r = require('./sessionindex').summaries({ limit: 200 }).find((x) => x.id === id);
    return r ? { title: require('./sessionindex').headline(r), project: r.cwd ? path.basename(r.cwd) : '' } : { title: '', project: '' };
  } catch { return { title: '', project: '' }; }
}

function lineOf(r, i) {
  const t = titleOf(r.session);
  const who = r.owner_pid ? `${r.surface || 'cli'} pid ${r.owner_pid}` : 'not running';
  const when = r.at ? new Date(r.at).toLocaleString() : '';
  return `${String(i + 1).padStart(2)}. ${r.state.padEnd(15)} ${(t.project || '').slice(0, 18).padEnd(18)} ${(t.title || r.session).slice(0, 40).padEnd(40)} ${who}  ${when}`;
}

function register({ define, C }) {
  define('/session', {
    surface: true,
    flashMs: 0,
    args: '[n|id]',
    desc: 'Every Noema session that has run here — running, finished, interrupted — in any terminal or the Harness',
    async run(app, ctx) {
      const w = (line) => app.render.write(`${line}\n`);
      const want = String((ctx.rest || '').trim());
      const list = rows();
      w('');
      if (!list.length) { w(C.dim('  No session has run on this machine yet.')); w(''); return; }
      if (!want) {
        list.forEach((r, i) => w(`  ${paint(lineOf(r, i), C)}`));
        w('');
        w(C.dim('  /session <n>  one of them in detail'));
        w('');
        return;
      }
      const n = Number(want);
      const r = Number.isInteger(n) && n > 0 ? list[n - 1] : list.find((x) => x.session === want || x.session.endsWith(want));
      if (!r) { w(C.yellow(`  There is no session ${want}.`)); w(C.dim('  Run /session for the list.')); w(''); return; }
      const t = titleOf(r.session);
      const j = require('./sessionjournal').state(r.session);
      w(`  ${paint(r.state, C)}  ${t.title || r.session}`);
      if (t.project) w(C.dim(`  project   ${t.project}`));
      w(C.dim(`  session   ${r.session}`));
      w(C.dim(`  host      ${r.owner_pid ? `${r.surface || 'cli'} (pid ${r.owner_pid})` : 'none — not running anywhere'}`));
      if (r.model) w(C.dim(`  model     ${r.model}`));
      if (j.phase) w(C.dim(`  phase     ${j.phase}`));
      if (j.tool) w(C.dim(`  running   ${j.tool.name}${j.tool.target ? ` ${j.tool.target}` : ''}`));
      if (r.needs_handover && r.handover_reason) w(C.yellow(`  ${r.handover_reason}`));
      if (r.usage) w(C.dim(`  last turn ${r.usage.input_tokens || 0} in · ${r.usage.output_tokens || 0} out`));
      w('');
    },
  });
}

/** The state vocabulary, coloured. Words only, never meaning. */
const COLOURS = Object.freeze({
  RUNNING: 'cyan',
  COMPLETED: 'green',
  FAILED: 'yellow',
  PROVIDER: 'yellow',
  LOST: 'yellow',
  INTERRUPTED: 'yellow',
  RATE_LIMITED: 'yellow',
  BLOCKED: 'yellow',
  WAITING: 'yellow',
  IDLE: 'dim',
  UNKNOWN: 'dim',
});

function paint(line, C) {
  for (const [word, colour] of Object.entries(COLOURS)) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(line)) return line.replace(re, (m) => (C[colour] ? C[colour](m) : m));
  }
  return line;
}

module.exports = { register, paint, COLOURS };
