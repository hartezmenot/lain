'use strict';

/**
 * FAST · NORMAL · ECO — the execution profile (profile.js).
 *
 * Strategy and spend differ; the correctness bar does not. Orthogonal to
 * AUTO/MANUAL/PLAN and to FOCUS.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const profile = require('../../src/profile');
const execmode = require('../../src/execmode');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');

module.exports = async function () {
  await test('PROFILE: NORMAL by default; Normal · Fast · Eco only (Phase 8.1); a saved SLOW reads — and re-saves — as ECO; a legacy fast session reads FAST', () => {
    const s = new Session({ cwd: tmpdir('prof-') });
    assert.strictEqual(profile.of(s), 'NORMAL');
    assert.deepStrictEqual(profile.PROFILES, ['FAST', 'NORMAL', 'ECO'], 'Slow is not a profile');
    assert.strictEqual(profile.set(s, 'slow'), 'ECO', 'the retired SLOW is ECO');
    s.profile = 'SLOW';
    assert.strictEqual(profile.of(s), 'ECO', 'a session saved as SLOW reads as ECO');
    const saved = new Session({ cwd: tmpdir('prof-r-') });
    saved.profile = 'SLOW'; require('../../src/workbench').of(saved).pendingProfile = 'SLOW'; saved.save();
    const r2 = Session.resume(saved.id);
    assert.strictEqual(r2.profile, 'ECO', 'resume migrates a saved SLOW to ECO');
    assert.strictEqual(r2.workbench.pendingProfile, 'ECO', 'and a queued SLOW');
    assert.strictEqual(profile.of(new Session({ cwd: tmpdir('prof-e-') }), { executionProfile: 'slow' }), 'ECO', 'a configured SLOW default is ECO');
    assert.strictEqual(profile.set(s, 'FAST'), 'FAST');
    assert.strictEqual(s.fast, true, 'the older boolean follows');
    const legacy = new Session({ cwd: tmpdir('prof-l-') }); legacy.fast = true;
    assert.strictEqual(profile.of(legacy), 'FAST');
    assert.strictEqual(profile.of(new Session({ cwd: tmpdir('prof-c-') }), { executionProfile: 'eco' }), 'ECO', 'a configured default is honoured');
  });

  await test('PROFILE TOGGLE: /fast and /eco toggle their own profile; /normal resets; on/off never flip', () => {
    const t = profile.toggle;
    assert.strictEqual(t('NORMAL', 'FAST'), 'FAST');
    assert.strictEqual(t('FAST', 'FAST'), 'NORMAL');
    assert.strictEqual(t('NORMAL', 'ECO'), 'ECO');
    assert.strictEqual(t('ECO', 'ECO'), 'NORMAL');
    assert.strictEqual(t('FAST', 'ECO'), 'ECO');
    assert.strictEqual(t('ECO', 'FAST'), 'FAST');
    assert.strictEqual(t('ECO', 'NORMAL'), 'NORMAL');
    assert.strictEqual(t('FAST', 'NORMAL'), 'NORMAL');
    assert.strictEqual(t('FAST', 'FAST', 'on'), 'FAST', '`on` is explicit');
    assert.strictEqual(t('NORMAL', 'FAST', 'off'), 'NORMAL');
    assert.strictEqual(t('SLOW', 'ECO'), 'NORMAL', 'a saved SLOW is ECO, so /eco returns to Normal');
    assert.strictEqual(t('SLOW', 'FAST'), 'FAST');
  });

  await test('PROFILE TOGGLE: through the registered commands, FOCUS and AUTO/MANUAL/PLAN untouched', async () => {
    const commands = require('../../src/commands');
    const { App } = require('../../src/app');
    const a = new App({ interactive: false, cwd: tmpdir('prof-cmd-') });
    a.render.write = () => {}; a.render.openSurface = () => {}; a.render.closeSurface = () => {};
    a.session.save = () => {};
    execmode.set(a.session, 'MANUAL');
    a.session.focus = true;
    const seq = [['/fast', 'FAST'], ['/fast', 'NORMAL'], ['/eco', 'ECO'], ['/eco', 'NORMAL'],
      ['/fast', 'FAST'], ['/eco', 'ECO'], ['/fast', 'FAST'], ['/normal', 'NORMAL']];
    for (const [cmd, want] of seq) {
      await commands.run(a, cmd);
      assert.strictEqual(profile.of(a.session), want, `${cmd} → ${want}`);
      assert.strictEqual(execmode.of(a.session), 'ASK', 'the authority mode never moves');
      assert.strictEqual(a.session.focus, true, 'FOCUS never moves');
    }
  });

  await test('PROFILE: persists with the session and survives a resume; a NEW session starts NORMAL', () => {
    const s = new Session({ cwd: tmpdir('prof-r-') });
    profile.set(s, 'ECO');
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(profile.of(back), 'ECO');
    assert.strictEqual(profile.of(new Session({ cwd: tmpdir('prof-n-') })), 'NORMAL');
    try { require('../../src/sessionstore').forget(s.id); } catch { /* best effort */ }
  });

  await test('PROFILE: orthogonal to AUTO/MANUAL/PLAN and FOCUS — PLAN still refuses mutation under FAST', async () => {
    const root = tmpdir('prof-p-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'PLAN'); profile.set(s, 'FAST'); s.focus = true;
    assert.strictEqual(execmode.label(s), 'Plan · FOCUS · FAST');
    const r = await require('../../src/tools').execute('write_file', { path: 'x.txt', content: 'x' }, { cwd: root, session: s, app: { session: s } });
    assert.ok(r.denied && /Plan mode: read-only/.test(r.output), 'FAST never widens authority');
    execmode.set(s, 'AUTO'); profile.set(s, 'ECO'); s.focus = false;
    assert.strictEqual(execmode.label(s), 'Auto · ECO');
    profile.set(s, 'NORMAL');
    assert.strictEqual(execmode.label(s), 'Auto', 'the default says nothing');
  });

  await test('PROFILE: the context budget — FAST never larger (speed is doing less, not carrying more), ECO smaller, same ceiling', () => {
    const budget = require('../../src/contextbudget');
    const pc = { ctx: 200000 };
    const n = budget.charsFor(pc, { executionProfile: 'NORMAL' });
    assert.ok(budget.charsFor(pc, { executionProfile: 'FAST' }) <= n, 'a bigger context is more to prefill on every request');
    assert.ok(budget.charsFor(pc, { executionProfile: 'ECO' }) < n);
    assert.ok(budget.charsFor({ ctx: 16000 }, { executionProfile: 'FAST' }) <= budget.charsFor({ ctx: 16000 }, { executionProfile: 'NORMAL' }) * 1.01 + 1, 'never above the provider ceiling');
  });

  await test('PROFILE: ECO refuses delegate/ab_compare unless the person asked; NORMAL and FAST allow', async () => {
    const tools = require('../../src/tools/delegate').tools;
    const s = new Session({ cwd: tmpdir('prof-d-') });
    s.task = new Task('fix the pricing bug');
    profile.set(s, 'ECO');
    const denied = await tools.delegate.run({ agents: [] }, { session: s, app: { session: s } });
    assert.ok(denied.denied && /ECO_PROFILE/.test(denied.output), denied.output);
    const ab = await tools.ab_compare.run({}, { session: s, app: { session: s } });
    assert.ok(ab.denied);
    s.task = new Task('fix the pricing bug using two subagents in parallel');
    assert.strictEqual(profile.allowsExtraAgents(s, 'delegate').ok, true, 'an explicit request overrides ECO');
    profile.set(s, 'NORMAL'); s.task = new Task('fix it');
    assert.strictEqual(profile.allowsExtraAgents(s, 'delegate').ok, true);
  });

  await test('PROFILE: FAST starts independent reads together; ECO stays serial; a read after a write is never started early', async () => {
    const toolstep = require('../../src/toolstep');
    const root = tmpdir('prof-par-');
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${f}.txt`), f);
    const s = new Session({ cwd: root });
    const calls = ['a', 'b', 'c'].map((f, i) => ({ id: `r${i}`, name: 'read_file', input: { path: `${f}.txt` } }));
    const opts = { session: s, evidence: null, toolCtx: { cwd: root, session: s } };
    const fast = toolstep.prefetch(calls, opts, profile.concurrency('FAST'));
    assert.strictEqual(fast.size, 3);
    const results = await Promise.all([...fast.values()]);
    assert.deepStrictEqual(results.map((r) => /\b[abc]\b/.exec(String(r.result.output))[0]), ['a', 'b', 'c']);
    assert.strictEqual(toolstep.prefetch(calls, opts, profile.concurrency('ECO')).size, 0, 'ECO: nothing starts early');
    const mixed = [calls[0], { id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'B' } }, calls[1]];
    const m = toolstep.prefetch(mixed, opts, 4);
    assert.ok(!m.has('r1'), 'the read after the write waits for it');
  });

  await test('PROFILE: FAST is parallel, not duplicated — two workers can never own the same files', async () => {
    const sub = require('../../src/subagents');
    const app = { session: new Session({ cwd: tmpdir('prof-dup-') }) };
    const contract = (o) => ({ role: 'IMPLEMENTER', objective: o, readScope: ['src/**'], writeScope: ['src/pricing.js'], expectedOutput: 'x', verification: 'npm test', completion: 'passes' });
    const r = await sub.run(app, [contract('one'), contract('two')], { mode: 'parallel', runner: async () => { throw new Error('must not run'); } });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /overlap|disjoint|same/i, r.why);
  });

  await test('PROFILE LEAK D/E/F: NORMAL→ECO→NORMAL, NORMAL→FAST→NORMAL and FOCUS on→off leave NOTHING behind', async () => {
    const s = new Session({ cwd: tmpdir('prof-leak-') });
    s.task = new Task('fix the pricing bug');
    const budget = require('../../src/contextbudget');
    const pc = { ctx: 400000 };
    const snapshot = () => ({
      profile: profile.of(s), focus: Boolean(s.focus), fast: Boolean(s.fast),
      budget: budget.charsFor(pc, { executionProfile: profile.of(s) }),
      concurrency: profile.concurrency(profile.of(s)),
      delegation: profile.allowsExtraAgents(s, 'delegate').ok,
      guidance: execmode.guidance(s), label: execmode.label(s),
    });
    const normal = snapshot();
    for (const via of ['ECO', 'FAST']) {
      profile.set(s, via);
      assert.notDeepStrictEqual(snapshot(), normal, `${via} really differs`);
      profile.set(s, 'NORMAL');
      assert.deepStrictEqual(snapshot(), normal, `NORMAL after ${via} is exactly NORMAL`);
    }
    // FOCUS is its own axis: toggling it never moves the profile, and back is back.
    s.focus = true;
    assert.strictEqual(profile.of(s), 'NORMAL');
    assert.strictEqual(snapshot().budget, normal.budget);
    s.focus = false;
    assert.deepStrictEqual(snapshot(), normal, 'FOCUS on→off leaves nothing');
    // FAST + FOCUS → NORMAL + FOCUS off
    profile.set(s, 'FAST'); s.focus = true;
    profile.set(s, 'NORMAL'); s.focus = false;
    assert.deepStrictEqual(snapshot(), normal);
    // Changing the profile never toggles FOCUS.
    s.focus = true; profile.set(s, 'ECO'); assert.strictEqual(s.focus, true); profile.set(s, 'NORMAL'); s.focus = false;
    // ECO → a model switch → NORMAL: the model is not part of the profile.
    profile.set(s, 'ECO');
    const turnCfg = require('../../src/sessionviews').turnCfg({ cfg: { model: 'b' }, session: s, connectionEvidence: {} }, s);
    assert.strictEqual(turnCfg.executionProfile, 'ECO', 'the profile rides every turn config, whatever the model');
    profile.set(s, 'NORMAL');
    assert.strictEqual(require('../../src/sessionviews').turnCfg({ cfg: { model: 'b' }, session: s, connectionEvidence: {} }, s).executionProfile, 'NORMAL');
  });

  await test('PROFILE G/H: FAST runs independent reads concurrently, NORMAL moderately, ECO strictly one at a time (measured)', async () => {
    const toolstep = require('../../src/toolstep');
    const tools = require('../../src/tools');
    const real = tools.execute;
    let inFlight = 0; let peak = 0;
    tools.execute = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 60)); inFlight -= 1; return { output: 'x' }; };
    try {
      const s = new Session({ cwd: tmpdir('prof-conc-') });
      const calls = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: 'grep', input: { pattern: `p${i}`, path: '.' } }));
      const measure = async (p) => {
        peak = 0;
        const t0 = Date.now();
        const pre = toolstep.prefetch(calls, { session: s, evidence: null, toolCtx: { cwd: s.cwd, session: s } }, profile.concurrency(p));
        for (const c of calls) await (pre.get(c.id) || toolstep.run(c, { session: s, evidence: null, toolCtx: { cwd: s.cwd, session: s } }));
        return { peak, ms: Date.now() - t0 };
      };
      const fast = await measure('FAST');
      const normal = await measure('NORMAL');
      const eco = await measure('ECO');
      assert.strictEqual(fast.peak, 4, JSON.stringify({ fast, normal, eco }));
      assert.strictEqual(normal.peak, 2);
      assert.strictEqual(eco.peak, 1, 'ECO is serial');
      assert.ok(fast.ms < eco.ms, `FAST finishes sooner than ECO: ${fast.ms} vs ${eco.ms}`);
    } finally { tools.execute = real; }
  });

  await test('PROFILE: guidance names the strategy and keeps the correctness bar', () => {
    const s = new Session({ cwd: tmpdir('prof-g-') });
    profile.set(s, 'ECO');
    assert.match(execmode.guidance(s), /ECO — token economy[\s\S]*BATCH[\s\S]*Same verification bar[\s\S]*final smoke/);
    profile.set(s, 'FAST');
    assert.match(execmode.guidance(s), /FAST — lowest latency[\s\S]*no preliminary surveys[\s\S]*targeted check[\s\S]*Never skip required reads, verification or permissions/);
  });
};
