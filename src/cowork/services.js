'use strict';

const path = require('path');
const contract = require('./contract');

const DOMAINS = new Set(['email', 'calendar', 'contacts', 'reminders', 'notes']);
const OPS = Object.freeze({
  email: new Set(['search', 'read', 'send', 'archive', 'delete']),
  calendar: new Set(['list', 'create', 'update', 'delete']),
  contacts: new Set(['list', 'create', 'update', 'delete']),
  reminders: new Set(['list', 'create', 'update', 'complete', 'delete']),
  notes: new Set(['list', 'create', 'update', 'delete']),
});

function configured(app, domain) {
  if (!DOMAINS.has(domain)) return false;
  if (typeof app?.coworkServices?.[domain]?.invoke === 'function') return true;
  const command = app?.cfg?.cowork?.services?.[domain]?.command;
  return Array.isArray(command) && command.length > 0 && command.every(v => typeof v === 'string' && v.length > 0);
}

function processEnvironment(spec = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  const mapping = spec.envFrom && typeof spec.envFrom === 'object' ? spec.envFrom : {};
  for (const [target, source] of Object.entries(mapping)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(target) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(String(source))) continue;
    if (process.env[source] != null) env[target] = process.env[source];
  }
  return env;
}

function failure(value, fallback = contract.FAILURE.FAILED) {
  const cls = Object.values(contract.FAILURE).includes(value?.class) ? value.class : fallback;
  return { ok: false, class: cls, why: contract.safeText(value?.why || 'the configured account service did not complete', 240) };
}

async function invoke(app, domain, operation, input = {}, { signal } = {}) {
  if (!DOMAINS.has(domain) || !OPS[domain]?.has(operation)) return failure({ class: contract.FAILURE.UNSUPPORTED, why: 'that account operation is not supported' });
  if (!configured(app, domain)) return failure({ class: contract.FAILURE.AUTH_REQUIRED, why: `no Cowork ${domain} service is configured` });
  try {
    if (typeof app?.coworkServices?.[domain]?.invoke === 'function') {
      const result = await app.coworkServices[domain].invoke(operation, input, { signal });
      return result?.ok ? { ok: true, data: result.data || {} } : failure(result);
    }
    const spec = app.cfg.cowork.services[domain], [program, ...args] = spec.command;
    const response = await require('../tools/exec').execute(program, args, {
      cwd: path.resolve(app.session?.cwd || process.cwd()), timeoutMs: Math.max(1000, Math.min(Number(spec.timeoutMs) || 30_000, 120_000)),
      signal, env: processEnvironment(spec), input: JSON.stringify({ version: 1, domain, operation, input }),
    });
    if (!response.ok) return failure({ class: response.interrupted ? contract.FAILURE.CANCELLED : contract.FAILURE.FAILED,
      why: response.timedOut ? 'the configured account service timed out' : 'the configured account service failed' });
    let result;
    try { result = JSON.parse(String(response.stdout || '').trim()); } catch { return failure({ why: 'the configured account service returned an invalid response' }); }
    return result?.ok ? { ok: true, data: result.data || {} } : failure(result);
  } catch (e) {
    return failure({ class: signal?.aborted ? contract.FAILURE.CANCELLED : contract.FAILURE.FAILED, why: e?.message });
  }
}

module.exports = { DOMAINS, OPS, configured, processEnvironment, failure, invoke };
