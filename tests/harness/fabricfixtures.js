'use strict';

/**
 * FIXTURE ACCOUNTS FOR THE FABRIC — real driver instances against fakes, no
 * network, no real account, no quota (Phase 8.4).
 *
 * Until 8.4 the fabric tests borrowed imported router pools as "accounts". A
 * pool is imported metadata now — never capacity — so capacity comes from the
 * same sources a person's does:
 *
 *   codexAccounts   one real Codex account instance per spec, each with its own
 *                   home, run by the fake `codex app-server` (its own login,
 *                   identity, limits and model list)
 *   claudeRuntime   Claude Code's own sign-in, through a fake `claude` behind an
 *                   npm-style .cmd shim
 *
 * ISOLATION: only fakes are configured (binary paths in the app's config), so
 * under LAIN_ISOLATED nothing on PATH or in a real home is ever touched.
 */

const fs = require('fs');
const path = require('path');

const FAKE_CODEX = path.join(__dirname, '..', 'fixtures', 'codex', 'fakeappserver.js');
const FAKE_CLAUDE = path.join(__dirname, '..', 'fixtures', 'runtimes', 'fakeclaude.js');
const FAKE_ACP = path.join(__dirname, '..', 'fixtures', 'antigravity', 'fakeacp.js');

function root(app) { return (app && app._sibling) || app; }

/** A window the fake app-server reports: percent used, its length in minutes, when it resets. */
function win(usedPercent, minutes, inMinutes) { return { usedPercent, windowDurationMins: minutes, resetsAt: Math.floor(Date.now() / 1000) + (inMinutes || minutes) * 60 }; }

/**
 * @param specs [{ name?, email, plan?, limits?: { primary, secondary }, models?: [{ id, ... }] }]
 * @returns [{ id, name, email }] — signed in, its limits and models read
 */
async function codexAccounts(app, specs, { alias = true } = {}) {
  const r = root(app);
  r.cfg.accounts = { ...(r.cfg.accounts || {}), codex: { ...((r.cfg.accounts || {}).codex || {}), binary: { command: process.execPath, args: [FAKE_CODEX] } } };
  const ai = require('../../src/accountinstances');
  const store = require('../../src/fabric/store');
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const added = ai.add(app, { driver_id: 'codex', display_name: s.name || `Codex ${i + 1}`, config: { home_mode: 'direct' } });
    if (!added.ok) throw new Error(`fixture account: ${added.why}`);
    const id = added.instance.id;
    const home = ai.handle(app, id).layout.home;
    fs.mkdirSync(home, { recursive: true });
    // SIGNED IN (what a completed login leaves) — the fake app-server reads it like the real one reads its auth.
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ fake: true, email: s.email, planType: s.plan || 'plus', accountId: `acct-${id}` }));
    if (s.limits) fs.writeFileSync(path.join(home, 'fake-limits.json'), JSON.stringify(s.limits));
    if (s.models) fs.writeFileSync(path.join(home, 'fake-models.json'), JSON.stringify(s.models));
    // eslint-disable-next-line no-await-in-loop -- one process at a time keeps the fixture deterministic
    const rf = await ai.refresh(app, id);
    if (!rf || rf.ok === false) throw new Error(`fixture account refresh: ${rf && rf.why}`);
    if (alias && s.name) store.setAlias(id, s.name);
    out.push({ id, name: s.name || `Codex ${i + 1}`, email: s.email });
  }
  try { require('../../src/appcatalog').invalidate(); r._acctMemo = null; r._catMemo = null; } catch { /* rebuilt on the next read */ }
  return out;
}

/** Claude Code, signed in as `person@example.com` (Pro), behind a fake `claude`. */
async function claudeRuntime(app, dir) {
  const r = root(app);
  const { shim } = require('../fixtures/runtimes/shim');
  const cmd = shim(path.join(dir, 'claude-bin'), 'claude', FAKE_CLAUDE);
  r.cfg.runtimes = { ...(r.cfg.runtimes || {}), 'claude-code': { ...((r.cfg.runtimes || {})['claude-code'] || {}), binary: cmd } };
  try { await require('../../src/runtimeadapters').report(app, 'claude-code', { refresh: true }); } catch { /* the account still lists */ }
  try { require('../../src/appcatalog').invalidate(); r._acctMemo = null; r._catMemo = null; } catch { /* rebuilt on the next read */ }
  return cmd;
}

