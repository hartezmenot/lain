'use strict';

/**
 * COMPUTER CONTROL — the person's switch over LAIN's hands on this desktop (Phase CU, 2026-10-02).
 *
 * SEPARATE FROM PREVIEW. The Preview's pointer and keyboard drive LAIN's own Preview window; this drives the person's
 * real desktop. Nothing granted to the Preview carries over here, and nothing here is granted silently.
 *
 * OFF BY DEFAULT, PER SESSION. `/computer on` (or the Harness's Enable) turns it on for THIS session; a new session,
 * `/computer off`, the kill switch (Ctrl+Alt+Pause, in the bridge) or closing LAIN turns it off. The CLI and the
 * Harness read and change the same state, because it lives in Core (on the App), not in a window.
 *
 * THREE TIERS, the person's choice:
 *   OBSERVE   windows, the accessibility tree, a capture — nothing is pressed or typed
 *   INTERACT  (default) input, but only into the TARGET window — focus-locked: if anything else comes to the front,
 *             input pauses (FOCUS_LOST) rather than landing in the wrong window; clicks must fall inside the target
 *   FULL      any window, window close, the clipboard, system hotkeys — still never a sensitive surface, never UAC
 *
 * EVERY DESKTOP OPERATION PASSES admit() (computermcp.js call), so the structured `computer` tool, the MNK primitives
 * (tools/computerinput.js) and request_computer obey one rule. The bridge adds what only it can see at the moment of
 * input: the kill switch, "the person is using the computer" (their input always wins) and the focus lock.
 *
 * SENSITIVE SURFACES are refused, not attempted: UAC / the secure desktop, Windows credential and security prompts,
 * password managers, password fields. The person does those. A model cannot lower this.
 *
 * ONLY THE PRIMARY AGENT by default: subagents are not given computer tools (toolfunnel `computer` family) unless the
 * person sets cfg.computer.agents. LAIN WEB may look, and cannot grant FULL without a local confirmation.
 */

const TIERS = Object.freeze(['OBSERVE', 'INTERACT', 'FULL']);
const READ_OPS = new Set(['window.list', 'window.active', 'displays', 'uia.tree', 'uia.find', 'uia.getValue', 'wait.window', 'wait.control', 'wait.gone', 'cursor.get', 'screen.capture', 'window.capture', 'control.state']);
const MOUSE_AT = new Set(['mouse.move', 'mouse.click', 'mouse.scroll']);
const FULL_ONLY = new Set(['window.close', 'clipboard.read', 'clipboard.write']);
const CONTROL_OPS = new Set(['control.arm', 'control.disarm', 'control.kill', 'control.resume']);
/** Processes and titles that are the person's alone. Lower-case. */
const SENSITIVE_PROCESSES = new Set(['consent', 'credentialuibroker', 'logonui', 'lockapp', 'securityhealthsystray', 'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane', 'enpass']);
const SENSITIVE_TITLES = [/user account control/i, /windows security/i, /^credential/i, /enter (your )?password/i, /sign in to (your )?microsoft account/i];
/** Key chords no tier sends. */
const NEVER_KEYS = [['ctrl', 'alt', 'delete'], ['ctrl', 'alt', 'del'], ['win', 'l']];
const FULL_KEYS = (keys) => keys.some((k) => /^win$/i.test(k)) || (keys.map((k) => k.toLowerCase()).includes('alt') && keys.map((k) => k.toLowerCase()).some((k) => k === 'f4' || k === 'tab' || k === 'esc'));

function root(app) { return (app && app._sibling) || app; }
function stateOf(app) { const r = root(app); return r ? (r._computerControl || null) : null; }
function sessionId(app) { return (app && app.session && app.session.id) || null; }

/** Is control on for THIS session? A state left by another session is not. */
function enabled(app) { const s = stateOf(app); return Boolean(s && s.on && s.sessionId === sessionId(app)); }
function tier(app) { return enabled(app) ? stateOf(app).tier : null; }
function rank(t) { return TIERS.indexOf(String(t || '').toUpperCase()); }

/**
 * TURN IT ON for this session. `by` is who asked: cli | harness | web | request (a model's request_computer, which the
 * person approved for observation). The desktop itself is authorized by computermcp.connect's one question.
 */
