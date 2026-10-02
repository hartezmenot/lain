'use strict';

/**
 * PHASE 8.3 — THE UNIFIED INTELLIGENCE FABRIC (part 2). Fixtures only.
 *
 *   MIGRATION   a fake router export: Claude, Codex, Antigravity (OAuth) and an API key.
 *               The key moves (verified against the PROVIDER, not the router); each OAuth
 *               account waits for LAIN's own sign-in; Antigravity says it has none yet.
 *               A duplicate is asked about. After the router is gone the API still works,
 *               and nothing in the normal UI names the router.
 *   SKILLS      a remote catalog (HTTP) over a git repository: search "Godot" from the
 *               index at once → inspect → install → validate → enable → offered to the Agent;
 *               a new version appears; a local change is never overwritten silently;
 *               a Hermes / Agent Skills folder is imported without starting Hermes.
 *   TRAY        only reported windows; a reset updates it without a restart; no idle work
 *   PERFORMANCE 1,000+ models across many accounts: the index is built once, pickers and
 *               search read it, nothing is re-fetched or re-normalised warm
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { test, tmpdir } = require('../helpers');

function server(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

/** A fake OpenAI-compatible PROVIDER (not a router): lists one model, answers "ok". */
function fakeProvider() {
  const seen = [];
  return server((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || '' });
      if (/\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  }).then((s) => ({ ...s, seen }));
}

function git(args, cwd) { const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; }
function skillMd({ name, description, version, extra = '' }) { return `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nlicense: MIT\nauthor: Fixture Author\ntags: [godot, gamedev]\n${extra}---\n# ${name}\n\nSteps for ${name}.\n`; }

const fx = require('../harness/fabricfixtures');

