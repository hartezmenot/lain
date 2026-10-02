'use strict';

/**
 * WHY ISN'T THIS WORKING — the MACHINE half of that question.
 *
 * `/status` says what LAIN is configured to do; `provider.js` and
 * `availability.js` say whether a route is healthy. Neither answers the
 * question a stuck user actually has, which is about the host: is the Node
 * version new enough, is there a terminal, can the config directory be written,
 * is there a shell for run_bash to use. V1 had this as `/doctor` and V2 had
 * lost it.
 *
 * The checks live here rather than inside the command because they are facts
 * about the environment, not presentation — which makes them testable directly
 * and keeps `commands.js` a registry rather than a place where logic collects.
 *
 * EVERY CHECK IS A LOCAL SYSCALL. Nothing here opens a socket or spends a
 * request: a diagnostic that costs money to run is one nobody runs when they
 * are already worried about spending.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const providerMod = require('./provider');
const sessionMod = require('./session');
const shell = require('./tools/shell');

/** @returns {Array<{ok:boolean, text:string}>} in the order a person reads them. */
function checks(app) {
  const out = [];
  const ok = (text) => out.push({ ok: true, text });
  const warn = (text) => out.push({ ok: false, text });

  const major = Number(process.versions.node.split('.')[0]);
  (major >= 18 ? ok : warn)(`Node ${process.version}${major >= 18 ? '' : ' — 18 or newer is required'}`);

  (process.stdout.isTTY ? ok : warn)(process.stdout.isTTY
    ? 'Interactive terminal'
    : 'No TTY — the framed UI is off and output is linear');

  // Sessions, /undo history and the model catalog all live under the config
  // directory. If it cannot be written, everything appears to work during the
  // session and none of it is there afterwards.
  const dir = config.configDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok(`Config directory writable (${dir})`);
  } catch (e) {
    warn(`Config directory is NOT writable (${dir}): ${e.message} — sessions and undo will not persist`);
  }
  // PLAINTEXT CREDENTIALS LEFT BEHIND by an older version — counted only (legacysecrets.js).
  try {
    const s = require('./legacysecrets').summary(dir);
    if (s) warn(s.text); else ok('No plaintext credential backups beside the config');
  } catch { /* the scan is advisory */ }

  const cwd = path.resolve(app.session.cwd);
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    ok(`Working directory writable (${cwd})`);
  } catch {
    warn(`Working directory is read-only (${cwd}) — edits will fail`);
  }

  // run_bash is the tool most likely to be silently unusable on a given host.
  const bash = shell.findBash();
  if (bash) ok(`Shell for run_bash: ${bash}`);
  else if (process.platform === 'win32') ok('Shell for run_bash: PowerShell / cmd (no bash found, which is normal on Windows)');
  else warn('No shell found for run_bash — shell commands will fail');

  // THE TAB TITLE is a side effect on someone else's window, and when it does
  // not take there is nothing on screen to say why. LAIN writes OSC 0 and 2 on
  // every redraw; a terminal that pins its own tab name simply ignores them, and
  // that is a setting in the terminal rather than a fault here. So this reports
  // what LAIN actually sent, and names the setting to check if the tab differs.
  const title = require('./termtitle');
  if (!title.enabled()) {
    warn('Terminal title not set — no TTY, TERM=dumb, or LAIN_NO_TITLE is set');
  } else {
    ok(`Terminal title set to "${title.compose({ folder: require('./ui/text').projectName(cwd) })}"`
      + ' — if your tab still shows the shell name, the terminal is overriding it'
      + (process.platform === 'win32' ? ' (Windows Terminal: profile → suppressApplicationTitle / tabTitle)' : ''));
  }

  const pc = providerMod.resolve(app.cfg);
  if (!pc.provider) warn('No provider configured — /provider to set one up');
  else if (!pc.apiKey) warn(`Provider ${pc.provider} has no credential — /oauth, or /config apiKey`);
  else ok(`Provider ${pc.provider} · model ${pc.model || 'none selected'} · credential present`);

  const room = sessionMod.budgetChars(pc);
  const used = app.session.contextChars();
  const pct = room > 0 ? Math.round((used / room) * 100) : 0;
  (pct < 80 ? ok : warn)(`Context ${Math.round(used / 1000)}k / ${Math.round(room / 1000)}k chars (${pct}%)`
    + (pct >= 80 ? ' — older tool output is being elided to fit' : ''));

  if (app.availability) {
    const healthy = new Set(['UNKNOWN', 'READY', 'REQUEST_READY']);
    const down = app.availability.all().filter((e) => e.status && !healthy.has(e.status));
    if (down.length) for (const d of down) warn(`Connection ${d.id}: ${d.status}${d.reason ? ` — ${d.reason}` : ''}`);
    else ok('No connection is disabled or in a failure state');
  }

  return out;
}

/**
 * What `/status` reports: the SESSION and its route, as label/value pairs.
 *
 * `checks()` answers "is this machine capable of running LAIN"; this answers
 * "what is LAIN currently pointed at". Both are reports built from state and
 * printed by a command, which is why they live together and neither lives in
 * the command registry.
 *
 * @returns {Array<[string, string]>}
 */
/**
 * A cache-hit-rate suffix for the tokens row, or '' when there is nothing to
 * say — no request has gone out, or the provider never reported cache usage
 * at all (a non-Anthropic route). Folded onto the existing row rather than
 * given one of its own: `/status` is a fixed-height panel windowed to the
 * terminal, and an unconditional extra row pushes whatever was last — here,
 * `config` — past the visible slice on a short terminal. This is the one
 * number that answers "is caching actually working" without re-deriving it
 * from raw provider events by hand: read tokens near zero next to real
 * conversation history is the signature of a broken or invalidated cache.
 */
