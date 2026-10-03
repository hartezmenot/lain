'use strict';

/** WHAT GIT SAYS ABOUT THE TREE, ONCE PER TURN, OFF THE REQUEST PATH. */

const gitsense = require('./gitsense');

/** Files listed before the section says "…and more". A briefing, not an inventory. */
const MAX_FILES = 12;
/** Rows of observations (the shape facts) before the same cut. */
const MAX_NOTES = 4;

/** THE SECTION, from a `gitsense.review` result. */
function say(review) {
  if (!review || !review.ok || !review.files || !review.files.length) return '';

  const lines = [];
  const mod = review.files.filter((f) => !f.untracked && !f.deleted).slice(0, MAX_FILES);
  const untracked = review.files.filter((f) => f.untracked).slice(0, MAX_FILES);
  const deleted = review.files.filter((f) => f.deleted).slice(0, MAX_FILES);
  const more = review.files.length - mod.length - Math.min(untracked.length, MAX_FILES) - Math.min(deleted.length, MAX_FILES);

  const row = (f) => `  ${f.file}  +${f.added} -${f.removed}${f.rewrite ? '  [whole file rewritten]' : ''}`;
  if (mod.length) {
    lines.push('Working tree vs the last commit (this session did not write all of these):');
    lines.push(...mod.map(row));
  }
  if (untracked.length) {
    lines.push(`${mod.length ? '' : 'Working tree vs the last commit:\n'}  untracked: ${untracked.map((f) => f.file).join(', ')}`);
  }
  if (deleted.length) lines.push(`  deleted: ${deleted.map((f) => f.file).join(', ')}`);
  if (more > 0) lines.push(`  (+${more} more)`);

  // THE SHAPE FACTS THAT CHANGE THE NEXT MOVE
  const notes = [];
  if (review.huge) notes.push(`the change set is ${review.totalLines} lines — if the task was small, most of this was not asked for`);
  const surprise = review.files.filter((f) => f.unexpected && !f.untracked);
  if (surprise.length) {
    notes.push(`${surprise.length} file(s) differ that this session never wrote (${surprise.slice(0, 3).map((f) => f.file).join(', ')}${surprise.length > 3 ? '…' : ''}) — they may have been dirty before this session started`);
  }
  const gen = review.files.filter((f) => f.generated);
  if (gen.length) {
    notes.push(`generated or built files in the change set (${gen.slice(0, 3).map((f) => f.file).join(', ')}${gen.length > 3 ? '…' : ''}) — usually produced by a command, not edited`);
  }
  const rewrites = review.files.filter((f) => f.rewrite);
  if (rewrites.length) {
    notes.push(`whole-file rewrites: ${rewrites.slice(0, 3).map((f) => f.file).join(', ')}${rewrites.length > 3 ? '…' : ''} — the signature of writing a file back whole rather than patching it`);
  }
  if (notes.length) {
    lines.push('', 'Worth knowing:', ...notes.slice(0, MAX_NOTES).map((n) => `  - ${n}`));
  }

  return lines.join('\n');
}

/** THE REFRESH — one background measurement, stored for the synchronous reader. */
function prefetch(app, expected = []) {
  if (!app || !app.session || !app.session.cwd) return Promise.resolve(null);
  const cwd = app.session.cwd;
  // THE OLD MEASUREMENT IS WITHDRAWN NOW, synchronously.
  app._gitSnapshot = null;
  return Promise.resolve()
    .then(() => gitsense.review(cwd, { expected }))
    .then((r) => { app._gitSnapshot = r || null; return r; })
    .catch(() => { /* leave whatever was there; a failed measure is silence */ });
}

/** Forget the measurement. `adopt` calls this — a new session is a new tree. */
function reset(app) {
  if (app) app._gitSnapshot = null;
}

/** THE FILES THIS SESSION HAS WRITTEN, as absolute paths — the checkpoint ledger's answer, which is the same source pretest.js and /changes read, so… */
function touched(app) {
  try {
    const rows = require('./ui/panes').changedFiles({
      checkpoints: app && app.checkpoints,
      cwd: app && app.session && app.session.cwd,
    });
    return (rows || []).map((r) => (r && r.path) || '').filter(Boolean);
  } catch { return []; }
}

module.exports = { say, prefetch, reset, touched, MAX_FILES, MAX_NOTES };
