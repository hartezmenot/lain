'use strict';

/** GETTING A KEYSTROKE TO THE WINDOW IT WAS MEANT FOR — LAIN's half of it. */

const cap = require('./capability');
const heldKeys = require('./heldkeys');

/** A hold is a lifecycle, and an unreleased key is a broken keyboard. */
const MAX_HOLD_MS = 30_000;
const DEFAULT_HOLD_MS = 1000;

/** How long any one Probe call may take before it is a failure, not a wait. */
const CALL_MS = 20_000;
/** A permission prompt waits for a person to read it and decide. */
const PERMISSION_MS = 180_000;

/** AIMING NEEDS ITS OWN PERMISSION, and finding that out cost a live run. */
const AIM_CAPABILITY = 'screen.capture';

/** ONE STEP OF THE SEQUENCE, as it is recorded. */
function step(stage, detail, extra = {}) {
  return { stage, detail: String(detail || ''), at: new Date().toISOString(), ...extra };
}

/** IS THIS CAPABILITY ALREADY GRANTED? */
async function granted(probe, capability) {
  if (!capability) return true;
  try {
    const r = await probe.call('permission.state', {}, CALL_MS);
    const caps = r && r.ok && r.result && r.result.capabilities;
    if (!caps || typeof caps !== 'object') return null;
    const entry = caps[capability];
    if (!entry) return null;
    return Boolean(entry.granted);
  } catch { return null; }
}

/** ASK FOR THE CAPABILITY, BEFORE ANYTHING IS AIMED. */
async function ensurePermission(probe, capability, reason) {
  if (!capability) return { ok: true, why: '', asked: false };
  const have = await granted(probe, capability);
  if (have === true) return { ok: true, why: 'already granted', asked: false };

  let r;
  try {
    r = await probe.call('permission.request', {
      capability,
      reason: String(reason || 'to send keyboard input to the window being worked on'),
    }, PERMISSION_MS);
  } catch (e) {
    return { ok: false, why: `the permission request failed: ${e && e.message}`, asked: true };
  }
  if (!r || !r.ok) {
    // AN OLDER PROBE MAY NOT HAVE permission.request.
    const why = String((r && r.error) || 'no answer');
    if (/unknown|not implemented|no such/i.test(why)) {
      return { ok: true, why: 'this Probe has no permission.request — its own gate will ask', asked: false };
    }
    return { ok: false, why, asked: true };
  }
  const ok = Boolean(r.result && r.result.granted);
  return {
    ok,
    why: ok ? 'the user allowed it' : String((r.result && r.result.summary) || 'the user did not allow it'),
    asked: true,
  };
}

/** FOCUS THE WINDOW AND ESTABLISH THAT IT REALLY IS THE FOREGROUND. */
async function focusVerified(probe, window) {
  let r;
  // PERMISSION_MS, NOT CALL_MS.
  try { r = await probe.call('window.focus', { window }, PERMISSION_MS); }
  catch (e) { return { ok: false, title: '', why: `window.focus failed: ${e && e.message}` }; }
  const res = (r && r.result) || {};
  if (!r || !r.ok) return { ok: false, title: '', why: String((r && r.error) || 'window.focus failed') };
  return {
    ok: res.focused === true,
    title: String(res.title || window || ''),
    why: res.focused === true ? '' : String(res.note || res.summary || 'the OS refused the foreground change'),
  };
}

