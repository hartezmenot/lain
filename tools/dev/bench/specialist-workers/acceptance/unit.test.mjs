// HIDDEN ACCEPTANCE — backend + client defects. Run against a working copy:
//   FIXTURE_DIR=<copy> node --test bench/specialist-workers/acceptance/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.env.FIXTURE_DIR;
if (!DIR) throw new Error('FIXTURE_DIR is required');
const mod = (rel) => import(pathToFileURL(path.join(DIR, rel)).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamdesk-acc-'));
process.env.SETTINGS_FILE = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.SETTINGS_FILE, JSON.stringify({ workspaceName: 'Before', digest: 'weekly' }));
delete process.env.LOG_LEVEL;

// Everything the server prints, for the diagnostics checks.
const printed = [];
for (const k of ['log', 'info', 'debug', 'warn', 'error']) {
  const orig = console[k];
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); if (process.env.ACC_VERBOSE) orig(...a); };
}

const { createApi } = await mod('server/app.js');
const srv = createApi().listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const call = (p, method = 'GET', body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
test.after(() => srv.close());

test('B1 stale settings: a saved value is what the next GET returns', async () => {
  const put = await call('/api/settings', 'PUT', { workspaceName: 'After', digest: 'daily' });
  assert.equal(put.status, 200);
  const got = await (await call('/api/settings')).json();
  assert.equal(got.workspaceName, 'After');
  assert.equal(got.digest, 'daily');
});

test('B2 API mapping: snake_case user becomes the UI shape', async () => {
  const { normalizeUser } = await mod('src/api.js');
  const u = normalizeUser({ id: 7, display_name: 'Ada Lovelace', avatar_url: '/a.svg' });
  assert.equal(u.displayName, 'Ada Lovelace');
  assert.equal(u.avatarUrl, '/a.svg');
});

test('B3a retry: 503 is retried, 400 is not', async () => {
  const { request } = await mod('src/api.js');
  let n = 0;
  const flaky = async () => { n += 1; return n < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ fine: true }) }; };
  assert.deepEqual(await request('/x', {}, { retries: 2, fetchImpl: flaky }), { fine: true });
  assert.equal(n, 3, '503 retried twice then succeeded');
  let m = 0;
  const bad = async () => { m += 1; return { ok: false, status: 400, json: async () => ({}) }; };
  await assert.rejects(request('/x', {}, { retries: 2, fetchImpl: bad }));
  assert.equal(m, 1, 'a 400 is never retried');
});

test('B3b race: an older save that answers last does not win', async () => {
  const { saveSettings, currentSettings } = await mod('src/api.js');
  const resolvers = [];
  const slow = (p, opts) => new Promise((resolve) => resolvers.push(() => resolve({ ok: true, status: 200, json: async () => JSON.parse(opts.body) })));
  const first = saveSettings({ workspaceName: 'old', digest: 'weekly' }, { fetchImpl: slow });
  const second = saveSettings({ workspaceName: 'new', digest: 'weekly' }, { fetchImpl: slow });
  await new Promise((r) => setTimeout(r, 10));
  resolvers[1]();                 // the newer request answers first
  await second;
  resolvers[0]();                 // the older one answers last
  await first.catch(() => {});
  assert.equal(currentSettings().workspaceName, 'new');
});

test('B4 diagnostics: default level prints no debug and never a password', async () => {
  printed.length = 0;
  await call('/api/login', 'POST', { username: 'ada', password: 'hunter2-secret' });
  await call('/api/settings');
  const all = printed.join('\n');
  assert.ok(!all.includes('hunter2-secret'), 'the password never reaches the log');
  assert.ok(!/\[DEBUG\]/.test(all), 'no debug lines by default');
});

test('B5 auth: /api/login exists and checks the password', async () => {
  const good = await call('/api/login', 'POST', { username: 'ada', password: 'correct horse' });
  assert.equal(good.status, 200);
  assert.ok((await good.json()).token);
  const wrong = await call('/api/login', 'POST', { username: 'ada', password: 'nope' });
  assert.equal(wrong.status, 401);
  const nobody = await call('/api/login', 'POST', { username: 'eve', password: 'correct horse' });
  assert.equal(nobody.status, 401);
});

test('existing behaviour kept: health, teams, billing', async () => {
  assert.equal((await call('/api/health')).status, 200);
  assert.equal((await (await call('/api/teams')).json()).length, 3);
  assert.equal((await (await call('/api/billing/invoices')).json()).length, 3);
});
