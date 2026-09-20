'use strict';

/**
 * SETTINGS — A SCHEMA, CURRENT VALUES, AND VALIDATED UPDATES.
 *
 * ------------------------------------------------------------------------
 * ONLY SETTINGS WITH A BACKEND. Each field names the authority that honours it:
 *
 *   general.startAtLogin     src/startup.js — a per-user Startup-folder
 *                            shortcut to LAIN.exe (only when LAIN.exe exists)
 *   general.closeToTray      native/host.cs OnClosing — FIXED behaviour, shown
 *   general.background       Core outlives the window — FIXED behaviour, shown
 *   general.maxSteps         cfg.maxSteps, honoured by turn.js
 *   models.defaultCoding     cfg.model — the process default for Coding
 *   models.defaultChat       cfg.defaultChat — applied to NEW engineering
 *                            sessions (sessionroutes `POST /api/session/new`)
 *   paths.defaultProjectRoot cfg.defaultProjectRoot — offered by
 *                            `POST /api/project/recent` and "Add project"
 *   paths.nodePath           cfg.nodePath — noderesolve.js; the launcher reads
 *                            it at build time, so a change needs a restart
 *   notifications.*          cfg.notifications — src/notify.js
 *   privacy.trustedDirectories  cfg.trustedPaths — trust.js; `forget` removes one
 *
 * Read-only facts (detected Node, config and session directories, model
 * sources, messaging connections) are fields with `editable: false`.
 *
 * Settings with no backend are NOT listed — no theme, no accent, no update
 * channel — because a switch that does nothing is worse than no switch.
 *
 * ------------------------------------------------------------------------
 * A FRONTEND NEVER WRITES A CONFIG PATH. It sends `{key, value}` for a key in
 * the schema; this file validates, applies through the owner, saves, and says
 * whether a restart is needed. An unknown key is refused.
 */

const fs = require('fs');
const path = require('path');

function root(app) { return (app && app._sibling) || app; }
function cfgOf(app) { return root(app).cfg; }

function save(app) { require('./config').save(cfgOf(app)); }

function launcher() {
  try { const p = require('./desktop').launcherPath(); return fs.existsSync(p) ? p : null; } catch { return null; }
}

function notif(cfg, k) {
  const n = cfg.notifications || {};
  return n[k] !== false;
}

/**
 * §55 — functional state only: DISCONNECTED / WAITING (bridge up, extension
 * has not registered yet) / CONNECTED, plus the count Settings actually
 * needs. "Installed" is not reported — Node has no way to ask Chrome's own
 * extension list, and a guess dressed as a fact is worse than the honest
 * three states this bridge can actually observe. See src/lainchrome.js.
 */
function chromeField(app) {
  const c = require('./lainchrome').existing(app);
  const s = c ? c.status() : { connected: false, extensionSeen: false, authorizedTabs: [] };
  const state = !s.connected ? 'DISCONNECTED' : !s.extensionSeen ? 'WAITING_FOR_EXTENSION' : 'CONNECTED';
  return { state, authorizedTabCount: s.authorizedTabs.length };
}

