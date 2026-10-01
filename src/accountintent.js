'use strict';

/**
 * "ADD AN ACCOUNT" CROSSES FROM THE TERMINAL TO THE WINDOW BY INTENT, NOT BY KEY.
 *
 * `/account add` never asks for a key in the terminal or in a conversation —
 * a key typed there would sit in scrollback, in input history, and one slip
 * away from a model turn. It mints a short-lived, single-use intent that says
 * only WHAT the person wants to do ("add an account", optionally which kind),
 * opens the window at MODEL › Add account, and the window redeems it.
 *
 * AN INTENT CARRIES NO CREDENTIAL, no account id to act on, and grants
 * nothing: redeeming it pre-selects a form. The key (or the runtime's own
 * sign-in) happens in that form, and nowhere else.
 */

const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const intents = new Map();

function sweep(now = Date.now()) { for (const [t, v] of intents) if (now - v.at > TTL_MS) intents.delete(t); }

function mint({ action = 'add', driver = null, provider = null, from = 'cli' } = {}) {
  sweep();
  if (!['add', 'replace-key'].includes(action)) throw new Error('unknown account intent');
  const token = crypto.randomBytes(12).toString('hex');
  intents.set(token, { action, driver: driver ? String(driver).slice(0, 40) : null, provider: provider ? String(provider).slice(0, 40) : null, from, at: Date.now() });
  return { token, expiresInMs: TTL_MS };
}

/** Single use. Returns what the form should open to, or null. */
function redeem(token) {
  sweep();
  const v = intents.get(String(token || ''));
  intents.delete(String(token || ''));
  return v ? { action: v.action, driver: v.driver, provider: v.provider, from: v.from } : null;
}

module.exports = { mint, redeem, TTL_MS };
