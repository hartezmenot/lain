'use strict';

/** WHAT KIND OF WORK IS THIS? */

// The task-identity verdict is CONSUMED, never re-derived.
const taskKinds = require('./task').KIND;

const KIND = Object.freeze({
  CHAT: 'CHAT',
  MIGRATE: 'MIGRATE',
  EXPLAIN: 'EXPLAIN',
  AUDIT: 'AUDIT',
  BUGFIX: 'BUGFIX',
  TROUBLESHOOT: 'TROUBLESHOOT',
  IMPLEMENT: 'IMPLEMENT',
  REFACTOR: 'REFACTOR',
  NEW_PROJECT: 'NEW_PROJECT',
  RESUME: 'RESUME',
});

/** Read-only modes. Nothing here should be writing to the user's files. */
const READ_ONLY = new Set([KIND.AUDIT, KIND.EXPLAIN, KIND.CHAT]);

// signals

/** "make me a X", "build a new Y from scratch" — nothing exists yet. */
const NEW_PROJECT_RE = /\b(?:create|build|make|write|scaffold|generate|start|set ?up|bootstrap)\b[^.?!]{0,40}\b(?:new |brand[- ]new |a |an |me a |me an )?(?:project|app|application|bot|tool|service|server|website|site|cli|library|package|game|dashboard|script)\b/i;
const FROM_SCRATCH_RE = /\bfrom scratch\b|\bnew project\b|\bgreenfield\b/i;

/** "audit", "review the codebase", "what's missing" — assess, do not change. */
const AUDIT_RE = /\b(?:audit|assess|review|inspect|analy[sz]e|evaluate|critique|compare|contrast|health[- ]check)\b/i;
const AUDIT_QUESTION_RE = /\bwhat(?:'s| is| are)?\b[^.?!]{0,30}\b(?:missing|wrong with|broken|left to do|the state of|not implemented)\b/i;
/** A yes/no JUDGEMENT asked of the code: "is the retry logic correct?", "any dead code in src/ui?". */
const JUDGE_RE = /^\s*(?:(?:is|are)\s+(?:the|this|my|our|these|that)\b[^?]{0,60}\b(?:correct|right|safe|sound|ok(?:ay)?|fine|in (?:good|bad) shape|well[- ]designed|thread[- ]safe|secure|idiomatic)\s*\??|what would you (?:improve|change|fix|do differently)\b.*|any (?:dead code|bugs?|issues|problems|leaks?|smells?|race conditions?)\b.*)\s*$/i;
/** What LAIN did or intends: "what did you change", "show me the plan". */
const REPORT_RE = /^\s*(?:what (?:did|have) you (?:change|changed|do|done|edit|edited|modify|modified|touch|touched|fix|fixed|write|written|add|added|remove|removed)\b[^.!,;]*|show me (?:the )?(?:plan|diff|changes|goal|what (?:you )?changed)(?:\s+(?:so far|again|please))?)\??\s*$/i;

/** "explain", "what does X do", "how does Y work" — describe, do not change. */
const EXPLAIN_RE = /\b(?:explain|describe|walk me through|what does\b|what do\b|how does\b|how do(?:es)?\b[^.?!]{0,20}\bwork|what is this|tell me (?:about|what|how)|summari[sz]e)\b/i;
/** Opens with an interrogative and is asked as a question. See rule 8c. */
const ASKED_RE = /^\s*(?:which|what|where|who|whom|whose|when|is|are|does|do|did|can|could|has|have)\b[^?]*\?/i;
const CHANGE_VERB_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate|install|upgrade|replace|move)\b/i;

