'use strict';

/** CAN THIS LOCAL MODEL BE THE CODING AGENT? */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function file() { return path.join(require('./config').configDir(), 'local', 'agentverify.json'); }
// Memoised on mtime+size (Phase 8.1): every connections() listing asked once per local model.
let allMemo = null;
function readAll() {
  let st = null;
  try { st = fs.statSync(file()); } catch { st = null; }
  const sig = st ? `${file()}|${st.mtimeMs}|${st.size}` : `${file()}|none`;
  if (allMemo && allMemo.sig === sig) return JSON.parse(allMemo.json);
  let v = {};
  try { v = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { v = {}; }
  allMemo = { sig, json: JSON.stringify(v) };
  return v;
}
function writeAll(v) {
  fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(v, null, 2)); allMemo = null;
  try { require('./appcatalog').invalidate(); } catch { /* not loaded */ }   // a verified model's roles changed (runtimeconnections.js)
}

/** What the result depends on, hashed. null when the model is unknown. */
function keyFor(app, modelId) {
  try {
    if (String(modelId).startsWith('llamacpp/')) {
      const m = require('./local/modeldirs').byId(modelId);
      if (!m) return null;
      const llama = require('./local/llamacpp');
      const cfg = llama.configFor(app, m);
      return crypto.createHash('sha1').update(JSON.stringify([m.file, m.sizeBytes, m.modifiedAt, llama.adapterKey(app), cfg.ctx, cfg.projector, cfg.ngl])).digest('hex').slice(0, 16);
    }
    if (String(modelId).startsWith('ollama/')) {
      const info = require('./local/ollama').cached();
      const m = info && (info.models || []).find((x) => x.id === modelId);
      if (!m) return null;
      return crypto.createHash('sha1').update(JSON.stringify([m.digest || m.name, m.modifiedAt, require('./local/ollama').adapterKey(info)])).digest('hex').slice(0, 16);
    }
  } catch { return null; }
  return null;
}

/** The stored result, only if it still applies. */
function current(app, modelId) {
  const k = keyFor(app, modelId);
  if (!k) return null;
  const r = readAll()[modelId];
  return r && r.key === k ? r : null;
}

/** Everything stored, including results that no longer apply (marked stale). */
function history(app, modelId) {
  const r = readAll()[modelId];
  if (!r) return null;
  return { ...r, stale: r.key !== keyFor(app, modelId) };
}

const TOOL = { name: 'read_file', description: 'Read a file from the project and return its text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path of the file to read' } }, required: ['path'] } };

async function collect(pc, messages, opts) {
  const provider = require('./provider');
  let text = ''; let calls = []; let first = null;
  for await (const ev of provider.chat(pc, messages, { ...opts, trace: { reason: 'agent-test' }, role: 'machinery' })) {
    if (!ev) continue;
    if (ev.type === 'text') { text += ev.chunk; if (!first) first = Date.now(); if (opts.onFirst) opts.onFirst(); }
    if (ev.type === 'tool_calls') calls = calls.concat(ev.calls || []);
  }
  return { text, calls };
}

/** RUN THE TEST for one local model. */
async function run(app, modelId, { signal = null, cwd = process.cwd() } = {}) {
  const key = keyFor(app, modelId);
  if (!key) return { ok: false, why: 'LAIN does not know this local model' };
  const cfg = { ...((app && app.cfg) || {}), connections: (app && app.cfg && app.cfg.connections) || {}, model: modelId, connection: null };
  const pc = require('./provider').resolve(cfg);
  if (!pc.protocol || pc.protocol !== 'runtime') return { ok: false, why: `${modelId} does not resolve to a local route` };
  const probes = [];
  const note = (id, pass, detail) => probes.push({ id, pass: Boolean(pass), detail: String(detail || '').slice(0, 200) });
  const base = { signal, cwd, app };
  const sys = { role: 'system', content: 'You are a coding agent. Follow instructions exactly.' };
  try {
    const a = await collect(pc, [sys, { role: 'user', content: 'Reply with exactly the single word READY and nothing else.' }], { ...base });
    note('instruction', /\bREADY\b/i.test(a.text) && a.text.trim().length < 40, a.text.trim().slice(0, 60) || '(no text)');

    const b = await collect(pc, [sys, { role: 'user', content: 'Use the read_file tool to read the file notes.txt. Do not answer from memory.' }], { ...base, tools: [TOOL] });
    const call = b.calls.find((c) => c.name === 'read_file');
    const okCall = call && call.input && /notes\.txt/i.test(String(call.input.path || ''));
    note('tool request', okCall, call ? `${call.name}(${JSON.stringify(call.input).slice(0, 80)})` : (b.text ? `answered in text: ${b.text.slice(0, 60)}` : 'no tool call'));

    const c = await collect(pc, [sys,
      { role: 'user', content: 'Use the read_file tool to read notes.txt, then tell me the secret word it contains.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'The secret word is PAPAYA.' }], { ...base, tools: [TOOL] });
    note('tool result', /papaya/i.test(c.text), c.text.trim().slice(0, 80) || (c.calls.length ? 'called a tool again' : '(no text)'));

    const ctl = new AbortController();
    let cancelledCleanly = false;
    try {
      await collect(pc, [sys, { role: 'user', content: 'Count slowly from 1 to 400, one number per line.' }], { ...base, signal: ctl.signal, onFirst: () => ctl.abort() });
      cancelledCleanly = ctl.signal.aborted;
    } catch (e) { cancelledCleanly = ctl.signal.aborted; }
    let healthy = true;
    if (String(modelId).startsWith('llamacpp/')) {
      const s = require('./local/llamacpp').status().find((x) => x.model === modelId);
      healthy = Boolean(s && (await require('./local/llamacpp').health(s.port)).ok);
    }
    note('cancel', cancelledCleanly && healthy, cancelledCleanly ? (healthy ? 'stopped; runtime still healthy' : 'stopped; runtime not healthy afterwards') : 'did not stop');

    const filler = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}: the build pipeline compiles, links and tests each module in order.`).join('\n');
    const d = await collect(pc, [sys, { role: 'user', content: `The access code is ORCHID-${key.slice(0, 4).toUpperCase()}.\n\n${filler}\n\nWhat is the access code? Reply with the code only.` }], { ...base });
    note('context', new RegExp(`ORCHID-${key.slice(0, 4)}`, 'i').test(d.text), d.text.trim().slice(0, 60) || '(no text)');
  } catch (e) {
    note('error', false, e.message);
  }
  const pass = (id) => probes.some((p) => p.id === id && p.pass);
  const all = ['instruction', 'tool request', 'tool result', 'cancel', 'context'].every(pass);
  const result = all ? 'verified' : (pass('instruction') && pass('tool result') ? 'partial' : 'unsupported');
  const rec = { modelId, key, result, probes, at: Date.now() };
  const store = readAll(); store[modelId] = rec; writeAll(store);
  return { ok: true, ...rec };
}

module.exports = { run, current, history, keyFor, TOOL };
