'use strict';

/** THE JOURNEY'S ROUTES — the window onto the session journey and its neighbours */

const sv = require('../sessionviews');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function reply(r) { return r && r.ok !== false ? ok(r) : { code: 200, body: { ok: false, ...(r || {}), why: String((r && r.why) || 'refused') } }; }
function root(app) {
  try { const p = sv.project(app.session); return p.attached && !p.missing ? app.session.cwd : null; } catch { return null; }
}
function noProject() { return { code: 409, body: { ok: false, why: 'no project is attached', projectRequired: true } }; }

const ROUTES = {
  /** The window says which room it is in. Navigation, recorded once per change. */
  'POST /api/journey/surface': (app, body = {}) => reply(require('../journey').surface(app, { surface: body.surface, pane: body.pane })),


  'POST /api/house/run': async (app, body = {}) => reply(await require('../house').run(app, body.id, body.args || {})),

  /** Provenance: which source wrote which lines of one file, as it stands now. */
  'POST /api/provenance/file': (app, body = {}) => {
    const r = root(app);
    if (!r) return noProject();
    const ledger = require('../editledger');
    const rel = String(body.path || '');
    return ok({ ...ledger.regions(r, rel), history: ledger.entries(r, { rel: rel.replace(/\\/g, '/'), limit: 20 }).reverse() });
  },
  /** Provenance: "what did I change?" / "what did LAIN change?". */
  'POST /api/provenance/summary': (app, body = {}) => {
    const r = root(app);
    if (!r) return noProject();
    const ledger = require('../editledger');
    const source = body.source ? String(body.source).toUpperCase() : null;
    const since = Number(body.since) || null;
    const sum = ledger.summary(r, { source, since, sessionId: body.session === 'this' ? app.session.id : null });
    const rows = ledger.entries(r, { source, since, limit: 60 }).reverse()
      .map((e) => ({ at: e.at, source: e.source, path: e.path, added: e.added, removed: e.removed, taskId: e.taskId, linesUnknown: Boolean(e.linesUnknown), first: e.hunks && e.hunks[0] ? e.hunks[0][0] : null }));
    return ok({ counts: sum.counts, text: sum.text, rows });
  },

  /** What the Coding Agent would be handed for this request — computed, not sent. */
  'POST /api/focus/packet': async (app, body = {}) => {
    const r = root(app);
    if (!r) return noProject();
    const pk = await require('../focuspacket').build(app, app.session, { task: String(body.task || '').slice(0, 2000) });
    return ok({ text: pk ? pk.text : '', metrics: pk ? pk.metrics : null, relevant: pk ? pk.relevant : [] });
  },
  /** The last packets' counts — the evidence that /focus sends less. */
  'POST /api/focus/metrics': (app) => ok({
    metrics: (app.session && app.session._focusMetrics) || [],
    // THE ADDRESSABLE EVIDENCE (evidencerefs.js) without bodies, and how the
    // canonical Selection was served (cache hit / carried forward / resolved).
    evidence: require('../evidencerefs').view(app.session),
    selection: require('../harnesscontext').selectionStats(app.session),
  }),
};

const QUIET = [
  'POST /api/journey/surface', 'POST /api/house/list',
  'POST /api/provenance/file', 'POST /api/provenance/summary', 'POST /api/focus/packet', 'POST /api/focus/metrics',
];

module.exports = { ROUTES, QUIET };