module.exports = async function () {
  const { App } = require('../../src/app');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const store = require('../../src/fabric/store');
  const F = require('../../src/fabric/index');
  const out = { write() {}, on() {}, columns: 110, rows: 30, isTTY: false };
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const mk = (p) => new App({ out, interactive: false, cwd: tmpdir(p) });
  const savedProvider = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;
  const servers = [];
  const resetStore = () => { try { fs.unlinkSync(store.file()); } catch { /* fresh */ } store.reset(); };

  try {
    await test('MIGRATION: the key moves; OAuth waits for LAIN\'s own sign-in; a duplicate is asked about; the router can go', async () => {
      resetStore();
      const prov = await fakeProvider(); servers.push(prov);
      const app = mk('p83m-');
      const exp = path.join(tmpdir('p83x-'), 'router-export.json');
      const KEY = 'sk-deepseek-fixture-0123456789';
      fs.writeFileSync(exp, JSON.stringify({ source: 'OldRouter', accounts: [
        { family: 'claude', kind: 'oauth', identity: 'me@example.com', label: 'Personal', oauth: { access_token: 'NEVER-READ-THIS' } },
        { family: 'codex', kind: 'oauth', identity: 'me@example.com', label: 'Work' },
        { family: 'antigravity', kind: 'oauth', identity: 'g@example.com' },
        { family: 'deepseek', kind: 'api', provider: 'deepseek', baseUrl: `${prov.url}/v1`, key: KEY },
      ] }));
      const d = await call(app, '/api/migrate/discover', { exportFile: exp });
      assert.strictEqual(d.code, 200, JSON.stringify(d.body));
      assert.ok(!JSON.stringify(d.body).includes(KEY), 'the discovered key never leaves Core');
      assert.deepStrictEqual(d.body.plan.map((p) => [p.family, p.action]), [['claude', 'reauth'], ['codex', 'reauth'], ['antigravity', 'reauth'], ['deepseek', 'transfer']]);
      assert.strictEqual(d.body.plan[2].reauth.supported, true, 'Antigravity has its own sign-in now (Connect account)');
      const a = await call(app, '/api/migrate/apply', { token: d.body.token });
      const res = Object.fromEntries(a.body.results.map((r) => [r.key.split(':').pop(), r.result]));
      assert.deepStrictEqual(res, { claude: 'reauth-required', codex: 'reauth-required', antigravity: 'reauth-required', deepseek: 'transferred' });
      assert.ok(prov.seen.some((s) => /\/models$/.test(s.url) && s.auth.includes(KEY)), 'verified against the PROVIDER with the moved key');
      assert.ok(!fs.readFileSync(require('../../src/config').configFile(), 'utf8').includes('NEVER-READ-THIS'), 'an OAuth token in an export is never taken');
      const fams = (await call(app, '/api/intel/families')).body.families;
      const byId = Object.fromEntries(fams.map((f) => [f.id, f]));
      assert.strictEqual(byId.codex.placeholders[0].state, 'REAUTH_REQUIRED');
      assert.strictEqual(byId.antigravity.placeholders[0].state, 'REAUTH_REQUIRED', 'Antigravity has its own sign-in now');
      assert.ok(byId['api:lain:deepseek'], 'the API is an ordinary LAIN API source');
      assert.ok(!JSON.stringify(fams).includes('OldRouter'), 'the normal UI does not name the router');
      // A SECOND SOURCE with the same identity: asked, never merged on a guess.
      const exp2 = path.join(tmpdir('p83x2-'), 'other.json');
      fs.writeFileSync(exp2, JSON.stringify({ source: 'OtherRouter', accounts: [{ family: 'codex', kind: 'oauth', identity: 'me@example.com' }] }));
      const d2 = await call(app, '/api/migrate/discover', { exportFile: exp2 });
      const dup = d2.body.plan.find((p) => p.family === 'codex' && p.action === 'duplicate');
      assert.ok(dup, JSON.stringify(d2.body.plan));
      assert.match(dup.text, /appears to already exist/);
      const undecided = await call(app, '/api/migrate/apply', { token: d2.body.token, keys: [dup.key] });
      assert.strictEqual(undecided.body.results[0].result, 'needs-decision');
      const kept = await call(app, '/api/migrate/apply', { token: d2.body.token, keys: [dup.key], decisions: { [dup.key]: 'keep' } });
      assert.strictEqual(kept.body.results[0].result, 'kept-existing');
      assert.strictEqual(F.family(app, 'codex').placeholders.length, 1, 'still one Codex placeholder');
      // THE ROUTER IS GONE: the moved API still answers, through the provider.
      fs.unlinkSync(exp); fs.unlinkSync(exp2);
      const r = await require('../../src/sessionintel').choose(app, app.session, { lane: 'coding', family: 'api:lain:deepseek', model: 'deepseek-chat' });
      assert.ok(r.ok, r.why);
      const before = prov.seen.length;
      await app.submit('Say ok.');
      assert.ok(prov.seen.length > before, 'the migrated API works with the router deleted');
      // THE SIGN-IN FINISHES THE MIGRATION: an account of the family with the same identity replaces the placeholder.
      const A = require('../../src/accountcatalog');
      const realList = A.list;
      A.list = () => ({ accounts: [{ id: 'inst-1', kind: 'runtime', family: 'codex', name: 'Codex', identity: { email: 'Me@Example.com' }, routes: [] }], byId: new Map() });
      try { assert.strictEqual(require('../../src/fabric/migrate').reconcile(app).length, 1); } finally { A.list = realList; }
      assert.strictEqual(F.family(app, 'codex'), null, 'no placeholder left for Codex');
    });

    await test('SKILLS: a remote catalog → search "Godot" at once → inspect → install → validate → enable → offered to the Agent; updates never overwrite a local change', async () => {
      const hub = require('../../src/skillshub');
      const repo = tmpdir('p83repo-');
      git(['init', '-q'], repo);
      fs.mkdirSync(path.join(repo, 'skills', 'godot-scenes'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'skills', 'godot-scenes', 'SKILL.md'), skillMd({ name: 'godot-scenes', description: 'How to build Godot scenes', version: '1.0.0' }));
      fs.mkdirSync(path.join(repo, 'skills', 'unity-prefabs', 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'skills', 'unity-prefabs', 'SKILL.md'), skillMd({ name: 'unity-prefabs', description: 'Unity prefab conventions', version: '0.3.0' }).replace('godot, gamedev', 'unity'));
      fs.writeFileSync(path.join(repo, 'skills', 'unity-prefabs', 'scripts', 'build.py'), 'print("build")\n');
      git(['add', '.'], repo); git(['commit', '-qm', 'v1'], repo);
      const cat = await server((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ skills: [
        { name: 'godot-scenes', description: 'How to build Godot scenes', tags: ['godot'], source: { type: 'git', url: repo, subdir: 'skills/godot-scenes' } },
        { name: 'unity-prefabs', description: 'Unity prefab conventions', tags: ['unity'], source: { type: 'git', url: repo, subdir: 'skills/unity-prefabs' } },
      ] })); });
      servers.push(cat);
      const app = mk('p83s-');
      const add = await call(app, '/api/skills/source/add', { type: 'index', url: `${cat.url}/skills.json`, label: 'Fixture catalog' });
      assert.strictEqual(add.code, 200, JSON.stringify(add.body));
      const ref = await call(app, '/api/skills/source/refresh', { id: add.body.id, wait: true });
      assert.ok(ref.body.results[0].ok, JSON.stringify(ref.body));
      const s = await call(app, '/api/skills/search', { query: 'Godot' });
      assert.deepStrictEqual(s.body.skills.map((x) => x.name), ['godot-scenes']);
      assert.ok(s.body.ms < 50, `from the index, not the network: ${s.body.ms} ms`);
      const key = s.body.skills[0].key;
      const ins = await call(app, '/api/skills/inspect', { key });
      assert.deepStrictEqual([ins.body.skill.author, ins.body.skill.version, ins.body.skill.license, ins.body.skill.executable], ['Fixture Author', '1.0.0', 'MIT', false]);
      assert.ok(ins.body.skill.files.includes('SKILL.md'));
      const installed = await call(app, '/api/skills/install', { key });
      assert.deepStrictEqual([installed.body.ok, installed.body.enabled], [true, true], 'an instruction-only skill may be enabled at install');
      const integ = require('../../src/integrations');
      assert.match(integ.skillsPrompt(app), /godot-scenes: How to build Godot scenes/, 'offered to the Agent for a relevant task');
      // A SKILL WITH A SCRIPT: installed disabled; enabled only with a confirm.
      const uni = (await call(app, '/api/skills/search', { query: 'unity' })).body.skills[0];
      const ui = await call(app, '/api/skills/install', { key: uni.key });
      assert.deepStrictEqual([ui.body.enabled, ui.body.needsConfirm], [false, true]);
      assert.deepStrictEqual((await call(app, '/api/integrations/skill/enable', { id: ui.body.id, enabled: true })).body.needsConfirm, true);
      // A NEW VERSION in the catalog's repository.
      fs.writeFileSync(path.join(repo, 'skills', 'godot-scenes', 'SKILL.md'), skillMd({ name: 'godot-scenes', description: 'How to build Godot scenes', version: '1.1.0' }) + '\nNew section.\n');
      git(['commit', '-qam', 'v1.1'], repo);
      await call(app, '/api/skills/source/refresh', { id: add.body.id, wait: true });
      assert.strictEqual((await call(app, '/api/skills/search', { query: 'Godot' })).body.skills[0].updateAvailable, true, 'the new version appears');
      // A LOCAL CHANGE: never overwritten silently.
      const mine = path.join(integ.store(app).skills[installed.body.id].path, 'SKILL.md');
      fs.appendFileSync(mine, '\nMy team\'s own rule.\n');
      const chk = await call(app, '/api/skills/update', { id: installed.body.id, action: 'check' });
      assert.deepStrictEqual([chk.body.updateAvailable, chk.body.local.modified, chk.body.choices], [true, true, ['diff', 'overwrite', 'keep', 'duplicate']]);
      assert.match(fs.readFileSync(mine, 'utf8'), /My team's own rule/, 'checking changed nothing');
      const diff = await call(app, '/api/skills/update', { id: installed.body.id, action: 'diff' });
      assert.ok(diff.body.diff[0].lines.some((l) => /^- My team's own rule/.test(l)) && diff.body.diff[0].lines.some((l) => /^\+ New section/.test(l)));
      const dup = await call(app, '/api/skills/update', { id: installed.body.id, action: 'duplicate' });
      assert.ok(dup.body.ok && dup.body.id !== installed.body.id, 'the new version installs beside it');
      assert.match(fs.readFileSync(mine, 'utf8'), /My team's own rule/, 'and the local copy is untouched');
      await call(app, '/api/skills/update', { id: installed.body.id, action: 'keep' });
      assert.strictEqual((await call(app, '/api/skills/update', { id: installed.body.id, action: 'check' })).body.updateAvailable, true, 'keep records the choice; the version is not forced');
      // THE SHARED TEST HOME IS LEFT AS FOUND: a later test asserts no skill is installed (workspaceshell.test.js).
      for (const id of [installed.body.id, ui.body.id, dup.body.id]) { try { integ.removeSkill(app, id, { deleteFiles: true }); } catch { /* already gone */ } }
    });

    await test('SKILLS: a Hermes / Agent Skills package is imported into LAIN\'s own store — Hermes is never started', async () => {
      const hub = require('../../src/skillshub');
      const root = tmpdir('p83hermes-');
      const d = path.join(root, 'research', 'arxiv-digest');
      fs.mkdirSync(path.join(d, 'references'), { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: arxiv-digest\ndescription: Summarise new arXiv papers for a topic\nversion: 2.0.0\nlicense: Apache-2.0\nallowed-tools: [Read, Grep]\nmetadata:\n  author: Hermes community\n  hermes:\n    tags: [research, papers]\n---\n# arXiv digest\n');
      fs.writeFileSync(path.join(d, 'references', 'format.md'), '# format\n');
      const spawned = [];
      const real = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFile: cp.execFile };
      cp.spawn = (c, ...a) => { spawned.push(String(c)); return real.spawn(c, ...a); };
      cp.spawnSync = (c, ...a) => { spawned.push(String(c)); return real.spawnSync(c, ...a); };
      cp.execFile = (c, ...a) => { spawned.push(String(c)); return real.execFile(c, ...a); };
      try {
        const app = mk('p83h-');
        const src = hub.addSource({ type: 'folder', path: root, label: 'Hermes skills folder' });
        await hub.refresh({ id: src.id });
        const row = hub.search(app, { query: 'arxiv' }).skills[0];
        assert.ok(row && row.compatible, 'an Agent Skills folder is compatible');
        assert.deepStrictEqual(row.tags.sort(), ['papers', 'research']);
        const ins = hub.inspect(row.key).skill;
        assert.deepStrictEqual([ins.capabilities, ins.author, ins.license], [['Read', 'Grep'], 'Hermes community', 'Apache-2.0']);
        const r = hub.install(app, row.key, { enable: true });
        assert.ok(r.ok && r.enabled, JSON.stringify(r));
        const dir = require('../../src/integrations').store(app).skills[r.id].path;
        assert.ok(dir.startsWith(path.join(require('../../src/config').configDir(), 'skills')), 'in LAIN\'s own store');
        assert.ok(fs.existsSync(path.join(dir, 'references', 'format.md')), 'every file came with it');
        assert.match(require('../../src/integrations').skillsPrompt(app), /arxiv-digest/);
        // THE SHARED TEST HOME IS LEFT AS FOUND (workspaceshell.test.js asserts no skill is installed).
        require('../../src/integrations').removeSkill(app, r.id, { deleteFiles: true });
      } finally { Object.assign(cp, real); }
      assert.ok(!spawned.some((c) => /hermes/i.test(c)), `no Hermes process: ${spawned.join(', ')}`);
    });

    await test('TRAY: only reported windows; Codex accounts, Claude, a monthly-only account; a reset updates it without a restart', async () => {
      resetStore(); await fx.reset();
      const tray = require('../../src/fabric/tray');
      tray.reset();
      const app = mk('p83t-');
      const { win } = fx;
      const acc = await fx.codexAccounts(app, [
        { name: 'Personal', email: 'personal@example.com', limits: { primary: win(74, 300, 130), secondary: win(52, 10080, 4000) } },
        { name: 'Work', email: 'work@example.com', limits: { primary: win(91, 300, 40), secondary: win(67, 10080, 2500) } },
        { name: 'Backup', email: 'backup@example.com', limits: { secondary: win(84, 10080, 3000) } },
        { name: 'Trial', email: 'trial@example.com', limits: { secondary: win(72, 43200, 20000) } },
      ]);
      await fx.claudeRuntime(app, tmpdir('p83t-claude-'));
      const w = (fh, wk) => [{ label: '5-hour', usedPercent: fh }, { label: 'weekly', usedPercent: wk }];
      store.recordQuota(F.family(app, 'claude').accounts[0].id, { windows: w(63, 41) });
      store.recordQuota(acc[2].id, { windows: [{ label: 'weekly', usedPercent: 84 }], limited: { until: Date.now() + 400, reason: 'rate limited' } });
      const sent = [];
      const ipc = require('../../src/harnessapp/ipc');
      const realToHost = ipc.toHost;
      ipc.toHost = (v) => { sent.push(v); return { ok: true, sent: 1 }; };
      try {
        const s = tray.summary(app);
        assert.deepStrictEqual(s.lines.slice(0, 6), ['LAIN', 'Codex', '  Personal  5h 26% left · Weekly 48% left', '  Work  5h 9% left · Weekly 33% left', '  Backup  Limited · Weekly 16% left', '  Trial  Monthly 28% left'], 'what REMAINS, stated as such — monthly only, no invented 5-hour or weekly');
        assert.ok(s.lines.some((l) => /^Claude( Pro)? {2}5h 37% left · Weekly 59% left$/.test(l)), s.lines.join('\n'));
        assert.ok(s.tooltip.length <= 127);
        tray.bind(app);
        tray.changed(app);
        const n = sent.length;
        tray.changed(app);
        assert.strictEqual(sent.length, n, 'nothing changed → nothing sent');
        await new Promise((r) => setTimeout(r, 1700));   // Backup's limit ends — the one timer re-reads
        assert.ok(sent.length > n, 'the reset reached the tray without a restart');
        assert.match(sent[sent.length - 1], /Backup {2}Weekly 16% left/);
        // IDLE: no polling — nothing is sent while nothing happens, and the process does no tray work.
        const before = sent.length; const cpu0 = process.cpuUsage(); const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 1500));
        const cpu = process.cpuUsage(cpu0);
        assert.strictEqual(sent.length, before, 'no idle refresh');
        assert.ok((cpu.user + cpu.system) / 1000 < (Date.now() - t0) * 0.1, `idle CPU ${(cpu.user + cpu.system) / 1000} ms over ${Date.now() - t0} ms`);
      } finally { ipc.toHost = realToHost; tray.reset(); await fx.reset(); }
    });

    await test('PERFORMANCE: 1,000+ models across many accounts — built once; warm pickers and search re-fetch and re-normalise nothing', async () => {
      resetStore();
      const app = mk('p83p-');
      await fx.reset();
      const rows = Array.from({ length: 140 }, (_, j) => ({ id: `model-${j}`, model: `model-${j}`, displayName: `Model ${j}`, hidden: false, isDefault: false, supportedReasoningEfforts: j % 3 === 0 ? [{ reasoningEffort: 'high', description: '' }, { reasoningEffort: 'xhigh', description: '' }] : [] }));
      await fx.codexAccounts(app, Array.from({ length: 8 }, (_, i) => ({ name: `Account ${i + 1}`, email: `acct${i}@example.com`, models: rows })));
      const conns = {};
      for (let i = 0; i < 0; i++) conns[`lain:r${i}`] = { baseUrl: 'http://127.0.0.1:9/v1', provider: '9router', apiKey: 'k', models: Array.from({ length: 140 }, (_, j) => ({ id: `cx/model-${j}${j % 3 === 0 ? '-high' : ''}`, owned_by: 'cx' })) };
      conns['lain:big'] = { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'k', models: Array.from({ length: 1100 }, (_, j) => `vendor-${j % 17}/model-${j}`) };
      app.cfg.connections = conns;
      const t0 = process.hrtime.bigint();
      const I = F.index(app);
      const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(I.modelCount >= 1100, `models: ${I.modelCount}`);
      assert.strictEqual(F.family(app, 'codex').accounts.length, 8, 'eight backing accounts, one Codex');
      const reads = [];
      const realRead = fs.readFileSync;
      fs.readFileSync = function (...a) { reads.push(String(a[0])); return realRead.apply(this, a); };
      let warmMs; let searchMs; let pickMs;
      try {
        const t1 = process.hrtime.bigint(); const again = F.index(app); warmMs = Number(process.hrtime.bigint() - t1) / 1e6;
        assert.strictEqual(again, I, 'the warm index is the same object — not rebuilt');
        const s = await call(app, '/api/intel/search', { query: 'model-7', limit: 50 }); searchMs = s.body.ms;
        assert.ok(s.body.total > 0);
        const t2 = process.hrtime.bigint(); await call(app, '/api/intel/search', { family: 'codex', lane: 'coding', limit: 300 }); pickMs = Number(process.hrtime.bigint() - t2) / 1e6;
      } finally { fs.readFileSync = realRead; }
      // (the supervisor's endpoint file is read by an unrelated background check in the test process)
      assert.deepStrictEqual(reads.filter((r) => !/fabric\.json$|[\\/]supervisor[\\/]/.test(r)), [], `warm reads: ${reads.join(', ')}`);
      assert.ok(warmMs < 5, `warm index ${warmMs} ms`);
      assert.ok(searchMs < 50 && pickMs < 150, `search ${searchMs} ms, picker ${pickMs} ms`);
      fs.writeFileSync(path.join(require('../../src/config').configDir(), 'phase83-perf.json'), JSON.stringify({ models: I.modelCount, accounts: 8 + 1, firstBuildMs: firstMs, indexBuildMs: I.buildMs, warmIndexMs: warmMs, searchMs, pickerMs: pickMs }, null, 1));
    });
  } finally {
    if (savedProvider !== undefined) process.env.LAIN_PROVIDER = savedProvider;
    for (const s of servers) { try { s.srv.close(); } catch { /* closed */ } }
    await fx.reset();
    resetStore();
  }
};
