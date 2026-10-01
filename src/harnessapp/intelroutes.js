'use strict';

/**
 * ACCOUNT FIRST, FOR THE WINDOW (Phase 8.2) — the routes every account and
 * model control draws from and writes through. They are sessionintel.js and
 * accountcatalog.js over HTTP; the CLI calls the same functions directly.
 *
 *   POST /api/intel/accounts   every account, grouped by family (no network)
 *   POST /api/intel/lanes      this session's { account, model } per lane
 *   POST /api/intel/choose     { lane, account?, model? } — passive, sends nothing
 *   POST /api/intel/models     { account, lane?, query? } — what that account offers
 *   POST /api/intel/rename     { id, name } — a display name for this person
 *   POST /api/intel/default    { id, model } — what choosing the account selects
 *   POST /api/intel/defaults   the global and project defaults per lane, with this session's pair
 */

const ok = (b = {}) => ({ code: 200, body: { ok: true, ...b } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why: String(why), ...extra } });

function save(app) { try { app.session.save(); } catch { /* the next save persists it */ } }

function grouped(app) {
  const A = require('../accountcatalog');
  const L = A.list(app);
  const groups = [];
  for (const a of L.accounts) {
    let g = groups.find((x) => x.family === a.family);
    if (!g) { g = { family: a.family, label: a.familyLabel, accounts: [] }; groups.push(g); }
    g.accounts.push(A.view(a));
  }
  return groups;
}

function lanes(app) {
  const si = require('../sessionintel');
  return { chat: si.lane(app, app.session, 'chat'), coding: si.lane(app, app.session, 'coding') };
}

/** One stored { account, model } pair, named the way the window names it. */
function pair(app, account, model) {
  const A = require('../accountcatalog');
  const a = account ? A.accountFor(app, account) : null;
  return { account: a ? a.id : (account || null), accountLabel: a ? A.label(a) : (account || ''), model: model || null, modelLabel: model ? A.modelLabel(app, a ? a.id : null, model) : '' };
}

const ROUTES = {
  'POST /api/intel/defaults': async (app) => {
    const cfg = ((app && app._sibling) || app).cfg || {};
    const si = require('../sessionintel');
    const out = {
      global: {
        chat: pair(app, (cfg.defaultChat && cfg.defaultChat.connection) || null, (cfg.defaultChat && cfg.defaultChat.model) || null),
        coding: pair(app, cfg.connection || null, cfg.model || null),
      },
      project: null,
      session: { chat: si.lane(app, app.session, 'chat'), coding: si.lane(app, app.session, 'coding') },
    };
    const sv = require('../sessionviews');
    const p = sv.project(app.session);
    if (p.attached && !p.missing) {
      const pid = require('../journey').projectId(app.session.cwd);
      const layer = (cfg.projects && cfg.projects[pid]) || {};
      out.project = { name: p.name, root: p.root, chat: pair(app, layer.bot && layer.bot.connection, layer.bot && layer.bot.model), coding: pair(app, layer.coding && layer.coding.connection, layer.coding && layer.coding.model) };
    }
    return ok(out);
  },
  'POST /api/intel/accounts': async (app) => {
    try { await app.ensureCatalog({ announce: false }); } catch { /* cached catalog */ }
    return ok({ groups: grouped(app), lanes: lanes(app) });
  },
  'POST /api/intel/lanes': async (app) => ok({ lanes: lanes(app) }),
  'POST /api/intel/choose': async (app, body = {}) => {
    const req = { lane: body.lane === 'chat' ? 'chat' : 'coding' };
    if (Object.prototype.hasOwnProperty.call(body, 'account')) req.account = body.account || null;
    if (Object.prototype.hasOwnProperty.call(body, 'model')) req.model = body.model || null;
    // PHASE 8.3: the provider FAMILY and the EFFORT are chosen here too (sessionintel.choose).
    if (Object.prototype.hasOwnProperty.call(body, 'family')) req.family = body.family || null;
    if (Object.prototype.hasOwnProperty.call(body, 'effort')) req.effort = body.effort == null ? 'auto' : String(body.effort);
    const r = await require('../sessionintel').choose(app, app.session, req);
    if (!r.ok) return bad(r.why, 409, { code: r.code || null, offering: r.offering || null });
    save(app);
    return ok({ lane: r.lane, needsModel: r.needsModel, lanes: lanes(app) });
  },
  'POST /api/intel/models': async (app, body = {}) => {
    const A = require('../accountcatalog');
    const acct = A.accountFor(app, body.account);
    if (!acct) return bad('choose an account first', 404);
    const which = body.lane === 'chat' ? 'chat' : body.lane === 'coding' ? 'coding' : null;
    const rows = A.models(app, acct.id, { query: body.query || '', limit: 2000 }).filter((m) => !which || (which === 'coding' ? m.coding : m.chat));
    const limit = Math.max(1, Math.min(500, Number(body.limit) || 200));
    return ok({ account: A.view(acct), models: rows.slice(0, limit), total: rows.length, defaultModel: A.defaultModel(app, acct.id) });
  },
  'POST /api/intel/rename': async (app, body = {}) => {
    const r = require('../accountcatalog').rename(app, String(body.id || ''), body.name);
    // THE FABRIC'S ALIAS (Phase 8.3) is what every surface shows — one registry for the CLI and the window.
    if (r.ok) { try { require('../fabric/store').setAlias(String(body.id || ''), body.name); } catch { /* the catalog name still stands */ } }
    return r.ok ? ok({ groups: grouped(app) }) : bad(r.why);
  },
  'POST /api/intel/default': async (app, body = {}) => {
    const r = require('../accountcatalog').setDefaultModel(app, String(body.id || ''), body.model ? String(body.model) : null);
    return r.ok ? ok({}) : bad(r.why);
  },
};

module.exports = { ROUTES };
