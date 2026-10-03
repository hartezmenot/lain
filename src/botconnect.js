'use strict';

/** MESSAGING CONNECTIONS FOR LAIN DESKTOP — a projection and a setup flow over authorities that already exist. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED', AUTH_REQUIRED: 'AUTH_REQUIRED', FAILED: 'FAILED',
});
const STATUS = Object.freeze({
  CONFIGURED: 'CONFIGURED', CONNECTING: 'CONNECTING', LISTENING: 'LISTENING', OPERATIONAL: 'OPERATIONAL',
  DEGRADED: 'DEGRADED', ERROR: 'ERROR', DISCONNECTED: 'DISCONNECTED',
});
/** The window's older five, derived — never decided separately. */
function legacyState(status, authFailed) {
  if (authFailed) return STATE.AUTH_REQUIRED;
  if (status === STATUS.LISTENING || status === STATUS.OPERATIONAL || status === STATUS.DEGRADED) return STATE.CONNECTED;
  if (status === STATUS.CONNECTING) return STATE.CONNECTING;
  if (status === STATUS.ERROR) return STATE.FAILED;
  return STATE.NOT_CONNECTED;
}
const PLATFORMS = ['telegram', 'discord', 'whatsapp'];
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{25,80}$/;

function root(app) { return (app && app._sibling) || app; }

function settings(app, platform) {
  const cfg = root(app).cfg;
  return (cfg.bot && cfg.bot.platforms && cfg.bot.platforms[platform]) || null;
}

function ensureSettings(app, platform) {
  const cfg = root(app).cfg;
  cfg.bot = cfg.bot || {};
  cfg.bot.platforms = cfg.bot.platforms || {};
  cfg.bot.platforms[platform] = cfg.bot.platforms[platform] || { enabled: false, accountId: 'default' };
  return cfg.bot.platforms[platform];
}

function saveConfig(app) {
  try { require('./config').save(root(app).cfg); return true; } catch { return false; }
}

async function rpc(msg, { start = false, timeoutMs = 8000 } = {}) {
  const sup = require('./supervisor');
  try {
    const r = start ? await sup.call(msg, { timeoutMs }) : await sup.callIfRunning(msg, { timeoutMs });
    return r || null;
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

/** TESTS ONLY: a fake runtime in place of the supervisor. */
let rpcFn = rpc;
function useRpc(fn) { rpcFn = fn || rpc; }

/** The gateway this Core owns, or what an external `lain --bot` reports. */
async function service(app) {
  const own = root(app)._botService;
  if (own && !own.stopped) return { running: true, owner: 'core', status: own.gateway.status(), gateway: own.gateway };
  let ext = null;
  try { ext = await require('./bot/service').control('status'); } catch { ext = null; }
  if (ext && ext.ok) return { running: true, owner: 'external', status: ext, gateway: null };
  return { running: false, owner: null, status: null, gateway: null };
}

function transportFile() { return path.join(require('./config').configDir(), 'bot', 'transport.json'); }

/** Candidates recorded by whichever gateway ran — read from the one store file. */
function candidates(app, platform = 'telegram') {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(transportFile(), 'utf8')); } catch { data = null; }
  const allowed = new Set(((settings(app, platform) || {}).allowUsers || []).map(String));
  return Object.values((data && data.candidates) || {})
    .filter((c) => c && c.platform === platform && !allowed.has(String(c.senderId)))
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((c) => ({ senderId: String(c.senderId), chatId: String(c.chatId), firstAt: c.firstAt, lastAt: c.lastAt, count: c.count }));
}

function adapterRow(svc, platform) {
  const rows = (svc.status && svc.status.platforms) || [];
  return rows.find((p) => p.platform === platform) || null;
}

