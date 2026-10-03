'use strict';

/**
 * A FAKE ANTIGRAVITY ACP SERVER — the Agent Client Protocol subset LAIN speaks (JSON-RPC over stdio):
 * initialize · authenticate · session/new · session/set_model · session/prompt.
 *
 * STATE LIVES IN GEMINI_HOME, as the real one's does (with AGY_ACP_FORCE_FILE_STORAGE=1):
 *   oauth_creds.json       written by a completed sign-in
 *   google_accounts.json   { active: <email>, old: [] }
 *   fake-login.json        who the NEXT sign-in is (the test writes it — standing in for the person in the browser)
 *   runs.jsonl · limited.json · release      per-profile run log · "usage limit" switch · HOLD's release
 *
 * IT RECORDS what a test must be able to see (FAKE_AGY_LOG): the profile it acted on, whether file credential
 * storage was forced, whether ambient Google credentials leaked into its environment, and the BROWSER it was given.
 * With no GEMINI_HOME it acts on FAKE_AGY_DEFAULT_HOME (never the real ~/.gemini) and says so — a login against
 * the wrong directory is then a visible mutation.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.GEMINI_HOME || process.env.FAKE_AGY_DEFAULT_HOME || null;
const AMBIENT = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'].filter((k) => process.env[k]);
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ home: process.env.GEMINI_HOME || null, acts_on: HOME, forceFile: process.env.AGY_ACP_FORCE_FILE_STORAGE || null, browser: process.env.BROWSER || null, ambient: AMBIENT, pid: process.pid, at: Date.now() })}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(HOME, f), 'utf8')); } catch { return null; } };
const exists = (f) => { try { return fs.existsSync(path.join(HOME, f)); } catch { return false; } };
const signedIn = () => exists('oauth_creds.json') && Boolean((readJson('google_accounts.json') || {}).active);
const email = () => (readJson('google_accounts.json') || {}).active;

async function handle(m) {
  const reply = (result) => send({ id: m.id, result });
  const fail = (message, code = -32603) => send({ id: m.id, error: { code, message } });
  if (!HOME) return fail('no profile');
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'oauth-personal', name: 'Sign in with Google' }, { id: 'gemini-api-key', name: 'Gemini API key' }] });
    case 'authenticate': {
      if (signedIn()) return reply({});
      fs.mkdirSync(HOME, { recursive: true });
      const url = `https://accounts.google.com/o/oauth2/v2/auth?state=${process.pid}`;
      process.stdout.write(`Open the following link to authenticate the ACP server: ${url}\n`);
      // …and ask "a browser" to open it, as the real server does.
      if (process.env.BROWSER) { try { spawn(process.env.BROWSER, [url], { shell: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch { /* no browser */ } }
      for (let i = 0; i < 1200; i++) {
        const who = readJson('fake-login.json');
        if (who) {
          fs.writeFileSync(path.join(HOME, 'oauth_creds.json'), JSON.stringify({ fake: true }));
          fs.writeFileSync(path.join(HOME, 'google_accounts.json'), JSON.stringify({ active: who.email, old: [] }));
          return reply({});
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
      }
      return fail('authentication timed out', -32000);
    }
    case 'session/new':
      if (!signedIn()) return fail('authentication required', -32000);
      return reply({ sessionId: `s-${process.pid}`, models: { currentModelId: 'gemini-3.8-flash', availableModels: [{ modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { modelId: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }] } });
    case 'session/set_model': return reply({});
    case 'session/prompt': {
      if (!signedIn()) return fail('authentication required', -32000);
      fs.appendFileSync(path.join(HOME, 'runs.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), as: email() })}\n`);
      if (exists('limited.json')) return fail("You've hit your usage limit. Try again in 60 minutes.", -32000);
      const text = ((m.params.prompt || [])[0] || {}).text || '';
      if (/HOLD/.test(text)) { for (let i = 0; i < 1200 && !exists('release'); i++) await sleep(50); }   // eslint-disable-line no-await-in-loop
      send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answered by ${email()} (${path.basename(HOME)})` } } } });
      return reply({ stopReason: 'end_turn' });
    }
    default: return m.id !== undefined ? fail(`unknown method ${m.method}`, -32601) : undefined;
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { handle(JSON.parse(l)); } catch { /* junk */ } }
});
process.stdin.on('end', () => process.exit(0));
