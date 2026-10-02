'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { Gateway } = require('./gateway');
const { createRegistry } = require('./registry');
function location(dir = config.configDir()) {
  let root = path.resolve(dir);
  try { root = fs.realpathSync(root); } catch { /* first configuration */ }
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  return { dir: path.join(root, 'bot'), file: path.join(root, 'bot', 'control.json'),
    port: 20000 + crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % 30000 };
}
// The OS socket is the singleton lock. A stale file never owns the service and
// a PID is never killed/reclaimed. A port collision fails closed.
async function start({ cfg = config.load(), cwd = process.cwd(), dir = config.configDir(), registry, runtimeFactory } = {}) {
  const loc = location(dir), token = crypto.randomBytes(24).toString('hex');
  require('../redact').register(token);
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy()); let data = '';
    socket.on('data', chunk => {
      data += chunk; if (data.length > 4096) return socket.destroy();
      if (!data.includes('\n')) return;
      let req; try { req = JSON.parse(data.split('\n')[0]); } catch { return socket.destroy(); }
      socket.pause();
      if (req.token !== token || !gateway) return socket.end('{"ok":false}\n');
      socket.end(JSON.stringify({ ok: true, ...gateway.status() }) + '\n');
      if (req.op === 'stop') setImmediate(() => stop().catch(() => {}));
    });
  });
  let gateway, stopped = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: loc.port, exclusive: true }, resolve); });
  let stopping;
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      try { await gateway?.stop(); } finally {
        await new Promise(resolve => server.close(resolve));
        try { if (JSON.parse(fs.readFileSync(loc.file, 'utf8')).token === token) fs.unlinkSync(loc.file); } catch { /* absent */ }
        resolveDone();
      }
    })(); return stopping;
  }
  try {
    gateway = new Gateway({ cfg, cwd, dir: loc.dir, registry: registry || createRegistry(), runtimeFactory });
    await gateway.start();
    // THE PROGRESS WEBAPP (read-only; webapp.js), only when asked for and only
    // with Telegram's own verification available — never a plain open endpoint.
    const tg = cfg.bot?.platforms?.telegram;
    if (cfg.bot?.webapp?.enabled && tg?.tokenEnv && process.env[tg.tokenEnv]) {
      try {
        const web = await require('../webapp').start({ port: Number(cfg.bot.webapp.port) || 0, botToken: process.env[tg.tokenEnv], allowUsers: tg.allowUsers || [],
          jobs: () => [...gateway.runtimes.values()].flatMap((r) => r.app.jobs.all().map((j) => j.summary())) });
        gateway.webapp = web;
        const prevStop = gateway.stop.bind(gateway);
        gateway.stop = async () => { await web.close().catch(() => {}); return prevStop(); };
      } catch { /* the Bot still works without the progress view */ }
    }
    fs.writeFileSync(loc.file, JSON.stringify({ token, port: loc.port }), { mode: 0o600 });
    server.on('error', () => stop().catch(() => {}));
    return { gateway, stop, done, get stopped() { return stopped; } };
  } catch (e) { await stop(); throw e; }
}
async function control(op = 'status', dir = config.configDir()) {
  const loc = location(dir); let auth;
  try { auth = JSON.parse(fs.readFileSync(loc.file, 'utf8')); } catch { return { state: 'stopped', platforms: [] }; }
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: loc.port }); let data = '', settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish({ state: 'unavailable', platforms: [] }));
    socket.on('error', () => finish({ state: 'stopped', platforms: [] }));
    socket.on('connect', () => socket.write(JSON.stringify({ op, token: auth.token }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.length > 16000) return finish({ state: 'unavailable' });
      if (data.includes('\n')) { try { const r = JSON.parse(data.split('\n')[0]); finish(r.ok ? r : { state: 'unavailable' }); } catch { finish({ state: 'unavailable' }); } } });
  });
}
function describe(status) {
  return [`Bot: ${status.state}`, ...(status.platforms || []).map(p => `  ${p.platform} (${p.accountId}): ${p.state}${p.reason ? ' — ' + p.reason : ''}`),
    ...(status.pendingDeliveries ? [`  ${status.pendingDeliveries} delivery fragments are pending.`] : []),
    ...(status.uncertain ? [`  ⚠ Delivery status unknown · ${status.uncertain} message fragment(s) may have been sent. Use /delivery in the originating conversation; no automatic resend.`] : []),
    ...(status.interrupted ? [`  ${status.interrupted} turns were interrupted; no automatic replay.`] : []),
    ...(status.webapp ? [status.webapp.url ? `  WebApp button URL: ${status.webapp.url}` : `  WebApp on port ${status.webapp.port} — set bot.webapp.pageUrl (the HTTPS address serving it) for the button URL.`] : [])].join('\n');
}
async function foreground({ cwd } = {}) {
  let service;
  try { service = await start({ cwd }); } catch { process.stderr.write('LAIN bot could not start; check configuration or an existing bot service.\n'); return 1; }
  const quit = () => service.stop().catch(() => {});
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  process.stdout.write(describe(service.gateway.status()) + '\n');
  try { await service.done; return 0; } finally { process.removeListener('SIGINT', quit); process.removeListener('SIGTERM', quit); }
}
module.exports = { start, control, describe, foreground, location };