async function telegram(app, { check = false } = {}) {
  const s = settings(app, 'telegram') || {};
  const svc = await service(app);
  const tg = await rpcFn({ op: check ? 'remote_gateway_check' : 'remote_gateway_status' }, { start: true, timeoutMs: check ? 25000 : 4000 });
  const snap = await rpcFn({ op: 'remote_status' }, { start: false });
  const remote = (snap && snap.ok && snap.remote) || {};
  const supervisorOk = Boolean(tg && tg.ok);
  const configured = supervisorOk && Boolean(tg.configured);
  const row = adapterRow(svc, 'telegram');
  const connecting = Boolean(root(app)._botConnecting);
  const trace = require('./bot/trace').summary(require('./bot/trace').read(), 'telegram', s.accountId || 'default');
  const attachedAt = trace.lastAttach ? trace.lastAttach.at : 0;
  const leased = Boolean(tg && tg.attached);
  const authFailed = Boolean(configured && check && tg.authFailed);
  let status = STATUS.DISCONNECTED;
  let summary = s.disconnectedAt ? 'Disconnected. LAIN no longer holds a Telegram credential.' : 'No Telegram bot is connected.';
  if (connecting) { status = STATUS.CONNECTING; summary = 'Checking the token with Telegram…'; }
  else if (!supervisorOk) { status = STATUS.ERROR; summary = `LAIN's runtime did not answer: ${(tg && tg.error) || 'no supervisor'}`; }
  else if (authFailed) { status = STATUS.ERROR; summary = 'Telegram rejected the stored token — reconnect with a new one.'; }
  else if (configured && row && row.state === 'unavailable') { status = STATUS.ERROR; summary = row.reason || 'the Telegram adapter could not start'; }
  else if (configured && row && row.state === 'degraded') { status = STATUS.DEGRADED; summary = (trace.lastAdapter && trace.lastAdapter.why) || 'the last poll failed; retrying'; }
  else if (configured && row && row.state === 'listening' && (leased || svc.owner === 'external')) {
    const trip = trace.lastRoundTrip && trace.lastRoundTrip.at >= attachedAt ? trace.lastRoundTrip : null;
    const lastOut = trace.lastOutbound && trace.lastOutbound.at >= attachedAt ? trace.lastOutbound : null;
    if (lastOut && !lastOut.ok) { status = STATUS.DEGRADED; summary = `the last reply was not confirmed: ${lastOut.why || 'unknown'}`; }
    else if (trip) { status = STATUS.OPERATIONAL; summary = 'Operational — a message came in and its reply was delivered.'; }
    else { status = STATUS.LISTENING; summary = 'Listening. No message has made a full round trip since it started — send the bot a message.'; }
  }
  else if (configured && row && row.state === 'listening') { status = STATUS.DEGRADED; summary = 'The adapter thinks it is listening, but the runtime says no one holds its mailbox.'; }
  else if (configured && !s.enabled) { status = STATUS.CONFIGURED; summary = 'A bot is set up but not enabled in LAIN\'s messaging settings — nothing is reading its messages.'; }
  else if (configured && !svc.running) { status = STATUS.CONFIGURED; summary = 'A bot is set up, but messaging is not running — messages wait at Telegram. Start messaging.'; }
  else if (configured) { status = STATUS.CONNECTING; summary = 'Messaging is starting.'; }
  const state = legacyState(status, authFailed);
  return {
    platform: 'telegram',
    supported: true,
    setup: 'harness',
    state,
    status,
    summary,
    diagnostics: {
      identity: configured ? { username: remote.bot_username || null, name: remote.bot_name || null, botId: tg.botId || null } : null,
      transport: 'Telegram long polling, by LAIN\'s runtime (supervisor) into a leased mailbox the gateway drains',
      runtime: supervisorOk ? { link: tg.link || null, leased, mailboxDepth: Number(tg.mailboxDepth) || 0, lastOkAt: tg.lastOkAt || null } : null,
      gateway: { running: svc.running, owner: svc.owner, adapter: row ? row.state : null },
      resume: root(app)._botResume || null,
      lastInbound: trace.lastInbound, lastAuthorize: trace.lastAuthorize, lastDispatch: trace.lastDispatch,
      lastModel: trace.lastModel, lastOutbound: trace.lastOutbound, lastError: trace.lastError,
      lastRoundTrip: trace.lastRoundTrip, lastMessage: trace.lastMessage,
    },
    disconnectedAt: s.disconnectedAt || null,
    configured,
    enabled: Boolean(s.enabled),
    running: Boolean(svc.running && row),
    service: svc.owner,
    identity: configured ? { username: remote.bot_username || null, name: remote.bot_name || null, botId: tg.botId || null } : null,
    allowedUsers: (s.allowUsers || []).map(String),
    allowedCount: (s.allowUsers || []).length + (Number(remote.authorized_chats) || 0),
    pairedChats: Number(remote.authorized_chats) || 0,
    candidates: configured ? candidates(app, 'telegram') : [],
    authenticated: check ? Boolean(tg && tg.authenticated) : null,
    restartRequired: Boolean(tg && !tg.ok && /unknown op/i.test(String(tg.error || ''))),
  };
}