async function enable(app, { tier: want = 'INTERACT', by = 'cli', ask = true, confirmedLocally = false } = {}) {
  const t = String(want || 'INTERACT').toUpperCase();
  if (!TIERS.includes(t)) return { ok: false, why: `tier is one of ${TIERS.join(', ')}` };
  if (by === 'web' && t === 'FULL' && !confirmedLocally) return { ok: false, why: 'FULL computer control cannot be granted from LAIN Web — confirm it in the CLI or the Harness' };
  const cm = require('./computermcp').forApp(app);
  const c = await cm.connect({ ask });
  if (!c.ok || !c.authorized) return { ok: false, why: c.why || 'the computer was not authorized' };
  const r = root(app);
  const prev = stateOf(app);
  // A REQUEST NEVER RAISES A TIER: request_computer asks for observation only.
  const tierNow = by === 'request' && prev && prev.on && prev.sessionId === sessionId(app) ? prev.tier : t;
  r._computerControl = { on: true, tier: tierNow, sessionId: sessionId(app), by, since: Date.now(), target: prev && prev.sessionId === sessionId(app) ? prev.target : null, killed: false, paused: '' };
  try { await cm.call('control.resume', {}, { internal: true }); } catch { /* an older bridge */ }
  watch(app);
  changed(app);
  return { ok: true, state: view(app) };
}

/** TURN IT OFF: input stops, the target is released; the desktop authorization is left to /mcp computer off. */
async function disable(app, why = 'turned off') {
  const r = root(app);
  if (!r || !r._computerControl) return { ok: true, state: view(app) };
  r._computerControl = { ...r._computerControl, on: false, target: null, offWhy: why };
  try { await require('./computermcp').forApp(app).call('control.disarm', {}, { internal: true }); } catch { /* not connected */ }
  changed(app);
  return { ok: true, state: view(app) };
}

/** THE KILL SWITCH from LAIN's side (the bridge has Ctrl+Alt+Pause): nothing more is sent, and control is off. */
async function stop(app, why = 'stopped') {
  try { await require('./computermcp').forApp(app).call('control.kill', {}, { internal: true }); } catch { /* not connected */ }
  const r = root(app);
  if (r && r._computerControl) r._computerControl.killed = true;
  return disable(app, why);
}

/** CHOOSE THE TARGET: a window (title, handle or pid) the input is locked to. `raw` for a raw-input reader (a game). */
async function setTarget(app, { window = null, handle = null, pid = null, raw = false } = {}) {
  if (!enabled(app)) return { ok: false, why: 'computer control is off — /computer on first' };
  const cm = require('./computermcp').forApp(app);
  const r = await cm.call('control.arm', { window, handle, pid, raw: Boolean(raw) }, { internal: true });
  if (!r.ok) return { ok: false, why: r.why };
  const w = r.result && r.result.armed;
  if (w && sensitive(w)) {
    await cm.call('control.disarm', {}, { internal: true });
    return { ok: false, why: `"${w.title}" (${w.process}) is a sensitive surface — LAIN does not control it; the person does` };
  }
  stateOf(app).target = w ? { handle: w.handle, pid: w.pid, title: w.title, process: w.process, rect: w.rect, raw: Boolean(raw) } : null;
  changed(app);
  return { ok: true, state: view(app) };
}

function sensitive(w) {
  if (!w) return false;
  const p = String(w.process || '').toLowerCase().replace(/\.exe$/, '');
  if (SENSITIVE_PROCESSES.has(p)) return true;
  return SENSITIVE_TITLES.some((re) => re.test(String(w.title || '')));
}

/**
 * ADMIT ONE DESKTOP OPERATION (computermcp.js call). Returns { ok, why?, params? } — params possibly scoped to the
 * target. `internal` = LAIN's own control ops.
 */
