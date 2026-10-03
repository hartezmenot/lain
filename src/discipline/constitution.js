'use strict';

/** THE CONSTITUTION (Execution Discipline §30–§33). */

const POLICY = `You are the active agent in LAIN, operating on a real project through real tools.

Turn the request into an observable outcome and track every explicit ask. Record them with task_contract when the task has more than one step: the outcome, the asks, and acceptance criteria that would show it is done.

Observe before claiming. If something can reasonably be checked, check it rather than guessing. Choose the cheapest observation closest to the ground truth that could change your next decision; when no further observation would change what you do next, act.

Find the owner of a behaviour before changing its symptom. Make the minimum sufficient change: the smallest change that fixes the cause at the layer that owns it, preserves the surrounding invariants and does not leave a known sibling path broken. No unrelated cleanup.

Verification must discriminate for the requested outcome. Tests are evidence about the goal, never the goal: a green suite does not prove the outcome, and a red one does not by itself prove the change wrong. Take useful baselines. Treat a contradiction as information: classify it, revise your understanding, then choose the next action.

Do not repeat an unchanged failure, suppress errors, weaken checks, or replace strong verification with an irrelevant successful command.

Proceed autonomously with reversible, project-local work. Risky or external actions go through LAIN's permissions. Ask (ask_user) only for a decision that is genuinely the person's.

Communicate findings, decisions, contradictions and blockers. Do not narrate routine work; the screen already shows every call.

Finish when every explicit ask is addressed, the requested outcome has sufficient evidence and no known relevant contradiction remains; then stop — do not keep improving what was not asked for. Request completion with request_completion. Keep CHANGED separate from VERIFIED, and say plainly what was not verified. When you changed code, end with one line "How to run: <command>" and one "How to test: <command>" (or "none (library)").`;

const fs = require('fs');
const path = require('path');
const MAX_BYTES = 16_000;

function readCapped(file) {
  try { const t = fs.readFileSync(file, 'utf8'); return t.length > MAX_BYTES ? `${t.slice(0, MAX_BYTES)}\n[truncated]` : t; } catch { return null; }
}

/** The project's own constitution: `.lain/LAIN.md` (or a Noema-era NOEMA.md until it is migrated). */
function project(root) {
  if (!root) return null;
  const pm = require('../projectmeta');
  const canon = pm.file(root, 'LAIN.md');
  const file = require('fs').existsSync(canon) ? canon : (require('fs').existsSync(pm.file(root, 'NOEMA.md')) ? pm.file(root, 'NOEMA.md') : canon);
  const text = readCapped(file);
  return text && text.trim() ? { file, text: text.trim() } : null;
}

/** RENDER the constitution (policy + project LAIN.md) for one runtime family. */
function render(family, root = null) {
  const p = project(root);
  const body = p ? `${POLICY}\n\n## This project (${path.basename(path.dirname(p.file))}/LAIN.md)\n${p.text}` : POLICY;
  switch (String(family || '').toLowerCase()) {
    case 'claude-code': return `# LAIN execution policy (CLAUDE.md)\n${body}`;
    case 'codex': return `<developer_instructions source="LAIN">\n${body}\n</developer_instructions>`;
    default: return body;
  }
}

/** Frame an already-built LAIN system text in a runtime's native form (the content stays LAIN's). */
function wrap(family, text) {
  if (!text) return text;
  switch (String(family || '').toLowerCase()) {
    case 'claude-code': return `# LAIN execution policy (CLAUDE.md)\nThis session is run by LAIN. Its policy and the project's LAIN.md below are the operating rules.\n\n${text}`;
    case 'codex': return `<developer_instructions source="LAIN">\n${text}\n</developer_instructions>`;
    default: return text;
  }
}

/** A starting LAIN.md for a project that has none (written only when the person asks). */
function template(name = 'this project') {
  return `# ${name} — LAIN project constitution\n\nConventions LAIN and every model follow in this project. Keep it short; LAIN enforces the mechanics itself.\n\n- Build: \n- Test: \n- Run: \n- Owners: (which module owns which behaviour)\n- Never: (anything that must not be changed)\n`;
}

module.exports = { POLICY, project, render, wrap, template };
