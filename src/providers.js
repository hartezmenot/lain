'use strict';

/** WHERE A CREDENTIAL CAN BE SENT — the endpoints LAIN actually knows. */

/** The endpoints LAIN knows, in the order a picker should offer them. */
const KNOWN = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OpenAI / Codex',
    protocol: 'chat',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
  }),
  Object.freeze({
    id: 'anthropic',
    label: 'Claude / Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
  }),
  Object.freeze({
    id: 'ollama',
    label: 'Ollama Cloud',
    protocol: 'chat',
    baseUrl: 'https://ollama.com/v1',
    envKey: 'OLLAMA_API_KEY',
  }),
  // SUPPLIED BY THE OPERATOR
  Object.freeze({
    id: 'bai',
    label: 'b.ai',
    protocol: 'chat',
    baseUrl: 'https://api.b.ai/v1',
    envKey: 'BAI_API_KEY',
  }),
  // CORROBORATED FROM THE USER'S OWN WORKING V1 CONFIGURATION
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode Zen',
    protocol: 'chat',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKey: 'OPENCODE_API_KEY',
  }),
  Object.freeze({
    id: 'zai',
    label: 'Z.AI',
    protocol: 'chat',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    envKey: 'ZAI_API_KEY',
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi',
    protocol: 'chat',
    baseUrl: 'https://api.kimi.com/coding/v1',
    envKey: 'KIMI_API_KEY',
  }),
  Object.freeze({
    id: 'cline',
    label: 'Cline',
    protocol: 'chat',
    baseUrl: 'https://api.cline.bot/api/v1',
    envKey: 'CLINE_API_KEY',
  }),
]);

/** PROVIDERS LAIN KNOWS OF AND CANNOT PLACE. */
const NEEDS_ENDPOINT = Object.freeze([
  Object.freeze({ id: 'agentrouter', label: 'AgentRouter' }),
  Object.freeze({ id: 'zenmux', label: 'ZenMux' }),
  Object.freeze({ id: 'nvidia', label: 'NVIDIA' }),
  Object.freeze({ id: 'gemini', label: 'Google Gemini' }),
  Object.freeze({ id: 'qwen', label: 'Qwen' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
  Object.freeze({ id: 'modelscope', label: 'ModelScope' }),
  Object.freeze({ id: 'kiro', label: 'Kiro' }),
  Object.freeze({ id: 'commandcode', label: 'CommandCode' }),
  Object.freeze({ id: 'zed', label: 'Zed' }),
]);

/** WHAT THE USER'S OWN V1 CONFIGURATION SAYS, read at run time. */
const V1_CONFIG = 'config.json';
/** Cached BY PATH, not by "have I run yet". */
let v1cache = null;
let v1cacheFor = null;
function v1File() {
  const os = require('os');
  const path = require('path');
  return process.env.LAIN_V1_CONFIG || path.join(os.homedir(), '.lain', V1_CONFIG);
}
function v1Routes() {
  const file = v1File();
  if (v1cache && v1cacheFor === file) return v1cache;
  v1cache = [];
  v1cacheFor = file;
  try {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const declared = (raw && raw.providers && typeof raw.providers === 'object') ? raw.providers : {};
    for (const [id, p] of Object.entries(declared)) {
      if (!p || typeof p !== 'object') continue;
      // NAME AND ENDPOINT ONLY. See above: the key stays where the user put it.
      v1cache.push({
        id: String(id),
        label: String(id),
        protocol: p.protocol === 'anthropic' ? 'anthropic' : 'chat',
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
      });
    }
  } catch { /* no V1 on this machine is the ordinary state, and contributes nothing */ }
  return v1cache;
}

/** The known provider with this id, or null. */
function byId(id) {
  const want = String(id || '').toLowerCase();
  return KNOWN.find((p) => p.id === want) || null;
}

/** The env-declared native routes, for connections.js. One list, one source. */
function envRoutes() {
  return KNOWN.map((p) => ({
    id: `env:${p.id}`,
    provider: p.id,
    envKey: p.envKey,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
  }));
}

/** EVERYTHING A CREDENTIAL COULD BELONG TO, for the `/api` picker. */
/** NAMES THIS PRODUCT NO LONGER OFFERS, from ANY list. */
const RETIRED = new Set(['omniroute', 'custom', 'tokenrouter']);

function choices(cfg = {}) {
  // A BRIDGE-HELD PROVIDER IS NEVER OFFERED, FROM ANY LIST
  const declaredAll = (cfg && cfg.connections && typeof cfg.connections === 'object') ? cfg.connections : {};
  const bridged = new Set();
  for (const [id, c] of Object.entries(declaredAll)) {
    if (c && typeof c === 'object' && c.via === 'bridge') bridged.add(String(c.provider || id));
  }
  const out = KNOWN.filter((p) => !bridged.has(p.id) && !RETIRED.has(p.id)).map((p) => ({ ...p, known: true, source: 'built-in' }));
  // RETIRED NAMES ARE SEEDED AS ALREADY-SEEN, so every loop below skips them
  // without each one needing to remember to. See RETIRED.
  const seen = new Set([...out.map((p) => p.id), ...bridged, ...RETIRED]);
  // OFFERED, AND HONEST ABOUT WHAT IS MISSING.
  const v1 = new Map(v1Routes().filter((r) => r.baseUrl).map((r) => [r.id, r]));
  for (const p of NEEDS_ENDPOINT) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const known = v1.get(p.id);
    out.push({
      ...p,
      label: known ? `${p.label}   (from your V1 configuration)` : p.label,
      protocol: known ? known.protocol : 'chat',
      baseUrl: known ? known.baseUrl : '',
      envKey: null,
      known: false,
      needsEndpoint: !known,
      source: known ? 'your V1 configuration' : 'endpoint not established',
    });
  }
  // AND WHAT V1 ALREADY KNEW, on a machine that has it
  for (const p of v1Routes()) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      ...p,
      label: p.baseUrl ? `${p.label}   (from your V1 configuration)` : p.label,
      envKey: null,
      known: false,
      needsEndpoint: !p.baseUrl,
      source: p.baseUrl ? 'your V1 configuration' : 'endpoint not established',
    });
  }
  for (const [id, c] of Object.entries(declaredAll)) {
    if (!c || typeof c !== 'object') continue;
    // A BRIDGE HOLDS ITS OWN CREDENTIAL — already excluded above, for every list rather than only for this one.
    if (c.via === 'bridge') continue;
    const name = String(c.provider || id);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: name,
      label: `${name}   (configured)`,
      protocol: c.protocol || 'chat',
      baseUrl: c.baseUrl || '',
      envKey: c.envKey || null,
      known: false,
      source: 'your config',
      connectionId: id,
    });
  }
  return out;
}

/** The connection id a credential for this provider should be stored under. */
const connectionIdFor = (providerId) => `lain:${String(providerId)}`;

module.exports = { KNOWN, NEEDS_ENDPOINT, RETIRED, byId, envRoutes, v1Routes, choices, connectionIdFor };
