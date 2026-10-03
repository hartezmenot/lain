'use strict';

/** LAIN'S OWN MODELS, AS A CHAT SOURCE. */

const { ModelSource, KIND, SOURCE, LABEL, CONNECTION, MODEL_STATE, STATUS, capabilities, result } = require('./contract');
const providerMod = require('../provider');
const errors = require('../errors');

/** How many catalog entries a picker is handed at once. The catalog can be ~1000. */
const MAX_MODELS = 400;

class RuntimeModelSource extends ModelSource {
  constructor({ app } = {}) {
    super({ id: SOURCE.LAIN, label: LABEL[SOURCE.LAIN], kind: KIND.RUNTIME });
    this.app = app;
    this._abort = null;
  }

  capabilities() {
    return capabilities({
      text: true,
      // The runtime path carries images through the ordinary tool and message
      // machinery; a chat send here is text. Stated rather than guessed.
      imageInput: false,
      fileInput: false,
      streaming: true,
      cancel: true,
      // THE ONE SOURCE WHERE THIS IS TRUE. A provider returns a usage receipt;
      // a website does not. That difference is exactly why the flag exists.
      authoritativeUsage: true,
    });
  }

  /** Which route serves the chat model right now. */
  _resolve() {
    const cfg = (this.app && this.app.cfg) || {};
    return providerMod.resolve({ ...cfg, _evidence: (this.app && this.app.connectionEvidence) || {} });
  }

  async status() {
    const pc = this._resolve();
    const hint = providerMod.credentialHint(pc, (this.app && this.app.cfg) || null);
    const state = hint ? CONNECTION.UNAVAILABLE : CONNECTION.READY;
    return {
      source: this.id,
      label: this.label,
      kind: this.kind,
      state,
      why: hint || '',
      selected: this.selectedModel(),
      // Not read here: the catalog is large and a status call must stay cheap.
      // `discoverModels` is the paid operation and is asked for by name.
      models: null,
      modelsAt: null,
      capabilities: this.capabilities(),
      route: pc.protocol ? { provider: pc.provider, connection: pc.connectionId } : null,
    };
  }

  /** Nothing to connect: a configured route is already reachable or is not. */
  async connect() { return this.status(); }

  /** Nothing to disconnect either. Declared so the contract is total. */
  async disconnect() { return this.status(); }

  /** WHAT THIS MACHINE'S ROUTES SERVE. */
  async discoverModels({ refresh = false } = {}) {
    if (!this.app) return { ok: false, models: [], cached: false, at: 0, why: 'no app' };
    try {
      await this.app.ensureCatalog({ force: Boolean(refresh), announce: false });
    } catch (e) {
      return { ok: false, models: [], cached: false, at: 0, why: `the catalog could not be read: ${(e && e.message) || e}` };
    }
    const cat = this.app.catalog();
    const rows = (cat && cat.models ? cat.models : []).slice(0, MAX_MODELS).map((m) => ({
      id: m.id,
      label: m.displayName || m.id,
      // A CONFIGURED, REACHABLE ROUTE SERVES IT.
      state: MODEL_STATE.AVAILABLE,
      connection: m.connectionId || null,
    }));
    return { ok: true, models: rows, cached: false, at: Date.now(), why: rows.length ? '' : 'no configured connection serves any model' };
  }

  selectedModel() {
    const s = this.app && this.app.session;
    const picks = (s && s.sourceSelections) || {};
    // The session's own choice first; otherwise whatever the config already
    // routes to, which is what `/model` set and what a turn would use anyway.
    return picks[this.id] || ((this.app && this.app.cfg && this.app.cfg.model) || null);
  }