/** A token count a person reads at a glance: 950 · 12.4k · 3.1M (/token has the exact figures). */
function short(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1000)}k`;
  if (v >= 1e3) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function cacheSuffix(u) {
  const read = u.cacheReadTokens || 0;
  const cached = read + (u.cacheCreationTokens || 0);
  const total = cached + (u.inputTokens || 0);
  if (!total) return '';
  return ` · cache ${Math.round((read / total) * 100)}%`;
}

function statusRows(app, { dim = (s) => s } = {}) {
  // THE ROUTE THIS SESSION'S NEXT TURN TAKES (Phase 8.2) — its lane, not the
  // process default: after the window chose another account, the default named
  // a route the next turn would not take.
  let pc;
  try { pc = providerMod.resolve(require('./sessionviews').turnCfg(app, app.session)); } catch { pc = providerMod.resolve(app.cfg); }
  const room = sessionMod.budgetChars(pc);
  const used = app.session.contextChars();
  const u = app.session.usage;
  // ACCOUNT FIRST, the same facts Telegram's /status and the window read (sessionfacts.js).
  const sf = require('./sessionfacts');
  const key = pc.protocol === 'runtime' ? 'the runtime holds the sign-in' : (pc.apiKey ? 'key present' : dim('no key'));
  const routeText = pc.unavailable ? dim(pc.unavailable.why || 'none') : (pc.connectionId ? `${pc.routeId || pc.connectionId} · ${pc.model}${pc.canonicalModel && pc.canonicalModel !== pc.model ? ` (${pc.canonicalModel})` : ''} · ${key}` : dim('none configured'));
  // THE BACKING ACCOUNT'S ROW CARRIES THE EXACT ROUTE (Phase 8.3): an account is where a route goes.
  const facts = sf.rows(sf.facts(app)).map(([k, v]) => (k === 'session' && app.resumedFrom ? [k, `${v} (resumed)`] : k === 'account' ? [k, `${v} · route ${routeText}`] : [k, v]));
  // THIRTEEN ROWS: what the panel shows unscrolled at an ordinary terminal size (statuspanel.test.js) —
  // related facts share a row; `session`, `context` and `config` keep their own.
  return [
    ...facts,
    // The window is the resource that silently ends long tasks, so it is a
    // headline number rather than something you have to know to ask for.
    ['context', `${Math.round(used / 1000)}k / ${Math.round(room / 1000)}k chars (${room > 0 ? Math.round((used / room) * 100) : 0}%) · ↑${short(u.inputTokens)} ↓${short(u.outputTokens)} · ${u.requests} requests${cacheSuffix(u)} · ${app.session.messages.length} messages · ${app.session.turns.length} turns`],
    // WHAT LAIN KNOWS ABOUT THIS PROJECT WITHOUT READING IT AGAIN.
    //
    // One line, because it is the line that would have made a silent failure
    // obvious: a whole TypeScript project once indexed to 47 files and ZERO
    // declarations, and every question about it fell back to grep and whole-file
    // reads on every turn. A count says that in one glance. It reads the index
    // that is already on disk and never builds one — asking for status must not
    // start a scan. See projectindex.coverage.
    // (and, at its end, which surface is up — the window is the application now, not a URL)
    ['index', `${projectRow(app.session.cwd, dim)} · ${appBrief(dim)}`],
    // ONE LINE, THE PATH ALONE: a row that wraps is a row the panel cannot fit at its foot.
    ['config', config.configDir()],
  ];
}

/** Whether LAIN Desktop is up, in a few words (appRow says it in full, for /doctor). */
function appBrief(dim) {
  try {
    const win = require('./desktopwindow').status();
    if (win.open) return `desktop open · pid ${win.pid}${require('./harnessapp/ipc').status().running ? '' : dim(' · channel down')}`;
    return dim('desktop closed');
  } catch { return dim('desktop unknown'); }
}

function appRow(dim) {
  try {
    const win = require('./desktopwindow').status();
    const chan = require('./harnessapp/ipc').status();
    if (win.open) return `Noema Desktop · pid ${win.pid}${chan.running ? ' · private channel' : dim(' · channel down')}`;
    // AND WHETHER THIS PROCESS IS THE ONE A LAUNCH WOULD FIND. The window is
    // opened by launching LAIN, not by a command here, so the useful fact is
    // whether a launch would reach THIS session or start its own. The browser
    // surface that used to be reported on this row went with `/app`
    // (2026-09-15). See src/corelock.js.
    const lock = require('./corelock').status();
    return dim(lock.holding
      ? 'closed — launching Noema Desktop opens this session'
      : 'closed — another Noema would answer a Desktop launch');
  } catch (e) {
    return dim(`unavailable (${(e && e.message) || e})`);
  }
}

function projectRow(cwd, dim) {
  try {
    const c = require('./projectindex').coverage(cwd);
    if (c.state === 'UNKNOWN') return dim('not indexed yet');
    const bits = [`${c.scanned}/${c.code} scanned`, `${c.symbols} declarations`];
    if (c.unscanned) bits.push(`${c.unscanned} not scanned`);
    return `${bits.join(' · ')} — ${c.state}`;
  } catch (e) {
    return dim(`unavailable (${(e && e.message) || e})`);
  }
}

module.exports = { checks, statusRows };
