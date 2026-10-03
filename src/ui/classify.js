'use strict';

/** WHAT KIND OF THING DID THE MODEL JUST SAY — named, once, in one place. */

/** THE ELEVEN THINGS A VISIBLE MESSAGE CAN BE. */
const CLASS = Object.freeze({
  /** "Let me inspect router.js." — the screen is already saying this. */
  OPERATIONAL_INTENT: 'OPERATIONAL_INTENT',
  /** "Ok." · "The user wants the runner traced." — words about the words. */
  SELF_NARRATION: 'SELF_NARRATION',
  /** "Hmm." · "Actually, let me reconsider." · "Should I read the loader?" */
  INTERNAL_RECONSIDERATION: 'INTERNAL_RECONSIDERATION',
  /** "The flag parses but is never dispatched." — established, and it matters. */
  FINDING: 'FINDING',
  /** "This may indicate the loader is initialized twice." — NOT established. */
  HYPOTHESIS: 'HYPOTHESIS',
  /** "Permission is required before modifying configuration." */
  BLOCKER: 'BLOCKER',
  /** A question put to the PERSON, which is the most important line LAIN writes. */
  ASK_USER: 'ASK_USER',
  /** "The build failed with exit 1." */
  ERROR: 'ERROR',
  /** "The tests pass." */
  COMPLETION: 'COMPLETION',
  /** The closing report: Issue / Fix / Changed / Verified / How to run. */
  SUMMARY: 'SUMMARY',
  /** Prose that is none of the above. Kept, because unknown is not noise. */
  OTHER: 'OTHER',
});

/** WHAT HAPPENS TO A CLASS. */
const DECISION = Object.freeze({
  SUPPRESS: 'SUPPRESS',
  SHOW: 'SHOW',
  PRESERVE: 'PRESERVE',
});

// vocabulary

/** Past this, a line is carrying more than an announcement. */
const MAX_LINE = 110;

/** TWO KINDS OF VERB, and they are held apart because the rescue differs. */
const LOOK = '(?:read|re-?read|check|re-?check|look|take\\s+a\\s+look|inspect|examine|open|'
  + 'review|search|grep|scan|find|locate|see|verify|confirm|investigate|trace|'
  + 'explore|dig|peek|walk\\s+through|trace\\s+through)';
const DO = '(?:run|start|kick\\s+off|test|try|fix|update|patch|add|write|make|do|go|'
  + 'move|continue|proceed|begin)';

/** "Let me think about what might be happening here." — announced deliberation. */
const THINK = '(?:think|consider|reconsider|reason\\s+about|figure\\s+out|work\\s+out|'
  + 'understand|get\\s+a\\s+sense|make\\s+sense\\s+of|puzzle\\s+out|mull)';

/** The openers. Optional stage-setting words, then a first-person intention. */
const LEAD = '(?:(?:so|ok|okay|alright|right|good|great|now|next|then|first|firstly|'
  + 'finally|also|additionally|meanwhile|'
  + 'perhaps|maybe|possibly|'
  // DISCOURSE MARKERS AND HEDGES, AND BOTH ARE LOAD-BEARING
  + 'actually|hmm+|wait|but\\s+wait|in\\s+fact|honestly|'
  + 'i\\s+think|i\\s+guess|i\\s+suspect|i\\s+wonder|i\\s+believe)[,:.]?\\s+|next\\s+up[,:]\\s+'
  + '|(?:while|once|after|before|when)\\s[^,.!?]{0,60},\\s+)*';
const INTENT = '(?:i\\s*(?:\'|’)?\\s*ll|i\\s+will|i\\s*(?:\'|’)?m\\s+going\\s+to|'
  + 'i\\s+am\\s+going\\s+to|i\\s+need\\s+to|i\\s+want\\s+to|i\\s+should|i\\s+am\\s+about\\s+to|'
  + 'let\\s+me|let\\s+us|let\\s*(?:\'|’)?s|we\\s*(?:\'|’)?ll|we\\s+will|going\\s+to|'
  + 'we\\s+could|i\\s+could|we\\s+might|i\\s+might|we\\s+should|'
  + 'time\\s+to|next\\s+up[,:]?)';
