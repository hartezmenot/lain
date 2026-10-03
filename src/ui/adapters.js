'use strict';

/** THE PANEL ADAPTERS — DATA, never drawing code. */

const { KIND, MODE, pad, clip } = require('./panel');

//
// Adapters are DATA. They read existing application state and never draw.

/** `/effort` — one owner; `auto` clears the pin. */
/** THE MODEL'S OWN LEVELS, and nothing else (Phase 8.3): a model that offers High and XHigh shows exactly those — no generic list, no invented 'auto'. */
function effortAdapter({ available = [], current = null }) {
  const caps = require('../fabric/effortcaps');
  const levels = caps.order(available);
  return {
    title: 'EFFORT',
    kind: KIND.EFFORT_SELECTION,
    mode: MODE.COMPACT,
    items: levels.map((l) => ({
      label: `${caps.label(l)}${l === caps.norm(current) ? '   (current)' : ''}`,
      value: l,
    })),
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

/** `/models` — MODEL-CENTRIC. One row per identity; routes on drill-down. */
function modelsAdapter({ catalog, current = null, currentConnection = null, onPickRoute = null, readinessOf = null, availabilityOf = null, availabilityRaw = null, filter = '', isNew = null, externalSources = [], sourceIssues = [] }) {
  // FILTERS: All · Free · Paid · Local · External (§55) Typed as `free:` `paid:` `local:` `external:` in the search.
  const fm = /(?:^|\s)(free|paid|local|external):(?=\s|$)/i.exec(String(filter || ''));
  const kind = fm ? fm[1].toLowerCase() : null;
  if (kind === 'external') {
    const rows = (externalSources || []).map((s) => ({ label: `  ${pad(s.label, 22)}external source${s.current ? '  · current' : ''}`, value: `source:${s.id}`, source: s.id }));
    return {
      title: 'MODELS · EXTERNAL SOURCES', kind: KIND.MODEL_SELECTION, mode: MODE.EXPANDED,
      items: rows.length ? rows : [{ label: 'no external source is available', selectable: false }],
      footer: '↑↓ source · Enter list its models · Esc cancel',
      onSelect(item) { return item && item.source ? { close: { source: item.source } } : undefined; },
    };
  }
  // THE SAME SEARCH THE COMMAND USES.
  const q = String(filter || '').replace(/(?:^|\s)(free|paid|local|external):(?=\s|$)/ig, ' ').trim();
  const searched = q ? require('../catalog').search(catalog, q, 400) : catalog.models;
  const wants = (m) => !kind || m.connections.some((c) => (kind === 'local' ? c.local : c.tier === kind));
  const models = searched.filter(wants);
  const items = models.map((m) => {
    // WHAT HELPS SOMEONE CHOOSE, and nothing else.
    const routes = m.connections.length;
    const efforts = (m.connections[0] && m.connections[0].efforts) || [];
    const idShown = String(m.displayName || '').toLowerCase() !== String(m.id).toLowerCase() ? m.id : null;
    const meta = routes > 1
      ? [idShown, `${routes} providers`].filter(Boolean).join('  ·  ')
      : [idShown, (m.connections[0] || {}).provider, efforts.length > 1 ? `${efforts.length} levels` : null]
        .filter(Boolean).join('  ·  ');
    // The mark goes in FRONT of the name, where a person looks for it, not in a
    // column after it.
    const mark = m.id === current ? '● ' : '  ';
    // NEW, for the models the LAST refresh actually brought in.
    const fresh = isNew && isNew.has && isNew.has(m.id) ? 'NEW ' : '    ';
    return {
      label: `${mark}${fresh}${pad(clip(m.displayName, 40), 42)}${meta}`,
      value: m.id,
      model: m,
    };
  });
  if (!items.length) items.push({ label: `no model matches "${filter}"`, selectable: false });
  const at = models.findIndex((m) => m.id === current);
  // THE CURRENT MODEL NEVER SILENTLY DISAPPEARS.
  const currentModel = current && catalog.models.find((m) => m.id === current);
  const currentShown = at >= 0;
  // A SOURCE THAT CANNOT LIST ITS MODELS IS SAID HERE, restrained, as its state
  // (src/catalogstate.js) — not as a WARN block every time the picker opens.
  const issues = (sourceIssues || []).map((s) => `${s.id} ${s.label}`).join(' · ');
  const title = (kind ? `MODELS · ${kind.toUpperCase()}  ` : '') + (q
    ? `MODELS   ${models.length} matching "${q}"`
      + (currentModel && !currentShown ? `   ·   current: ${clip(currentModel.displayName, 28)}` : '')
    : `MODELS   ${models.length}`)
    + (issues ? `   ·   ${issues}` : '');
  return {
    title,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    cursor: at > 0 ? at : 0,
    footer: '↑↓ select · Enter use · → routes · filter: free: paid: local: external: · Esc cancel',
    /** ENTER MEANS "USE THIS MODEL". */
    onSelect(item, { key } = {}) {
      const m = item.model;
      if (!m) return undefined;
      const routes = m.connections;
      const drill = key === 'right' || routes.length > 1;
      if (drill) {
        return { push: modelRoutesAdapter({ model: m, onPickRoute, readinessOf, availabilityOf, availabilityRaw, currentConnection }) };
      }
      const c = routes[0];
      // NEVER SHOW A SCREEN THAT HAS ONE ANSWER ON IT.
      if (c.efforts.length > 1) {
        return { push: routeDetailAdapter({ model: m, connection: c, onPickRoute, readinessOf, availabilityOf }) };
      }
      const effort = c.efforts.length === 1 ? c.efforts[0] : null;
      if (onPickRoute) onPickRoute(m, c, effort);
      return { close: { model: m.id, connection: c.connectionId, effort } };
    },
  };
}

/** MODEL → PROVIDER / CONNECTION. */
/** CAN I CALL THIS ROUTE RIGHT NOW — as a colour and a sentence. */
function routeHealth(c, { readinessOf, availabilityOf, availabilityRaw } = {}) {
  const avail = availabilityOf ? String(availabilityOf(c) || '') : '';
  const ready = readinessOf ? String(readinessOf(c) || '') : '';
  const raw = availabilityRaw ? availabilityRaw(c) : null;

  // TEMPORARY FIRST. A rate-limited route is not broken, and calling it red
  // sends people off to check credentials that are perfectly fine.
  if (raw && raw.rateLimited) {
    const left = raw.resumeAt ? raw.resumeAt - Date.now() : 0;
    const when = left > 0 ? ` · clears in ${require('../ratelimit').human(left)}` : ' · should have cleared';
    return { tone: 'warn', text: `rate limited${when}` };
  }
  if (/RATE|LIMIT|TOO MANY/i.test(avail)) return { tone: 'warn', text: 'rate limited · try again later' };
  if (/MAINTENANCE|DISABLED/i.test(avail)) return { tone: 'warn', text: avail.toLowerCase() };

  // PERMANENT UNTIL SOMEBODY ACTS.
  if (/AUTH|CREDENTIAL|KEY/i.test(ready) && !/READY|PRESENT|OK/i.test(ready)) {
    return { tone: 'bad', text: ready.toLowerCase().replace(/_/g, ' ') };
  }
  if (/UNAVAILABLE|DOWN|FAILED/i.test(avail)) return { tone: 'bad', text: avail.toLowerCase() };

  if (/AVAILABLE|READY/i.test(avail) || /READY|PRESENT/i.test(ready)) {
    return { tone: 'ok', text: 'ready' };
  }
  return { tone: 'meta', text: avail ? avail.toLowerCase() : 'not tried yet' };
}

function modelRoutesAdapter({ model, onPickRoute = null, readinessOf = null, availabilityOf = null, availabilityRaw = null, currentConnection = null }) {
  const items = [];
  for (const c of model.connections) {
    const here = c.connectionId === currentConnection;
    const name = [c.provider, c.route && c.route !== c.provider ? c.route : null].filter(Boolean).join(' · ');
    const health = routeHealth(c, { readinessOf, availabilityOf, availabilityRaw });
    items.push({
      // WHICH ROUTE, AND WHETHER IT WILL ANSWER, on the row you choose from — rather than one level deeper, which is where it used to be.
      label: `${here ? '● ' : '  '}${(name || c.connectionId).padEnd(28)}${health.text}`,
      tone: health.tone,
      value: c, connection: c,
    });
    items.push({
      label: `      ${c.efforts.length ? c.efforts.join(' · ') : '(no effort levels on this route)'}`,
      selectable: false,
    });
  }
  const at = model.connections.findIndex((c) => c.connectionId === currentConnection);
  return {
    title: `${model.displayName.toUpperCase()}   ·   ${model.connections.length} route${model.connections.length === 1 ? '' : 's'}`,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    cursor: at > 0 ? at * 2 : 0,
    footer: '↑↓ select · Enter open route · ← back · Esc close',
    onSelect(item) {
      if (!item.connection) return undefined;
      return { push: routeDetailAdapter({ model, connection: item.connection, onPickRoute, readinessOf, availabilityOf }) };
    },
  };
}

/** MODEL → ROUTE → EFFORT. */
function routeDetailAdapter({ model, connection, onPickRoute = null, readinessOf = null, availabilityOf = null }) {
  const c = connection;
  const items = [
    { label: `  connection    ${c.connectionId}`, selectable: false },
    { label: `  provider      ${c.provider}  ·  via ${c.via}`, selectable: false },
    { label: `  credential    ${c.auth}`, selectable: false },
  ];
  if (readinessOf) items.push({ label: `  readiness     ${readinessOf(c)}`, selectable: false });
  if (availabilityOf) items.push({ label: `  availability  ${availabilityOf(c)}`, selectable: false });
  items.push({ label: '', selectable: false });

  if (c.efforts.length) {
    items.push({ label: '  EFFORT', selectable: false });
    for (const e of c.efforts) items.push({ label: `    ${e}`, value: e, effort: e });
  } else {
    // Not an error and not an empty list: this route genuinely exposes none,
    // and selecting it is still the right action.
    items.push({ label: '  This route exposes no effort levels.', selectable: false });
    items.push({ label: '    use this route', value: null, useRoute: true });
  }

  return {
    title: `${model.displayName.toUpperCase()}   ·   ${c.provider}`,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter use · ← back · Esc close',
    onSelect(item) {
      if (!item.effort && !item.useRoute) return undefined;
      if (onPickRoute) onPickRoute(model, c, item.effort || null);
      return { close: { model: model.id, connection: c.connectionId, effort: item.effort || null } };
    },
  };
}

/** `/provider` — availability + connection state. No health checks, no polling. */
function providerAdapter({ connections = [], availabilityOf = () => 'UNKNOWN' }) {
  const items = [];
  for (const c of connections) {
    items.push({ label: c.id, value: c.id });
    items.push({ label: `    availability: ${availabilityOf(c.id)}`, selectable: false });
    items.push({ label: `    provider:     ${c.provider}  ·  via ${c.via}`, selectable: false });
    items.push({ label: `    credential:   ${c.auth}`, selectable: false });
    items.push({ label: `    readiness:    ${c.readiness}`, selectable: false });
    items.push({ label: `    models:       ${c.models.length}`, selectable: false });
    items.push({ label: '', selectable: false });
  }
  if (!items.length) items.push({ label: '  no connections configured', selectable: false });
  return { title: 'PROVIDERS', kind: KIND.PROVIDER_SELECTION, mode: MODE.EXPANDED, items, footer: '↑↓ select · Enter select · Esc close' };
}

/** `/config` — reads the EXISTING config store; there is no second one. */
function configAdapter({ cfg, keys = null, editors = {} }) {
  const shown = keys || ['model', 'connection', 'effort', 'maxSteps', 'stream'];
  return {
    title: 'CONFIG',
    kind: KIND.CONFIG,
    mode: MODE.EXPANDED,
    items: shown.map((k) => ({
      label: `${k.padEnd(14)}${pad(fmt(cfg[k]), 34)}${editors[k] ? '' : '(read-only)'}`,
      value: k,
      key: k,
    })),
    footer: '↑↓ navigate · Enter change · Esc close',
    onSelect(item) {
      const edit = editors[item.key];
      if (typeof edit !== 'function') return undefined;      // nothing to do
      const outcome = edit(cfg);
      // An editor either hands back another panel to drill into, or it applied
      // the change itself and we redraw this list with the new value.
      if (outcome && outcome.push) return { push: outcome.push };
      return { push: configAdapter({ cfg, keys, editors }) };
    },
  };
}

function fmt(v) {
  if (v === null || v === undefined) return 'auto';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return String(v);
}

/** `ask_user` / MCQ — choices rendered deterministically from the tool input. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** How much of an option is a CHOICE, and how much is its explanation. */
function splitOption(text) {
  // WHAT A ROW SAYS is ui/answer.js's question, not this one.
  const s = require('./answer').optionText(text).replace(/\s+/g, ' ').trim();
  // A model writes `Left panel — keeps the toolbar clear, but hides it on mobile`: the part before the dash is the choice, the rest is why.
  const m = /^(.{1,60}?)\s+[—–-]\s+(.+)$/.exec(s);
  if (m) return { choice: m[1].trim(), why: m[2].trim() };
  if (s.length <= 60) return { choice: s, why: '' };
  return { choice: s.slice(0, 57).trimEnd() + '…', why: s };
}

/** `ask_user` — TWO LEVELS, because a question and its reasoning are different sizes. */

function confirmAdapter({ question, yes = 'Yes', no = 'No' }) {
  return {
    title: 'CONFIRM',
    kind: KIND.CONFIRM,
    mode: MODE.COMPACT,
    items: [
      { label: question, selectable: false },
      { label: '', selectable: false },
      { label: yes, value: true },
      { label: no, value: false },
    ],
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

/** `/` — the command palette. */
/** A `token description` row, columns aligned — and a real gap even when the token overruns the column. */
function twoCol(left, desc, col) {
  const l = String(left == null ? '' : left);
  const gap = l.length + 2 <= col ? col - l.length : 2;
  return l + ' '.repeat(gap) + String(desc == null ? '' : desc);
}

function commandPaletteAdapter({ commands = [], filter = '' }) {
  const f = String(filter || '').toLowerCase();
  const matches = commands.filter((c) => c.name.startsWith(f));
  // WHAT YOU TYPED IN FULL IS WHAT YOU MEANT
  matches.sort((a, b) => Number(b.name === f) - Number(a.name === f));
  const items = matches.map((c) => ({
    label: twoCol(c.name + (c.args ? ' ' + c.args : ''), c.desc || '', 30),
    value: c.name,
    command: c.name,
  }));
  if (!items.length) items.push({ label: `no command matches "${filter}"`, selectable: false });
  return {
    title: 'COMMANDS',
    kind: KIND.COMMAND_PALETTE,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Tab complete · Enter run · Esc cancel',
  };
}

/** `@` — project-relative path completion. */
function fileCompletionAdapter({ entries = [], filter = '' }) {
  const items = entries.map((e) => ({
    label: e.isDir ? e.path : '  ' + e.path,
    value: e.path,
    entry: e,
  }));
  if (!items.length) items.push({ label: `no path matches "@${filter}"`, selectable: false });
  return {
    title: 'FILES',
    kind: KIND.FILE_COMPLETION,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Tab/→ insert · Enter insert · Esc cancel',
  };
}

// `changedFilesAdapter` AND `planStepsAdapter` STOOD HERE, and both are gone.

function helpAdapter({ commands = [] }) {
  return {
    title: 'COMMANDS',
    mode: MODE.EXPANDED,
    items: commands.map((c) => ({ label: twoCol(c.name + (c.args ? ' ' + c.args : ''), c.desc, 24), value: c.name })),
    footer: '↑↓ select · Enter insert · Esc close',
  };
}


/** WHAT A COMMAND SAID — `/status`, `/dash`, `/effort`, a compaction notice. */
function outputAdapter({ title = '', lines = [] }) {
  return {
    title: String(title || '').trim().toUpperCase(),
    mode: MODE.EXPANDED,
    kind: KIND.OUTPUT,
    // WRAPPED, NOT CLIPPED.
    wrap: true,
    // Blank rows are dropped: a command that opens with `\n` to separate itself from a prompt is padding for a scrolling terminal, and this is a box with a…
    items: lines
      .map((l) => String(l == null ? '' : l).replace(/\s+$/, ''))
      .filter((l) => l.trim())
      .map((label) => ({ label, selectable: false })),
    footer: 'Esc close',
  };
}

module.exports = { routeHealth, effortAdapter, modelsAdapter, modelRoutesAdapter, routeDetailAdapter, providerAdapter, configAdapter, fmt, LETTERS, splitOption, confirmAdapter, commandPaletteAdapter, fileCompletionAdapter, helpAdapter, outputAdapter };


// THE QUESTION FRAMES LIVE IN ui/askframes.js — see its header for why.
Object.assign(module.exports, require('./askframes'));
