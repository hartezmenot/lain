'use strict';

/**
 * THE HOUSE, IN THE WINDOW — the doors, the Focus workspace, and which room.
 *
 * ------------------------------------------------------------------------
 * ONE HANDLER PER DOOR. Core's house.js names every capability (ide.open_file,
 * settings.open_mcp, model.add_api_key …). When the BOT walks through a
 * navigate door, /api/state carries `navigate.capability` and the window runs
 * the handler registered here — the SAME function the hover menus
 * (pagequick.js), Home's search and the views' own buttons call. There is no
 * second copy of any flow, and no handler here holds state of its own: each
 * one calls the owner (L.ide, L.source, L.keys, L.nav …).
 *
 * ------------------------------------------------------------------------
 * THE FOCUS WORKSPACE IS /focus, AND /focus IS THE IDE. Leaving the IDE does
 * not close it: the editors, tabs and selection stay in the window
 * (pagesource.js keeps them while the view is hidden), and the window keeps
 * the list of open files and the file in front in its OWN storage (per project
 * root) — presentation state, not Core's — so a restart brings the same
 * workspace back. `L.focus.enter()` is how any surface —
 * Chat's "Open in /focus →", the BOT, the task — goes back to it: the IDE,
 * the AGENT tab when the Agent carries the task, and the task's RELEVANT
 * files (the ones it changed) — not every file it ever read.
 *
 * ------------------------------------------------------------------------
 * WHICH ROOM. Every navigation is reported (POST /api/journey/surface) so the
 * session's path reads "Chat → Agent → IDE → edit → BOT", and the BOT can say
 * where the person is. Navigation only.
 */

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;

  function S() { return L.state() || {}; }
  function tabFirst(tab, opts, fn) { if (L.nav.tab() !== tab) L.nav.go(tab, opts || {}); else if (opts) L.nav.go(tab, opts); if (fn) setTimeout(fn, 0); }

  // ---- the Focus workspace -------------------------------------------------------
  var restored = false;
  function attachedRoot() { var s = S(); var p = s.workspace && s.workspace.project; return p && p.attached ? p.root : null; }

  /** Open files into the IDE without taking the one in front away from the person. */
  function openSome(paths, front) {
    if (!L.source || !paths || !paths.length) return;
    var open = (L.source.state().open || []).map(function (f) { return f.path; });
    var want = paths.filter(function (p) { return p && open.indexOf(p) < 0; }).slice(0, 6);
    var chain = Promise.resolve();
    want.forEach(function (p) { chain = chain.then(function () { return L.source.openFile(p); }).catch(function () { /* a file that is gone is skipped */ }); });
    if (front) chain = chain.then(function () { return L.source.openFile(front); }).catch(function () {});
    return chain;
  }

  /**
   * ENTER /focus. `o.task` (default: the Agent's task) chooses the AGENT tab
   * and the task's changed files; with nothing to continue it is simply the IDE
   * as it was left.
   */
  function enter(o) {
    o = o || {};
    L.nav.go('ide');
    var sp = S().journey || {};
    var t = sp.agentTask;
    if (t && o.agent !== false && L.botpane) L.botpane.show('agent');
    var files = (o.files || (t && t.files) || []).slice(0, 5);
    if (files.length) openSome(files, o.front || files[0]);
    if (o.path) openSome([o.path], o.path).then(function () { if (o.line) L.source.gotoLine(o.line); });
  }

  /**
   * AFTER A RESTART: the IDE's tabs come back from Core's record of the Focus
   * workspace — once, when the project is loaded and nothing is open yet.
   */
  function focusKey(root) { return 'lain.focus.' + String(root || '').toLowerCase(); }
  /** Remember the workspace: open files, the one in front, the caret. Window storage only. */
  var lastSaved = '';
  function saveFocus() {
    var root = attachedRoot();
    if (!root || !L.source || !restored) return;
    var st = L.source.state();
    var open = (st.open || []).filter(function (f) { return f.kind === 'text'; }).map(function (f) { return f.path; }).slice(0, 12);
    var cur = L.source.current && L.source.current();
    var pos = L.source.cursor ? L.source.cursor() : null;
    var v = JSON.stringify({ root: root, open: open, active: cur ? cur.path : null, cursor: pos ? { line: pos.line, col: pos.col } : null, groups: L.groups ? L.groups.serialize() : null });
    if (v === lastSaved) return;
    lastSaved = v;
    try { localStorage.setItem(focusKey(root), v); } catch (e) { /* storage unavailable: nothing is restored, nothing breaks */ }
  }
  function restore() {
    if (restored || L.nav.tab() !== 'ide' || !L.source) return;
    var root = attachedRoot();
    var f = null;
    try { f = JSON.parse(localStorage.getItem(focusKey(root)) || 'null'); } catch (e) { f = null; }
    if (!root) return;
    if (!f || !f.open || !f.open.length || f.root !== root) { restored = true; return; }
    if ((L.source.state().open || []).length) { restored = true; return; }
    restored = true;
    openSome(f.open.slice(0, 8), f.active).then(function () {
      if (f.active && f.cursor && L.source.gotoLine) L.source.gotoLine(f.cursor.line);
      // THE SPLIT GROUPS come back with the tabs (window state, pagegroups.js).
      if (f.groups && L.groups) L.groups.restore(f.groups);
    });
  }

  // ---- the doors ------------------------------------------------------------------
  var DOORS = {
    'ide.enter_focus': function (a) { enter(a); },
    'ide.open_project': function (a) { if (a && a.path) L.ide.open(a.path); else L.ide.openProject(); },
    'ide.new_project': function () { L.ide.newProject(); },
    'ide.recent_projects': function () { tabFirst('ide'); },
    'ide.open_file': function (a) { enter({ agent: false, path: a.path, line: a.line }); },
    'ide.open_symbol': function (a) { enter({ agent: false, path: a.path, line: a.line }); },
    'ide.show_problems': function () { tabFirst('ide', null, function () { L.ide.showPanel('PROBLEMS'); }); },
    'chat.open': function () { L.nav.go('chat'); },
    'chat.new': function () { L.chat.newChat(); },
    'model.open': function (a) { L.nav.go('model', { section: (a && a.section) || null }); },
    'model.add_api_key': function (a) { tabFirst('model', null, function () { L.keys.add((a && a.provider) || null); }); },
    'model.add_account': function () { L.nav.go('model', { section: 'accounts' }); },
    'model.connect_provider': function () { L.nav.go('model', { section: 'overview' }); },
    'model.refresh': function () { if (L.nav.tab() !== 'model') L.nav.go('model'); if (L.dash) L.dash.refresh(); },
    'bot.add_telegram': function () { L.nav.go('bot', { section: 'telegram' }); },
    'bot.add_whatsapp': function () { L.nav.go('bot', { section: 'whatsapp' }); },
    'bot.open_settings': function () { L.nav.go('bot', { section: 'identity' }); },
    // THE ASSISTANT (assistant/doors.js): its settings and the Schedules view where a model task's policy is confirmed.
    'assistant.open': function () { L.nav.go('bot', { section: 'assistant' }); },
    'assistant.schedule': function () { L.nav.go('chat', { section: 'schedules' }); },
    'session.open': function (a) { L.nav.go('session', { id: a && a.id }); },
    'settings.open': function (a) { L.nav.go('settings', { section: (a && a.section) || null }); },
    'settings.open_mcp': function () { L.nav.go('settings', { section: 'mcp' }); },
    'settings.open_skills': function () { L.nav.go('settings', { section: 'skills' }); },
    // /focus — the same doors the BOT and the palette's "LAIN:" commands walk through.
    'focus.pick_element': function () { L.nav.go('ide'); if (LAIN.workshop && LAIN.workshop.startPick) LAIN.workshop.startPick(); },
    'focus.ask_bot': function () {
      L.nav.go('ide');
      if (L.botpane) L.botpane.show('bot');
      setTimeout(function () { var box = document.getElementById('ask'); if (box) box.focus(); }, 0);
    },
    'focus.move_to_agent': function () { L.nav.go('ide'); if (L.botpane) L.botpane.show('agent'); },
  };

  /**
   * RUN A DOOR THROUGH CORE (house.js) — the one path the BOT takes too. A
   * navigate door comes back through /api/state `navigate` and is applied once
   * by the shell (by sequence number), so the handler above runs exactly once;
   * a read door's answer is returned to the caller to show.
   */
  function invoke(id, args) {
    return L.api('/api/house/run', { id: id, args: args || {} }).then(function (r) {
      if (!r || r.ok === false) { if (L.toast) L.toast((r && r.why) || ('could not run ' + id), true); return r; }
      if (r.kind === 'navigate' && typeof L.poll === 'function') L.poll();
      return r;
    });
  }

  function run(id, args) {
    var fn = DOORS[id];
    if (!fn) return false;
    try { fn(args || {}); } catch (e) { if (window.console) console.error('door ' + id, e); }
    return true;
  }

  // ---- which room ------------------------------------------------------------------
  var lastSurface = '';
  function report() {
    var tab = L.nav.tab();
    var pane = tab === 'ide' && L.botpane ? L.botpane.current() : null;
    var sig = tab + '|' + (pane || '');
    if (sig === lastSurface) return;
    lastSurface = sig;
    L.api('/api/journey/surface', { surface: tab, pane: pane }).then(function () {}, function () {});
  }

  L.house = { run: run, invoke: invoke, has: function (id) { return Boolean(DOORS[id]); }, doors: function () { return Object.keys(DOORS); } };
  L.focus = { enter: enter, restore: restore, saveGroups: function () { saveFocus(); } };

  L.onBoot(function () {
    ['home', 'ide', 'chat', 'bot', 'model', 'usage', 'session', 'settings'].forEach(function (t) { L.nav.onShow(t, function () { setTimeout(report, 0); }); });
  });
  L.onRender(function () { report(); restore(); if (L.nav.tab() === 'ide') saveFocus(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { js, client };
