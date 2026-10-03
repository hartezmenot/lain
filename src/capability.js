'use strict';

/** WHAT IS ACTUALLY POSSIBLE RIGHT NOW — one vocabulary for the whole path. */

/** THE STATES ONE ATTEMPT CAN BE IN. */
const STAGE = Object.freeze({
  /** The model asked. Nothing has happened yet. */
  REQUESTED: 'REQUESTED',
  /** No bridge/Probe is connected, so nothing can be attempted. */
  BRIDGE_LOST: 'BRIDGE_LOST',
  /** The user has not allowed this kind of action; they are being asked. */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** The user said no. Final for this request. */
  REFUSED: 'REFUSED',
  /** The action is aimed at a process and no process is authorised. */
  NO_TARGET: 'NO_TARGET',
  /** There WAS an authorised target and it is gone. */
  TARGET_LOST: 'TARGET_LOST',
  /** Allowed, not yet run. */
  GRANTED: 'GRANTED',
  /** THE THREE STAGES OF AIMING, which used to be one silent gap. */
  FOCUSING: 'FOCUSING',
  FOCUSED: 'FOCUSED',
  INJECTING: 'INJECTING',
  /** A WITNESS SAW THE TARGET RECEIVE IT. */
  DELIVERED: 'DELIVERED',
  /** In flight on the far side. */
  EXECUTING: 'EXECUTING',
  /** It ran, and the far side reported success. */
  SUCCEEDED: 'SUCCEEDED',
  /** It ran, or could not run, and the far side reported why. */
  FAILED: 'FAILED',
  /** The intended window could not be brought to the foreground, so NOTHING WAS SENT. */
  FOCUS_FAILED: 'FOCUS_FAILED',
  /** The OS accepted the injection and NOBODY OBSERVED THE TARGET RECEIVE IT. */
  SENT_UNCONFIRMED: 'SENT_UNCONFIRMED',
});

/** Stages that mean the attempt is over and nothing reached the machine. */
const DEAD = Object.freeze([STAGE.BRIDGE_LOST, STAGE.REFUSED, STAGE.NO_TARGET, STAGE.TARGET_LOST]);

/** WHICH CAPABILITY AN OPERATION NEEDS. */
const CAPABILITY_OF = Object.freeze({
  // ---- the Probe's dialect ----
  'input.mouse.move': 'mouse.move',
  'input.mouse.click': 'mouse.click',
  'input.mouse.drag': 'mouse.click',
  'input.mouse.position': 'mouse.read',
  'input.keyboard.press': 'keyboard.press',
  'input.keyboard.release': 'keyboard.release',
  'input.keyboard.tap': 'keyboard.press',
  // A HOLD IS LAIN'S COMPOSITE of press + release (see tools/probe.js).
  'input.keyboard.hold': 'keyboard.press',
  'input.keyboard.type': 'keyboard.press',
  'vision.screen.capture': 'screen.capture',
  'screen.capture': 'screen.capture',
  'screen.ocr': 'screen.ocr',
  'process.attach': 'process.attach',
  'process.terminate': 'process.terminate',
  'memory.read': 'memory.read',
  'memory.write': 'memory.write',
  'memory.scan': 'memory.read',
  'debug.attach': 'debug.attach',
  'debug.breakpoint': 'debug.breakpoint',
  'debug.watchpoint': 'debug.breakpoint',
  'python.run': 'python.execute',
  'python.execute': 'python.execute',
  // ---- the desktop bridge's dialect ----
  'mouse.move': 'mouse',
  'mouse.click': 'mouse',
  'keyboard.type': 'keyboard',
  'keyboard.key': 'keyboard',
  'window.list': 'window',
  'window.focus': 'window',
});

function capabilityOf(op) { return CAPABILITY_OF[String(op || '')] || null; }

/** OPERATIONS THAT ADDRESS THE SCREEN, NOT A WINDOW. */
const SCREEN_SCOPED = new Set([
  'input.mouse.move', 'input.mouse.click', 'input.mouse.drag', 'input.mouse.position',
  'mouse.move', 'mouse.click',
  'screen.capture', 'vision.screen.capture', 'screen.ocr',
]);

