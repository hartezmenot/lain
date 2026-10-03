'use strict';

/** LAIN'S OWN COMPUTER OPERATIONS — the ownership correction, in one file. */

const cap = require('./capability');
const kbd = require('./keyboarddelivery');

/** THE OPERATIONS, in LAIN's words. */
const OPS = Object.freeze({
  windows: { aim: 'NONE', reads: true, what: 'list the visible windows, with titles and rectangles' },
  focus: { aim: 'NONE', reads: false, what: 'bring a window to the foreground and VERIFY that it came' },
  screenshot: { aim: 'NONE', reads: true, what: 'capture the screen to a PNG file and return its path' },
  ocr: { aim: 'NONE', reads: true, what: 'read the text on the screen, or in a region of it' },
  move: { aim: 'SCREEN', reads: false, what: 'move the mouse to a screen coordinate' },
  click: { aim: 'SCREEN', reads: false, what: 'click at a screen coordinate' },
  type: { aim: 'FOCUS', reads: false, what: 'type text into the window named by `window`' },
  key: { aim: 'FOCUS', reads: false, what: 'press and release one key in the window named by `window`' },
  hold: { aim: 'FOCUS', reads: false, what: 'hold a key down for `ms` and release it, both edges reported' },
});

const NAMES = Object.freeze(Object.keys(OPS));

/** WHERE TO LOOK — a window title resolved to the rectangle it occupies. */
/** `needle` appears in `haystack` bounded by something that is not a letter or digit. */
function wordMatch(haystack, needle) {
  const hay = String(haystack || '').toLowerCase();
  const want = String(needle || '').toLowerCase();
  if (!hay || !want) return false;
  const alnum = (ch) => /[\p{L}\p{N}]/u.test(ch);
  for (let at = hay.indexOf(want); at >= 0; at = hay.indexOf(want, at + 1)) {
    const end = at + want.length;
    if ((at === 0 || !alnum(hay[at - 1])) && (end >= hay.length || !alnum(hay[end]))) return true;
  }
  return false;
}

async function regionOf(app, wanted) {
  const want = String(wanted || '').trim();
  if (!want) return { ok: false, why: 'no window was named' };
  const listed = await perform(app, 'windows', {}, { why: `find ${want} so the capture can be aimed at it` });
  if (listed.stage !== cap.STAGE.SUCCEEDED) {
    return { ok: false, why: `the windows could not be listed — ${listed.why || listed.stage}` };
  }
  const rows = (listed.result && (listed.result.windows || listed.result.list || listed.result)) || [];
  const all = Array.isArray(rows) ? rows : [];
  const needle = want.toLowerCase();
  // EXACT TITLE FIRST, then a WHOLE-WORD match.
  const hit = all.find((w) => String((w && w.title) || '').toLowerCase() === needle)
    || all.find((w) => wordMatch(String((w && w.title) || ''), want));
  if (!hit) {
    const titles = all.map((w) => String((w && w.title) || '')).filter(Boolean).slice(0, 12);
    return {
      ok: false,
      why: `no window titled "${want}". Visible: ${titles.length ? titles.join(' | ') : 'none reported'}`,
    };
  }
  // The two rectangle shapes the transports use. A window with neither is a
  // real answer — it cannot be aimed at — and is reported rather than guessed.
  const r = hit.rect || hit.bounds || hit;
  const x = Number(r.x != null ? r.x : r.left);
  const y = Number(r.y != null ? r.y : r.top);
  const width = Number(r.width != null ? r.width : (Number(r.right) - x));
  const height = Number(r.height != null ? r.height : (Number(r.bottom) - y));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return { ok: false, why: `"${hit.title}" reported no usable rectangle, so nothing can be aimed at it` };
  }
  return { ok: true, region: { x, y, width, height }, title: String(hit.title || want) };
}

/** HOW EACH OPERATION IS SPELT ON EACH TRANSPORT. */
const DIALECT = Object.freeze({
  probe: {
    windows: 'window.list',
    focus: 'window.focus',
    screenshot: 'screen.capture',
    ocr: 'vision.ocr',
    move: 'input.mouse.move',
    click: 'input.mouse.click',
    type: 'input.keyboard.type',
    key: 'input.keyboard.tap',
    hold: 'input.keyboard.hold',
  },
  desktop: {
    windows: 'window.list',
    focus: 'window.focus',
    screenshot: 'screen.capture',
    ocr: null,                 // the bridge has no OCR. Saying so beats guessing.
    move: 'mouse.move',
    click: 'mouse.click',
    type: 'keyboard.type',
    key: 'keyboard.key',
    hold: null,                // no press/release pair, so no hold can be built
  },
});

/** WHICH TRANSPORTS CAN BE AIMED AT A RECTANGLE. */
const REGIONS = Object.freeze({
  probe: { screenshot: true, ocr: true },
  desktop: { screenshot: false, ocr: false },
});

