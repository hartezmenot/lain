'use strict';

/** LEAVING PLAN MODE (Simplify S5): exit_plan saves the plan to `.lain/plans/<slug>.md` and shows it — the CLI offers Approve / Edit ($EDITOR) / Keep… */

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 40;

function slug(text) {
  const first = String(text).split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || 'plan';
  const s = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
  return `${new Date().toISOString().slice(0, 10)}-${s}`;
}

/** The plan's checklist: `- [ ] step` lines, else numbered lines, else top-level bullets. */
function checklist(text) {
  const lines = String(text).split(/\r?\n/);
  const pick = (re) => lines.map((l) => re.exec(l)).filter(Boolean).map((m) => m[m.length - 1].trim()).filter(Boolean);
  const boxes = pick(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/);
  const items = boxes.length ? boxes : pick(/^\s*\d+[.)]\s+(.+)$/).length ? pick(/^\s*\d+[.)]\s+(.+)$/) : pick(/^[-*]\s+(.+)$/);
  return items.slice(0, MAX_ITEMS);
}

/** Open a file in the person's editor and wait for it to close (the TUI steps aside meanwhile). */
function edit(app, file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const ui = app && app.ui && app.ui.enabled ? app.ui : null;
  const inp = app && app.input && app.input.isTTY ? app.input : null;
  try {
    if (ui && ui.screen) ui.screen.leave();
    if (inp) { try { inp.stdin.setRawMode(false); } catch { /* not a tty */ } }
    const r = require('child_process').spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    return r.error ? { ok: false, why: r.error.message } : { ok: true };
  } finally {
    if (inp) { try { inp.stdin.setRawMode(true); } catch { /* not a tty */ } }
    if (ui && ui.screen) { ui.screen.enter(); try { ui.refresh(); } catch { /* redrawn on the next frame */ } }
  }
}

async function exitPlan(input = {}, ctx = {}) {
  const app = ctx.app;
  const session = ctx.session || (app && app.session);
  const execmode = require('./execmode');
  if (!session || execmode.of(session) !== 'PLAN') return { output: 'Not in Plan mode — there is nothing to approve; carry on.' };
  const proposed = String(input.plan || '').trim();
  if (!proposed) return { output: 'exit_plan needs the plan: markdown, with a checklist of steps.', isError: true };
  const file = require('./projectmeta').file(session.cwd, 'plans', `${slug(proposed)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${proposed}\n`);
  const rel = path.relative(session.cwd, file).replace(/\\/g, '/');
  session._planFile = file;
  for (;;) {
    const text = fs.readFileSync(file, 'utf8').trim();
    const answer = await require('./decisions').ask(app, {
      type: 'PLAN_APPROVAL', title: 'Plan ready — build it?', question: `${rel}\n\n${text}`,
      options: ['Approve', 'Edit', 'Keep planning'], plan: { file, text },
    }, ctx.signal);
    if (answer === 'Edit') {
      const r = edit(app, file);
      if (!r.ok) return { output: `The editor did not open (${r.why}). The plan is saved at ${rel}; stay in Plan mode.` };
      continue;
    }
    if (answer === 'Approve') return approve(ctx, session, file, rel, proposed);
    if (answer === 'Keep planning') return { output: 'The person wants to keep planning. Stay in Plan mode: investigate or ask what is unclear, then call exit_plan again.' };
    return { output: `No one approved the plan; it is saved at ${rel}. Stay in Plan mode.` };
  }
}

async function approve(ctx, session, file, rel, proposed) {
  const execmode = require('./execmode');
  const text = fs.readFileSync(file, 'utf8').trim();
  const before = execmode.MODES.includes(session._modeBeforePlan) && session._modeBeforePlan !== 'PLAN' && session._modeBeforePlan !== 'ASK' ? session._modeBeforePlan : 'ACCEPT_EDITS';
  execmode.set(session, before);
  try { session.save(); } catch { /* the mode still applies in memory */ }
  const items = checklist(text);
  if (items.length) await require('./tools/core').tools.todo_write.run({ todos: items.map((content) => ({ content, status: 'pending' })) }, ctx);
  const edited = text !== proposed ? `\n\nThe person edited the plan; this is the approved version:\n${text}` : '';
  return { output: `Approved. Mode: ${execmode.WORD[before]}. The plan is saved at ${rel}${items.length ? `; your todo list holds its ${items.length} step(s)` : ''}. Build it.${edited}` };
}

module.exports = { exitPlan, checklist, slug, edit };
