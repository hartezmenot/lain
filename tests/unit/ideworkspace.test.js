'use strict';

/**
 * THE IDE'S CORE HALF — files, search, git, the terminal's screen, the BOT's
 * view of the IDE, and routing — each against a real temporary project.
 *
 * Every defect named here was on the screen once:
 *   - files LAIN would not open because an extension was not on a list;
 *   - a CRLF / UTF-16 file saved back as something else;
 *   - delete that reached the person's real Recycle Bin from a test;
 *   - the window polling Core ~70 times a second because a read woke it;
 *   - the BOT's "terminal output" being every PSReadLine repaint at once.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { test } = require('../helpers');

const routes = require('../../src/harnessapp/routes');
const source = require('../../src/harnessapp/source');
const vtscreen = require('../../src/vtscreen');
const botroute = require('../../src/harnessapp/botroute');
const idecontext = require('../../src/idecontext');
const isolation = require('../harness/isolation');

module.exports = async function () {
  const proj = isolation.tmp('ide-unit-');
  const app = { session: { id: 'ide-unit', cwd: proj, turns: [], messages: [] }, ui: null, checkpoints: null, events: null };
  const req = async (p, body) => (await routes.dispatch(app, 'POST', p, body)).body;

  await test('IDE FILES: any text file opens — the content decides, not the extension', async () => {
    fs.writeFileSync(path.join(proj, 'Dockerfile'), 'FROM node:22\n');
    fs.writeFileSync(path.join(proj, 'notes.weird-ext'), 'plain words\n');
    fs.writeFileSync(path.join(proj, '.env.local'), 'A=1\n');
    for (const f of ['Dockerfile', 'notes.weird-ext', '.env.local']) {
      const r = await req('/api/files/open', { path: f });
      assert.ok(r.ok, `${f}: ${r.why}`);
      assert.strictEqual(r.kind, 'text', f);
    }
    assert.strictEqual((await req('/api/files/open', { path: 'Dockerfile' })).mode, 'dockerfile');
  });

  await test('IDE FILES: binary is refused with a reason; an image is an image', async () => {
    fs.writeFileSync(path.join(proj, 'blob.dat'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]));
    const bin = await req('/api/files/open', { path: 'blob.dat' });
    assert.ok(!bin.ok && /binary/i.test(bin.why), JSON.stringify(bin));
    fs.writeFileSync(path.join(proj, 'dot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const img = await req('/api/files/open', { path: 'dot.png' });
    assert.ok(img.ok && img.kind === 'image' && img.mime === 'image/png', JSON.stringify(img));
  });

  await test('IDE FILES: encoding and line endings survive a save', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\r\nwörld\r\n', 'utf16le')]);
    fs.writeFileSync(path.join(proj, 'w.txt'), utf16);
    const c = source.classify(fs.readFileSync(path.join(proj, 'w.txt')));
    assert.strictEqual(c.encoding, 'utf16le');
    assert.strictEqual(c.eol, 'CRLF');
    const o = await req('/api/files/open', { path: 'w.txt' });
    assert.ok(o.ok, o.why);
    const s = await req('/api/files/save', { path: 'w.txt', body: o.body.replace('héllo', 'hallo'), hash: o.hash, encoding: o.encoding });
    assert.ok(s.ok, s.why);
    const back = fs.readFileSync(path.join(proj, 'w.txt'));
    assert.deepStrictEqual([...back.slice(0, 2)], [0xff, 0xfe], 'the BOM is kept');
    assert.ok(back.slice(2).toString('utf16le').includes('hallo\r\nwörld\r\n'), 'UTF-16 and CRLF are kept');
    assert.strictEqual(source.classify(Buffer.from('caf\xe9', 'latin1')).encoding, 'latin1', 'not UTF-8 is not forced into it');
  });

  await test('IDE FILES: create, rename, move and delete — delete goes to the run-owned trash', async () => {
    assert.ok((await req('/api/files/mkdir', { path: 'pkg' })).ok);
    assert.ok((await req('/api/files/create', { path: 'pkg/a.js', body: 'x\n' })).ok);
    assert.ok(!(await req('/api/files/create', { path: 'pkg/a.js' })).ok, 'create never overwrites');
    assert.ok(!(await req('/api/files/create', { path: '../escape.js' })).ok, 'nothing outside the project');
    assert.ok((await req('/api/files/rename', { from: 'pkg/a.js', to: 'pkg/b.js' })).ok);
    assert.ok(!(await req('/api/files/rename', { from: 'pkg', to: 'pkg/inner/pkg' })).ok, 'a folder cannot move into itself');
    const trash = process.env.LAIN_TRASH_DIR;
    assert.ok(trash && isolation.isolated() && !path.resolve(trash).startsWith(path.resolve(isolation.REAL_HOME)), 'the trash is the run-owned one, never the real profile or Recycle Bin');
    const d = await req('/api/files/delete', { path: 'pkg/b.js' });
    assert.ok(d.ok, d.why);
    assert.ok(!fs.existsSync(path.join(proj, 'pkg', 'b.js')));
    assert.ok(fs.readdirSync(trash).length > 0, 'the deleted file is recoverable from the run trash');
  });

  await test('IDE SEARCH: find and replace across files, and a changed file is skipped', async () => {
    fs.writeFileSync(path.join(proj, 's1.js'), 'const alpha = 1;\nalpha += 1;\n');
    fs.writeFileSync(path.join(proj, 's2.js'), 'alphabet\n');
    const plain = await req('/api/files/search', { query: 'alpha' });
    assert.ok(plain.ok && plain.total >= 3, JSON.stringify(plain).slice(0, 300));
    const whole = await req('/api/files/search', { query: 'alpha', wholeWord: true, include: '*.js' });
    assert.strictEqual(whole.files.length, 1, 'whole word leaves alphabet out');
    const stale = whole.files.map((f) => ({ path: f.path, hash: 'not-the-hash' }));
    assert.strictEqual((await req('/api/files/replace', { query: 'alpha', replacement: 'beta', wholeWord: true, files: stale })).replaced.length, 0);
    const done = await req('/api/files/replace', { query: 'alpha', replacement: 'beta', wholeWord: true, files: whole.files.map((f) => ({ path: f.path, hash: f.hash })) });
    assert.strictEqual(done.total, 2);
    assert.strictEqual(fs.readFileSync(path.join(proj, 's1.js'), 'utf8'), 'const beta = 1;\nbeta += 1;\n');
  });

  const hasGit = cp.spawnSync('git', ['--version']).status === 0;
  await test('IDE GIT: status, stage, diff, commit and the HEAD version', async () => {
    if (!hasGit) return;
    const repo = isolation.tmp('ide-git-');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    cp.spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
    const g = { session: { id: 'g', cwd: repo, turns: [], messages: [] } };
    const call = async (p, body) => (await routes.dispatch(g, 'POST', p, body)).body;
    let st = await call('/api/git/status', {});
    assert.ok(st.ok && st.repo !== false, JSON.stringify(st));
    assert.strictEqual(st.branch, 'main', 'a repository without commits still has its branch');
    assert.ok((await call('/api/git/stage', { paths: ['f.txt'] })).ok);
    const c = await call('/api/git/commit', { message: 'first' });
    assert.ok(c.ok, c.why);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'two\n');
    st = await call('/api/git/status', {});
    assert.ok(JSON.stringify(st).includes('f.txt'), 'the change is listed');
    const head = await call('/api/git/show', { path: 'f.txt' });
    assert.strictEqual(head.text, 'one\n');
    const dif = await call('/api/git/diff', { path: 'f.txt' });
    assert.ok(/-one[\s\S]*\+two/.test(dif.diff || dif.body || ''), JSON.stringify(dif).slice(0, 200));
  });

  await test('IDE WAKE: a read sent as POST does not wake the window; a write does', async () => {
    const ipc = require('../../src/harnessapp/ipc');
    const orig = ipc.wake;
    let wakes = 0;
    ipc.wake = () => { wakes += 1; };
    try {
      await req('/api/files/freshness', { open: [] });
      await req('/api/files/open', { path: 's1.js' });
      await req('/api/git/status', {});
      await req('/api/terminal/read', { id: 'none', since: 0 });
      assert.strictEqual(wakes, 0, 'poll → render → freshness → wake → poll was a loop at pipe speed');
      await req('/api/files/create', { path: 'woke.txt' });
      assert.strictEqual(wakes, 1, 'a change still shows at once');
    } finally { ipc.wake = orig; }
  });

  await test('IDE TERMINAL: the BOT reads the screen, not every repaint', () => {
    const E = '\u001b';
    const painted = `PS D:\\p> ${E}[?25l${E}[93mecho ${E}[37mabcX${E}[?25h${E}[1;10H${E}[93mecho ${E}[37mabc ${E}[K\r\nabc\r\nPS D:\\p> `;
    assert.strictEqual(vtscreen.render(painted, { cols: 80, rows: 10 }), 'PS D:\\p> echo abc\nabc\nPS D:\\p>');
    assert.strictEqual(vtscreen.render('npm install\r\nfetching 10%\rfetching 100%\r\n', { cols: 80, rows: 10 }), 'npm install\nfetching 100%\n');
    assert.strictEqual(vtscreen.render(`${E}]0;title${E}\\abc\bd\r\n`, { cols: 80, rows: 10 }), 'abd\n');
  });
  await test('IDE ROUTING: questions to the BOT; changes are proposed for the Agent (the AGENT tab and Chat go straight); a choice wins', () => {
    const a = { session: { messages: [] } };
    assert.strictEqual(botroute.decide(a, 'why does main return 3?').role, 'bot');
    assert.strictEqual(botroute.decide(a, 'explain the build script').role, 'bot');
    assert.strictEqual(botroute.decide(a, 'rename add to sum in util.ts and update the callers').role, 'propose');
    assert.strictEqual(botroute.decide(a, 'rename add to sum in util.ts and update the callers', { pane: 'agent' }).role, 'agent');
    assert.strictEqual(botroute.decide(a, 'rename add to sum in util.ts and update the callers', { via: 'chat' }).role, 'agent');
    assert.strictEqual(botroute.decide(a, 'why does main return 3?', { route: 'agent' }).role, 'agent');
  });
};
