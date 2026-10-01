'use strict';

/**
 * GITHUB ROUTES — GitHub as a source of LAIN projects (github.js).
 *
 *   /api/github/status        connected? via gh / device / token, and as whom
 *   /api/github/repos         repositories this identity may see, with local state
 *   /api/github/connect-token a fine-grained token → DPAPI (never echoed)
 *   /api/github/disconnect
 *   /api/github/assign        bind the session to owner/repo; attaches at once when
 *                             a local clone exists, else Coding stays disabled
 *                             until "Clone project"
 *   /api/github/clone         clone → register → (attach to this session)
 *   /api/github/project       the attached project's git/GitHub state
 *   /api/github/action        pull · branch · commit · push · pr-create · pr-view ·
 *                             issue-view · issue-create — writes need `confirm`
 *
 * SEVERAL ACCOUNTS (github.js): every identity LAIN may act as, LAIN's active one,
 * and the account each repository belongs to. Never a token in an answer.
 *   /api/github/accounts      the list (and the active one)
 *   /api/github/switch        LAIN's active account — gh's own is untouched
 *   /api/github/rename        a name for one account, shown instead of the login
 *   /api/github/disconnect    forget ONE account ({id}; the active one if none)
 *   /api/github/restore       show a hidden GitHub CLI account again
 *   /api/github/device/start  GitHub's device flow (the person's own OAuth App) —
 *   /api/github/device/poll   scopes chosen explicitly: read · public · private
 *   /api/github/bind          the account a repository's writes go out as
 */

const gh = require('../github');
const sv = require('../sessionviews');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
function save(app) { try { app.session.save(); } catch { /* in memory */ } }

async function attach(app, dir) {
  return require('./viewroutes').ROUTES['POST /api/project/attach'](app, { path: dir });
}

const ROUTES = {
  'POST /api/github/status': async (app) => ok({ github: gh.status(app) }),
  'POST /api/github/repos': async (app, body = {}) => {
    try { const r = await gh.repos(app, { limit: Number(body.limit) || 100 }); return r.ok ? ok(r) : bad(r.why, 409, { status: r.status }); } catch (e) { return bad(e.message, 502); }
  },
  'POST /api/github/connect-token': async (app, body = {}) => {
    const r = await gh.connectToken(app, body.token);
    return r.ok ? ok({ github: r.status }) : bad(r.why);
  },
  'POST /api/github/disconnect': async (app, body = {}) => {
    const r = gh.disconnect(app, body.id ? String(body.id) : null);
    return r.ok ? ok(r) : bad(r.why, 404);
  },
  'POST /api/github/accounts': async (app, body = {}) => {
    if (body.refresh) gh.forgetGhMemo();
    const st = gh.status(app);
    return ok({ accounts: st.accounts || [], active: st.active || null, github: st });
  },
  'POST /api/github/switch': async (app, body = {}) => {
    const r = gh.switchAccount(app, String(body.id || ''));
    return r.ok ? ok({ github: r.status }) : bad(r.why, 404);
  },
  'POST /api/github/rename': async (app, body = {}) => {
    const r = gh.rename(app, String(body.id || ''), body.name);
    return r.ok ? ok({ github: r.status }) : bad(r.why, 404);
  },
  'POST /api/github/restore': async (app, body = {}) => {
    const r = gh.restore(app, String(body.id || ''));
    return r.ok ? ok({ github: r.status }) : bad(r.why, 404);
  },
  'POST /api/github/device/start': async (app, body = {}) => {
    try { const r = await gh.deviceStart(app, { access: String(body.access || 'read') }); return r.ok ? ok(r) : bad(r.why, 409); } catch (e) { return bad(e.message, 502); }
  },
  'POST /api/github/device/poll': async (app, body = {}) => {
    try { const r = await gh.devicePoll(app, String(body.handle || '')); return r.ok ? ok(r) : bad(r.why, 409); } catch (e) { return bad(e.message, 502); }
  },
  'POST /api/github/client': async (app, body = {}) => {
    const r = gh.setClientId(app, body.clientId);
    return r.ok ? ok({ github: r.status }) : bad(r.why);
  },
  'POST /api/github/bind': async (app, body = {}) => {
    const full = String(body.fullName || sv.views(app.session).project.github || '');
    const r = gh.bind(app, full, body.id ? String(body.id) : null);
    return r.ok ? ok(r) : bad(r.why, 409);
  },

  'POST /api/github/assign': async (app, body = {}) => {
    const full = String(body.fullName || '');
    if (!gh.REPO_RE.test(full)) return bad('name the repository as owner/repo');
    const local = gh.localClones(app).get(full.toLowerCase());
    const v = sv.views(app.session);
    v.project.github = full;
    if (local) {
      const r = await attach(app, local);
      // AN EXISTING CLONE opened for the first time belongs to the account that opened it.
      if (r.body.ok && !gh.accountFor(app, full).bound) gh.bind(app, full, null);
      save(app);
      return r.body.ok ? ok({ project: r.body.project, github: full, local, cloned: true }) : r;
    }
    save(app);
    return ok({ github: full, local: null, cloned: false, why: 'This GitHub project must be cloned locally before Coding Agent can edit it.' });
  },

  'POST /api/github/clone': async (app, body = {}) => {
    const full = String(body.fullName || sv.views(app.session).project.github || '');
    const r = gh.clone(app, full, { dir: body.dir || null });
    if (!r.ok) return bad(r.why, 409);
    let project = null;
    if (body.attach !== false) {
      sv.views(app.session).project.github = full;
      const a = await attach(app, r.dir);
      if (!a.body.ok) return ok({ ...r, attached: false, why: a.body.why });
      project = a.body.project;
    }
    save(app);
    return ok({ ...r, attached: Boolean(project), project });
  },

  'POST /api/github/project': async (app) => {
    const p = sv.project(app.session);
    if (!p.attached) return ok({ project: p, git: null, github: sv.views(app.session).project.github || null });
    return ok({ project: p, git: gh.projectStatus(p.root), github: gh.remoteOf(p.root) });
  },

  'POST /api/github/action': async (app, body = {}) => {
    const p = sv.project(app.session);
    if (!p.attached) return bad('attach a project first', 409);
    try {
      const r = await gh.action(app, p.root, String(body.kind || ''), body.args || {}, { confirm: body.confirm === true });
      return r.ok ? ok(r) : bad(r.why, r.needsConfirm ? 428 : 409, { needsConfirm: Boolean(r.needsConfirm) });
    } catch (e) { return bad(e.message, 502); }
  },
};

module.exports = { ROUTES };