/** A concrete failure: a named thing behaving in a named wrong way. */
const SYMPTOM_RE = /\b(?:doesn'?t|does not|won'?t|will not|isn'?t|is not|aren'?t|are not|can'?t|cannot|never|fails?|failing|failed|broken|breaks?|crash(?:es|ed|ing)?|hangs?|stuck|error|errors|exception|throws?|returns? (?:null|undefined|nothing|the wrong)|wrong|incorrect|empty|missing|not (?:working|updating|showing|saving|firing|switching|changing|responding))\b/i;
const BUG_NOUN_RE = /\b(?:bug|regression|defect|traceback|stack ?trace|500|404|nan|undefined is not)\b/i;
/** "it should X but Y" — the clearest possible statement of a defect. */
const EXPECTATION_RE = /\bshould\b[^.?!]{0,60}\b(?:but|instead|however|yet)\b/i;

/** Vague trouble: something is wrong and the user cannot say what. */
const VAGUE_RE = /\b(?:some(?:thing|how|where)|anything|not sure|no idea|dunno|weird|strange|odd|flaky|intermittent|randomly|sometimes|occasionally|seems? to|kind of|acting up)\b/i;

/** A complaint with no subject at all — "it doesn't work", "nothing happens". */
const NO_SUBJECT_RE = /^(?:it|this|that|things?|nothing|everything|stuff|the app|the thing)\b[^.?!]{0,40}$/i;

/** CHANGING THE SHAPE OF WORKING CODE, not what it does. */
// `move` IS A REFACTOR ONLY FOR CODE: "move it into core", "move the helper functions" — not "move the button down
// 6px", which is a visual change and was being given a restructuring brief (run the tests first) (2026-10-01).
const REFACTOR_RE = /\b(?:refactor|restructure|reorgani[sz]e|rewrite|clean ?up|tidy|simplify|de-?duplicate|dedupe|extract|inline|split (?:up|out|into)|move (?:it|them|this|that|these|those) (?:in)?to|move (?:the |this |that |these |those )?(?:\w+ )?(?:functions?|methods?|class(?:es)?|modules?|files?|folders?|code|logic|helpers?|utils?|types?|tests?|components?)|rename|modulari[sz]e|untangle|consolidate)\b/i;

/** "add", "implement", "support for" — build something that is not there yet. */
const IMPLEMENT_RE = /\b(?:add|implement|introduce|support|enable|integrate|wire ?up|hook ?up|expose|extend|create|build|make|write|refactor|rename|migrate|convert|replace|remove|delete|drop|update|change|improve|optimi[sz]e|port)\b/i;

/** Conversation, not work. */
const CHAT_WORD = '(?:hi|hey|hello|yo|thanks?|thank you|ta|cheers|ok(?:ay)?|cool|nice|great|perfect|got it|sounds good|never ?mind|nvm|sorry|no worries|wait|hmm+|lol|awesome|brilliant|all good|that (?:worked|works|did it|helped)|(?:it )?works now)';
/** WHO THE PLEASANTRY IS ADDRESSED TO. */
const CHAT_ADDRESS = '(?:there|again|all|team|mate|friend|folks|everyone|lain|bot)';
const CHAT_RE = new RegExp(
  `^\\s*${CHAT_WORD}(?:[\\s,.!?]+(?:${CHAT_WORD}|${CHAT_ADDRESS}))*[\\s.!?]*$`, 'i');

/** FIND IT, DO NOT CHANGE IT — "where is X", "what controls Y", "which file sets Z", "trace the call". */
const LOCATE_RE = /\b(?:where(?:'s| is| are| does| do)|which file|what (?:controls|sets|decides|calls|uses|defines|owns)|who (?:calls|sets|owns))\b|\b(?:find|locate|trace|track down|follow)\b[^.?!]{0,40}\b(?:where|what|which|the (?:code|function|file|place|caller|definition|call|path|flow|chain))\b/i;

/** A question with no imperative — the user wants an answer, not an edit. */
const QUESTION_RE = /^[^.!]*\?\s*$/;

/** THE PERSON SAID, IN SO MANY WORDS, THAT NOTHING IS TO CHANGE. */
// A prohibition is a DECLARATION only when it ends its clause: "Do not modify any file." is; "…any file in src/legacy", "…anything else", "…any changes…
const CLAUSE_END = String.raw`(?=\s*(?:[.,;:!?)\n—]|$))`;
const READ_ONLY_DECLARED_RE = new RegExp([
  // Opens with it, standing alone: "READ-ONLY.", "Read only please", "read-only:".
  String.raw`^\W{0,3}read[- ]?only(?:\s+(?:please|pls))?\s*(?:[.!:;—\n]|$)`,
  // "READ-ONLY PROJECT INSPECTION", "a read-only review/trace/task".
  String.raw`\bread[- ]?only\s+(?:project\s+)?(?:task|inspection|investigation|review|audit|analysis|exploration|pass|trace|report|diagnostic|diagnosis)\b`,
  String.raw`\b(?:this (?:task )?is|keep (?:this|it)|stay|remain|strictly|purely)\s+read[- ]?only\b`,
  String.raw`\b(?:do not|don'?t|never|must not)\s+(?:modify|change|edit|touch|alter|write to)\s+(?:any|a single)\s+(?:file|files|code|source(?: files?)?)${CLAUSE_END}`,
  String.raw`\b(?:do not|don'?t|never)\s+(?:modify|change|edit|touch|alter)\s+anything${CLAUSE_END}`,
  String.raw`\b(?:do not|don'?t)\s+make\s+(?:any\s+)?(?:changes|edits|modifications)${CLAUSE_END}`,
  String.raw`\bwithout\s+(?:changing|modifying|editing|touching)\s+(?:anything|any (?:file|files|code))${CLAUSE_END}`,
].join('|'), 'i');

/** Does the text DECLARE this task read-only? See READ_ONLY_DECLARED_RE. */
function declaresReadOnly(text) { return READ_ONLY_DECLARED_RE.test(String(text == null ? '' : text)); }

/** Classify a request into a workflow mode. */
function classify(text, ctx = {}) {
  return { ...classifyMode(text, ctx), intent: intent(text) };
}

function classifyMode(text, ctx = {}) {
  const raw = String(text == null ? '' : text);
  const s = raw.trim();
  const one = s.replace(/\s+/g, ' ');

  const decide = (mode, reason) => ({ mode, reason, readOnly: READ_ONLY.has(mode), declaredReadOnly: false, deterministic: true });

  // 1. A CONTINUATION KEEPS ITS MODE. "continue" says nothing about what kind of work this is — the work already running decides that. Re-classifying it…
  if (ctx.taskKind === taskKinds.CONTINUATION) {
    return decide(ctx.activeMode || KIND.RESUME, 'continuing the active task');
  }

  // 2. A PASTE THAT JOINS WORK IS CONTENT. The terminal told us structurally. A pasted stack trace is full of "error" and "failed" and is not a bug…
  if (ctx.isPaste && ctx.joinsActiveTask !== false) {
    return decide(ctx.activeMode || KIND.IMPLEMENT, 'pasted content, not a new request');
  }

  if (!one) return decide(KIND.CHAT, 'empty input');

  const v = byWords(one, ctx, decide);
  // 2b. A DECLARED READ-ONLY TASK IS READ-ONLY, whatever else its words match. A brief that says "do not modify any file" and then lists what must not be…
  if (declaresReadOnly(s)) {
    if (READ_ONLY.has(v.mode) && v.mode !== KIND.CHAT) return { ...v, reason: `${v.reason}; declared read-only`, declaredReadOnly: true };
    const explain = EXPLAIN_RE.test(one) || LOCATE_RE.test(one);
    return { ...decide(explain ? KIND.EXPLAIN : KIND.AUDIT, 'declared read-only: nothing is to change'), declaredReadOnly: true };
  }
  return v;
}

// THE FORM OF THE REQUEST, beside its mode
const QUESTION_FORM_RE = /\?\s*$|^(?:why|what|how|where|when|which|who|explain|describe|show me|tell me)\b/i;
const NAVIGATE_RE = /^\s*(?:please\s+)?(?:open|show|go to|go back to|take me to|bring up|display|jump to|navigate to)\b/i;
const SETTING_RE = /\b(?:use|switch(?:\s+to)?|set|assign|pick|choose)\b[\s\S]*\b(?:model|opus|sonnet|haiku|fable|gpt[-\w.]*|gemini|claude|glm|coding agent|the bot)\b/i;
const CONNECT_RE = /^\s*(?:please\s+)?(?:add|connect|set up)\b[\s\S]*\b(?:telegram|whatsapp|discord|api key|account|provider|mcp server)\b/i;
const PLAN_RE = /^\s*(?:please\s+)?(?:(?:lets|let.s|let us|can you|could you)\s+)?(?:plan|draft|design|propose|outline|research|investigate|compare|brainstorm|think|discuss|consider|evaluate|review|analy[sz]e|assess|summari[sz]e|estimate|scope)\b|\b(?:make|write|draft|give me|come up with)\s+(?:a|an|the)\s+(?:plan|proposal|outline|design|approach)\b/i;
const INTENT_CHANGE_RE = /\b(?:rename|refactor|implement|fix|rewrite|delete|remove|replace|edit|modify|extract|migrate|convert|debug|patch|write|create|build)\b/i;

/** { question, navigate, setting, plan } — what the words ask FOR, as opposed to what kind of work they name. */
function intent(text) {
  const t = String(text == null ? '' : text).trim();
  const rest = t.replace(/^\s*(?:please\s+)?\S+/, '');
  return {
    question: QUESTION_FORM_RE.test(t),
    navigate: NAVIGATE_RE.test(t) && !INTENT_CHANGE_RE.test(rest),
    setting: (SETTING_RE.test(t) && !/\.[a-z]{1,4}\b/i.test(t) && !INTENT_CHANGE_RE.test(t)) || CONNECT_RE.test(t),
    plan: PLAN_RE.test(t),
  };
}

/** The word rules, in precedence order. Split out so a declaration can overrule their answer. */
function byWords(one, ctx, decide) {

  // 3. Pleasantries. Cheap to detect and it stops "thanks!" scanning a repo.
  if (CHAT_RE.test(one)) return decide(KIND.CHAT, 'conversational');

  // 4. A NEW PROJECT outranks IMPLEMENT, because "build a trading bot" and "build a login form" share a verb and mean very different things. The object…
  if (FROM_SCRATCH_RE.test(one)) return decide(KIND.NEW_PROJECT, 'asks for something built from scratch');
  if (NEW_PROJECT_RE.test(one)) {
    // In an existing project, "build a dashboard" is a feature, not a new repo.
    if (ctx.projectEmpty) return decide(KIND.NEW_PROJECT, 'names a whole project and there is nothing here yet');
    return decide(KIND.IMPLEMENT, 'names a component to build inside the existing project');
  }

  // 5. AUDIT before EXPLAIN: "review this project" is an assessment, and both
  //    are read-only so a wrong call between them is cheap.
  if (AUDIT_RE.test(one) || AUDIT_QUESTION_RE.test(one) || JUDGE_RE.test(one)) return decide(KIND.AUDIT, 'asks for an assessment');
  // "what did you change", "show me the plan" — a report on the work, not work.
  if (REPORT_RE.test(one)) return decide(KIND.EXPLAIN, 'asks what was done or planned');

  // 6. A DEFECT. "should X but Y" is unambiguous; otherwise a symptom word
  //    plus something concrete to attach it to.
  if (EXPECTATION_RE.test(one)) return decide(KIND.BUGFIX, 'states expected behaviour against actual');
  const symptom = SYMPTOM_RE.test(one) || BUG_NOUN_RE.test(one);
  if (symptom) {
    // VAGUE trouble is a different job: the cause is unknown, so the first move
    // is to narrow it down rather than to edit anything.
    if (VAGUE_RE.test(one) || NO_SUBJECT_RE.test(one)) {
      return decide(KIND.TROUBLESHOOT, 'reports a problem without saying where it is');
    }
    return decide(KIND.BUGFIX, 'reports a specific thing behaving wrongly');
  }

  // 7. VAGUE UNEASE with no symptom word at all — "the app is being weird", "it's acting up". There is a problem and no statement of what it is, which is…
  if (VAGUE_RE.test(one)) return decide(KIND.TROUBLESHOOT, 'reports unease without a specific symptom');

  // 8. EXPLAIN — after defects, so "explain why it crashes" is a bug, not a
  //    lecture request.
  if (EXPLAIN_RE.test(one)) return decide(KIND.EXPLAIN, 'asks for an explanation');

  // 8b. LOCATING SOMETHING IS READING, NOT WRITING. After defects for the same reason EXPLAIN is — "find why it crashes" is a bug report — and before the…
  if (LOCATE_RE.test(one)) return decide(KIND.EXPLAIN, 'asks where something is, not for it to change');

  // 8c. A PLAIN QUESTION. "Which function in src/pricing.js applies the tier discount? Answer in one line." fell through to IMPLEMENT (live, 2026-09-18)…
  if (ASKED_RE.test(one) && !CHANGE_VERB_RE.test(one)) return decide(KIND.EXPLAIN, 'asks a question, not for a change');

  // 9. A MIGRATION — a real STATE TRANSITION (dispatch.js, 2026-09-24).
  if (require('./dispatch').migrationTransition(one).eligible) {
    return decide(KIND.MIGRATE, 'asks for a structural migration: the final state must not contain the old thing');
  }

  // 9b. REFACTOR before IMPLEMENT — they share verbs, and only this one is
  //    about code that already works. See REFACTOR_RE.
  if (REFACTOR_RE.test(one)) return decide(KIND.REFACTOR, 'asks to restructure code that already works');

  // 10. IMPLEMENT — an imperative to change the code.
  if (IMPLEMENT_RE.test(one)) return decide(KIND.IMPLEMENT, 'asks for a change to the code');

  // 9. A bare question with no imperative is a question.
  if (QUESTION_RE.test(one)) return decide(KIND.CHAT, 'a question with nothing to change');

  // 10. Default. Most bare statements in a coding CLI are work, and IMPLEMENT
  //     carries the "look before you leap" guidance — the safest default hint.
  return decide(KIND.IMPLEMENT, 'no clearer signal; treated as work to do');
}

/** Does this text point at something concrete? */
function namesSomething(text) {
  const t = String(text || '');
  if (/[\w-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|rb|cs|php|json|yml|yaml|html|css|sh|ps1)\b/i.test(t)) return true;
  if (/[/\\][\w.-]+/.test(t)) return true;                       // a path
  if (/`[^`]+`|"[^"]+"|'[^']+'/.test(t)) return true;            // a quoted thing
  if (/\b[a-z]+[A-Z]\w*\b/.test(t)) return true;                 // camelCase
  if (/\b\w+_\w+\b/.test(t)) return true;                        // snake_case
  if (/\b\w+\(\)/.test(t)) return true;                          // a call
  if (/\b[A-Z][a-z]+[A-Z]\w*\b/.test(t)) return true;            // PascalCase
  // A noun the user capitalised mid-sentence is usually a product or component.
  if (/\S\s+[A-Z][a-z]{2,}/.test(t)) return true;
  return false;
}

module.exports = { KIND, READ_ONLY, classify, intent, namesSomething, declaresReadOnly };
