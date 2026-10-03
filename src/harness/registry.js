'use strict';

/** THE CAPABILITY REGISTRY — one description of everything LAIN can do, whoever provides it. */

const SIDE_EFFECT = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  EXECUTE: 'EXECUTE',
  NETWORK: 'NETWORK',
  DESTRUCTIVE: 'DESTRUCTIVE',
  EXTERNAL: 'EXTERNAL',
});

/** How much a capability's PROVIDER is trusted, which is not how safe it is. */
const TRUST = Object.freeze({
  /** Shipped in this repository, covered by these tests. */
  BUILT_IN: 'BUILT_IN',
  /** A bridge or server the user configured. Their choice; still not our code. */
  CONFIGURED: 'CONFIGURED',
  /** Reached over a network to somebody else's service. */
  EXTERNAL: 'EXTERNAL',
});

const APPROVAL = Object.freeze({
  AUTOMATIC: 'AUTOMATIC',
  REQUIRED: 'REQUIRED',
});

/** THE POLICY — the whole of it, in one readable table. */
const POLICY = Object.freeze({
  [SIDE_EFFECT.READ]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.WRITE]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.EXECUTE]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.NETWORK]: APPROVAL.AUTOMATIC,
  [SIDE_EFFECT.DESTRUCTIVE]: APPROVAL.REQUIRED,
  [SIDE_EFFECT.EXTERNAL]: APPROVAL.REQUIRED,
});

/** A capability that has not answered by now has stopped answering. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** RETRY POLICY, and the rule behind the table. */
const RETRY = Object.freeze({
  [SIDE_EFFECT.READ]: 'IDEMPOTENT',
  [SIDE_EFFECT.WRITE]: 'IDEMPOTENT',
  [SIDE_EFFECT.EXECUTE]: 'ONCE',
  [SIDE_EFFECT.NETWORK]: 'IDEMPOTENT',
  [SIDE_EFFECT.DESTRUCTIVE]: 'DISABLED',
  [SIDE_EFFECT.EXTERNAL]: 'DISABLED',
});

/** WHAT EACH LAIN TOOL ACTUALLY DOES, where `mutates` is not specific enough. */
const OVERRIDES = Object.freeze({
  run_bash: SIDE_EFFECT.EXECUTE,
  run_powershell: SIDE_EFFECT.EXECUTE,
  run_cmd: SIDE_EFFECT.EXECUTE,
  process_run: SIDE_EFFECT.EXECUTE,
  python_run: SIDE_EFFECT.EXECUTE,
  run_background: SIDE_EFFECT.EXECUTE,
  run_tests: SIDE_EFFECT.EXECUTE,
  service_start: SIDE_EFFECT.EXECUTE,
  service_stop: SIDE_EFFECT.EXECUTE,
  verify_task: SIDE_EFFECT.EXECUTE,
  web_fetch: SIDE_EFFECT.NETWORK,
  delete_file: SIDE_EFFECT.DESTRUCTIVE,
  delete_range: SIDE_EFFECT.DESTRUCTIVE,
  remove_symbol: SIDE_EFFECT.DESTRUCTIVE,
  computer: SIDE_EFFECT.EXECUTE,
});

/** Providers whose capabilities are never LAIN's own code. */
const PROVIDER = Object.freeze({
  TOOL: 'lain',
  BRIDGE: 'bridge',
  MCP: 'mcp',
  HARNESS: 'harness',
});

function effectFor(name, { mutates = false } = {}) {
  return OVERRIDES[name] || (mutates ? SIDE_EFFECT.WRITE : SIDE_EFFECT.READ);
}

