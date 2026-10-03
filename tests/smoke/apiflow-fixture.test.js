'use strict';

/**
 * `/api` END TO END, THROUGH THE REAL BINARY — PHASE 8.3: THE TERMINAL NEVER TAKES A KEY.
 *
 * A key is entered only in the Model Dashboard (Model › API). The terminal's
 * `/api`, `/api add` and `/api <provider>` open the dashboard; a key typed at
 * the prompt anyway is refused, never stored, and never drawn. What the
 * dashboard's Add API stores is one registry every LAIN reads: a SECOND
 * process — the real binary — sees the new API source and its models.
 *
 * WHAT IS REAL: the binary (spawned, drawing real frames over a pipe with
 * LAIN_FORCE_TUI), a real HTTP server standing in for the provider (it records
 * what it was sent), the real config file and the real secret store. WHAT IS
 * NOT: the provider's identity — FIXTURE-VERIFIED, never LIVE PROVIDER VERIFIED.
 * The spawned binary runs with LAIN_NO_DESKTOP, so the dashboard is reported as
 * not opened here rather than a window appearing in a test.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, runCli, tmpdir, frames, rowsOf, assertIncludes, assertNotIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** THE SENTINEL: a credential that cannot occur by accident, so "absent from every byte" is a real claim. */
const SENTINEL = 'LAIN_SECRET_SENTINEL_DO_NOT_RENDER_9f3a';
const SERVED = ['fixture/alpha-1', 'fixture/beta-2', 'fixture/gamma-3'];

function serveModels() {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || '' });
      if (!/\/models$/.test(req.url || '')) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: SERVED.map((id) => ({ id })) }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) }));
  });
}

function home(prefix) {
  const cwd = tmpdir(prefix);
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }] }), 'utf8');
  return { cwd, configDir };
}

module.exports = async function () {
  await test('API-FIXTURE (8.3): /api, /api add and /api <key> through the real binary — no key prompt, the key never stored, never drawn, never sent', async () => {
    const srv = await serveModels();
    const { cwd, configDir } = home('apiflow-');
    try {
      const r = await runCli([], {
        cwd, configDir,
        env: { LAIN_FORCE_TUI: '1', COLUMNS: '110', LINES: '34', LAIN_NO_DESKTOP: '1' },
        stdinSteps: ['/api\r', '/api add\r', `/api ${SENTINEL}\r`, '/exit\r'],
        stepDelayMs: 1500, script: [], timeoutMs: 60000,
      });
      const out = plain(r.out);
      assertIncludes(out, 'Model Dashboard', '/api points at the Model Dashboard');
      assertIncludes(out, 'never takes a key in the terminal', 'a key typed at the prompt is refused, and the person is told where keys go');
      assert.ok(!/api credential|paste the api key/i.test(out), 'no credential panel opens in the terminal');
      // THE SENTINEL: only ever on the input row it was typed on — never in the
      // feed, a panel or a message. Row by row (a TUI frame positions its rows
      // with the cursor, so a newline split would see a whole frame as one line).
      const leaks = [];
      for (const f of frames(r.out)) {
        for (const row of rowsOf(f)) {
          if (row.includes(SENTINEL) && !/^[\s▌]*\/api \S+\s*$/.test(row)) leaks.push(row.trim());   // `▌` is the composer's gutter
        }
      }
      assert.deepStrictEqual(leaks, [], 'the key is never drawn back');
      const cfgText = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
      assert.ok(!cfgText.includes(SENTINEL), 'never stored');
      assert.deepStrictEqual(srv.seen, [], 'and never sent anywhere');
    } finally { await srv.close(); }
  });

  await test('API-FIXTURE (8.3): an API added in the dashboard (one process) is read by the real binary (another) — its models, never its key', async () => {
    const srv = await serveModels();
    const { cwd, configDir } = home('apiflow2-');
    const was = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = configDir;   // THIS process is the Harness for a moment: the dashboard's Add API
    try {
      const { App } = require('../../src/app');
      const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
      const added = await require('../../src/harnessapp/accountops').addKey(app, { provider: 'deepseek', key: SENTINEL, baseUrl: srv.baseUrl });
      assert.ok(added.ok, added.why);
      assert.ok(srv.seen.some((s) => s.auth.includes(SENTINEL)), 'the dashboard verified the key with the provider');
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
      assert.ok(!JSON.stringify(cfg).includes(SENTINEL), 'the config holds a reference, never the key');
    } finally { if (was === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = was; }
    try {
      const r = await runCli([], { cwd, configDir, env: { LAIN_NO_DESKTOP: '1' }, stdin: '/model alpha-1\n/status\n/exit\n', script: [] });
      const out = plain(r.stdout);
      assertIncludes(out, 'DeepSeek', 'the other process sees the API source');
      assertIncludes(out, 'Alpha 1', 'and its models');
      assertNotIncludes(out, SENTINEL, 'never its key');
    } finally { await srv.close(); }
  });
};
