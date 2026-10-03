'use strict';

/** HOW A TOOL CALL IS SAID — the vocabulary layer, and nothing else. */

/** The glyph that starts a row: outcome first, before any word. */
const MARK = { done: '✓', active: '●', todo: '○', dropped: '✗', error: '✗' };

/** A tool call, said the way a person would say it. */
/** THE SUBJECT OF A SHELL COMMAND is the command, and its VERB is the program. */
/** WHAT SEPARATES A TOOL ROW'S VERB FROM ITS SUBJECT. */
const SUBJECT_SEP = '·';

function shellParts(command) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  if (!c) return { verb: 'shell', subject: '' };
  const cut = c.indexOf(' ');
  const head = cut < 0 ? c : c.slice(0, cut);
  const rest = cut < 0 ? '' : c.slice(cut + 1);
  // THE PROGRAM, NOT THE PATH TO IT. `C:\\Python311\\python.exe` is `python`.
  const prog = head.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|sh)$/i, '') || head;
  return { verb: prog, subject: rest };
}

/** A TOOL CALL, AS `verb · subject`. */
function phrase(name, target, running = false) {
  const t = String(target || '');
  // A search's subject is its PATTERN, and `describeTarget` hands it over
  // wrapped in slashes — the tool's own spelling of the question.
  const pat = /^\/(.*)\/$/.test(t) ? t.slice(1, -1) : t;
  const two = (verb, subject) => (subject ? `${verb} ${SUBJECT_SEP} ${subject}` : verb);
  if (/^run_(bash|powershell|cmd)$/.test(name)) {
    const { verb, subject } = shellParts(t);
    return two(verb, subject);
  }
  const say = {
    read_file: () => two('read', t),
    write_file: () => two('wrote', t),
    edit_file: () => two('edited', t),
    list_dir: () => two('list', t || 'the project'),
    grep: () => two('search', pat),
    glob: () => two('find', pat),
    web_fetch: () => two('fetch', t),
    plan_write: () => 'plan',
    plan_step_done: () => 'plan · step done',
    ask_user: () => 'asked you',
    run_tests: () => two('test', t),
    discover_tests: () => two('test', t || 'discover'),
    verify_task: () => two('verify', t),
    service_start: () => two('service', t),
    service_check: () => two('service', t),
    observe: () => two('observe', t),
    // THE SURGICAL EDITS KEEP THEIR OWN VERBS.
    apply_patch: () => two('patched', t),
    append_file: () => two('appended', t),
    insert_at: () => two('inserted', t),
    delete_range: () => two('deleted lines', t),
    move_file: () => two('moved', t),
    delete_file: () => two('deleted', t),
    file_info: () => two('stat', t),
    dependents: () => two('imports of', t),
    symbols: () => two('symbol', t),
    // THE BRIDGE, NAMED AS THE BRIDGE — an action carried out by something other
    // than LAIN, which is worth a word of its own.
    computer: () => two('computer', t),
    // BACKGROUND WORK IN THE PERSON'S WORDS (2026-10-01): never `job wait` / `run background` on screen.
    run_background: () => two('shell (background)', t),
    job_wait: () => two('waited for shell', t),
    job_status: () => two('checked shell', t),
    job_stop: () => two('stopped shell', t),
    observe_start: () => two('monitor', t),
    observe_stop: () => two('monitor stopped', t),
    delegate: () => two('agent', t),
  }[name];
  if (!say) return two(String(name || '').replace(/_/g, ' '), t);
  return say();
}

/** The one-word verb a call is COUNTED under when a run of them is compacted. */
const VERB_OF = {
  read_file: 'Read', list_dir: 'Read', file_info: 'Read',
  computer: 'Computer',
  grep: 'Searched', glob: 'Searched', symbols: 'Searched', dependents: 'Searched',
  write_file: 'Wrote', edit_file: 'Edited', apply_patch: 'Patched',
  append_file: 'Appended', insert_at: 'Inserted', delete_range: 'Deleted',
  move_file: 'Moved', delete_file: 'Deleted',
  run_bash: 'Ran', run_powershell: 'Ran', run_cmd: 'Ran',
  plan_write: 'Planned', plan_step_done: 'Planned',
  // A LOOKUP IS A READ, and saying so keeps it in the same column as every other read — but `Looked up` is what distinguishes a page somebody else…
  web_fetch: 'Looked up',
};
function verbOf(name) { return VERB_OF[name] || String(name || 'Ran'); }

