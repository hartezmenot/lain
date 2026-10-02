'use strict';

/**
 * THE ONE TOOL GATE — may this call touch that path or change an account?
 *
 * Called from `tools/index.js:execute`, which is the single door every tool
 * call goes through. Putting it there rather than at each `resolve()` is the
 * whole point: there were six resolve sites across three files, and six places
 * to remember is one place to forget. A tool written tomorrow is covered
 * without its author knowing this exists.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT DO, deliberately:
 *
 *   NO COMMAND ALLOWLIST. An architecture guard forbids one, and it is right
 *     to: a list of permitted shell commands is either so short the shell is
 *     useless or so long it is decorative, and every entry is a promise about
 *     what a command means that the next flag breaks. What is gated is the
 *     DIRECTORY, which is a fact, not a guess about intent.
 *
 *   NO REWRITING. A refused call is refused and says so. It is never silently
 *     redirected somewhere safer, because a model that is lied to about where
 *     its file went writes the next one to the same wrong place.
 *
 *   FILESYSTEM TRUST DOES NOTHING WHEN THERE IS NO APP. A turn run headless —
 *     a unit test, a piped one-shot — has no project trust decision to read.
 *     External effects remain refused when nobody can approve them.
 */

const path = require('path');

const trust = require('./trust');

/** Ask once immediately before a call that changes an external account. */
async function externalApproval(name, input, ctx, approval) {
  const app = ctx && ctx.app;
  const interaction = require('./interaction');
  const registry = require('./harness/registry');
  if (!app || !interaction.available(app)) {
    return { ok: false, output: 'PERMISSION_REQUIRED: an interactive approval is required before this external action; nothing was sent or changed' };
  }
  let preview = {};
  try { preview = typeof approval === 'function' ? await approval(input || {}, ctx || {}) : {}; } catch { preview = {}; }
  if (preview && preview.ok === false) {
    const cls = String(preview.class || 'FAILED');
    return { ok: false, output: `${cls}: ${require('./redact').text(String(preview.why || 'the external action is not ready')).slice(0, 240)}` };
  }
  const safe = require('./redact').text;
  const what = safe(String(preview.what || name).replace(/\s+/g, ' ').trim()).slice(0, 160);
  const reason = safe(String(preview.reason || 'This action will change a connected account.').replace(/\s+/g, ' ').trim()).slice(0, 240);
  const details = safe(String(preview.details || '').trim()).slice(0, 2000);
  // THE PERSON'S PermissionRequest HOOK answers only the question LAIN was about to ask (userhooks.js): never one
  // nobody could have answered (refused above), never a refusal (a gate refusal never reaches here).
  const hk = await require('./userhooks').fire(app, 'PermissionRequest', { kind: 'external', tool: name, what, reason }, { match: name });
  if (hk.decision === 'deny') return { ok: false, output: `PERMISSION_REQUIRED: your PermissionRequest hook denied it${hk.reason ? ` — ${safe(hk.reason).slice(0, 200)}` : ''}; nothing was sent or changed` };
  if (hk.decision === 'allow') {
    try { app.events?.emit?.(require('./events').EVENT.APPROVAL_RESOLVED, { what, granted: true, kind: 'external', by: 'hook' }); } catch { /* result still stands */ }
    return { ok: true, sideEffect: registry.SIDE_EFFECT.EXTERNAL };
  }
  try { app.events?.emit?.(require('./events').EVENT.APPROVAL_REQUIRED, { what, reason, kind: 'external' }); } catch { /* approval still stands */ }
  let answer = null;
  try {
    answer = await require('./decisions').ask(app, { type: 'PERMISSION_REQUEST', title: 'Approve external action?', question: [what, reason, details].filter(Boolean).join('\n\n'), options: ['Approve once', 'Deny'] }, ctx && ctx.signal);
  } catch { answer = null; }
  const granted = answer === 'Approve once';
  try { app.events?.emit?.(require('./events').EVENT.APPROVAL_RESOLVED, { what, granted, kind: 'external' }); } catch { /* result still stands */ }
  if (!granted) return { ok: false, output: 'PERMISSION_REQUIRED: external action was not approved; nothing was sent or changed' };
  return { ok: true, sideEffect: registry.SIDE_EFFECT.EXTERNAL };
}