/** DESCRIBE ONE CAPABILITY. */
function describe(name, { mutates = false, effect = null, description = '', provider = PROVIDER.TOOL, trust = TRUST.BUILT_IN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sideEffect = effect || effectFor(name, { mutates });
  return {
    name: String(name),
    description: String(description || '').slice(0, 400),
    provider,
    source: provider,
    category: provider === PROVIDER.BRIDGE ? 'Observation' : sideEffect === SIDE_EFFECT.EXECUTE ? 'Execution' : 'Core',
    availability: provider === PROVIDER.BRIDGE ? 'REQUIRES_CONFIGURATION' : 'AVAILABLE',
    requirements: provider === PROVIDER.BRIDGE ? ['configured bridge', 'connected transport', 'existing permission grant'] : [],
    limitations: provider === PROVIDER.BRIDGE ? ['configuration alone does not prove a working connection'] : ['subject to existing trust and permission checks'],
    trust,
    sideEffect,
    approval: POLICY[sideEffect] || APPROVAL.AUTOMATIC,
    retry: RETRY[sideEffect] || 'ONCE',
    timeoutMs: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
  };
}

/** EVERY CAPABILITY AVAILABLE RIGHT NOW. */
function all(app = null) {
  const out = [];
  const cfg = (app && app.cfg) || require('../config').load();
  let tools;
  try { tools = require('../tools'); } catch { tools = null; }
  if (tools) {
    // BUILT ONCE. `schemas()` re-derives the whole active vocabulary on every call, so asking it per tool made this quadratic in the tool count for no…
    const byName = new Map(tools.schemas(app).map((x) => [x.name, x]));
    for (const name of tools.names(app)) {
      const schema = byName.get(name);
      out.push(describe(name, {
        mutates: tools.isMutating(name, app),
        effect: tools.effect(name, app),
        description: (schema && schema.description) || '',
        provider: name === 'computer' ? PROVIDER.BRIDGE : PROVIDER.TOOL,
        trust: name === 'computer' ? TRUST.CONFIGURED : TRUST.BUILT_IN,
      }));
    }
  }
  // THE DESKTOP BRIDGE'S OWN OPERATIONS, named individually.
  try {
    const mcp = require('../mcp');
    if (mcp.configured(cfg)) {
      const computer = require('../computer');
      for (const op of computer.NAMES) {
        const spec = computer.OPS[op];
        out.push(describe(`computer.${op}`, {
          mutates: !spec.reads,
          description: spec.what,
          provider: PROVIDER.BRIDGE,
          trust: TRUST.CONFIGURED,
        }));
      }
    }
  } catch { /* no bridge configured, which is the ordinary case */ }
  for (const capability of out) {
    if (capability.provider === PROVIDER.BRIDGE) {
      const bridge = app && app._desktop && app._desktop.bridge;
      capability.availability = bridge && bridge.state === 'CONNECTED' ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.configured = require('../mcp').configured(cfg);
      capability.limitations = ['requires a live bridge handshake and existing permission grant'];
    }
    if (capability.name === 'python_run') {
      const python = require('../tools/exec').findPython(cfg);
      capability.category = 'Execution';
      capability.availability = python.ok ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.requirements = ['Python interpreter on PATH or configured in python.exe'];
      capability.limitations = ['interpreter presence does not prove project dependencies are installed'];
    }
    if (/^cowork_email_(?:search|read|send|archive|delete)$/.test(capability.name)) {
      const configured = require('../cowork/services').configured(app, 'email');
      capability.category = 'Account'; capability.trust = TRUST.CONFIGURED; capability.configured = configured;
      capability.availability = configured ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.requirements = ['configured Cowork email service'];
      capability.limitations = ['configuration alone does not prove provider availability'];
    }
    const personal = /^cowork_(calendar|contacts|reminders|notes)_(?:list|change)$/.exec(capability.name);
    if (personal) {
      const configured = require('../cowork/services').configured(app, personal[1]);
      capability.category = 'Account'; capability.trust = TRUST.CONFIGURED; capability.configured = configured;
      capability.availability = configured ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.requirements = [`configured Cowork ${personal[1]} service`];
      capability.limitations = ['configuration alone does not prove provider availability'];
    }
    if (/^cowork_image_(?:generate|inpaint)$/.test(capability.name)) {
      const configured = require('../cowork/services').configured(app, 'image');
      capability.category = 'Media'; capability.trust = TRUST.CONFIGURED; capability.configured = configured;
      capability.availability = configured ? 'AVAILABLE' : 'OPTIONAL_UNAVAILABLE';
      capability.requirements = ['configured Cowork image service'];
      capability.limitations = ['configuration alone does not prove provider availability'];
    }
  }
  return out;
}

/** DOES THIS NEED SOMEBODY TO SAY YES? */
function needsApproval(name, opts = {}) {
  return describe(name, opts).approval === APPROVAL.REQUIRED;
}

/** Grouped for display: what can this thing do, by kind of effect. */
function byEffect(app = null) {
  const groups = {};
  for (const c of all(app)) {
    if (!groups[c.sideEffect]) groups[c.sideEffect] = [];
    groups[c.sideEffect].push(c.name);
  }
  return groups;
}

module.exports = {
  SIDE_EFFECT, TRUST, APPROVAL, POLICY, RETRY, PROVIDER, OVERRIDES,
  describe, all, byEffect, needsApproval, effectFor, DEFAULT_TIMEOUT_MS,
};
