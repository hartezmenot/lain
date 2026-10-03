#!/usr/bin/env node
'use strict';

/**
 * A FAKE GitHub CLI (`gh`) — just the calls github.js makes, against local data:
 *   gh api user --jq .login                     → FAKE_GH_USER (or not signed in)
 *   gh api user/repos?…                         → FAKE_GH_REPOS (a JSON file)
 *   gh api repos/o/r/pulls --method POST --input -   → a created PR (logged to FAKE_GH_LOG)
 *   gh api repos/o/r/pulls?…  / issues?…         → [] / logged
 *   gh repo clone o/r <dir>                      → clones FAKE_GH_REMOTES/o__r.git; origin
 *                                                  fetch URL is github.com/o/r, push URL the bare repo
 * Nothing here talks to GitHub.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const log = (x) => { if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(x)}\n`); };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };

// SEVERAL ACCOUNTS (gh ≥ 2.40): FAKE_GH_ACCOUNTS="a,b" — the first is gh's active one. A call made with
// GH_TOKEN=gho_fake_<login>_… acts as <login>, the way gh honours GH_TOKEN over its own active account.
const ACCTS = (process.env.FAKE_GH_ACCOUNTS || process.env.FAKE_GH_USER || '').split(',').map((s) => s.trim()).filter(Boolean);
const asUser = (() => { const m = /^gho_fake_([A-Za-z0-9-]+)_/.exec(process.env.GH_TOKEN || ''); return m ? m[1] : ACCTS[0] || null; })();

if (args[0] === 'auth' && args[1] === 'status') {
  if (!ACCTS.length) { process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n'); process.exit(1); }
  const lines = ['github.com'];
  ACCTS.forEach((a, i) => lines.push(`  ✓ Logged in to github.com account ${a} (keyring)`, `  - Active account: ${i === 0}`, '  - Git operations protocol: https', '  - Token: gho_************************************', "  - Token scopes: 'read:org', 'repo'", ''));
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'token') {
  const user = args.includes('--user') ? args[args.indexOf('--user') + 1] : ACCTS[0];
  if (!user || !ACCTS.includes(user)) { process.stderr.write(`no oauth token found for github.com account ${user}\n`); process.exit(1); }
  log({ kind: 'token', user });
  process.stdout.write(`gho_fake_${user}_000000000000000000000000\n`);
  process.exit(0);
}

if (args[0] === 'api') {
  const route = args[1];
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
  if (!asUser) { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\n'); process.exit(4); }
  log({ kind: 'api', route, method, as: asUser });
  if (route === 'user') { process.stdout.write(`${asUser}\n`); process.exit(0); }
  if (route.startsWith('user/repos')) {
    const own = process.env.FAKE_GH_REPOS_DIR ? path.join(process.env.FAKE_GH_REPOS_DIR, `${asUser}.json`) : null;
    process.stdout.write(fs.readFileSync(own && fs.existsSync(own) ? own : process.env.FAKE_GH_REPOS, 'utf8'));
    process.exit(0);
  }
  const m = /^repos\/([^/]+)\/([^/]+)\/(pulls|issues)/.exec(route);
  if (m && method === 'POST') {
    const body = JSON.parse(readStdin() || '{}');
    log({ kind: m[3], repo: `${m[1]}/${m[2]}`, body, as: asUser });
    const n = m[3] === 'pulls' ? 7 : 3;
    process.stdout.write(JSON.stringify({ number: n, html_url: `https://github.com/${m[1]}/${m[2]}/${m[3] === 'pulls' ? 'pull' : 'issues'}/${n}`, title: body.title }));
    process.exit(0);
  }
  if (m) { process.stdout.write('[]'); process.exit(0); }
  process.stderr.write(`fake gh: no route ${route}\n`); process.exit(1);
}
if (args[0] === 'repo' && args[1] === 'clone') {
  const [owner, repo] = String(args[2]).split('/');
  const bare = path.join(process.env.FAKE_GH_REMOTES, `${owner}__${repo}.git`);
  const target = args[3];
  const r = spawnSync('git', ['clone', '-q', bare, target], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  spawnSync('git', ['-C', target, 'remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`]);
  spawnSync('git', ['-C', target, 'remote', 'set-url', '--push', 'origin', bare]);
  log({ kind: 'clone', repo: `${owner}/${repo}`, target });
  process.exit(0);
}
process.stderr.write(`fake gh: unsupported ${args.join(' ')}\n`);
process.exit(1);
