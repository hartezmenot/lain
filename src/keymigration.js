'use strict';

/** LEGACY KEYS — API keys still written in config.json as plain text, moved into the Windows secret store on the person's request. */

const crypto = require('crypto');

function root(app) { return (app && app._sibling) || app; }

function legacy(cfg) {
  const out = [];
  for (const [id, c] of Object.entries((cfg && cfg.connections) || {})) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.apiKey === 'string' && c.apiKey && !c.credentialRef) {
      out.push({ id, provider: c.provider || id, masked: require('./credentials').mask(c.apiKey) });
    }
  }
  return out;
}

function migrate(app, { only = null } = {}) {
  const r = root(app);
  const cfg = r.cfg;
  const creds = require('./credentials');
  const results = [];
  let changed = false;
  for (const row of legacy(cfg)) {
    if (only && row.id !== only) continue;
    const entry = cfg.connections[row.id];
    const secret = entry.apiKey;
    const ref = creds.ref(`${row.id}-${crypto.randomBytes(3).toString('hex')}`);
    const kept = creds.store(ref, secret, { kind: 'api_key' });
    if (!kept.ok) { results.push({ id: row.id, ok: false, why: kept.why || 'the secret store refused' }); continue; }
    // VERIFY before the config forgets the value: the stored bytes must read back identical.
    if (creds.resolve(ref) !== secret) { creds.remove(ref); results.push({ id: row.id, ok: false, why: 'the stored key did not read back identically; left in config' }); continue; }
    entry.credentialRef = ref;
    delete entry.apiKey;
    delete entry.plaintext;
    changed = true;
    results.push({ id: row.id, ok: true, masked: row.masked });
  }
  if (changed) require('./config').save(cfg);
  return { ok: results.every((x) => x.ok), migrated: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results, remaining: legacy(cfg).length };
}

module.exports = { legacy, migrate };