  /** CHOOSE A MODEL — through the SAME catalog resolution `/model` uses. */
  async selectModel(modelId) {
    const want = String(modelId || '').trim();
    if (!want) return { ok: false, modelId: null, why: 'no model was named' };
    if (!this.app) return { ok: false, modelId: null, why: 'no app' };
    await this.app.ensureCatalog({ announce: false });
    const cat = this.app.catalog();
    const r = require('../catalog').resolve(cat, { model: want, connectionId: this.app.cfg.connection || null, effort: this.app.cfg.effort || null });
    if (!r.ok) {
      const hits = require('../catalog').find(cat, want);
      return {
        ok: false,
        modelId: null,
        why: hits && hits.length
          ? `"${want}" is ambiguous — ${hits.slice(0, 3).map((h) => h.id).join(', ')}`
          : `"${want}" is not served by any configured connection`,
      };
    }
    this.app.cfg.model = r.model;
    if (r.connection && r.connection.connectionId) this.app.cfg.connection = r.connection.baseConnectionId || r.connection.connectionId;
    try { require('../config').save(this.app.cfg); } catch { /* an unwritable config still runs */ }
    const s = this.app.session;
    if (s) {
      if (!s.sourceSelections || typeof s.sourceSelections !== 'object') s.sourceSelections = {};
      s.sourceSelections[this.id] = r.model;
    }
    return { ok: true, modelId: r.model, label: r.model, why: '' };
  }

  /** ONE CHAT REQUEST, NO TOOLS. */
  async send({ prompt, modelId = null, signal = null, system = null } = {}) {
    const wanted = modelId || this.selectedModel();
    const cfg = { ...((this.app && this.app.cfg) || {}), _evidence: (this.app && this.app.connectionEvidence) || {} };
    if (wanted) cfg.model = wanted;
    const pc = providerMod.resolve(cfg);
    const hint = providerMod.credentialHint(pc, (this.app && this.app.cfg) || null);
    if (hint) return result({ source: this.id, model: wanted, status: STATUS.UNAVAILABLE, error: hint });

    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(prompt || '') });

    const abort = new AbortController();
    this._abort = abort;
    const onOuter = () => abort.abort();
    if (signal) { if (signal.aborted) abort.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }

    let text = '';
    let usage = null;
    try {
      for await (const ev of providerMod.chat(pc, messages, {
        tools: [], signal: abort.signal,
        trace: { reason: require('../reqtrace').REASON.EXTERNAL },
      })) {
        if (abort.signal.aborted) break;
        if (!ev) continue;
        if (ev.type === 'text') text += ev.chunk || '';
        else if (ev.type === 'usage') usage = { inputTokens: ev.inputTokens || 0, outputTokens: ev.outputTokens || 0 };
      }
    } catch (e) {
      if (abort.signal.aborted) {
        return result({ source: this.id, model: pc.canonicalModel || pc.model, status: STATUS.CANCELLED, error: 'cancelled' });
      }
      const f = errors.classify(e);
      const limited = f.kind === errors.KIND.RATE_LIMITED;
      return result({
        source: this.id,
        model: pc.canonicalModel || pc.model,
        status: limited ? STATUS.RATE_LIMITED : STATUS.FAILED,
        error: f.message,
        retryAfterMs: f.retryAfterMs || null,
      });
    } finally {
      this._abort = null;
      if (signal) signal.removeEventListener('abort', onOuter);
    }
    if (abort.signal.aborted) {
      return result({ source: this.id, model: pc.canonicalModel || pc.model, status: STATUS.CANCELLED, error: 'cancelled' });
    }
    return result({
      source: this.id,
      model: pc.canonicalModel || pc.model,
      status: STATUS.COMPLETED,
      text,
      usage,
    });
  }

  cancel(why = 'cancelled by the user') {
    const a = this._abort;
    this._abort = null;
    if (!a || a.signal.aborted) return { ok: true, cancelled: false, why: 'nothing in flight' };
    try { a.abort(String(why)); } catch { /* already gone */ }
    return { ok: true, cancelled: true, why };
  }
}

module.exports = { RuntimeModelSource, MAX_MODELS };
