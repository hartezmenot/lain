'use strict';

/** WHAT KIND OF GROUNDING DOES THIS REQUEST NEED? */

const modeId = require('./mode');

const CLASS = Object.freeze({
  PROJECT_IMPLEMENTATION: 'PROJECT_IMPLEMENTATION',
  PROJECT_DIAGNOSTIC: 'PROJECT_DIAGNOSTIC',
  LIVE_EXTERNAL_DIAGNOSTIC: 'LIVE_EXTERNAL_DIAGNOSTIC',
  DIRECT_TOOL_TASK: 'DIRECT_TOOL_TASK',
  CONVERSATIONAL: 'CONVERSATIONAL',
});

/** What each class demands before work may proceed. See §13: routing must never weaken these. */
const GROUNDING = Object.freeze({
  PROJECT_STRICT: 'PROJECT_STRICT',        // architecture, ownership, mutation discipline, regression protection, verification
  PROJECT_DIAGNOSTIC: 'PROJECT_DIAGNOSTIC', // reads, tests, logs — no implementation demanded
  LIVE_DESKTOP: 'LIVE_DESKTOP',             // Computer MCP / native app / process — no project source required
  LIVE_BROWSER: 'LIVE_BROWSER',             // LAIN for Chrome — no project source required
  DIRECT: 'DIRECT',                         // one deterministic operation — minimal ceremony
  NONE: 'NONE',                             // conversational — nothing to ground
});

const GROUNDING_FOR = Object.freeze({
  [CLASS.PROJECT_IMPLEMENTATION]: GROUNDING.PROJECT_STRICT,
  [CLASS.PROJECT_DIAGNOSTIC]: GROUNDING.PROJECT_DIAGNOSTIC,
  [CLASS.LIVE_EXTERNAL_DIAGNOSTIC]: GROUNDING.LIVE_DESKTOP, // surface narrows it further, below
  [CLASS.DIRECT_TOOL_TASK]: GROUNDING.DIRECT,
  [CLASS.CONVERSATIONAL]: GROUNDING.NONE,
});

/** Classes that must NOT be told a project source or an implementation target is required. */
const PROJECT_SOURCE_REQUIRED = new Set([CLASS.PROJECT_IMPLEMENTATION]);

// --------------------------------------------------------------- signals ----

/** COMPUTER MCP, NAMED EXPLICITLY. */
const COMPUTER_MCP_RE = /\bcomputer\s*mcp\b/i;

