'use strict';

/**
 * MESSAGING CONNECTIONS FOR LAIN DESKTOP — a projection and a setup flow over
 * authorities that already exist. NOT another Telegram client.
 *
 * ------------------------------------------------------------------------
 * WHO OWNS WHAT, and none of it moves here.
 *
 *   the Telegram credential   the Rust supervisor (remote.rs): proved against
 *                             `getMe` before it is stored, never returned by any op
 *   the Telegram poller       the Rust supervisor, in gateway mode
 *   the gateway / adapters    src/bot/gateway.js + src/bot/{telegram,discord,whatsapp}.js
 *   who may talk to the bot   `cfg.bot.platforms.<p>.allowUsers` (contract.authorized)
 *   Discord / WhatsApp keys   environment variables named in config (docs/BOT.md)
 *
 * ------------------------------------------------------------------------
 * THE TELEGRAM FLOW, with no CLI:
 *
 *   1. token typed into the window → `connectTelegram(token)` → the supervisor's
 *      `remote_gateway_attach` VERIFIES it against Telegram and stores it, and
 *      the lease is released at once. A rejected token stores nothing.
 *   2. the window is shown the bot's PUBLIC identity (@username, name) — never
 *      the token, which lives in this process only for the length of the call
 *      and is registered with redact.js first.
 *   3. config gains `telegram.enabled` (no secret), and the gateway starts in
 *      Core, so a `/start` reaches it.
 *   4. an unauthorized private `/start` is recorded as a CANDIDATE by the
 *      gateway (bot/store.js `candidate`) — sender ID, chat ID, when.
 *   5. the person approves that exact ID → it is added to `allowUsers`, in
 *      place, so the running gateway authorizes it on the next message.
 *
 * ------------------------------------------------------------------------
 * STATES are the five the window renders — NOT_CONNECTED, CONNECTING,
 * CONNECTED, AUTH_REQUIRED, FAILED — with `configured` and `running` beside
 * them, because "a bot is set up and messaging is not running" is its own fact.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED', AUTH_REQUIRED: 'AUTH_REQUIRED', FAILED: 'FAILED',
});
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
  const tg = await rpc({ op: check ? 'remote_gateway_check' : 'remote_gateway_status' }, { start: true, timeoutMs: check ? 25000 : 4000 });
  const snap = await rpc({ op: 'remote_status' }, { start: false });
  const remote = (snap && snap.ok && snap.remote) || {};
  const supervisorOk = Boolean(tg && tg.ok);
  const configured = supervisorOk && Boolean(tg.configured);
  const row = adapterRow(svc, 'telegram');
  const connecting = Boolean(root(app)._botConnecting);
  let state = STATE.NOT_CONNECTED;
  let summary = 'No Telegram bot is connected.';
  if (connecting) { state = STATE.CONNECTING; summary = 'Checking the token with Telegram…'; }
  else if (!supervisorOk) { state = STATE.FAILED; summary = `LAIN's runtime did not answer: ${(tg && tg.error) || 'no supervisor'}`; }
  else if (configured && check && tg.authFailed) { state = STATE.AUTH_REQUIRED; summary = 'Telegram rejected the stored token — reconnect with a new one.'; }
  else if (configured && row && row.state === 'listening') { state = STATE.CONNECTED; summary = 'Connected.'; }
  else if (configured && row && (row.state === 'unavailable' || row.state === 'degraded')) { state = STATE.FAILED; summary = row.reason || `the Telegram adapter is ${row.state}`; }
  else if (configured && !svc.running) { summary = 'A bot is set up; messaging is not running.'; }
  else if (configured && svc.running && !s.enabled) { summary = 'A bot is set up but not enabled in LAIN\'s messaging settings.'; }
  else if (configured) { state = STATE.CONNECTING; summary = 'Messaging is starting.'; }
  return {
    platform: 'telegram',
    supported: true,
    setup: 'harness',
    state,
    summary,
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
    // HONEST ABOUT SETUP: these adapters read their secrets from environment
    // variables named in config. The window shows what is missing; it does not
    // collect a Discord or WhatsApp secret, because no credential store exists
    // for them to go into.
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
    r._botService = await require('./bot/service').start({ cfg: r.cfg, cwd: require('./sessionviews').unattachedDir() });
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

/** The Telegram token passes through; it is never stored here or returned. */
async function connectTelegram(app, token) {
  const r = root(app);
  const t = String(token || '').trim();
  if (!TOKEN_RE.test(t)) return { ok: false, why: 'that does not look like a Telegram bot token (123456789:ABC…) — copy it from @BotFather' };
  require('./redact').register(t);
  const before = await rpc({ op: 'remote_gateway_status' }, { start: true, timeoutMs: 8000 });
  if (!before || !before.ok) {
    return { ok: false, why: /unknown op/i.test(String(before && before.error)) ? 'LAIN\'s runtime is older than messaging support — restart it when its work can stop' : `LAIN's runtime did not answer: ${(before && before.error) || 'no supervisor'}` };
  }
  if (before.configured) return { ok: false, why: 'a Telegram bot is already connected — disconnect it first to use a different one' };
  if (r._botConnecting) return { ok: false, why: 'a connection is already being checked' };
  r._botConnecting = true;
  try {
    const owner = crypto.randomBytes(24).toString('hex');
    const attached = await rpc({ op: 'remote_gateway_attach', owner, token: t }, { start: true, timeoutMs: 30000 });
    // THE LEASE IS RELEASED AT ONCE: the gateway below attaches with its own owner.
    await rpc({ op: 'remote_gateway_detach', owner }, { start: false });
    if (!attached || !attached.ok) {
      return { ok: false, why: (attached && attached.error) === 'Telegram credential could not be verified' ? 'Telegram did not accept that token' : `the token could not be connected: ${(attached && attached.error) || 'no answer'}` };
    }
    const s = ensureSettings(app, 'telegram');
    s.enabled = true;
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
    return { ok: false, why: 'approve an ID that sent /start to the bot — that is how LAIN knows the account is real' };
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

/** GONE MEANS GONE: the gateway stops, the credential and approvals are removed. */
async function disconnectTelegram(app) {
  const svc = await service(app);
  if (svc.owner === 'external') return { ok: false, why: 'messaging is running in another LAIN process (lain --bot); stop it there first' };
  if (svc.owner === 'core') await stopService(app);
  const r = await rpc({ op: 'remote_disconnect' }, { start: true });
  if (!r || !r.ok) return { ok: false, why: `the runtime did not remove the credential: ${(r && r.error) || 'no answer'}` };
  const s = ensureSettings(app, 'telegram');
  s.enabled = false;
  s.allowUsers = [];
  saveConfig(app);
  const others = PLATFORMS.filter((p) => p !== 'telegram' && (settings(app, p) || {}).enabled);
  if (others.length) await startService(app);
  return { ok: true, removed: Boolean(r.removed), telegram: await telegram(app) };
}

module.exports = {
  STATE, PLATFORMS, TOKEN_RE,
  connections, telegram, candidates, service, startService, stopService,
  connectTelegram, approveTelegram, revokeTelegram, disconnectTelegram,
};
