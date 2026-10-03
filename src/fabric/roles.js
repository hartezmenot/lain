'use strict';

/**
 * ROLE DEFAULTS, RESOLVED (Phase 8.3) — the Model Dashboard's Defaults tab
 * (Chat · Assistant · Coding · Research · Vision · Auxiliary) as routes a
 * request can take: provider family › logical model › effort, with the backing
 * account chosen by the default's policy (or the family's). A backing account
 * appears in a default only when it is pinned.
 *
 * Chat and Coding are the session lanes' global layer (sessionintel.globalOf).
 * The other roles are read here by the Core paths that run them: the
 * Assistant's scheduled model tasks today (assistant/actions.js).
 */

function root(app) { return (app && app._sibling) || app; }

/** { model (catalog id), connection (route), account, family, effort } — or null when the role has no usable default. */
function routeFor(app, role) {
  const store = require('./store');
  const d = store.roleDefault(role);
  if (!d || !d.family || !d.model) return null;
  const idx = require('./index');
  const f = idx.family(app, d.family);
  const m = f && f.byModel.get(d.model);
  if (!m) return null;
  const effort = d.effort && m.efforts.includes(d.effort) ? d.effort : null;
  const r = require('./policy').resolve(app, { family: f.id, model: m.id, effort, policy: d.policy || null, pinned: d.pinned || null });
  if (!r.ok) return null;
  const x = m.accounts.find((a) => a.id === r.account.id);
  if (!x) return null;
  return { model: x.catalogId, connection: x.route, account: r.account.id, family: f.id, effort, execution: d.execution || null };
}

/** The route for a role, else the session's Chat lane — never a model name that resolves through its first route. */
function routeOrChat(app, role) {
  const byRole = routeFor(app, role);
  if (byRole) return byRole;
  const r = root(app);
  try {
    const rc = require('../sessionintel').routeCfg(r, r.session, 'chat');
    if (rc.ok) return { model: rc.model, connection: rc.connection, account: rc.account, family: rc.family, effort: rc.effort || null };
  } catch { /* no lane */ }
  return null;
}

module.exports = { routeFor, routeOrChat };
