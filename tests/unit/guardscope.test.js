'use strict';

/**
 * GUARDS, FROM BOTH SIDES — because an over-restrictive guard is also a defect.
 *
 * ------------------------------------------------------------------------
 * THE ASYMMETRY THIS FILE EXISTS TO CORRECT.
 *
 * A safety mechanism is almost always tested by proving it REFUSES something.
 * That half is easy to write and easy to keep passing, and it is the half that
 * cannot tell you the guard has grown too wide. Every rule here is therefore
 * asserted twice: the thing it must stop, and the thing it must NOT stop.
 *
 * It is not hypothetical. The global turn lock passed every test it had — it
 * genuinely prevented two uncontrolled turns in one session — while making it
 * impossible to LOOK at a second conversation, which no test asked about
 * because no test asked what the guard allowed.
 *
 * For each: WHAT PROPERTY IS THIS ACTUALLY PROTECTING?
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

module.exports = async function () {
  await test('GUARD: navigation is allowed while a turn runs; a second turn in the SAME session is not uncontrolled', async () => {
    // PROPERTY: two uncontrolled turns must not mutate one session.
    // NOT THE PROPERTY: what a person may LOOK at.
    const routes = require('../../src/harnessapp/routes');
    const app = appAt(tmpdir('guard-'));
    const a = app.session.id;
    app.abort = new AbortController();

    // ALLOWED — every one of these is navigation, and none touches the turn.
    const made = await routes.dispatch(app, 'POST', '/api/session/new', {});
    assert.strictEqual(made.code, 200, 'creating a session while one runs');
    const cowork = await routes.dispatch(app, 'POST', '/api/session/new', { lane: 'cowork' });
    assert.strictEqual(cowork.code, 200, 'creating a Cowork session while one runs');
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/session/select', { id: made.body.id })).code, 200);
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/session/select', { id: a })).code, 200);
    assert.strictEqual((await routes.dispatch(app, 'GET', '/api/state', {})).code, 200, 'and reading state');

    // GUARDED — a sentence into the SAME working session does not start a
    // second turn. It becomes a steer, which is the contract, not a refusal.
    const typed = await routes.dispatch(app, 'POST', '/api/turn', { text: 'and also this' });
    assert.strictEqual(typed.body.steered, true, 'it is queued against the running turn');
    assert.ok(app.abort && !app.abort.signal.aborted, 'and the turn in flight is untouched');

    for (const id of [made.body.id, cowork.body.id]) require('../../src/sessionstore').forget(id);
  });

  await test('GUARD: the path gate stops what is outside the project and allows what is inside', async () => {
    // PROPERTY: a call may not touch a path this session has no business in.
    // NOT THE PROPERTY: making the project itself hard to work in.
    const gate = require('../../src/gate');
    const root = tmpdir('guard-fs-');
    fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
    const app = appAt(root);
    const trust = require('../../src/trust');

    // UNDECIDED IS *ASK*, NOT REFUSE — the third state, and the one an
    // over-restrictive guard collapses into a denial.
    const undecided = trust.check({ cfg: app.cfg, root, target: path.join(root, 'a.js'), write: true, mode: 'ask' });
    assert.strictEqual(undecided.ok, false);
    assert.strictEqual(undecided.ask, true, 'a directory nobody has ruled on is asked about, never silently denied');

    // ALLOWED — once the person has trusted the directory, its own files are
    // usable for reading AND writing without asking again per file.
    // `remember` RETURNS the new list rather than mutating the config — the
    // caller owns saving it. Getting that wrong here read as the guard refusing
    // a trusted directory, which is the false alarm this file is about.
    const cfg = { ...app.cfg, trustedPaths: trust.remember(app.cfg, root, trust.LEVEL.TRUSTED) };
    for (const write of [false, true]) {
      const v = trust.check({ cfg, root, target: path.join(root, 'a.js'), write, mode: 'ask' });
      assert.strictEqual(v.ok, true, `the project's own file must be usable (write=${write}): ${v.why}`);
    }

    // GUARDED — a credential store is never auto-allowed, whatever the mode.
    const secret = process.platform === 'win32'
      ? path.join(process.env.USERPROFILE || 'C:\\Users\\x', '.ssh', 'id_rsa')
      : path.join(process.env.HOME || '/home/x', '.ssh', 'id_rsa');
    const v = trust.check({ cfg: app.cfg, root, target: secret, write: true, mode: 'auto' });
    assert.notStrictEqual(v.ok, true, 'a credential location is not auto-approved even in AUTO');

    // AND THE GATE ITSELF STILL ANSWERS for an ordinary in-project call.
    const ok = await gate.check('read_file', { path: path.join(root, 'a.js') }, { app, cwd: root }, { mutates: false });
    assert.strictEqual(ok.ok, true, ok.output);
  });

  await test('GUARD: the computer refuses before authorization and works after it', async () => {
    // PROPERTY: LAIN does not drive the machine until a person says so.
    // NOT THE PROPERTY: making an authorised session ask again per action.
    const { Permissions, CAPABILITY, SCOPE } = require('../../src/permissions');
    // THE CAPABILITIES ARE THE ACTIONS, and `computer` is a SCOPE over them —
    // not a capability of its own. Keeping those apart is what lets one
    // authorization cover a piece of work without becoming a blanket grant.
    const caps = ['screen', 'keyboard', 'mouse', 'window'];
    for (const c of caps) assert.ok(CAPABILITY[c], `${c} is a real capability`);
    const p = new Permissions();

    // GUARDED — nothing is granted by default.
    for (const c of caps) assert.strictEqual(p.check(c).ok, false, `${c} is not open by default`);
    // AND THE CLIPBOARD IS NOT SWEPT IN by authorising the desktop: it is its
    // own capability and stays ungranted unless it was asked for.
    assert.strictEqual(p.check('clipboard').ok, false);

    // ALLOWED — and once granted for the SESSION it does not lapse on a clock,
    // because a person authorised a piece of work rather than sixty seconds.
    p.grant(caps, { scope: SCOPE.COMPUTER, target: 'this machine' });
    for (const c of caps) assert.strictEqual(p.check(c).ok, true, `the authorised session may ${c}`);
    assert.strictEqual(p.check('clipboard').ok, false, 'and only what was granted');
    const far = new Permissions({ now: () => Date.now() + 1000 * 60 * 60 * 24 });
    far.grant(caps, { scope: SCOPE.COMPUTER });
    assert.strictEqual(far.check('screen').ok, true, 'and is not expired out from under the work');
    // WHEREAS AN ORDINARY GRANT STILL EXPIRES — the session scope is the
    // exception, deliberately, not the new default for everything.
    const soon = new Permissions({ now: () => Date.now() + 1000 * 60 * 60 });
    soon.grant(['screen'], { scope: SCOPE.SESSION });
    soon._now = () => Date.now() + 1000 * 60 * 60 * 2;
    assert.strictEqual(soon.check('screen').ok, false, 'a clock-scoped grant lapses');

    // AND IT ENDS WHEN SOMEBODY ENDS IT — the grant is revocable, not eternal.
    p.revoke('you stopped it');
    for (const c of caps) assert.strictEqual(p.check(c).ok, false, 'revoking really revokes');
  });

  await test('GUARD: two sessions on one project are warned, and one session is not warned about itself', () => {
    // PROPERTY: a session must not silently write over another session's work.
    // NOT THE PROPERTY: a session tripping over its own writes.
    const evidence = require('../../src/evidence');
    const root = tmpdir('guard-two-');
    const file = path.join(root, 'shared.js');
    fs.writeFileSync(file, 'module.exports = 1;\n');
    const mine = new evidence.EvidenceLedger(root, 'session-A');
    const theirs = new evidence.EvidenceLedger(root, 'session-B');

    evidence.noteWrite(root, file, 'session-A');
    // ALLOWED — A's own second write is not foreign to A.
    assert.strictEqual(evidence.foreignWrite(mine, root, file, 'session-A'), null);
    // GUARDED — and B is told whose write it was, by name.
    const seen = evidence.foreignWrite(theirs, root, file, 'session-B');
    assert.ok(seen && seen.by === 'session-A', 'the other session is named, not merely refused');
  });

  await test('GUARD: no guard was widened into a blanket exemption', () => {
    // The failure mode of fixing an over-restrictive guard is replacing it with
    // nothing. A guard file that grew an "always allow" escape would pass every
    // test above and protect nothing.
    for (const f of ['gate.js', 'trust.js', 'permissions.js', 'workorderguard.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/LAIN_(DISABLE|SKIP|NO)_(GATE|TRUST|PERMISSION)/i.test(src),
        `${f} must not carry an environment switch that turns it off`);
      assert.ok(!/return\s*\{\s*ok:\s*true\s*\}\s*;\s*\/\/\s*TODO/i.test(src), `${f} has a stubbed-open path`);
    }
  });
};