/** The whole schema, with current values. Cheap: no browser, no network. */
async function schema(app) {
  const cfg = cfgOf(app);
  const exe = launcher();
  const node = (() => { try { return require('./noderesolve').find({ cfg }); } catch (e) { return { ok: false, why: e.message }; } })();
  const sources = await (async () => {
    try {
      const v = await require('./modelsource/registry').overview(app);
      return v.sources.map((s) => ({ source: s.source, label: s.label, kind: s.kind, state: s.state, why: s.why || '' }));
    } catch { return []; }
  })();
  const config = require('./config');
  const f = (key, label, type, value, extra = {}) => ({ key, label, type, value, editable: true, supported: true, restartRequired: false, ...extra });
  return {
    sections: [
      {
        id: 'GENERAL', label: 'General', fields: [
          f('general.startAtLogin', 'Start LAIN when I sign in to Windows', 'boolean',
            require('./startup').enabled(),
            process.platform !== 'win32' ? { supported: false, editable: false, why: 'Windows only' }
              : !exe ? { supported: false, editable: false, why: 'LAIN.exe is not installed yet — run the installer or `lain --desktop` once' } : {}),
          f('general.closeToTray', 'Closing the window keeps LAIN running in the tray', 'boolean', true,
            { editable: false, why: 'Quit from the tray icon ends LAIN.' }),
          f('general.background', 'Work, background tasks and messaging continue while the window is hidden', 'boolean', true,
            { editable: false }),
          f('general.maxSteps', 'Tool-step budget per turn (0 = no limit)', 'integer', Number(cfg.maxSteps) || 0, { min: 0, max: 10000 }),
        ],
      },
      {
        id: 'MODELS', label: 'Models', fields: [
          f('models.defaultChat', 'Default Chat model for new sessions', 'model',
            cfg.defaultChat && cfg.defaultChat.source ? { source: cfg.defaultChat.source, modelId: cfg.defaultChat.model || null } : null,
            { lane: 'chat', search: 'POST /api/models/search' }),
          f('models.defaultCoding', 'Default Coding model', 'model', cfg.model ? { source: 'lain', modelId: cfg.model } : null,
            { lane: 'coding', search: 'POST /api/models/search' }),
          f('models.sources', 'Model sources', 'list', sources, { editable: false }),
          f('models.customs', 'Customs… (custom providers)', 'info', 'Add or edit custom providers with /api in the LAIN terminal.', { editable: false }),
        ],
      },
      {
        id: 'PATHS', label: 'Paths & projects', fields: [
          f('paths.defaultProjectRoot', 'Default folder for projects', 'directory', cfg.defaultProjectRoot || null),
          f('paths.nodePath', 'Node.js executable (empty = find it)', 'file', cfg.nodePath || null, { restartRequired: true }),
          f('paths.detectedNode', 'Node.js LAIN uses', 'text', node.ok ? node.exe : null, { editable: false, why: node.ok ? node.how : node.why }),
          f('paths.configDir', 'LAIN settings folder', 'directory', config.configDir(), { editable: false }),
          f('paths.sessionsDir', 'Sessions folder', 'directory', config.sessionsDir(), { editable: false }),
        ],
      },
      {
        id: 'CONNECTIONS', label: 'Connections', fields: [
          f('connections.messaging', 'Telegram, Discord and WhatsApp', 'link', { view: 'bot', route: 'POST /api/bot/connections' }, { editable: false }),
          f('connections.webModels', 'Website model sign-in', 'list',
            sources.filter((s) => s.kind === 'WEB').map((s) => ({ source: s.source, label: s.label, state: s.state, connect: { route: 'POST /api/source/connect', body: { source: s.source } } })),
            { editable: false }),
          f('connections.chrome', 'LAIN for Chrome — tabs you explicitly authorize', 'link', chromeField(app),
            { editable: false, connect: { route: 'POST /api/chrome/connect' }, disconnect: { route: 'POST /api/chrome/disconnect' } }),
        ],
      },
      {
        id: 'NOTIFICATIONS', label: 'Notifications', fields: [
          f('notifications.completion', 'When work finishes or is verified', 'boolean', notif(cfg, 'completion')),
          f('notifications.errors', 'When a turn fails or verification fails', 'boolean', notif(cfg, 'errors')),
          f('notifications.needsInput', 'When LAIN is waiting for me', 'boolean', notif(cfg, 'needsInput')),
        ],
      },
      {
        id: 'PRIVACY', label: 'Privacy & security', fields: [
          f('privacy.trustedDirectories', 'Folders LAIN may work in', 'list',
            (cfg.trustedPaths || []).filter((e) => e && e.path).map((e) => ({ path: e.path, level: e.level, at: e.at || null })),
            { editable: false, actions: ['forget'] }),
        ],
      },
    ],
  };
}

function fieldOf(s, key) {
  for (const sec of s.sections) for (const fl of sec.fields) if (fl.key === key) return fl;
  return null;
}

function refuse(key, why) { return { ok: false, key, why }; }

