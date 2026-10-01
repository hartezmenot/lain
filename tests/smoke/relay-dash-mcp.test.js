'use strict';

/**
 * THE CHAT SOURCES, THE DASHBOARD AND THE DESKTOP SEAM — through the real binary.
 *
 * A unit test proves a function returns the right thing; only this proves the
 * thing reaches a user. Everything here spawns bin/noema.js and asserts on what
 * a person would have read, or talks to the dashboard over real HTTP.
 *
 * LIMITATION, STATED: the model is the scripted mock provider. The PATH is real
 * — the binary, the config, the provider resolution, the command registry, the
 * session — but no real model was consulted here, nothing below opens a browser,
 * and nothing contacts chatgpt.com or gemini.google.com. See
 * docs/MODEL-SOURCES.md for what a LIVE claim about those actually requires.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, runCli, tmpdir, assertIncludes, assertNotIncludes } = require('../helpers');

const plain = (s) => String(s).replace(/\x1b\][0-9]+;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const BRIDGE = path.join(__dirname, '..', 'fixtures', 'stub-bridge.js');

/** A Python project with a real, findable defect and a config we control. */
function probot(cfg = {}) {
  const cwd = tmpdir('probot-');
  fs.mkdirSync(path.join(cwd, 'probot'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'requirements.txt'), 'flask\n');
  fs.writeFileSync(path.join(cwd, 'probot', 'dashboard.py'),
    'def refresh():\n    try:\n        pull()\n    except Exception:\n        pass\n\n'
    + 'def render():\n    try:\n        draw()\n    except: pass\n');
  const configDir = path.join(cwd, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg, null, 2));
  return { cwd, configDir };
}

// (Two scripted FACT / EVIDENCE / HYPOTHESIS / RECOMMENDATION reviews stood
// here — the reviewer's half of the bounded relay these tests used to drive.
// They went with it; nothing scripts a second model any more.)

// NOTHING SECRET IS PRINTED (consolidation §11), so a client gets in the way the page does: a password the person
// set (stored only as a scrypt hash) proved once at /api/login, which mints the session key every later call sends.
const PW = 'correct horse battery staple';
const withPassword = (cfg = {}) => ({ ...cfg, dashPassword: require('../../src/dashauth').hash(PW) });
function login(port) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ password: PW });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b).session || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}
const SECRET_RE = /\b[a-f0-9]{32}\b/;

function get(port, p, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ code: 0, body: e.message }));
  });
}