/** The capability each operation needs, per dialect. One table, both spellings. */
function capabilityFor(op, kind) {
  const name = DIALECT[kind] && DIALECT[kind][op];
  return name ? cap.capabilityOf(name) : null;
}

/** WHICH TRANSPORTS ARE AVAILABLE, best first. */
function transports(app) {
  const out = [];
  if (app && typeof app.desktop === 'function') {
    let bridge = null;
    try { bridge = app.desktop(); } catch { bridge = null; }
    if (bridge && bridge.bridge) {
      out.push({
        kind: 'desktop',
        call: (op, params, ms) => bridge.bridge.call(op, params, ms),
        raw: bridge.bridge,
      });
    }
  }
  return out;
}

/** The first transport that can perform this operation, or null with a reason. */
function pick(app, op) {
  const available = transports(app);
  if (!available.length) {
    return { ok: false, why: 'nothing is connected — start the desktop bridge with /mcp connect' };
  }
  for (const t of available) {
    if (DIALECT[t.kind][op]) return { ok: true, transport: t, name: DIALECT[t.kind][op] };
  }
  return {
    ok: false,
    why: `${available.map((t) => t.kind).join(' and ')} cannot ${op} — `
      + `it is not an operation ${available.length > 1 ? 'either has' : 'that one has'}`,
  };
}

/** CAN LAIN ACTUALLY LOOK AT THE SCREEN RIGHT NOW? */
function visualReadiness(app) {
  const ledger = channelsOf(app);
  const shut = ledger && ledger.check('screenshot');
  if (shut && !shut.ok) {
    return { ok: false, state: shut.state, transport: '', why: `${shut.channel} ${shut.state} — ${shut.why}` };
  }
  const chosen = pick(app, 'screenshot');
  if (!chosen.ok) return { ok: false, state: 'NO TRANSPORT', transport: '', why: chosen.why };
  return { ok: true, state: 'CONNECTED', transport: chosen.transport.kind, why: '' };
}

/** THE CHANNEL LEDGER FOR THIS SESSION, created on first use. */
function channelsOf(app) {
  if (!app) return null;
  if (!app._channels) app._channels = new (require('./channels').Channels)();
  return app._channels;
}

/** PERFORM ONE OPERATION, and report what is actually known about it. */
async function perform(app, op, params = {}, opts = {}) {
  // AIM A READ AT A WINDOW, IF ONE WAS NAMED
  if ((op === 'screenshot' || op === 'ocr') && opts.window && !params.region) {
    // CAN ANYTHING HERE ACTUALLY BE AIMED?
    const chosen = pick(app, op);
    const capable = chosen.ok && REGIONS[chosen.transport.kind] && REGIONS[chosen.transport.kind][op];
    if (chosen.ok && !capable) {
      return {
        stage: cap.STAGE.NO_TARGET, trail: [kbd.step(cap.STAGE.REQUESTED, op)], result: null,
        transport: chosen.transport.kind,
        why: `${chosen.transport.kind} cannot aim ${op} at a window — it captures the whole screen `
          + 'and has no region parameter. Nothing was captured, because a whole-desktop capture '
          + `labelled "${opts.window}" would answer a different question. `
          + 'Ask for the whole screen deliberately by omitting `window`.',
      };
    }
    const aimed = await regionOf(app, opts.window);
    if (!aimed.ok) {
      return {
        stage: cap.STAGE.NO_TARGET, trail: [kbd.step(cap.STAGE.REQUESTED, op)], result: null,
        transport: null,
        why: `${op} was aimed at "${opts.window}" and ${aimed.why}. Nothing was captured — `
          + 'the whole desktop would have answered a different question. '
          + 'Use `computer{op:"windows"}` to see what is actually open.',
      };
    }
    params = { ...params, region: aimed.region };
    opts = { ...opts, aimedAt: aimed.title };
  }
  const outcome = await attempt(app, op, params, opts);
  if (opts.aimedAt) outcome.aimedAt = opts.aimedAt;
  const ledger = channelsOf(app);
  const channel = ledger && require('./channels').OP_CHANNEL[op];
  if (ledger && channel) {
    // ONLY THE USER CLOSES A CHANNEL.
    if (outcome.stage === cap.STAGE.REFUSED && !outcome.channel) {
      // THE REASON, NOT THE WHOLE SENTENCE.
      ledger.deny(channel, 'the user did not allow it');
    } else if (outcome.stage === cap.STAGE.SUCCEEDED || outcome.stage === cap.STAGE.SENT_UNCONFIRMED) {
      ledger.open(channel);
    }
  }
  return outcome;
}

