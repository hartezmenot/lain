'use strict';

/** API SOURCES — what the Model Dashboard's Add API and the terminal share. */

const providers = require('./providers');
const connectionsMod = require('./connections');

/** The subcommands `/api` has always had. Anything else is a credential. */
const SUBCOMMANDS = new Set(['refresh', 'status', 'list', 'help']);

/** The row that means "LAIN does not know this one — I will say where it goes". */
const OTHER = '__other__';

/** Said whenever the flow stops without storing anything. */
const CANCELLED = '  Cancelled. Nothing was stored.' + String.fromCharCode(10);

/** Is this argument a credential rather than a subcommand? */
function looksLikeCredential(arg, cfg = {}) {
  const s = String(arg || '').trim();
  if (!s || SUBCOMMANDS.has(s.toLowerCase())) return false;
  // A PROVIDER'S NAME IS NOT A PROVIDER'S KEY
  const name = s.toLowerCase();
  if (providers.choices(cfg).some((p) => String(p.id).toLowerCase() === name)) return false;
  // NOR IS A CONNECTION ID, AND THAT HALF WAS MISSING
  if (name.startsWith('lain:')) return false;
  // A credential has no spaces. A mistyped subcommand is caught by the same
  // test, and gets told what the subcommands are rather than being stored.
  return !/\s/.test(s) && s.length >= 8;
}

/** `sk-…9f2a` — enough to recognise, not enough to use. */
function shapeOf(cred) {
  const s = String(cred || '');
  if (s.length <= 10) return '…';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** Only somewhere a credential can safely be sent. */
function validBaseUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return 'a base URL must start with http:// or https://';
  try { new URL(s); } catch { return 'that is not a URL LAIN can parse'; }
  return null;
}

/** STORE THE CREDENTIAL, under the existing connection model. */
function store(app, config, { provider, protocol, baseUrl, credential, connectionId, retireOld = false }) {
  const cfg = app.cfg;
  // HELD BACK FROM EVERY SCREEN, BEFORE IT IS WRITTEN ANYWHERE
  const redact = require('./redact');
  redact.register(credential);
  redact.scrubHistory(app.input);
  if (!cfg.connections || typeof cfg.connections !== 'object') cfg.connections = {};
  const id = connectionId || providers.connectionIdFor(provider);
  const existing = cfg.connections[id] || {};
  // THE KEY GOES TO THE OS STORE; CONFIG KEEPS ITS NAME
  const creds = require('./credentials');
  const nextRef = creds.ref(`${id}-${require('crypto').randomBytes(3).toString('hex')}`);
  const kept = creds.store(nextRef, credential, { kind: 'api_key' });
  const entry = {
    ...existing,
    provider,
    via: 'native',
    auth: 'api_key',
    protocol: protocol || existing.protocol || 'chat',
    baseUrl: baseUrl || existing.baseUrl || '',
  };
  if (kept.ok) { entry.credentialRef = nextRef; delete entry.apiKey; delete entry.plaintext; }
  else { entry.apiKey = credential; entry.plaintext = true; delete entry.credentialRef; }
  cfg.connections[id] = entry;
  config.save(cfg);
  // The terminal flows keep a new key even when discovery fails (the network may
  // be what is wrong), so the one it replaced goes now.
  if (retireOld) retire(existing, entry);
  return id;
}

/** After a stored key proved itself: the blob it replaced is deleted. */
function retire(previous, current) {
  const was = previous && previous.credentialRef;
  if (was && (!current || current.credentialRef !== was)) require('./credentials').remove(was);
}

/** WHAT THE ROUTE SERVES — asked once, immediately. */
async function discoverModels(app, connectionId) {
  const conn = (app.connections() || []).find((c) => c.id === connectionId);
  if (!conn) return { ok: false, error: 'the connection was saved but cannot be read back' };
  try {
    // `discover` RETURNS A RESULT, NOT A LIST
    const r = await connectionsMod.discover(conn);
    if (!r || !r.ok) {
      // THE PROVIDER'S OWN WORDS, here: this is the person checking a credential they just entered.
      const said = r && r.raw ? ` — ${String(r.raw).replace(/\s+/g, ' ').slice(0, 200)}` : '';
      return { ok: false, error: r && r.error ? `${r.error}${said}` : 'the provider answered, but listed no models' };
    }
    return { ok: true, models: r.models, url: r.url };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** THE ROUTE THIS NAME NAMES — exact connection id first, then the bare provider. */
/** IS THIS WORD THE NAME OF A PROVIDER `/api` COULD ADD? */
function providerNamed(app, name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  // THE `lain:` PREFIX IS STRIPPED HERE TOO, mirroring `connectionByName`.
  const want = raw.startsWith('lain:') ? raw.slice('lain:'.length) : raw;
  return providers.choices((app && app.cfg) || {})
    .find((p) => String(p.id).toLowerCase() === want) || null;
}

function connectionByName(app, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const conns = app.connections() || [];
  const byId = conns.find((c) => String(c.id || '').toLowerCase() === want);
  if (byId) return byId;
  // `/api custom` IS `/api lain:custom`: the `lain:` prefix says WHO HOLDS THE KEY (see connectionIdFor), not part of the name a person has to type.
  const bare = want.startsWith('lain:') ? want.slice('lain:'.length) : want;
  return conns.find((c) => c.via !== 'bridge'
    && (String(c.id || '').toLowerCase() === `lain:${bare}`
      || String(c.provider || '').toLowerCase() === bare)) || null;
}

module.exports = {
  retire,
  providerNamed,
  connectionByName, looksLikeCredential, shapeOf, validBaseUrl, SUBCOMMANDS,
  // The window's Add API key (harnessapp/accountops.js) is the same two steps.
  store, discoverModels,
};