/** Discord and WhatsApp: Astra's adapters, configured by environment variables. */
async function envPlatform(app, platform, report) {
  const svc = await service(app);
  const d = (report && report.platforms || []).find((p) => p.platform === platform) || {};
  const row = adapterRow(svc, platform);
  let state = STATE.NOT_CONNECTED;
  let summary = d.configured ? 'Configured; messaging is not running.' : 'Not configured.';
  if (d.connected || (row && row.state === 'listening')) { state = STATE.CONNECTED; summary = 'Connected.'; }
  else if (row && (row.state === 'unavailable' || row.state === 'degraded')) { state = STATE.FAILED; summary = row.reason || `the ${platform} adapter is ${row.state}`; }
  const s = settings(app, platform) || {};
  return {
    platform,
    supported: true,
    // HONEST ABOUT SETUP: these adapters read their secrets from environment variables named in config.
    setup: 'environment',
    state,
    summary,
    configured: Boolean(d.configured),
    enabled: Boolean(s.enabled),
    running: Boolean(svc.running && row),
    service: svc.owner,
    identity: null,
    allowedUsers: (s.allowUsers || []).map(String),
    allowedCount: (s.allowUsers || []).length,
    checks: (d.checks || []).map(([name, value]) => ({ name, value })),
    requires: platform === 'discord'
      ? { env: [s.tokenEnv || 'LAIN_DISCORD_TOKEN'], node: '>=22', config: ['allowUsers', 'allowGuilds', 'allowChannels'] }
      : { env: [s.tokenEnv || 'LAIN_WHATSAPP_TOKEN', s.appSecretEnv || 'LAIN_WHATSAPP_APP_SECRET', s.verifyTokenEnv || 'LAIN_WHATSAPP_VERIFY_TOKEN'], config: ['phoneNumberId', 'apiVersion', 'allowUsers', 'port'] },
    docs: 'docs/BOT.md',
  };
}

async function connections(app, { check = false } = {}) {
  let report = null;
  try { report = await require('./bot/doctor').inspect({ cfg: root(app).cfg }); } catch { report = null; }
  const svc = await service(app);
  return {
    service: { running: svc.running, owner: svc.owner, state: svc.status ? svc.status.state : 'stopped' },
    platforms: [
      await telegram(app, { check }),
      await envPlatform(app, 'discord', report),
      await envPlatform(app, 'whatsapp', report),
    ],
  };
}

// ------------------------------------------------------------ actions --

async function startService(app) {
  const r = root(app);
  const svc = await service(app);
  if (svc.running) return { ok: true, owner: svc.owner, already: true };
  try {
    // `_botRuntimeFactory`: tests put a fake conversation runtime here; nothing else sets it.
    r._botService = await require('./bot/service').start({ cfg: r.cfg, cwd: require('./sessionviews').unattachedDir(), runtimeFactory: r._botRuntimeFactory || undefined });
    r._botService.startedAt = Date.now();
    return { ok: true, owner: 'core' };
  } catch (e) {
    return { ok: false, why: `messaging could not start: ${require('./redact').text(String((e && e.message) || e)).slice(0, 200)}` };
  }
}

async function stopService(app) {
  const r = root(app);
  if (r._botService && !r._botService.stopped) {
    await r._botService.stop();
    r._botService = null;
    return { ok: true };
  }
  const svc = await service(app);
  if (svc.owner === 'external') return { ok: false, why: 'messaging is running in another LAIN process (lain --bot); stop it there' };
  return { ok: true, already: true };
}