/** The argument names a tool uses for "a path on disk". */
const PATH_KEYS = ['path', 'file', 'dest', 'to', 'from', 'src'];

/** Every path this call names, absolute. */
function pathsIn(input, cwd) {
  const out = [];
  const i = input && typeof input === 'object' ? input : {};
  for (const k of PATH_KEYS) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) out.push(path.resolve(cwd, v));
  }
  return out;
}

/**
 * Is the model asking about the machine or about the project?
 *
 * @returns {Promise<{ok:boolean, output?:string}>}
 */
async function check(name, input, ctx, { mutates = false, effect = null, approval = null } = {}) {
  const app = ctx && ctx.app;
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const registry = require('./harness/registry');
  const sideEffect = effect || registry.effectFor(name, { mutates });
  if (registry.POLICY[sideEffect] === registry.APPROVAL.REQUIRED && sideEffect === registry.SIDE_EFFECT.EXTERNAL) {
    const verdict = await externalApproval(name, input, ctx, approval);
    if (!verdict.ok) return verdict;
  }
  // No App means no filesystem trust state. External effects were refused above.
  if (!app || !app.cfg) return { ok: true };
  // ---- AND NO GATE WITHOUT A UI, WHICH IS THE SAME RULE -------------------
  //
  // The gate enforces a DECISION. On a pipe — `lain -p`, a one-shot, a test —
  // the trust question was never asked, because there was nobody to ask it. An
  // undecided directory would then refuse every read and every write, which is
  // not caution: it is punishing the user for a question the program never put
  // to them, and it would break every non-interactive run of LAIN.
  //
  // A person who typed `lain -p "fix the parser"` in a directory has said which
  // directory they mean about as plainly as it can be said.
  if (!require('./interaction').available(app)) return { ok: true };

  const root = (app.session && app.session.cwd) || cwd;
  const targets = pathsIn(input, cwd);
  // Remote admission is not local machine consent. Commands without a named
  // file still exercise the existing directory trust decision.
  if (app.interaction && mutates) targets.push(path.resolve(cwd, input?.cwd || '.'));
  if (!targets.length) return { ok: true };

  for (const target of targets) {
    const verdict = trust.check({
      cfg: app.cfg,
      root,
      target,
      write: mutates,
      // THE MODE, FROM THE ONE PLACE THAT DERIVES IT. AUTO is allowed to say
      // yes outside the project, but never for a system or credential location
      // — trust.check enforces that whatever the mode is. See trust.NEVER_AUTO.
      mode: trust.modeOf(app.cfg),
    });
    if (verdict.ok) continue;

    // ---- ASK, IF THERE IS ANYONE TO ASK ----------------------------------
    if (verdict.ask) {
      let allowed = false;
      try {
        allowed = await require('./trustask').askOutside(app, {
          target, why: verdict.why, write: mutates,
        });
      } catch { allowed = false; }
      if (allowed) continue;
    }

    // ---- REFUSED, AND RECORDED -------------------------------------------
    //
    // On the list rather than only in this result, so `/permissions` can show
    // what has been turned down and let it be allowed afterwards. A refusal the
    // user never sees is one they cannot reconsider.
    try { require('./rejected').note(app, { tool: name, target, why: verdict.why, write: mutates }); } catch { /* the refusal still stands */ }

    return {
      ok: false,
      output: `refused: ${verdict.why || 'that path is outside what this session may touch'}`
        + `\n  ${target}`
        + '\n\nThe user can allow it with /permissions, or trust the directory with /trust.',
    };
  }
  return { ok: true };
}

module.exports = { check, externalApproval, pathsIn, PATH_KEYS };
