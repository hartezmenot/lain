'use strict';

/**
 * A STREAM THAT GOES SILENT MID-REPLY IS RESUMED, NOT THE END OF THE TURN.
 *
 * Reported 2026-09-19 from a real session: after forty actions the model
 * streamed one sentence, then went silent while composing a ~12KB tool call the
 * router buffers whole. At 60s LAIN ended the turn, and the screen said it
 * twice under two names:
 *
 *     ERROR  NETWORK — stream inactive for 60s
 *     NOTE   PROVIDER REFUSED — the provider stopped answering
 *     TIP · /compact can reduce context usage.
 *
 * Now: the bound is 180s; a stall after the reply started keeps the text and
 * resumes the step (bounded); a stall that does not recover is ONE row named
 * STREAM STALLED; no "refused" note; no /compact tip under it.
 *
 * A real SSE server holds the socket open without writing — the real parser's
 * inactivity guard fires, and the real turn loop runs on the result.
 */

const assert = require('assert');
const http = require('http');
const { test, tmpdir } = require('../helpers');
const { runTurn } = require('../../src/turn');
const { Session } = require('../../src/session');

const chatText = (t) => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const chatEnd = (reason) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** Each script: {text, stall} writes text then goes silent; {text, end} finishes. */
function server(scripts) {
  const bodies = [];
  const open = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { bodies.push(null); }
        const s = scripts.shift();
        if (!s) { res.writeHead(500); res.end('no more'); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(chatText(s.text))}\n\n`);
        if (s.stall) { open.push(res); return; }   // silent, socket held open
        res.write(`data: ${JSON.stringify(chatEnd('stop'))}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, bodies, close: () => { for (const r of open) r.destroy(); srv.close(); } }));
  });
}

async function turnOn(scripts) {
  const s = await server(scripts);
  const session = new Session({ cwd: tmpdir('stall-') });
  const cfg = { model: 'm', connection: 'x', connections: { x: { provider: 'x', via: 'native', auth: 'api_key', apiKey: 'k', baseUrl: `http://127.0.0.1:${s.srv.address().port}/v1`, models: ['m'] } } };
  const events = [];
  let record = null;
  process.env.LAIN_STREAM_TIMEOUT_MS = '80';
  process.env.LAIN_BACKOFF_MS = '1,1,1,1,1,1,1,1,1,1';
  try {
    for await (const ev of runTurn(session, 'write the store module', { cfg, maxConnectionRetries: 1, steer: () => [], evidence: session.evidence, lifecycle: session.lifecycle })) {
      events.push(ev);
      if (ev.type === 'done') record = ev.record;
    }
  } finally { s.close(); delete process.env.LAIN_STREAM_TIMEOUT_MS; delete process.env.LAIN_BACKOFF_MS; }
  return { record, events, session, bodies: s.bodies };
}

const noteText = (body) => JSON.stringify(body && body.messages);

module.exports = async function () {
  await test('STALL: a reply that goes silent after it started is RESUMED with its text kept — the turn completes', async () => {
    const { record, events, bodies } = await turnOn([
      { text: 'Now the list-domain CRUD in store.py.', stall: true },
      { text: 'Continuing: the CRUD is written in smaller pieces.' },
    ]);
    assert.strictEqual(record.stopReason, 'end', JSON.stringify(record.errors));
    assert.strictEqual(record.stallResumes, 1);
    assert.strictEqual(bodies.length, 2, 'one resumed request, not a retry storm');
    const second = noteText(bodies[1]);
    assert.match(second, /Now the list-domain CRUD in store\.py\./, 'what was said before the stall is KEPT in the conversation');
    assert.match(second, /STALLED/, 'the resumed step is told why');
    assert.ok(events.some((e) => e.type === 'notice' && e.transient && /STREAM STALLED/.test(e.message)), 'a transient says it is resuming');
    assert.deepStrictEqual(record.errors, [], 'a recovered stall is not an error on the turn');
  });

  await test('STALL: one that does not recover ends as ONE row, STREAM STALLED — not "PROVIDER REFUSED", no /compact tip', async () => {
    const { record } = await turnOn([
      { text: 'Step one.', stall: true },
      { text: ' Step two.', stall: true },
      { text: ' Step three.', stall: true },
    ]);
    assert.strictEqual(record.stopReason, 'provider');
    assert.strictEqual(record.errors.length, 1);
    const row = require('../../src/ui/failure').failureRow(record.errors[0]);
    assert.strictEqual(row.word, 'STREAM STALLED');
    assert.match(row.detail, /went silent mid-reply/);
    assert.match(row.detail, /resumed 2× without recovering/);
    assert.match(row.detail, /continue/, 'the next action is named');

    const said = [];
    require('../../src/turnevents').noteInterruption({ ui: { enabled: true, noteActor: (k, t) => said.push(t) } }, record);
    assert.deepStrictEqual(said, [], 'no second, differently-named note for the same event');

    let tipped = false;
    const app = { session: { turns: [record], contextChars: () => 10_000_000 }, cfg: {}, transient: () => { tipped = true; } };
    assert.strictEqual(require('../../src/compacttip').afterTurn(app), false);
    assert.strictEqual(tipped, false, '/compact is not offered as the remedy for a stalled stream');
  });

  await test('STALL: a real refusal still says PROVIDER REFUSED, and the default bound is no longer 60s', () => {
    const said = [];
    require('../../src/turnevents').noteInterruption({ ui: { enabled: true, noteActor: (k, t) => said.push(t) } },
      { stopReason: 'provider', providerFailure: { kind: 'BAD_REQUEST' } });
    assert.match(said[0], /PROVIDER REFUSED/);
    const src = require('fs').readFileSync(require.resolve('../../src/provider'), 'utf8');
    assert.match(src, /LAIN_STREAM_TIMEOUT_MS\) \|\| 180_000/);
  });
};
