'use strict';

/**
 * RUNTIME ADAPTERS — every runtime LAIN can work through, reported in three
 * separate answers that are never collapsed into one "connected":
 *
 *     DISCOVERY   can LAIN find (and, where it makes sense, adopt or start) it?
 *     TELEMETRY   can LAIN read its models, limits, credits, sessions, status?
 *     EXECUTION   can LAIN submit work to it and get the result back?
 *
 *   LAIN ─▶ adapter ─▶ the runtime's REAL program ─▶ its provider
 *
 * No adapter impersonates a runtime: none forges its identity, borrows its
 * client id, copies its credentials or calls the service behind it. Where a
 * runtime's entitlement lives only inside it, the adapter runs that runtime.
 *
 * STATES (`state`):
 *   NOT_INSTALLED   nothing found
 *   DETECTED        installed; not read yet
 *   TELEMETRY_ONLY  status readable; no execution path
 *   READY           an execution path exists; not yet proven by a run
 *   OPERATIONAL     a run through LAIN succeeded (the last one)
 *   DEGRADED        installed, but its status or last run failed
 *   RUNNING/STOPPED local services (Ollama running or not)
 *
 * Telemetry is cached per adapter (<configDir>/runtimes/<id>.json) so model
 * pickers read it synchronously; it is refreshed on request, never polled.
 */

const fs = require('fs');
const path = require('path');

const STATE = Object.freeze({
  NOT_INSTALLED: 'Not installed', DETECTED: 'Detected', ADOPTED: 'Adopted', STARTING: 'Starting', READY: 'Ready',
  TELEMETRY_ONLY: 'Telemetry only', OPERATIONAL: 'Operational', DEGRADED: 'Degraded', ERROR: 'Error', STOPPED: 'Stopped', RUNNING: 'Running',
});

function all() {
  const local = require('./local/adapters');
  return [require('./drivers/claudecode'), require('./drivers/zcoderun'), require('./drivers/opencoderun'), local.ollama, local.llama];
}
function get(id) { return all().find((a) => a.id === id) || null; }

function disconnected(app, id) { const r = (app && app._sibling) || app; const c = (r && r.cfg && r.cfg.runtimes && r.cfg.runtimes[id]) || {}; return c.disconnected === true; }

function cacheDir() { return path.join(require('./config').configDir(), 'runtimes'); }
// Re-read only when the file changes (2026-10-01): asked on every connection build, i.e. every turn.
const telemetryMemo = new Map();
function cachedTelemetry(id) {
  const f = path.join(cacheDir(), `${id}.json`);
  let st = null;
  try { st = fs.statSync(f); } catch { telemetryMemo.delete(f); return null; }
  const m = telemetryMemo.get(f);
  if (m && m.mtimeMs === st.mtimeMs && m.size === st.size) return m.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { value = null; }
  telemetryMemo.set(f, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}
function saveTelemetry(id, t) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const f = path.join(cacheDir(), `${id}.json`);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
    fs.renameSync(tmp, f);
    try { require('./accountcatalog').touched(f); } catch { /* not loaded yet */ }
  } catch { /* a cache */ }
  // WHAT A RUNTIME CAN SERVE MAY HAVE CHANGED: the memoised runtime connections go too (runtimeconnections.js).
  try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }
}
function cachedDiscovery(id) { const t = cachedTelemetry(`${id}.discovery`); return t || null; }

/** The composite state from the three answers. */
function stateOf(a, disc, tele, exec) {
  if (!disc || !disc.installed) return a.id === 'ollama' && disc && disc.running ? STATE.RUNNING : STATE.NOT_INSTALLED;
  if (a.id === 'ollama') return disc.running ? (exec.chat.ok ? STATE.READY : STATE.RUNNING) : STATE.STOPPED;
  const canRun = exec && (exec.chat.ok || exec.agent.ok);
  if (!tele) return STATE.DETECTED;
  if (!tele.ok && !canRun) return STATE.DEGRADED;
  if (!canRun) return STATE.TELEMETRY_ONLY;
  if (tele.lastRun && tele.lastRun.ok) return STATE.OPERATIONAL;
  if (tele.lastRun && tele.lastRun.ok === false && !tele.lastRun.cancelled) return STATE.DEGRADED;
  return STATE.READY;
}

