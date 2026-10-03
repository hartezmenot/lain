'use strict';

/**
 * S12d — THE BENCH'S TERMINAL DRIVER answers a prompt that may or may not come: in Accept edits a command asks first
 * (Allow once · Allow for this turn · Deny), and the `watch` step answers "Allow for this turn" until the turn ends.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const tty = require('../tty/realtty');

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) { await test('S12d DRIVER: skipped — no pseudo-terminal driver', () => {}); return; }
  const cwd = tmpdir('s12drv-');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    permissions: { defaultMode: 'acceptEdits' },
    trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }],
  }, null, 2));
  const r = await tty.runTty({
    cwd, configDir, cols: 120, rows: 36,
    script: [
      { text: 'running two commands', tool_calls: [{ name: 'shell', input: { command: 'touch first-allowed.txt', shell: 'bash' } }] },
      { text: 'and the second', tool_calls: [{ name: 'shell', input: { command: 'touch second-allowed.txt', shell: 'bash' } }] },
      { text: 'Done: both ran' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 30000 },
      { send: 'run the two commands\r' },
      { watch: { until: 'Done: both ran', timeout: 60000, answer: [{ when: '(?i)allow this\\?', keys: ['down'], send: '\r' }] } },
      { snap: 'end', settle: 800 },
      { send: '/exit\r' }, { wait: 800 },
    ],
  });
  const text = r.byName.end ? r.byName.end.text.join('\n') : '';
  await test('S12d DRIVER: the Accept-edits prompt is answered "Allow for this turn" once, and the rest of the turn runs without asking', () => {
    assert.deepStrictEqual(r.timeouts, [], text);
    assert.deepStrictEqual(r.answered, [1], 'one prompt: "for this turn" covers the second command');
    assert.ok(!/did not allow/.test(text), text);
    assert.ok(fs.existsSync(path.join(cwd, 'first-allowed.txt')) && fs.existsSync(path.join(cwd, 'second-allowed.txt')), 'both commands ran');
  });
};
