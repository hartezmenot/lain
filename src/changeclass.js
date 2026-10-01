'use strict';

/**
 * HOW MUCH MACHINERY A CODE CHANGE GETS (2026-09-30) — the execution class.
 *
 *   DIRECT   "move this 8px down", "change this colour", "rename this text" —
 *            locate the owner, the minimal patch, verify, one or two lines back.
 *   NARROW   "move this config to JSON", "extract this component", a semantic
 *            rename across a few files — owner → references → extract/update
 *            consumers → diagnostics → repair.
 *   AGENT    a feature across a subsystem, a multi-owner bug — the Coding
 *            Agent as it always runs.
 *   PHASED   a migration, a new architecture, a long multi-step project —
 *            planned first (the plan-first offer) and run phase by phase.
 *
 * LAIN used to give every edit the whole machinery: read the project, narrate
 * the architecture, rediscover the file, and eventually edit. The class keeps
 * a trivial edit trivial. The person never has to see these labels.
 *
 * ------------------------------------------------------------------------
 * DETERMINISTIC FIRST. The classifier below decides from the words, the
 * selection and what the request came from — no model. JEV (workers.js
 * `change_class`) may be asked ONLY when a recruited model passed that
 * contract's gate and the deterministic answer is uncertain; its answer can
 * ESCALATE the class (DIRECT → NARROW → AGENT → PHASED) and never lower it. A
 * safety floor (deleting files, history rewrites, credentials…) is Core's and
 * nothing overrides it. With no Jev, LAIN works exactly the same.
 */

const ORDER = Object.freeze(['DIRECT', 'NARROW', 'AGENT', 'PHASED']);
const CLASS = Object.freeze({ DIRECT: 'DIRECT', NARROW: 'NARROW', AGENT: 'AGENT', PHASED: 'PHASED' });

const PHASED_RE = /\b(migrat(e|ion)|re-?architect|new architecture|overhaul|rewrite (the|this|our|all)|port (the|this|it|everything) (to|from)|from scratch|end[- ]to[- ]end|multi[- ]step|(whole|entire) (app|application|project|codebase|repo)|roadmap|phase (one|1|two|2)|several phases)\b/i;
const SAFETY_RE = /\b(delete|remove|wipe|erase|purge) (all |every |these |those )?(of )?(the )?(whole |entire )?([\w.-]+ )?(files?|folders?|director(y|ies)|branch(es)?|history|database|tables?|data|repo(sitory)?)\b|\bgit (push|reset|rebase|filter-branch|clean)\b|--force\b|\bforce[- ]push\b|\b(credential|secret|api key|token|password)s?\b|\bdrop (table|database)\b|\brm -rf\b|\bformat (the )?(disk|drive)\b/i;
const AGENT_RE = /\b(implement|add (support|a feature|an? (endpoint|api|page|screen|command|integration))|build (a|an|the)|create (a|an) (new )?(feature|service|module|system|page)|integrate|wire (up|in)|fix (the |this |a )?(bug|crash|race|leak|regression)|debug|investigate|diagnose|why (does|is|did|do|are)|root cause|refactor (the |this )?(module|system|subsystem|architecture|layer)|optimi[sz]e|performance|test(s)? (for|covering)|write tests)\b/i;
const NARROW_RE = /\b(extract (this|the|a|it)|move (this|the|these|that|it|our)? ?(config(uration)?|settings|constants?|types?|strings?|options|values|data)\b.*\b(to|into) (a )?(json|ya?ml|toml|separate file|its own file|file|module)|rename .{1,60} (across|everywhere|throughout|in all|in every)|(split|separate) .{1,60} into|convert .{1,60} (to|into)|inline (this|the)|dedup(licate)?|replace all|move (this|the) (function|component|hook|class|type) (to|into))\b/i;
const VISUAL_RE = /\b(move|shift|nudge|push|pull|align|centre|center|resize|widen|narrow|enlarge|shrink|offset)\b[^.?!]{0,40}\b(\d+(\.\d+)?\s?(px|pixels?|rem|em|%)|up|down|left|right|above|below|lower|higher|over|under)\b/i;
const STYLE_RE = /\b(colou?r|background|font( |-)?(size|weight|family)?|text size|size|width|height|padding|margin|spacing|gap|radius|rounded|corners?|border|shadow|opacity|bold|italic|underline|icon)\b/i;
const CHANGE_RE = /\b(change|make|set|increase|decrease|reduce|bump|raise|lower|darker|lighter|brighter|bigger|smaller|wider|narrower|taller|shorter|thicker|thinner|bolder|remove the|hide|show|swap)\b/i;
const SIZE_ADJ_RE = /\b(make|made|keep)\s+(it|them|these|those|(this|that|the)(\s+[\w-]+){0,2})\s+(a\s+(bit|little|touch)\s+)?(bigger|smaller|wider|narrower|taller|shorter|bolder|lighter|darker|brighter|rounder|flatter|tighter|looser)\b/i;
const TEXTEDIT_RE =/\b(rename|change|update|replace|reword|fix (the )?(typo|spelling))\b[^.?!]{0,50}\b(text|label|title|heading|placeholder|copy|caption|tooltip|wording|headline|button text)\b|\b(change|replace|rename) ["“'][^"”']{1,80}["”'] (to|with) ["“'][^"”']{1,80}["”']/i;