/** One adapter's report, from cache unless `refresh`. */
async function report(app, id, { refresh = false } = {}) {
  const a = get(id);
  if (!a) return null;
  let disc = cachedDiscovery(id);
  let tele = cachedTelemetry(id);
  if (refresh || !disc) {
    disc = await a.discover(app).catch((e) => ({ installed: false, why: e.message }));
    saveTelemetry(`${id}.discovery`, { ...disc, at: Date.now() });
  }
  if (refresh && disc.installed) {
    const next = await a.telemetry(app, { prev: tele }).catch((e) => ({ ok: false, why: e.message, at: Date.now() }));
    tele = { ...next, lastRun: next.lastRun || (tele && tele.lastRun) || null };
    saveTelemetry(id, tele);
  } else if (a.kind === 'local' && disc.installed) {
    // LOCAL TELEMETRY IS LAIN'S OWN (directory scans, server table) — always current.
    tele = await a.telemetry(app, { prev: tele }).catch((e) => ({ ok: false, why: e.message }));
  }
  const exec = a.execution(app, tele);
  return {
    id: a.id, label: a.label, provider: a.provider, kind: a.kind, icon: a.icon, source: a.source, authentication: a.authentication, install: a.install,
    state: disconnected(app, a.id) ? 'Disconnected from Noema' : stateOf(a, disc, tele, exec),
    disconnected: disconnected(app, a.id),
    discovery: { ok: Boolean(disc && disc.installed), ...disc },
    telemetry: tele ? { ok: Boolean(tele.ok), at: tele.at || null, why: tele.why || null } : { ok: false, why: 'not read yet' },
    execution: exec,
    // THE CAPABILITY MATRIX (runtimecaps.js): eleven separate answers, never one "connected".
    capabilities: require('./runtimecaps').matrix(a, disc, tele, exec),
    detail: tele || null,
  };
}

async function reports(app, { refresh = false, only = null } = {}) {
  const out = [];
  for (const a of all()) {
    if (only && a.id !== only) { const r = await report(app, a.id, { refresh: false }); out.push(r); continue; }
    // eslint-disable-next-line no-await-in-loop -- a handful of adapters, each bounded
    out.push(await report(app, a.id, { refresh }));
  }
  return out;
}

/** Models a runtime can serve NOW (cached telemetry), for runtimeconnections. */
function servableModels(app, id) {
  const a = get(id);
  if (!a) return [];
  if (a.kind === 'local') return null;       // local models come from their own registries
  const tele = cachedTelemetry(id);
  const disc = cachedDiscovery(id);
  if (!disc || !disc.installed || !tele) return [];
  // DISCONNECTED FROM LAIN (the person's choice): its models are not offered. The runtime's own sign-in is untouched.
  if (disconnected(app, id)) return [];
  const exec = a.execution(app, tele);
  if (!exec.chat.ok && !exec.agent.ok) return [];
  // A THIRD-PARTY MODEL INSIDE A RUNTIME (OpenCode's free and configured models) is the Coding Agent
  // only after runtimeverify.js watched it do real work; a failed chat probe withdraws BOT/CHAT.
  const gated = id === 'opencode';
  const verified = tele.verified || {};
  return (tele.models || []).map((m) => {
    const v = verified[m.id] && verified[m.id].version === (disc.version || null) ? verified[m.id] : null;
    return { ...m, verification: v, roles: (m.roles || []).filter((r) => {
      if (r === 'AGENT') return exec.agent.ok && (!gated || (v && v.agent === true));
      return exec.chat.ok && !(gated && v && v.chat === false);
    }) };
  });
}

module.exports = { disconnected, STATE, all, get, report, reports, cachedTelemetry, saveTelemetry, servableModels, stateOf };
