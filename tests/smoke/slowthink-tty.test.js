'use strict';

/**
 * SLOW REASONING, IN A REAL TERMINAL (S5.1) — the shape GLM 5.3 on Z.ai streams: silence, then `reasoning_content`
 * for seconds, then the answer. A local fake OpenAI-compatible server (tests/fixtures/slowthink.js); no quota.
 *
 *   F3  before the first byte the live row says `Waiting for <model>`, with `esc to interrupt`
 *   F1  while it thinks, a box shows the reasoning's last lines; at the first text it folds to `▸ Thought for …`
 *   F2  Ctrl+C mid-think shows `Thinking (interrupted)` and never shows the reasoning as the answer
 *
 * Evidence tier: REAL_TTY_VERIFIED. SKIPS, and says so, without a pseudo-console driver.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');
const tty = require('../tty/realtty');

async function server(env) {
  const dir = tmpdir('slowthink-');
  const portFile = path.join(dir, 'port');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'fixtures', 'slowthink.js'), portFile], { env: { ...process.env, SLOWTHINK_IDLE_MS: '60000', ...env }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  return { port: Number(fs.readFileSync(portFile, 'utf8')), stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

function home(port) {
  const cwd = tmpdir('slowthink-proj-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x","scripts":{"test":"node -v"}}\n');
  const configDir = path.join(cwd, '.config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    model: 'glm-5.3', connection: 'fake',
    connections: { fake: { provider: 'fake', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', protocol: 'chat', models: ['glm-5.3'] } },
    trustedPaths: [{ path: cwd, level: 'TRUSTED' }],
  }));
  return { cwd, configDir };
}

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('SLOW THINK TTY: skipped — no pseudo-console driver', () => { process.stdout.write(`    (skipped: ${probe.why})\n`); });
    return;
  }

  const srv = await server({ SLOWTHINK_MS: '7000', SLOWTHINK_FIRST_BYTE_MS: '2500' });
  let run;
  try {
    const h = home(srv.port);
    run = await tty.runTty({
      cols: 110, rows: 32, script: null, cwd: h.cwd, configDir: h.configDir,
      steps: [
        { until: 'Ask LAIN', timeout: 30000 },
        { send: 'look at the project\r' },
        { wait: 900 },
        { snap: 'waiting', settle: 200 },
        { until: 'Thinking', timeout: 15000 },
        { wait: 2500 },
        { snap: 'thinking', settle: 200 },
        { until: 'SLOWTHINK_ANSWER', timeout: 30000 },
        { snap: 'answered', settle: 900 },
        { send: 'and again\r' },
        { until: 'Thinking', timeout: 15000 },
        { wait: 1500 },
        { key: 'ctrl-c' },
        { snap: 'interrupted', settle: 1500 },
      ],
    });
  } finally { srv.stop(); }

  await test('SLOW THINK TTY: the driver reached every screen it waited for', () => {
    assert.deepStrictEqual(run.timeouts, []);
  });

  await test('F3: before the first byte the live row says what it is waiting for', () => {
    const v = tty.visible(run.byName.waiting);
    assert.match(v, /Waiting for GLM 5\.3/, v);
    assert.match(v, /esc to interrupt/, v);
  });

  await test('F1: while it thinks, the box shows the reasoning; once it answers, one folded `Thought for` line', () => {
    const thinking = tty.visible(run.byName.thinking);
    assert.match(thinking, /Thinking/, thinking);
    assert.match(thinking, /package file|layout of the files|decide which file/, `the thinking box shows the reasoning:\n${thinking}`);
    const answered = tty.visible(run.byName.answered);
    assert.match(answered, /▸ Thought for \d+s/, answered);
    assert.match(answered, /SLOWTHINK_ANSWER/);
    assert.ok(!/layout of the files|decide which file/.test(answered), `folded away once answered:\n${answered}`);
  });

  await test('F2: Ctrl+C mid-think says `Thinking (interrupted)` and never shows the reasoning as the answer', () => {
    const v = tty.visible(run.byName.interrupted);
    assert.match(v, /Thinking \(interrupted\)/, v);
    const afterSecond = v.slice(v.lastIndexOf('and again'));
    assert.ok(!/layout of the files|decide which file|package file/.test(afterSecond), `reasoning printed as the answer:\n${afterSecond}`);
  });
};
