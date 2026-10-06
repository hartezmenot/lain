'use strict';

/** LEASES OF GONE PROCESSES ARE FORGOTTEN (2026-10-06): pruneDead removes a lease whose pids are all gone, keeps live ones. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  await test('LEASES: a lease whose holder and children are all gone is removed; one with a live process stays', async () => {
    const dir = tmpdir('lain-leases-');
    const prev = process.env.LAIN_RUNTIME_DIR;
    process.env.LAIN_RUNTIME_DIR = dir;
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const write = (name, holder, kids) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ owner: name, lease: { pid: holder, start: 's0' }, processes: kids.map((pid, i) => ({ id: `p${i}`, pid, start: 's0' })) }));
      write('lain_dead', 4194300, [4194301]);            // pids far beyond any live process
      write('lain_childlive', 4194302, [live.pid]);
      write('lain_holderlive', live.pid, []);
      const r = require('../../src/runtimeregistry').pruneDead();
      assert.strictEqual(r.removed, 1);
      assert.ok(!fs.existsSync(path.join(dir, 'lain_dead.json')));
      assert.ok(fs.existsSync(path.join(dir, 'lain_childlive.json')) && fs.existsSync(path.join(dir, 'lain_holderlive.json')));
    } finally {
      live.kill();
      if (prev === undefined) delete process.env.LAIN_RUNTIME_DIR; else process.env.LAIN_RUNTIME_DIR = prev;
    }
  });
};
