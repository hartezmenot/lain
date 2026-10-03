'use strict';

/**
 * THE FACT FOOTER (Simplify S4): what LAIN itself recorded during a turn, shown under the model's report — files
 * changed with +/- counts, commands with exit code and duration, background jobs still running, agents used. Built
 * only from records Core already has; shown in the CLI and Harness, never sent to the model.
 */

const path = require('path');

const SHELLS = /^(shell|run_(bash|powershell|cmd)|bash|Bash)$/;
const MAX_ITEMS = 8;

function rel(cwd, p) {
  if (!cwd) return String(p).replace(/\\/g, '/');
  const abs = path.resolve(cwd, String(p));
  const r = path.relative(cwd, abs);
  return (r && !r.startsWith('..') ? r : abs).replace(/\\/g, '/');
}

/** The facts of one turn record, plus the jobs and agents still running in this app. */
function of(record, app = null) {
  const cwd = app && app.session ? app.session.cwd : '';
  const acts = (record && record.actions) || [];
  const files = new Map();
  for (const a of acts) {
    if (!a.path || !(a.added || a.removed)) continue;
    const k = rel(cwd, a.path);
    const f = files.get(k) || { path: k, added: 0, removed: 0 };
    f.added += a.added || 0; f.removed += a.removed || 0;
    files.set(k, f);
  }
  for (const m of (record && record.mutations) || []) {
    const k = rel(cwd, m);
    if (!files.has(k)) files.set(k, { path: k, added: null, removed: null });
  }
  const commands = acts.filter((a) => SHELLS.test(a.name) && !a.denied)
    .map((a) => ({ command: a.target || '', exitCode: a.exitCode == null ? null : a.exitCode, ms: a.ms || 0, job: a.job || null, ok: a.ok !== false }));
  const agents = acts.filter((a) => a.name === 'Agent' && !a.denied).map((a) => ({ what: a.target || 'agent', ms: a.ms || 0, ok: a.ok !== false, job: a.job || null }));
  const running = [];
  try { for (const j of (app && app._jobs ? app._jobs.running() : [])) running.push({ id: j.id, what: j.command }); } catch { /* no jobs */ }
  try { for (const j of (app && app.jobs ? app.jobs.running() : [])) if (j.kind === 'subagent') running.push({ id: j.id, what: j.request, agent: true }); } catch { /* no agents */ }
  return { files: [...files.values()], commands, running, agents };
}

function empty(f) { return !f || !(f.files.length || f.commands.length || f.running.length || f.agents.length); }

function secs(ms) { return ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }

function capped(items, fmt) {
  const shown = items.slice(0, MAX_ITEMS).map(fmt);
  if (items.length > MAX_ITEMS) shown.push(`+${items.length - MAX_ITEMS} more`);
  return shown;
}

/** One line per kind of fact; empty when the turn left none. */
function lines(f) {
  if (empty(f)) return [];
  const out = [];
  if (f.files.length) out.push(`Files changed: ${capped(f.files, (x) => (x.added == null ? x.path : `${x.path} +${x.added} -${x.removed}`)).join(' · ')}`);
  if (f.commands.length) out.push(`Commands: ${capped(f.commands, (c) => `${c.command} (${c.job ? `background #${c.job}` : c.exitCode != null ? `exit ${c.exitCode}` : c.ok ? 'no exit code' : 'failed'}, ${secs(c.ms)})`).join(' · ')}`);
  if (f.running.length) out.push(`Still running: ${capped(f.running, (j) => `#${j.id} ${j.what}`).join(' · ')}`);
  if (f.agents.length) out.push(`Agents: ${capped(f.agents, (a) => `${a.what} (${a.job ? `background #${a.job}` : `${a.ok ? 'returned' : 'failed'}, ${secs(a.ms)}`})`).join(' · ')}`);
  return out;
}

/** Puts the facts on the kept turn and on the turn's last assistant message (a field the wire never sends). */
function attach(app, record) {
  const f = of(record, app);
  if (empty(f)) return null;
  record.facts = f;
  const s = app.session;
  const kept = (s.turns || [])[s.turns.length - 1];
  if (kept && kept.turnId === record.turnId) kept.facts = f;
  for (let i = (s.messages || []).length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'user' && !m.tool_call_id) break;
    if (m.role === 'assistant' && String(m.content || '').trim()) { m.facts = f; break; }
  }
  return f;
}

/** Feed entries for the TUI conversation: one quiet unlabelled row per fact line. */
function push(out, f) { for (const l of lines(f)) out.push({ kind: 'facts', text: l }); }

module.exports = { of, lines, attach, empty, push };
