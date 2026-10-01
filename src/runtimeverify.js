'use strict';

/**
 * IS THIS RUNTIME MODEL A BOT? AN AGENT? — measured, per model, through the
 * real runtime (the RuntimeBridge), never assumed from a model list.
 *
 *   chat    one short instruction ("reply with exactly READY") through the
 *           BOT path — the model must answer, and answer that
 *   agent   a small, real piece of work in a scratch folder through the Agent
 *           path: create notes.txt containing a given word — the file must
 *           exist afterwards with that word. The runtime uses its own tools.
 *
 * Results are kept with the runtime's telemetry (`verified[modelId]`), keyed by
 * the runtime's version, and read by runtimeadapters.servableModels: a runtime
 * model is offered as the Coding Agent ONLY after its agent probe passed, and
 * is withdrawn from BOT/CHAT if its chat probe failed. Small by design: two
 * short requests per model.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BRIDGES = { opencode: () => require('./drivers/opencoderun'), 'claude-code': () => require('./drivers/claudecode') };

async function verify(app, runtimeId, modelId, { signal = null } = {}) {
  const bridge = BRIDGES[runtimeId] && BRIDGES[runtimeId]();
  if (!bridge) return { ok: false, why: 'no runtime bridge verifies this runtime' };
  const ra = require('./runtimeadapters');
  const version = ((ra.cachedTelemetry(`${runtimeId}.discovery`) || {}).version) || null;
  const res = { modelId, version, at: Date.now(), chat: null, agent: null, detail: {} };
  // CHAT: the BOT path (side effects denied).
  try {
    let text = '';
    for await (const ev of bridge.runStream(app, { prompt: 'Reply with exactly the single word READY and nothing else.', model: modelId, mode: 'chat', signal })) if (ev.type === 'text') text += ev.chunk;
    res.chat = /\bREADY\b/i.test(text) && text.trim().length < 60;
    res.detail.chat = text.trim().slice(0, 80);
  } catch (e) { res.chat = false; res.detail.chat = e.message.slice(0, 200); }
  // AGENT: a real file, in a scratch folder, by the runtime's own tools.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-agentprobe-'));
  const word = `LAIN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  try {
    for await (const ev of bridge.runStream(app, { prompt: `Create a file named notes.txt in the current folder containing exactly the text ${word}. Do nothing else.`, model: modelId, mode: 'agent', cwd: dir, signal })) void ev;
    const f = path.join(dir, 'notes.txt');
    res.agent = fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(word);
    res.detail.agent = res.agent ? 'created notes.txt with the word' : (fs.existsSync(f) ? 'notes.txt written, but without the word' : 'no file was created');
  } catch (e) { res.agent = false; res.detail.agent = e.message.slice(0, 200); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ } }
  const prev = ra.cachedTelemetry(runtimeId) || {};
  ra.saveTelemetry(runtimeId, { ...prev, verified: { ...(prev.verified || {}), [modelId]: res } });
  return { ok: true, ...res };
}

/** The stored result, if it still applies (same runtime version). */
function current(runtimeId, modelId) {
  const ra = require('./runtimeadapters');
  const t = ra.cachedTelemetry(runtimeId) || {};
  const r = (t.verified || {})[modelId];
  if (!r) return null;
  const version = ((ra.cachedTelemetry(`${runtimeId}.discovery`) || {}).version) || null;
  return r.version === version ? r : { ...r, stale: true };
}

module.exports = { verify, current, BRIDGES };
