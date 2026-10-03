'use strict';

/** TURN EVENTS → SCREEN. */

const { describeTarget } = require('./turn');
// THE ONE FIRST-LINE RULE — see `note:` below for what two copies of it cost.
const describe = require('./describe');
const { EVENT, busOf } = require('./events');

/** How long a compaction notice stays before clearing itself. */
const COMPACT_FLASH_MS = 1500;

/** Tools whose results belong in the OUTPUT view. */
const SHELL_TOOLS = new Set(['run_bash', 'run_powershell', 'run_cmd']);
/** A result at or under this length is a message to the user, not data. */
const BRIEF = 160;

/** Tools whose result is the CONTENT OF A FILE, and therefore worth looking at. */
const READ_TOOLS = new Set(['read_file', 'read_symbol']);

/** Apply one event. */
/** AN EDIT LANDED — hand its real change to the activity timeline. */
function noteEdit(app, changedPath) {
  if (!app.ui || !app.ui.enabled || !app.ui.showDiff) return null;
  const panes = require('./ui/panes');
  const path = require('path');
  const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd });
  if (!files.length) return null;
  const want = path.resolve(app.session.cwd, String(changedPath));
  const f = files.find((x) => path.resolve(x.path || '') === want) || null;
  if (!f) return null;
  app.ui.noteEditCounts(f.added, f.removed);
  // THE TWO TEXTS, NOT A RENDERED DIFF.
  app.ui.showDiff(f.rel, f.before, f.after);
  return f;
}