/** THE SEQUENCE, in full, for one focus-following operation. */
async function deliver({ probe, op, params = {}, window = '', capability = null, reason = '' } = {}) {
  const trail = [step(cap.STAGE.REQUESTED, `${op} → ${window || 'no window named'}`)];
  const stop = (stage, why) => { trail.push(step(stage, why)); return { stage, trail, result: null, why, title: '' }; };

  if (!probe) return stop(cap.STAGE.BRIDGE_LOST, 'nothing is connected, so nothing was attempted');

  // NEVER SEND A KEYSTROKE AT NOTHING.
  if (!String(window).trim()) {
    return stop(cap.STAGE.FOCUS_FAILED,
      'no window was named, so there was nothing to aim at and nothing to verify. NOTHING WAS SENT. '
      + 'Name the window this input is for.');
  }

  // 1. PERMISSION FIRST — for BOTH decisions, before anything is aimed.
  for (const want of [capability, AIM_CAPABILITY]) {
    if (!want) continue;
    const perm = await ensurePermission(probe, want, reason);
    trail.push(step(cap.STAGE.PERMISSION_REQUIRED,
      perm.asked ? `asked for ${want}: ${perm.why}` : `${want}: ${perm.why || 'no permission needed'}`,
      { granted: perm.ok }));
    if (!perm.ok) {
      return stop(cap.STAGE.REFUSED,
        `${want} — ${perm.why}. Nothing was sent. Do not ask again for this.`);
    }
  }

  // 2. AIM.
  trail.push(step(cap.STAGE.FOCUSING, `bringing ${window} to the foreground`));
  const first = await focusVerified(probe, window);
  if (!first.ok) {
    return stop(cap.STAGE.FOCUS_FAILED,
      `could not focus ${window}: ${first.why}. NOTHING WAS SENT — a keystroke now would go to `
      + "whatever is in front, possibly the user's own work.");
  }
  trail.push(step(cap.STAGE.FOCUSED, first.title));

  // 3. VERIFY AGAIN, IMMEDIATELY BEFORE INJECTION. This is the check that
  //    catches a prompt, a notification or a click that arrived in between.
  const again = await focusVerified(probe, window);
  if (!again.ok) {
    return stop(cap.STAGE.FOCUS_FAILED,
      `${window} was focused and then lost the foreground before the key could be sent (${again.why}). `
      + 'NOTHING WAS SENT.');
  }

  // 4. INJECT.
  trail.push(step(cap.STAGE.INJECTING, `${op} into ${again.title}`));
  let r;
  try { r = await probe.call(op, params, CALL_MS); }
  catch (e) { return stop(cap.STAGE.FAILED, `${op} failed: ${e && e.message}`); }
  if (!r || !r.ok) {
    if (r && r.denied) return stop(cap.STAGE.REFUSED, `the user did not allow ${r.capability || capability}. Nothing was done.`);
    return stop(cap.STAGE.FAILED, `${op} failed: ${(r && r.error) || 'no answer'}`);
  }

  // 5. SENT — AND NOT DELIVERED. The OS accepted it; nobody watched the target receive it. Only a witness that saw the event arrive may say DELIVERED…
  trail.push(step(cap.STAGE.SENT_UNCONFIRMED, `${op} was accepted by the OS with ${again.title} in front`));
  return { stage: cap.STAGE.SENT_UNCONFIRMED, trail, result: r.result, why: '', title: again.title };
}

/** A HOLD IS A LIFECYCLE, NOT A CALL. */
async function hold({ probe, key, ms = DEFAULT_HOLD_MS, window = '', reason = '' } = {}) {
  const held = Math.max(1, Math.min(Number(ms) || DEFAULT_HOLD_MS, MAX_HOLD_MS));

  const down = await deliver({
    probe,
    op: 'input.keyboard.press',
    params: { key },
    window,
    capability: 'keyboard.press',
    reason: reason || `to hold ${key} in ${window}`,
  });
  if (down.stage !== cap.STAGE.SENT_UNCONFIRMED) {
    // NOTHING WENT DOWN, so there is nothing to lift and nothing to claim.
    return { stage: down.stage, held: 0, down, up: null, trail: down.trail, why: down.why };
  }

  // IT IS DOWN NOW, AND SOMETHING OUTSIDE THIS CALL MUST KNOW
  const release = () => probe.call('input.keyboard.release', { key }, CALL_MS);
  heldKeys.down(key, release, reason || `held in ${window}`);

  let up = null;
  try {
    await new Promise((resolve) => { setTimeout(resolve, held); });
  } finally {
    // THE KEY COMES UP WHATEVER HAPPENED.
    try {
      const r = await release();
      up = { ok: Boolean(r && r.ok), error: (r && r.error) || null };
    } catch (e) { up = { ok: false, error: e && e.message }; }
    // DEREGISTERED ONLY ON A CONFIRMED LIFT.
    if (up && up.ok) heldKeys.up(key);
  }

  const trail = [
    ...down.trail,
    step(cap.STAGE.INJECTING, `held ${key} for ${held}ms`),
    step(up && up.ok ? cap.STAGE.SENT_UNCONFIRMED : cap.STAGE.FAILED,
      up && up.ok ? `${key} released` : `${key} could NOT be released: ${up && up.error}`),
  ];
  return {
    stage: up && up.ok ? cap.STAGE.SENT_UNCONFIRMED : cap.STAGE.FAILED,
    held, down, up, trail,
    why: up && up.ok ? '' : 'the key was pressed and the release failed — it may still be down',
  };
}

/** The trail as lines a person reads. The stage first, because that is the answer. */
function trailLines(trail = []) {
  return trail.map((t) => `  ${t.stage.padEnd(20)} ${t.detail}`);
}

module.exports = {
  MAX_HOLD_MS, DEFAULT_HOLD_MS, CALL_MS, PERMISSION_MS, AIM_CAPABILITY,
  deliver, hold, ensurePermission, focusVerified, granted, trailLines, step,
};
