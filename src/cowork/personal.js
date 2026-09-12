'use strict';

const artifacts = require('./artifacts');
const contract = require('./contract');
const services = require('./services');

const DOMAINS = new Set(['calendar', 'contacts', 'reminders', 'notes']);
const ACTIONS = Object.freeze({
  calendar: new Set(['create', 'update', 'delete']), contacts: new Set(['create', 'update', 'delete']),
  reminders: new Set(['create', 'update', 'complete', 'delete']), notes: new Set(['create', 'update', 'delete']),
});
const FIELDS = Object.freeze({
  calendar: ['title', 'start', 'end', 'location', 'description', 'attendees'],
  contacts: ['name', 'emails', 'phones', 'organization', 'notes'],
  reminders: ['title', 'due', 'notes', 'completed'],
  notes: ['title', 'body', 'tags'],
});

function value(input, key) {
  const raw = input?.[key];
  if (Array.isArray(raw)) return raw.map(v => contract.safeText(v, 300)).filter(Boolean).slice(0, 50);
  if (typeof raw === 'boolean') return raw;
  return contract.safeText(raw, key === 'body' || key === 'description' || key === 'notes' ? 20_000 : 1000);
}
function cleanChange(domain, input = {}) {
  if (!DOMAINS.has(domain) || !ACTIONS[domain].has(input.action)) return { ok: false, class: contract.FAILURE.UNSUPPORTED, why: 'that personal-service action is not supported' };
  const id = contract.safeText(input.id, 200), data = {};
  for (const key of FIELDS[domain]) if (input[key] !== undefined) data[key] = value(input, key);
  if (input.action !== 'create' && !id) return { ok: false, class: contract.FAILURE.FAILED, why: `${input.action} requires an item id` };
  if (input.action === 'create' && !Object.values(data).some(v => Array.isArray(v) ? v.length : Boolean(v))) return { ok: false, class: contract.FAILURE.FAILED, why: 'create requires item details' };
  return { ok: true, action: input.action, payload: { ...(id ? { id } : {}), ...data } };
}
function preview(domain) {
  return (input, ctx) => {
    if (!services.configured(ctx.app, domain)) return { ok: false, class: contract.FAILURE.AUTH_REQUIRED, why: `no Cowork ${domain} service is configured` };
    const clean = cleanChange(domain, input); if (!clean.ok) return clean;
    const label = clean.payload.title || clean.payload.name || clean.payload.id || domain;
    return { what: `${clean.action} ${domain} item: ${contract.safeText(label, 160)}`,
      reason: `This will ${clean.action} data in the connected ${domain} account.`, details: JSON.stringify(clean.payload).slice(0, 1600) };
  };
}
function normalize(domain, data) {
  return (Array.isArray(data?.items) ? data.items : []).slice(0, 100).map(row => {
    const item = { id: contract.safeText(row?.id, 200) };
    for (const key of FIELDS[domain]) if (row?.[key] !== undefined) item[key] = value(row, key);
    return item;
  }).filter(row => row.id);
}
async function list(app, domain, input, signal) {
  if (!DOMAINS.has(domain)) return { ok: false, class: contract.FAILURE.UNSUPPORTED, why: 'that personal service is not supported' };
  const r = await services.invoke(app, domain, 'list', { query: contract.safeText(input.query, 1000), limit: Math.max(1, Math.min(Number(input.limit) || 50, 100)) }, { signal });
  if (!r.ok) return r;
  const items = normalize(domain, r.data); return { ok: true, output: items.length ? JSON.stringify({ items }) : `No matching ${domain} items.` };
}
async function change(app, domain, input, signal) {
  const clean = cleanChange(domain, input); if (!clean.ok) return clean;
  const r = await services.invoke(app, domain, clean.action, clean.payload, { signal }); if (!r.ok) return r;
  const receipt = artifacts.keep(app, { name: `${domain}-${clean.action}-receipt.json`, mime: 'application/json', body: Buffer.from(JSON.stringify({
    version: 1, kind: `${domain}-${clean.action}-receipt`, action: clean.action, id: contract.safeText(r.data?.id || clean.payload.id, 200),
    completedAt: contract.safeText(r.data?.completedAt, 100) || new Date().toISOString(),
  }, null, 2)), note: `External ${domain} ${clean.action} receipt` });
  return receipt ? { ok: true, artifact: receipt, output: `${domain[0].toUpperCase() + domain.slice(1)} ${clean.action} completed.\nReceipt ${receipt.ref} · ${receipt.name}` }
    : { ok: false, class: contract.FAILURE.INCONCLUSIVE, why: `the provider reported success but the ${domain} receipt could not be stored` };
}
function rendered(result) { return result.ok ? { output: result.output, ...(result.artifact ? { artifact: result.artifact } : {}), meta: { classification: 'DONE' } }
  : { output: `${result.class}: ${result.why}`, isError: true, meta: { classification: result.class } }; }

module.exports = { DOMAINS, ACTIONS, FIELDS, cleanChange, preview, normalize, list, change, rendered };