/** A LIVE DESKTOP TARGET — a native application, a running process, the desktop itself, named either generically or by a common product name. */
const DESKTOP_NOUN_RE = /\b(?:calculator|notepad|task manager|control panel|device manager|explorer\.exe|the taskbar|start menu|system tray|the desktop|obs(?:\s+studio)?|task scheduler|registry editor|event viewer|resource monitor|the clipboard|desktop process)\b/i;
// "this desktop process", "this running app", "my open Notepad window" — up to two modifier words are allowed between the pointer word and the noun, so…
const RUNNING_THING_RE = /\b(?:running|open|native)\s+(?:app|application|window|process|program)\b|\bmy\s+(?:running|open)\s+[a-z][\w .-]{2,30}\b|\b(?:this|that)\s+(?:[\w-]+\s+){0,2}(?:app|application|window|process|program)\b|\bthe\s+window\s+(?:i|I)(?:'ve| have)?\s+(?:got|open)\b/i;

/** A live browsing session — the person's own Chrome, not the project preview. */
const LIVE_BROWSER_RE = /\b(?:chrome|browser)\s+tab\b|\bmy\s+(?:chrome|browser)\b|\bthe\s+tab\s+(?:i|I)(?:'ve| have)?\s+(?:got|open(?:ed)?)\b|\bcurrent(?:ly)?\s+open\s+(?:browser|tab|page)\b/i;

/** DIAGNOSTIC PHRASING ABOUT A LIVE TARGET — "is X working", "check whether Y responds", "diagnose why Z isn't seeing the device". */
const LIVE_DIAGNOSTIC_VERB_RE = /\b(?:diagnose|inspect|test whether|check whether|check if|verify (?:that|whether)?|is\s+\w[\w .'-]{0,40}\s+(?:working|responding|running|visible|seeing)|does\s+\w[\w .'-]{0,40}\s+(?:work|respond|see)|why\s+(?:isn'?t|is\s+not|won'?t|does\s+not)\b)/i;

/** A SINGLE, CONCRETE, DETERMINISTIC OPERATION — one imperative verb, one target, short. */
const DIRECT_VERB_RE = /^\s*(?:take\s+a\s+screenshot|screenshot|click|double[- ]click|right[- ]click|type\s+(?:into|in)|press|open\s+(?:this|that|the)\s+file|close\s+(?:this|that|the)\s+(?:window|tab|app)|check\s+whether\s+(?:the\s+)?process|check\s+if\s+(?:the\s+)?process)\b/i;
const INVESTIGATION_WORD_RE = /\b(?:diagnose|inspect|investigate|find out why|trace|figure out|debug)\b/i;
/** "use the browser", "in chrome", or a navigation verb straight at a URL. */
const BROWSER_OBSERVE_RE = /\b(?:use|using|with|in|via|through)\s+(?:the\s+|a\s+)?(?:browser|chrome)\b|\b(?:open|visit|load|go\s+to|navigate\s+to|look\s+at)\s+(?:the\s+(?:page|site|url)\s+(?:at\s+)?)?https?:\/\//i;
/** A request that also changes the project stays project work, browser or not. */
const PROJECT_CHANGE_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate)\b/i;

/** A FRONTEND PROJECT TASK — still PROJECT_IMPLEMENTATION (the project is still the target and needs every guard that class has), but a hint that the… */
const WORKSHOP_HINT_RE = /\b(?:mobile|responsive|viewport|breakpoint|react|vue|svelte|frontend|front-end|the\s+ui\b|component|css|stylesheet|the\s+button\b|the\s+page\b|the\s+form\b)\b/i;

/** mode the verdict from mode.js — reused, never re-derived projectEmpty no recognisable project attached to this session @returns {{cls, grounding… */
function classify(text, ctx = {}) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  const mode = ctx.mode || modeId.KIND.IMPLEMENT;

  const decide = (cls, surface, reason) => ({
    cls, grounding: GROUNDING_FOR[cls], surface,
    projectSourceRequired: PROJECT_SOURCE_REQUIRED.has(cls),
    reason,
  });

  // 1. COMPUTER MCP NAMED EXPLICITLY outranks everything — the person said the surface. Never re-routed into project implementation regardless of what…
  if (COMPUTER_MCP_RE.test(one)) {
    return decide(CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'computer-mcp', 'names Computer MCP explicitly');
  }

  // 2. A LIVE DESKTOP TARGET, named plus diagnostic phrasing, OR named with a running-thing phrase alone ("my running Calculator"). Two paths because…
  const desktopNoun = DESKTOP_NOUN_RE.test(one) || RUNNING_THING_RE.test(one);
  if (desktopNoun && (LIVE_DIAGNOSTIC_VERB_RE.test(one) || RUNNING_THING_RE.test(one))) {
    return decide(CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'computer-mcp', 'names a live desktop target with diagnostic phrasing');
  }

  // 3. A LIVE BROWSING SESSION — the person's own Chrome, not a project preview. "Look at the Chrome tab I have open" never implies the project needs…
  if (LIVE_BROWSER_RE.test(one)) {
    return decide(CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'chrome', 'names the person\'s own browser session');
  }

  // 3b. LOOK AT A PAGE IN A BROWSER AND SAY WHAT IT SHOWS. Live, 2026-09-18: "Use the browser to open http://127.0.0.1:18777 and tell me what the…
  if (BROWSER_OBSERVE_RE.test(one) && !PROJECT_CHANGE_RE.test(one)) {
    return { ...decide(CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'browser', 'asks for a page observed in a browser'), observe: true };
  }

  // 4. A DIRECT, SINGLE, DETERMINISTIC OPERATION — never an investigation.
  if (DIRECT_VERB_RE.test(one) && !INVESTIGATION_WORD_RE.test(one)) {
    // Which surface it lands on is exactly what desktop/browser signals above already answer for; a direct task with neither is assumed to mean the…
    const surface = LIVE_BROWSER_RE.test(one) ? 'chrome' : 'computer-mcp';
    return decide(CLASS.DIRECT_TOOL_TASK, surface, 'one concrete deterministic operation');
  }

  // 5. CONVERSATION. mode.js already decided this; consumed, not re-derived.
  if (mode === modeId.KIND.CHAT) {
    return decide(CLASS.CONVERSATIONAL, 'none', 'conversational — mode.js classified it as CHAT');
  }

  // 6. READ-ONLY PROJECT ASSESSMENT. "Find why this project crashes", "run the tests and tell me what's wrong" — evidence-gathering about the attached…
  if (mode === modeId.KIND.AUDIT || mode === modeId.KIND.EXPLAIN || mode === modeId.KIND.TROUBLESHOOT) {
    return decide(CLASS.PROJECT_DIAGNOSTIC, 'project-tools', `project-oriented assessment (mode: ${mode})`);
  }

  // 7. EVERYTHING ELSE IS PROJECT WORK — the mutating modes, and the default when nothing else applies. Every existing guard stays exactly as strict as…
  const surface = WORKSHOP_HINT_RE.test(one) ? 'workshop' : 'project-tools';
  return decide(CLASS.PROJECT_IMPLEMENTATION, surface, `project implementation (mode: ${mode})`);
}

/** Compact prose for the framed context block — see contextprovenance.js. */
function statusLine(verdict) {
  if (!verdict) return '';
  return `Task class: ${verdict.cls}\nGrounding: ${verdict.grounding}\n`
    + `Project source required: ${verdict.projectSourceRequired ? 'YES' : 'NOT REQUIRED'}`
    + (verdict.surface && verdict.surface !== 'none' ? `\nSuggested surface: ${verdict.surface}` : '');
}

module.exports = { CLASS, GROUNDING, classify, statusLine, PROJECT_SOURCE_REQUIRED };