/**
 * Antigravity accounts, each signed in through a real AuthSession against a fake ACP server (its own private profile,
 * its own identity) and — unless `verify: false` — shown to answer one test message. @param specs [{ name, email }] @returns [{ id, name, email }]
 */
async function antigravityAccounts(app, specs, { verify = true } = {}) {
  const r = root(app);
  r.cfg.runtimes = { ...(r.cfg.runtimes || {}), antigravity: { ...((r.cfg.runtimes || {}).antigravity || {}), acpBinary: process.execPath, acpArgs: [FAKE_ACP] } };
  const A = require('../../src/authsession');
  const out = [];
  for (const s of specs) {
    const st = await A.start(r, 'antigravity', { name: s.name });
    if (!st.ok) throw new Error(`fixture antigravity: ${st.why}`);
    const sess = A.get(st.session.id);
    const end = Date.now() + 5000;
    while (!(sess.profile && fs.existsSync(sess.profile)) && Date.now() < end) await new Promise((x) => setTimeout(x, 30));   // eslint-disable-line no-await-in-loop
    fs.writeFileSync(path.join(sess.profile, 'fake-login.json'), JSON.stringify({ email: s.email }));
    const done = await A.settled(sess.id, 20000);   // eslint-disable-line no-await-in-loop
    if (done.state !== 'CONNECTED') throw new Error(`fixture antigravity: ${JSON.stringify(done)}`);
    out.push({ id: sess.target, name: s.name, email: s.email });
    // A SIGN-IN PROVES AN IDENTITY, NOT THAT THE ACCOUNT ANSWERS: Chat and Assistant are advertised only after a real message did (tests can ask for the bare sign-in).
    if (verify) { const v = await require('../../src/drivers/antigravity').verify(r, sess.target); if (!v.ok) throw new Error(`fixture antigravity verify: ${v.why}`); }   // eslint-disable-line no-await-in-loop
  }
  try { require('../../src/appcatalog').invalidate(); r._acctMemo = null; r._catMemo = null; } catch { /* rebuilt on the next read */ }
  return out;
}

/** The account's home (where the fake app-server keeps its state). */
function homeOf(app, id) { return require('../../src/accountinstances').handle(app, id).layout.home; }

/** Make an account answer "You've hit your usage limit" (or clear it). */
function limit(app, id, on = true) {
  const f = path.join(homeOf(app, id), 'fake-limited.json');
  if (on) fs.writeFileSync(f, '{}'); else { try { fs.unlinkSync(f); } catch { /* not limited */ } }
}

/** What this account was asked, in order: [{ argv, prompt, as }] — proof of WHICH account answered and how. */
function execs(app, id) {
  try { return fs.readFileSync(path.join(homeOf(app, id), 'fake-exec.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
/** The model and effort on an exec's command line. */
function wire(rec) {
  const at = (flag) => { const i = rec.argv.indexOf(flag); return i >= 0 ? rec.argv[i + 1] : null; };
  const eff = /model_reasoning_effort="(\w+)"/.exec(rec.argv.join(' '));
  return { model: at('--model'), effort: eff ? eff[1] : null };
}

/** Stop every fixture account's process and remove them (a test's cleanup — a process left running holds the runner open). */
async function reset() {
  const ai = require('../../src/accountinstances');
  try { await ai.stopAll(); } catch { /* none running */ }
  try { fs.unlinkSync(ai.file()); } catch { /* none */ }
}

module.exports = { codexAccounts, claudeRuntime, antigravityAccounts, reset, win, homeOf, limit, execs, wire, FAKE_CODEX, FAKE_CLAUDE, FAKE_ACP };
