'use strict';

/** S11: in Auto, the first computer call turns Computer Control on — a look (windows, screenshot) as much as a click. */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  await test('AUTO: a read-only computer call turns Computer Control on first; in Ask it does not', async () => {
    const cc = require('../../src/computercontrol');
    const execmode = require('../../src/execmode');
    const was = { enabled: cc.enabled, enable: cc.enable };
    let asked = 0;
    cc.enabled = () => false;
    cc.enable = async () => { asked += 1; return { ok: false, why: 'the computer was not authorized' }; };
    try {
      const session = { cwd: process.cwd(), execMode: 'AUTO', _defaultMode: { cwd: process.cwd(), mode: 'AUTO' } };
      const app = { cfg: {}, session };
      const auto = await execmode.gate({ app, session }, 'computer', { mutates: false }, { action: 'windows' });
      assert.strictEqual(asked, 1, 'the desktop authorization was asked for');
      assert.match(auto.output || '', /Computer Control is off: the computer was not authorized/);
      session.execMode = 'ASK';
      const ask = await execmode.gate({ app, session }, 'computer', { mutates: false }, { action: 'windows' });
      assert.strictEqual(asked, 1, 'Ask never turns it on by itself');
      assert.strictEqual(ask.ok, true, 'a read passes the mode gate');
    } finally { cc.enabled = was.enabled; cc.enable = was.enable; }
  });
};