const HEDGE = '(?:just|quickly|now|also|first|then|briefly|next|probably|maybe|perhaps|'
  + 'go\\s+ahead\\s+and)\\s+';

/** ONE SENTENCE, AND THE DOT IN A FILENAME IS NOT THE END OF IT. */
const ONE_SENTENCE = '(?:[^.!?]|[.](?![\\s]|$))*[.!?…]*\\s*$';
const ANNOUNCE_LOOK = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${LOOK}\\b${ONE_SENTENCE}`, 'i');
const ANNOUNCE_DO = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${DO}\\b${ONE_SENTENCE}`, 'i');
const ANNOUNCE_THINK = new RegExp(
  `^\\s*${LEAD}${INTENT}\\s+(?:${HEDGE})*${THINK}\\b${ONE_SENTENCE}`, 'i');

/** A line that is only stage-setting or thinking noise, split into the two classes it was always two of. */
const REVISION_WORD = '(?:hmm+|huh|wait|hold\\s+on|actually|interesting|'
  + 'let\\s*(?:\'|’)?s\\s+see|let\\s+me\\s+(?:think|reconsider|check\\s+again)|'
  + 'one\\s+(?:sec|second|moment)|anyway|moving\\s+on)';
const ACK_WORD = '(?:ok|okay|alright|right|good|great|perfect|excellent|nice|got\\s+it|'
  + 'understood|sure|but|so|well|now|then|makes\\s+sense|that\\s+makes\\s+sense|'
  + 'as\\s+expected|so\\s+far\\s+so\\s+good)';
const SEP = '[\\s,.!?…:;-]';
/** A CHAIN OF THEM IS STILL ONE OF THEM. */
const REVISION = new RegExp(`^\\s*(?:(?:${REVISION_WORD}|${ACK_WORD})${SEP}*)*`
  + `${REVISION_WORD}(?:${SEP}*(?:${REVISION_WORD}|${ACK_WORD}))*${SEP}*$`, 'i');
const ACKNOWLEDGEMENT = new RegExp(`^\\s*(?:${ACK_WORD}${SEP}*)+$`, 'i');
/** Either of the two, which is the test the editing pass asks. */
const FILLER = new RegExp(`^\\s*(?:(?:${REVISION_WORD}|${ACK_WORD})${SEP}*)+$`, 'i');

/** A WHOLE LINE THAT RESTATES THE REQUEST, anywhere in the message. */
const RESTATES = new RegExp(
  '^\\s*(?:so\\s+)?(?:the\\s+user\\s+(?:wants|is\\s+asking|asked|would\\s+like|needs)'
  + '|you\\s+(?:want|asked|wanted|need)\\s+me\\s+to'
  + '|as\\s+(?:you\\s+)?requested'
  + '|based\\s+on\\s+your\\s+request'
  + '|per\\s+your\\s+request)\\b[^.!?]*[.!?]?\\s*$', 'i');

/** A line that carries a RESULT is never an announcement, whatever it opens with. */
const CALL = '[A-Za-z_$][\\w$]*\\(';
const CARRIES_RESULT = new RegExp(
  '(?:`|:\\d+|\\b\\d+\\b'
  + '|[\\w-]+\\.(?:js|ts|py|go|rs|java|rb|json|md|yml|yaml|toml|sh|ps1|txt|html|css)\\b'
  + `|${CALL}|→|->)`, 'i');

/** WHAT A FINDING SOUNDS LIKE WHEN IT NAMES NO FILE. */
const ASSERTS = new RegExp(
  '\\b(?:never|always|still|only|instead|no\\s+longer|missing|absent|unwired|unused|'
  + 'duplicated|twice|neither|but|however|does\\s*n[o’\']t|do\\s*n[o’\']t|is\\s*n[o’\']t|'
  + 'are\\s*n[o’\']t|was\\s*n[o’\']t|were\\s*n[o’\']t|cannot|can\\s*n[o’\']t|fails\\s+to|'
  + 'without|before\\s+it|out\\s+of\\s+order'
  + ')\\b', 'i');