// ONE NEW ELEMENT (Gate 4, spec §102): "add Settings button", "add a divider under the header" — a short request for a
// single piece of UI beside what is selected is as local as a colour change. A button that must also DO something new
// ("…that exports the report") is behaviour, and stays with the Agent.
const ADD_UI_RE = /\b(add|insert|put|place)\s+(an?\s+|one\s+|another\s+|the\s+)?([\w-]+\s+){0,2}(button|link|label|icon|heading|title|divider|separator|badge|chip|tooltip|toggle|checkbox|switch|menu item|tab|caption|subtitle|spacer)s?\b/i;
const BEHAVIOUR_RE = /\b(that|which|to|so (it|that))\s+(\w+\s+){0,2}(opens?|calls?|sends?|fetch(es)?|saves?|loads?|exports?|imports?|authenticat\w*|logs? (in|out)|submits?|triggers?|runs?|navigates?|deletes?|uploads?|downloads?|syncs?)\b/i;

function rank(c) { return ORDER.indexOf(c); }
function higher(a, b) { return rank(a) >= rank(b) ? a : b; }

/**
 * THE DETERMINISTIC CLASS of a request.
 * @param {string} text
 * @param {object} ctx  { selection: bool (an element or a code selection), fromPreview: bool, files: number (pinned/named) }
 * @returns {{ class, reasons: string[], confidence: 'high'|'medium'|'low', floor: string|null }}
 */
function classify(text, ctx = {}) {
  const t = String(text || '').trim();
  const reasons = [];
  const sentences = t.split(/[.!?]\s+|\n+/).filter((x) => x.trim().length > 2).length;
  const long = t.length > 600;
  let floor = null;
  if (SAFETY_RE.test(t)) { floor = CLASS.AGENT; reasons.push('touches something that must never be a quick edit (deletion, history, credentials)'); }
  let broad = false;
  try { broad = require('./supervision').isBroad(t); } catch { broad = false; }
  if (broad || PHASED_RE.test(t) || long) {
    reasons.push(broad ? 'several systems at once' : long ? 'a long, multi-part request' : 'a migration or a new architecture');
    return { class: CLASS.PHASED, reasons, confidence: long && !broad && !PHASED_RE.test(t) ? 'medium' : 'high', floor };
  }
  if (AGENT_RE.test(t)) { reasons.push('a feature, a bug or an investigation'); return { class: higher(CLASS.AGENT, floor || CLASS.DIRECT), reasons, confidence: 'high', floor }; }
  if (NARROW_RE.test(t)) { reasons.push('a structural change with a known owner (extract, move, rename across files)'); return { class: higher(CLASS.NARROW, floor || CLASS.DIRECT), reasons, confidence: 'high', floor }; }
  const visual = VISUAL_RE.test(t);
  const style = (STYLE_RE.test(t) && CHANGE_RE.test(t)) || SIZE_ADJ_RE.test(t);
  const textEdit = TEXTEDIT_RE.test(t);
  const addUi = ADD_UI_RE.test(t) && !BEHAVIOUR_RE.test(t) && t.length <= 120;
  const small = t.length <= 220 && sentences <= 2 && !/\b(and then|after that|also|as well as)\b/i.test(t);
  const anchored = Boolean(ctx.selection || ctx.fromPreview) || /\b(this|the|that)( [\w-]+){0,2} (button|header|navbar|nav|title|heading|headline|card|link|label|icon|input|field|menu|sidebar|footer|logo|image|text|row|column|panel|modal|dialog|page|section|hero|badge|chip|tab)\b/i.test(t);
  if ((visual || style || textEdit || addUi) && small) {
    if (anchored) {
      reasons.push(visual ? 'a visual move or size on one element' : style ? 'one style property on one element' : textEdit ? 'a text change on one element' : 'one new element beside the selection');
      if (ctx.selection || ctx.fromPreview) reasons.push('the element is selected');
      return { class: higher(CLASS.DIRECT, floor || CLASS.DIRECT), reasons, confidence: ctx.selection || ctx.fromPreview ? 'high' : 'medium', floor };
    }
    reasons.push('a small edit whose owner must be found first');
    return { class: higher(CLASS.NARROW, floor || CLASS.DIRECT), reasons, confidence: 'medium', floor };
  }
  reasons.push('nothing marks it as a quick edit');
  return { class: higher(CLASS.AGENT, floor || CLASS.DIRECT), reasons, confidence: 'low', floor };
}

/**
 * THE CLASS, WITH JEV WHEN ONE IS RECRUITED. Jev is asked only when the deterministic answer is not certain and a
 * model passed the `change_class` gate (workers.binding); its label can only raise the class, never lower it or
 * cross the safety floor. `infer` is the recruited model's one inference — absent in a build with none.
 */
