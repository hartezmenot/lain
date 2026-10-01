'use strict';

/**
 * LAIN.contract — THE FRONTEND'S CLIENT FOR docs/HARNESS_UI_CONTRACT.md.
 *
 * ------------------------------------------------------------------------
 * NO DOM. It draws nothing and owns no layout: every action in the contract as
 * a function, plus Core's events (`session.status`, `wake`) as subscriptions.
 * The visual layer (page*.js) calls these and renders `/api/state`; it never
 * needs to know a route path, a request shape or how an event arrives.
 *
 * EMITTED FROM A REAL FUNCTION'S SOURCE (`client.toString()`), not from a
 * template literal, so nothing in it needs escaping and a backtick cannot end
 * the page. The function runs in the renderer only.
 */

/* eslint-disable no-var, prefer-arrow-callback, func-names -- renderer ES5 style, matching the other page scripts */
function client() {
  var L = window.LAIN = window.LAIN || {};
  var host = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  var listeners = {};
  var waiting = {};
  var seq = 0;
  var statuses = {};

  function emit(type, payload) {
    (listeners[type] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { /* one listener never breaks another */ }
    });
  }

  if (host) {
    host.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.wake) { emit('wake', {}); return; }
      if (m.event && m.event.type) {
        if (m.event.type === 'session.status' && m.event.session) statuses[m.event.session] = m.event.status;
        emit(m.event.type, m.event);
        return;
      }
      if (typeof m.id === 'string' && waiting[m.id]) {
        var done = waiting[m.id];
        delete waiting[m.id];
        done(m);
      }
    });
  }

  /** The shared transport when the shell provides one; otherwise its own. */
  function call(path, body) {
    if (typeof L.api === 'function') return L.api(path, body);
    if (!host) return Promise.reject(new Error('this page is not running inside Noema Desktop'));
    return new Promise(function (resolve, reject) {
      var id = 'c' + (++seq);
      var timer = setTimeout(function () { delete waiting[id]; reject(new Error('the desktop host did not answer')); }, 180000);
      waiting[id] = function (m) {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error)); else resolve(m.body);
      };
      host.postMessage({ id: id, method: body === undefined ? 'GET' : 'POST', path: path, body: body || {} });
    });
  }

  function post(path) {
    return function (body) { return call(path, body || {}); };
  }

  L.contract = {
    /** Subscribe to a Core event: 'session.status' or 'wake'. Returns an unsubscribe. */
    on: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return function () { listeners[type] = (listeners[type] || []).filter(function (x) { return x !== fn; }); };
    },
    /** The latest status an event delivered for a session, or null. */
    statusOf: function (sessionId) { return statuses[sessionId] || null; },

    state: function () { return call('/api/state'); },

    // ---- sessions and views
    newSession: post('/api/session/new'),
    selectSession: post('/api/session/select'),
    closeSession: post('/api/session/close'),
    deleteSession: post('/api/session/delete'),
    selectView: function (view, extra) { return call('/api/view/select', Object.assign({ view: view }, extra || {})); },
    send: function (view, text, extra) { return call('/api/turn', Object.assign({ view: view, text: text }, extra || {})); },
    stop: post('/api/interrupt'),
    answer: post('/api/ask/answer'),

    // ---- models
    searchModels: function (modelLane, query, extra) { return call('/api/models/search', Object.assign({ lane: modelLane, query: query || '' }, extra || {})); },
    selectModel: function (modelLane, source, model, extra) { return call('/api/models/select', Object.assign({ lane: modelLane, source: source, model: model }, extra || {})); },
    discoverModels: function (source, refresh) { return call('/api/source/models', { source: source, refresh: Boolean(refresh) }); },
    connectSource: function (source) { return call('/api/source/connect', { source: source }); },

    // ---- plans and handoff
    draftPlan: post('/api/plan/draft'),
    editPlan: function (id, text) { return call('/api/plan/edit', { id: id, text: text }); },
    deferPlan: function (id) { return call('/api/plan/defer', { id: id }); },
    acceptPlan: function (id) { return call('/api/plan/accept', { id: id }); },
    completePlan: function (id) { return call('/api/plan/complete', { id: id }); },
    discardHandoff: post('/api/handoff/discard'),

    // ---- workspace panels
    panel: function (action, panel, extra) { return call('/api/workspace/panel', Object.assign({ action: action, panel: panel }, extra || {})); },

    // ---- project files
    projectState: post('/api/project/state'),
    attachProject: function (path) { return call('/api/project/attach', { path: path }); },
    recentProjects: post('/api/project/recent'),
    tree: function (path) { return call('/api/files/tree', { path: path || '' }); },
    openFile: function (path) { return call('/api/files/open', { path: path }); },
    findFiles: function (q) { return call('/api/files/find', { q: q }); },
    diff: function (path) { return call('/api/files/diff', { path: path }); },
    pin: function (path, from, to) { return call('/api/files/pin', { path: path, from: from, to: to }); },
    unpin: function (path) { return call('/api/files/unpin', { path: path }); },

    // ---- dev server
    devServer: {
      status: post('/api/devserver/status'),
      start: post('/api/devserver/start'),
      stop: post('/api/devserver/stop'),
      restart: post('/api/devserver/restart'),
      probe: function (path) { return call('/api/devserver/probe', { path: path || '/' }); },
    },

    // ---- bot connections
    bot: {
      connections: function (check) { return call('/api/bot/connections', { check: Boolean(check) }); },
      service: function (action) { return call('/api/bot/service', { action: action }); },
      connectTelegram: function (token) { return call('/api/bot/telegram/connect', { token: token }); },
      checkTelegram: post('/api/bot/telegram/check'),
      candidates: post('/api/bot/telegram/candidates'),
      approve: function (senderId) { return call('/api/bot/telegram/approve', { senderId: senderId }); },
      revoke: function (senderId) { return call('/api/bot/telegram/revoke', { senderId: senderId }); },
      disconnectTelegram: post('/api/bot/telegram/disconnect'),
    },

    // ---- settings
    settings: {
      get: function () { return call('/api/settings', {}); },
      update: function (key, value) { return call('/api/settings/update', { key: key, value: value }); },
      action: function (key, action, arg) { return call('/api/settings/action', { key: key, action: action, arg: arg || {} }); },
    },
  };

  // A STATUS EVENT IS ALSO A REASON TO READ STATE AGAIN, so a shell that only
  // polls still shows a background session's change at once.
  L.contract.on('session.status', function () { if (typeof L.poll === 'function') L.poll(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { js, client };
