'use strict';

/**
 * THE CHAT SOURCES, THE DASHBOARD AND THE DESKTOP SEAM — through the real binary.
 *
 * A unit test proves a function returns the right thing; only this proves the
 * thing reaches a user. Everything here spawns bin/lain.js and asserts on what
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

  await test('SOURCE: the real binary answers /source, and defaults to LAIN', async () => {
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
    assertIncludes(out, 'LAIN');
    // THE WEBSITE SOURCES WERE RETIRED (Phase 8.1): not listed, and nothing on screen points at them.
    assert.ok(!/ChatGPT\.com|Gemini\.google\.com|\/source chatgpt/.test(out), 'a retired website source is neither listed nor suggested');
    assertIncludes(out, "coding request always runs on LAIN's runtime");
  });

  await test('SOURCE: a retired website source is refused, says what to use instead, and chat stays LAIN', async () => {
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
    assert.match(out, /●\s+LAIN/, 'chat is still LAIN');
  });

  // ----------------------------------------------------------------- dash ---
  await test('MCP: unconfigured, /mcp says NOT CONFIGURED and starts nothing', async () => {
    const { cwd, configDir } = probot({});
    const r = await runCli([], { cwd, configDir, stdin: '/mcp\n/mcp connect\n/exit\n', script: [], timeoutMs: 30000 });
    const out = plain(r.out);
    assertIncludes(out, 'NOT CONFIGURED');
    assertIncludes(out, 'The bridge is a separate program you provide');
    assertIncludes(out, 'LAIN automates nothing itself');
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