/** A REASON — the one thing that rescues an announcement about LOOKING. */
const REASON = /\b(?:because|but|however|although|since|so\s+that|to\s+see\s+if|to\s+confirm|to\s+rule\s+out|in\s+case|instead\s+of|rather\s+than)\b/i;

/** A QUESTION THE MODEL IS ASKING ITSELF, IN PUBLIC. */
const SELF_ASK = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:should|shall|can|could|do|must|ought)\\s+(?:i|we)\\b[^?]*'
  + '\\bask(?:_user|\\s+(?:the\\s+)?user)?\\b[^?]*\\?\\s*$', 'i');

/** THE SAME SELF-QUESTION, HEDGED — and a model hedges constantly. */
const SELF_ASK_HEDGED = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:(?:maybe|perhaps)\\s+(?:i|we)\\s+(?:should|could|might|ought\\s+to|need\\s+to)\\s+'
  + '|(?:i|we)\\s+wonder\\s+(?:if|whether)\\s+(?:i|we)\\s+(?:should|could|might|ought\\s+to|need\\s+to)\\s+'
  + '|is\\s+it\\s+worth\\s+)'
  + '[^?]*\\bask(?:ing|_user)?\\b', 'i');

const SELF_LOOK = new RegExp(
  '^\\s*(?:so\\s+|but\\s+|hmm[,.]?\\s+|actually[,.]?\\s+)?'
  + '(?:should|shall|can|could|do|does|must|ought|maybe|perhaps)\\s+(?:i|we)\\s+'
  + `(?:should\\s+|need\\s+to\\s+|have\\s+to\\s+|also\\s+|first\\s+|just\\s+)*${LOOK}\\b[^?]*\\?\\s*$`, 'i');

/** " or " means a choice is being offered, and a choice is for the user. */
const OFFERS_CHOICE = /\bor\b/i;

/** A QUESTION PUT TO THE PERSON. */
const ASKS_USER = /\?\s*$/;
const SECOND_PERSON = /\b(?:you|your|you're|you’re|shall\s+i|would\s+you|do\s+you\s+want|which\s+would)\b/i;

/** A BLOCKER — a wall named, with the work stopped in front of it. */
const BLOCKED = new RegExp(
  '\\b(?:'
  + 'i\\s+(?:cannot|can\'t|can’t|am\\s+unable\\s+to|am\\s+blocked)'
  + '|blocked\\s+(?:on|by)|permission\\s+is\\s+required|requires?\\s+permission'
  + '|needs?\\s+(?:your\\s+)?approval|not\\s+authori[sz]ed|access\\s+denied'
  + '|rate\\s+limit(?:ed)?|quota\\s+(?:reached|exhausted)|credential\\s+is\\s+missing'
  + '|no\\s+credential|waiting\\s+for\\s+you'
  + ')\\b', 'i');

/** AN ERROR — something ran and did not work. Names the failure, not a risk. */
const FAILED = new RegExp(
  '\\b(?:'
  + 'failed|failing|fails|error|errors|exception|traceback|stack\\s+trace|crashed|'
  + 'exit(?:ed\\s+with)?\\s+(?:code\\s+)?[1-9]|non-?zero\\s+exit|refused|rejected|'
  + 'timed\\s+out|not\\s+found|undefined\\s+is\\s+not'
  + ')\\b', 'i');

/** A COMPLETION — a claim that something now works, stated as done. */
const COMPLETED = new RegExp(
  '\\b(?:'
  + 'tests?\\s+(?:now\\s+)?pass(?:es|ed)?|all\\s+(?:tests|checks)\\s+pass|suite\\s+is\\s+green|'
  + '(?:is|are|now)\\s+(?:fixed|working|green|passing|resolved|done|complete)|'
  + 'no\\s+(?:failures|regressions)'
  + ')', 'i');
const DONE_ALONE = /^\s*(?:done|fixed|complete|completed|all\s+green)\s*[.!]?\s*$/i;

/** A HYPOTHESIS — a cause offered, explicitly not established. */
const HEDGED = new RegExp(
  '\\b(?:'
  + 'may\\s+(?:indicate|mean|be|have|suggest)|might\\s+(?:be|have|indicate|mean|explain)|'
  + 'appears?\\s+to|seems?\\s+to|seems\\s+like|looks\\s+like|'
  + 'likely|probably|possibly|presumably|suggests?\\s+that|'
  + 'suspect|i\\s+think|my\\s+guess|could\\s+(?:be|explain|indicate)|'
  + 'not\\s+established|unconfirmed|hypothesis'
  + ')\\b', 'i');

/** THE SUMMARY SCHEMA — the closing report's own section labels. */
const SCHEMA_WORDS = Object.freeze([
  'issue', 'problem', 'cause', 'root cause', 'fix', 'change', 'changed', 'changes',
  'verified', 'verification', 'how to run', 'how to test',
  'limitations', 'limitation', 'remaining', 'next', 'next steps', 'summary', 'result',
]);
/** A line that is nothing but a schema word, with optional markup and colon. */
const SCHEMA_HEADING = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(${SCHEMA_WORDS.join('|')})\\s*(?:\\*\\*|__)?\\s*:?\\s*$`, 'i');

/** WHERE ONE SENTENCE ENDS AND THE NEXT BEGINS. */
const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-Z“‘"'(\[])/;

/** A fence opens or closes here. Everything between is code and is untouched. */
const FENCE = /^\s*(?:```|~~~)/;