/** AT LAUNCH: bring back the messaging a person connected. */
async function resume(app) {
  const r = root(app);
  const enabled = PLATFORMS.filter((p) => (settings(app, p) || {}).enabled);
  if (!enabled.length) { r._botResume = { at: Date.now(), started: false, why: 'no messaging channel is enabled' }; return r._botResume; }
  let why = '';
  if (enabled.includes('telegram')) {
    const tg = await rpcFn({ op: 'remote_gateway_status' }, { start: true, timeoutMs: 8000 });
    if (!tg || !tg.ok) why = `LAIN's runtime did not answer: ${(tg && tg.error) || 'no supervisor'}`;
    else if (!tg.configured && enabled.length === 1) why = 'Telegram is enabled but the runtime holds no bot credential — reconnect it';
  }
  if (why) { r._botResume = { at: Date.now(), started: false, why }; return r._botResume; }
  const started = await startService(app);
  r._botResume = { at: Date.now(), started: Boolean(started.ok && !started.already), owner: started.owner || null, why: started.ok ? (started.already ? 'already running' : '') : started.why };
  return r._botResume;
}

/** SEND TEST: one message, to one approved person, through the same delivery path a reply takes — and its outbound receipt, so the round trip's second… */
async function sendTest(app, { to } = {}) {
  const s = settings(app, 'telegram') || {};
  const allowed = (s.allowUsers || []).map(String);
  const target = String(to || allowed[0] || '');
  if (!target) return { ok: false, why: 'approve someone first — a test message only goes to an approved person' };
  if (!allowed.includes(target)) return { ok: false, why: 'a test message only goes to an approved person' };
  const own = root(app)._botService;
  if (!own || own.stopped) {
    const svc = await service(app);
    return { ok: false, why: svc.owner === 'external' ? 'messaging is running in another LAIN process (lain --bot); send the test from there' : 'messaging is not running — start it first' };
  }
  const gw = own.gateway;
  const accountId = s.accountId || 'default';
  const id = `t-${crypto.randomBytes(5).toString('hex')}`;
  const e = { platform: 'telegram', accountId, chatId: target, senderId: target, kind: 'dm', threadId: '', replyTo: '', timestamp: Date.now() };
  gw.trace.note('dispatch', { id, platform: 'telegram', accountId, test: true });
  let rows;
  try { rows = await gw.delivery.sendMessage(e, 'LAIN test message — the channel can reach you. (No reply needed.)', { id: `test:${id}`, kind: 'notice' }); }
  catch (err) { gw.trace.note('outbound', { id, platform: 'telegram', accountId, ok: false, why: String((err && err.message) || err), test: true }); return { ok: false, why: `not sent: ${(err && err.message) || err}`, receipt: id }; }
  const bad = (rows || []).find((x) => x.state !== 'delivered');
  gw.trace.note('outbound', bad ? { id, platform: 'telegram', accountId, ok: false, why: `test ${bad.state}`, test: true } : { id, platform: 'telegram', accountId, test: true });
  return bad ? { ok: false, why: `Telegram did not confirm the test (${bad.state})`, receipt: id } : { ok: true, receipt: id };
}

/** The Telegram token passes through; it is never stored here or returned. */
async function connectTelegram(app, token) {
  const r = root(app);
  const t = String(token || '').trim();
  if (!TOKEN_RE.test(t)) return { ok: false, why: 'that does not look like a Telegram bot token (123456789:ABC…) — copy it from @BotFather' };
  require('./redact').register(t);
  const before = await rpcFn({ op: 'remote_gateway_status' }, { start: true, timeoutMs: 8000 });
  if (!before || !before.ok) {
    return { ok: false, why: /unknown op/i.test(String(before && before.error)) ? 'LAIN\'s runtime is older than messaging support — restart it when its work can stop' : `LAIN's runtime did not answer: ${(before && before.error) || 'no supervisor'}` };
  }
  if (before.configured) return { ok: false, why: 'a Telegram bot is already connected — disconnect it first to use a different one' };
  if (r._botConnecting) return { ok: false, why: 'a connection is already being checked' };
  r._botConnecting = true;
  try {
    const owner = crypto.randomBytes(24).toString('hex');
    const attached = await rpcFn({ op: 'remote_gateway_attach', owner, token: t }, { start: true, timeoutMs: 30000 });
    // THE LEASE IS RELEASED AT ONCE: the gateway below attaches with its own owner.
    await rpcFn({ op: 'remote_gateway_detach', owner }, { start: false });
    if (!attached || !attached.ok) {
      return { ok: false, why: (attached && attached.error) === 'Telegram credential could not be verified' ? 'Telegram did not accept that token' : `the token could not be connected: ${(attached && attached.error) || 'no answer'}` };
    }
    const s = ensureSettings(app, 'telegram');
    s.enabled = true;
    delete s.disconnectedAt;
    s.accountId = s.accountId || 'default';
    if (!Array.isArray(s.allowUsers)) s.allowUsers = [];
    if (!saveConfig(app)) return { ok: false, why: 'the bot was verified, but LAIN could not save its messaging settings' };
    const running = await service(app);
    let started = { ok: true, owner: running.owner };
    if (running.owner === 'core') {
      await stopService(app);
      started = await startService(app);
    } else if (!running.running) {
      started = await startService(app);
    }
    return { ok: true, started, telegram: await telegram(app) };
  } finally {
    r._botConnecting = false;
  }
}

