'use strict';

/** CONNECTED BOTS (Phase 8.1) — external bots joining the LAIN house. */

const PERMS = Object.freeze(['projects', 'schedules', 'channels', 'mcp', 'skills', 'delegate', 'runtime']);
const STATES = Object.freeze(['WORKING', 'IDLE', 'WAITING', 'ERROR', 'OFFLINE']);

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { const r = root(app); return (r && r.cfg) || {}; }
function store(app) { const c = cfgOf(app); if (!c.bots || typeof c.bots !== 'object') c.bots = {}; if (!c.bots.connected || typeof c.bots.connected !== 'object') c.bots.connected = {}; return c.bots.connected; }
function save(app) { try { require('./config').save(cfgOf(app)); } catch { /* in memory */ } }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot'; }

function connect(app, body = {}) {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return { ok: false, why: 'name the bot' };
  const statusUrl = body.statusUrl ? String(body.statusUrl).trim() : null;
  if (statusUrl) {
    let u; try { u = new URL(statusUrl); } catch { return { ok: false, why: 'the status address is not a URL' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, why: 'the status address must be http(s)' };
    if (u.protocol === 'http:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return { ok: false, why: 'a remote status address must use https' };
  }
  const s = store(app);
  let id = slug(name); let n = 2; while (s[id]) id = `${slug(name)}-${n++}`;
  const perms = {};
  for (const p of PERMS) perms[p] = Boolean(body.permissions && body.permissions[p]);
  s[id] = { name, statusUrl, pid: Number(body.pid) || null, channel: body.channel ? String(body.channel).slice(0, 60) : null, permissions: perms, mode: 'connected', connectedAt: new Date().toISOString() };
  save(app);
  return { ok: true, id, bot: describe(app, id) };
}

function describe(app, id) {
  const b = store(app)[id];
  if (!b) return null;
  return { id, name: b.name, mode: b.mode, statusUrl: b.statusUrl || null, channel: b.channel || null, permissions: { ...b.permissions }, connectedAt: b.connectedAt, migratedAt: b.migratedAt || null, lastStatus: b.lastStatus || null };
}
function list(app) { return Object.keys(store(app)).map((id) => describe(app, id)); }

function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** THE BOT'S STATE — its own structured report first; a live process alone never reads as working. */
async function status(app, id) {
  const b = store(app)[id];
  if (!b) return { ok: false, why: 'no such bot' };
  let st = { state: 'UNKNOWN', basis: 'nothing reports this bot\'s state', at: Date.now() };
  if (b.statusUrl) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(b.statusUrl, { signal: ctl.signal, headers: { accept: 'application/json' } });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const reported = j && String(j.state || '').toUpperCase();
      if (j && STATES.includes(reported)) st = { state: reported, task: j.task ? String(j.task).slice(0, 200) : null, since: j.since || null, basis: 'reported by the bot', migratable: Boolean(j.lainMigration), at: Date.now() };
      else st = { state: 'UNKNOWN', basis: r.ok ? 'the bot answered without a state LAIN understands' : `the status address answered ${r.status}`, at: Date.now() };
    } catch (e) { st = { state: 'OFFLINE', basis: `the status address did not answer (${e.name === 'AbortError' ? 'timeout' : e.message})`, at: Date.now() }; } finally { clearTimeout(t); }
  } else if (b.pid) {
    st = alive(b.pid) ? { state: 'RUNNING', basis: 'its process is alive — whether it is working is not reported', at: Date.now() } : { state: 'OFFLINE', basis: 'its process has exited', at: Date.now() };
  }
  b.lastStatus = st;
  return { ok: true, status: st };
}

/** MIGRATE — only what the bot's own manifest declares; the external bot is left as it is. */
async function migrate(app, id) {
  const b = store(app)[id];
  if (!b) return { ok: false, why: 'no such bot' };
  if (!b.statusUrl) return { ok: false, why: 'this bot has no status address to read a migration from — Connect keeps it as it is' };
  let j = null;
  try { const r = await fetch(b.statusUrl, { headers: { accept: 'application/json' } }); j = r.ok ? await r.json() : null; } catch { j = null; }
  const m = j && j.lainMigration;
  if (!m || typeof m !== 'object') return { ok: false, unsupported: true, why: 'this bot does not declare a migration to LAIN — keep it connected instead' };
  const profile = {
    name: String(m.name || b.name).slice(0, 60),
    instructions: String(m.instructions || '').slice(0, 8000),
    schedules: Array.isArray(m.schedules) ? m.schedules.slice(0, 20).map((x) => ({ when: String(x.when || '').slice(0, 80), task: String(x.task || '').slice(0, 400) })) : [],
    from: { bot: id, at: new Date().toISOString() },
  };
  const c = cfgOf(app);
  c.bots.profiles = c.bots.profiles || {};
  c.bots.profiles[slug(profile.name)] = profile;
  b.mode = 'migrated'; b.migratedAt = profile.from.at;
  save(app);
  return { ok: true, profile, note: 'Imported into a LAIN bot profile. The external bot was not changed or stopped; schedules are suggestions until you enable them.' };
}

function setPermissions(app, id, perms = {}) {
  const b = store(app)[id];
  if (!b) return { ok: false, why: 'no such bot' };
  for (const p of PERMS) if (p in perms) b.permissions[p] = Boolean(perms[p]);
  save(app);
  return { ok: true, bot: describe(app, id) };
}

/** May this connected bot use that house capability? */
function may(app, id, capability) { const b = store(app)[id]; return Boolean(b && b.permissions && b.permissions[capability]); }

function remove(app, id) {
  const s = store(app);
  if (!s[id]) return { ok: false, why: 'no such bot' };
  delete s[id];
  save(app);
  return { ok: true, note: 'Disconnected from LAIN. The bot itself keeps running wherever it runs.' };
}

module.exports = { connect, list, describe, status, migrate, setPermissions, may, remove, PERMS, STATES };
