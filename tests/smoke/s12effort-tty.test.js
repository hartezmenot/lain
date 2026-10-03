'use strict';

/**
 * S12a IN A REAL TERMINAL: a model with no native effort. Picking it in /model is followed by the effort step,
 * which offers Low / High / Max labelled LAIN effort; the choice is in the header; bare /effort opens the same
 * picker with the choice marked. (ptydrive.py: ConPTY on Windows, a real pty elsewhere.)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const tty = require('../tty/realtty');

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) {
    await test('S12a REAL TTY: skipped — no pseudo-terminal driver', () => {
      process.stdout.write(`    (skipped: ${probe.why}; set LAIN_TTY_PYTHON to a Python with pyte and ptyprocess/pywinpty)\n`);
    });
    return;
  }
  const cwd = tmpdir('s12tty-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    connections: { gateway: { provider: 'openai', via: 'bridge', baseUrl: 'http://127.0.0.1:9/v1', models: ['kimi-k3'] } },
    trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }],
  }, null, 2));
  const r = await tty.runTty({
    cwd, configDir, cols: 120, rows: 36,
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: '/model\r' },
      { until: 'Kimi', timeout: 20000 },
      { send: '\r' },
      { until: 'LAIN effort', timeout: 20000 },
      { snap: 'step', settle: 500 },
      { key: 'down' }, { key: 'down' }, { send: '\r' },
      { until: 'LAIN effort · Max', timeout: 20000 },
      { snap: 'header', settle: 500 },
      { send: '/effort\r' },
      { until: 'Effort · LAIN effort', timeout: 20000 },
      { snap: 'effort', settle: 500 },
      { key: 'escape' }, { wait: 300 },
      { send: '/exit\r' }, { wait: 800 },
    ],
  });
  const text = (n) => (r.byName[n] ? r.byName[n].text.join('\n') : '');

  await test('S12a REAL TTY: picking a model with no native effort is followed by the LAIN effort step — Low / High / Max and one dim line', () => {
    assert.deepStrictEqual(r.timeouts, [], `screens not reached: ${r.timeouts.join(' | ')}\n${text('step')}`);
    const s = text('step');
    assert.match(s, /Effort · LAIN effort/);
    assert.match(s, /No native effort on this model/);
    for (const l of ['Low', 'High', 'Max']) assert.match(s, new RegExp(`\\b${l}\\b`), l);
    assert.doesNotMatch(s, /\bMedium\b|\bXHigh\b/, 'only LAIN\'s three');
  });

  await test('S12a REAL TTY: the choice is in the header like a provider level, and bare /effort opens the same picker with it marked', () => {
    assert.match(text('header').split('\n').slice(0, 3).join('\n'), /LAIN effort · Max/);
    assert.match(text('effort'), /Max\s+\(current\)/);
  });
};