function apply(app, ev, ctx) {

  // THE WINDOW LOOKS AGAIN, NOW.
  try { require('./harnessapp/ipc').wake(); } catch { /* no window is connected */ }
  // THE SAME EVENT, AS A FACT OTHER SURFACES READ (sessionjournal.js): to the window as a delta, to the journal.
  try { const j = require('./sessionjournal'); const e = j.fromTurnEvent(ev, ctx); if (e) j.note(app, e); } catch { /* a record, never a turn failure */ }
  switch (ev.type) {
    case 'text':
      app.render.text(ev.chunk);
      // THE HEADER'S OUTPUT COUNTER
      if (app.ui.enabled) app.ui.noteOutputChars((ev.chunk || '').length);
      // Buffered, not rendered per chunk: the feed shows sentences, and
      // repainting the screen on every token would be a redraw storm.
      ctx.liveText += ev.chunk || '';
      // BUT A COMPLETE THOUGHT GOES UP IMMEDIATELY.
      if (app.ui.enabled) ctx.liveText = flushParagraphs(app, ctx.liveText);
      break;

    // THE MODEL THINKING ALOUD
    case 'reasoning':
      ctx.reasoning = (ctx.reasoning || '') + (ev.chunk || '');
      // REASONING IS BILLED AS OUTPUT, so it is counted as output.
      if (app.ui.enabled) app.ui.noteOutputChars((ev.chunk || '').length);
      if (!app.ui.enabled) break;   // the line CLI never prints reasoning as text; the thinking phase gets one line
      // THINKING IS NOT SPEECH, AND IT IS NOT IN THE CONVERSATION
      if (process.env.LAIN_SHOW_THINKING === '1') {
        ctx.reasoning = flushParagraphs(app, ctx.reasoning);
      }
      break;

    // A THINKING PHASE ENDED (turn.js): folded to one line — ui/thoughtrow.js.
    case 'thought':
      if (!ev.thought) break;
      if (app.ui.enabled) app.ui.noteThought(ev.thought);
      else app.render.thought(ev.thought);
      break;

    // WHAT THE OPEN REQUEST HAS COST SO FAR
    case 'usage_live':
      if (app.ui.enabled) {
        app.ui.liveUsage = {
          inputTokens: ev.inputTokens || 0,
          cacheReadTokens: ev.cacheReadTokens || 0,
          cacheCreationTokens: ev.cacheCreationTokens || 0,
        };
        app.ui.refresh();
      }
      break;

    case 'tool_start':
      app.render.toolStart(ev.name, ev.input);
      (ctx.startedAt = ctx.startedAt || {})[ev.id] = Date.now();   // a shell row says how long it took
      // THE PROSE THAT PRECEDED THIS CALL ENTERS THE FEED NOW, not at its result (2026-09-23).
      if (app.ui.enabled && ctx.liveText.trim()) { app.ui.noteNarration(ctx.liveText.trim()); ctx.liveText = ''; }
      // TWO FACTS, NOT ONE. "The model asked for this" and "this is running" are different events to a companion: the first is a decision, the second is…
      busOf(app).emit(EVENT.MODEL_TOOL_CALL, { tool: ev.name, target: describeTarget(ev.name, ev.input) });
      busOf(app).emit(EVENT.TOOL_STARTED, { tool: ev.name, target: describeTarget(ev.name, ev.input) });
      // Show the call in flight, so the workspace is never silent while the
      // model works. Pure redraw — no request, no extra token.
      if (app.ui.enabled) app.ui.setRunning(ev.name, describeTarget(ev.name, ev.input));
      break;

    case 'tool_result': {
      app.render.toolResult(ev.name, ev.output, ev.isError);
      busOf(app).emit(EVENT.TOOL_COMPLETED, {
        tool: ev.name,
        ok: !ev.isError,
        summary: firstLine(ev.output),
      });
      if (!app.ui.enabled) break;
      // The prose that PRECEDED this call, then the call itself — the same interleaving the persisted record uses, so the feed does not reorder itself when…
      if (ctx.liveText.trim()) { app.ui.noteNarration(ctx.liveText.trim()); ctx.liveText = ''; }
      const out = String(ev.output == null ? '' : ev.output);
      // THE LIVE ROW CARRIES ITS FILE AND ITS SIZE, so the turn in flight draws the same CHANGE row and [Diff] the finished turn will (ui/turnsections.js)…
      let edit = null;
      if (!ev.isError && require('./tools').isMutating(ev.name) && ev.input && ev.input.path) {
        try { edit = noteEdit(app, ev.input.path); } catch { /* the turn is unaffected */ }
      }
      app.ui.noteAction({
        name: ev.name,
        target: describeTarget(ev.name, ev.input),
        ok: !ev.isError,
        exitCode: ev.exitCode == null ? null : ev.exitCode,
        ms: ctx.startedAt && ctx.startedAt[ev.id] ? Date.now() - ctx.startedAt[ev.id] : 0,
        // THE ONE FIRST-LINE RULE, NOT A SECOND COPY OF IT
        note: describe.firstLine(out),
        brief: out.length <= BRIEF,
        // The tail of a command's output, the same rule as the settled row (describe.outputTail).
        ...(SHELL_TOOLS.has(ev.name) ? describe.outputTail(out) : {}),
        file: Boolean(ev.input && ev.input.path),
        // Whether this call's result went to the OUTPUT surface, so Context can
        // point at it instead of repeating it.
        output: SHELL_TOOLS.has(ev.name),
        // WHO DID THIS. A `computer` call is the bridge acting on the machine, not LAIN reading a file, and the status strip colours them apart.
        actor: ev.name === 'computer' ? 'MCP' : 'TOOL',
        path: (ev.input && ev.input.path) || null,
        // THE SAME PER-CALL SIZE the turn record keeps (describe.js editSize), so the
        // row does not change its numbers at settlement; the reel's file total is a fallback.
        ...(edit ? { added: edit.added, removed: edit.removed } : {}),
        ...(ev.size && ev.size.name === ev.name && ev.size.path === ((ev.input && ev.input.path) || null) && (ev.size.added || ev.size.removed) ? { added: ev.size.added, removed: ev.size.removed } : {}),
      });
      // AN INTEGRATED CANDIDATE writes several files in one call (candidates.js):
      // each gets the same live CHANGE row and Diff a write of the main agent's does.
      if (!ev.isError && ev.meta && Array.isArray(ev.meta.paths) && !(ev.input && ev.input.path)) {
        for (const p of ev.meta.paths) {
          let e = null;
          try { e = noteEdit(app, p); } catch { /* the turn is unaffected */ }
          app.ui.noteAction({ name: 'write_file', target: p, ok: true, file: true, path: p, actor: 'TOOL', ...(e ? { added: e.added, removed: e.removed } : {}) });
        }
      }
      // AN EDIT SHOWS ITS CHANGE, ONCE
      if (!ev.isError && READ_TOOLS.has(ev.name) && ev.input && ev.input.path && app.ui.showRead) {
        try { app.ui.showRead(describeTarget(ev.name, ev.input), ev.output); } catch { /* presentation only */ }
      }
      app.ui.setRunning(null);
      // A computer call is the BRIDGE acting on the machine, not LAIN reading
      // a file, and Context labels it so.
      if (ev.name === 'computer' && !ev.isError) {
        const first = String(ev.output || '').split('\n')[0];
        app.ui.noteActor('mcp', first.slice(0, 120));
      }
      if (SHELL_TOOLS.has(ev.name)) {
        app.ui.noteOutput((ev.input && ev.input.command) || ev.name, ev.output, ev.exitCode);
      }
      break;
    }

    case 'notice':
      // A NOTICE ADDRESSED TO A SURFACE goes to the bottom of the screen, never into the conversation.
      if (ev.transient) {
        require('./ui/operation').say(app, ev.message, ev.level || 'info');
        break;
      }
      if (app.ui.enabled && require('./compacttip').onNotice(app, ev)) break;
      if (ev.surface && app.ui.enabled) {
        app.render.openSurface(ev.surface, { busy: Boolean(ev.working) });
        app.render.write(`${ev.message}\n`);
        // IT CLEARS ITSELF WHEN THE WORK IS DONE.
        if (!ev.working) app.render.doneSurface({ closeAfterMs: COMPACT_FLASH_MS });
        break;
      }
      if (app.ui.enabled) app.ui.noteSystem(ev.message, ev.level);
      else app.render.notice(ev.level, ev.message);
      break;
    // THE PROVIDER SPEAKING, AT THE BOTTOM
    case 'provider_failure':
      if (app.ui.enabled) {
        app.render.openSurface('PROVIDER');
        app.render.providerFailure(ev);
        app.render.doneSurface();
      } else {
        app.render.providerFailure(ev);
      }
      break;
    case 'done':
      ctx.record = ev.record;
      // THE TURN ENDING ENDS THE ADVISORY TOO.
      if (app.ui.enabled && app.ui.panel.isAdvisory) app.ui.panel.close(null);
      // A LAST THOUGHT WITH NO PARAGRAPH AFTER IT
      if (app.ui.enabled && ctx.reasoning && ctx.reasoning.trim()) {
        app.ui.noteNarration(ctx.reasoning.trim());
        ctx.reasoning = '';
      }
      noteInterruption(app, ev.record);
      // COMPLETED AND FAILED ARE DIFFERENT ANSWERS, and a companion that shows one word for both is the "it says DONE and nothing worked" problem in another…
      busOf(app).emit(
        ev.record && (ev.record.stopReason === 'provider' || ev.record.stopReason === 'no-credential')
          ? EVENT.TASK_FAILED
          : EVENT.TASK_COMPLETED,
        {
          stopReason: (ev.record && ev.record.stopReason) || 'end',
          toolCalls: (ev.record && ev.record.toolCalls) || 0,
          text: (ev.record && ev.record.text) || '',
        },
      );
      break;
    default: break;
  }
  return ctx;
}

