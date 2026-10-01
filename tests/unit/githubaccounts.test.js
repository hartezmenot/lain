'use strict';

/**
 * GITHUB — SEVERAL ACCOUNTS (github.js, §13 / §75). Fixtures only: a fake `gh` holding two accounts, local bare
 * repositories, an in-memory secret store. Nothing talks to GitHub.
 *
 *   LIST      every identity LAIN may act as; LAIN's active one; never a token in any answer
 *   SWITCH    LAIN's choice only — gh's own active account is never switched
 *   AS WHOM   a non-active gh account acts through ITS token, handed to the one child by environment
 *   BOUND     a repository's writes go out as the account it was opened with, not whichever is active later
 *   READ-ONLY what GitHub said an account may do is kept: a push it may not make is refused, not retried as another
 *   ISOLATED  adding or forgetting one LAIN-held account never touches another's secret
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
  const gh = require('../../src/github');
  const creds = require('../../src/credentials');
  const mk = (cwd) => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: cwd || tmpdir('gha-') });
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'Noema Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Noema Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  const { shim, FIX } = require('../fixtures/runtimes/shim');

  function world() {
    const remotes = tmpdir('gha-remotes-');
    const bare = path.join(remotes, 'multi__widget.git');
    sh(remotes, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = tmpdir('gha-seed-');
    sh(seed, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(seed, 'README.md'), '# widget\n');
    sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'init'); sh(seed, 'push', '-q', bare, 'main');
    const data = tmpdir('gha-data-');
    const row = (push) => ({ full_name: 'multi/widget', private: true, default_branch: 'main', html_url: 'https://github.com/multi/widget', permissions: { admin: false, push, pull: true } });
    fs.writeFileSync(path.join(data, 'octo.json'), JSON.stringify([row(true)]));
    fs.writeFileSync(path.join(data, 'reader.json'), JSON.stringify([row(false)]));
    fs.writeFileSync(path.join(data, 'repos.json'), JSON.stringify([row(true)]));
    const log = path.join(tmpdir('gha-log-'), 'log.jsonl');
    Object.assign(process.env, { FAKE_GH_ACCOUNTS: 'octo,reader', FAKE_GH_REPOS: path.join(data, 'repos.json'), FAKE_GH_REPOS_DIR: data, FAKE_GH_REMOTES: remotes, FAKE_GH_LOG: log });
    const app = mk();
    app.cfg.github = { ghBin: shim(tmpdir('gha-bin-'), 'gh', path.join(FIX, 'fakegh.js')), cloneRoot: tmpdir('gha-clones-') };
    gh.forgetGhMemo();
    const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { app, bare, remotes, logged };
  }
  const done = () => { for (const k of ['FAKE_GH_ACCOUNTS', 'FAKE_GH_REPOS', 'FAKE_GH_REPOS_DIR', 'FAKE_GH_REMOTES', 'FAKE_GH_LOG']) delete process.env[k]; gh.forgetGhMemo(); };

  await test('GITHUB ACCOUNTS: both gh accounts listed; switching is Noema\'s own; the other account acts through its own token', async () => {
    const { app, logged } = world();
    try {
      const a = (await call(app, '/api/github/accounts')).body;
      assert.deepStrictEqual(a.accounts.map((x) => [x.id, x.via, x.active]), [['gh:octo', 'gh', true], ['gh:reader', 'gh', false]], 'gh\'s own active account is Noema\'s default');
      const sw = await call(app, '/api/github/switch', { id: 'gh:reader' });
      assert.strictEqual(sw.code, 200);
      assert.strictEqual(sw.body.github.user, 'reader');
      const repos = (await call(app, '/api/github/repos')).body;
      assert.strictEqual(repos.account.id, 'gh:reader');
      assert.strictEqual(repos.repos[0].access, 'read', 'what GitHub said this account may do');
      const L = logged();
      assert.ok(L.some((x) => x.kind === 'token' && x.user === 'reader'), 'Noema asked gh for THAT account\'s token');
      assert.ok(L.some((x) => x.kind === 'api' && x.route.startsWith('user/repos') && x.as === 'reader'), 'the listing ran as reader');
      assert.ok(!L.some((x) => /switch|logout/.test(x.kind)), 'gh\'s own active account and sign-in are never changed');
      const bad = await call(app, '/api/github/switch', { id: 'gh:nobody' });
      assert.strictEqual(bad.code, 404);
      // NEVER A TOKEN IN AN ANSWER.
      for (const r of [a, sw.body, repos]) assert.ok(!/gho_fake_/.test(JSON.stringify(r)), 'no token in a route answer');
    } finally { done(); }
  });

  await test('GITHUB ACCOUNTS: a repository\'s writes go out as the account it was opened with; a read-only account is refused, not retried', async () => {
    const { app, bare, remotes, logged } = world();
    try {
      await call(app, '/api/github/switch', { id: 'gh:reader' });
      await call(app, '/api/github/repos');
      await call(app, '/api/project/detach');
      await call(app, '/api/github/assign', { fullName: 'multi/widget' });
      const cl = await call(app, '/api/github/clone', {});
      assert.strictEqual(cl.code, 200, cl.body.why);
      assert.strictEqual(cl.body.account.id, 'gh:reader');
      assert.strictEqual(gh.accountFor(app, 'multi/widget').bound, 'gh:reader', 'bound to the account that opened it');
      const dir = cl.body.dir;
      fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = 1;\n');
      await call(app, '/api/github/action', { kind: 'commit', args: { message: 'add src' }, confirm: true });
      // SWITCHING LATER does not move the repository: it still belongs to reader, who may only read.
      await call(app, '/api/github/switch', { id: 'gh:octo' });
      const before = sh(remotes, '--git-dir', bare, 'log', '--oneline').split('\n').length;
      const refused = await call(app, '/api/github/action', { kind: 'push', confirm: true });
      assert.strictEqual(refused.code, 409);
      assert.match(refused.body.why, /@reader can read multi\/widget but cannot write/);
      assert.strictEqual(sh(remotes, '--git-dir', bare, 'log', '--oneline').split('\n').length, before, 'nothing was pushed — and not as octo either');
      // THE PERSON CHOOSES the repository's account explicitly: now it goes out as octo.
      const b = await call(app, '/api/github/bind', { fullName: 'multi/widget', id: 'gh:octo' });
      assert.strictEqual(b.body.account.login, 'octo');
      const push = await call(app, '/api/github/action', { kind: 'push', confirm: true });
      assert.strictEqual(push.code, 200, push.body.why);
      assert.strictEqual(push.body.as, 'octo');
      assert.strictEqual(sh(remotes, '--git-dir', bare, 'log', '--oneline').split('\n').length, before + 1);
      const pr = await call(app, '/api/github/action', { kind: 'pr-create', args: { title: 'Add src' }, confirm: true });
      assert.strictEqual(pr.code, 200, pr.body.why);
      assert.ok(logged().some((x) => x.kind === 'pulls' && x.as === 'octo'), 'the pull request was opened as octo');
      const noConfirm = await call(app, '/api/github/action', { kind: 'push' });
      assert.strictEqual(noConfirm.code, 428, 'still never without an explicit confirm');
    } finally { done(); }
  });

  await test('GITHUB ACCOUNTS: LAIN-held accounts are isolated — forgetting one never touches another; a gh account is only hidden', async () => {
    creds.useBackend(creds.memoryBackend());
    const { app, logged } = world();
    try {
      // Two LAIN-held accounts, as a token or device sign-in leaves them (their own DPAPI entries).
      const put = (login) => {
        creds.store(creds.ref(`github.${login}`, 'oauth_token'), `github_pat_${login}_secret_0000000000`, { kind: 'oauth_token' });
        app.cfg.github.accounts = { ...(app.cfg.github.accounts || {}), [`pat:${login}`]: { id: `pat:${login}`, login, via: 'pat', addedAt: Date.now() } };
      };
      put('alpha'); put('beta');
      const ids = gh.accounts(app).map((x) => x.id);
      assert.deepStrictEqual(ids, ['gh:octo', 'gh:reader', 'pat:alpha', 'pat:beta']);
      const f = await call(app, '/api/github/disconnect', { id: 'pat:beta' });
      assert.strictEqual(f.code, 200);
      assert.ok(!creds.resolve(creds.ref('github.beta', 'oauth_token')), 'beta\'s secret is gone');
      assert.strictEqual(creds.resolve(creds.ref('github.alpha', 'oauth_token')), 'github_pat_alpha_secret_0000000000', 'alpha\'s is untouched');
      assert.deepStrictEqual(gh.accounts(app).map((x) => x.id), ['gh:octo', 'gh:reader', 'pat:alpha']);
      // A GITHUB CLI ACCOUNT is hidden from LAIN, never signed out of gh.
      const h = await call(app, '/api/github/disconnect', { id: 'gh:reader' });
      assert.match(h.body.note, /gh auth logout/);
      assert.ok(!gh.accounts(app).some((x) => x.id === 'gh:reader'));
      assert.ok(!logged().some((x) => /logout/.test(x.kind)));
      await call(app, '/api/github/restore', { id: 'gh:reader' });
      assert.ok(gh.accounts(app).some((x) => x.id === 'gh:reader'), 'shown again');
      const st = (await call(app, '/api/github/status')).body;
      assert.ok(!/github_pat_|gho_fake_/.test(JSON.stringify(st)), 'no secret in the status');
    } finally { done(); creds.useBackend(null); }
  });

  await test('GITHUB ACCOUNTS: the device flow asks only for the scopes chosen, and needs the person\'s own OAuth App', async () => {
    const app = mk();
    app.cfg.github = {};
    const r = await gh.deviceStart(app, { access: 'private' });
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /OAuth App you registered/);
    assert.deepStrictEqual(gh.DEVICE_SCOPES, { read: 'read:user', public: 'read:user public_repo', private: 'read:user repo' });
  });
};
