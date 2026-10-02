'use strict';

/**
 * CHAT SUPERVISES THE CODING AGENT — the window's half of supervision.js.
 *
 *   L.work.items(S, lane)   what a lane's stream shows besides messages, each
 *                           with a time so it interleaves with the conversation:
 *                           your notes while the Agent worked and LAIN's answer,
 *                           LAIN's questions (plan first? steer now? continue?),
 *                           checkpoints and findings. Compact: a thin accent edge
 *                           and a few lines — never a dashboard in the chat.
 *   L.work.runPanel(host)   the task panel beside the full Coding Chat: where the
 *                           work stands, the one next action, details on demand
 *   L.work.taskStrip(host)  the same state as a small strip (the IDE sidecar)
 *   L.work.projectMenu(a)   bind THIS session to a folder (never a copy)
 *
 * WHAT A PAUSE MEANS IS CORE'S (turnoutcome.js, autocontinue.js): a task pauses
 * for a decision, a quota limit, an explicit pause, or its execution host
 * closing — never because one model turn ended. An automatic continuation and
 * its cause are shown as what they are.
 *
 * Every button answers through Core (POST /api/workbench/*); nothing here
 * decides anything or keeps its own copy.
 */

const CSS = `
/* ---- supervision in the stream: compact, flat, a thin edge in its tone ------------------------------------ */
.wcard{margin:0 0 18px;background:var(--surface-base);border-radius:var(--radius-md);padding:12px 14px;box-shadow:inset 2px 0 0 var(--border-subtle)}
.wcard .wk{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted)}
.wcard .wk .tag{text-transform:none;letter-spacing:0}
.wcard .wt{font:600 13.5px/1.4 var(--sans);margin:0 0 2px;color:var(--text-primary)}
.wcard .wb{color:var(--text-secondary);font-size:13px;line-height:1.5;white-space:pre-wrap;margin-top:4px}
.wcard .wacts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.wcard.offer{box-shadow:inset 2px 0 0 var(--accent-primary)}
.wcard.sup{box-shadow:inset 2px 0 0 var(--accent-secondary)}
.wcard.warn{box-shadow:inset 2px 0 0 var(--warning)}
.wcard.hot{box-shadow:inset 2px 0 0 var(--danger)}
.wcard.auto{box-shadow:inset 2px 0 0 var(--accent-tertiary)}
.wcard .wl{margin:4px 0 0;padding:0;list-style:none}
.wcard .wl li{display:flex;gap:8px;padding:3px 0;font-size:13px;color:var(--text-primary)}
.wcard .wl .mk{flex:none;width:14px;color:var(--text-muted)}
.wcard .wl .mk.ok{color:var(--positive)} .wcard .wl .mk.bad{color:var(--danger)} .wcard .wl .mk.warn{color:var(--warning)}
.wcard .wsec{font-size:11px;font-weight:600;color:var(--text-muted);margin:8px 0 0}
.wcard details summary{cursor:pointer;font-size:12px;color:var(--text-secondary);margin-top:6px;list-style:none}
.wcard details summary::-webkit-details-marker{display:none}
.wcard details summary::before{content:'\\25B8  '}
.wcard details[open] summary::before{content:'\\25BE  '}
.wnote-you{margin:0 0 6px auto;max-width:min(85%,640px);background:var(--surface-raised);border-radius:var(--radius-lg);padding:8px 13px;font-size:14px}
.wnote-you .tag{margin-left:8px}
.wnote-lain{margin:0 0 18px;color:var(--text-secondary);font-size:13.5px;white-space:pre-wrap}
.bp-convo .wcard{margin:10px 0;padding:10px 12px}
.bp-convo .wcard .wt{font-size:13px}
.bp-convo .wcard .wl li,.bp-convo .wcard .wb{font-size:12.5px}

/* ---- the task panel (full Coding Chat, wide windows) -------------------------------------------------------- */
.runpanel{display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;padding:16px 16px 16px 0}
.rp-block{background:var(--surface-base);border-radius:var(--radius-md);padding:12px 14px}
.rp-head{display:flex;align-items:center;gap:8px}
.rp-head .rp-t{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
.rp-sumblock .rp-proj{margin-top:6px;font-size:12.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-sumblock .rp-now{margin-top:6px;font-size:13.5px;line-height:1.45;color:var(--text-primary);overflow-wrap:anywhere}
.rp-sumblock .rp-facts2{margin-top:6px;font-size:12px;color:var(--text-muted)}
.rp-sumblock .rp-auto{margin-top:8px;padding-top:8px;border-top:1px solid var(--separator);font-size:12px;color:var(--text-secondary)}
.rp-row{display:flex;gap:6px;flex-wrap:wrap}
.rp-more{align-self:flex-start;font-size:12.5px;color:var(--text-secondary);padding:3px 6px;border-radius:var(--radius-sm)}
.rp-more:hover{color:var(--text-primary);background:var(--hover)}
.rp-go{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border-radius:var(--radius-md);background:var(--accent-primary);color:var(--on-accent);text-align:left}
.rp-go b{display:block;font-size:13.5px} .rp-go span{display:block;font-size:12px;opacity:.8}
.rp-go:disabled{background:var(--surface-raised);color:var(--text-muted)}
.rp-steps{margin:8px 0 0;padding:0;list-style:none}
.rp-steps li{display:flex;gap:10px;align-items:flex-start;padding:4px 0;font-size:12.5px;color:var(--text-primary)}
.rp-steps .tx{flex:1;min-width:0;overflow-wrap:anywhere}
.rp-steps .mk{flex:none;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;font-size:10px;box-shadow:inset 0 0 0 1.5px var(--border-subtle);color:var(--text-muted);margin-top:1px}
.rp-steps .mk.done{background:var(--positive);box-shadow:none;color:var(--canvas)}
.rp-steps .mk.active{box-shadow:inset 0 0 0 1.5px var(--accent-primary);color:var(--accent-primary)}
.rp-steps .mk.bad{background:var(--danger);box-shadow:none;color:#fff}
.rp-cfg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px}
.rp-cfg button{display:flex;align-items:center;gap:8px;text-align:left;padding:7px 8px;border-radius:var(--radius-sm);background:var(--surface-raised);min-width:0}
.rp-cfg button:hover{background:var(--surface-active)}
.rp-cfg b{display:block;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-cfg span{display:block;color:var(--text-muted);font-size:11px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;

  function W() { var S = L.state(); return (S && S.workbench) || null; }
  function btn(label, cls, fn) { var b = el('button', 'u-btn sm' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }

  async function answer(offer, choice) {
    var r = await L.api('/api/workbench/answer', { id: offer.id, choice: choice });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not answer', true); return r; }
    if (r.projectRequired) projectMenu(null, { reason: r.why });
    if (choice === 'discuss' || (offer.kind === 'PLAN_FIRST' && choice === 'plan')) L.chat.lane('chat');
    if (r.focusFinding) { var n = document.getElementById('wf-' + r.focusFinding); if (n) n.scrollIntoView({ block: 'center' }); }
    L.poll();
    return r;
  }
  async function finding(f, action, text) {
    var r = await L.api('/api/workbench/finding', { id: f.id, action: action, text: text || undefined });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not do that', true); return; }
    if (action === 'discuss') { L.chat.lane('chat'); var a = document.getElementById('ask'); if (a && !a.value) { a.value = 'Let’s discuss the Agent’s finding: ' + f.summary; a.focus(); } }
    L.poll();
  }
  async function continueTask() {
    var r = await L.api('/api/workbench/continue', {});
    if (r && r.ok === false) L.toast(r.why, true);
    L.poll();
  }

  var CHOICE_LABEL = {
    plan: 'Plan in Chat first', direct: 'Implement directly', now: 'Steer now', wait: 'Wait for checkpoint', send: 'Send to Agent',
    discuss: 'Discuss', drop: 'Drop', add: 'Add to plan', later: 'Leave for later', 'continue': 'Continue', review: 'Review problem',
    pause: 'Pause', fast: 'Switch to Fast', keep: 'Keep current', eco: 'Use Eco', cancel: 'Cancel',
  };
  var PRIMARY = { plan: 1, now: 1, send: 1, add: 1, 'continue': 1, fast: 1 };
  var OFFER_KICKER = { PLAN_FIRST: 'Before implementing', URGENT_STEER: 'Steer the Agent', PENDING_STEERS: 'Pending steers', PLAN_DELTA: 'Scope found by the Agent', PHASE_REVIEW: 'Checkpoint', FAST_OFFER: 'Faster finish', LONG_CONTEXT_WARNING: 'Long Context Phasing' };

  function offerCard(o) {
    var c = el('div', 'wcard offer' + (o.kind === 'URGENT_STEER' || o.kind === 'LONG_CONTEXT_WARNING' ? ' warn' : ''));
    c.appendChild(el('div', 'wk', OFFER_KICKER[o.kind] || 'LAIN asks'));
    c.appendChild(el('div', 'wt', o.text || ''));
    if (o.kind === 'PLAN_FIRST' && o.request) c.appendChild(el('div', 'wb', o.request.length > 400 ? o.request.slice(0, 400) + '…' : o.request));
    if (o.kind === 'URGENT_STEER') c.appendChild(el('div', 'wb', '“' + o.steer + '”'));
    if (o.kind === 'PENDING_STEERS') { var ul = el('ul', 'wl'); (o.steers || []).forEach(function (s) { var li = el('li'); li.appendChild(el('span', 'mk', '•')); li.appendChild(el('span', '', s.text)); ul.appendChild(li); }); c.appendChild(ul); }
    if (o.kind === 'LONG_CONTEXT_WARNING' && o.estimate) c.appendChild(el('div', 'wb', o.estimate.text + (o.estimate.basis ? '\n' + o.estimate.basis : '')));
    var acts = el('div', 'wacts');
    (o.choices || []).forEach(function (ch) { acts.appendChild(btn(CHOICE_LABEL[ch] || ch, PRIMARY[ch] ? 'pri' : 'ghost', function () { answer(o, ch); })); });
    c.appendChild(acts);
    return c;
  }

  /** A CHECKPOINT: what landed, found, failed or was recovered from; what is next; and what LAIN did about it. */
  function phaseCard(p) {
    var auto = p.decision && p.decision['continue'] && !p.complete;
    var c = el('div', 'wcard' + ((p.problems || []).length ? ' warn' : auto ? ' auto' : ''));
    c.appendChild(el('div', 'wk', p.complete ? 'Plan complete' : (p.title || 'Checkpoint')));
    var sec = function (host, title, rows, mk, cls) {
      if (!rows || !rows.length) return;
      host.appendChild(el('div', 'wsec', title));
      var ul = el('ul', 'wl');
      rows.forEach(function (r) { var li = el('li'); li.appendChild(el('span', 'mk ' + (cls || ''), mk)); li.appendChild(el('span', '', typeof r === 'string' ? r : r.summary)); ul.appendChild(li); });
      host.appendChild(ul);
    };
    // THE HEADLINE: what LAIN does next, and why — continuing automatically is said as plainly as a pause.
    if (p.decision && p.decision.why && !p.complete) c.appendChild(el('div', 'wt', (auto ? 'Continuing · ' : 'Paused · ') + p.decision.why));
    else if (p.outcome && p.outcome.label && !p.complete) c.appendChild(el('div', 'wt', p.outcome.label));
    sec(c, 'Landed', p.landed, '✓', 'ok');
    sec(c, 'Failed', p.failed, '✕', 'bad');
    var more = el('details', '');
    more.appendChild(el('summary', '', 'Details'));
    sec(more, 'Found', p.found, '!', 'warn');
    sec(more, 'Recovered — the Agent worked past these', p.recovered, '↺', '');
    if (p.recommended) sec(more, 'Recommended next change', [p.recommended.text], '→');
    sec(more, 'Remaining', p.remaining, '·');
    if (p.profileApplied) more.appendChild(el('div', 'wb', 'Execution profile is now ' + p.profileApplied + '.'));
    if (more.childNodes.length > 1) c.appendChild(more);
    return c;
  }

  function findingCard(f) {
    var c = el('div', 'wcard' + (f.blocking ? ' hot' : ' warn'));
    c.id = 'wf-' + f.id;
    var head = el('div', 'wk', 'Finding');
    head.appendChild(el('span', 'tag ' + (f.blocking ? 'bad' : f.severity === 'major' || f.severity === 'critical' ? 'warn' : ''), f.severity + (f.blocking ? ' · blocking' : '')));
    c.appendChild(head);
    c.appendChild(el('div', 'wt', f.summary));
    if ((f.evidence || []).length) c.appendChild(el('div', 'wb', 'Evidence: ' + f.evidence.join(' · ')));
    if ((f.affected || []).length) c.appendChild(el('div', 'wb', 'Affects: ' + f.affected.join(' · ')));
    if (f.possibleFix) c.appendChild(el('div', 'wb', 'Possible fix: ' + f.possibleFix));
    var acts = el('div', 'wacts');
    if (f.possibleFix) acts.appendChild(btn('Use this fix', 'pri', function () { finding(f, 'use-fix'); }));
    acts.appendChild(btn('Discuss in Chat', 'ghost', function () { finding(f, 'discuss'); }));
    acts.appendChild(btn('Dismiss', 'ghost', function () { finding(f, 'dismiss'); }));
    c.appendChild(acts);
    return c;
  }

  function noteNodes(n) {
    var you = el('div', 'wnote-you', n.you);
    if (n.kind === 'pending') you.appendChild(el('span', 'tag accent', 'pending steer'));
    var lain = el('div', 'wnote-lain', n.lain);
    return [you, lain];
  }

  /** How the task stands, in one word Core already chose — plus the tone to draw it in. */
  function standing(w, plan) {
    var quota = w.quota && w.quota.state === 'QUOTA_PAUSED';
    var restarting = w.autoRun && w.autoRun.waiting;
    var tone = quota || w.hostPaused ? 'warn' : restarting ? 'warn' : w.running ? 'accent' : '';
    var canContinue = quota || w.hostPaused || (!w.running && plan && plan.done < plan.total);
    return { quota: quota, restarting: restarting, tone: tone, canContinue: canContinue, word: w.status || 'Idle' };
  }

  /** The last automatic continuation, in words (autocontinue.js log): its cause and when. */
  var AUTO_CAUSE = { 'auto-resume': 'resumed after the execution host stopped', 'provider-restart': 'restarted after a provider failure', 'phase-continue': 'on to the next step' };
  function autoLine(w) {
    var a = w.autoRun || {};
    if (a.waiting) return 'Restarting · ' + (a.waiting.why || 'the provider failed');
    var last = a.last;
    if (!last || !last.cause) return '';
    return 'Continued automatically · ' + (AUTO_CAUSE[last.cause] || String(last.cause).replace(/-/g, ' ')) + (last.at ? ' · ' + L.fmt.time(last.at) : '');
  }

  /**
   * CHAT'S VIEW OF THE AGENT: one sparse card while the Coding Agent is working,
   * paused or has a plan. Its own checkpoints stay in the Coding Agent lane.
   */
  function supervisorCard(S) {
    var w = S.workbench || {};
    var plan = S.plan;
    var st = standing(w, plan);
    if (!w.running && !st.quota && !w.hostPaused && !plan) return null;
    var c = el('div', 'wcard sup');
    var k = el('div', 'wk', 'Coding Agent');
    k.appendChild(el('span', 'tag ' + st.tone, st.word));
    c.appendChild(k);
    c.appendChild(el('div', 'wt', plan ? plan.done + ' of ' + plan.total + ' steps done' : (w.running ? 'Working' : 'Waiting')));
    var line = autoLine(w);
    if (line) c.appendChild(el('div', 'wb', line));
    var problem = (w.findings || []).filter(function (f) { return f.state === 'OPEN'; })[0];
    if (problem) c.appendChild(el('div', 'wb', 'Needs your review: ' + problem.summary));
    var pending = (w.steers || []).filter(function (s) { return s.state === 'PENDING'; });
    if (pending.length) c.appendChild(el('div', 'wb', pending.length + ' idea' + (pending.length === 1 ? '' : 's') + ' waiting for a safe point'));
    var acts = el('div', 'wacts');
    acts.appendChild(btn('Open Coding Chat', 'ghost', function () { L.chat.lane('agent'); }));
    if (st.canContinue) acts.appendChild(btn('▶ Continue', 'pri', continueTask));
    c.appendChild(acts);
    return c;
  }

  var LANE_OFFERS = { chat: { URGENT_STEER: 1, PENDING_STEERS: 1, PLAN_DELTA: 1, PHASE_REVIEW: 1, FAST_OFFER: 1, LONG_CONTEXT_WARNING: 1 }, coding: { PLAN_FIRST: 1, PHASE_REVIEW: 1, PLAN_DELTA: 1, FAST_OFFER: 1, LONG_CONTEXT_WARNING: 1 } };
  function items(S, lane) {
    var w = S && S.workbench;
    if (!w) return [];
    var out = [];
    if (lane === 'chat') (w.notes || []).forEach(function (n) { out.push({ at: n.at, nodes: noteNodes(n) }); });
    if (lane === 'chat') { var sc = supervisorCard(S); if (sc) out.push({ at: Date.now(), nodes: [sc], last: true }); }
    if (lane !== 'chat') (w.phases || []).slice(-6).forEach(function (p) { out.push({ at: p.at, nodes: [phaseCard(p)] }); });
    (w.findings || []).filter(function (f) { return f.state === 'OPEN'; }).forEach(function (f) { out.push({ at: f.at, nodes: [findingCard(f)] }); });
    (w.offers || []).filter(function (o) { return (LANE_OFFERS[lane] || {})[o.kind]; }).forEach(function (o) { out.push({ at: o.at, nodes: [offerCard(o)], last: true }); });
    return out;
  }
  function sig(S) { var w = S && S.workbench; return w ? JSON.stringify([w.status, w.running, w.quota, w.surface, w.hostPaused, w.autoRun && [w.autoRun.last, w.autoRun.waiting], (w.notes || []).length, (w.phases || []).length, (w.steers || []).map(function (s) { return s.id + s.state; }), (w.findings || []).map(function (f) { return f.id + f.state; }), (w.offers || []).map(function (o) { return o.id; }), w.discussing, S.plan && S.plan.done]) : ''; }

  // ---- project binding --------------------------------------------------------------------------------------
  /** BIND THIS SESSION TO A FOLDER — the same conversation, never a copy. */
  function projectMenu(anchor, opts) {
    opts = opts || {};
    var S = L.state() || {};
    var p = (S.workspace && S.workspace.project) || {};
    var ideRoot = L.ide && L.ide.currentRoot ? L.ide.currentRoot() : null;
    var done = async function (r) {
      if (!r || !r.ok) { L.toast((r && r.why) || 'could not attach the project', true); return; }
      await L.poll();
      if (opts.then) opts.then();
    };
    var attach = function (root) { return L.api('/api/project/attach', { path: root }).then(done); };
    var items2 = [];
    if (ideRoot && (!p.attached || p.root !== ideRoot)) items2.push({ label: 'Use open IDE project', note: ideRoot, run: function () { attach(ideRoot); } });
    items2.push({ label: p.attached ? 'Move to another folder…' : 'Choose a folder…', note: 'an existing folder on this machine', run: async function () { var dir = await L.ide.pickFolder('Choose the project folder'); if (dir) attach(dir); } });
    items2.push({ label: 'Create project…', note: 'a new folder, bound to this conversation', run: async function () {
      var rec = null; try { rec = await L.api('/api/project/recent', {}); } catch (e) { rec = null; }
      var v = await L.dialog({ title: 'Create project', text: 'LAIN creates the folder and binds this conversation to it.', fields: [{ key: 'name', label: 'Name', value: 'new-project' }, { key: 'parent', label: 'Location', value: (rec && rec.defaultProjectRoot) || '', action: { label: 'Choose…', run: function () { return L.ide.pickFolder('Where the project lives'); } } }], ok: 'Create' });
      if (v) done(await L.api('/api/project/create', { parent: v.parent, name: v.name, attach: true }));
    } });
    items2.push({ label: 'Clone from GitHub…', note: 'a repository you can access, cloned into a local folder', run: function () { if (L.github) L.github.pick({ then: opts.then }); } });
    if (p.attached) items2.push({ sep: true }, { label: 'Remove project', note: 'this conversation becomes unassigned', danger: true, run: async function () { done(await L.api('/api/project/detach', {})); } });
    L.kit.menu(anchor || document.getElementById('chatHead') || document.body, items2, { title: opts.reason || (p.attached ? 'Project · ' + p.name : 'The Coding Agent works in a project folder') });
  }

  // ---- the task panel -----------------------------------------------------------------------------------------
  function cfgBtn(icon, value, label, fn) {
    var b = el('button', '');
    b.appendChild(L.icon(icon, 16));
    var t = el('div', ''); t.style.minWidth = '0';
    t.appendChild(el('b', '', value)); t.appendChild(el('span', '', label));
    b.appendChild(t);
    b.onclick = function () { fn(b); };
    return b;
  }
  var runSig = '';
  function detailsOpen() { try { return localStorage.getItem('lain.chat.runDetails') === '1'; } catch (e) { return false; } }
  /**
   * THE TASK PANEL — SUBORDINATE TO THE CONVERSATION. Where the work stands, the ONE next action, and
   * details (steps, configuration, CLI / IDE) only when asked for.
   */
  function runPanel(host) {
    var S = L.state();
    if (!S || !host) return;
    var w = S.workbench || {};
    var p = (S.workspace && S.workspace.project) || {};
    var plan = S.plan;
    var m = S.models || {};
    var open = detailsOpen();
    var sig = JSON.stringify([w.status, w.running, w.profile, w.pendingProfile, w.strategy, p.root, plan, (w.findings || []).length, (w.offers || []).map(function (o) { return o.id; }), w.quota, w.surface, w.hostPaused, w.autoRun && [w.autoRun.last, w.autoRun.waiting], m.coding && m.coding.display, open, (S.changes || []).length]);
    if (sig === runSig && host.firstChild) return;
    runSig = sig;
    host.textContent = '';
    var steps = (plan && plan.steps) || [];
    var active = steps.filter(function (x) { return x.status === 'active'; })[0];
    var findings = (w.findings || []).filter(function (x) { return x.state === 'OPEN'; });
    var st = standing(w, plan);
    var review = (w.offers || []).filter(function (o) { return o.kind === 'PHASE_REVIEW'; })[0];

    var b1 = el('div', 'rp-block rp-sumblock');
    var hd = el('div', 'rp-head');
    hd.appendChild(el('div', 'rp-t', 'Task'));
    hd.appendChild(el('span', 'spacer'));
    hd.appendChild(el('span', 'tag ' + st.tone, st.word));
    b1.appendChild(hd);
    b1.appendChild(el('div', 'rp-proj', p.attached ? p.name : (p.github ? p.github + ' — not cloned yet' : 'No project')));
    if (active) b1.appendChild(el('div', 'rp-now', (w.running ? 'Now: ' : 'Next: ') + active.text));
    var facts = [];
    if (plan) facts.push(plan.done + ' of ' + plan.total + ' steps done');
    facts.push((S.changes || []).length + ' files changed');
    if (findings.length) facts.push(findings.length + ' open finding' + (findings.length === 1 ? '' : 's'));
    b1.appendChild(el('div', 'rp-facts2', facts.join(' · ')));
    var line = autoLine(w);
    if (line) b1.appendChild(el('div', 'rp-auto', line));
    host.appendChild(b1);

    // THE ONE NEXT ACTION.
    var go = el('button', 'rp-go');
    go.appendChild(L.icon('play', 16));
    var gt = el('div', '');
    gt.appendChild(el('b', '', st.quota || w.hostPaused ? 'Continue' : 'Continue plan'));
    gt.appendChild(el('span', '', w.hostPaused ? 'Resume here — the task picks up where it stopped' : st.quota ? 'Re-check the provider now and resume' : review ? (review.text || 'Next phase') : w.running ? 'The Agent is working' : st.canContinue ? 'Run the next phase' : 'Nothing to continue'));
    go.appendChild(gt);
    go.onclick = function () { go.disabled = true; continueTask(); };
    // ONLY WHEN THERE IS SOMETHING TO CONTINUE: a disabled slab reads as a broken button.
    if (st.canContinue) host.appendChild(go);
    if (findings.length) {
      var row = el('div', 'rp-row');
      row.appendChild(btn('Review problem', 'ghost', function () { var n = document.getElementById('wf-' + findings[0].id); if (n) n.scrollIntoView({ block: 'center' }); }));
      row.appendChild(btn('Discuss in Chat', 'ghost', function () { L.chat.lane('chat'); }));
      host.appendChild(row);
    }

    // DETAILS, ON DEMAND.
    var dt = el('button', 'rp-more', open ? 'Hide details' : 'Details');
    dt.onclick = function () { try { localStorage.setItem('lain.chat.runDetails', open ? '0' : '1'); } catch (e) { /* per viewer */ } runSig = ''; runPanel(host); };
    host.appendChild(dt);
    if (!open) return;
    var b2 = el('div', 'rp-block');
    b2.appendChild(el('div', 'rp-t', 'Steps'));
    var ul = el('ul', 'rp-steps');
    steps.slice(0, 14).forEach(function (x) {
      var li = el('li');
      li.appendChild(el('span', 'mk ' + (x.status === 'done' ? 'done' : x.status === 'active' ? 'active' : ''), x.status === 'done' ? '✓' : ''));
      li.appendChild(el('span', 'tx', x.text));
      ul.appendChild(li);
    });
    findings.slice(0, 3).forEach(function (fd) { var li = el('li'); li.appendChild(el('span', 'mk bad', '!')); li.appendChild(el('span', 'tx', fd.summary)); ul.appendChild(li); });
    if (!ul.childNodes.length) ul.appendChild(el('li', 'faint', 'No plan yet.'));
    b2.appendChild(ul);
    host.appendChild(b2);
    var b3 = el('div', 'rp-block');
    b3.appendChild(el('div', 'rp-t', 'How it runs'));
    var cfg = el('div', 'rp-cfg');
    var mc = m.coding || {};
    var d = mc.display || {};
    cfg.appendChild(cfgBtn('model', d.resolved ? d.modelLabel : 'Select model', d.resolved ? d.sourceLabel : 'Route', function (bt) { if (L.intel) L.intel.pickModel(bt, 'coding'); }));
    if (mc.efforts && mc.efforts.length) cfg.appendChild(cfgBtn('sliders', mc.effortLabel || 'Default', 'Effort', function (bt) { if (L.intel) L.intel.pickEffort(bt, 'coding'); }));
    cfg.appendChild(cfgBtn(w.profile === 'FAST' ? 'bolt' : w.profile === 'ECO' ? 'leaf' : 'play', (w.profile || 'NORMAL').charAt(0) + (w.profile || 'NORMAL').slice(1).toLowerCase() + (w.pendingProfile ? ' → ' + w.pendingProfile.toLowerCase() : ''), 'Execution', function (bt) { if (L.composer) L.composer.profileMenu(bt); }));
    cfg.appendChild(cfgBtn('layers', w.strategy ? w.strategy.label : 'Normal', 'Run strategy', function (bt) { if (L.composer) L.composer.strategyMenu(bt); }));
    b3.appendChild(cfg);
    host.appendChild(b3);
    var row2 = el('div', 'rp-row');
    row2.appendChild(btn(w.surface && w.surface.writer === 'cli' ? 'Take back from CLI' : 'Continue in CLI', 'ghost', function () { continueInCli(); }));
    row2.appendChild(btn('Open in IDE', 'ghost', function () { if (L.ide && L.ide.openTask) L.ide.openTask(); else L.nav.go('ide'); }));
    host.appendChild(row2);
  }

  /** CONTINUE IN CLI — a real handoff of the writer; the command resumes the SAME session. */
  async function continueInCli() {
    var w = W() || {};
    if (w.surface && w.surface.writer === 'cli') {
      var t = await L.api('/api/surface/takeback', {});
      if (!t || !t.ok) return L.toast((t && t.why) || 'could not take it back', true);
      L.toast('The window holds this session again — with what the CLI did.');
      return L.poll();
    }
    var r = await L.api('/api/surface/handoff', { to: 'cli' });
    if (!r || !r.ok) return L.toast((r && r.why) || 'could not hand off', true);
    L.dialog({ title: 'Continue in CLI', text: 'This session now continues in the terminal. Run this there — it attaches to the same task (no transcript replay). Hand it back with /handback, or press Take back here.', pre: (r.cwd ? 'cd "' + r.cwd + '"\n' : '') + r.command, ok: 'Close', cancel: 'Close' });
    L.poll();
  }

  L.work = { items: items, sig: sig, runPanel: runPanel, projectMenu: projectMenu, answer: answer, continueInCli: continueInCli, continueTask: continueTask, standing: standing, autoLine: autoLine };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