// ------------------------------------------------------------- the rules ---

/** WHICH CLASS IS THIS ONE SENTENCE, and WHY. */
function classifySentence(text, ctx = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { class: CLASS.OTHER, why: 'empty' };

  // THE QUESTION, BEFORE ANY SUPPRESSING RULE CAN REACH IT
  if (SELF_ASK.test(t) || (SELF_ASK_HEDGED.test(t) && !SECOND_PERSON.test(t))) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'a question about whether to ask, addressed to nobody' };
  }
  if (ASKS_USER.test(t) && (OFFERS_CHOICE.test(t) || SECOND_PERSON.test(t)) && !SELF_LOOK.test(t)) {
    return { class: CLASS.ASK_USER, why: 'a question addressed to the user' };
  }
  if (SELF_LOOK.test(t) && !OFFERS_CHOICE.test(t)) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'deliberation about looking, asked out loud' };
  }

  // THE SEAMS OF A MONOLOGUE
  if (REVISION.test(t)) return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'a revision marker with nothing attached' };
  if (ACKNOWLEDGEMENT.test(t)) return { class: CLASS.SELF_NARRATION, why: 'an acknowledgement with nothing attached' };
  if (RESTATES.test(t)) return { class: CLASS.SELF_NARRATION, why: 'restates the request back to the person who wrote it' };

  // ANNOUNCEMENTS, AND WHAT RESCUES EACH KIND
  const long = t.length > MAX_LINE;
  const result = CARRIES_RESULT.test(t);
  const reason = REASON.test(t);
  if (!long && ANNOUNCE_LOOK.test(t) && !reason) {
    // Naming the file does not rescue this one: the file is the half the
    // timeline is best at, drawn in full one row lower.
    return { class: CLASS.OPERATIONAL_INTENT, why: 'announces a look the timeline already draws, with no reason given' };
  }
  if (!long && ANNOUNCE_DO.test(t) && !result && !reason) {
    return { class: CLASS.OPERATIONAL_INTENT, why: 'announces an action the timeline already draws' };
  }
  if (!long && ANNOUNCE_THINK.test(t) && !result && !reason) {
    return { class: CLASS.INTERNAL_RECONSIDERATION, why: 'announces that thinking is about to happen' };
  }

  // A WALL, AND A FAILURE
  if (BLOCKED.test(t)) return { class: CLASS.BLOCKER, why: 'names a wall the work stopped at' };
  if (FAILED.test(t)) return { class: CLASS.ERROR, why: 'names something that failed' };

  // WHAT WAS FINISHED
  if (DONE_ALONE.test(t) || COMPLETED.test(t)) {
    return { class: CLASS.COMPLETION, why: 'claims something is now done or passing' };
  }

  // ---- OFFERED, NOT ESTABLISHED -----------------------------------------
  if (HEDGED.test(t)) return { class: CLASS.HYPOTHESIS, why: 'offers a cause and marks it as unestablished' };

  // ---- ESTABLISHED, AND WORTH THE LINE ----------------------------------
  if (result) return { class: CLASS.FINDING, why: 'names a file, a symbol, a number or a call' };
  if (ASSERTS.test(t)) return { class: CLASS.FINDING, why: 'asserts that something expected does not happen' };
  return { class: CLASS.OTHER, why: 'prose that matches no rule — kept, because unknown is not noise' };
}