/** The attempt itself. Every exit is a named stage; see capability.STAGE. */
async function attempt(app, op, params = {}, { window = '', why = '' } = {}) {
  const spec = OPS[op];
  if (!spec) {
    return { stage: cap.STAGE.FAILED, trail: [], result: null, why: `there is no operation "${op}"` };
  }

  // A CLOSED CHANNEL IS ANSWERED HERE, WITHOUT ASKING ANYONE
  const ledger = channelsOf(app);
  if (ledger) {
    const allowed = ledger.check(op);
    if (!allowed.ok) {
      return {
        stage: cap.STAGE.REFUSED,
        trail: [kbd.step(cap.STAGE.REQUESTED, op), kbd.step(cap.STAGE.REFUSED, `${allowed.channel} ${allowed.state}`)],
        result: null,
        channel: allowed.channel,
        transport: null,
        why: `${allowed.channel} ${allowed.state} — ${allowed.why}. Nothing was attempted, and asking `
          + `again will not change it. Instead: ${allowed.fallback}.`,
      };
    }
  }

  const chosen = pick(app, op);
  if (!chosen.ok) {
    return {
      stage: cap.STAGE.BRIDGE_LOST,
      trail: [kbd.step(cap.STAGE.REQUESTED, op)],
      result: null,
      why: chosen.why,
    };
  }
  const { transport, name } = chosen;

  // THE KEYBOARD HALF IS keyboarddelivery.js, not a copy of it
  if (spec.aim === 'FOCUS') {
    const kbdOp = DIALECT.probe[op];      // the sequence speaks the Probe dialect
    if (transport.kind !== 'probe') {
      return {
        stage: cap.STAGE.FAILED,
        trail: [kbd.step(cap.STAGE.REQUESTED, op)],
        result: null,
        why: 'keyboard input needs a transport that can verify the foreground before each '
          + 'keystroke: the desktop bridge cannot, and an unverified keystroke goes wherever '
          + 'the user is looking.',
      };
    }
    if (op === 'hold') {
      return kbd.hold({
        probe: transport.raw, key: params.key, ms: params.ms, window, reason: why,
      });
    }
    return kbd.deliver({
      probe: transport.raw,
      op: kbdOp,
      params,
      window,
      capability: capabilityFor(op, 'probe'),
      reason: why,
    });
  }

  // ---- FOCUS IS ITS OWN OPERATION, and its answer is VERIFIED --------------
  if (op === 'focus') {
    const trail = [kbd.step(cap.STAGE.REQUESTED, window || params.window || '')];
    const want = String(window || params.window || '').trim();
    if (!want) {
      return { stage: cap.STAGE.FAILED, trail, result: null, why: 'focus needs a window title' };
    }
    trail.push(kbd.step(cap.STAGE.FOCUSING, want));
    const r = await transport.call(name, { window: want }, kbd.PERMISSION_MS).catch((e) => ({ ok: false, error: e.message }));
    const ok = Boolean(r && r.ok && r.result && r.result.focused === true);
    trail.push(kbd.step(ok ? cap.STAGE.FOCUSED : cap.STAGE.FOCUS_FAILED,
      (r && r.result && (r.result.title || r.result.note)) || (r && r.error) || ''));
    return {
      stage: ok ? cap.STAGE.SUCCEEDED : cap.STAGE.FOCUS_FAILED,
      trail,
      result: r && r.result,
      why: ok ? '' : `the OS did not put ${want} in front — ${(r && r.result && r.result.note) || (r && r.error) || 'it refused'}`,
      transport: transport.kind,
    };
  }

  // ---- EVERYTHING ELSE: a read, or a coordinate-addressed action -----------
  const trail = [kbd.step(cap.STAGE.REQUESTED, `${op} via ${transport.kind}`)];
  trail.push(kbd.step(cap.STAGE.EXECUTING, name));
  const r = await transport.call(name, params, kbd.PERMISSION_MS).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    if (r && r.denied) {
      trail.push(kbd.step(cap.STAGE.REFUSED, r.error || 'the user said no'));
      return { stage: cap.STAGE.REFUSED, trail, result: null, transport: transport.kind,
        why: `the user did not allow ${r.capability || op}. Nothing was done. Do not ask again.` };
    }
    trail.push(kbd.step(cap.STAGE.FAILED, (r && r.error) || 'no answer'));
    return { stage: cap.STAGE.FAILED, trail, result: null, transport: transport.kind,
      why: `${op} failed: ${(r && r.error) || 'no answer'}` };
  }

  // A READ SUCCEEDS OR IT DOES NOT — there is nothing unconfirmed about the text that came back.
  const stage = spec.reads ? cap.STAGE.SUCCEEDED : cap.STAGE.SENT_UNCONFIRMED;
  trail.push(kbd.step(stage, name));
  return { stage, trail, result: r.result, why: '', transport: transport.kind };
}

module.exports = { OPS, NAMES, DIALECT, REGIONS, transports, pick, perform, capabilityFor, channelsOf, visualReadiness, regionOf, wordMatch };
