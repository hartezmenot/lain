'use strict';

/**
 * A FAKE `codex app-server` — the protocol subset LAIN's Codex driver speaks,
 * over stdio, newline-delimited JSON. Started as `node fakeappserver.js
 * app-server` with CODEX_HOME set, like the real one.
 *
 * STATE LIVES IN CODEX_HOME, as the real one's does:
 *   auth.json            written by a completed login; read by account/read.
 *                        Fake shape: { fake: true, email, planType, accountId }
 *   fake-login.json      what the NEXT login signs in as (the test writes it —
 *                        standing in for the person in the browser)
 *   fake-limits.json     optional rate-limit windows to report
 *   sessions/<id>.json   native threads (in a shared home these are shared)
 *   fake-models.json     optional model/list rows (default: two models + a hidden one)
 *
 * `node fakeappserver.js exec --json ... -` is `codex exec`: it reads the prompt
 * from stdin, answers AS the account signed in to CODEX_HOME, prints Codex's
 * JSONL events, and appends what it was asked and how (argv, cwd) to
 * CODEX_HOME/fake-exec.jsonl — so a test can prove which account answered and
 * that the run was read-only, ephemeral and outside the project.
 *
 * No network, no real account, no quota.
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.CODEX_HOME;
const loaded = new Set();
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(HOME, f), 'utf8')); } catch { return null; } };
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
/**
 * THE REAL auth.json SHAPE TOO (a migrated sign-in, fabric/portable.js): `tokens.id_token` names the account like the
 * real Codex reads it — email, plan and account id from its claims. A token issued to another client is refused, as
 * OpenAI would; so is a sign-in with no refresh token past its expiry.
 */
