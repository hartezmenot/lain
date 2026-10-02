'use strict';

/**
 * THE TRAY — current intelligence health and quota, at a glance (Phase 8.3).
 *
 *   hover   LAIN
 *           Codex
 *           Personal   5h 74% · Weekly 52%
 *           Work       5h 91% · Weekly 67%
 *           Backup     Limited · Weekly 84%
 *           Claude Pro 5h 63% · Weekly 41%
 *           Antigravity Monthly 72%
 *           OpenCode   Ready
 *   click   a compact menu: those lines, then Open LAIN · Models & Accounts ·
 *           Usage · Active Tasks · Pause/Continue task · Exit
 *
 * ONLY REPORTED WINDOWS. A percentage is the provider's "used" figure for a
 * window it reported (runtime telemetry, a response's limit headers, Codex's
 * own rate-limit read). Nothing is estimated from LAIN's token counts — those
 * are observed usage, a different fact, shown on USAGE.
 *
 * EVENT-DRIVEN, NEVER POLLED. The summary is built from the fabric index (a
 * lookup) and pushed to the native host only when it CHANGES: after a request's
 * receipt, an account change, a fallback, a manual refresh, when a window
 * connects — and once more at the next KNOWN reset (one timer, unref'd). An
 * idle LAIN does no tray work at all.
 */

const store = require('./store');

const SHORT = [[/^5[- ]?hour$/i, '5h'], [/^five[_ ]hour$/i, '5h'], [/^weekly$|^7[- ]?day$|^seven[_ ]day$/i, 'Weekly'], [/^monthly$/i, 'Monthly'], [/^daily$/i, 'Daily'], [/^hourly$/i, 'Hourly']];
function shortLabel(l) { const s = String(l || ''); for (const [re, v] of SHORT) if (re.test(s)) return v; return s.replace(/^\w/, (c) => c.toUpperCase()); }

/** What REMAINS of a window, from whichever figure the provider gave (used → 100 − used). Never guessed. */
function remainingOf(w) {
  if (w.remainingPercent != null) return Math.round(w.remainingPercent);
  return w.usedPercent != null ? Math.round(100 - w.usedPercent) : null;
}
function windowsText(windows) {
  return (windows || []).filter((w) => remainingOf(w) != null || w.credits != null)
    .map((w) => (remainingOf(w) == null ? `Credits ${w.credits}` : `${shortLabel(w.label)} ${remainingOf(w)}% left`)).join(' · ');
}

function accountText(a) {
  const w = windowsText(a.quota);
  if (a.limited) return `Limited${w ? ` · ${w}` : ''}`;
  if (!a.usable) return a.state === 'SIGN_IN' ? 'Sign-in needed' : 'Unavailable';
  return w || 'Ready';
}

/** THE SUMMARY — families with accounts, each line only what was reported. Pure over the index. */
function summary(app) {
  const idx = require('./index');
  const fams = idx.families(app).filter((f) => f.kind !== 'api' && f.accounts.length);
  const groups = fams.map((f) => {
    const rows = f.accounts.map((a) => ({ id: a.id, name: a.name, text: accountText(a), limited: Boolean(a.limited), max: Math.max(-1, ...a.quota.map((w) => (w.usedPercent == null ? -1 : w.usedPercent))) }));
    return { id: f.id, label: f.label, single: rows.length === 1, rows };
  });
  const lines = ['LAIN'];
  for (const g of groups) {
    if (g.single) lines.push(`${g.label}  ${g.rows[0].text}`);
    else { lines.push(g.label); for (const r of g.rows) lines.push(`  ${r.name}  ${r.text}`); }
  }
  // THE ACTIVE QUOTA: the account the Coding Agent runs on now, its fullest reported window.
  let active = null;
  try {
    const l = require('../sessionintel').lane(app, app.session, 'coding');
    const g = groups.find((x) => x.id === l.family);
    const r = g && g.rows.find((x) => x.id === l.account);
    // `percent` is what the provider reported USED (kept for readers of the old shape); `remaining` is what the icon draws.
    if (r && r.max >= 0) active = { family: g.label, account: r.name, percent: r.max, remaining: Math.max(0, Math.round(100 - r.max)), limited: r.limited };
    else if (r && r.limited) active = { family: g.label, account: r.name, percent: 100, remaining: 0, limited: true };
  } catch { active = null; }
  const last = store.events({ type: 'fallback' }).slice(-1)[0] || null;
  const note = last && Date.now() - last.at < 6 * 3600 * 1000 ? `${last.familyLabel || last.family} switched to ${last.to && last.to.name} · ${last.reason || ''}`.trim() : null;
  let task = null;
  try {
    const w = require('../workbench').of(app.session);
    task = w.quota && w.quota.state === 'QUOTA_PAUSED' ? 'paused' : (app.abort && !app.abort.signal.aborted ? 'running' : null);
  } catch { task = null; }
  // THE TOOLTIP: Windows shows up to 127 characters — the most useful lines first.
  const tip = [];
  let n = 0;
  for (const l of lines) { const t = l.trim(); if (n + t.length + 1 > 127) break; tip.push(t); n += t.length + 1; }
  return { title: 'LAIN', groups, lines, active, note, task, tooltip: tip.join('\n') };
}

