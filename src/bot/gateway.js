'use strict';

const path = require('path');
const { event, authorized, whyDenied, sessionKey, eventKey, digest } = require('./contract');
const { Trace, STAGE, rid } = require('./trace');
const { Store } = require('./store');
const { Delivery } = require('./delivery');
const { Prompts } = require('./prompts');

class Gateway {
  constructor({ cfg = {}, cwd = process.cwd(), dir, registry, runtimeFactory } = {}) {
    this.cfg = cfg; this.cwd = cwd; this.registry = registry;
    this.store = new Store(dir || path.join(require('../config').configDir(), 'bot'));
    this.trace = new Trace(dir);
    this.runtimeFactory = runtimeFactory || (opts => new (require('./runtime').Runtime)(opts));
    this.adapters = new Map(); this.unavailable = []; this.runtimes = new Map(); this.queues = new Map(); this.busy = new Set();
    this.tasks = new Set(); this.active = 0; this.stopping = false;
    this.maxActive = Math.max(1, Math.min(8, Number(cfg.bot?.maxConcurrent) || 2));
    this.delivery = new Delivery(this.store, (platform, account) => {
      const adapter = this.adapters.get(`${platform}:${account}`);
      return adapter && !['unavailable', 'stopped'].includes(adapter.state) ? adapter : null;
    });
    this.prompts = new Prompts(this.delivery);
  }
  async start() {
    if (this.started) { if (this.stopping) throw new Error('create a fresh gateway after shutdown'); return this.status(); }
    this.started = true;
    this.stopping = false;
    for (const [platform, settings] of Object.entries(this.cfg.bot?.platforms || {})) {
      if (!settings.enabled) continue;
      const key = `${platform}:${settings.accountId || 'default'}`;
      try {
        const adapter = this.registry.create(platform, settings);
        adapter.settings = settings; adapter.accountId = settings.accountId || 'default';
        adapter.note = (facts) => this.trace.note(STAGE.ADAPTER, { platform, accountId: adapter.accountId, ...facts });
        this.adapters.set(key, adapter);
        await adapter.start(e => this.receive(e));
        this.store.account(key, adapter.identity);
      } catch (error) {
        const reason = require('../redact').text(String(error?.message || 'adapter could not start')).slice(0, 180);
        const adapter = this.adapters.get(key);
        if (adapter) { await adapter.stop().catch(() => {}); adapter.state = 'unavailable'; adapter.reason = reason; }
        else this.unavailable.push({ platform, accountId: settings.accountId || 'default', state: 'unavailable', reason });
        this.trace.note(STAGE.ADAPTER, { platform, accountId: settings.accountId || 'default', ok: false, why: `could not start: ${reason}` });
      }
    }
    await this.delivery.recover(target => {
      const adapter = this.adapters.get(`${target.platform}:${target.accountId}`);
      return adapter && authorized(target, adapter.settings);
    });
    for (const [id, row] of Object.entries(this.store.data.inbox)) {
      const adapter = row.event && this.adapters.get(`${row.event.platform}:${row.event.accountId}`);
      if (row.state === 'queued' && row.event && adapter && !['unavailable', 'stopped'].includes(adapter.state)) this.enqueue(id, row.event);
    }
    // LAIN NEEDS YOU: Core decisions and attention events to the owner chat. See bot/attention.js.
    this.attention = require('./attention').forGateway(this).start();
    this.pump(); return this.status();
  }
  status() {
    return { state: this.stopping ? 'stopped' : 'running', active: this.active,
      queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
      platforms: [...this.adapters.values()].map(a => ({ platform: a.caps.platform, accountId: a.accountId, state: a.state || 'starting', reason: a.reason || '', caps: a.caps,
        accountFingerprint: a.identity ? digest([a.caps.platform, String(a.accountId || 'default'), String(a.identity)]).slice(0, 24) : '', diagnostics: diagnostics(a) })).concat(this.unavailable),
      pendingDeliveries: Object.values(this.store.data.deliveries).filter(r => r.state === 'pending').length,
      uncertain: Object.values(this.store.data.deliveries).filter(r => r.state === 'uncertain').length,
      interrupted: Object.values(this.store.data.inbox).filter(r => r.state === 'interrupted').length,
      // THE WEBAPP BUTTON URL (webapp.js launchUrl): endpoints + ping key, from the HTTPS page address you serve it at.
      ...(this.webapp ? { webapp: { port: this.webapp.port, url: this.cfg?.bot?.webapp?.pageUrl ? this.webapp.launch(this.cfg.bot.webapp.pageUrl) : null } } : {}) };
  }
  async receive(raw) {
    if (this.stopping) return { accepted: false };
    let e; try { e = event(raw); } catch { this.trace.note(STAGE.INBOUND, { platform: String(raw?.platform || ''), ok: false, why: 'malformed event' }); return { accepted: false }; }
    const r = { id: rid(eventKey(e)), platform: e.platform, accountId: e.accountId };
    this.trace.note(STAGE.INBOUND, { ...r, kind: e.kind, sender: e.senderId, chars: e.text.length, attachments: e.attachments.length });
    const adapter = this.adapters.get(`${e.platform}:${e.accountId}`);
    const denied = !adapter ? 'no adapter for this account' : whyDenied(e, adapter.settings);
    if (denied) {
      this.trace.note(STAGE.AUTHORIZE, { ...r, ok: false, why: denied, sender: e.senderId });
      // An unauthorized private message is a request to be approved locally —
      // recorded for LAIN Desktop's Bot view, answered with nothing, granting
      // nothing. Any private message, not only `/start`: a person who typed
      // "hi" first is the same person asking.
      if (adapter && e.platform === 'telegram' && e.kind === 'dm' && !e.bot) {
        try { this.store.candidate(e); } catch { /* a full or unwritable store still refuses the sender */ }
      }
      return { accepted: false };
    }
    if (!e.text.trim() && !e.attachments.length && !e.promptResponse) { this.trace.note(STAGE.AUTHORIZE, { ...r, ok: false, why: 'empty message' }); return { accepted: false }; }
    this.trace.note(STAGE.AUTHORIZE, { ...r, sender: e.senderId });
    this.store.account(`${e.platform}:${e.accountId}`, adapter.identity);
    const key = sessionKey(e), id = eventKey(e);
    if (this.store.data.inbox[id]) return { accepted: true, duplicate: true };
    const cancel = /^\/(?:cancel|bg\s+stop)\s+(\d+)$/.exec(e.text.trim());
    const control = cancel || e.promptResponse || /^\/answer\b/.test(e.text) || /^\/?stop$/i.test(e.text.trim()) || /^\/steer\s+/.test(e.text);
    if (!control && ((this.queues.get(key)?.length || 0) >= 8 || [...this.queues.values()].reduce((n, q) => n + q.length, 0) >= 128)) { this.trace.note(STAGE.DISPATCH, { ...r, ok: false, why: 'queue full — will be read again' }); return { accepted: false, busy: true }; }
    if (!this.store.admit(id, e)) return { accepted: true, duplicate: true };
    if (control) {
      if (cancel) this.runtimes.get(key)?.cancelJob(cancel[1]);
      else if (/^\/?stop$/i.test(e.text.trim())) {
        this.runtimes.get(key)?.stop(); this.prompts.cancel(key);
        for (const waiting of this.queues.get(key) || []) this.store.settle(waiting.id, 'done');
        this.queues.delete(key);
      } else if (/^\/steer\s+/.test(e.text)) this.runtimes.get(key)?.steer(e.text.replace(/^\/steer\s+/, ''));
      else if (!this.prompts.resolve(e)) this.attention?.resolve(e);
      this.trace.note(STAGE.DISPATCH, { ...r, control: true });
      this.store.settle(id, 'done'); return { accepted: true };
    }
    this.enqueue(id, e); this.pump(); return { accepted: true };
  }
  enqueue(id, e) { const key = sessionKey(e); if (!this.queues.has(key)) this.queues.set(key, []); this.queues.get(key).push({ id, e }); }
  pump() {
    if (this.stopping) return;
    for (const [key, queue] of this.queues) {
      if (this.active >= this.maxActive) break;
      if (!queue.length || this.busy.has(key)) continue;
      const item = queue.shift(); this.queues.delete(key); if (queue.length) this.queues.set(key, queue);
      this.busy.add(key); this.active++;
      const work = this.run(key, item).catch(() => {}).finally(() => {
        this.active--; this.busy.delete(key); this.tasks.delete(work); this.pump();
      });
      this.tasks.add(work);
    }
  }
  async run(key, { id, e }) {
    const adapter = this.adapters.get(`${e.platform}:${e.accountId}`);
    // Config changes and queued recovery cannot bypass current authorization.
    const r = { id: rid(id), platform: e.platform, accountId: e.accountId };
    if (!adapter || !authorized(e, adapter.settings)) { this.trace.note(STAGE.DISPATCH, { ...r, ok: false, why: 'no longer authorized when its turn came' }); this.store.settle(id, 'denied'); return; }
    this.store.settle(id, 'running');
    const send = (text, deliveryId) => this.delivery.sendMessage(e, text, { id: deliveryId, turnId: id,
      kind: /^\/(?:delivery|retry|send)\b/.test(e.text.trim()) ? 'notice' : 'text' });
    const notify = async (text, deliveryId) => {
      const rows = await send(text, deliveryId).catch((err) => { this.trace.note(STAGE.OUTBOUND, { ...r, ok: false, why: String(err?.message || 'delivery failed') }); throw err; });
      const bad = (rows || []).find((x) => x.state !== 'delivered');
      this.trace.note(STAGE.OUTBOUND, bad ? { ...r, ok: false, why: `reply ${bad.state}${bad.error ? `: ${bad.error}` : ''}`, parts: rows.length } : { ...r, parts: (rows || []).length });
      return rows;
    };
    let timer;
    // /target — WHICH SESSION THIS CHAT DRIVES (a canonical session, never a copy).
    if (/^\/target\b/.test(String(e.text || '').trim())) {
      try { await notify(await this.target(key, String(e.text).trim().replace(/^\/target\s*/, '')), `turn:${id}`); } catch { /* reported by delivery */ }
      this.store.settle(id, 'done');
      return;
    }
    try {
      let runtime = this.runtimes.get(key);
      if (!runtime) {
        if (this.runtimes.size >= 128) throw new Error('active conversation capacity reached');
        const sessionId = this.store.data.sessions[key];
        const coworkState = require('../cowork/sessionstate');
        const targeted = Boolean(this.store.data.targets && this.store.data.targets[key]);
        const cowork = !targeted && coworkState.SOURCES.has(e.platform) ? { source: e.platform, binding: coworkState.sourceBinding(e.platform, key) } : null;
        runtime = this.runtimeFactory({ cfg: this.cfg, cwd: this.cwd, sessionId, cowork, ask: (target, q, signal) => this.prompts.ask(target, q, signal),
          prepareInput: (app, target) => require('./media').ingress(adapter, app, target),
          deliveryStatus: target => this.delivery.review(target), retryDelivery: target => this.delivery.retryLatest(target, eventKey(target)),
          sendArtifact: (app, target, artifactId, deliveryId = null) => require('./media').sendArtifact(adapter, this.delivery, app, target, artifactId, deliveryId || `artifact:${eventKey(target)}:${artifactId}`) });
        this.store.bind(key, () => runtime.id); this.runtimes.set(key, runtime);
      }
      this.trace.note(STAGE.DISPATCH, { ...r, session: runtime.id });
      if (adapter.caps.typing) {
        const typing = () => adapter.action({ type: 'typingStart', target: e }).catch(() => {});
        typing(); timer = setInterval(typing, 6000);
      }
      const text = await runtime.run(e, notify);
      const outcome = runtime.lastOutcome || {};
      this.trace.note(STAGE.MODEL, outcome.providerFailure
        ? { ...r, ok: false, why: `provider could not answer: ${outcome.providerFailure}`, model: outcome.model }
        : { ...r, ok: Boolean(text), why: text ? '' : 'turn ended without text', chars: String(text || '').length, model: outcome.model, command: outcome.command || undefined });
      if (!this.stopping && text) await notify(text, `turn:${id}`);
      this.store.settle(id, 'done');
    } catch (err) {
      this.trace.note(STAGE.MODEL, { ...r, ok: false, why: `turn failed: ${String(err?.message || err).slice(0, 160)}` });
      this.store.settle(id, 'interrupted');
      if (!this.stopping) await notify('Noema could not complete this turn. Check the local bot status before retrying.', `error:${id}`).catch(() => {});
    } finally {
      clearInterval(timer);
      if (adapter.caps.typing) await adapter.action({ type: 'typingStop', target: e }).catch(() => {});
    }
  }
  /** `/target` lists recent sessions; `/target <n|id>` binds this chat to one; `/target reset` returns to its own. */
  async target(key, arg) {
    const { Session } = require('../session');
    let rows = [];
    try { rows = (require('../sessionindex').summaries({ limit: 12 }) || []).filter((r) => r && r.id); } catch { rows = []; }
    const cur = this.store.data.sessions[key] || null;
    if (!arg) return rows.length ? `Sessions (reply /target <number>):\n${rows.map((r, i) => `${i + 1}. ${r.title || '(untitled)'} · ${require('path').basename(r.cwd || '') || 'no project'}${r.id === cur ? ' ← this chat' : ''}`).join('\n')}` : 'No sessions yet.';
    if (arg === 'reset') { if (this.store.data.targets) delete this.store.data.targets[key]; delete this.store.data.sessions[key]; this.store.save(); const rt = this.runtimes.get(key); if (rt) { this.runtimes.delete(key); await rt.close().catch(() => {}); } return 'This chat is back on its own conversation.'; }
    const pick = /^\d+$/.test(arg) ? rows[Number(arg) - 1] : rows.find((r) => r.id === arg || Session.shortId(r.id) === arg);
    if (!pick) return 'No such session — /target lists them.';
    const rt = this.runtimes.get(key);
    if (rt) { this.runtimes.delete(key); await rt.close().catch(() => {}); }
    this.store.data.sessions[key] = pick.id;
    this.store.data.targets = { ...(this.store.data.targets || {}), [key]: pick.id };
    this.store.save();
    return `This chat now drives: ${pick.title || '(untitled)'} (${require('path').basename(pick.cwd || '') || 'no project'}). Same session, same state as the Harness and CLI.`;
  }
  async stop() {
    this.stopping = true; this.prompts.cancel(); this.attention?.stop(); this.delivery.stop();
    for (const r of this.runtimes.values()) r.stop();
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([...this.runtimes.values()].map(r => r.close()));
    await Promise.allSettled([...this.adapters.values()].map(a => a.stop()));
    this.runtimes.clear(); this.queues.clear();
  }
}
function diagnostics(adapter) {
  let raw; try { raw = adapter.diagnostics?.() || {}; } catch { return {}; }
  return Object.fromEntries(['activeSession', 'heartbeatHealthy', 'gatewayReachable', 'intents', 'localListener', 'publicWebhookVerified',
    'inboundAccepted', 'deliveryAcknowledged', 'heartbeatAgeMs', 'reconnects', 'duplicates'].filter(k => typeof raw[k] === 'boolean' || (typeof raw[k] === 'number' && Number.isFinite(raw[k])))
    .map(k => [k, raw[k]]));
}
module.exports = { Gateway };