/** Every sentence in a message, fences excluded — the unit this file works in. */
function sentencesOf(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text == null ? '' : text).split('\r\n').join('\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line.trim()) continue;
    for (const part of line.split(SENTENCE_SPLIT)) if (part.trim()) out.push(part.trim());
  }
  return out;
}

/** How many of the closing schema's own headings this message carries. */
function schemaHeadings(text) {
  let n = 0;
  let fenced = false;
  for (const line of String(text == null ? '' : text).split('\r\n').join('\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (SCHEMA_HEADING.test(line)) { n += 1; continue; }
    // `How to run: npm start` is a heading AND its content on one line — the
    // form the prompt asks for by name. ui/markdown.js draws it as a callout.
    if (/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*how\s+to\s+(?:run|test)\b/i.test(line)) n += 1;
  }
  return n;
}

/** WHICH CLASS IS THIS WHOLE MESSAGE. */
function classifyVisibleMessage(text, ctx = {}) {
  const src = String(text == null ? '' : text);
  const sentences = sentencesOf(src).map((s) => ({ text: s, ...classifySentence(s, ctx) }));
  const headings = schemaHeadings(src);
  if (headings >= 2) {
    return { class: CLASS.SUMMARY, why: `carries ${headings} of the closing schema's own headings`, sentences };
  }
  // THE MOST CONSEQUENTIAL SENTENCE WINS, in the order the classes are declared to matter.
  const rank = [CLASS.ASK_USER, CLASS.BLOCKER, CLASS.ERROR, CLASS.FINDING,
    CLASS.HYPOTHESIS, CLASS.COMPLETION, CLASS.OTHER,
    CLASS.OPERATIONAL_INTENT, CLASS.INTERNAL_RECONSIDERATION, CLASS.SELF_NARRATION];
  for (const k of rank) {
    const hit = sentences.find((s) => s.class === k);
    if (hit) return { class: k, why: hit.why, sentences };
  }
  return { class: CLASS.OTHER, why: 'nothing was said', sentences };
}

/** WHAT THE FEED DOES WITH A CLASS — the policy, written once. */
function renderPolicy(cls) {
  const quiet = cls === CLASS.OPERATIONAL_INTENT
    || cls === CLASS.SELF_NARRATION
    || cls === CLASS.INTERNAL_RECONSIDERATION;
  if (quiet) return DECISION.SUPPRESS;
  // NEVER FOLDED AWAY. These three are the classes most likely to carry no
  // filename and most costly to lose — see DECISION.PRESERVE.
  if (cls === CLASS.HYPOTHESIS || cls === CLASS.ASK_USER || cls === CLASS.BLOCKER) {
    return DECISION.PRESERVE;
  }
  return DECISION.SHOW;
}

/** THE DIAGNOSTIC VIEW — raw candidate, class, decision, reason. */
function explain(text, ctx = {}) {
  return sentencesOf(text).map((s) => {
    const c = classifySentence(s, ctx);
    return { text: s, class: c.class, decision: renderPolicy(c.class, ctx), why: c.why };
  });
}

module.exports = {
  CLASS, DECISION,
  classifyVisibleMessage, classifySentence, renderPolicy, explain, sentencesOf,
  schemaHeadings,
  // The vocabulary, for ui/condense.js — which does the EDITING this classifies.
  MAX_LINE, CARRIES_RESULT, SENTENCE_SPLIT, FENCE, FILLER, SCHEMA_HEADING, SCHEMA_WORDS,
};