function authOf(raw) {
  if (!raw || raw.fake || !raw.tokens) return raw;
  try {
    const c = JSON.parse(Buffer.from(String(raw.tokens.id_token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if ([].concat(c.aud || []).length && ![].concat(c.aud).includes('app_EMoamEEZ73f0CkXaXp7hrann')) return null;
    if (!raw.tokens.refresh_token && c.exp && c.exp * 1000 < Date.now()) return null;
    const a = c['https://api.openai.com/auth'] || {};
    return { email: c.email, planType: a.chatgpt_plan_type || 'plus', accountId: raw.tokens.account_id || a.chatgpt_account_id || null };
  } catch { return null; }
}

function handle(m) {
  const reply = (result) => out({ id: m.id, result });
  const fail = (message, code = -32600) => out({ id: m.id, error: { code, message } });
  const auth = authOf(read('auth.json'));
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'fake-codex/0', codexHome: HOME, platformFamily: 'windows', platformOs: 'windows' });
    case 'initialized': return undefined;
    case 'account/read':
      return reply(auth ? { account: { type: 'chatgpt', email: auth.email, planType: auth.planType }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true });
    case 'account/rateLimits/read': {
      if (!auth) return fail('codex account authentication required to read rate limits');
      const l = read('fake-limits.json') || { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 3 } };
      return reply({ accountId: auth.accountId, rateLimits: { limitId: 'codex', planType: auth.planType, ...l }, rateLimitsByLimitId: null, rateLimitResetCredits: null });
    }
    case 'account/login/start': {
      const loginId = `login-${Date.now()}`;
      reply(m.params && m.params.type === 'chatgptDeviceCode'
        ? { type: 'chatgptDeviceCode', loginId, userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' }
        : { type: 'chatgpt', loginId, authUrl: `https://auth.openai.com/oauth/authorize?state=${loginId}` });
      // THE PERSON FINISHES IN THEIR BROWSER: the test has said who they are.
      // (FAKE_CODEX_LOGIN_WAIT_MS: the browser step takes as long as the test needs — it keeps waiting for `fake-login.json`.)
      const waitUntil = Date.now() + (Number(process.env.FAKE_CODEX_LOGIN_WAIT_MS) || 0);
      const finish = () => {
        const who = read('fake-login.json');
        if (!who) {
          if (Date.now() < waitUntil) { setTimeout(finish, 60); return undefined; }
          return out({ method: 'account/login/completed', params: { loginId, success: false, error: 'cancelled' } });
        }
        fs.writeFileSync(path.join(HOME, 'auth.json'), JSON.stringify({ fake: true, ...who }));
        return out({ method: 'account/login/completed', params: { loginId, success: true } });
      };
      setTimeout(finish, 150);
      return undefined;
    }
    case 'model/list': {
      if (!auth) return fail('codex account authentication required');
      const rows = read('fake-models.json') || [
        { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
        { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, isDefault: false, supportedReasoningEfforts: [] },
        { id: 'internal-preview', model: 'internal-preview', displayName: 'Internal', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
      ];
      return reply({ data: rows, nextCursor: null });
    }
    case 'account/login/cancel': return reply({ status: 'canceled' });
    case 'account/logout':
      try { fs.unlinkSync(path.join(HOME, 'auth.json')); } catch { /* signed out */ }
      return reply({});
    case 'thread/list': {
      const dir = path.join(HOME, 'sessions');
      let rows = [];
      try { rows = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) })); } catch { rows = []; }
      return reply({ data: rows, nextCursor: null });
    }
    case 'thread/read': {
      const id = m.params && m.params.threadId;
      const f = path.join(HOME, 'sessions', `${id}.json`);
      if (!fs.existsSync(f)) return fail(`no rollout found for thread id ${id}`);
      const t = JSON.parse(fs.readFileSync(f, 'utf8'));
      return reply({ thread: { id, cwd: t.cwd || null, preview: t.preview || '', turns: t.turns || [] } });
    }
    case 'thread/loaded/list': return reply({ data: [...loaded] });
    case 'thread/resume': {
      const id = m.params && m.params.threadId;
      if (!fs.existsSync(path.join(HOME, 'sessions', `${id}.json`))) return fail(`no rollout found for thread id ${id}`);
      if (!auth) return fail('not signed in');
      loaded.add(id);
      return reply({ thread: { id } });
    }
    case 'thread/unsubscribe': {
      const id = m.params && m.params.threadId;
      const had = loaded.delete(id);
      return reply({ status: had ? 'unsubscribed' : 'notLoaded' });
    }
    default:
      if (m.id !== undefined) return fail(`unknown method ${m.method}`, -32601);
      return undefined;
  }
}

/** `codex exec --json … -`: one answer, as whoever is signed in to this home. */
function exec(argv) {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', () => {
    const auth = authOf(read('auth.json'));
    const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
    fs.appendFileSync(path.join(HOME, 'fake-exec.jsonl'), `${JSON.stringify({ argv, cwd: process.cwd(), home: HOME, prompt, as: auth ? auth.email : null })}\n`);
    out({ type: 'thread.started', thread_id: `fake-${Date.now()}` });
    out({ type: 'turn.started' });
    if (!auth) {
      out({ type: 'turn.failed', error: { message: 'Not signed in. Please run codex login.' } });
      process.exitCode = 1;
      return;
    }
    // A LIMITED ACCOUNT: the provider's own words for a usage limit, with a stated reset (fake-limited.json present).
    if (read('fake-limited.json')) {
      out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 60 minutes." } });
      process.exitCode = 1;
      return;
    }
    if (process.env.FAKE_CODEX_SLOW) { setTimeout(() => {}, 60000); return; }   // a turn someone will cancel
    const text = `answered by ${auth.email} (${auth.accountId}) on ${at('--model') || 'default'}`;
    out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: Math.max(1, Math.ceil(prompt.length / 4)), cached_input_tokens: 0, output_tokens: Math.ceil(text.length / 4) } });
  });
}
if (process.argv[2] === 'exec') { exec(process.argv.slice(3)); return; }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore junk */ }
  }
});
process.stdin.on('end', () => process.exit(0));
