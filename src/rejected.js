'use strict';

/** WHAT LAIN WAS NOT ALLOWED TO DO — and how to change your mind. */

const path = require('path');

/** Bounded like every other in-memory list. Newest kept. */
const MAX = 50;

/** The list for this app, created on first use. */
function listOf(app) {
  if (!app._rejected) app._rejected = [];
  return app._rejected;
}

/** Record a refusal. */
function note(app, { tool, target, why, write = false } = {}) {
  if (!app || !target) return null;
  const list = listOf(app);
  const key = path.resolve(String(target));
  const found = list.find((e) => e.target === key && e.tool === tool);
  if (found) {
    found.count += 1;
    found.at = Date.now();
    return found;
  }
  const entry = {
    id: `r${list.length + 1}-${Date.now().toString(36)}`,
    tool: String(tool || 'tool'),
    target: key,
    why: String(why || 'outside what this session may touch'),
    write: Boolean(write),
    count: 1,
    at: Date.now(),
    allowed: false,
  };
  list.push(entry);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  return entry;
}

/** Everything refused this session, newest first. */
function all(app) {
  return listOf(app).slice().sort((a, b) => b.at - a.at);
}

/** How many DISTINCT things are waiting to be reconsidered. */
function pending(app) {
  return listOf(app).filter((e) => !e.allowed).length;
}

/** Allow one entry, for real. */
function allow(app, id) {
  const entry = listOf(app).find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'no such refusal' };
  const trust = require('./trust');
  const dir = path.dirname(entry.target);
  app.cfg.trustedPaths = trust.remember(app.cfg, dir, trust.LEVEL.TRUSTED);
  try { require('./config').save(app.cfg); } catch { /* an unwritable config still allows it for this session */ }
  entry.allowed = true;
  entry.allowedAt = Date.now();
  return { ok: true, entry, dir };
}

/** Forget everything. Used by `/permissions clear`. */
function clear(app) {
  const n = listOf(app).length;
  app._rejected = [];
  return n;
}

module.exports = { note, all, pending, allow, clear, MAX };
