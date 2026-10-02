'use strict';

/**
 * THE RUNTIME CAPABILITY MATRIX — per runtime, per capability, what LAIN can
 * actually do through the runtime's own program, right now. Never one
 * "connected": each cell is its own answer.
 *
 *   discovery · telemetry · execution · sessions · usage · limits ·
 *   streaming · cancel · bot · chat · agent
 *
 * A CELL is { level, why }:
 *   OPERATIONAL   proven by a run through LAIN (the last one succeeded / verified)
 *   AVAILABLE     the path exists and is wired; not yet proven by a run
 *   TELEMETRY     readable, not executable
 *   DETECTED      the runtime is installed; this was not read
 *   NOT_REPORTED  the runtime does not expose it (said, never invented)
 *   UNSUPPORTED   no legitimate path exists (the reason says which boundary)
 *   UNAVAILABLE   the path exists but is down now (not installed, not signed in, failed)
 *
 * WHAT EACH RUNTIME SUPPORTS AT ALL is declared here, once, with its reason;
 * what is TRUE NOW comes from the adapter's discovery, telemetry and execution.
 */

const L = Object.freeze({ OPERATIONAL: 'Operational', AVAILABLE: 'Available', TELEMETRY: 'Telemetry', DETECTED: 'Detected', NOT_REPORTED: 'Not reported', UNSUPPORTED: 'Unsupported', UNAVAILABLE: 'Unavailable' });
const KEYS = Object.freeze(['discovery', 'telemetry', 'execution', 'sessions', 'usage', 'limits', 'streaming', 'cancel', 'bot', 'chat', 'agent']);

// What each runtime's OWN program offers LAIN (true), or why not (a string).
const SUPPORT = Object.freeze({
  'claude-code': { sessions: true, usage: true, limits: true, streaming: true, cancel: true, bot: true, chat: true, agent: true },
  opencode: { sessions: true, usage: true, limits: 'OpenCode does not report limits for its models', streaming: true, cancel: true, bot: true, chat: true, agent: true },
  zcode: { sessions: 'ZCode does not expose its sessions to another program', usage: 'ZCode does not report usage to LAIN', limits: 'Balance not reported by ZCode', streaming: true, cancel: true, bot: true, chat: true, agent: 'ZCode Agent mode is not wired through LAIN' },
  ollama: { sessions: 'LAIN keeps the conversation (a local model has none of its own)', usage: true, limits: 'a local model has no provider quota', streaming: true, cancel: true, bot: true, chat: true, agent: true },
  llamacpp: { sessions: 'LAIN keeps the conversation (a local model has none of its own)', usage: true, limits: 'a local model has no provider quota', streaming: true, cancel: true, bot: true, chat: true, agent: true },
});

function cell(level, why) { return { level, why: why || null }; }

/** The matrix for one adapter report's parts. */
function matrix(a, disc, tele, exec) {
  const sup = SUPPORT[a.id] || SUPPORT[a.kind === 'local' ? 'llamacpp' : ''] || {};
  const installed = Boolean(disc && (disc.installed || disc.running));
  const out = {};
  out.discovery = installed ? cell(L.OPERATIONAL, disc.version ? `version ${disc.version}` : 'found') : cell(L.UNAVAILABLE, (disc && disc.why) || 'not installed');
  if (!installed) { for (const k of KEYS.slice(1)) out[k] = cell(L.UNAVAILABLE, 'not installed'); return out; }
  out.telemetry = tele && tele.ok ? cell(L.OPERATIONAL, tele.via || null) : tele ? cell(L.UNAVAILABLE, tele.why || 'status could not be read') : cell(L.DETECTED, 'not read yet');
  const ran = tele && tele.lastRun;
  const proven = Boolean(ran && ran.ok);
  const canChat = Boolean(exec && exec.chat && exec.chat.ok);
  const canAgent = Boolean(exec && exec.agent && exec.agent.ok);
  const execWhy = (exec && ((exec.chat && exec.chat.why) || (exec.agent && exec.agent.why))) || null;
  const run = (ok, why) => (ok ? cell(proven ? L.OPERATIONAL : L.AVAILABLE, why) : cell(tele && tele.ok ? L.TELEMETRY : L.UNAVAILABLE, execWhy));
  out.execution = typeof sup.chat === 'string' && typeof sup.agent === 'string' ? cell(L.UNSUPPORTED, sup.chat) : run(canChat || canAgent, null);
  const staticOr = (k, live) => (typeof sup[k] === 'string' ? cell(/not report|not expose|Balance|Credits/.test(sup[k]) ? L.NOT_REPORTED : L.UNSUPPORTED, sup[k]) : live);
  out.sessions = staticOr('sessions', tele && Array.isArray(tele.sessions) ? cell(L.OPERATIONAL, `${tele.sessions.length} listed`) : cell(L.AVAILABLE, null));
  out.usage = staticOr('usage', ran && ran.usage ? cell(L.OPERATIONAL, 'reported with each run') : cell(L.AVAILABLE, 'reported with each run'));
  const windows = tele && tele.limits && Array.isArray(tele.limits.windows) ? tele.limits.windows : null;
  out.limits = staticOr('limits', windows && windows.length ? cell(L.OPERATIONAL, `${windows.length} window(s) reported`) : cell(L.NOT_REPORTED, 'reported after a run'));
  out.streaming = staticOr('streaming', run(canChat || canAgent, null));
  out.cancel = staticOr('cancel', run(canChat || canAgent, null));
  const verified = tele && tele.verified ? Object.values(tele.verified) : [];
  const anyVerified = (f) => verified.some((v) => v && v[f] === true);
  out.chat = staticOr('chat', canChat ? cell(proven || anyVerified('chat') ? L.OPERATIONAL : L.AVAILABLE, null) : run(false));
  out.bot = staticOr('bot', canChat ? cell(proven || anyVerified('chat') ? L.OPERATIONAL : L.AVAILABLE, null) : run(false));
  out.agent = staticOr('agent', canAgent ? cell(anyVerified('agent') || (proven && a.id !== 'opencode') ? L.OPERATIONAL : L.AVAILABLE, a.id === 'opencode' ? 'per model, after LAIN verified it did real work' : null) : run(false));
  return out;
}

module.exports = { matrix, KEYS, LEVEL: L, SUPPORT };
