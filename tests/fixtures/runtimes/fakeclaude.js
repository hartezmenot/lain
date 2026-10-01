'use strict';

/**
 * A FAKE `claude` for tests — the documented surface LAIN uses:
 *   --version · auth status (JSON) · auth login · auth logout · -p --output-format stream-json
 *
 * IT KEEPS ITS STATE WHERE THE REAL ONE DOES — in its configuration directory:
 *   CLAUDE_CONFIG_DIR/.credentials.json    written by a completed login, read by `auth status`
 *   CLAUDE_CONFIG_DIR/fake-login.json      what the NEXT login signs in as (the test writes it —
 *                                          standing in for the person in the browser)
 *   CLAUDE_CONFIG_DIR/runs.jsonl           one line per `-p` run (which directory it ran in)
 *   CLAUDE_CONFIG_DIR/release              a prompt containing HOLD waits for this file to appear
 *
 * WITH NO CLAUDE_CONFIG_DIR it acts on the DEFAULT profile (FAKE_CLAUDE_HOME — never the real
 * ~/.claude), and it says so in FAKE_CLAUDE_LOG. That is how a test detects the failure this
 * fake exists for: an "Add account" that logs in against, or logs out of, another account's directory.
 *
 * It records every invocation as {argv, cfg, pid} (FAKE_CLAUDE_LOG) and its argv (FAKE_CLAUDE_ARGS).
 * A prompt containing SLOW streams slowly; HOLD stays running until released; FAIL ends in an error.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const CFG = process.env.CLAUDE_CONFIG_DIR || null;
const HOME = CFG || process.env.FAKE_CLAUDE_HOME || null;   // where THIS invocation reads and writes its state
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, `${JSON.stringify(argv)}\n`);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cfg: CFG, acts_on: HOME, pid: process.pid, at: Date.now() })}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const credFile = () => (HOME ? path.join(HOME, '.credentials.json') : null);
const readCred = () => { try { return JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch { return null; } };
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }

if (argv[0] === 'auth' && argv[1] === 'status') {
  // A CONFIG DIRECTORY IS AN ACCOUNT: signed in exactly when its own credentials exist. (No directory and no
  // FAKE_CLAUDE_HOME is the legacy fixed person the older tests expect.)
  if (HOME) {
    const c = readCred();
    process.stdout.write(JSON.stringify(c ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: c.email, orgName: 'Org', subscriptionType: c.subscriptionType || 'pro' } : { loggedIn: false }, null, 2));
  } else {
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.com', orgName: 'Org', subscriptionType: 'pro' }, null, 2));
  }
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  (async () => {
    if (!HOME) { process.stderr.write('no configuration directory\n'); process.exit(3); }
    fs.mkdirSync(HOME, { recursive: true });
    process.stdout.write(`Opening your browser to sign in.\nIf it does not open, visit: https://claude.ai/oauth/authorize?state=${process.pid}\n`);
    // THE PERSON, IN THE BROWSER: a login completes when they have said who they are (in THIS directory).
    for (let i = 0; i < 600; i++) {
      const who = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'fake-login.json'), 'utf8')); } catch { return null; } })();
      if (who) {
        fs.writeFileSync(credFile(), JSON.stringify({ fake: true, ...who }));
        process.stdout.write('Login successful.\n');
        process.exit(0);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    process.stderr.write('login timed out\n');
    process.exit(1);
  })();
} else if (argv[0] === 'auth' && argv[1] === 'logout') {
  if (HOME) { try { fs.unlinkSync(credFile()); } catch { /* not signed in */ } }
  process.stdout.write('Logged out.\n');
  process.exit(0);
} else if (argv[0] === '-p') {
  let prompt = '';
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', async () => {
    // THE SDK CONTROL PROTOCOL (claudecontrol.js): a session that sends ONLY control requests generates nothing. It is
    // answered from this profile's files — fake-models.json (the catalog) and fake-limits.json (0–1 used) — and logged
    // to controls.jsonl so a test can prove no prompt ran.
    const lines = prompt.split('\n').map((l) => l.trim()).filter(Boolean);
    const reqs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    if (argv.includes('--input-format') && reqs.length && reqs.every((r) => r && r.type === 'control_request')) {
      const where = CFG || HOME;
      const cred = readCred();
      const signed = CFG ? Boolean(cred) : true;
      const who = CFG ? (cred || {}) : { email: 'person@example.com', subscriptionType: 'pro' };
      const models = (() => { try { return JSON.parse(fs.readFileSync(path.join(where, 'fake-models.json'), 'utf8')); } catch { return null; } })()
        || [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }, { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] }, { value: 'haiku', displayName: 'Haiku' }, { value: 'fable', displayName: 'Fable', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }];
      const fl = (() => { try { return JSON.parse(fs.readFileSync(path.join(where, 'fake-limits.json'), 'utf8')); } catch { return null; } })() || { fiveHour: 0.25, sevenDay: 0.6 };
      if (where) { try { fs.appendFileSync(path.join(where, 'controls.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), subtypes: reqs.map((r) => r.request && r.request.subtype) })}\n`); } catch { /* best effort */ } }
      for (const r of reqs) {
        const sub = r.request && r.request.subtype;
        if (sub === 'initialize') out({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response: { models, account: signed ? { email: who.email, organization: 'Org', subscriptionType: who.subscriptionType || 'pro', apiProvider: 'firstParty' } : {} } } });
        else if (sub === 'get_usage') {
          // A SIGN-IN ANTHROPIC REFUSES (a migrated token marked "not-accepted"): Claude Code's own answer, verbatim-shaped.
          const refused = signed && cred && cred.claudeAiOauth && /not-accepted/.test(String(cred.claudeAiOauth.accessToken || ''));
          if (!signed) out({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: 'Not logged in' } });
          else if (refused) out({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: 'Anthropic refused this sign-in' } });
          else out({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response: { rate_limits_available: true, subscription_type: who.subscriptionType || 'pro', rate_limits: { five_hour: { utilization: Math.round(fl.fiveHour * 100), resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: Math.round(fl.sevenDay * 100), resets_at: new Date(Date.now() + 86400_000).toISOString() }, seven_day_opus: null, model_scoped: [] } } } });
        } else out({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: `unknown subtype ${sub}` } });
      }
      process.exit(0);
    }
    if (CFG && !readCred()) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in. Run claude auth login.' }); process.exit(1); }
    // A LIMITED ACCOUNT (limited.json in ITS directory): the provider's own words, with a stated reset.
    if (CFG && exists(path.join(CFG, 'limited.json'))) { fs.appendFileSync(path.join(CFG, 'runs.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), as: (readCred() || {}).email || null, limited: true })}
`); out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit. Try again in 60 minutes." }); process.exit(1); }
    if (CFG) fs.appendFileSync(path.join(CFG, 'runs.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), as: (readCred() || {}).email || null })}\n`);
    const model = argv[argv.indexOf('--model') + 1] || 'default';
    out({ type: 'system', subtype: 'init', session_id: 'S1', tools: [] });
    out({ type: 'stream_event', event: { type: 'message_start', message: { model: `claude-${model}-fake-1` } } });
    const text = /SLOW/.test(prompt) ? Array.from({ length: 100 }, (_, i) => `w${i} `).join('') : `Echo: ${prompt.trim().split('\n').pop().slice(0, 60)}${CFG ? ` [as ${(readCred() || {}).email}]` : ''}`;
    const agent = argv.includes('--permission-mode');
    if (agent) out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.js' } }] } });
    for (const c of /SLOW/.test(prompt) ? text.match(/.{1,6}/g) : [text]) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: c } } });
      // eslint-disable-next-line no-await-in-loop
      if (/SLOW/.test(prompt)) await sleep(40);
    }
    // A LONG RUN: stays alive until the test releases it — and then still answers as the account it started as.
    if (/HOLD/.test(prompt) && CFG) {
      const before = JSON.stringify(readCred());
      for (let i = 0; i < 1200 && !exists(path.join(CFG, 'release')); i++) await sleep(50);   // eslint-disable-line no-await-in-loop
      if (JSON.stringify(readCred()) !== before) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'my account changed under me' }); process.exit(1); }
    }
    // THE ACCOUNT'S OWN WINDOWS (a test may give each config directory its own `fake-limits.json`: { fiveHour, sevenDay } as 0–1 used).
    const fl = (() => { try { return CFG ? JSON.parse(fs.readFileSync(path.join(CFG, 'fake-limits.json'), 'utf8')) : null; } catch { return null; } })() || { fiveHour: 0.25, sevenDay: 0.6 };
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: fl.fiveHour, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: fl.sevenDay, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } });
    if (/FAIL/.test(prompt)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model overloaded' }); process.exit(1); }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'S1', duration_ms: 50, num_turns: 1, total_cost_usd: 0.0123, stop_reason: 'end_turn',
      usage: { input_tokens: 11, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 22, output_tokens_details: { thinking_tokens: 5 } } });
    process.exit(0);
  });
} else { process.stderr.write('unknown\n'); process.exit(2); }
