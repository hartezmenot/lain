'use strict';

/**
 * API SOURCES — what the Model Dashboard's Add API and the terminal share.
 *
 * PHASE 8.3: THE TERMINAL NEVER TAKES A KEY. `/api`, `/api add`, `/api <provider>`
 * and `/api <route>` open the Model Dashboard at API (fabric/dashlaunch.js); a
 * key typed at the prompt anyway is refused, redacted and taken out of the input
 * history (routecommands.js). What stays here is shared by the window's Add API
 * (harnessapp/accountops.js): recognising what a word is (a route, a provider, a
 * credential), keeping a key in the OS secret store under a reference
 * (`store`), retiring the key it replaced (`retire`), and asking the provider
 * what it serves (`discoverModels`) — a catalog read, never a completion.
 */

const providers = require('./providers');
const connectionsMod = require('./connections');

/** The subcommands `/api` has always had. Anything else is a credential. */
const SUBCOMMANDS = new Set(['refresh', 'status', 'list', 'help']);

/**
 * The row that means "LAIN does not know this one — I will say where it goes".
 *
 * A NAMED CONSTANT, and it was briefly a raw NUL byte written into the source
 * by a patch script — invisible corruption of exactly the kind the control-byte
 * guard exists for, and it was caught by it on the next run. A sentinel has to
 * be readable in the file it lives in.
 */
const OTHER = '__other__';

/** Said whenever the flow stops without storing anything. */
const CANCELLED = '  Cancelled. Nothing was stored.' + String.fromCharCode(10);

/**
 * Is this argument a credential rather than a subcommand?
 *
 * DELIBERATELY NOT A KEY-SHAPE PATTERN. Every provider spells its keys
 * differently and a new one would be refused by a regex written before it
 * existed — the same failure as a hardcoded provider list, one level down. The
 * only thing LAIN actually knows is which words are its OWN subcommands;
 * everything else is the user handing it something.
 */
function looksLikeCredential(arg, cfg = {}) {
  const s = String(arg || '').trim();
  if (!s || SUBCOMMANDS.has(s.toLowerCase())) return false;
  // ---- A PROVIDER'S NAME IS NOT A PROVIDER'S KEY ------------------------
  //
  // `/api openrouter` is somebody asking about a route, and `openrouter` is
  // ten characters with no spaces — so the length test alone would have stored
  // the WORD as that route's credential and reported success. A stored
  // credential that is a provider name is worse than a rejected command: the
  // route then fails to authenticate for a reason nothing on screen explains.
  //
  // Every name a picker would offer is excluded, which is the same list the
  // picker itself is built from — so this cannot drift out of step with it.
  const name = s.toLowerCase();
  if (providers.choices(cfg).some((p) => String(p.id).toLowerCase() === name)) return false;
  // ---- NOR IS A CONNECTION ID, AND THAT HALF WAS MISSING ----------------
  //
  // `connectionByName` accepts three spellings of one route — `custom`,
  // `lain:custom`, and the provider name — but this only excluded the bare
  // one, because it is the only spelling `providers.choices` lists.
  //
  // So `/api lain:custom` typed before that connection exists (a typo, a
  // route since removed, or simply doing it in the wrong order) fell through
  // to the length test: eleven characters, no spaces, therefore a credential.
  // The literal string `lain:custom` was stored as an API key, and the route
  // then failed to authenticate for a reason nothing on screen explained —
  // the exact failure the paragraph above this one describes, arrived at
  // through the prefix instead of the name.
  //
  // `lain:` is LAIN's own namespace for "a key we hold" (see connectionIdFor).
  // Nothing a provider issues is spelled that way, so a word wearing that
  // prefix is always a route being named and never a secret being handed over.
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
  try { new URL(s); } catch { return 'that is not a URL Noema can parse'; }
  return null;
}

/**
 * STORE THE CREDENTIAL, under the existing connection model.
 *
 * `lain:<provider>` says WHO HOLDS THE KEY, which is the distinction
 * connections.js is built around. An existing entry for the same provider is
 * UPDATED rather than duplicated — re-keying a route that already works is the
 * commonest reason to run this a second time.
 */
