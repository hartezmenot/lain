'use strict';

/**
 * SETTINGS › DEVELOPMENT — the professional tooling's real state, drawn.
 *
 *   Extensions         what runs, under which permissions, and how much of it
 *                      works: FULL / PARTIAL / UNSUPPORTED with the missing APIs
 *   Language Servers   installed or not, running, crashed, restartable
 *   Runtime Processes  what LAIN runs — from the runtime registry only, never by
 *                      process name — and the one-time legacy leak diagnostic
 *   Focus              what /focus sent: files, tokens, reuse, evidence
 *   Debugging          the debug adapters this machine can run
 *
 * Every figure is read from Core (POST /api/exthost/status, /api/lsp/status,
 * /api/runtime/list, /api/runtime/legacy/scan, /api/focus/metrics,
 * /api/debug/status); every button is a Core route. Nothing is stored here.
 */
const CSS = `
.dv .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:10px;max-width:880px;padding:12px 16px}
.dv .card h4{margin:0 0 4px;font-size:13.5px;display:flex;align-items:center;gap:8px}
.dv .card .sub2{color:var(--faint);font-size:12px;margin-bottom:8px}
.dv .lvl{font-size:10.5px;letter-spacing:.08em;padding:1px 7px;border-radius:10px;border:1px solid var(--line2)}
.dv .lvl.FULL{color:var(--ok);border-color:var(--ok)} .dv .lvl.PARTIAL{color:var(--warn);border-color:var(--warn)} .dv .lvl.UNSUPPORTED{color:var(--bad);border-color:var(--bad)}
.dv .rows{font-size:12.5px;margin:4px 0}
.dv .rows div{padding:1px 0}
.dv .rows .no{color:var(--dim)} .dv .rows .no::before{content:"\\2717  ";color:var(--bad)}
.dv .rows .yes::before{content:"\\2713  ";color:var(--ok)}
.dv .acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.dv table{border-collapse:collapse;font-size:12px;width:100%;max-width:880px;margin-bottom:12px}
.dv th{text-align:left;color:var(--faint);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--line)}
.dv td{padding:4px 8px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11.5px;vertical-align:top}
.dv td.w{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dv .pill{font-size:11px}
.dv .pill.ok{color:var(--ok)} .dv .pill.warn{color:var(--warn)} .dv .pill.bad{color:var(--bad)}
.dv pre{white-space:pre-wrap;font-family:var(--mono);font-size:11.5px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:220px;overflow:auto}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var cache = {};
  var legacy = null;
  var picked = {};

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }
  function btn(label, fn, cls) { var b = el('button', 'btn small' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }
  function head(pane, title, sub) { pane.appendChild(el('h2', '', title)); if (sub) pane.appendChild(el('div', 'sub', sub)); }
  function load(key, route, body) {
    return L.api(route, body || {}).then(function (r) { cache[key] = r; if (L.settings) L.settings.draw(); return r; }, function (e) { cache[key] = { ok: false, why: e && e.message }; if (L.settings) L.settings.draw(); });
  }
  function ensure(key, route) { if (!cache[key]) { cache[key] = { loading: true }; load(key, route); } return cache[key]; }
  function wrap(pane) { var d = el('div', 'dv'); pane.appendChild(d); return d; }

  // ---- Extensions -----------------------------------------------------------------------
  function extensions(pane) {
    head(pane, 'Extensions', 'VS Code-format extensions whose code runs in LAIN’s extension host, each in its own process under the permissions you granted. Compatibility is measured, not claimed.');
    var d = wrap(pane);
    var r = ensure('ext', '/api/exthost/status');
    if (r.loading) { d.appendChild(el('div', 'missing', 'Reading extensions…')); return; }
    var list = (r.extensions || []);
    if (!list.length) { d.appendChild(el('div', 'missing', 'No extensions are installed. Install one from the IDE’s Extensions pane (Ctrl+Shift+X).')); return; }
    list.forEach(function (x) {
      var c = el('div', 'card');
      var h = el('h4');
      h.appendChild(el('span', '', (x.name || x.id) + (x.version ? ' ' + x.version : '')));
      var lvl = (x.compatibility && x.compatibility.level) || 'UNSUPPORTED';
      h.appendChild(el('span', 'lvl ' + lvl, lvl));
      c.appendChild(h);
      c.appendChild(el('div', 'sub2', x.id + ' · ' + (x.scope || '') + ' · ' + (x.enabled ? 'enabled' : 'disabled') + ' · ' + (x.state ? x.state.toLowerCase() : (x.run ? 'allowed, not started' : 'not allowed to run')) + (x.pid ? ' · pid ' + x.pid : '') + (x.why ? ' — ' + x.why : '')));
      var rows = el('div', 'rows');
      ((x.compatibility && x.compatibility.rows) || []).forEach(function (row) { rows.appendChild(el('div', row.ok ? 'yes' : 'no', row.what + (row.why ? ' — ' + row.why : ''))); });
      c.appendChild(rows);
      if (x.grant) c.appendChild(el('div', 'sub2', 'Permissions: ' + Object.keys(x.grant).filter(function (k) { return x.grant[k]; }).join(', ') || 'none'));
      var acts = el('div', 'acts');
      if (x.state === 'RUNNING') { acts.appendChild(btn('Restart', function () { L.api('/api/exthost/restart', { id: x.id, scope: x.scope }).then(function () { load('ext', '/api/exthost/status'); }); })); acts.appendChild(btn('Stop', function () { L.api('/api/exthost/stop', { id: x.id, scope: x.scope }).then(function () { load('ext', '/api/exthost/status'); }); })); }
      else if (x.run && x.enabled && x.code) acts.appendChild(btn('Start', function () { L.api('/api/exthost/start', {}).then(function () { load('ext', '/api/exthost/status'); }); }));
      c.appendChild(acts);
      d.appendChild(c);
    });
    d.appendChild(btn('Refresh', function () { load('ext', '/api/exthost/status'); }));
  }

  // ---- Language servers -------------------------------------------------------------------
  function servers(pane) {
    head(pane, 'Language Servers', 'Deterministic language intelligence for /focus: definitions, references, rename and diagnostics come from these servers, not from a model. LAIN finds installed servers; it downloads nothing on its own.');
    var d = wrap(pane);
    var r = ensure('lsp', '/api/lsp/status');
    if (r.loading) { d.appendChild(el('div', 'missing', 'Reading language servers…')); return; }
    var t = el('table');
    var hr = el('tr'); ['Server', 'Languages', 'State', 'Capabilities', ''].forEach(function (h) { hr.appendChild(el('th', '', h)); }); t.appendChild(hr);
    (r.servers || []).forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', '', s.name + (s.configured ? ' (configured)' : '')));
      tr.appendChild(el('td', 'w', (s.languages || []).join(', ')));
      var st = s.state || (s.available ? 'installed, not started' : 'not installed');
      var cls = s.state === 'READY' ? 'ok' : s.state === 'FAILED' || s.state === 'CRASHED' ? 'bad' : s.available ? '' : 'warn';
      var td = el('td'); td.appendChild(el('span', 'pill ' + cls, st.toLowerCase() + (s.inProject ? ' · used here' : ''))); if (s.why && !s.state) td.appendChild(el('div', 'sub2', s.why)); tr.appendChild(td);
      tr.appendChild(el('td', 'w', (s.capabilities || []).join(', ')));
      var a = el('td');
      if (s.available) a.appendChild(btn(s.state === 'READY' ? 'Restart' : 'Start', function () { L.api('/api/lsp/restart', { id: s.id }).then(function (x) { if (x && x.ok === false && L.toast) L.toast(x.why, true); load('lsp', '/api/lsp/status'); }); }));
      if (s.state === 'READY') a.appendChild(btn('Stop', function () { L.api('/api/lsp/stop', { id: s.id }).then(function () { load('lsp', '/api/lsp/status'); }); }));
      tr.appendChild(a);
      t.appendChild(tr);
    });
    d.appendChild(t);
    d.appendChild(el('div', 'sub', 'Add or override a server in LAIN’s config: lsp.servers = [{ id, command, args, languages, extensions }].'));
    d.appendChild(btn('Refresh', function () { load('lsp', '/api/lsp/status'); }));
  }

  // ---- Runtime processes ---------------------------------------------------------------------
  function runtime(pane) {
    head(pane, 'Runtime Processes', 'What LAIN is running — terminals, language servers, extension hosts, debug adapters, services — read from the runtime registry, where each was recorded by the part of LAIN that started it, with its process identity. Nothing is listed or stopped because of its name.');
    var d = wrap(pane);
    var r = ensure('rt', '/api/runtime/list');
    if (r.loading) { d.appendChild(el('div', 'missing', 'Reading the registry…')); }
    else {
      var t = el('table');
      var hr = el('tr'); ['Purpose', 'Label', 'PID', 'Owner', ''].forEach(function (h) { hr.appendChild(el('th', '', h)); }); t.appendChild(hr);
      (r.processes || []).forEach(function (p) {
        var tr = el('tr');
        tr.appendChild(el('td', '', p.purpose));
        tr.appendChild(el('td', 'w', p.label || p.command || ''));
        tr.appendChild(el('td', '', p.pid));
        tr.appendChild(el('td', 'w', (p.mine ? 'this LAIN' : p.owner) + (p.ownerAlive === false ? ' (owner gone)' : '')));
        var a = el('td');
        a.appendChild(btn('Stop', function () {
          L.confirm('Stop ' + (p.label || p.purpose) + ' (pid ' + p.pid + ')?', { ok: 'Stop', danger: true }).then(function (yes) {
            if (yes) L.api('/api/runtime/stop', { id: p.id }).then(function (x) { if (x && x.ok === false && L.toast) L.toast(x.why, true); load('rt', '/api/runtime/list'); });
          });
        }));
        tr.appendChild(a);
        t.appendChild(tr);
      });
      if (!(r.processes || []).length) { var tr0 = el('tr'); var td0 = el('td', '', 'nothing is running'); td0.colSpan = 5; tr0.appendChild(td0); t.appendChild(tr0); }
      d.appendChild(t);
      d.appendChild(btn('Refresh', function () { load('rt', '/api/runtime/list'); }));
    }

    // THE ONE-TIME LEGACY DIAGNOSTIC — look first; stop only what you select.
    d.appendChild(el('h3', '', 'Leaked test supervisors (before the registry)'));
    d.appendChild(el('div', 'sub', 'Test runs before the runtime registry existed could leave lain-supervisor processes behind. This scan only reports evidence — start time, command line, temporary home, port, parent, and whether current LAIN state references each — and classifies it. Only processes you select, re-checked as verified orphans at that moment, are stopped.'));
    if (!legacy) { d.appendChild(btn('Scan', function () { legacy = { loading: true }; L.settings.draw(); L.api('/api/runtime/legacy/scan', {}).then(function (x) { legacy = x; picked = {}; L.settings.draw(); }); })); return; }
    if (legacy.loading) { d.appendChild(el('div', 'missing', 'Scanning…')); return; }
    var counts = legacy.counts || {};
    d.appendChild(el('div', 'sub2', Object.keys(counts).map(function (k) { return counts[k] + ' ' + k.toLowerCase().replace(/_/g, ' '); }).join(' · ') || 'no candidates'));
    var lt = el('table');
    var lh = el('tr'); ['', 'PID', 'Started', 'Home', 'Parent', 'Class', 'Why'].forEach(function (h) { lh.appendChild(el('th', '', h)); }); lt.appendChild(lh);
    (legacy.candidates || []).forEach(function (c) {
      var tr = el('tr');
      var tdc = el('td');
      if (c.class === 'VERIFIED_ORPHAN') { var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = Boolean(picked[c.id]); cb.onchange = function () { if (cb.checked) picked[c.id] = true; else delete picked[c.id]; }; tdc.appendChild(cb); }
      tr.appendChild(tdc);
      tr.appendChild(el('td', '', c.pid));
      tr.appendChild(el('td', '', c.start ? new Date(c.start).toLocaleString() : '?'));
      var home = el('td', 'w', c.home || '?'); home.title = c.command || ''; tr.appendChild(home);
      tr.appendChild(el('td', '', (c.parent || '?') + (c.parentAlive ? ' (alive)' : '')));
      tr.appendChild(el('td', '', c.class.toLowerCase().replace(/_/g, ' ')));
      tr.appendChild(el('td', 'w', c.why.join('; ')));
      lt.appendChild(tr);
    });
    d.appendChild(lt);
    var acts = el('div', 'acts');
    acts.appendChild(btn('Select all verified orphans', function () { (legacy.candidates || []).forEach(function (c) { if (c.class === 'VERIFIED_ORPHAN') picked[c.id] = true; }); L.settings.draw(); }));
    acts.appendChild(btn('Stop selected', function () {
      var ids = Object.keys(picked);
      if (!ids.length) { if (L.toast) L.toast('Select the verified orphans to stop.', true); return; }
      L.confirm('Stop ' + ids.length + ' selected process(es)? Each is re-checked first; anything no longer a verified orphan is left alone.', { ok: 'Stop them', danger: true }).then(function (yes) {
        if (!yes) return;
        L.api('/api/runtime/legacy/stop', { ids: ids }).then(function (x) {
          var res = (x && x.results) || [];
          var ok = res.filter(function (q) { return q.stopped; }).length;
          if (L.toast) L.toast(ok + ' stopped' + (res.length - ok ? ', ' + (res.length - ok) + ' refused' : ''), res.length - ok > 0);
          legacy = null; picked = {}; L.settings.draw();
        });
      });
    }, 'danger'));
    acts.appendChild(btn('Scan again', function () { legacy = null; picked = {}; L.settings.draw(); }));
    d.appendChild(acts);
  }

  // ---- Focus ---------------------------------------------------------------------------------
  function focus(pane) {
    head(pane, 'Focus', 'What /focus handed the Coding Agent, turn by turn: how far structural narrowing got before any model reasoned, what was reused, and what the turn then cost. Counts only — never prompt text.');
    var d = wrap(pane);
    var r = ensure('focus', '/api/focus/metrics');
    if (r.loading) { d.appendChild(el('div', 'missing', 'Reading…')); return; }
    var sel = r.selection || {};
    d.appendChild(el('div', 'sub2', 'Canonical Selection this session: ' + (sel.resolved || 0) + ' resolved · ' + (sel.carried || 0) + ' carried forward · ' + (sel.hits || 0) + ' served from cache'));
    var t = el('table');
    var hr = el('tr'); ['Kind', 'Project files', 'Candidates', 'Sent', '~Tokens', 'LSP', 'Artifact', 'Requests', 'Whole-file reads'].forEach(function (h) { hr.appendChild(el('th', '', h)); }); t.appendChild(hr);
    (r.metrics || []).slice().reverse().forEach(function (m) {
      var tr = el('tr');
      [m.kind + (m.role ? ' (' + m.role + ')' : ''), m.projectFiles, m.candidateFiles, m.filesSelected, m.approxTokens,
        m.lsp ? (m.lsp.via + (m.lsp.requests != null ? ' ' + m.lsp.requests + ' req / ' + (m.lsp.cached || 0) + ' cached' : '')) : '—',
        m.artifact ? m.artifact.state : '—', m.modelRequests != null ? m.modelRequests : '—', m.fullFileReads != null ? m.fullFileReads : '—'].forEach(function (v) { tr.appendChild(el('td', '', v == null ? '?' : v)); });
      t.appendChild(tr);
    });
    if (!(r.metrics || []).length) { var tr0 = el('tr'); var td0 = el('td', '', 'no /focus turn yet in this session'); td0.colSpan = 9; tr0.appendChild(td0); t.appendChild(tr0); }
    d.appendChild(t);
    var ev = r.evidence || { entries: [] };
    d.appendChild(el('h3', '', 'Addressable evidence (' + ev.entries.length + ')'));
    var et = el('table');
    var eh = el('tr'); ['Id', 'Kind', 'Generation', 'Summary'].forEach(function (h) { eh.appendChild(el('th', '', h)); }); et.appendChild(eh);
    ev.entries.slice(-30).reverse().forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', '', 'evidence:' + e.id));
      tr.appendChild(el('td', '', e.kind));
      tr.appendChild(el('td', '', e.generation + (e.carriedFrom != null ? ' (since ' + e.carriedFrom + ')' : '') + (e.stale ? ' STALE' : '')));
      tr.appendChild(el('td', 'w', e.summary));
      et.appendChild(tr);
    });
    d.appendChild(et);
    d.appendChild(btn('Refresh', function () { load('focus', '/api/focus/metrics'); }));
  }

  // ---- Debugging ---------------------------------------------------------------------------------
  function debugging(pane) {
    head(pane, 'Debugging', 'Debug adapters LAIN can run (Debug Adapter Protocol over stdio). Each runs as an owned process; the IDE’s Debug panel (F5) drives it.');
    var d = wrap(pane);
    var r = ensure('dbg', '/api/debug/status');
    if (r.loading) { d.appendChild(el('div', 'missing', 'Reading…')); return; }
    var t = el('table');
    var hr = el('tr'); ['Adapter', 'Files', 'State'].forEach(function (h) { hr.appendChild(el('th', '', h)); }); t.appendChild(hr);
    (r.adapters || []).forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', '', a.name + (a.configured ? ' (configured)' : '')));
      tr.appendChild(el('td', '', (a.extensions || []).join(' ')));
      var td = el('td'); td.appendChild(el('span', 'pill ' + (a.available ? 'ok' : 'warn'), a.available ? 'available' : 'unavailable')); if (a.why) td.appendChild(el('div', 'sub2', a.why)); tr.appendChild(td);
      t.appendChild(tr);
    });
    d.appendChild(t);
    var s = r.session;
    d.appendChild(el('div', 'sub2', s ? 'Session ' + s.id + ': ' + s.program + ' — ' + s.state.toLowerCase() + (s.why ? ' (' + s.why + ')' : '') : 'No debug session.'));
    d.appendChild(el('div', 'sub', 'Configure another adapter in LAIN’s config: dap.adapters = [{ id, name, command, args, extensions, launch }]; the Python used for debugpy: dap.python.'));
    d.appendChild(btn('Refresh', function () { load('dbg', '/api/debug/status'); }));
  }

  L.devSettings = {
    PAGES: [['extensions', 'Extensions', 'ext'], ['servers', 'Language Servers', 'ide'], ['runtime', 'Runtime Processes', 'terminal'], ['focus', 'Focus', 'preview'], ['debugging', 'Debugging', 'play']],
    draw: function (page, pane) {
      if (page === 'extensions') extensions(pane);
      else if (page === 'servers') servers(pane);
      else if (page === 'runtime') runtime(pane);
      else if (page === 'focus') focus(pane);
      else if (page === 'debugging') debugging(pane);
      else return false;
      return true;
    },
    /** Entering the page reads it fresh. */
    invalidate: function (page) { var key = { extensions: 'ext', servers: 'lsp', runtime: 'rt', focus: 'focus', debugging: 'dbg' }[page]; if (key) delete cache[key]; },
  };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
