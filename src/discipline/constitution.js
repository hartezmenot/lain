'use strict';

/**
 * THE CONSTITUTION (Execution Discipline §30–§33).
 *
 * POLICY — the short standing instruction every model gets. It teaches judgment, not procedure: everything Noema can
 * enforce mechanically (stale edits, permissions, repeated failures, claim verification, test-integrity checks, task
 * continuation, scope) is enforced in Core and reaches the model as a CONTEXTUAL message when it applies — never as
 * a permanent wall of warnings.
 *
 * `.noema/NOEMA.md` — the canonical PROJECT constitution: this project's conventions, owned by Noema (not by any one
 * provider). Provider-native forms are RENDERED from it — CLAUDE.md-style context for Claude Code, AGENTS.md-style
 * developer instructions for Codex, a plain system section for everything else — and never become separate
 * authorities. A legacy `.noema/AGENTS.md` / `.lain/AGENTS.md` is read when no NOEMA.md exists (agentsmd.js).
 */

const POLICY = `You are the active agent in Noema, operating on a real project through real tools.

Turn the request into an observable outcome and track every explicit ask. Record them with task_contract when the task has more than one step: the outcome, the asks, and acceptance criteria that would show it is done.

Observe before claiming. If something can reasonably be checked, check it rather than guessing. Choose the cheapest observation closest to the ground truth that could change your next decision; when no further observation would change what you do next, act.

Find the owner of a behaviour before changing its symptom. Make the minimum sufficient change: the smallest change that fixes the cause at the layer that owns it, preserves the surrounding invariants and does not leave a known sibling path broken. No unrelated cleanup.

Verification must discriminate for the requested outcome. Tests are evidence about the goal, never the goal: a green suite does not prove the outcome, and a red one does not by itself prove the change wrong. Take useful baselines. Treat a contradiction as information: classify it, revise your understanding, then choose the next action.

Do not repeat an unchanged failure, suppress errors, weaken checks, or replace strong verification with an irrelevant successful command.

Proceed autonomously with reversible, project-local work. Risky or external actions go through Noema's permissions. Ask (ask_user) only for a decision that is genuinely the person's.

Communicate findings, decisions, contradictions and blockers. Do not narrate routine work; the screen already shows every call.

Finish when every explicit ask is addressed, the requested outcome has sufficient evidence and no known relevant contradiction remains; then stop — do not keep improving what was not asked for. Request completion with request_completion. Keep CHANGED separate from VERIFIED, and say plainly what was not verified. When you changed code, end with one line "How to run: <command>" and one "How to test: <command>" (or "none (library)").`;

const fs = require('fs');
const path = require('path');
const MAX_BYTES = 16_000;

function readCapped(file) {
  try { const t = fs.readFileSync(file, 'utf8'); return t.length > MAX_BYTES ? `${t.slice(0, MAX_BYTES)}\n[truncated]` : t; } catch { return null; }
}

/** The project's own constitution: `.noema/NOEMA.md` (or LAIN's `.lain/NOEMA.md` in an unmigrated project). */
function project(root) {
  if (!root) return null;
  const file = require('../projectmeta').file(root, 'NOEMA.md');
  const text = readCapped(file);
  return text && text.trim() ? { file, text: text.trim() } : null;
}

/**
 * RENDER the constitution (policy + project NOEMA.md) for one runtime family. Same content, the surface each provider
 * reads natively — so Claude Code, Codex, GLM or a local model all receive Noema's policy, not their own.
 */
function render(family, root = null) {
  const p = project(root);
  const body = p ? `${POLICY}\n\n## This project (${path.basename(path.dirname(p.file))}/NOEMA.md)\n${p.text}` : POLICY;
  switch (String(family || '').toLowerCase()) {
    case 'claude-code': return `# Noema execution policy (CLAUDE.md)\n${body}`;
    case 'codex': return `<developer_instructions source="Noema">\n${body}\n</developer_instructions>`;
    default: return body;
  }
}

/** Frame an already-built Noema system text in a runtime's native form (the content stays Noema's). */
function wrap(family, text) {
  if (!text) return text;
  switch (String(family || '').toLowerCase()) {
    case 'claude-code': return `# Noema execution policy (CLAUDE.md)\nThis session is run by Noema. Its policy and the project's NOEMA.md below are the operating rules.\n\n${text}`;
    case 'codex': return `<developer_instructions source="Noema">\n${text}\n</developer_instructions>`;
    default: return text;
  }
}

/** A starting NOEMA.md for a project that has none (written only when the person asks). */
function template(name = 'this project') {
  return `# ${name} — Noema project constitution\n\nConventions Noema and every model follow in this project. Keep it short; Noema enforces the mechanics itself.\n\n- Build: \n- Test: \n- Run: \n- Owners: (which module owns which behaviour)\n- Never: (anything that must not be changed)\n`;
}

module.exports = { POLICY, project, render, wrap, template };
