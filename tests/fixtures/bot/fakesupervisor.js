'use strict';

/**
 * A FAKE LAIN RUNTIME FOR THE TELEGRAM CHANNEL — the supervisor's messaging ops
 * (rust/lain-supervisor/src/bot.rs + remote.rs), in memory, with the one rule
 * the P0 turned on: Telegram is polled ONLY while a gateway holds the mailbox
 * lease (`can_poll`). A message "sent to the bot" waits at Telegram until then.
 *
 * Installed by replacing supervisor.call / callIfRunning; `restore()` puts them
 * back. No network, no real token, no real bot.
 */

const GOOD = '123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0';

function install() {
  const sup = require('../../../src/supervisor');
  const real = { call: sup.call, callIfRunning: sup.callIfRunning };
  const s = {
    configured: false, token: null, owner: '', atTelegram: [], mailbox: [], sent: [], ops: [], n: 0,
    botId: '123456789',
  };
  const lease = () => Boolean(s.owner);
  function op(req) {
    s.ops.push(req.op);
    switch (req.op) {
      case 'remote_gateway_status':
      case 'remote_gateway_check':
        return { ok: true, configured: s.configured, botId: s.configured ? s.botId : '0', gatewayEnabled: true, gatewayMode: true,
          attached: lease(), gatewayOwned: lease(), link: s.configured ? 'LISTENING' : 'OFF', mailboxDepth: s.mailbox.length,
          lastOkAt: Date.now(), ...(req.op === 'remote_gateway_check' ? { authenticated: s.configured, authFailed: false } : {}) };
      case 'remote_status':
        return { ok: true, remote: { configured: s.configured, bot_username: s.configured ? 'fakebot' : null, bot_name: s.configured ? 'Fake' : null, authorized_chats: 0, pairing_code: null } };
      case 'remote_gateway_attach':
        if (req.token !== undefined) {
          if (req.token !== GOOD) return { ok: false, error: 'Telegram credential could not be verified' };
          s.configured = true; s.token = req.token;
        }
        if (!s.configured) return { ok: false, error: 'Telegram is not configured' };
        if (s.owner && s.owner !== req.owner) return { ok: false, error: 'mailbox leased by another gateway' };
        s.owner = req.owner;
        return { ok: true, botId: s.botId, mediaProtocol: 1 };
      case 'remote_gateway_detach':
        if (s.owner === req.owner) s.owner = '';
        return { ok: true };
      case 'remote_gateway_poll':
        if (!s.owner || s.owner !== req.owner) return { ok: false, error: 'lease lost' };
        // can_poll: only now does anything leave Telegram.
        while (s.atTelegram.length && s.mailbox.length < 128) s.mailbox.push(s.atTelegram.shift());
        return { ok: true, events: s.mailbox.slice() };
      case 'remote_gateway_ack':
        s.mailbox = s.mailbox.filter((e) => e.messageId !== req.messageId);
        return { ok: true };
      case 'remote_gateway_send':
        if (!s.owner || s.owner !== req.owner) return { ok: false, error: 'lease lost' };
        s.sent.push({ method: req.method, chatId: String(req.params.chat_id), text: req.params.text || '' });
        return { ok: true, accepted: true, status: 200, messageId: String(1000 + s.sent.length) };
      case 'remote_disconnect': {
        const had = s.configured;
        s.configured = false; s.token = null; s.owner = ''; s.mailbox = [];
        return { ok: true, removed: had };
      }
      default: return { ok: false, error: `unknown op ${req.op}` };
    }
  }
  sup.call = async (req) => op(req);
  sup.callIfRunning = async (req) => op(req);
  return {
    state: s,
    GOOD,
    /** A person sends the bot a private message. It waits at Telegram. */
    dm(sender, text) {
      s.n += 1;
      s.atTelegram.push({ platform: 'telegram', chatId: String(sender), senderId: String(sender), messageId: String(s.n), kind: 'dm', text, timestamp: Date.now() });
    },
    restore() { Object.assign(sup, real); },
  };
}

module.exports = { install, GOOD };
