'use strict';

/** WHICH CHAT SOURCES EXIST, AND WHICH ONE THIS SESSION IS USING. */

const contract = require('./contract');
const { SOURCE, LABEL, KIND, CONNECTION } = contract;

/** The sources this build knows about, in the order a picker should show them. */
const DECLARED = Object.freeze([
  { id: SOURCE.LAIN, kind: KIND.RUNTIME },
]);
const RETIRED = Object.freeze(new Set([SOURCE.CHATGPT_WEB, SOURCE.GEMINI_WEB]));
const RETIRED_WHY = 'The ChatGPT and Gemini website sources were retired in LAIN — connect the provider as an account or runtime instead (MODEL › Sources).';

/** No website source is constructed any more (see DECLARED). */
const PLANS = Object.freeze({});

function store(app) {
  if (!app) return new Map();
  if (!app._modelSources) app._modelSources = new Map();
  return app._modelSources;
}

/** THE SOURCE, BUILT ONCE PER APP. */
function get(app, sourceId, { surface = null } = {}) {
  const id = String(sourceId || '');
  const held = store(app);
  if (!surface && held.has(id)) return held.get(id);

  // PHASE 8.3: LAIN's own runtime is the only chat source — the website adapters are removed, not just retired.
  if (id !== SOURCE.LAIN) return null;
  const made = new (require('./runtime').RuntimeModelSource)({ app });
  held.set(id, made);
  return made;
}

/** Every declared source, as instances. */
function all(app) {
  return DECLARED.map((d) => get(app, d.id)).filter(Boolean);
}

/** WHICH SOURCE ANSWERS A CHAT TURN. */
function selectedId(app) {
  const s = app && app.session;
  const want = s && s.chatSource ? String(s.chatSource) : SOURCE.LAIN;
  return DECLARED.some((d) => d.id === want) ? want : SOURCE.LAIN;
}

function selected(app) { return get(app, selectedId(app)); }

/** Is the chat source something other than LAIN's own runtime? */
function usingWeb(app) {
  const id = selectedId(app);
  const row = DECLARED.find((d) => d.id === id);
  return Boolean(row && row.kind === KIND.WEB);
}

/** CHOOSE A SOURCE, and restore the model already chosen for it if there is one. */
function selectSource(app, sourceId) {
  const id = String(sourceId || '');
  if (RETIRED.has(id)) return { ok: false, retired: true, why: RETIRED_WHY };
  if (!DECLARED.some((d) => d.id === id)) {
    return { ok: false, why: `"${id}" is not a chat source (${DECLARED.map((d) => d.id).join(', ')})` };
  }
  const s = app && app.session;
  if (!s) return { ok: false, why: 'no session' };
  s.chatSource = id;
  const model = (s.sourceSelections || {})[id] || null;
  if (id === SOURCE.LAIN && !model && app.cfg && app.cfg.model) {
    // Not a silent switch: the runtime source's model IS `cfg.model`, which the
    // person already chose with `/model`. Recording it makes that explicit.
    s.sourceSelections = { ...(s.sourceSelections || {}), [id]: app.cfg.model };
  }
  return { ok: true, source: id, model: (s.sourceSelections || {})[id] || null, why: '' };
}

/** Choose a model on a source. Delegates the real work to the source itself. */
async function selectModel(app, sourceId, modelId, opts = {}) {
  const src = get(app, sourceId);
  if (!src) return { ok: false, why: `"${sourceId}" is not a chat source` };
  return src.selectModel(modelId, opts);
}

/** THE WHOLE PICTURE, FOR A FRONTEND. */
async function overview(app, { open = false } = {}) {
  const chosen = selectedId(app);
  const rows = [];
  for (const src of all(app)) {
    let st;
    // eslint-disable-next-line no-await-in-loop -- three sources, and a status
    // call that opens a browser must not race two others doing the same.
    try { st = await src.status({ open: open && src.id === chosen }); } catch (e) {
      st = { source: src.id, label: src.label, kind: src.kind, state: CONNECTION.FAILED, why: (e && e.message) || String(e) };
    }
    rows.push({
      ...st,
      chosen: src.id === chosen,
      selected: src.selectedModel ? src.selectedModel() : null,
    });
  }
  return { selected: chosen, sources: rows };
}

module.exports = {
  DECLARED, get, all, selectedId, selected, usingWeb, selectSource, selectModel, overview,
  SOURCE, LABEL, KIND,
};