module.exports = async function () {
  // --------------------------------------------------------- chat sources ---

  // ---- THE RELAY IS RETIRED, AND THAT IS THE RESOLUTION ------------------
  //
  // These tests drove `/troubleshoot` — removed from the command surface by the
  // 2026-09 UX subtraction pass — and then, once that left the bounded external
  // review unreachable, they asserted the REACHABILITY FACT instead: that
  // `investigation.relay` had exactly one caller and no registered command
  // reached it. That was recorded as a known limitation whose repair was a
  // product decision: give the relay a door, or retire it with its module.
  //
  // THE DECISION WAS MADE, AND IT WAS RETIREMENT. `/external`, external.js,
  // actors.js, externalrequest.js and investigation.js are gone. A second
  // opinion is now a chat SOURCE on the session — select ChatGPT.com or
  // Gemini.google.com and the next question goes there, in the same history,
  // with provenance on the answer. Maintaining two consultation systems was
  // the one outcome worse than either. See src/modelsource and `/source`.
  //
  // What is asserted below is that decision, from the outside, through the real
  // binary — which is the only tier that can see whether a command exists.

  await test('RETIRED: the real binary has no /external, and says so', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/external\n/exit\n',
      script: [{ text: 'unused' }],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.strictEqual(r.code, 0, 'an unknown command is not a crash');
    assertNotIncludes(out, 'External actor');
    assertNotIncludes(out, 'external reviewer');
  });

  await test('SOURCE: the real binary answers /source, and defaults to Noema', async () => {
    // THE REPLACEMENT, DRIVEN END TO END. It must list the three sources, mark
    // LAIN as the one in force with nothing configured, and — the sentence that
    // matters most — say that coding stays LAIN's whatever is selected.
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/source\n/exit\n',
      script: [{ text: 'unused' }],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assert.strictEqual(r.code, 0);
    assertIncludes(out, 'Chat source');
    assertIncludes(out, 'Noema');
    // THE WEBSITE SOURCES WERE RETIRED (Phase 8.1): not listed, and nothing on screen points at them.
    assert.ok(!/ChatGPT\.com|Gemini\.google\.com|\/source chatgpt/.test(out), 'a retired website source is neither listed nor suggested');
    assertIncludes(out, "coding request always runs on Noema's runtime");
  });

  await test('SOURCE: a retired website source is refused, says what to use instead, and chat stays Noema', async () => {
    // Selecting one is a local decision that must not launch a browser — and since
    // Phase 8.1 the answer is a refusal with the way forward, never a half-selection.
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: '/source chatgpt\n/source\n/exit\n',
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'website sources were retired');
    assertIncludes(out, '/account');
    assert.ok(!/chat source: ChatGPT\.com/.test(out), 'nothing was selected');
    assert.match(out, /●\s+Noema/, 'chat is still Noema');
  });

  // ----------------------------------------------------------------- dash ---

  await test('DASH: the real binary serves a credential-protected dashboard, read-only', async () => {
    const { cwd, configDir } = probot({});
    // Driven with staged input so the server is up before it is polled.
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['/dash\n', '/dash status\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, 'Remote Control');
    // THE URL AND THE CREDENTIAL ARE NOW TWO THINGS. This asserted a URL ending
    // `/?t=<token>` — which is to say it asserted that the link WAS the secret.
    // That is the shape being removed: a URL leaks through browser history, the
    // address bar, proxy logs and `Referer`, and sending yourself "the dashboard
    // link" sent the credential with it for good. The page asks for the token
    // instead, so the link is safe to pass around and the token is printed on
    // its own line for the person who can see this terminal.
    assert.match(out, /http:\/\/127\.0\.0\.1:\d+\//, 'a localhost URL');
    assert.ok(!/\?t=/.test(out), 'no credential may be in the URL');
    // AND NO CREDENTIAL ANYWHERE IN THE TERMINAL (§11): the startup password used to be printed on its own row;
    // terminal output is history, so now it says how to set the password the page asks for instead.
    assert.ok(!SECRET_RE.test(out), `a 32-hex credential reached the terminal:\n${out.slice(-600)}`);
    assert.match(out, /no password (set|yet)/);
    assertIncludes(out, 'read-only');
    assert.ok(!/0\.0\.0\.0/.test(out), 'the default must not bind every interface');
    assert.strictEqual(r.code, 0);
  });

  await test('DASH: it really answers over HTTP, and really stops with the session', async () => {
    const { cwd, configDir } = probot(withPassword());
    const { spawn } = require('child_process');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('LAIN_')) delete env[k];
    Object.assign(env, { LAIN_CONFIG_DIR: configDir, LAIN_HOME: path.join(configDir, 'supervisor-home'), LAIN_NO_COLOR: '1', NO_COLOR: '1', LAIN_PROVIDER: 'mock', LAIN_SUPERVISOR_BIN: process.env.LAIN_SUPERVISOR_BIN || '', LAIN_SUPERVISOR_LEASE_PORT: process.env.LAIN_SUPERVISOR_LEASE_PORT || '' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'noema.js')], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      await wait(1200);
      child.stdin.write('/dash\n');
      await wait(1500);
      // THE URL AND THE PASSWORD ARE PRINTED SEPARATELY NOW — see the test
      // above for why the link stopped being the credential.
      //
      // ONE PATTERN FOR BOTH SURFACES. `/dash` prints the label and the value
      // on one row; the autostart line in repl.js splits them across two,
      // because that runs before the UI exists and has to fit 40 columns. What
      // is asserted is the LABEL followed by the value — not the layout.
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      assert.ok(m, `no dashboard URL was printed:\n${out.slice(-400)}`);
      assert.ok(!SECRET_RE.test(out), `a credential reached the terminal:\n${out.slice(-400)}`);
      const port = Number(m[1]);
      assert.strictEqual((await get(port, '/api/state')).code, 401, 'no password, no answer');
      const t = await login(port);
      assert.ok(t, 'proving the configured password mints a session key');
      // THE HEADER FORM, which is how the page actually asks — this is the path
      // that has to work, and testing only the query form would leave it unproven.
      const state = await get(port, '/api/state', { 'x-lain-session': t });
      assert.strictEqual(state.code, 200);
      const s = JSON.parse(state.body);
      assert.ok(s.project.name, 'the state names the project');
      assert.strictEqual(s.control.actions, false, 'read-only until told otherwise');
      // THE SHELL LOADS FOR ANYONE — it must, in order to ask — and carries no
      // token and no project. Fetched with NO credential at all, deliberately.
      const page = await get(port, '/');
      assert.strictEqual(page.code, 200, 'the shell must load so it can ask for the password');
      assert.match(page.body, /Noema/);
      assert.match(page.body, /id="gate"/, 'and it must be the gate that loads');
      assert.ok(!page.body.includes(t), 'THE TOKEN MUST NOT BE IN THE PAGE');
      assert.ok(!page.body.includes(s.project.name),
        'nor may an unauthenticated stranger learn which project this is');
      child.stdin.write('/exit\n');
      await wait(2500);
      const after = await get(port, '/api/state', { 'x-lain-session': t });
      assert.strictEqual(after.code, 0, 'the socket must not outlive the session');
    } finally {
      try { child.kill(); } catch { /* gone */ }
    }
  });

  // ------------------------------------------------------------------ mcp ---

  await test('DASH: autostart is ON by default, and OFF is respected', async () => {
    // THE DEFAULT CHANGED, DELIBERATELY. This asserted the opposite — that a
    // plain session starts no dashboard — on the reasoning that a CLI should
    // not open a listening socket for somebody who never asked.
    //
    // That reasoning holds up poorly against what is actually bound: an
    // OS-chosen port on 127.0.0.1, unreachable from the network, serving a page
    // that is a locked gate until a credential is proved. Weighed against
    // retyping `/dash` every session, the design is right that it should simply
    // be there. So the test now pins the new contract AND the way out of it,
    // because a default with no escape is not a default.
    const on = probot({});
    const a = await runCli([], { cwd: on.cwd, configDir: on.configDir, stdin: '/exit\n', script: [], timeoutMs: 30000 });
    assert.match(plain(a.out), /dashboard\s+http/, 'a plain session should bring the dashboard up');

    const off = probot({ dashAutostart: false });
    const b = await runCli([], { cwd: off.cwd, configDir: off.configDir, stdin: '/exit\n', script: [], timeoutMs: 30000 });
    assert.ok(!/dashboard\s+http/.test(plain(b.out)), 'and dashAutostart:false must still turn it off');
  });

  await test('DASH: with autostart ON, it is already serving before /dash is typed', async () => {
    // WHAT THIS PROVES, and it is the point of the feature: the URL is printed
    // and the port ANSWERS, without `/dash` ever being run. Asserting only the
    // printed line would prove a message, not a server.
    const { cwd, configDir } = probot(withPassword({ dashAutostart: true }));
    const { spawn } = require('child_process');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('LAIN_')) delete env[k];
    Object.assign(env, { LAIN_CONFIG_DIR: configDir, LAIN_HOME: path.join(configDir, 'supervisor-home'), LAIN_NO_COLOR: '1', NO_COLOR: '1', LAIN_PROVIDER: 'mock', LAIN_SUPERVISOR_BIN: process.env.LAIN_SUPERVISOR_BIN || '', LAIN_SUPERVISOR_LEASE_PORT: process.env.LAIN_SUPERVISOR_LEASE_PORT || '' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'noema.js')], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    // ---- WAIT FOR THE LINE, NOT FOR A NUMBER OF MILLISECONDS -------------
    //
    // This slept 2000ms and then asserted, which is a race against process
    // startup — and it loses whenever the machine is busy, which inside a file
    // that has already spawned thirteen other binaries is often. A loss was
    // indistinguishable from the banner never being printed at all.
    const until = async (re, ms = 15000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = re.exec(plain(out));
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await wait(50);
      }
    };
    try {
      const m = await until(/dashboard\s+http:\/\/127\.0\.0\.1:(\d+)\//);
      assert.ok(m, `no dashboard was started by itself:\n${plain(out).slice(-400)}`);
      assert.ok(await until(/password required/), `the banner says a password is required:\n${plain(out).slice(0, 400)}`);
      assert.ok(!SECRET_RE.test(plain(out)), 'and prints no credential (§11)');
      const port = Number(m[1]);
      const sessionKey = await login(port);
      // IT REALLY ANSWERS — and still refuses without the token.
      assert.strictEqual((await get(port, '/api/state')).code, 401, 'autostart must not mean unlocked');
      const ok = await get(port, '/api/state', { 'x-lain-session': sessionKey });
      assert.strictEqual(ok.code, 200, 'the autostarted server must actually serve');
      assert.strictEqual(JSON.parse(ok.body).control.actions, false, 'and be read-only, like any other');
    } finally {
      try { child.stdin.write('/exit\n'); } catch { /* already gone */ }
      await wait(800);
      try { child.kill(); } catch { /* gone */ }
    }
  });

  await test('MCP: unconfigured, /mcp says NOT CONFIGURED and starts nothing', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], { cwd, configDir, stdin: '/mcp\n/mcp connect\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'NOT CONFIGURED');
    assertIncludes(out, 'The bridge is a separate program you provide');
    assertIncludes(out, 'Noema automates nothing itself');
  });

  await test('MCP: configured, it connects and grants NOTHING on its own', async () => {
    const { cwd, configDir } = probot({ mcp: { command: [process.execPath, BRIDGE] } });
    const r = await runCli([], {
      cwd, configDir,
      stdinSteps: ['/mcp connect\n', '/mcp\n', '/exit\n'],
      stepDelayMs: 1200,
      script: [],
      timeoutMs: 40000,
    });
    const out = plain(r.out);
    assertIncludes(out, '✓ CONNECTED');
    assertIncludes(out, 'stub-bridge');
    assertIncludes(out, 'nothing is permitted yet');
    // Every capability must read as NOT granted.
    for (const cap of ['Screen', 'Keyboard', 'Mouse', 'Window']) {
      assert.match(out, new RegExp(`${cap}\\s+— not granted`), `${cap} must not be granted by connecting`);
    }
  });

  await test('MCP: the model is offered the machine tool only when a bridge exists', async () => {
    // THE PROPERTY IS UNCHANGED; ONLY THE NAME IS. This asserted that a tool
    // called `desktop` appeared with a bridge and not without one. `desktop` was
    // a SECOND name for operations `computer` already performed — the duplicate
    // vocabulary the design forbids — so it was removed and its name is now checked for
    // by its absence. The gate it was testing is still the gate: nothing that
    // touches the screen, mouse or keyboard is put in front of the model until a
    // transport is actually connected, so the model cannot even try.
    const without = probot({});
    const a = await runCli([], { cwd: without.cwd, configDir: without.configDir, stdin: '/tools\n/exit\n', script: [], timeoutMs: 30000 });
    const noBridge = plain(a.out);
    assert.ok(!/\bcomputer\b/.test(noBridge), 'no bridge, no machine tool — the model cannot even try');
    assert.ok(!/\bdesktop\b/.test(noBridge), 'the retired second vocabulary must not come back');

    const with_ = probot({ mcp: { command: [process.execPath, BRIDGE] } });
    const b = await runCli([], { cwd: with_.cwd, configDir: with_.configDir, stdin: '/tools\n/exit\n', script: [], timeoutMs: 30000 });
    const bridged = plain(b.out);
    assertIncludes(bridged, 'computer', 'with a bridge configured it is offered');
    assert.ok(!/\bdesktop\b/.test(bridged), 'and a bridge must not introduce a name of its own');
    // ONE tool speaks for the machine, not two rows meaning the same thing.
    const rows = bridged.split('\n').filter((l) => /^\s*computer\s+\S/.test(l)).length;
    assert.strictEqual(rows, 1, 'exactly one tool speaks for the machine');
  });

  // ----------------------------------------------------------------- copy ---

  await test('COPY: every named section copies, or says why it cannot', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'summarise the dashboard\n'
        + '/copy last\n/copy activity\n/copy task\n/copy audit\n/copy health\n/copy rc\n/copy context\n/copy diff\n/copy troubleshoot\n/exit\n',
      script: [{ text: 'The dashboard swallows two exceptions.' }],
      timeoutMs: 90000,
    });
    const out = plain(r.out);
    for (const name of ['last', 'activity', 'task', 'audit', 'health', 'rc', 'context']) {
      assert.match(out, new RegExp(`copied ${name}|wrote \\d+ line\\(s\\)`), `/copy ${name} produced nothing`);
    }
    // The two with genuinely nothing in them must SAY so rather than copy air.
    assert.match(out, /diff: nothing to copy yet/);
    assert.match(out, /troubleshoot: nothing to copy yet/);
    assert.strictEqual(r.code, 0);
  });

  // ---------------------------------------------------------------- title ---

  await test('TITLE: the tab names the project, from the real binary', async () => {
    const dir = tmpdir('scalpbot-');
    const r = await runCli([], { cwd: dir, env: { LAIN_FORCE_TUI: '1', COLUMNS: '96', LINES: '30' }, stdin: '/exit\n', script: [] });
    const titles = [...r.out.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(titles.length, 'the binary must emit the OSC sequence');
    const folder = path.basename(dir);
    assert.ok(titles.some((x) => x === folder),
      `expected the idle project title "${folder}", saw ${JSON.stringify(titles)}`);
  });

  // --------------------------------------------------------------- resume ---

  await test('RESUME: it restores conclusions, and says what was NOT there', async () => {
    const { cwd, configDir } = probot({});
    const first = await runCli([], {
      cwd, configDir,
      stdin: 'fix the dropped errors\n/exit\n',
      script: [{ text: 'Checking.', tool_calls: [{ name: 'run_bash', input: { command: 'echo checked' } }] }, { text: 'Done.' }],
      timeoutMs: 40000,
    });
    const id = (/--resume (\S+)/.exec(first.out) || [])[1];
    assert.ok(id, 'the session must offer a resume token');
    const second = await runCli([], { cwd, configDir, stdin: `/resume ${id}\n/exit\n`, script: [], timeoutMs: 30000 });
    const out = plain(second.out);
    assertIncludes(out, 'RESUMING SESSION');
    assertIncludes(out, 'objective: fix the dropped errors');
    assertIncludes(out, 'last check: echo checked');
    // What was never there must read as absent, not as restored.
    assertIncludes(out, 'no corrections recorded');
    assertIncludes(out, 'desktop permission: nothing granted');
  });
};
