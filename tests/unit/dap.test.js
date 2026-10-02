'use strict';

/**
 * THE DEBUGGER — a real Debug Adapter Protocol session, end to end.
 *
 * tests/fixtures/dap/fakedap.js is a small adapter speaking real DAP over stdio,
 * attached the way a person attaches any adapter (`dap.adapters` in config).
 * Every state read below travels through LAIN's DAP client.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const FAKE = path.join(__dirname, '..', 'fixtures', 'dap', 'fakedap.js');

module.exports = async function () {
  const dap = require('../../src/dap/manager');
  dap._reset();
  const root = isolation.tmp('dap-proj-');
  fs.writeFileSync(path.join(root, 'prog.toy'), 'x = 1\ny = x + 2\nprint y\nnull y\nz = x + 10\nprint z\n');
  fs.writeFileSync(path.join(root, 'boom.toy'), 'a = 1\ncrash\n');
  const { Session } = require('../../src/session');
  const session = new Session({ id: 'dap-unit', cwd: root });
  require('../../src/sessionviews').views(session).project = { attached: true, attachedAt: new Date().toISOString() };
  const app = { session, cfg: { dap: { adapters: [{ id: 'toy', name: 'Toy adapter', command: process.execPath, args: [FAKE], extensions: ['.toy'] }] } } };
  try {
    await test('DAP: launch stops at a breakpoint; stack, scopes and variables come from the adapter', async () => {
      assert.ok((await dap.setBreakpoints(app, 'prog.toy', [3])).ok);
      const r = await dap.start(app, { program: 'prog.toy' });
      assert.ok(r.ok, r.why);
      const s = dap.status(app).session;
      assert.strictEqual(s.state, 'PAUSED', JSON.stringify(s));
      assert.strictEqual(s.stopped.reason, 'breakpoint');
      assert.strictEqual(s.stack[0].line, 3);
      assert.strictEqual(s.stack[0].path, 'prog.toy');
      const locals = s.scopes[0].variables;
      assert.deepStrictEqual(locals.map((v) => `${v.name}=${v.value}`), ['x=1', 'y=3']);
      assert.ok(s.breakpoints[0].list[0].verified, 'the adapter verified the breakpoint');
      // The registry records at once and confirms the identity (start time) a moment later.
      let owned = [];
      for (let i = 0; i < 100; i++) { owned = require('../../src/runtimeregistry').list().filter((p) => p.purpose === 'debug-adapter' && p.pid === s.pid); if (owned[0] && owned[0].alive) break; await new Promise((res) => setTimeout(res, 50)); }
      assert.ok(owned.length === 1 && owned[0].alive, 'the adapter is an owned process, recorded with its identity');
    });

    await test('DAP: watch expressions and the debug console evaluate in the paused frame', async () => {
      const w = await dap.setWatches(app, ['x + 5', 'nosuch']);
      assert.strictEqual(w.session.watches[0].value, '6');
      assert.strictEqual(w.session.watches[1].ok, false);
      const e = await dap.evaluate(app, 'y');
      assert.ok(e.ok && e.value === '3');
      assert.ok(e.session.output.some((o) => o.category === 'repl' && /> y/.test(o.text)));
    });

    await test('DAP: step over moves one line; the program output arrives as output events', async () => {
      let r = await dap.control(app, 'next');
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.session.stack[0].line, 4);
      assert.ok(r.session.output.some((o) => o.category === 'stdout' && o.text.trim() === '3'), 'print y ran');
      r = await dap.control(app, 'stepIn');
      assert.strictEqual(r.session.stack[0].line, 5);
      assert.ok(r.session.scopes[0].variables.some((v) => v.name === 'y' && v.value === 'null'));
    });

    await test('DAP: the paused state is available as compact context, on request', () => {
      const c = dap.context(app);
      assert.ok(c.paused);
      assert.ok(/Paused \(step\) in prog\.toy/.test(c.text), c.text);
      assert.ok(/Frame: <toy> at prog\.toy:5/.test(c.text));
      assert.ok(/y = null \(null\)/.test(c.text), 'the variable the question is about');
      assert.ok(/>\s+5\s+z = x \+ 10/.test(c.text), 'the source line it stopped on');
    });

    await test('DAP: a turn is told WHERE it is paused in one line; the state itself is asked for through a door', async () => {
      const pkt = require('../../src/harnesscontext').packet(app, session);
      assert.ok(/debugger: paused \(step\) in prog\.toy at prog\.toy:5/.test(pkt), pkt);
      assert.ok(!/y = null/.test(pkt), 'no variables are injected');
      const door = await require('../../src/house').run(app, 'debug.context', {});
      assert.ok(door.ok && door.kind === 'read' && /y = null/.test(door.text), JSON.stringify(door).slice(0, 200));
    });

    await test('DAP: continue runs to the end; the session ends and says why', async () => {
      const r = await dap.control(app, 'continue');
      assert.ok(r.ok, r.why);
      await new Promise((res) => setTimeout(res, 300));
      const s = dap.status(app).session;
      assert.strictEqual(s.state, 'ENDED', JSON.stringify(s.state));
      assert.ok(s.output.some((o) => o.text.trim() === '11'));
      assert.ok(/exited with code 0/.test(s.why));
      assert.strictEqual(dap.context(app).paused, false);
    });

    await test('DAP: a crashing adapter ends its session and LAIN carries on', async () => {
      await dap.setBreakpoints(app, 'prog.toy', []);
      const r = await dap.start(app, { program: 'boom.toy' });
      assert.ok(r.ok, r.why);
      for (let i = 0; i < 40 && dap.status(app).session.state !== 'ENDED'; i++) await new Promise((res) => setTimeout(res, 50));
      const s = dap.status(app).session;
      assert.strictEqual(s.state, 'ENDED');
      assert.ok(/adapter stopped \(exit 3\)/.test(s.why), s.why);
      const left = require('../../src/runtimeregistry').list().filter((p) => p.purpose === 'debug-adapter' && p.pid === s.pid && p.alive);
      assert.strictEqual(left.length, 0, 'nothing of it is left running');
    });

    await test('DAP: a file with no adapter says so; python is found or honestly not', async () => {
      fs.writeFileSync(path.join(root, 'x.rb'), 'puts 1\n');
      const r = await dap.start(app, { program: 'x.rb' });
      assert.ok(!r.ok && /no debug adapter/.test(r.why));
      const py = dap.status(app).adapters.find((a) => a.id === 'python');
      assert.ok(py && (py.available || /debugpy|not found/.test(py.why)), JSON.stringify(py));
      const node = dap.status(app).adapters.find((a) => a.id === 'node');
      assert.ok(node && !node.available && /TCP/.test(node.why), 'Node is not claimed');
    });
  } finally {
    await dap.stopAll();
    dap._reset();
  }
};
