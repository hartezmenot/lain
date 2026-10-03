'use strict';

/** A SCRIPTED PROVIDER, for testing the real binary. */

const fs = require('fs');

// Per-PROCESS cursor. Each smoke test spawns its own binary, so this is the natural lifetime; within one process, multi-turn scripts sequence across…
let cursor = 0;
let script = null;
let loadedFrom = null;

function loadScript() {
  const p = process.env.LAIN_MOCK_SCRIPT;
  if (script && loadedFrom === (p || null)) return script;
  if (script) cursor = 0;   // a new script (another test) starts at its first step
  loadedFrom = p || null;
  if (!p) { script = []; return script; }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    script = Array.isArray(data) ? data : [];
  } catch (e) {
    process.stderr.write(`lain: mock script unreadable (${p}): ${e.message}\n`);
    script = [];
  }
  return script;
}

async function* chat(pc, messages, opts = {}) {
  // MEASUREMENT SEAM. `LAIN_MOCK_WIRELOG` appends one line per request with the size of the payload that was actually about to be sent. That number is…
  if (process.env.LAIN_MOCK_WIRELOG) {
    const chars = messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
    try { fs.appendFileSync(process.env.LAIN_MOCK_WIRELOG, `${messages.length}\t${chars}\n`); } catch { /* measurement must never break a run */ }
  }
  const steps = loadScript();
  const step = steps[cursor];
  cursor++;

  if (!step) {
    yield { type: 'text', chunk: 'Nothing further to do.' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    return;
  }

  // A PROVIDER THAT TAKES TIME
  if (step.delayMs > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, step.delayMs);
      const sig = opts && opts.signal;
      if (!sig) return;
      if (sig.aborted) { clearTimeout(t); resolve(); return; }
      sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (opts && opts.signal && opts.signal.aborted) return;
  }

  if (step.error) {
    const e = new Error(step.error.message || step.error.code || 'mock provider failure');
    if (step.error.status) e.status = step.error.status;
    if (step.error.code) e.code = step.error.code;
    if (step.error.retryAfter) e.retryAfter = step.error.retryAfter;
    throw e;
  }

  // A REASONING-ONLY RESPONSE, which is what a real route did and what left Context empty.
  if (typeof step.reasoning === 'string' && step.reasoning) {
    for (const part of step.reasoning.match(/\S+\s*|\s+/g) || [step.reasoning]) {
      if (opts.signal && opts.signal.aborted) break;
      if (step.reasoningDelayMs > 0) await new Promise((r) => setTimeout(r, step.reasoningDelayMs));   // a slow think, observable
      yield { type: 'reasoning', chunk: part };
    }
  }

  if (typeof step.text === 'string' && step.text) {
    // Stream in chunks so the renderer's streaming path is genuinely exercised.
    for (const part of step.text.match(/\S+\s*|\s+/g) || [step.text]) {
      if (opts.signal && opts.signal.aborted) break;
      // `chunkDelayMs` paces the words, so a streaming answer is observable.
      if (step.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, step.chunkDelayMs));
      yield { type: 'text', chunk: part };
    }
  }

  // `{ "toolStreamMs": 3000 }` streams each call's arguments over that long, in slices, the way a router relays a 10 KB `edit_file` — the liveness record…
  if (Array.isArray(step.tool_calls) && step.tool_calls.length && step.toolStreamMs > 0 && opts.live) {
    const progress = require('./streamprogress');
    const calls = step.tool_calls;
    const slices = 20;
    for (let i = 0; i < calls.length; i++) {
      const raw = typeof calls[i].args === 'string' ? calls[i].args : JSON.stringify(calls[i].input || {});
      for (let k = 1; k <= slices; k++) {
        if (opts.signal && opts.signal.aborted) return;
        await new Promise((r) => setTimeout(r, step.toolStreamMs / calls.length / slices));
        progress.bytes(opts.live, Math.ceil(raw.length / slices) + 40);
        progress.toolDelta(opts.live, { name: calls[i].name, bytes: Math.round(raw.length * k / slices), index: i, calls: calls.length });
      }
    }
  }

  if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
    yield {
      type: 'tool_calls',
      calls: step.tool_calls.map((c, i) => ({
        id: c.id || `mock_${cursor}_${i}`,
        name: String(c.name || ''),
        // `args` scripts the RAW argument text a provider streamed — a cut or
        // mistranslated call is then parsed exactly as a real one is (finish.js).
        ...(typeof c.args === 'string' ? require('./finish').parseArgs(c.args) : { input: c.input && typeof c.input === 'object' ? c.input : {} }),
      })),
    };
  }

  // `finish` scripts WHY the generation ended: 'stop', 'length', 'content_filter'…
  if (step.finish) yield { type: 'finish', reason: require('./finish').normalize(step.finish), raw: step.finish };

  yield {
    type: 'usage',
    inputTokens: step.inputTokens || 100,
    outputTokens: step.outputTokens || 20,
  };
}

/** Test hook — resets the cursor within one process. */
function _reset() { cursor = 0; script = null; loadedFrom = null; }

module.exports = { chat, _reset };