function admit(app, op, params = {}, { internal = false } = {}) {
  if (CONTROL_OPS.has(op)) return internal ? { ok: true, params } : { ok: false, why: `${op} is LAIN's, not a tool's` };
  if (internal && op === 'control.state') return { ok: true, params };   // LAIN reading its own switch, on or off
  if (!enabled(app)) return { ok: false, why: 'computer control is off for this session — the person turns it on with /computer on (or Enable in the Harness)' };
  const s = stateOf(app);
  if (s.killed) return { ok: false, why: 'computer control was stopped (kill switch) — /computer on resumes' };
  if (READ_OPS.has(op)) return { ok: true, params };
  if (s.tier === 'OBSERVE') return { ok: false, why: `this session's computer control is OBSERVE — ${op} would act; the person can raise it with /computer on interact` };
  if (FULL_ONLY.has(op) && s.tier !== 'FULL') return { ok: false, why: `${op} needs FULL computer control (/computer on full)` };
  const keys = op === 'keyboard.key' ? (Array.isArray(params.keys) ? params.keys : [params.key]).map(String) : op === 'keyboard.hold' || op === 'keyboard.down' ? [String(params.key)] : null;
  if (keys) {
    const low = keys.map((k) => k.toLowerCase());
    if (NEVER_KEYS.some((ch) => ch.every((k) => low.includes(k)))) return { ok: false, why: `${keys.join('+')} is never sent — secure-attention and lock keys are the person's` };
    if (FULL_KEYS(keys) && s.tier !== 'FULL') return { ok: false, why: `${keys.join('+')} acts on the system, not the target — it needs FULL` };
  }
  if (s.tier === 'INTERACT') {
    if (!s.target) return { ok: false, why: 'INTERACT needs a target window — /computer target <window> (or Target in the Harness)' };
    const scoped = { ...params };
    // UIA ACTIONS ARE SCOPED TO THE TARGET: another window named in the call is refused, none named means the target.
    if (/^uia\.|^window\.focus$|^wait\./.test(op)) {
      const other = (params.handle != null && Number(params.handle) !== Number(s.target.handle)) || (params.pid != null && Number(params.pid) !== Number(s.target.pid))
        || (params.window && !String(s.target.title || '').toLowerCase().includes(String(params.window).toLowerCase()));
      if (other) return { ok: false, why: `INTERACT is locked to "${s.target.title}" — ${op} named another window` };
      // THE HANDLE, not the pid: one host process can own several windows (ApplicationFrameHost runs Calculator AND Settings).
      if (params.handle == null && params.pid == null) { scoped.handle = s.target.handle; delete scoped.window; }
    }
    if (MOUSE_AT.has(op) && params.x != null && params.y != null && !s.target.raw && s.target.rect) {
      const r = s.target.rect;
      const inside = params.x >= r.x && params.y >= r.y && params.x < r.x + r.width && params.y < r.y + r.height;
      if (!inside) return { ok: false, why: `(${params.x},${params.y}) is outside the target "${s.target.title}" (${r.x},${r.y} ${r.width}×${r.height})` };
    }
    if (op === 'mouse.drag' && !s.target.raw && s.target.rect) {
      const r = s.target.rect;
      const inR = (x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
      if (!inR(params.fromX, params.fromY) || !inR(params.toX, params.toY)) return { ok: false, why: `the drag leaves the target "${s.target.title}"` };
    }
    return { ok: true, params: scoped };
  }
  return { ok: true, params };
}

/** After an operation: a bridge refusal that means "stop" is reflected in the state (indicator, Harness). */
function noteResult(app, op, r) {
  const s = stateOf(app);
  if (!s || r.ok) { if (s && s.paused && r.ok && !READ_OPS.has(op)) { s.paused = ''; changed(app); } return; }
  const why = String(r.why || '');
  if (/^KILLED/.test(why)) { s.killed = true; s.on = false; s.offWhy = 'kill switch'; changed(app); } else if (/^(USER_ACTIVE|FOCUS_LOST)/.test(why)) { s.paused = why.split(':')[0]; changed(app); }
}

/** A sensitive control (a password field) is never typed into. Checked before uia.setValue. */
async function guardValue(app, cm, params) {
  try {
    const f = await cm.bridge.call('uia.find', { ...params, limit: 1 });
    const row = f && f.ok && f.result && ((f.result.matches && f.result.matches[0]) || f.result.element || null);
    if (row && row.isPassword) return { ok: false, why: 'that is a password field — LAIN does not type into it; the person does' };
  } catch { /* the setValue itself will report */ }
  return { ok: true };
}

/** THE INDICATOR: "● Computer · Minecraft" — the same words in the CLI status and the Harness. */
function label(app) {
  const s = stateOf(app);
  if (!s || s.sessionId !== sessionId(app)) return '';
  if (s.killed) return '■ Computer stopped';
  if (!s.on) return '';
  const what = s.target ? (/^applicationframehost$/i.test(s.target.process || '') ? s.target.title : s.target.process || s.target.title || 'target') : (s.tier === 'FULL' ? 'all windows' : 'no target');
  return `● Computer · ${String(what).slice(0, 28)}${s.tier !== 'INTERACT' ? ` · ${s.tier.toLowerCase()}` : ''}${s.target && s.target.raw ? ' · raw' : ''}${s.paused ? ` · paused (${s.paused === 'USER_ACTIVE' ? 'you' : 'focus'})` : ''}`;
}

function view(app) {
  const s = stateOf(app);
  const mine = s && s.sessionId === sessionId(app);
  return {
    on: Boolean(mine && s.on), tier: mine && s.on ? s.tier : null, target: mine ? s.target : null, killed: Boolean(mine && s.killed),
    paused: mine ? s.paused || '' : '', by: mine ? s.by : null, since: mine ? s.since : null, label: label(app), tiers: TIERS,
    agents: Boolean(root(app) && root(app).cfg && root(app).cfg.computer && root(app).cfg.computer.agents),
    killSwitch: 'Ctrl+Alt+Pause',
  };
}

/** While on: read the bridge's state every 2 s (focus, the person's input, the kill switch) for the indicator. */
function watch(app) {
  const r = root(app);
  if (!r || r._computerWatch) return;
  const tick = async () => {
    r._computerWatch = null;
    if (!enabled(app)) return;
    try {
      const st = await require('./computermcp').forApp(app).call('control.state', {}, { internal: true });
      const s = stateOf(app);
      if (st.ok && s) {
        const res = st.result || {};
        if (res.killed && !s.killed) { s.killed = true; s.on = false; s.offWhy = 'kill switch'; changed(app); return; }
        const t = s.target;
        const fg = res.foreground;
        const paused = t && fg && Number(fg.handle) !== Number(t.handle) && Number(fg.owner) !== Number(t.handle) ? 'FOCUS_LOST' : res.personInputMsAgo >= 0 && res.personInputMsAgo < 1500 ? 'USER_ACTIVE' : '';
        if (paused !== (s.paused || '')) { s.paused = paused; changed(app); }
        if (t && res.armed && res.armed.rect) t.rect = res.armed.rect;
      }
    } catch { /* the next tick tries again */ }
    r._computerWatch = setTimeout(tick, 2000);
    if (r._computerWatch.unref) r._computerWatch.unref();
  };
  r._computerWatch = setTimeout(tick, 2000);
  if (r._computerWatch.unref) r._computerWatch.unref();
}

function changed(app) {
  try { const ui = root(app) && root(app).ui; if (ui && ui.enabled && ui.refresh) ui.refresh(); } catch { /* nothing drawn */ }
  try { require('./events').busOf(root(app)).emit(require('./events').EVENT.TASK_STATE, { computer: label(app) }); } catch { /* no bus */ }
}

/** `/computer` — on [observe|interact|full] · off · stop · target <window> [raw] · status */
function register({ define, C }) {
  define('/computer', {
    surface: true,
    args: '[on [observe|interact|full] | off | stop | target <window> [raw] | status]',
    desc: 'Computer Control: let LAIN observe and use this desktop for this session (off by default)',
    async run(app, { args, rest }) {
      const w = (s) => app.render.write(s);
      const sub = String(args[0] || 'status').toLowerCase();
      if (sub === 'on') {
        w(C.dim('  starting the desktop bridge…\n'));
        const r = await enable(app, { tier: args[1] || 'INTERACT', by: 'cli' });
        if (!r.ok) { w(C.yellow(`  ${r.why}\n`)); return; }
        w(`  ${C.green(label(app) || '● Computer')}  ${C.dim(`${r.state.tier} for this session · kill switch ${r.state.killSwitch} · /computer off ends it`)}\n`);
        if (r.state.tier === 'INTERACT' && !r.state.target) w(C.dim('  Choose the window it may use: /computer target <window title> [raw]\n'));
        return;
      }
      if (sub === 'off') { await disable(app, 'you turned it off'); w(`  ${C.green('✓')} Computer control is off for this session.\n`); return; }
      if (sub === 'stop') { await stop(app, 'you stopped it'); w(`  ${C.green('■')} Stopped — nothing more is sent. /computer on resumes.\n`); return; }
      if (sub === 'target') {
        const isRaw = args[args.length - 1] && args[args.length - 1].toLowerCase() === 'raw';
        const title = rest.slice(args[0].length).trim().replace(/\s+raw$/i, '').trim();
        if (!title) { w(C.dim('  usage: /computer target <window title> [raw]\n')); return; }
        const r = await setTarget(app, { window: title, raw: isRaw });
        w(r.ok ? `  ${C.green(label(app))}\n` : C.yellow(`  ${r.why}\n`));
        return;
      }
      const v = view(app);
      w('\n' + C.bold('Computer Control') + '\n');
      w(`  ${v.on ? C.green(v.label) : C.dim(v.killed ? '■ stopped by the kill switch' : 'off for this session')}\n`);
      if (v.on) w(C.dim(`  tier ${v.tier}${v.target ? ` · target ${v.target.title} (${v.target.process}, pid ${v.target.pid})${v.target.raw ? ' · raw input' : ''}` : ''} · since ${new Date(v.since).toLocaleTimeString()}\n`));
      w(C.dim(`  Kill switch: ${v.killSwitch} anywhere. Subagents: ${v.agents ? 'allowed (cfg.computer.agents)' : 'never'}. Your own input always wins.\n`));
    },
  });
}

module.exports = { TIERS, enabled, tier, enable, disable, stop, setTarget, admit, noteResult, guardValue, label, view, sensitive, register, rank };