/** OPERATIONS THAT GO TO WHATEVER HAS KEYBOARD FOCUS. */
const FOCUS_SCOPED = new Set([
  'input.keyboard.type', 'input.keyboard.tap', 'input.keyboard.press', 'input.keyboard.release',
  'input.keyboard.hold',
  'keyboard.type', 'keyboard.key',
]);

/** Operations that act ON an authorised process and are meaningless without one. */
const TARGET_SCOPED = new Set([
  'process.attach', 'process.terminate',
  'memory.read', 'memory.write', 'memory.scan',
  'debug.attach', 'debug.breakpoint', 'debug.watchpoint',
]);

/** DOES THIS OPERATION GO WHEREVER THE FOREGROUND IS? */
function needsFocus(op) { return FOCUS_SCOPED.has(String(op || '')); }

function aim(op) {
  const o = String(op || '');
  if (SCREEN_SCOPED.has(o)) return 'SCREEN';
  if (FOCUS_SCOPED.has(o)) return 'FOCUS';
  if (TARGET_SCOPED.has(o)) return 'TARGET';
  return 'NONE';
}

/** WHAT IS TRUE BEFORE THE CALL IS MADE. */
function preflight({ op, connected = false, granted = null, target = null } = {}) {
  const capability = capabilityOf(op);
  const at = aim(op);
  if (!connected) {
    return { stage: STAGE.BRIDGE_LOST, capability, aim: at, blocking: true,
      why: 'nothing is connected, so nothing was attempted' };
  }
  // A TARGET-SCOPED OPERATION WITH NO TARGET cannot do anything but fail, and saying so before the call is the difference between a named state and a…
  if (at === 'TARGET' && target && target.authorized === false) {
    return { stage: STAGE.NO_TARGET, capability, aim: at, blocking: true,
      why: target.reason === 'NO_AUTHORIZED_TARGET'
        ? 'no process is authorised — the person at the machine chooses one'
        : String(target.reason || 'no authorised target') };
  }
  if (capability && granted && granted[capability] === false) {
    return { stage: STAGE.PERMISSION_REQUIRED, capability, aim: at, blocking: false,
      why: `the user has not allowed ${capability}; they will be asked when it is attempted` };
  }
  return { stage: STAGE.GRANTED, capability, aim: at, blocking: false, why: '' };
}

