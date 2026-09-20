'use strict';

/**
 * SESSION LIFECYCLE — a running turn belongs to its session, not to LAIN.
 *
 * ------------------------------------------------------------------------
 * THE REGRESSION THESE EXIST FOR, in one sentence: opening or creating a
 * conversation was refused while any other conversation was working.
 *
 * It was one variable doing two jobs — `app.abort` answered both "is this
 * process busy" and "is this session busy" — so navigation was governed by
 * execution. The fix separates them (src/sessionpool.js), and these pin the
 * separation from both directions: what must now be allowed, and what must
 * still not be.
 *
 * REAL Apps, real sessions on disk. A pool of stubs would prove that stubs do
 * not refuse each other.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: cwd || process.cwd(),
  });
}

/** Sessions this file created, removed at the end so the rail stays clean. */
const made = [];
function track(id) { if (id) made.push(id); return id; }

module.exports = async function () {
  await test('POOL: a turn running in A does not stop B being opened or C created', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const a = app.session.id;

    const b = track(pool.create({}).id);
    const c = track(pool.create({}).id);

    // A IS WORKING. Nothing below may consult this, and that is the whole test.
    app.abort = new AbortController();
    assert.strictEqual(pool.running(a), true, 'A is running');

    assert.strictEqual(pool.open(b).ok, true, 'B opens');
    assert.strictEqual(pool.create({}).ok, true, 'a new one is created');
    assert.strictEqual(pool.create({ lane: 'cowork' }).ok, true, 'a Cowork one too');
    assert.strictEqual(pool.open(c).ok, true, 'C opens');
    assert.strictEqual(pool.open(a).ok, true, 'and A can be returned to');

    // AND A IS STILL RUNNING. Nothing above cancelled, waited for or moved it.
    assert.strictEqual(pool.running(a), true, 'A is still running at the end');
    for (const id of pool.ids()) if (id !== a) track(id);
  });

  await test('POOL: running is a fact about ONE session', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const b = track(pool.create({}).id);
    app.abort = new AbortController();
    assert.strictEqual(pool.running(app.session.id), true);
    assert.strictEqual(pool.running(b), false, 'B is idle, and says so');
    // THE SIBLING HAS ITS OWN CONTROLLER, which is the point of a pool at all.
    assert.strictEqual(pool.live(b).abort, null);
    assert.notStrictEqual(pool.live(b), app, 'and its own App');
  });

  await test('POOL: a session opened by its short token is keyed by its real id', () => {
    // `Session.resume` takes the short form a person types (`ayze`) and returns
    // the full session. Keying the view on what was ASKED FOR would point the
    // window at a name nothing is registered under: `live()` misses, and the
    // view silently falls back to the terminal's session — the window showing a
    // different conversation than the one that was clicked.
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const full = track(pool.create({}).id);
    pool.release(full);                      // idle: really released
    assert.strictEqual(pool.live(full), null);

    const short = require('../../src/session').Session.shortId(full);
    const r = pool.open(short);
    assert.strictEqual(r.ok, true, `opened by short token ${short}`);
    assert.strictEqual(r.id, full, 'and reported under its real id');
    assert.strictEqual(pool.viewId, full, 'the view is keyed by the real id');
    assert.ok(pool.live(full), 'so the pool can find it again');
    assert.strictEqual(pool.view().session.id, full, 'and the view resolves to it');
  });

  await test('POOL: the view is not the executor', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const b = track(pool.create({}).id);
    app.abort = new AbortController();
    pool.open(b);
    assert.strictEqual(pool.viewId, b, 'the window is looking at B');
    // THE TERMINAL DID NOT MOVE, and neither did the work.
    assert.notStrictEqual(app.session.id, b, 'the terminal kept its own session');
    assert.ok(app.abort && !app.abort.signal.aborted, 'and its turn is untouched');
    assert.strictEqual(pool.view().session.id, b, 'the view resolves to B');
  });

  await test('POOL: a sibling shares the process facts and nothing about the conversation', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const sib = pool.live(track(pool.create({}).id));

    // SHARED — one answer to "is this route shut" and "did a request succeed".
    assert.strictEqual(sib.availability, app.availability, 'availability is the process\'s');
    assert.strictEqual(sib.connectionEvidence, app.connectionEvidence, 'so is connection evidence');
    assert.strictEqual(sib.cfg, app.cfg, 'and the configuration object');

    // NOT SHARED — everything a conversation owns.
    assert.notStrictEqual(sib.session, app.session);
    assert.notStrictEqual(sib.checkpoints, app.checkpoints, 'its own snapshots, or /undo crosses sessions');
    assert.notStrictEqual(sib.jobs, app.jobs);
    assert.notStrictEqual(sib.events, app.events);
    assert.strictEqual(sib.abort, null, 'and its own turn, which is the point');

    // AND IT HAS NO TERMINAL. A second App drawing frames would fight the CLI
    // for the screen; a sibling writes to a sink and never enables its UI.
    assert.strictEqual(sib.ui.enabled, false, 'a sibling never draws');
    assert.strictEqual(sib.interactive, false);
  });

  await test('POOL: closing a view is not stopping, and not deleting', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const b = track(pool.create({}).id);
    const sib = pool.live(b);
    sib.abort = new AbortController();           // B is working

    pool.release(b);
    // IT IS STILL LIVE AND STILL WORKING. Closing the tab you were watching work
    // in has never been an instruction to stop the work.
    assert.strictEqual(pool.running(b), true, 'B carries on');
    assert.ok(pool.live(b), 'and is still held');
    assert.notStrictEqual(pool.viewId, b, 'it is simply no longer the view');
    sib.abort = null;

    // NOW IT IS IDLE, so closing really does release the App — and STILL does
    // not touch the transcript.
    pool.release(b);
    assert.strictEqual(pool.live(b), null, 'the idle App is released');
    assert.ok(require('../../src/session').Session.list(500).includes(b), 'the conversation is kept');
  });

  await test('POOL: two Apps never hold one session — the terminal takes it back', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const b = track(pool.create({}).id);
    assert.strictEqual(pool.handover(b).ok, true, 'an idle session is handed over');
    assert.strictEqual(pool.live(b), null, 'and the window no longer holds it');

    const c = track(pool.create({}).id);
    pool.live(c).abort = new AbortController();
    const refused = pool.handover(c);
    // NOT MOVED OUT FROM UNDER ITSELF. The honest answer is that it is already
    // open here, not a silent second App on the same transcript.
    assert.strictEqual(refused.ok, false, 'a working session is not handed over');
    assert.match(refused.why, /running/);
    pool.live(c).abort = null;
  });

  await test('POOL: the rail says what each live session is doing', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const { statusOf } = require('../../src/sessionpool');

    assert.strictEqual(statusOf(app, false).state, 'IDLE', 'nothing has happened in it');
    assert.strictEqual(statusOf(app, true).state, 'RUNNING');
    assert.strictEqual(statusOf(app, true).spin, true);

    app.session.turns.push({ text: 'done', providerFailure: false });
    assert.strictEqual(statusOf(app, false).state, 'DONE');
    app.session.turns.push({ text: '', providerFailure: { kind: 'timeout' } });
    // FAILED is the public word (sessionstatus.js), and its SUMMARY keeps the
    // distinction the old STOPPED protected: it says the last TURN did not
    // finish — never that the work failed verification.
    assert.strictEqual(statusOf(app, false).state, 'FAILED');
    assert.match(statusOf(app, false).detail, /last turn did not finish/);

    const b = track(pool.create({}).id);
    const all = pool.statuses();
    assert.ok(all[app.session.id], 'the primary is in the rail');
    assert.ok(all[b], 'and so is the session the window opened');
  });

  await test('POOL: an idle App is evicted, and a working one never is', () => {
    const app = appAt(tmpdir('pool-'));
    const pool = app.pool();
    const keep = track(pool.create({}).id);
    pool.live(keep).abort = new AbortController();
    for (let i = 0; i < require('../../src/sessionpool').MAX_IDLE + 4; i++) track(pool.create({}).id);
    assert.ok(pool.live(keep), 'the working session survived the rail filling up');
    assert.ok(pool.apps.size <= require('../../src/sessionpool').MAX_IDLE + 2, 'and the rail is bounded');
    pool.live(keep).abort = null;
  });

  await test('POOL: two sessions on one project are governed by the EXISTING authority, not a new lock', () => {
    // ---- THE THING THE POOL MADE REACHABLE -----------------------------
    //
    // Before this, a second conversation could not run at the same time, so two
    // sessions writing one file was impossible by accident. It is possible now,
    // and §23 of the correction is explicit that the answer is the mutation
    // authority that already exists rather than a Desktop-specific lock.
    //
    // THE MECHANISM IS REAL AND IS PROCESS-WIDE: `evidence.foreignWrite` keys
    // writes by path across the whole process and reports a write made by a
    // DIFFERENT session owner. Asserted here rather than assumed, because the
    // pool is what made it load-bearing.
    const evidence = require('../../src/evidence');
    const root = tmpdir('pool-');
    const file = path.join(root, 'shared.js');
    fs.writeFileSync(file, 'module.exports = 1;\n');

    const ledgerA = new evidence.EvidenceLedger(root, 'session-A');
    const ledgerB = new evidence.EvidenceLedger(root, 'session-B');

    // A WRITES IT.
    evidence.noteWrite(root, file, 'session-A');
    // A's OWN second write is not foreign to A.
    assert.strictEqual(evidence.foreignWrite(ledgerA, root, file, 'session-A'), null);
    // B's write to the same file IS, and B is told whose it was.
    const seen = evidence.foreignWrite(ledgerB, root, file, 'session-B');
    assert.ok(seen, 'the other session is warned about a write it did not make');
    assert.strictEqual(seen.by, 'session-A');

    // AND THE POOL ITSELF ADDS NO LOCK OF ITS OWN. Navigation is not mutation
    // authority: a second answer to "may this write proceed" is exactly what
    // §23 forbids.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sessionpool.js'), 'utf8');
    assert.ok(!/\block\b|mutex|acquire|semaphore/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
      'the pool holds no lock — the mutation authority decides');
  });

  await test('POOL: deleting is the only thing that removes a transcript', () => {
    // EVERY OTHER VERB KEEPS IT. This is the §11 boundary as a property: nothing
    // in the closing path may reach the deleting path.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sessionpool.js'), 'utf8');
    assert.ok(!/unlinkSync|rmSync|rmdirSync|sessionstore/.test(src),
      'the pool can close a view and cannot delete a conversation');
    const store = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sessionstore.js'), 'utf8');
    assert.match(store, /unlinkSync/, 'and deletion lives in one named place');
    // IT TAKES A FULL ID. A short token that is unique today is ambiguous
    // tomorrow, which is survivable for "open" and not for this.
    const { forget } = require('../../src/sessionstore');
    assert.strictEqual(forget('').ok, false);
    assert.strictEqual(forget('nope-nope').ok, false);
  });

  // Whatever these created, removed — including anything a failed case left.
  for (const id of made) { try { require('../../src/sessionstore').forget(id); } catch { /* gone */ } }
};