async function decide(app, text, ctx = {}, { infer = null } = {}) {
  const det = classify(text, ctx);
  const w = require('./workers');
  const cfg = (app && ((app._sibling && app._sibling.cfg) || app.cfg)) || {};
  const recruited = w.binding(cfg, 'change_class');
  if (!recruited || !infer || det.confidence === 'high') return { ...det, by: 'deterministic', jev: recruited ? 'not asked' : 'absent' };
  const r = await w.decide({
    contract: 'change_class', fingerprint: require('crypto').createHash('sha1').update(String(text)).digest('hex').slice(0, 16),
    packet: { decision: 'How much machinery does this code change need?', facts: [`request: ${String(text).slice(0, 300)}`, `selection: ${ctx.selection ? 'yes' : 'no'}`, `deterministic: ${det.class} (${det.reasons.join('; ')})`], candidates: [...ORDER] },
    deterministic: () => ({ label: det.class, certain: false }), infer, session: app && app.session,
  });
  const jevClass = ORDER.includes(r.label) ? r.label : det.class;
  // SAFETY / CORE WINS: Jev can escalate, never lower the class or cross the floor.
  const final = higher(higher(det.class, jevClass), det.floor || CLASS.DIRECT);
  return { ...det, class: final, by: r.by === 'deterministic' ? 'deterministic' : (final === det.class ? 'deterministic (Jev agreed or lower)' : 'Jev (escalated)'), jev: r.escalated ? 'abstained' : jevClass };
}

/** What the running turn is told about its class — for DIRECT and NARROW only; AGENT and PHASED run as they always have. */
function section(session) {
  const c = session && session._changeClass;
  if (!c || !c.class || session._role === 'bot') return '';
  if (c.class === CLASS.DIRECT) {
    return ['# Execution: DIRECT change',
      'This is a small, local edit. Do exactly this:',
      '1. Locate the owner of the target (the selection and its source binding are in context; otherwise search once).',
      '2. Make the minimal source patch that achieves it — no unrelated edits, no refactoring, no project survey.',
      '3. Verify: diagnostics for the file you touched' + (c.fromPreview ? ', and the element\'s geometry after the preview reloads' : '') + '.',
      '4. Report in one or two sentences: what changed, where.',
      'If the owner is ambiguous or the change turns out not to be local, say so in one line and stop.'].join('\n');
  }
  if (c.class === CLASS.NARROW) {
    return ['# Execution: NARROW change',
      'A structural change with a known shape. Work in this order and do not survey the whole project:',
      'locate the owner → identify its references (the project index and language server, not reading every file) → extract or move the data → update each consumer → run diagnostics → repair what broke → done.',
      'Keep the report short: the files changed and why.'].join('\n');
  }
  return '';
}

/** Record the class on the session for the turn about to run (cleared when it ends). */
function mark(session, result, extra = {}) {
  if (!session) return;
  session._changeClass = result ? { class: result.class, reasons: result.reasons, confidence: result.confidence, by: result.by || 'deterministic', at: Date.now(), ...extra } : null;
}

/** Is there a selection the request is about (the preview's, or a code selection in the IDE)? */
function selectionOf(app) {
  try { const sel = require('./harnesscontext').selection(app, app.session); return Boolean(sel && (sel.kind === 'visual' || sel.kind === 'text' || sel.kind === 'dom')); } catch { return false; }
}

/** A TURN BEGINS: classify (deterministically — Jev only when recruited), mark it, remember where the receipts stood. */
function begin(app, text, { fromPreview = false, via = null } = {}) {
  const s = app && app.session;
  if (!s) return null;
  const r = classify(text, { selection: selectionOf(app), fromPreview });
  mark(s, { ...r, by: 'deterministic' }, { fromPreview, via, text: String(text).slice(0, 200), receiptsFrom: (s.mutationReceipts || []).length });
  return r;
}

/** A TURN ENDED: a DIRECT or NARROW change leaves its result where the IDE's panel shows it (Quick changes). */
const QUICK_MAX = 20;
function end(app, { ok = true, why = null } = {}) {
  const s = app && app.session;
  const c = s && s._changeClass;
  if (!c) return null;
  s._changeClass = null;
  if (c.class !== CLASS.DIRECT && c.class !== CLASS.NARROW) return null;
  const rs = (s.mutationReceipts || []).slice(c.receiptsFrom || 0);
  const kept = rs.filter((r) => r && r.verdict === 'KEEP');
  const files = [...new Set(kept.flatMap((r) => r.targets || []))].slice(0, 20);
  const failed = rs.filter((r) => r && r.verdict && r.verdict !== 'KEEP').map((r) => ({ tool: r.tool, verdict: r.verdict }));
  const row = { at: Date.now(), class: c.class, text: c.text, files, ok: ok && !failed.length && files.length > 0, failed: failed.slice(0, 5), why: why || (files.length ? null : 'no file was changed'), fromPreview: Boolean(c.fromPreview), ms: Date.now() - (c.at || Date.now()) };
  s.quickChanges = [...(Array.isArray(s.quickChanges) ? s.quickChanges : []), row].slice(-QUICK_MAX);
  return row;
}

module.exports = { classify, decide, section, mark, begin, end, selectionOf, CLASS, ORDER };
