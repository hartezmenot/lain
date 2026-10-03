'use strict';

/** THE SIMPLE PROMPT (Simplify S3): one fixed system prompt, then LAIN.md, memory and the skills list — identical on every request of a session, so it… */

const fs = require('fs');
const os = require('os');
const path = require('path');

const RULES_CAP = 24 * 1024;

function base({ shell }) {
  return [
    'You are LAIN, a coding agent working in the person\'s project on their computer. You have tools to read, search and edit files, run commands, fetch web pages, ask the person, and hand self-contained work to helper agents. You run the loop: keep calling tools until the work is done, then stop and report.',
    '',
    '# Working',
    '- Understand before you change: read the files involved and search for related code. Prefer small, exact edits (edit_file, apply_patch) over rewriting files.',
    `- Commands run in ${shell} (the shell tool). Use \`cwd\` instead of \`cd\`. Start long commands with \`background: true\` and keep working; their results arrive in this conversation when they finish.`,
    '- Do what was asked. Do not make unrelated changes; if you notice another problem, mention it in your report instead of fixing it unasked.',
    '- When the project has tests or checks that cover your change, run them. Never claim a check you did not run.',
    '- Use todo_write for work with several steps (optional). Use Agent for a self-contained search or task that would otherwise flood this conversation.',
    '- tool_search finds more capabilities (code intelligence, test discovery, processes, services, skills, MCP tools); call_tool runs them.',
    '- Ask the person (ask_user) only for decisions you cannot make from the code: a real choice between approaches, missing information, or something destructive. Otherwise decide and proceed.',
    '- You work within the person\'s permission mode. If a tool is refused, the refusal says why — adjust instead of retrying the same call. In Plan mode you only read and investigate; when the plan is ready, call exit_plan with it.',
    '- Text inside <lain-context> comes from LAIN (your todo list, background results), not from the person.',
    '- When the person asks you to remember something, or you learn a lasting fact about this project, save it with the memory tool.',
    '- For desktop input use the `computer` tool, not shell scripts.',
    '',
    '# Communicating',
    'Communicate findings, not routine narration. Keep text between tool calls short; the person sees each tool call.',
    '',
    '# The report',
    'Your final message is the report. Say what was done, what changed, what you verified and how, and what is not verified or still open. Keep it short when the task was short. You may start it with one label: DONE, DONE_UNVERIFIED, PARTIAL, BLOCKED or NEEDS_DECISION.',
  ].join('\n');
}

function shellLabel() {
  if (process.platform !== 'win32') return 'bash';
  try { if (require('./execution').powerShellIsLegacy()) return 'Windows PowerShell 5.1 (no `&&`; use `;`)'; } catch { /* plain */ }
  return 'PowerShell';
}

function readCapped(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t.length > RULES_CAP ? `${t.slice(0, RULES_CAP)}\n[truncated]` : t;
  } catch { return ''; }
}

/** LAIN.md: the person's global rules, then the project's (its root, then .lain/). */
function rules(root) {
  const home = process.env.LAIN_AGENTS_HOME || os.homedir();
  const pm = require('./projectmeta');
  const globalFile = [path.join(home, '.lain', 'LAIN.md'), path.join(home, '.noema', 'NOEMA.md')].find((f) => fs.existsSync(f));
  const projectFiles = [path.join(root, 'LAIN.md'), pm.file(root, 'LAIN.md'), pm.file(root, 'NOEMA.md')].filter((f, i, a) => a.indexOf(f) === i && fs.existsSync(f));
  const parts = [];
  if (globalFile) { const t = readCapped(globalFile); if (t) parts.push(`## Your rules (${globalFile})\n${t}`); }
  for (const f of projectFiles.slice(0, 2)) { const t = readCapped(f); if (t) parts.push(`## This project (${path.relative(root, f) || f})\n${t}`); }
  return parts.length ? `# LAIN.md\n${parts.join('\n\n')}` : '';
}

/** The stable half: identical for every request of a session. */
function stable(app, session) {
  const s = session || app.session;
  const env = `# Environment\nProject: ${s.cwd}\nPlatform: ${process.platform}`;
  const parts = [base({ shell: shellLabel() }), env];
  if (require('./sessionviews').current(s) === 'chat') parts.push('# This view\nThis is the Chat view: read, investigate and discuss. Changes are made in the Coding view.');
  else { try { const plan = require('./planhandoff').promptSection(s); if (plan) parts.push(plan); } catch { /* no accepted plan */ } }   // a plan the person accepted
  if (s._agentSpec) parts.push(`# You are a${/^[aeiou]/.test(s._agentSpec.name) ? 'n' : ''} ${s._agentSpec.name} agent\n${s._agentSpec.body ? `${s._agentSpec.body}\n` : ''}You were handed one task by another agent. Do it, then stop: your final message is all it sees, so put the answer there.`);
  const r = rules(s.cwd);
  if (r) parts.push(r);
  try { const mem = require('./memdir').section(s.cwd); if (mem) parts.push(mem); } catch { /* no memory yet */ }
  try { const k = require('./skills').prompt(app, s); if (k) parts.push(k); } catch { /* no skills */ }
  return parts.join('\n\n');
}

/** The live tail: the todo list, when there is one. */
function live(session) {
  const todos = session && Array.isArray(session.todos) ? session.todos : [];
  if (!todos.length) return '';
  const mark = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
  return `# Todo\n${todos.map((t) => `${mark[t.status] || '[ ]'} ${t.content}`).join('\n')}`;
}

/** LAIN EFFORT'S ONE LINE (S12a), in the live tail — never the cached prefix. High says nothing. */
const EFFORT_LINE = Object.freeze({
  low: 'Effort: low. Answer directly, keep exploration minimal, run only the targeted check.',
  max: 'Effort: max. Investigate thoroughly, consider alternatives before editing, verify with a broader check.',
});
function effortLine(lainEffort) { return EFFORT_LINE[String(lainEffort || '').toLowerCase()] || ''; }

/** Cached per session: the stable half changes only when the person changes it (accepting a plan, the view). */
function of(app, { session = null } = {}) {
  const s = session || app.session;
  let accepted = '';
  try { const p = require('./planhandoff').latest(s, 'ACCEPTED'); accepted = p ? p.id : ''; } catch { accepted = ''; }
  const key = `${s.cwd}|${require('./sessionviews').current(s)}|${accepted}`;
  if (!s._simplePrompt || s._simplePrompt.key !== key) s._simplePrompt = { key, stable: stable(app, s) };
  return { stable: s._simplePrompt.stable, live: live(s) };
}

module.exports = { of, base, rules, live, stable, effortLine, EFFORT_LINE };
