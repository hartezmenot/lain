'use strict';

/** SOURCE CONTROL FOR THE IDE — status, diff, stage, unstage, commit, branch. */

const path = require('path');
const { execute } = require('../tools/exec');

async function git(cwd, args, { timeoutMs = 20000, input = null } = {}) {
  const r = await execute('git', args, { cwd, timeoutMs, input });
  return { ok: r.ok && r.exitCode === 0, out: String(r.stdout || ''), err: String(r.stderr || r.error || ''), code: r.exitCode };
}

function mapCode(x, y) {
  const c = `${x}${y}`;
  if (c === '??') return 'untracked';
  if (c.includes('U') || c === 'AA' || c === 'DD') return 'conflict';
  const one = x !== ' ' ? x : y;
  return { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' }[one] || 'modified';
}

/** THE WORKING TREE. `-z` so a path with spaces or quotes arrives intact. Paths come back relative to the PROJECT (not the repository root). */
async function status(app) {
  const cwd = app.session.cwd;
  // THE PROJECT'S PLACE IN THE REPOSITORY, as git spells it.
  const pre = await git(cwd, ['rev-parse', '--show-prefix']);
  if (!pre.ok) return { ok: true, repo: false, why: 'this project is not a git repository' };
  const prefix = pre.out.trim();
  let br = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (!br.ok) br = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  const st = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (!st.ok) return { ok: false, why: st.err.trim() || 'git status failed' };
  const parts = st.out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    let file = rec.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') { from = parts[i + 1]; i += 1; }
    const rel = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
    files.push({
      path: rel,
      from: from ? (prefix && from.startsWith(prefix) ? from.slice(prefix.length) : from) : null,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ',
      state: mapCode(x, y),
      index: x,
      work: y,
    });
  }
  let ahead = null;
  let behind = null;
  const ab = await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (ab.ok) { const [b, a] = ab.out.trim().split(/\s+/).map(Number); ahead = a; behind = b; }
  return { ok: true, repo: true, branch: br.ok ? br.out.trim() : null, ahead, behind, files };
}

/** A unified diff for one path — working tree, or what is staged. */
async function diff(app, rel, { staged = false } = {}) {
  const at = require('./source').locate(app, rel);
  if (!at.ok) return at;
  const args = ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', at.rel];
  const r = await git(app.session.cwd, args);
  if (!r.ok) return { ok: false, why: r.err.trim() || 'git diff failed' };
  let text = r.out;
  if (!text && !staged) {
    // AN UNTRACKED FILE HAS NO DIFF against the index; show it whole as added.
    const nf = await git(app.session.cwd, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', at.rel]);
    text = nf.out;
  }
  return { ok: true, path: at.rel, staged, diff: text.slice(0, 400000) };
}

function paths(app, list) {
  const out = [];
  for (const p of Array.isArray(list) ? list.slice(0, 500) : []) {
    const at = require('./source').locate(app, p);
    if (at.ok) out.push(at.rel);
  }
  return out;
}

async function stage(app, list) {
  const ps = paths(app, list);
  if (!ps.length) return { ok: false, why: 'nothing to stage' };
  const r = await git(app.session.cwd, ['add', '--', ...ps]);
  return r.ok ? { ok: true, staged: ps } : { ok: false, why: r.err.trim() };
}

async function unstage(app, list) {
  const ps = paths(app, list);
  if (!ps.length) return { ok: false, why: 'nothing to unstage' };
  let r = await git(app.session.cwd, ['restore', '--staged', '--', ...ps]);
  // A REPOSITORY WITH NO COMMIT YET has no HEAD to restore from.
  if (!r.ok) r = await git(app.session.cwd, ['rm', '--cached', '-q', '--', ...ps]);
  return r.ok ? { ok: true, unstaged: ps } : { ok: false, why: r.err.trim() };
}

/** COMMIT what is staged, with the person's message. Never `-a`, never `--amend`. */
async function commit(app, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, why: 'a commit needs a message' };
  const r = await git(app.session.cwd, ['commit', '-F', '-'], { input: msg });
  if (!r.ok) return { ok: false, why: (r.err || r.out).trim().split('\n').slice(0, 4).join(' ') || 'git commit failed' };
  const head = await git(app.session.cwd, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, commit: head.ok ? head.out.trim() : null, summary: r.out.trim().split('\n')[0] };
}

/** A FILE AS GIT HAS IT — at HEAD, or as staged (`:`). */
async function show(app, rel, { ref = 'HEAD' } = {}) {
  const at = require('./source').locate(app, rel);
  if (!at.ok) return at;
  const pre = await git(app.session.cwd, ['rev-parse', '--show-prefix']);
  if (!pre.ok) return { ok: false, why: 'this project is not a git repository' };
  const spec = `${ref === ':' ? ':' : 'HEAD:'}${pre.out.trim()}${at.rel}`;
  const r = await git(app.session.cwd, ['show', spec]);
  return { ok: true, path: at.rel, ref, exists: r.ok, text: r.ok ? r.out : '' };
}

async function branches(app) {
  const r = await git(app.session.cwd, ['branch', '--format=%(refname:short)%09%(HEAD)']);
  if (!r.ok) return { ok: false, why: r.err.trim() };
  return { ok: true, branches: r.out.trim().split('\n').filter(Boolean).map((l) => { const [name, head] = l.split('\t'); return { name, current: head === '*' }; }) };
}

/** Switch branch — refused by git itself when it would lose changes. */
async function checkout(app, name) {
  const b = String(name || '').trim();
  if (!b || b.startsWith('-')) return { ok: false, why: 'name a branch' };
  // A SWITCH REWRITES THE WORKING TREE: the files that differ between the two branches are the targets, known before it runs, and the switch goes through…
  const d = await git(app.session.cwd, ['diff', '--name-only', 'HEAD', b, '--']);
  const targets = d.ok ? d.out.split(/\r?\n/).filter(Boolean).map((f) => require('path').join(app.session.cwd, f)) : [];
  let out = null;
  await require('../mutation').change(app, {
    actor: 'TOOL', origin: 'git', name: 'git.switch', targets, what: `switched to ${b}`,
    write: async () => { const r = await git(app.session.cwd, ['switch', b]); out = r; return r.ok ? { ok: true } : { ok: false, why: r.err.trim().split('\n')[0] }; },
  });
  const r = out || { ok: false, err: 'the switch did not run' };
  return r.ok ? { ok: true, branch: b } : { ok: false, why: r.err.trim().split('\n')[0] };
}

module.exports = { status, diff, show, stage, unstage, commit, branches, checkout, git };