/** The first line of a tool result — all a companion's status row can show. */
function firstLine(text) {
  const s = String(text == null ? '' : text);
  const at = s.indexOf('\n');
  return (at < 0 ? s : s.slice(0, at)).trimEnd().slice(0, 200);
}

/** Move every COMPLETED paragraph out of the buffer and onto the screen. */
const LONG = 600;
function flushParagraphs(app, buf) {
  let rest = String(buf || '');
  let cut = rest.lastIndexOf('\n\n');
  if (cut < 0 && rest.length > LONG) {
    // The last sentence end that is not the very tail: the tail is probably
    // still being written, and flushing it would split a sentence in two.
    const m = rest.slice(0, -40).match(/[\s\S]*[.!?]["')\]]?\s/);
    if (m) cut = m[0].length - 1;
  }
  if (cut < 0) return rest;
  const whole = rest.slice(0, cut).trim();
  if (whole) app.ui.noteNarration(whole);
  return rest.slice(cut).replace(/^\s+/, '');
}

/** MODEL INTERRUPTED — said plainly, with the reason, in the conversation. */
/** Who stopped the turn, in the words the note uses. */
const WHO = {
  aborted: 'TURN STOPPED',
  provider: 'PROVIDER REFUSED',
  'no-credential': 'NOT AUTHENTICATED',
  blocked: 'TASK BLOCKED',
  'max-steps': 'STEP LIMIT',
  'no-progress': 'TASK PENDING',
};

const WHY = {
  // YOUR limit, not LAIN's. With maxSteps unset this never happens.
  'max-steps': 'it reached the step limit you configured',
  aborted: 'you interrupted it',
  provider: 'the provider stopped answering',
  blocked: 'it was blocked for producing no new evidence',
  'no-credential': 'there is no usable credential',
  'no-progress': 'no file was changed and no passing check showed none was needed, even after one wake-up',
};
/** ENDINGS THAT ARE NOT NEWS, AND MUST NOT BECOME DURABLE GLUE. */
// `rate-limited` too: the live row and the wait/change question already say it, and the
// state must CLEAR on recovery — a durable note outlived it under every later turn (2026-09-19).
const NOT_NEWS = new Set(['aborted', 'rate-limited']);

function noteInterruption(app, record) {
  if (!app.ui.enabled || !record) return;
  const why = record.stopReason;
  if (!why || why === 'end') return;
  if (NOT_NEWS.has(why)) return;
  // WHO ACTUALLY STOPPED, because "MODEL INTERRUPTED — the provider stopped answering" names the wrong one twice over: the model did not interrupt…
  const pf = record.providerFailure;
  if (why === 'provider' && pf && (pf.kind === 'TIMEOUT' || pf.kind === 'UNAVAILABLE')) return;
  const who = WHO[why] || 'MODEL INTERRUPTED';
  app.ui.noteActor('note', `${who} — ${WHY[why] || why}`);
}

module.exports = { apply, flushParagraphs, noteInterruption, SHELL_TOOLS, BRIEF, WHY };
