'use strict';

/**
 * PHASE 8 CORE — AGENTS.md editing, GitHub projects, feedback privacy, the
 * writer lease (Continue in CLI), session controls, appearance, provider
 * reset-window accounting, and the passive-selection invariant.
 * Fakes only: a fake `gh` over local bare repositories; no network, no model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

function sh(cwd, ...a) { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

module.exports = async function () {
  const { App } = require('../../src/app');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const mk = (cwd) => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: cwd || tmpdir('p8-') });
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'LAIN Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'LAIN Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

  await test('AGENTS.md: global and project scopes; save; effective inheritance; reset shows a diff, needs confirmation, keeps a backup', async () => {
    process.env.LAIN_AGENTS_HOME = tmpdir('agents-home-');
    const app = mk(tmpdir('agents-proj-'));
    const md = require('../../src/agentsmd');
    let r = await call(app, '/api/agents/read', { scope: 'global' });
    assert.strictEqual(r.body.file.exists, false);
    assert.match(r.body.default.text, /LAIN default AGENTS.md/);
    r = await call(app, '/api/agents/save', { scope: 'global', text: '# Mine\n- keep diffs small\n' });
    assert.strictEqual(r.body.file.modified, true);
    await call(app, '/api/agents/save', { scope: 'project', text: '# Project\n- use tabs\n' });
    const eff = (await call(app, '/api/agents/effective')).body;
    assert.deepStrictEqual(eff.layers.map((l) => [l.scope, l.active]), [['global', true], ['project', true]]);
    assert.ok(eff.prompt.indexOf('keep diffs small') < eff.prompt.indexOf('use tabs'), 'project reads after global');
    const prev = (await call(app, '/api/agents/preview-reset', { scope: 'global' })).body;
    assert.strictEqual(prev.needsConfirm, true);
    assert.ok(prev.diff.some((d) => d.op === '-' && /keep diffs small/.test(d.text)));
    const refused = await call(app, '/api/agents/reset', { scope: 'global' });
    assert.strictEqual(refused.code, 428, 'no silent overwrite');
    assert.match(fs.readFileSync(md.homeFile(), 'utf8'), /keep diffs small/);
    const done = await call(app, '/api/agents/reset', { scope: 'global', confirm: true });
    assert.strictEqual(done.body.file.isDefault, true);
    assert.match(fs.readFileSync(done.body.backup, 'utf8'), /keep diffs small/, 'the custom text is kept as a backup');
    assert.match(fs.readFileSync(md.projectFile(app.session.cwd), 'utf8'), /use tabs/, 'the project file is independent');
    delete process.env.LAIN_AGENTS_HOME;
  });

  await test('GITHUB: connect (gh) → repos → un-cloned repo keeps Coding disabled → clone registers → edit → commit/push/PR only on explicit confirm', async () => {
    const { shim, FIX } = require('../fixtures/runtimes/shim');
    const remotes = tmpdir('gh-remotes-');
    const bare = path.join(remotes, 'octo__widget.git');
    sh(remotes, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = tmpdir('gh-seed-');
    sh(seed, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(seed, 'README.md'), '# widget\n');
    sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'init'); sh(seed, 'push', '-q', bare, 'main');
    const reposFile = path.join(tmpdir('gh-data-'), 'repos.json');
    fs.writeFileSync(reposFile, JSON.stringify([{ full_name: 'octo/widget', private: true, default_branch: 'main', html_url: 'https://github.com/octo/widget', updated_at: '2026-09-27T00:00:00Z' }, { full_name: 'octo/other', private: false, default_branch: 'main', html_url: 'https://github.com/octo/other' }]));
    const logFile = path.join(tmpdir('gh-log-'), 'log.jsonl');
    Object.assign(process.env, { FAKE_GH_USER: 'octo', FAKE_GH_REPOS: reposFile, FAKE_GH_REMOTES: remotes, FAKE_GH_LOG: logFile });
    const app = mk();
    app.cfg.github = { ghBin: shim(tmpdir('gh-bin-'), 'gh', path.join(FIX, 'fakegh.js')), cloneRoot: tmpdir('gh-clones-') };
    try {
      const st = (await call(app, '/api/github/status')).body.github;
      assert.deepStrictEqual([st.connected, st.via, st.user], [true, 'gh', 'octo']);
      const repos = (await call(app, '/api/github/repos')).body.repos;
      assert.deepStrictEqual(repos.map((r) => [r.fullName, r.state.label]), [['octo/widget', 'Not downloaded'], ['octo/other', 'Not downloaded']]);
      await call(app, '/api/project/detach');
      const as = await call(app, '/api/github/assign', { fullName: 'octo/widget' });
      assert.strictEqual(as.body.cloned, false);
      assert.match(as.body.why, /must be cloned locally before Coding Agent/);
      const coding = require('../../src/harnessapp/viewroutes').submit(app, { view: 'coding', text: 'rename x' });
      assert.strictEqual(coding.body.projectRequired, true, 'Coding Agent disabled until cloned');
      const cl = await call(app, '/api/github/clone', {});
      assert.strictEqual(cl.code, 200, cl.body.why);
      assert.strictEqual(cl.body.attached, true);
      const dir = cl.body.dir;
      assert.ok(fs.existsSync(path.join(dir, 'README.md')));
      assert.strictEqual(require('../../src/sessionviews').project(app.session).root, dir);
      const again = (await call(app, '/api/github/repos')).body.repos.find((r) => r.fullName === 'octo/widget');
      assert.strictEqual(again.state.label, 'Up to date', 'a fresh clone matches its remote (Phase 8.1 status words)');
      fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = 1;\n');
      const pj = (await call(app, '/api/github/project')).body;
      assert.strictEqual(pj.git.modified, 1);
      const noConfirm = await call(app, '/api/github/action', { kind: 'commit', args: { message: 'add src' } });
      assert.strictEqual(noConfirm.code, 428, 'a write needs an explicit confirm');
      const commit = await call(app, '/api/github/action', { kind: 'commit', args: { message: 'add src' }, confirm: true });
      assert.strictEqual(commit.code, 200, commit.body.why);
      assert.strictEqual(commit.body.state.unpushed, 1);
      assert.match(commit.body.state.summary, /main · clean · 1 unpushed commit/);
      const bareBefore = sh(remotes, '--git-dir', bare, 'log', '--oneline').split('\n').length;
      const push = await call(app, '/api/github/action', { kind: 'push', confirm: true });
      assert.strictEqual(push.code, 200, push.body.why);
      assert.strictEqual(sh(remotes, '--git-dir', bare, 'log', '--oneline').split('\n').length, bareBefore + 1);
      const pr = await call(app, '/api/github/action', { kind: 'pr-create', args: { title: 'Add src' }, confirm: true });
      assert.strictEqual(pr.body.pr.number, 7);
      const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(logged.some((x) => x.kind === 'pulls' && x.body.head === 'main'));
      assert.ok(!Object.keys(require('../../src/tools')).includes('github'), 'no model tool can push');
    } finally { delete process.env.FAKE_GH_USER; delete process.env.FAKE_GH_REPOS; delete process.env.FAKE_GH_REMOTES; delete process.env.FAKE_GH_LOG; }
  });

  await test('FEEDBACK: attachments only when ticked; anonymized; secrets refused; saved locally', async () => {
    const app = mk();
    app.session.turns.push({ endedAt: new Date().toISOString(), errors: [{ kind: 'X', message: `failed at ${app.session.cwd}\\a.js for me@example.com` }] });
    const bare = await call(app, '/api/feedback/preview', { type: 'bug', title: 'Composer froze', description: 'It froze.' });
    assert.deepStrictEqual(Object.keys(bare.body.preview.attachments), [], 'nothing attached by default');
    const withAtt = await call(app, '/api/feedback/preview', { type: 'bug', title: 'Composer froze', include: { version: true, surface: true, errors: true }, surface: 'chat' });
    const a = withAtt.body.preview.attachments;
    assert.ok(a.version.core);
    assert.strictEqual(a.surface, 'chat');
    assert.ok(a.errors.length && !a.errors[0].message.includes(app.session.cwd) && /<project>/.test(a.errors[0].message) && /<email>/.test(a.errors[0].message));
    assert.ok(!('screenshot' in a) && !('logs' in a), 'screenshot and logs need an explicit tick');
    const leak = await call(app, '/api/feedback/preview', { type: 'bug', title: 'key', description: 'my key is sk-abcdefghijklmnopqrstuvwxyz123456' });
    assert.ok(leak.code === 400 || !JSON.stringify(leak.body).includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'a secret never survives into the report');
    const sub = await call(app, '/api/feedback/submit', { type: 'ux', title: 'Tabs too small', include: { version: true } });
    assert.strictEqual(sub.code, 200, sub.body.why);
    assert.ok(fs.existsSync(path.join(sub.body.saved, 'report.json')));
    assert.strictEqual(sub.body.issue, null, 'nothing leaves the machine unless asked');
  });
  await test('CONTROLS: /fast toggles (Normal ⇄ Fast), queued while the Agent works; /effort, /mode, /status, /strategy; slash text never reaches a model', async () => {
    const app = mk();
    const provider = require('../../src/provider');
    const was = provider.chat; let calls = 0;
    provider.chat = async function* () { calls += 1; };
    try {
      let r = (await call(app, '/api/controls/run', { text: '/fast' })).body.result;
      assert.match(r.text, /FAST/);
      r = (await call(app, '/api/controls/run', { text: '/fast' })).body.result;
      assert.match(r.text, /NORMAL/, 'a second /fast returns to Normal');
      assert.strictEqual((await call(app, '/api/controls/run', { text: '/slow' })).code, 404, '/slow was retired (Phase 8.1): Eco is the conservative profile');
      assert.ok(!(await call(app, '/api/controls/list')).body.controls.some((c) => c.name === '/slow'));
      app.session.thread = 'coding'; app.abort = new AbortController();
      r = (await call(app, '/api/controls/run', { text: '/eco' })).body.result;
      assert.match(r.text, /queued/);
      app.abort = null;
      r = (await call(app, '/api/controls/run', { text: '/effort xhigh' })).body.result;
      assert.strictEqual(r.ok, true, r.text);
      r = (await call(app, '/api/controls/run', { text: '/mode plan' })).body.result;
      assert.match(r.text, /Mode: Plan/);
      r = (await call(app, '/api/controls/run', { text: '/strategy phased' })).body.result;
      assert.match(r.text, /Phased/);
      r = (await call(app, '/api/controls/run', { text: '/status' })).body.result;
      assert.match(r.text, /Effort: xhigh/i);
      assert.strictEqual((await call(app, '/api/controls/run', { text: '/nonsense' })).code, 404);
      assert.strictEqual(calls, 0);
    } finally { provider.chat = was; }
  });

  await test('APPEARANCE: palettes, light/dark, custom colours, zoom steps, sizes, theme and keymap are independent and validated', async () => {
    const app = mk();
    let r = await call(app, '/api/appearance', { set: { mode: 'light', palette: 'violet', zoom: 125, type: 'large', icons: 'large', theme: 'jetbrains', keymap: 'jetbrains' } });
    assert.strictEqual(r.code, 200, r.body.why);
    assert.deepStrictEqual([r.body.ui.mode, r.body.ui.palette, r.body.ui.zoom, r.body.ui.theme, r.body.ui.keymap], ['light', 'violet', 125, 'jetbrains', 'jetbrains']);
    r = await call(app, '/api/appearance', { set: { keymap: 'vscode', theme: 'lain' } });
    assert.deepStrictEqual([r.body.ui.keymap, r.body.ui.theme], ['vscode', 'lain'], 'keymap and theme are separate axes');
    assert.strictEqual((await call(app, '/api/appearance', { set: { zoom: 133 } })).code, 400);
    assert.strictEqual((await call(app, '/api/appearance', { set: { custom: { accent: 'teal' } } })).code, 400);
    r = await call(app, '/api/appearance', { set: { palette: 'custom', custom: { accent: '#ff4d7a' } } });
    assert.strictEqual(r.body.ui.custom.accent, '#FF4D7A');
    r = await call(app, '/api/appearance', { set: { reset: 'palette' } });
    assert.strictEqual(r.body.ui.palette, 'slate', 'Slate is the default palette (8.4)');
  });

  await test('RESET WINDOWS: observed usage per provider window (5-hour, weekly), current vs previous, kept apart from the provider %', async () => {
    const app = mk();
    const usage = require('../../src/usage');
    const ra = require('../../src/runtimeadapters');
    const now = Date.now();
    const H = 3600e3;
    // THE ACCOUNT MUST BE CONNECTED to have windows (fabric/quotaview.js): the fake Claude Code, then its reading.
    await require('../harness/fabricfixtures').claudeRuntime(app, tmpdir('p8-claude-'));
    ra.saveTelemetry('claude-code', { ...(ra.cachedTelemetry('claude-code') || {}), ok: true, limits: { at: Date.now() + 1, basis: 'reported by Claude Code (rate_limit_event)', windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 62, resetsAt: now + 2 * H }, { id: 'seven_day', label: 'weekly', usedPercent: 71, resetsAt: now + 3 * 24 * H }] } });
    require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null;
    const rec = (at, over) => usage.record({ id: `r${Math.random()}`, at, ok: true, transport: 'runtime', runtime: 'claude-code', model: 'claude-code/opus', connection: 'runtime:claude-code', receipt: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheCreationTokens: 50, reasoningTokens: 30, ...over } });
    rec(now - 1 * H);            // current 5-hour window (started now-3h)
    rec(now - 2 * H, { inputTokens: 3000 });
    rec(now - 5 * H);            // previous 5-hour window, current week
    rec(now - 20 * H);           // older: only the weekly window
    const ws = (await call(app, '/api/usage/windows', { by: 'project' })).body.windows;
    const five = ws.find((w) => w.window === 'five_hour');
    const week = ws.find((w) => w.window === 'seven_day');
    assert.deepStrictEqual([five.label, five.category, five.durationMins], ['5-hour', 'SHORT_TERM', 300], 'the provider label is kept');
    assert.deepStrictEqual([five.observed.requests, five.observed.input, five.observed.output, five.observed.cacheRead, five.observed.cacheWrite, five.observed.reasoning], [2, 4000, 400, 1000, 100, 60]);
    assert.strictEqual(five.previous.observed.requests, 1);
    assert.strictEqual(five.usedPercent, 62, 'provider % is its own number');
    assert.strictEqual(five.remainingPercent, 38);
    assert.strictEqual(week.category, 'WEEKLY');
    assert.strictEqual(week.observed.requests, 4);
    assert.ok(five.breakdown.length >= 1 && five.breakdown[0].share === 100);
  });

  await test('PASSIVE SELECTION: choosing a model, account or effort sends nothing — no request, no spawn', async () => {
    const app = mk();
    const provider = require('../../src/provider');
    const mr = require('../../src/modelrequest');
    const reg = require('../../src/runtimeregistry');
    const was = { chat: provider.chat, open: mr.open, spawn: reg.spawnRegistered };
    let n = 0;
    provider.chat = async function* () { n += 1; };
    mr.open = (...a) => { n += 1; return was.open(...a); };
    reg.spawnRegistered = (...a) => { n += 1; return was.spawn(...a); };
    try {
      const intel = require('../../src/sessionintel');
      await intel.set(app, app.session, { lane: 'reasoning', value: 'high' });
      await intel.set(app, app.session, { lane: 'coding', field: 'model', value: 'mock-model', scope: 'session' }).catch(() => {});
      await call(app, '/api/controls/run', { text: '/effort low' });
      assert.strictEqual(n, 0, 'selection is state only; SEND is the inference boundary');
    } finally { provider.chat = was.chat; mr.open = was.open; reg.spawnRegistered = was.spawn; }
  });

  await test('IMPORTED THEME: an installed extension’s colour theme is read as data (includes, comments), mapped to editor tokens; nothing runs', async () => {
    const app = mk();
    const root = path.join(require('../../src/config').configDir(), 'extensions');
    fs.mkdirSync(path.join(root, 'acme.night', 'themes'), { recursive: true });
    const reg = path.join(root, 'extensions.json');
    const before = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : null;
    try {
      fs.writeFileSync(path.join(root, 'acme.night', 'package.json'), JSON.stringify({ name: 'night', displayName: 'Acme Night', main: './boom.js', contributes: { themes: [{ label: 'Acme Night', uiTheme: 'vs-dark', path: './themes/night.json' }, { label: 'Escape', path: '../../outside.json' }] } }));
      fs.writeFileSync(path.join(root, 'acme.night', 'boom.js'), 'throw new Error("extension code must not run for a theme");');
      fs.writeFileSync(path.join(root, 'acme.night', 'themes', 'base.json'), '{ "colors": { "editor.background": "#101010" }, "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#777777", "fontStyle": "italic" } } ] }');
      fs.writeFileSync(path.join(root, 'acme.night', 'themes', 'night.json'), '// a comment\n{ "include": "./base.json", "type": "dark", "colors": { "editor.foreground": "#EEEEEE", "statusBar.background": "#FF0000", }, "tokenColors": [ { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#FF8800" } }, { "scope": "string.quoted.double", "settings": { "foreground": "#00AA00" } } ] }');
      fs.writeFileSync(reg, JSON.stringify({ installed: [{ id: 'acme.night', dir: 'acme.night', enabled: true }] }));
      const list = (await call(app, '/api/themes/list')).body.themes;
      assert.deepStrictEqual(list.map((t) => t.id), ['ext:acme.night/Acme Night', 'ext:acme.night/Escape']);
      const t = (await call(app, '/api/themes/read', { id: 'ext:acme.night/Acme Night' })).body.theme;
      assert.strictEqual(t.base, 'vs-dark');
      assert.strictEqual(t.colors['editor.background'], '#101010', 'include is followed');
      assert.strictEqual(t.colors['editor.foreground'], '#EEEEEE');
      assert.ok(!('statusBar.background' in t.colors), 'only editor colours reach the editor');
      const rule = (tok) => t.rules.find((r) => r.token === tok);
      assert.deepStrictEqual([rule('comment').foreground, rule('comment').fontStyle, rule('keyword').foreground, rule('string').foreground], ['777777', 'italic', 'FF8800', '00AA00']);
      const esc = await call(app, '/api/themes/read', { id: 'ext:acme.night/Escape' });
      assert.strictEqual(esc.body.ok, false, 'a theme path outside its extension is refused');
      const bad = await call(app, '/api/themes/read', { id: '../../etc' });
      assert.strictEqual(bad.code, 404);
      const a = require('../../src/appearance');
      assert.strictEqual(a.set(app, { theme: 'ext:acme.night/Acme Night' }).ok, true);
      assert.strictEqual(a.set(app, { keymap: 'jetbrains' }).ui.theme, 'ext:acme.night/Acme Night', 'keymap and theme are independent');
    } finally {
      if (before == null) fs.rmSync(reg, { force: true }); else fs.writeFileSync(reg, before);
      fs.rmSync(path.join(root, 'acme.night'), { recursive: true, force: true });
    }
  });
};