function approveTelegram(app, senderId) {
  const id = String(senderId || '').trim();
  if (!/^\d{1,20}$/.test(id)) return { ok: false, why: 'a Telegram user ID is a number' };
  if (!candidates(app, 'telegram').some((c) => c.senderId === id)) {
    return { ok: false, why: 'approve an ID that messaged the bot — that is how LAIN knows the account is real' };
  }
  const s = ensureSettings(app, 'telegram');
  // IN PLACE: the running gateway holds this very object as its adapter settings.
  if (!Array.isArray(s.allowUsers)) s.allowUsers = [];
  if (!s.allowUsers.map(String).includes(id)) s.allowUsers.push(id);
  if (!saveConfig(app)) return { ok: false, why: 'LAIN could not save the approval' };
  const own = root(app)._botService;
  try { if (own && own.gateway) own.gateway.store.dropCandidate('telegram', s.accountId || 'default', id); } catch { /* the filter hides it anyway */ }
  return { ok: true, allowedUsers: s.allowUsers.map(String) };
}

function revokeTelegram(app, senderId) {
  const id = String(senderId || '').trim();
  const s = settings(app, 'telegram');
  if (!s || !Array.isArray(s.allowUsers)) return { ok: true, allowedUsers: [] };
  for (let i = s.allowUsers.length - 1; i >= 0; i--) if (String(s.allowUsers[i]) === id) s.allowUsers.splice(i, 1);
  if (!saveConfig(app)) return { ok: false, why: 'LAIN could not save the change' };
  return { ok: true, allowedUsers: s.allowUsers.map(String) };
}

/** GONE MEANS GONE — as far as LAIN can make it */
async function disconnectTelegram(app) {
  const svc = await service(app);
  if (svc.owner === 'external') return { ok: false, why: 'messaging is running in another LAIN process (lain --bot); stop it there first' };
  if (svc.owner === 'core') await stopService(app);
  const r = await rpcFn({ op: 'remote_disconnect' }, { start: true });
  if (!r || !r.ok) return { ok: false, why: `the runtime did not remove the credential: ${(r && r.error) || 'no answer'}` };
  const s = ensureSettings(app, 'telegram');
  s.enabled = false;
  s.allowUsers = [];
  s.disconnectedAt = new Date().toISOString();
  saveConfig(app);
  dropCandidates('telegram');
  try { new (require('./bot/trace').Trace)().note('adapter', { platform: 'telegram', accountId: s.accountId || 'default', ok: true, why: 'disconnected by the owner' }); } catch { /* receipts are best effort */ }
  const others = PLATFORMS.filter((p) => p !== 'telegram' && (settings(app, p) || {}).enabled);
  if (others.length) await startService(app);
  return {
    ok: true, removed: Boolean(r.removed),
    notRevoked: 'The token is still valid at Telegram. To revoke it, send /revoke to @BotFather.',
    telegram: await telegram(app),
  };
}

function dropCandidates(platform) {
  try {
    const f = transportFile();
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!data.candidates) return;
    for (const [k, c] of Object.entries(data.candidates)) if (c && c.platform === platform) delete data.candidates[k];
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  } catch { /* no store yet */ }
}

module.exports = {
  STATE, STATUS, PLATFORMS, TOKEN_RE, legacyState,
  connections, telegram, candidates, service, startService, stopService, resume, sendTest,
  connectTelegram, approveTelegram, revokeTelegram, disconnectTelegram, useRpc,
};