// ---------------------------------------------------------------- pushing --

let last = { sig: null, timer: null, at: 0 };

/** The next moment a reported window or a limit expires — the one timer the tray keeps. */
function nextReset(app) {
  const idx = require('./index');
  let t = Infinity;
  const now = Date.now();
  for (const f of idx.families(app)) for (const a of f.accounts) {
    for (const w of a.quota) { const r = w.resetsAt ? Number(new Date(w.resetsAt)) : NaN; if (r > now && r < t) t = r; }
    if (a.limited && a.limited.until && a.limited.until > now && a.limited.until < t) t = a.limited.until;
  }
  return Number.isFinite(t) ? t : null;
}

/**
 * SOMETHING THAT FEEDS THE TRAY MAY HAVE CHANGED. Builds the summary (lookups
 * only) and sends it to the host when it differs from what the host has.
 */
function changed(app, { force = false } = {}) {
  if (!app) return { ok: false, why: 'no app' };
  let s;
  try { s = summary(app); } catch (e) { return { ok: false, why: e.message }; }
  const sig = JSON.stringify([s.lines, s.active, s.note, s.task]);
  // THE NEXT KNOWN RESET re-reads the tray once, without a restart (an expired window stops showing as current).
  try {
    const nr = nextReset(app);
    if (last.timer) { clearTimeout(last.timer); last.timer = null; }
    if (nr) { last.timer = setTimeout(() => { last.timer = null; changed(app); }, Math.min(2 ** 31 - 1, Math.max(1000, nr - Date.now() + 1000))); if (last.timer.unref) last.timer.unref(); }
  } catch { /* no timer */ }
  if (!force && sig === last.sig) return { ok: true, sent: false, summary: s };
  last.sig = sig;
  last.at = Date.now();
  let sent = false;
  try { sent = require('../harnessapp/ipc').toHost(`tray:${JSON.stringify({ tooltip: s.tooltip, lines: s.lines.slice(0, 24), active: s.active, note: s.note, task: s.task })}`).ok; } catch { sent = false; }
  return { ok: true, sent, summary: s };
}

// THE PROCESS THAT HOLDS A WINDOW is the one that feeds a tray (harnessapp/ipc.js binds it on connect).
let bound = null;
let soon = null;
function bind(app) { bound = app || null; }

/** A request's receipt landed: the provider may have reported new windows. Coalesced; nothing without a window. */
function afterReceipt() {
  if (!bound || soon) return;
  soon = setTimeout(() => { soon = null; try { changed(bound); } catch { /* the tray is presentation */ } }, 400);
  if (soon.unref) soon.unref();
}

/** For tests. */
function reset() { if (last.timer) clearTimeout(last.timer); if (soon) clearTimeout(soon); soon = null; bound = null; last = { sig: null, timer: null, at: 0 }; }

module.exports = { summary, changed, nextReset, shortLabel, windowsText, bind, afterReceipt, reset };
