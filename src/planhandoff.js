'use strict';

/** A PLAN MADE IN CHAT, ACCEPTED BY A PERSON, IMPLEMENTED IN CODING. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE = Object.freeze({ DRAFT: 'DRAFT', ACCEPTED: 'ACCEPTED', SUPERSEDED: 'SUPERSEDED', COMPLETED: 'COMPLETED' });
const HANDOFF = Object.freeze({ PREFILLED: 'PREFILLED', SUBMITTED: 'SUBMITTED' });

const MAX_PLANS = 20;
const MAX_PLAN_CHARS = 12_000;
const MAX_STEPS = 40;
const PROMPT_STEPS = 12;
const MAX_REQUIREMENTS = 6;
const REQUIREMENT_CHARS = 400;

const STEP_RE = /^\s*(?:\d{1,2}[.)]|[-*•]|\[[ xX]?\])\s+(\S.*)$/;
const HEADER_RE = /^\s*(?:#{1,6}\s*|\*\*)?\s*(?:(?:implementation|proposed|fix|the|my|a)\s+)?plan\b/im;
const ASKED_RE = /\bplan\b/i;
const CONSTRAINT_RE = /\b(?:must(?:\s+not)?|don'?t|do\s+not|never|only|without|avoid|keep|no\s+new)\b/i;

function digest(text) { return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16); }

function attach(session) {
  session.planDocs = [];
  session.transfers = [];
  return session;
}

/** THE PLAN HANDOFF — the newest transfer of kind 'plan'. */
function handoff(session) {
  const list = (session && Array.isArray(session.transfers)) ? session.transfers : [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].kind === 'plan') return list[i];
  return null;
}

function toJSON(session) {
  return {
    planDocs: (session.planDocs || []).slice(-MAX_PLANS),
    transfers: (session.transfers || []).slice(-MAX_TRANSFERS),
  };
}

function restore(session, data = {}) {
  session.planDocs = Array.isArray(data.planDocs)
    ? data.planDocs.filter((p) => p && typeof p.id === 'string' && STATE[p.state] && typeof p.text === 'string').slice(-MAX_PLANS)
    : [];
  session.transfers = Array.isArray(data.transfers) ? data.transfers.filter((t) => t && typeof t.id === 'string' && typeof t.kind === 'string').slice(-MAX_TRANSFERS) : [];
  // A SESSION SAVED BEFORE 2026-09-25 kept its plan handoff in a field of its
  // own; it joins the transfer list once, so nothing reads that field again.
  const h = data.handoff && typeof data.handoff === 'object' && typeof data.handoff.planId === 'string' ? data.handoff : null;
  if (h && !session.transfers.some((t) => t.id === h.id)) session.transfers.push({ ...h, kind: 'plan', id: h.id || `X${h.planId}` });
  return session;
}

