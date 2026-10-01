'use strict';

/**
 * THE MODEL DASHBOARD, OPENED FROM THE TERMINAL (Phase 8.3).
 *
 *   /model manage · /account add · /api add
 *
 * The terminal is a SAFE CONTROL SURFACE, never a secret-entry surface: a key
 * or a sign-in is entered in the Model Dashboard window, never typed into the
 * terminal, its history or a conversation. So these commands open the window:
 *
 *   1. this LAIN already shows its window     → it navigates to MODEL (and comes to the front)
 *   2. another LAIN on this machine holds one → asked over the control pipe to open MODEL
 *   3. no window anywhere                     → this LAIN opens its own, at MODEL
 *   4. NO HARNESS (a CLI-only install), or its window would not open
 *                                             → Core's own account page (fabric/standalone.js), on
 *                                               loopback, in the default browser (§76: the CLI never
 *                                               REQUIRES the Harness)
 *
 * THE HANDOFF CARRIES A SECTION NAME ONLY — from a fixed list — never a
 * credential, an address or a session; the window's channel keeps its own
 * per-launch secret (harnessapp/ipc.js). The terminal learns what happened
 * from the registry's SAFE COMPLETION EVENTS (fabric/store.js): "source added",
 * an id, a display name, what it can do. Never the key.
 */

const SECTIONS = Object.freeze({ accounts: 'accts', accts: 'accts', models: 'mdl', mdl: 'mdl', api: 'api', local: 'local', defaults: 'defaults', import: 'import' });

function sectionOf(s) { return SECTIONS[String(s || 'accounts').toLowerCase()] || 'accts'; }

/** Open (or bring forward) the Model Dashboard at `section`. */
async function open(app, section = 'accounts') {
  const sec = sectionOf(section);
  const nav = { tab: 'model', section: sec };
  const ipc = require('../harnessapp/ipc');
  // 1. THIS PROCESS HOLDS THE WINDOW.
  if (ipc.status().clients > 0) {
    ipc.navigate(nav);
    ipc.toHost('show');
    return { ok: true, how: 'navigated', section: sec };
  }
  // 2. ANOTHER LAIN HOLDS ONE — asked over the control pipe (a fixed section name, nothing else).
  try {
    const corelock = require('../corelock');
    const lock = corelock.read();
    if (lock && lock.pid && lock.pid !== process.pid) {
      const r = await corelock.ask(`dashboard:${sec}`);
      if (r && r.ok) return { ok: true, how: 'running-lain', section: sec, pid: lock.pid };
    }
  } catch { /* no other LAIN answered — open one here */ }
  // 3. (LAIN_NO_DESKTOP: a spawned test binary says so and opens nothing.)
  if (process.env.LAIN_NO_DESKTOP === '1') return { ok: false, why: 'no desktop window in this environment (LAIN_NO_DESKTOP)' };
  //    OPEN THIS LAIN'S OWN WINDOW, at MODEL (the page asks for the queued section when it boots) — when there is a Harness.
  let why = null;
  if (require('../harnesslocation').load().ok) {
    ipc.queueNavigation(nav);
    // THE HARNESS when it is installed; otherwise the small Model Dashboard window (the same page, MODEL alone) — a
    // CLI-only install manages accounts, keys and models natively, never in a browser tab.
    const harness = require('../components').harness();
    const r = await require('../desktopwindow').open(app, harness ? {} : { mode: 'dashboard', section: sec });
    if (r.ok && !harness) return { ok: true, how: 'dashboard-window', section: sec };
    if (r.ok) return { ok: true, how: 'opened', section: sec };
    ipc.queueNavigation(null);
    why = r.why || 'the window did not open';
  }
  // 4. NO HARNESS, or its window would not open: Core's own account page, in the default browser.
  const s = await require('./standalone').open(app, { section: sec === 'api' ? 'api' : 'accts' });
  if (!s.ok) return { ok: false, why: why ? `${why}; ${s.why}` : s.why };
  return { ok: true, how: 'standalone', section: sec, base: s.base, opened: s.opened !== false, windowWhy: why };
}

/** What the terminal says after `open` — one line, the same for /account, /api and /model manage. */
function said(r, where = 'Accounts') {
  if (!r || !r.ok) return `The Model Dashboard did not open: ${(r && r.why) || 'unknown'}`;
  if (r.how === 'running-lain') return `Opened the Model Dashboard at ${where} in the Noema already running.`;
  if (r.how === 'standalone') {
    const lead = r.windowWhy ? 'The Harness window did not open' : 'The Noema Harness is not installed';
    // THE ONE-TIME LAUNCH LINK IS NEVER PRINTED (consolidation §11) — it is handed to the browser directly. If no
    // browser could be opened there is nothing to copy: the way forward is the native window or another try.
    const how = r.opened ? 'opened Noema\'s account page in your browser' : 'no browser could be opened for Noema\'s account page — install the Noema Harness, or run the command again';
    return r.opened ? `${lead} — ${how}. It is served on this computer only and closes when you press Done.` : `${lead} — ${how}.`;
  }
  if (r.how === 'dashboard-window') return `Opened the Noema Model Dashboard at ${where}. Keys and sign-ins are entered there, never in this terminal.`;
  return `Opened the Model Dashboard at ${where}.`;
}

/**
 * TELL THE TERMINAL WHAT THE DASHBOARD DID — the registry's safe events since
 * `since`, until one arrives or `timeoutMs` passes. One stat per second while
 * waiting (the registry is a file every LAIN writes); nothing once it is done.
 */
function watch(since, onEvent, { timeoutMs = 15 * 60 * 1000, types = ['source-added', 'source-removed'] } = {}) {
  const store = require('./store');
  let gen = store.generation();
  const started = Date.now();
  const t = setInterval(() => {
    if (Date.now() - started > timeoutMs) { clearInterval(t); return; }
    const g = store.generation();
    if (g === gen) return;
    gen = g;
    const evs = store.events({ since }).filter((e) => types.includes(e.type));
    if (!evs.length) return;
    clearInterval(t);
    for (const e of evs) { try { onEvent(safe(e)); } catch { /* the terminal reports what it can */ } }
  }, 1000);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

/** ONLY WHAT IS SAFE TO PRINT: an id, a display name, a kind, what it can do. */
function safe(e) {
  return { type: e.type, kind: e.kind || null, id: e.id || null, family: e.family || null, name: e.name || null, capabilities: e.capabilities || null, at: e.at };
}

function describe(e) {
  const caps = e.capabilities && e.capabilities.models != null ? ` · ${e.capabilities.models} model${e.capabilities.models === 1 ? '' : 's'}` : '';
  if (e.type === 'source-added') return `${e.kind === 'api' ? 'API added' : 'Account connected'}: ${e.name || e.id} (${e.id})${caps}`;
  if (e.type === 'source-removed') return `Removed: ${e.id}`;
  return `${e.type}: ${e.name || e.id || ''}`;
}

module.exports = { open, said, watch, safe, describe, sectionOf, SECTIONS };