/** THE RESTATEMENT AT THE TOP OF AN ANSWER — dropped, because it is not one. */
const RESTATEMENT = new RegExp(
  '^\\s*(?:so\\s+)?(?:'
  + 'the\\s+user\\s+(?:wants|is\\s+asking|asked|would\\s+like)'
  + '|what\\s+(?:you(?:\\u2019re|\u0027re| are)\\s+asking|the\\s+user\\s+wants)'
  + '|i\\s+understand\\s+(?:that\\s+)?you\\s+want'
  + '|as\\s+requested'
  + ')\\b[^.!?\\n]*[.!?](?=\\s|$)', 'i');

/** Drop a leading restatement of the request. See above for the limits. */
function trimRestatement(text) {
  const s = String(text == null ? '' : text);
  const m = RESTATEMENT.exec(s);
  if (!m) return s;
  const rest = s.slice(m[0].length);
  // Nothing left to say means the restatement WAS the answer. Keep it.
  if (!rest.trim()) return s;
  return rest.replace(/^[ \t]+/, '');
}

/** WHAT A TURN LAIN ASKED ITSELF FOR IS CALLED. */
const SELF_ASKED = Object.freeze({
  'external-advice': 'continuing the investigation with the external advice',
  'rate-limit-resume': 'continuing after the rate limit reset',
  'phase-continue': 'continuing with the next phase of the approved plan',
  // EVERY KEY ANY CALLER ACTUALLY USES.
  'provider-failover': 'continuing on another provider',
  handover: 'continuing from what LAIN observed',
  steer: 'continuing with what you added',
  plan: 'executing the accepted plan',
  'bg-complete': 'continuing with the background result',
  // Found live 2026-09-19: these two were drawn as a second USER message. (`continue` —
  // a shelf's Continue — deliberately shows the instruction it sent: the person pressed it.)
  'rate-limit-switch': 'retrying your message on the model you switched to',
  'smoke-failed': 'continuing: the final smoke failed — repairing the step it names',
  // THE TASK CARRYING ON BY ITSELF (autocontinue.js) — a crash recovered, a provider failure waited out,
  // an account switched by the family's policy. Each is LAIN's own continuation, never a person's message.
  'auto-resume': 'resuming after the execution host stopped mid-turn',
  'provider-restart': 'continuing after the provider failure cleared',
  'account-fallback': 'continuing on another account of the same provider',
});

/** What to draw instead of a user block, or null when a person really did type it. */
function selfAskedCaption(from, typed = false) {
  // TEXT A PERSON TYPED IS NEVER CAPTIONED.
  if (!from || typed) return null;
  return SELF_ASKED[from] || null;
}

/** WHICH MODEL, THROUGH WHICH ROUTE — and the routing was hiding in plain sight. */
function routeOf(model, provider, connection) {
  const raw = String(model || '');
  const cut = raw.indexOf('/');
  const via = cut > 0 ? raw.slice(0, cut) : null;
  const name = cut > 0 ? raw.slice(cut + 1) : raw;

  // The connection name and the provider name are frequently the same word,
  // and printing it twice tells nobody anything.
  const base = [provider, connection].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const route = base.length ? base.join(' · ') : '';
  return {
    model: name || raw || null,
    // `omniroute/cc` — the connection you configured, and the downstream it
    // resolved to. Nothing is invented: both halves are read from real state.
    route: via ? (route ? route + '/' + via : via) : route,
    via,
  };
}

module.exports = {
  shellParts, SUBJECT_SEP,
  SELF_ASKED, selfAskedCaption, routeOf, MARK, phrase, verbOf, VERB_OF, trimRestatement };