// THE TRANSFER — the one Core representation of work changing hands
const TRANSFER = Object.freeze({ PROPOSED: 'PROPOSED', PREFILLED: 'PREFILLED', ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED', SUBMITTED: 'SUBMITTED', DONE: 'DONE' });
const MAX_TRANSFERS = 40;
const PROPOSAL_TTL_MS = 30 * 60_000;

function transfersOf(session) {
  if (!Array.isArray(session.transfers)) session.transfers = [];
  return session.transfers;
}

function transfer(app, { kind, from, to, task = '', text = '', context = '', reason = '', via = null, origin = null, state = TRANSFER.PROPOSED, extra = {} } = {}) {
  const session = app.session;
  let generation = null;
  let selection = null;
  try { const hc = require('./harnesscontext'); generation = require('./projectgen').current(session.cwd).n; const sel = hc.selection(app, session); selection = sel ? sel.id : null; } catch { /* no Harness context */ }
  const body = `${task || text}\n${context || ''}`;
  const rec = {
    id: `X${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    kind: String(kind), from: from || null, to: to || null, state,
    task: String(task || '').slice(0, 4000) || null, text: String(text || '').slice(0, 4000) || null,
    findings: String(context || '').slice(0, 6000) || null,
    constraints: body.split('\n').map((l) => l.trim()).filter((l) => l && CONSTRAINT_RE.test(l)).slice(0, MAX_REQUIREMENTS),
    evidenceRefs: { selection, taskId: session.task ? session.task.id : null },
    projectGeneration: generation, reason: String(reason || '').slice(0, 200), via, origin,
    at: Date.now(), ...extra,
  };
  const list = transfersOf(session);
  // One PROPOSED transfer at a time: a newer question replaces the one waiting.
  for (const t of list) if (t.state === TRANSFER.PROPOSED && rec.state === TRANSFER.PROPOSED) { t.state = TRANSFER.DECLINED; t.why = 'superseded by a newer proposal'; }
  list.push(rec);
  if (list.length > MAX_TRANSFERS) list.splice(0, list.length - MAX_TRANSFERS);
  return rec;
}

/** The transfer waiting for the person, or null (expired ones are closed here). */
function pendingTransfer(app) {
  const list = transfersOf(app.session);
  const t = list.filter((x) => x.state === TRANSFER.PROPOSED).slice(-1)[0] || null;
  if (t && Date.now() - t.at > PROPOSAL_TTL_MS) { t.state = TRANSFER.DECLINED; t.why = 'expired'; return null; }
  return t;
}

/** Answer a waiting transfer, once. An unknown or stale id takes nothing. */
function answerTransfer(app, id, accept) {
  const t = pendingTransfer(app);
  if (!t || t.id !== String(id || '')) return null;
  t.state = accept ? TRANSFER.ACCEPTED : TRANSFER.DECLINED;
  t.answeredAt = Date.now();
  return t;
}

function settleTransfer(app, id, state) {
  const t = transfersOf(app.session).find((x) => x.id === id);
  if (t && TRANSFER[state]) { t.state = state; t.settledAt = Date.now(); }
  return t || null;
}

function docs(session) {
  if (!Array.isArray(session.planDocs)) session.planDocs = [];
  return session.planDocs;
}

function find(session, id) { return docs(session).find((p) => p.id === String(id || '')) || null; }
function latest(session, state) { return docs(session).filter((p) => p.state === state).slice(-1)[0] || null; }

/** Does this text read as a plan? */
function detect(text, askedText = '') {
  const body = String(text || '');
  const steps = body.split('\n').map((l) => STEP_RE.exec(l)).filter(Boolean).map((m) => m[1].trim()).slice(0, MAX_STEPS);
  if (steps.length < 2) return { ok: false, why: 'fewer than two steps' };
  const header = HEADER_RE.exec(body);
  if (!header && !ASKED_RE.test(String(askedText || ''))) return { ok: false, why: 'neither called a plan nor asked for one' };
  const titleLine = header
    ? body.slice(header.index).split('\n')[0].replace(/[#*]/g, '').trim()
    : String(askedText || '').split('\n')[0].trim();
  return { ok: true, steps, title: titleLine.slice(0, 120) || 'Plan' };
}

/** A new DRAFT. An older DRAFT is superseded — only one draft is ever pending. */
function draft(session, { text, title = null, origin = null } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, why: 'the plan is empty' };
  if (body.length > MAX_PLAN_CHARS) return { ok: false, why: `a plan is at most ${MAX_PLAN_CHARS} characters` };
  const found = detect(body, 'plan');
  const now = Date.now();
  for (const p of docs(session)) {
    if (p.state === STATE.DRAFT) { p.state = STATE.SUPERSEDED; p.supersededAt = now; }
  }
  const n = docs(session).reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0) + 1;
  const plan = {
    id: `p${n}`,
    state: STATE.DRAFT,
    title: String(title || (found.ok ? found.title : body.split('\n')[0])).slice(0, 120),
    text: body,
    steps: found.ok ? found.steps : [],
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    supersededAt: null,
    completedAt: null,
    digest: null,
    goalId: goalId(session),
    origin: origin || null,
  };
  docs(session).push(plan);
  while (docs(session).length > MAX_PLANS) docs(session).shift();
  return { ok: true, plan };
}

/** AFTER A CHAT TURN: did it produce a plan? */
function capture(session, { reply, asked, origin = null } = {}) {
  const found = detect(reply, asked);
  if (!found.ok) return { ok: false, why: found.why };
  return draft(session, { text: reply, title: found.title, origin });
}

/** Edit a DRAFT in place. An ACCEPTED plan is frozen: editing it opens a new DRAFT. */
function edit(session, id, text) {
  const p = find(session, id);
  if (!p) return { ok: false, why: `no plan ${id}` };
  if (p.state === STATE.DRAFT) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, why: 'the plan is empty' };
    if (body.length > MAX_PLAN_CHARS) return { ok: false, why: `a plan is at most ${MAX_PLAN_CHARS} characters` };
    const found = detect(body, 'plan');
    p.text = body;
    p.steps = found.ok ? found.steps : [];
    p.updatedAt = Date.now();
    return { ok: true, plan: p };
  }
  if (p.state === STATE.ACCEPTED) return draft(session, { text, title: p.title, origin: { editedFrom: p.id } });
  return { ok: false, why: `plan ${id} is ${p.state} and cannot be edited` };
}

function goalId(session) {
  try { return require('./goal').id(session) || null; } catch { return null; }
}

/** ACCEPT: freeze, supersede the previous acceptance, build the handoff and prefill the Coding composer. */
function accept(app, id) {
  const session = app.session;
  const p = find(session, id);
  if (!p) return { ok: false, why: `no plan ${id}` };
  if (p.state !== STATE.DRAFT) return { ok: false, why: `plan ${id} is ${p.state}; only a DRAFT can be accepted` };
  const now = Date.now();
  for (const q of docs(session)) {
    if (q !== p && q.state === STATE.ACCEPTED) { q.state = STATE.SUPERSEDED; q.supersededAt = now; }
  }
  p.state = STATE.ACCEPTED;
  p.acceptedAt = now;
  p.digest = digest(p.text);
  p.goalId = goalId(session);
  const brief = buildBrief(app, p);
  // THE PLAN HANDOFF IS A TRANSFER (kind 'plan', Chat → IDE), the same record.
  const h = transfer(app, {
    kind: 'plan', from: 'chat', to: 'ide', task: p.title || '', text: p.text, reason: 'an accepted plan', state: HANDOFF.PREFILLED,
    extra: { planId: p.id, planDigest: p.digest, createdAt: now, submittedAt: null, prompt: instruction(brief), brief },
  });
  require('./sessionviews').views(session).active = 'coding';
  return { ok: true, plan: p, handoff: h };
}

/** The Coding turn that carried the handoff was submitted. */
function noteSubmitted(session) {
  const h = handoff(session);
  if (!h || h.state !== HANDOFF.PREFILLED) return null;
  h.state = HANDOFF.SUBMITTED;
  h.submittedAt = Date.now();
  return h;
}

function complete(session, id) {
  const p = find(session, id);
  if (!p) return { ok: false, why: `no plan ${id}` };
  if (p.state !== STATE.ACCEPTED) return { ok: false, why: `plan ${id} is ${p.state}; only an ACCEPTED plan can be completed` };
  p.state = STATE.COMPLETED;
  p.completedAt = Date.now();
  return { ok: true, plan: p };
}

/** AFTER A CODING TURN: a submitted handoff whose work the LIFECYCLE declared DONE completes its plan. */
function afterCoding(session) {
  const h = handoff(session);
  const life = session.lifecycle;
  if (!h || h.state !== HANDOFF.SUBMITTED || !life || life.state !== 'DONE') return null;
  const r = complete(session, h.planId);
  return r.ok ? r.plan : null;
}

// --------------------------------------------------------------- brief --

function userLines(session) {
  const sv = require('./sessionviews');
  return (session.messages || [])
    .filter((m) => m && m.role === 'user' && sv.threadOf(m) === 'chat' && !m._steer)
    .map((m) => String(m.content || '').trim())
    .filter(Boolean);
}

function mentionedFiles(root, text) {
  if (!root) return [];
  const out = new Set();
  const re = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,5})(?=$|[\s`'"),:;])/gm;
  let m;
  while ((m = re.exec(String(text || ''))) && out.size < 12) {
    const rel = m[1].replace(/^\.\//, '');
    try { if (fs.statSync(path.join(root, rel)).isFile()) out.add(rel); } catch { /* not a file here */ }
  }
  return [...out];
}

/** The structured handoff. Every field is read from an owner; nothing is guessed. */
function buildBrief(app, plan) {
  const s = app.session;
  const sv = require('./sessionviews');
  const project = sv.project(s);
  const root = project.attached ? project.root : null;
  const requirements = userLines(s).slice(-MAX_REQUIREMENTS).map((t) => t.slice(0, REQUIREMENT_CHARS));
  const constraints = userLines(s)
    .flatMap((t) => t.split(/(?<=[.!?])\s+|\n/))
    .filter((l) => CONSTRAINT_RE.test(l))
    .map((l) => l.trim().slice(0, 200))
    .slice(-8);
  const pins = sv.views(s).pins.map((p) => ({ path: p.path, range: p.range || null }));
  const files = [...new Set([...pins.map((p) => p.path), ...mentionedFiles(root, plan.text)])].slice(0, 12);

  let intelligence = null;
  if (root) {
    try {
      const pi = require('./projectindex');
      const cov = pi.coverage(root);
      const index = pi.load(root);
      const names = [...new Set((plan.text.match(/`([A-Za-z_$][\w$]{2,60})`/g) || []).map((x) => x.slice(1, -1)))].slice(0, 8);
      intelligence = {
        index: cov.persisted ? pi.fileFor(root) : null,
        freshness: cov.state,
        declarations: cov.symbols,
        symbols: names.map((n) => ({ name: n, at: pi.definitionsOf(index, n).slice(0, 3).map((d) => `${d.file}:${d.line || 0}`) }))
          .filter((x) => x.at.length),
      };
    } catch { intelligence = null; }
  }

  const harness = (() => { try { return require('./harnesssurface').project(app); } catch { return null; } })();
  const evidence = [];
  if (harness && harness.task) evidence.push({ kind: 'task', id: harness.task.id, state: harness.task.state });
  for (const a of (harness && harness.recent) || []) evidence.push({ kind: 'artifact', name: a.name || a.kind, ref: a.id || null });
  const verification = (harness && harness.verification)
    ? { verdict: harness.verification.verdict, why: harness.verification.why }
    : (s.verification ? { verdict: s.verification.verdict || null, why: String(s.verification.why || '').slice(0, 200) } : null);
  let changes = [];
  try {
    changes = require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: s.cwd })
      .slice(0, 20).map((f) => ({ path: f.rel, kind: f.kind, added: f.added, removed: f.removed }));
  } catch { changes = []; }

  return {
    goalId: plan.goalId || goalId(s),
    goal: (() => { try { return require('./goal').text(s) || ''; } catch { return ''; } })(),
    acceptedPlanId: plan.id,
    acceptedPlanDigest: plan.digest,
    acceptedPlanTitle: plan.title,
    acceptedPlanText: plan.text,
    steps: plan.steps,
    userRequirements: requirements,
    constraints,
    projectRoot: root,
    relevantFiles: files,
    pins,
    projectIntelligenceRefs: intelligence,
    evidenceRefs: evidence.slice(0, 12),
    existingChanges: changes,
    verificationState: verification,
    chatSource: (s.chatSource || 'lain'),
  };
}

/** The bounded instruction prefilled into the Coding composer. */
function instruction(brief) {
  const lines = [`Implement the accepted plan ${brief.acceptedPlanId} — "${brief.acceptedPlanTitle}".`, ''];
  if (brief.goal) lines.push(`Objective: ${brief.goal}`);
  if (brief.projectRoot) lines.push(`Project: ${brief.projectRoot}`);
  if (brief.steps.length) {
    lines.push('', 'Steps (the full accepted plan is in your context):');
    brief.steps.slice(0, PROMPT_STEPS).forEach((st, i) => lines.push(`${i + 1}. ${st.slice(0, 200)}`));
    if (brief.steps.length > PROMPT_STEPS) lines.push(`… ${brief.steps.length - PROMPT_STEPS} more in the accepted plan`);
  }
  if (brief.constraints.length) {
    lines.push('', 'Constraints from the discussion:');
    for (const c of brief.constraints) lines.push(`- ${c}`);
  }
  if (brief.relevantFiles.length) lines.push('', `Relevant files: ${brief.relevantFiles.join(', ')}`);
  if (brief.existingChanges.length) lines.push(`Already changed in this session: ${brief.existingChanges.map((c) => c.path).join(', ')}`);
  lines.push('', 'Work through the steps in order, verify with the project\'s own checks, and report what changed.');
  return lines.join('\n');
}

/** WHAT A TURN'S SYSTEM CONTEXT CARRIES about this, per view. */
function promptSection(session) {
  const sv = require('./sessionviews');
  if (sv.current(session) === 'chat') {
    const accepted = latest(session, STATE.ACCEPTED);
    return [
      '# View: Chat',
      'You are in the Chat view of an engineering session: questions, explanation, architecture, research and planning.',
      'You cannot change files or run commands here; mutating tools are refused. When the person wants work done, write a plan as a titled "Plan" with numbered steps — they accept it and the Coding view implements it.',
      accepted ? `An accepted plan already exists (${accepted.id}, "${accepted.title}").` : '',
    ].filter(Boolean).join('\n');
  }
  const accepted = latest(session, STATE.ACCEPTED);
  if (!accepted) return '';
  const ho = handoff(session);
  const h = ho && ho.planId === accepted.id ? ho.brief : null;
  const out = [
    `# Accepted plan ${accepted.id} — ${accepted.title}`,
    'The person accepted this plan in the Chat view. It is the agreed scope; implement it, and say so if the code shows a step is wrong rather than silently diverging.',
    '',
    accepted.text,
  ];
  if (h) {
    if (h.userRequirements.length) out.push('', '## The person\'s own requirements (their words)', ...h.userRequirements.map((r) => `- ${r}`));
    if (h.projectIntelligenceRefs && h.projectIntelligenceRefs.symbols.length) {
      out.push('', '## Symbols named in the plan', ...h.projectIntelligenceRefs.symbols.map((x) => `- ${x.name}: ${x.at.join(', ')}`));
    }
    if (h.verificationState) out.push('', `## Verification when accepted: ${h.verificationState.verdict || 'none'}`);
  }
  return out.join('\n');
}

/** The public projection: no brief internals the window has no use for. */
function project(session) {
  const plans = docs(session).map((p) => ({
    id: p.id, state: p.state, title: p.title, text: p.text, steps: p.steps,
    createdAt: p.createdAt, updatedAt: p.updatedAt, acceptedAt: p.acceptedAt,
    supersededAt: p.supersededAt, completedAt: p.completedAt, deferredAt: p.deferredAt || null, digest: p.digest,
    origin: p.origin ? { source: p.origin.source || null, model: p.origin.model || null, editedFrom: p.origin.editedFrom || null } : null,
  }));
  const draftDoc = latest(session, STATE.DRAFT);
  const h = handoff(session);
  return {
    plans,
    draft: draftDoc ? draftDoc.id : null,
    accepted: (latest(session, STATE.ACCEPTED) || {}).id || null,
    // THE PROMPT THE WINDOW SHOWS: "Plan ready — Continue to Coding?"
    ready: Boolean(draftDoc),
    handoff: h ? {
      id: h.id, planId: h.planId, state: h.state, createdAt: h.createdAt, submittedAt: h.submittedAt,
      prompt: h.prompt, brief: h.brief,
    } : null,
  };
}

module.exports = {
  STATE, HANDOFF, MAX_PLAN_CHARS,
  attach, toJSON, restore, detect, draft, capture, edit, accept, complete,
  noteSubmitted, afterCoding, buildBrief, instruction, promptSection, project, find, latest,
  TRANSFER, transfer, handoff, pendingTransfer, answerTransfer, settleTransfer, transfersOf,
};
