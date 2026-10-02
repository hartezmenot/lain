'use strict';

/**
 * THE TWO LOCAL RUNTIMES in the runtime-adapter contract (runtimeadapters.js):
 * llama.cpp (LAIN starts and owns llama-server) and Ollama (a service the
 * person runs; LAIN only talks to it).
 *
 * A local model has NO PROVIDER QUOTA. Its measurements are runtime health,
 * tokens, speed, latency, memory and context — never a "% remaining".
 */

const path = require('path');
const llamacpp = require('./llamacpp');
const ollama = require('./ollama');
const modeldirs = require('./modeldirs');

function agentRoles(kind, model, verification) {
  const roles = ['CHAT', 'BOT', 'AUX'];
  if (model.vision) roles.push('VISION');
  if (verification && verification.result === 'verified') roles.push('AGENT');
  return roles;
}

const llama = {
  id: 'llamacpp', label: 'llama.cpp', provider: 'llama.cpp', kind: 'local', icon: 'llamacpp',
  source: 'llama.cpp · Local', authentication: 'none — a local program',
  install: { docs: 'https://github.com/ggml-org/llama.cpp' },
  binary: (app) => llamacpp.binary(app),
  async discover(app) {
    const bin = llamacpp.binary(app);
    return { installed: Boolean(bin), binary: bin, cli: llamacpp.cliBinary(app), version: bin ? llamacpp.version(app) : null, why: bin ? null : 'llama-server is not on PATH' };
  },
  async telemetry(app) {
    const l = modeldirs.list();
    const verify = require('../localagent');
    return {
      ok: true, at: Date.now(),
      dirs: l.dirs, projectors: l.projectors.length, other: l.other.length,
      models: l.models.map((m) => {
        const v = verify.current(app, m.id);
        return {
          id: m.id, label: `${m.modelName || path.basename(m.file, '.gguf')} · llama.cpp`, file: m.file,
          quantization: m.quantization, sizeBytes: m.sizeBytes, contextLength: m.contextLength, architecture: m.architecture,
          vision: m.vision, projector: m.projector, pairing: m.pairing, roles: agentRoles('llamacpp', m, v), agent: v ? v.result : 'not verified',
          entitlement: { kind: 'local', label: 'Local · no provider quota' },
        };
      }),
      servers: llamacpp.status().map((s) => ({ ...s, memoryBytes: llamacpp.processMemory(s.pid) })),
    };
  },
  execution(app) {
    if (!llamacpp.binary(app)) return { chat: { ok: false, why: 'llama-server is not installed' }, agent: { ok: false, why: 'llama-server is not installed' } };
    return { chat: { ok: true, how: 'LAIN starts an owned llama-server for the chosen model' }, agent: { ok: true, how: 'per model, after its Agent compatibility test passes' } };
  },
};

const oll = {
  id: 'ollama', label: 'Ollama', provider: 'ollama', kind: 'local', icon: 'ollama',
  source: 'Ollama · Local', authentication: 'none — a local service',
  install: { docs: 'https://ollama.com/download' },
  binary: () => ollama.binary(),
  async discover(app) {
    const info = await ollama.refresh(app);
    return { installed: Boolean(info.binary) || info.running, binary: info.binary, version: info.version, running: info.running, endpoint: info.endpoint, endpointConfigured: info.endpointConfigured, why: info.running ? null : (info.binary ? `not running at ${info.endpoint} (${info.why})` : `not installed, and nothing answers at ${info.endpoint}`) };
  },
  async telemetry(app) {
    const info = ollama.cached() || await ollama.refresh(app);
    const verify = require('../localagent');
    return {
      ok: Boolean(info && info.running), at: info ? info.at : Date.now(), why: info && !info.running ? info.why : null,
      endpoint: info ? info.endpoint : null, loaded: info ? info.loaded : [],
      models: ((info && info.models) || []).map((m) => {
        const v = verify.current(app, m.id);
        return { ...m, label: `${m.name} · Ollama`, roles: agentRoles('ollama', m, v), agent: v ? v.result : 'not verified', entitlement: { kind: 'local', label: 'Local · no provider quota' } };
      }),
    };
  },
  execution(app, tele) {
    if (!tele || !tele.ok) return { chat: { ok: false, why: 'Ollama is not running' }, agent: { ok: false, why: 'Ollama is not running' } };
    return { chat: { ok: true, how: 'Ollama /api/chat' }, agent: { ok: true, how: 'per model, after its Agent compatibility test passes' } };
  },
  chat: ollama.chat,
};

module.exports = { llama, ollama: oll };