/** WHAT THE MODEL IS TOLD AFTERWARDS — evidence, never a bare `ok`. */
function envelope({ op, stage, capability, aim: at, result = null, error = null, target = null, why = '' }) {
  const evidence = {
    action: op,
    state: stage,
    capability: capability || null,
    aim: at || 'NONE',
    at: new Date().toISOString(),
  };
  if (target && target.authorized) evidence.target = target.selected || target.summary || 'authorised';
  else if (at === 'TARGET') evidence.target = null;
  if (result !== null && result !== undefined) evidence.result = result;
  if (error) evidence.error = String(error);

  const lines = [`${op} — ${stage}`];
  if (why) lines.push(why);
  if (capability) lines.push(`capability: ${capability}`);

  // THE OUTCOME OUTRANKS THE AIM.
  if (stage === STAGE.FOCUS_FAILED) {
    lines.push('NOTHING WAS SENT. The intended window could not be brought to the foreground, '
      + 'and a keystroke sent now would go to whatever is in front — possibly the user\'s own work.');
    evidence.injection = { requested: true, accepted: false };
    evidence.delivery = { verified: false, reason: 'FOCUS_FAILED' };
    return { state: stage, text: lines.join('\n'), evidence };
  }
  if (stage === STAGE.SENT_UNCONFIRMED) {
    // THE HONEST DEFAULT FOR INJECTED INPUT, and the state whose absence was the whole reported bug.
    lines.push('The OS accepted this input. NOBODY OBSERVED THE TARGET RECEIVE IT — an accepted '
      + 'injection is not a delivered keystroke. Confirm by observing the target change '
      + '(its own log, a value it wrote, a capture) before relying on it.');
    evidence.injection = { requested: true, accepted: true };
    evidence.delivery = { verified: false, reason: 'TARGET_RECEIPT_NOT_OBSERVED' };
    if (result !== null && result !== undefined) {
      evidence.result = result;
      lines.push((typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 16000));
    }
    return { state: stage, text: lines.join('\n'), evidence };
  }

  // THE AIM, SAID PLAINLY, on every input operation.
  if (at === 'SCREEN') {
    lines.push('aim: SCREEN COORDINATES. This addressed a point on the screen, not a window. '
      + 'Nothing has confirmed which window received it — focus the intended window first '
      + '(window.focus reports whether the OS actually allowed it) and verify afterwards.');
    evidence.verification = { status: 'unconfirmed', reason: 'coordinate-addressed; no window was confirmed to receive it' };
  } else if (at === 'FOCUS') {
    lines.push('aim: WHATEVER HAS KEYBOARD FOCUS. This did not name a window. '
      + 'If the intended window was not frontmost, the text went somewhere else — '
      + 'focus it first and verify afterwards.');
    evidence.verification = { status: 'unconfirmed', reason: 'focus-addressed; no window was confirmed to receive it' };
  } else if (stage === STAGE.SENT_UNCONFIRMED) {
    // THE HONEST DEFAULT FOR INJECTED INPUT. The OS accepted it; nobody saw it
    // arrive. Saying SUCCEEDED here is the false success the audit found.
    lines.push('The OS accepted this input. NOBODY OBSERVED THE TARGET RECEIVE IT — '
      + 'an accepted injection is not a delivered keystroke. Verify by observing the '
      + 'target change (a screenshot, its own log, a value it wrote) before relying on it.');
    evidence.injection = { requested: true, accepted: true };
    evidence.delivery = { verified: false, reason: 'TARGET_RECEIPT_NOT_OBSERVED' };
  } else if (stage === STAGE.FOCUS_FAILED) {
    lines.push('NOTHING WAS SENT. The intended window could not be brought to the '
      + 'foreground, and a keystroke sent now would go to whatever is in front — '
      + 'possibly the user\'s own work.');
    evidence.injection = { requested: true, accepted: false };
    evidence.delivery = { verified: false, reason: 'FOCUS_FAILED' };
  } else if (stage === STAGE.SUCCEEDED) {
    evidence.verification = { status: 'reported', reason: 'the far side reported success' };
  }

  if (error) lines.push(`reason: ${error}`);
  if (result !== null && result !== undefined) {
    const body = typeof result === 'string' ? result : JSON.stringify(result);
    lines.push(body.slice(0, 16000));
  }
  return { state: stage, text: lines.join('\n'), evidence };
}

/** THE CAPABILITY PICTURE, for the status surfaces. */
async function readState(probe) {
  const out = {
    connected: false, operations: [], capabilities: null, target: null,
    permissionSource: null, notes: [],
  };
  if (!probe || probe.state !== 'CONNECTED') {
    out.notes.push(probe ? `the Probe is ${probe.state}` : 'no Probe in this session');
    return out;
  }
  out.connected = true;
  out.operations = Array.isArray(probe.capabilities) ? probe.capabilities.slice() : [];

  const perms = await safeCall(probe, 'permission.state');
  if (perms && perms.capabilities && typeof perms.capabilities === 'object') {
    out.capabilities = {};
    for (const [k, v] of Object.entries(perms.capabilities)) {
      out.capabilities[k] = { granted: Boolean(v && v.granted), why: (v && v.why) || '' };
    }
    out.permissionSource = perms.prompter ? 'the Probe window prompts, per capability' : 'the Probe decides';
    if (Array.isArray(perms.active) && perms.active.length) out.active = perms.active.slice();
  } else {
    out.notes.push('this Probe does not report permission state — capability status is UNKNOWN');
  }

  const tgt = await safeCall(probe, 'target.status');
  if (tgt && typeof tgt.authorized === 'boolean') {
    out.target = {
      authorized: tgt.authorized,
      reason: tgt.reason || null,
      selected: tgt.selected || null,
      attached: Boolean(tgt.attached),
      policy: (tgt.policy && tgt.policy.summary) || null,
      note: tgt.note || null,
    };
  } else {
    out.notes.push('this Probe does not report target status — target availability is UNKNOWN');
  }
  return out;
}

/** One call that can never throw and never blocks a status screen for long. */
async function safeCall(probe, op, ms = 8000) {
  try {
    const r = await probe.call(op, {}, ms);
    return r && r.ok ? r.result : null;
  } catch { return null; }
}

module.exports = {
  STAGE, DEAD, CAPABILITY_OF, SCREEN_SCOPED, FOCUS_SCOPED, TARGET_SCOPED,
  capabilityOf, aim, needsFocus, preflight, envelope, readState,
};
