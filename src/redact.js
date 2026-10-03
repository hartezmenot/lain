'use strict';

/** A CREDENTIAL MAY EXIST INSIDE LAIN. */

/** THE LIVE CREDENTIALS THIS PROCESS IS HOLDING. */
const secrets = new Set();

/** Below this, a string is too short to be a credential and too likely to be a word. */
const MIN_SECRET = 12;

/** `sk-…9f2a` — enough to recognise, not enough to use. */
function shape(cred) {
  const s = String(cred || '');
  if (s.length <= 10) return '…';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** Hold this value back from every display surface, from now on. */
function register(secret) {
  const s = String(secret == null ? '' : secret).trim();
  if (s.length < MIN_SECRET) return false;
  secrets.add(s);
  return true;
}

/** Everything a config file and the environment are currently holding. */
function registerFrom(cfg = {}) {
  for (const [platform, settings] of Object.entries(cfg.bot?.platforms || {})) {
    if (!settings || typeof settings !== 'object') continue;
    for (const key of [settings.tokenEnv || `LAIN_${platform.toUpperCase()}_TOKEN`, settings.appSecretEnv, settings.verifyTokenEnv]) {
      if (key && process.env[key]) register(process.env[key]);
    }
  }
  const conns = (cfg && cfg.connections && typeof cfg.connections === 'object') ? cfg.connections : {};
  for (const c of Object.values(conns)) {
    if (!c || typeof c !== 'object') continue;
    if (c.apiKey) register(c.apiKey);
    if (c.token) register(c.token);
    if (c.envKey && process.env[c.envKey]) register(process.env[c.envKey]);
  }
  // The env-declared routes, from the one table of them. A key that configures
  // LAIN without a config file is exactly as secret as one that is written down.
  try {
    for (const r of require('./providers').envRoutes()) {
      if (r.envKey && process.env[r.envKey]) register(process.env[r.envKey]);
    }
  } catch { /* providers is a leaf module; if it cannot load, nothing else can */ }
  return secrets.size;
}

/** Forget everything. For tests, and for a process that has re-keyed. */
function clear() { secrets.clear(); }

/** How many are held. Never WHAT is held — that would be the leak itself. */
function count() { return secrets.size; }

/** A TOKEN THAT ARRIVED FROM SOMEWHERE LAIN NEVER STORED. */
const INTRODUCED = new RegExp(
  '((?:bearer\\s+|x-api-key\\s*[:=]\\s*"?|api[_-]?key\\s*[:=]\\s*"?|'
  + 'authorization\\s*[:=]\\s*"?(?:bearer\\s+)?|token\\s*[:=]\\s*"?))'
  + '([A-Za-z0-9_\\-.]{16,})', 'gi');

/** The text, with every credential this process holds replaced by its shape. */
function text(s) {
  if (s === null || s === undefined) return s;
  let out = String(s);
  if (!out) return out;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(shape(secret));
  }
  // The second pass only pays for itself when the introducing word is present.
  if (/bearer|api[_-]?key|authorization|token/i.test(out)) {
    out = out.replace(INTRODUCED, (m, lead, tok) => lead + shape(tok));
  }
  return out;
}

/** Does this text still contain a credential? */
function leaks(s) {
  const t = String(s == null ? '' : s);
  for (const secret of secrets) if (t.includes(secret)) return true;
  return false;
}

/** A CREDENTIAL TYPED ON THE COMMAND LINE IS TAKEN BACK OUT OF HISTORY. */
function scrubHistory(input) {
  if (!input || !Array.isArray(input.history)) return 0;
  const before = input.history.length;
  input.history = input.history.filter((h) => !leaks(h));
  const dropped = before - input.history.length;
  if (dropped) input.histIndex = input.history.length;
  // The line still being edited is the same exposure, one keystroke earlier.
  if (leaks(input.line) && typeof input.setLine === 'function') input.setLine('');
  return dropped;
}

module.exports = { register, registerFrom, clear, count, text, leaks, shape, scrubHistory, MIN_SECRET };