function store(app, config, { provider, protocol, baseUrl, credential, connectionId, retireOld = false }) {
  const cfg = app.cfg;
  // ---- HELD BACK FROM EVERY SCREEN, BEFORE IT IS WRITTEN ANYWHERE --------
  //
  // From here on the exact bytes are known, so src/redact.js can keep them off
  // every display surface - the activity feed, an error message, `/provider
  // status`, the dashboard, a copied transcript. And `/api sk-...` typed at the
  // prompt was remembered by the input history BEFORE anything knew what it
  // was, so that entry is taken back out: the up-arrow must not return a
  // plain-text key.
  const redact = require('./redact');
  redact.register(credential);
  redact.scrubHistory(app.input);
  if (!cfg.connections || typeof cfg.connections !== 'object') cfg.connections = {};
  const id = connectionId || providers.connectionIdFor(provider);
  const existing = cfg.connections[id] || {};
  // ---- THE KEY GOES TO THE OS STORE; CONFIG KEEPS ITS NAME --------------
  //
  // A fresh reference per store, so a failed proof can put the previous one
  // back untouched (accountops.addKey) and a working one retires the old blob
  // (`retire`). Where no OS store exists the old plaintext field is the only
  // place left, and the entry says so (`plaintext`) for the window to warn.
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

/**
 * WHAT THE ROUTE SERVES — asked once, immediately.
 *
 * A catalog request (`GET /models`), never a model round-trip: no tokens are
 * spent and no completion is generated. This is the step that makes typing a
 * model id unnecessary, and it is also the first real proof the credential
 * works — which is why its failure is reported in the provider's own words
 * rather than as "something went wrong".
 */
async function discoverModels(app, connectionId) {
  const conn = (app.connections() || []).find((c) => c.id === connectionId);
  if (!conn) return { ok: false, error: 'the connection was saved but cannot be read back' };
  try {
    // ---- `discover` RETURNS A RESULT, NOT A LIST -------------------------
    //
    // THE DEFECT THIS FIXES, and it made the happy path unreachable. This read
    //
    //     const models = await connectionsMod.discover(conn);
    //     if (!models || !models.length) return { error: 'listed no models' };
    //
    // `discover` answers `{ ok, count, models, url }`. An object has no
    // `length`, so `!models.length` was ALWAYS true and `/api` reported "the
    // provider answered, but listed no models" for every successful discovery
    // in existence — then wrote the result object into the catalog cache in
    // place of the array. The credential was stored and the flow stopped one
    // step before the model picker, which is the step it exists for.
    //
    // It survived because the only verification anyone had run used a FAKE
    // credential, which fails earlier and never reaches this line. A failure
    // path proved correct is not a happy path proved correct.
    //
    // `discover` also writes the cache itself, keyed on the connection and
    // stamped with the URL it actually read — so the second write here was a
    // worse copy of one that had already happened.
    const r = await connectionsMod.discover(conn);
    if (!r || !r.ok) {
      // THE PROVIDER'S OWN WORDS, here: this is the person checking a credential
      // they just entered. `discover` keeps the body off its one-line `error`
      // (see catalogstate.js — the `/model` path), so it is added back.
      const said = r && r.raw ? ` — ${String(r.raw).replace(/\s+/g, ' ').slice(0, 200)}` : '';
      return { ok: false, error: r && r.error ? `${r.error}${said}` : 'the provider answered, but listed no models' };
    }
    return { ok: true, models: r.models, url: r.url };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * THE ROUTE THIS NAME NAMES — exact connection id first, then the bare provider.
 *
 * `lain:custom` and `custom` are the same route, and a person should not have
 * to know which spelling the config uses. Bridges are deliberately NOT matched
 * by provider: a bridge authenticates upstream itself, so LAIN holds no
 * credential for it and there is nothing here to replace — the same exclusion
 * `providers.choices()` applies when offering rows.
 *
 * @param {object} app  anything with `connections()`, as commands receive it
 * @returns {object|null} the connection, or null when the name names nothing
 */
/**
 * IS THIS WORD THE NAME OF A PROVIDER `/api` COULD ADD?
 *
 * Read from `providers.choices` — the same list the picker is built from — so
 * a word that would appear in that menu is a word `/api <word>` can act on.
 * Kept beside `connectionByName` because the two answer the two halves of one
 * question: does this route exist yet, and could it.
 */
function providerNamed(app, name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  // THE `lain:` PREFIX IS STRIPPED HERE TOO, mirroring `connectionByName`.
  // Somebody typing `/api lain:custom` for a route that does not exist yet is
  // asking for that route — offering to add it is the answer to what they
  // typed, where showing them the routes they already have was not.
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
  // `/api custom` IS `/api lain:custom`: the `lain:` prefix says WHO HOLDS THE
  // KEY (see connectionIdFor), not part of the name a person has to type. The
  // bare spelling, the full id, and the provider name all reach one route.
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
