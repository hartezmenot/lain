'use strict';

/**
 * THE ENGINEERING SESSION'S HALF OF /api/state — cheap, polled, opens nothing.
 *
 * Reshapes what sessionstatus, sessionviews, planhandoff, modelinventory and
 * the Workshop's dev-server records already hold. Decides nothing, launches
 * nothing, contacts nothing. See state.js for the rules this shares.
 */

/** The session header: title, project path, status, clock, what can be done. */
function header(app, S = null) {
  const s = app.session;
  const st = require('../sessionstatus').of(app);
  // THE TITLE THE RAIL ALREADY COMPUTED — never a second serialization of the
  // session on every poll.
  const rows = S && S.sessions ? [...(S.sessions.engineering || []), ...(S.sessions.cowork || [])] : [];
  const row = rows.find((r) => r.id === s.id);
  const title = row ? row.title : '';
  const p = s.cowork ? null : require('../sessionviews').project(s);
  return {
    sessionId: s.id,
    title: title || (p && p.name) || 'New session',
    project: p ? { attached: p.attached, name: p.name, path: p.root, missing: p.missing } : null,
    status: st,
    canStop: st.state === 'RUNNING' || st.state === 'WAITING' || st.state === 'VERIFYING' || st.state === 'NEEDS_INPUT',
    // Only verbs a route exists for: POST /api/interrupt (canStop),
    // /api/session/close, /api/session/delete, /api/desktop/opencli.
    actions: ['close', 'delete', 'openCli'],
  };
}

/** Which panels a Coding view can open, and what each would show. */
function panels(app, S) {
  const sv = require('../sessionviews');
  const s = app.session;
  const v = sv.views(s);
  const proj = sv.project(s);
  const changes = (S && S.changes) || [];
  const plan = S && S.plan;
  const ws = S && S.workshop;
  const verification = S && S.harness && S.harness.verification;
  return {
    openPanel: v.panel.open,
    width: v.panel.width,
    file: v.panel.file,
    project: { attached: proj.attached, root: proj.root, name: proj.name, missing: proj.missing },
    pins: v.pins,
    panels: [
      { id: 'PROJECT_FILES', label: 'Project Files', available: true, badge: v.pins.length ? `${v.pins.length} pinned` : null, needsProject: !proj.attached },
      { id: 'CHANGES', label: 'Changes', available: changes.length > 0, badge: changes.length || null },
      { id: 'PLAN', label: 'Plan', available: Boolean(plan) || Boolean((s.planDocs || []).length), badge: plan ? `${plan.done}/${plan.total}` : null },
      { id: 'TERMINAL', label: 'Terminal', available: proj.attached, badge: null },
      { id: 'WORKSHOP', label: 'Workshop', available: Boolean(ws && ws.available) && proj.attached, badge: ws && ws.devServer ? ws.devServer.status : null },
      { id: 'VERIFICATION', label: 'Verification', available: Boolean(verification), badge: verification ? verification.verdict : null },
    ],
    actions: { open: 'POST /api/workspace/panel {action:"open", panel}', close: 'POST /api/workspace/panel {action:"close"}', toggle: 'POST /api/workspace/panel {action:"toggle", panel}' },
  };
}

/** Everything a Chat/Coding engineering session adds to the read model. */
function project(app, S) {
  const s = app.session;
  if (s.cowork) return { header: header(app, S), views: null, plans: null, composer: null, workspace: null, models: null };
  const sv = require('../sessionviews');
  const plans = require('../planhandoff').project(s);
  const draft = plans.draft ? plans.plans.find((p) => p.id === plans.draft) : null;
  const h = plans.handoff;
  return {
    header: header(app, S),
    views: {
      active: sv.views(s).active,
      available: ['chat', 'coding'],
      running: s.thread || null,
    },
    plans: {
      ...plans,
      // "Plan ready — Continue to Coding?" — asked for the newest DRAFT until
      // the person says Yes, Edit plan or Not yet.
      prompt: draft && !draft.deferredAt ? { planId: draft.id, title: draft.title, actions: ['accept', 'edit', 'defer'] } : null,
    },
    composer: {
      chat: { placeholder: 'Ask, discuss or plan…', canSend: true },
      coding: {
        placeholder: sv.project(s).attached ? 'Tell LAIN what to implement…' : 'Attach a project to start coding',
        canSend: sv.project(s).attached,
        // THE HANDOFF PREFILL — shown in the Coding composer, editable, sent
        // only when the person presses Enter.
        prefill: h && h.state === 'PREFILLED' ? { handoffId: h.id, planId: h.planId, text: h.prompt } : null,
      },
    },
    workspace: panels(app, S),
    models: require('../modelinventory').selections(app),
  };
}

/** The dev server record for this project, when one exists. Never starts one. */
function devServer(app) {
  try {
    const p = require('../sessionviews').project(app.session);
    if (!p.attached || p.missing) return null;
    const ws = app._workshop;
    return ws ? ws.devServers.get(p.root) : require('../workshop/devstate').blank(p.root);
  } catch { return null; }
}

module.exports = { project, header, panels, devServer };
