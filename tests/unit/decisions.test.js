'use strict';

/** §39–40, §78 — one Core decision, first valid answer wins, signed remote answers. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const decisions = require('../../src/decisions');

module.exports = async function () {
  await test('DECISION: one record on disk; the first valid answer wins; later ones are told who answered', () => {
    decisions._reset();
    const d = decisions.create({ type: 'PERMISSION_REQUEST', sessionId: 's1', title: 't', question: 'q', options: ['Allow once', 'Deny'] });
    assert.ok(fs.existsSync(path.join(decisions.dir(), `${d.id}.json`)));
    const first = decisions.resolve(d.id, 'Allow once', { surface: 'cli' });
    assert.strictEqual(first.ok, true);
    const second = decisions.resolve(d.id, 1, { surface: 'telegram', sig: d.sig });
    assert.strictEqual(second.ok, false);
    assert.match(second.why, /already answered in cli/);
    assert.strictEqual(decisions.get(d.id).answer, 'Allow once');
  });

  await test('DECISION: a remote answer without the right signature is refused', () => {
    const d = decisions.create({ type: 'ASK_USER', options: ['A', 'B'] });
    assert.strictEqual(decisions.resolve(d.id, 0, { surface: 'telegram', sig: '0000000000000000' }).why, 'bad signature');
    assert.strictEqual(decisions.get(d.id).state, 'PENDING');
    assert.strictEqual(decisions.resolve(d.id, 0, { surface: 'telegram', sig: d.sig }).ok, true);
  });

  await test('DECISION: the Telegram token is id+signature, 24 hex — the existing callback shape', () => {
    const d = decisions.create({ options: ['x'] });
    assert.match(decisions.token(d), /^[0-9a-f]{24}$/);
  });

  await test('DECISION: an expired decision cannot be answered', () => {
    const d = decisions.create({ options: ['x'], ttlMs: 1000 });
    const rec = JSON.parse(fs.readFileSync(path.join(decisions.dir(), `${d.id}.json`), 'utf8'));
    rec.expires = Date.now() - 1;
    fs.writeFileSync(path.join(decisions.dir(), `${d.id}.json`), JSON.stringify(rec));
    assert.strictEqual(decisions.resolve(d.id, 'x', { surface: 'cli' }).why, 'expired');
  });

  await test('DECISION: ask() — a remote answer resolves the SAME decision and closes the local panel', async () => {
    decisions._reset();
    let closedWith;
    const panel = { stack: [], close(v) { closedWith = v; this.stack = []; if (this._r) this._r(v); } };
    const app = {
      session: { id: 'sess', cwd: process.cwd() },
      ui: { enabled: true, panel, ask: () => new Promise((r) => { panel.stack = [{}]; panel._r = r; }) },
    };
    app.ui.askUser = app.ui.ask;
    const p = decisions.ask(app, { type: 'PERMISSION_REQUEST', title: 'x', question: 'y', options: ['Allow once', 'Deny'] }, null, () => app.ui.ask());
    await new Promise((r) => setTimeout(r, 20));
    const open = decisions.pending('sess');
    assert.strictEqual(open.length, 1, 'exactly one pending record — no duplicate approval state');
    const r = decisions.resolve(open[0].id, 1, { surface: 'telegram', sig: open[0].sig });
    assert.ok(r.ok);
    assert.strictEqual(await p, 'Deny');
    assert.strictEqual(closedWith, 'Deny', 'the CLI panel closed with the remote answer');
  });

  await test('DECISION: with no local surface and no remote listener, ask() returns null at once instead of hanging', async () => {
    decisions._reset();
    try { fs.unlinkSync(path.join(decisions.dir(), '.remote')); } catch { /* none */ }
    const t0 = Date.now();
    const v = await decisions.ask({ session: { id: 'z', cwd: '.' }, ui: { enabled: false } }, { options: ['a'] });
    assert.strictEqual(v, null);
    assert.ok(Date.now() - t0 < 500);
  });

  await test('DECISION: the bot bridge resolves a button press with the signed token, and refuses a forged one', () => {
    const { Attention } = require('../../src/bot/attention');
    const sent = [];
    const bridge = new Attention({ delivery: { sendMessage: async (t, text) => { sent.push(text); return []; } }, targets: [{ platform: 'telegram', chatId: '1' }] });
    const d = decisions.create({ type: 'CAPABILITY_REQUEST', options: ['Allow once', 'Allow session', 'Deny'] });
    const forged = `${d.id}${'f'.repeat(16)}`;
    assert.strictEqual(bridge.resolve({ promptResponse: { id: forged, value: '1' }, text: '' }), true);
    assert.strictEqual(decisions.get(d.id).state, 'PENDING', 'a forged signature changes nothing');
    assert.strictEqual(bridge.resolve({ promptResponse: { id: decisions.token(d), value: '2' }, text: '' }), true);
    assert.strictEqual(decisions.get(d.id).answer, 'Allow session');
    assert.strictEqual(decisions.get(d.id).surface, 'telegram');
  });

  await test('DECISION: a question whose asking process is gone is ABANDONED — no surface offers it after a restart', () => {
    const d = decisions.create({ type: 'PERMISSION_REQUEST', sessionId: 'dead', options: ['Allow once', 'Deny'] });
    const file = path.join(decisions.dir(), `${d.id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.pid = 999999; // no such process
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.strictEqual(decisions.get(d.id).state, 'ABANDONED');
    assert.strictEqual(decisions.pending('dead').length, 0);
    assert.strictEqual(decisions.resolve(d.id, 0, { surface: 'telegram', sig: rec.sig }).ok, false);
  });

  await test('ATTENTION: routine events are never written; the four attention kinds are', () => {
    const notify = require('../../src/notify');
    const app = { session: { id: 's', cwd: process.cwd() } };
    assert.strictEqual(notify.attention(app, 'TOOL_CALL', 'x'), false);
    for (const k of ['BLOCKED', 'BACKGROUND_COMPLETE', 'TASK_COMPLETE', 'FAILED']) assert.strictEqual(notify.attention(app, k, 'x'), true);
  });
};