/** UPDATE ONE FIELD. Validated, applied through its owner, saved. */
async function update(app, key, value) {
  const s = await schema(app);
  const field = fieldOf(s, key);
  if (!field) return refuse(key, `"${key}" is not a setting`);
  if (!field.supported) return refuse(key, field.why || 'not supported here');
  if (!field.editable) return refuse(key, `"${field.label}" is not something LAIN can change`);
  const cfg = cfgOf(app);

  switch (key) {
    case 'general.startAtLogin': {
      if (typeof value !== 'boolean') return refuse(key, 'on or off');
      const r = value ? require('./startup').enable(launcher()) : require('./startup').disable();
      if (!r.ok) return refuse(key, r.why);
      break;
    }
    case 'general.maxSteps': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return refuse(key, 'a whole number from 0 (no limit) to 10000');
      cfg.maxSteps = n;
      save(app);
      break;
    }
    case 'models.defaultCoding': {
      const id = value && typeof value === 'object' ? String(value.modelId || '') : String(value || '');
      if (!id) return refuse(key, 'choose a model');
      try { await root(app).ensureCatalog({ announce: false }); } catch { /* resolved below */ }
      const r = require('./catalog').resolve(root(app).catalog(), { model: id, connectionId: null, effort: cfg.effort || null });
      if (!r.ok) return refuse(key, `"${id}" is not served by any configured connection`);
      cfg.model = r.model;
      if (r.connection) cfg.connection = r.connection.baseConnectionId || r.connection.connectionId;
      save(app);
      break;
    }
    case 'models.defaultChat': {
      if (value === null) { delete cfg.defaultChat; save(app); break; }
      const src = String((value && value.source) || '');
      const registry = require('./modelsource/registry');
      if (!registry.DECLARED.some((d) => d.id === src)) return refuse(key, `"${src}" is not a chat source`);
      const model = value.modelId ? String(value.modelId) : null;
      if (src === 'lain' && model) {
        try { await root(app).ensureCatalog({ announce: false }); } catch { /* resolved below */ }
        const r = require('./catalog').resolve(root(app).catalog(), { model, connectionId: null, effort: null });
        if (!r.ok) return refuse(key, `"${model}" is not served by any configured connection`);
        cfg.defaultChat = { source: src, model: r.model };
      } else {
        // A WEBSITE MODEL IS CHECKED WHEN IT IS USED: the account's list is only
        // known after sign-in, and a send refuses a model the site will not take.
        cfg.defaultChat = { source: src, model };
      }
      save(app);
      break;
    }
    case 'paths.defaultProjectRoot': {
      if (value === null || value === '') { delete cfg.defaultProjectRoot; save(app); break; }
      const chk = require('./sessionviews').checkRoot(value);
      if (!chk.ok) return refuse(key, chk.why);
      cfg.defaultProjectRoot = chk.root;
      save(app);
      break;
    }
    case 'paths.nodePath': {
      if (value === null || value === '') { delete cfg.nodePath; save(app); break; }
      const p = String(value);
      if (!path.isAbsolute(p)) return refuse(key, 'give the full path to node.exe');
      if (!require('./noderesolve').usable(p)) return refuse(key, `${p} is not a Node.js executable LAIN can run`);
      cfg.nodePath = p;
      save(app);
      break;
    }
    case 'notifications.completion':
    case 'notifications.errors':
    case 'notifications.needsInput': {
      if (typeof value !== 'boolean') return refuse(key, 'on or off');
      cfg.notifications = { ...(cfg.notifications || {}), [key.split('.')[1]]: value };
      save(app);
      break;
    }
    default:
      return refuse(key, `"${key}" cannot be changed here`);
  }
  const after = fieldOf(await schema(app), key);
  return { ok: true, key, field: after, restartRequired: Boolean(field.restartRequired) };
}

/** A per-item action on a list setting. */
async function action(app, key, act, arg = {}) {
  const cfg = cfgOf(app);
  if (key === 'privacy.trustedDirectories' && act === 'forget') {
    const dir = String((arg && arg.path) || '');
    if (!dir) return refuse(key, 'which folder?');
    const trust = require('./trust');
    const before = (cfg.trustedPaths || []).length;
    cfg.trustedPaths = trust.remember(cfg, dir, trust.LEVEL.UNTRUSTED);
    if (cfg.trustedPaths.length === before) return refuse(key, `${dir} is not in the list`);
    save(app);
    return { ok: true, key, field: fieldOf(await schema(app), key) };
  }
  return refuse(key, `no action "${act}" on "${key}"`);
}

const ROUTES = {
  'GET /api/settings': async (app) => ({ code: 200, body: { ok: true, ...(await schema(app)) } }),
  'POST /api/settings': async (app) => ({ code: 200, body: { ok: true, ...(await schema(app)) } }),
  'POST /api/settings/update': async (app, body = {}) => {
    const r = await update(app, String(body.key || ''), body.value);
    return { code: r.ok ? 200 : 400, body: r };
  },
  'POST /api/settings/action': async (app, body = {}) => {
    const r = await action(app, String(body.key || ''), String(body.action || ''), body.arg || {});
    return { code: r.ok ? 200 : 400, body: r };
  },
};

module.exports = { schema, update, action, ROUTES };
