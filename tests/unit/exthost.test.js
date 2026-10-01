'use strict';

/**
 * THE EXTENSION HOST — a real extension, in its own process, under its grant.
 *
 * The fixture (tests/fixtures/extensions/lain-sample) registers commands,
 * diagnostics, completion and hover, writes a file, reads outside the
 * workspace, calls an unsupported API, crashes and hangs. Every one of those
 * is observed from Core, and LAIN (this process) stays up throughout.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'extensions', 'lain-sample');

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
}

module.exports = async function () {
  const ext = require('../../src/extensions');
  const mgr = require('../../src/exthost/manager');
  const root = isolation.tmp('exthost-proj-');
  fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1; // TODO: remove\n');
  const { Session } = require('../../src/session');
  const session = new Session({ id: 'exthost-unit', cwd: root });
  require('../../src/sessionviews').views(session).project = { attached: true, attachedAt: new Date().toISOString() };
  const app = { session };
  const status = () => mgr.status(app).find((x) => x.id === 'lain-test.lain-sample');

  await test('EXTENSION HOST · SURFACE: every API Noema claims to provide exists in the host', () => {
    const { SURFACE } = require('../../src/exthost/surface');
    const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'exthost', 'host.js'), 'utf8');
    const absent = [];
    for (const [ns, members] of Object.entries(SURFACE)) for (const m of members) if (!new RegExp(`\\b${m}\\b`).test(host)) absent.push(`${ns}.${m}`);
    assert.deepStrictEqual(absent, [], 'the compatibility report would claim an API the host does not have');
  });

  await test('EXTENSION HOST · SURFACE: a static scan names the unsupported APIs before the extension runs', () => {
    const s = require('../../src/exthost/surface');
    const scan = s.scanExtension(FIXTURE, JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')));
    assert.ok(scan.ok && scan.missing.includes('window.createWebviewPanel'), JSON.stringify(scan));
    assert.ok(scan.used.includes('commands.registerCommand') && !scan.missing.includes('commands.registerCommand'));
    const c = mgr.compatibility(JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')), null, scan);
    assert.strictEqual(c.level, 'PARTIAL');
    assert.ok(c.missingApis.includes('window.createWebviewPanel'));
    assert.strictEqual(mgr.compatibility({ contributes: { views: { explorer: [{}] } } }).level, 'UNSUPPORTED', 'nothing that works is UNSUPPORTED, not NONE');
    // PHASE 8: a colour theme is read as data and applied to the editor (exttheme.js).
    assert.strictEqual(mgr.compatibility({ contributes: { themes: [{}] } }).level, 'FULL', 'a colour theme works: editor colours, no code run');
  });

  try {
    await test('EXTENSION HOST: an installed extension does not run until allowed, with its permissions', async () => {
      const r = await ext.install({ folder: FIXTURE }, { scope: 'global' });
      assert.ok(r.ok, r.why);
      const e = ext.list().find((x) => x.id === 'lain-test.lain-sample');
      const s = await mgr.start(app, e);
      assert.ok(!s.ok && s.needsGrant, JSON.stringify(s));
      const c = status().compatibility;
      assert.ok(c.rows.some((x) => x.ok && /command/.test(x.what)), JSON.stringify(c));
    });

    await test('EXTENSION HOST: separate process; activation; commands, messages, diagnostics, completion, hover', async () => {
      assert.ok(mgr.allow(app, 'lain-test.lain-sample', 'global', { run: true, grant: { read: true, write: true } }).ok);
      const e = ext.list().find((x) => x.id === 'lain-test.lain-sample');
      const s = await mgr.start(app, e);
      assert.ok(s.ok, s.why);
      const st = status();
      assert.strictEqual(st.state, 'RUNNING');
      assert.ok(st.pid && st.pid !== process.pid, 'a separate process');
      const reg = require('../../src/runtimeregistry').list().find((x) => x.pid === st.pid);
      assert.ok(reg && reg.purpose === 'extension-host', 'recorded as an owned extension host');
      assert.ok(await until(() => status().commands.includes('sample.hello')), 'the command registered on activation');
      const hello = await mgr.executeCommand(app, 'sample.hello', ['Noema']);
      assert.ok(hello.ok && hello.result === 'hello', JSON.stringify(hello));
      assert.ok(status().messages.some((m) => /Hello from the sample extension, Noema/.test(m.text)));
      await mgr.document(app, { event: 'open', path: path.join(root, 'a.js'), text: fs.readFileSync(path.join(root, 'a.js'), 'utf8'), languageId: 'javascript', version: 1 });
      const d = await until(() => mgr.diagnostics().find((x) => /TODO left/.test(x.message)));
      assert.ok(d && d.line === 0 && d.severity === 1, JSON.stringify(d));
      const comp = await mgr.provide(app, 'completion', { path: path.join(root, 'a.js'), line: 0, col: 3 });
      assert.ok(comp.some((c) => (c.items || []).some((i) => i.label === 'sampleCompletion')), JSON.stringify(comp));
      const hov = await mgr.provide(app, 'hover', { path: path.join(root, 'a.js'), line: 0, col: 7 });
      assert.ok(hov.some((h) => (h.contents || []).some((t) => /sample hover/.test(t))), JSON.stringify(hov));
    });

    await test('EXTENSION HOST: a granted write lands in the workspace and is recorded as EXTENSION', async () => {
      const r = await mgr.executeCommand(app, 'sample.countTodos');
      assert.ok(r.ok, r.why);
      assert.strictEqual(fs.readFileSync(path.join(root, 'todo-count.txt'), 'utf8'), '1');
      const last = require('../../src/editledger').entries(root, { rel: 'todo-count.txt' }).pop();
      assert.ok(last && last.source === 'EXTENSION' && /lain-sample/.test(last.actor), JSON.stringify(last));
    });

    await test('EXTENSION HOST: the Node runtime enforces the grant — outside-workspace reads are denied', async () => {
      const r = await mgr.executeCommand(app, 'sample.readOutside');
      assert.ok(r.ok && r.result === 'ERR_ACCESS_DENIED', JSON.stringify(r));
    });

    await test('EXTENSION HOST: without "write" the same command is refused by the bridge', async () => {
      mgr.allow(app, 'lain-test.lain-sample', 'global', { run: true, grant: { read: true, write: false } });
      await until(() => status().state !== 'RUNNING', 5000);
      const r = await mgr.executeCommand(app, 'sample.countTodos');
      assert.ok(!r.ok && /DENIED/.test(r.why), JSON.stringify(r));
    });

    await test('EXTENSION HOST: an unsupported API fails loudly and appears in the compatibility report', async () => {
      const r = await mgr.executeCommand(app, 'sample.unsupported');
      assert.ok(!r.ok && /LAIN_UNSUPPORTED vscode\.window\.createWebviewPanel/.test(r.why), JSON.stringify(r));
      const c = status().compatibility;
      assert.strictEqual(c.level, 'PARTIAL');
      assert.ok(c.rows.some((x) => !x.ok && /createWebviewPanel/.test(x.what)));
    });

    await test('EXTENSION HOST: the BOT may not run a command from an extension that can write', async () => {
      mgr.allow(app, 'lain-test.lain-sample', 'global', { run: true, grant: { read: true, write: true } });
      await until(() => status().state !== 'RUNNING', 5000);
      const r = await mgr.executeCommand(app, 'sample.hello', [], { origin: 'bot' });
      assert.ok(!r.ok && /BOT does not edit/.test(r.why), JSON.stringify(r));
    });

    await test('EXTENSION HOST: a crash is contained and restarted; Noema keeps running', async () => {
      const before = status().pid || (await mgr.executeCommand(app, 'sample.hello'), status().pid);
      await mgr.executeCommand(app, 'sample.crash');
      assert.ok(await until(() => status().state === 'CRASHED' || (status().state === 'RUNNING' && status().pid !== before)), 'the crash was noticed');
      assert.ok(await until(() => status().state === 'RUNNING' && status().pid && status().pid !== before), 'and the host came back');
      assert.ok(/stopped unexpectedly/.test(status().logs.map((l) => l.text).join('\n')));
      const again = await mgr.executeCommand(app, 'sample.hello');
      assert.ok(again.ok, 'the extension works after the restart');
    });

    await test('EXTENSION HOST: a hung extension is stopped and restarted; the caller is answered', async () => {
      const t0 = Date.now();
      const r = await mgr.executeCommand(app, 'sample.hang', [], { timeoutMs: 1500 });
      assert.ok(!r.ok && r.code === 'LAIN_EXT_HUNG', JSON.stringify(r));
      assert.ok(Date.now() - t0 < 5000, 'the caller was not left waiting');
      assert.ok(await until(() => status().state === 'RUNNING', 15000), 'restarted after the hang');
    });

    await test('EXTENSION HOST: disable and uninstall stop the host', async () => {
      ext.setEnabled('lain-test.lain-sample', false, { scope: 'global' });
      mgr.stop(app, 'lain-test.lain-sample', 'global');
      assert.ok(await until(() => status().state === 'STOPPED'));
      const pid = status().pid;
      assert.ok(!pid);
      assert.ok(ext.uninstall('lain-test.lain-sample', { scope: 'global' }).ok);
      assert.ok(!mgr.status(app).some((x) => x.id === 'lain-test.lain-sample'));
    });
  } finally {
    mgr._reset();
  }
};
