'use strict';

/** THE BOT SIDE OF "LAIN NEEDS YOU" (§39–40, §78). */

const fs = require('fs');
const path = require('path');
const decisions = require('../decisions');

const SCAN_MS = 700;

function ownerTarget(platform, settings) {
  const chat = settings.notifyChatId || (Array.isArray(settings.allowUsers) && settings.allowUsers[0]);
  if (!chat) return null;
  return { platform, accountId: settings.accountId || 'default', chatId: String(chat), senderId: String(chat), threadId: '', kind: 'dm', replyTo: '' };
}

function label(kind) {
  return { ASK_USER: 'LAIN asks', PERMISSION_REQUEST: 'PERMISSION', CAPABILITY_REQUEST: 'REQUEST', DOWNLOAD_REQUEST: 'DOWNLOAD', BLOCKED: 'BLOCKED',
    BACKGROUND_COMPLETE: 'BG COMPLETE', TASK_COMPLETE: 'DONE', FAILED: 'FAILED' }[kind] || kind;
}

class Attention {
  constructor({ delivery, targets = [], configDir = null } = {}) {
    this.delivery = delivery;
    this.targets = targets;               // [{ target }] — the owner chat per adapter
    this.home = configDir || require('../config').configDir();
    this.sent = new Map();                // decision id -> { surfaceSeen }
    this.timer = null;
  }

  start() {
    if (this.timer || !this.targets.length) return this;
    decisions.heartbeat();
    this.timer = setInterval(() => { this.scan().catch(() => {}); }, SCAN_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async send(text, id, prompt = null) {
    for (const t of this.targets) {
      try { await this.delivery.sendMessage(t, text, { id: `${id}:${t.platform}:${t.chatId}`, prompt, kind: 'notice' }); } catch { /* delivery records its own failure */ }
    }
  }

  async scan() {
    decisions.heartbeat();
    for (const d of decisions.pending()) {
      if (this.sent.has(d.id)) continue;
      this.sent.set(d.id, { closed: false });
      const text = [`${label(d.type)} · ${d.project || 'LAIN'}`, d.title, d.question].filter(Boolean).join('\n');
      await this.send(text, `decision:${d.id}`, d.options.length ? { id: decisions.token(d), choices: d.options } : null);
    }
    for (const [id, row] of this.sent) {
      if (row.closed) continue;
      const d = decisions.get(id);
      if (!d || d.state === 'PENDING') continue;
      row.closed = true;
      if (d.surface !== 'telegram') await this.send(`✓ answered in ${d.surface}${d.answer ? `: ${d.answer}` : ''}`, `decision-closed:${id}`);
    }
    const dir = path.join(this.home, 'attention');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { names = []; }
    for (const n of names) {
      const f = path.join(dir, n);
      let row = null;
      try { row = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { row = null; }
      try { fs.unlinkSync(f); } catch { continue; }
      if (row) await this.send(`${label(row.kind)} · ${row.project}\n${row.text}`, `attention:${n}`);
    }
  }

  /** A button press or `/answer <token> <n>`. True when it was a Core decision. */
  resolve(e) {
    const r = e && e.promptResponse;
    const typed = /^\/answer\s+([0-9a-f]{24})\s+([1-9][0-9]?)$/.exec(String((e && e.text) || '').trim());
    const tok = r ? r.id : typed && typed[1];
    const val = r ? r.value : typed && typed[2];
    if (!/^[0-9a-f]{24}$/.test(String(tok || ''))) return false;
    const id = tok.slice(0, 8);
    if (!decisions.get(id)) return false;
    const out = decisions.resolve(id, Number(val) - 1, { surface: 'telegram', sig: tok.slice(8) });
    // Only a press that WON closes Telegram's copy; a refused one (forged, late)
    // leaves it open so the real answer is still reported here when it comes.
    const row = this.sent.get(id);
    if (row && out.ok) row.closed = true;
    this.send(out.ok ? `✓ ${out.decision.answer}` : `Not applied: ${out.why}`, `decision-reply:${id}:${Date.now()}`).catch(() => {});
    return true;
  }
}

/** Build the bridge for a running gateway's adapters. */
function forGateway(gateway) {
  const targets = [];
  for (const a of gateway.adapters.values()) {
    const t = ownerTarget(a.caps.platform, { ...a.settings, accountId: a.accountId });
    if (t && a.caps.buttons) targets.push(t);
  }
  return new Attention({ delivery: gateway.delivery, targets });
}

module.exports = { Attention, forGateway, ownerTarget, label };
