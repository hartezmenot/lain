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
};

module.exports = { ROUTES };
