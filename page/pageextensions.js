'use strict';

/**
 * THE IDE'S EXTENSIONS PANE (Ctrl+Shift+X) — four things, kept apart because
 * they are different things:
 *
 *   Extensions       VS Code-format packages. LAIN uses their snippets; their
 *                    code never runs (Core: extensions.js). Open VSX search,
 *                    .vsix, folder or URL; global or this project.
 *   Recommended      the project's own .vscode/extensions.json, offered from
 *                    Open VSX when they are published there.
 *   Import           VS Code / Cursor settings, keys and snippets, previewed
 *                    item by item before anything is written (vscodeimport.js).
 *   LAIN plugins     LAIN's own packages. Enabling one means granting the
 *                    permissions it lists; Core enforces them (plugins.js).
 */

const CSS = `
.xp .xsearch{display:flex;gap:6px;padding:8px 10px 4px}
.xp .xsearch input{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line2);border-radius:var(--radius-s);padding:5px 8px;font-size:12.5px}
.xp .xscope{display:flex;gap:4px;padding:2px 10px 6px;font-size:11.5px;color:var(--faint);align-items:center}
.xp .xscope button{padding:1px 8px;border-radius:10px;border:1px solid var(--line2);color:var(--dim)}
.xp .xscope button[aria-pressed=true]{border-color:var(--accent-line);color:var(--ink)}
.xrow{padding:6px 10px;border-top:1px solid var(--line);font-size:12.5px}
.xrow .xt{display:flex;align-items:center;gap:6px}
.xrow .xt b{font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.xrow .xt .v{color:var(--faint);font-size:11px}
.xrow .xt .spacer{flex:1}
.xrow .tag{font-size:10px;border:1px solid var(--line2);border-radius:8px;padding:0 6px;color:var(--faint);white-space:nowrap}
.xrow .tag.ok{color:var(--ok);border-color:#5aae8466}
.xrow .tag.off{color:var(--warn);border-color:#d8a65066}
.xrow small{display:block;color:var(--faint);font-size:11px;margin-top:2px;overflow-wrap:anywhere}
.xrow .xa{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.xp .xbtns{display:flex;flex-wrap:wrap;gap:4px;padding:4px 10px 8px}
.xp .none{padding:4px 10px;color:var(--faint);font-size:12px}
.xp .xnote{padding:8px 10px 12px;color:var(--faint);font-size:11px;line-height:1.45}
.impdlg{width:min(560px,94vw)}
.impdlg .isec{margin:10px 0 4px;font-size:12.5px;color:var(--ink)}
.impdlg details{font-size:11.5px;color:var(--faint);margin:2px 0 6px}
.impdlg details div{padding:1px 0;overflow-wrap:anywhere}
.impdlg .inote{font-size:11.5px;color:var(--faint);margin:2px 0 6px}
.impdlg label.ck{display:flex;align-items:center;gap:6px;font-size:12.5px;margin:4px 0}
.impdlg .ibody{max-height:52vh;overflow:auto;padding-right:4px}
`;

function client() {
  var L = window.LAIN;
  var el = function (t, c, x) { return L.el(t, c, x); };
  var host = null;
  var E = { scope: 'global', list: null, workspace: false, plugins: null, editors: null, recs: [], q: '', results: null, searching: false, busy: '', view: 'installed', found: null, updates: null };
  var VIEWS = [['search', 'Search'], ['installed', 'Installed'], ['recommended', 'Recommended'], ['updates', 'Updates'], ['machine', 'On this machine']];
  async function loadFound() { var r = await L.api('/api/extensions/discover', {}); E.found = r && r.ok ? r.found : []; draw(); }
  async function loadUpdates() { E.updates = null; draw(); var r = await L.api('/api/extensions/updates', {}); E.updates = r && r.ok ? r.updates : []; if (r && !r.ok) L.toast(r.why, true); draw(); }
  function foundRow(f) {
    var r = el('div', 'xrow');
    r.setAttribute('data-found', f.product + ':' + f.id);
    var t = el('div', 'xt'); t.appendChild(el('b', '', f.name)); t.appendChild(el('span', '', ' ' + f.id + ' ' + f.version)); r.appendChild(t);
    var lvl = f.compatibility.level;
    r.appendChild(el('small', '', f.productLabel + ' · ' + lvl + (lvl !== 'FULL' ? ' — ' + f.compatibility.rows.filter(function (x) { return !x.ok; }).slice(0, 3).map(function (x) { return x.what; }).join(', ') : '') + (f.reused ? ' · in LAIN ' + f.reused.version : '')));
    var a = el('div', 'xa');
    if (lvl !== 'UNSUPPORTED' && !(f.reused && f.reused.sameVersion)) a.appendChild(btn(f.reused ? 'Update from ' + f.productLabel : 'Use in LAIN', function () {
      act('Copying ' + f.name + '…', async function () {
        report(await L.api('/api/extensions/reuse', { product: f.product, id: f.id }), function (x) { return (x.copied ? 'Copied ' : 'Already stored: ') + f.name + ' ' + x.version + ' — ' + f.productLabel + '’s folder was not changed'; });
        loadFound();
      });
    }, 'primary'));
    r.appendChild(a);
    return r;
  }

  async function load() {
    var got = await Promise.all([
      L.api('/api/extensions/list', {}), L.api('/api/plugins/list', {}), L.api('/api/import/detect', {}), L.api('/api/workspace/vscode', {}),
    ]);
    E.list = got[0] && got[0].ok ? got[0].extensions : [];
    E.workspace = Boolean(got[0] && got[0].workspace);
    if (!E.workspace) E.scope = 'global';
    E.plugins = got[1] && got[1].ok ? got[1].plugins : [];
    E.editors = got[2] && got[2].ok ? got[2].editors : [];
    E.recs = got[3] && got[3].ok && got[3].present ? (got[3].recommendations || []) : [];
    draw();
  }

  async function act(label, fn) {
    if (E.busy) return;
    E.busy = label; draw();
    try { await fn(); } finally { E.busy = ''; }
    await load();
    if (L.profile && L.profile.reload) L.profile.reload();
  }

  function report(r, done) {
    if (!r || !r.ok) { L.toast((r && r.why) || 'That did not work.', true); return false; }
    L.toast(done(r));
    return true;
  }

  function install(source, label) {
    return act('Installing ' + label + '…', async function () {
      var r = await L.api('/api/extensions/install', { source: source, scope: E.scope });
      report(r, function (x) {
        var e = x.extension;
        return (x.updated ? 'Updated ' : 'Installed ') + e.name + ' ' + e.version + (E.scope === 'workspace' ? ' (this project)' : '')
          + (e.uses.length ? ' · LAIN uses its ' + e.uses.join(', ') : ' · nothing in it that LAIN runs');
      });
    });
  }

  async function search() {
    var q = E.q.trim();
    if (!q) { E.results = null; draw(); return; }
    E.searching = true; E.view = 'search'; draw();
    var r = await L.api('/api/extensions/search', { query: q });
    E.searching = false;
    E.results = r && r.ok ? r.results : [];
    if (!r || !r.ok) L.toast((r && r.why) || 'Open VSX could not be searched.', true);
    draw();
  }

  function head(box, t, extra) {
    var h = el('div', 'scm-head', t);
    if (extra) { h.appendChild(el('span', 'spacer')); h.appendChild(extra); }
    box.appendChild(h);
  }
  function btn(t, fn, cls) { var b = el('button', 'btn small' + (cls ? ' ' + cls : ''), t); b.disabled = Boolean(E.busy); b.onclick = fn; return b; }

  function installedRow(e) {
    var r = el('div', 'xrow');
    var t = el('div', 'xt');
    t.appendChild(el('b', '', e.name));
    t.appendChild(el('span', 'v', e.version));
    t.appendChild(el('span', 'spacer'));
    if (e.scope === 'workspace') t.appendChild(el('span', 'tag', 'project'));
    if (e.verified && e.verified.sha256) t.appendChild(el('span', 'tag ok', 'sha256 ✓'));
    t.appendChild(el('span', 'tag' + (e.enabled ? ' ok' : ' off'), e.enabled ? 'enabled' : 'disabled'));
    r.appendChild(t);
    r.appendChild(el('small', '', e.id + (e.source ? ' · from ' + e.source.kind : '')));
    if (e.uses && e.uses.length) r.appendChild(el('small', '', 'LAIN uses: ' + e.uses.join('; ')));
    if (e.notUsed && e.notUsed.length) r.appendChild(el('small', '', 'Not used by LAIN: ' + e.notUsed.join('; ')));
    var a = el('div', 'xa');
    a.appendChild(btn(e.enabled ? 'Disable' : 'Enable', function () {
      act('…', async function () { report(await L.api('/api/extensions/enable', { id: e.id, scope: e.scope, enabled: !e.enabled }), function (x) { return e.name + (x.enabled ? ' enabled' : ' disabled'); }); });
    }));
    if (e.source && e.source.kind === 'openvsx') a.appendChild(btn('Update', function () {
      act('Checking ' + e.name + '…', async function () { report(await L.api('/api/extensions/update', { id: e.id, scope: e.scope }), function (x) { return x.current ? e.name + ' is up to date (' + x.version + ')' : 'Updated ' + e.name + ' to ' + x.extension.version; }); });
    }));
    a.appendChild(btn('Uninstall', async function () {
      if (!(await L.confirm('Uninstall ' + e.name + '?', { ok: 'Uninstall', danger: true }))) return;
      act('…', async function () { report(await L.api('/api/extensions/uninstall', { id: e.id, scope: e.scope }), function () { return 'Uninstalled ' + e.name; }); });
    }, 'danger'));
    r.appendChild(a);
    return r;
  }

  function resultRow(x) {
    var r = el('div', 'xrow');
    var t = el('div', 'xt');
    t.appendChild(el('b', '', x.name));
    t.appendChild(el('span', 'v', x.version));
    t.appendChild(el('span', 'spacer'));
    if (x.verified) t.appendChild(el('span', 'tag ok', 'verified publisher'));
    r.appendChild(t);
    r.appendChild(el('small', '', x.id + (x.description ? ' — ' + x.description : '')));
    var a = el('div', 'xa');
    var have = (E.list || []).some(function (e) { return e.id.toLowerCase() === x.id.toLowerCase() && e.scope === E.scope; });
    a.appendChild(btn(have ? 'Reinstall' : 'Install', function () { install({ openvsx: x.id }, x.name); }, have ? '' : 'primary'));
    r.appendChild(a);
    return r;
  }

  function pluginRow(p) {
    var r = el('div', 'xrow');
    var t = el('div', 'xt');
    t.appendChild(el('b', '', p.name || p.id));
    t.appendChild(el('span', 'v', p.version || ''));
    t.appendChild(el('span', 'spacer'));
    t.appendChild(el('span', 'tag' + (p.enabled ? ' ok' : ' off'), p.broken ? 'broken' : p.enabled ? 'enabled' : 'disabled'));
    r.appendChild(t);
    if (p.broken) { r.appendChild(el('small', '', p.broken)); return r; }
    if (p.description) r.appendChild(el('small', '', p.description));
    r.appendChild(el('small', '', 'Permissions: ' + p.permissions.join(', ')));
    var notRun = [];
    if (p.notRun && p.notRun.hooks) notRun.push('hooks (not run in this build)');
    if (p.notRun && p.notRun.mcp) notRun.push('MCP servers ' + p.mcp.map(function (m) { return m.name; }).join(', ') + ' (add them in Settings › MCP yourself)');
    if (p.notRun && p.notRun.skills) notRun.push('skills (listed; LAIN has no skill loader yet)');
    if (notRun.length) r.appendChild(el('small', '', 'Declared, not run: ' + notRun.join('; ')));
    var a = el('div', 'xa');
    if (p.enabled) {
      p.commands.forEach(function (c) {
        a.appendChild(btn('▶ ' + c.title, async function () {
          var x = await L.api('/api/plugins/run', { id: p.id, command: c.id });
          if (!x || !x.ok) L.toast((x && x.why) || 'It did not start.', true);
          else { L.toast(c.title + ' — running with ' + p.permissions.join(', ')); L.poll(); }
        }));
      });
      a.appendChild(btn('Disable', function () { act('…', async function () { report(await L.api('/api/plugins/disable', { id: p.id }), function () { return p.name + ' disabled'; }); }); }));
    } else {
      a.appendChild(btn('Enable…', async function () {
        var extra = p.permissions.filter(function (x) { return x !== 'read'; });
        var text = p.name + ' asks to ' + (extra.length ? 'read the project and: ' + extra.join(', ') : 'read the project only') + '.\n\nIts commands run as Coding Agent turns, and LAIN refuses any tool outside these permissions.';
        if (!(await L.confirm(text, { ok: 'Grant and enable' }))) return;
        act('…', async function () { report(await L.api('/api/plugins/enable', { id: p.id, grant: p.permissions }), function () { return p.name + ' enabled'; }); });
      }, 'primary'));
    }
    a.appendChild(btn('Uninstall', async function () {
      if (!(await L.confirm('Uninstall the plugin ' + (p.name || p.id) + '?', { ok: 'Uninstall', danger: true }))) return;
      act('…', async function () { report(await L.api('/api/plugins/uninstall', { id: p.id }), function () { return 'Uninstalled ' + (p.name || p.id); }); });
    }, 'danger'));
    r.appendChild(a);
    return r;
  }

  async function previewImport(ed) {
    var r = await L.api('/api/import/preview', { product: ed.id });
    if (!r || !r.ok) { L.toast((r && r.why) || 'Nothing to import.', true); return; }
    var back = el('div', 'dlg-back');
    var box = el('div', 'dlg impdlg');
    box.setAttribute('role', 'dialog');
    box.appendChild(el('h3', '', 'Import from ' + r.label));
    box.appendChild(el('p', '', 'LAIN reads ' + r.label + '’s files and never changes them. Only what LAIN can apply is imported; everything else is listed below with the reason.'));
    var body = el('div', 'ibody');
    var ck = function (label, on) { var l = el('label', 'ck'); var c = document.createElement('input'); c.type = 'checkbox'; c.checked = on; c.disabled = !on; l.appendChild(c); l.appendChild(el('span', '', label)); body.appendChild(l); return c; };
    var list = function (title, rows) {
      if (!rows.length) return;
      var d = document.createElement('details');
      d.appendChild(el('summary', '', title));
      rows.slice(0, 200).forEach(function (t) { d.appendChild(el('div', '', t)); });
      body.appendChild(d);
    };
    body.appendChild(el('div', 'isec', 'Settings'));
    var cS = ck(r.settings.applied.length + ' editor setting' + (r.settings.applied.length === 1 ? '' : 's') + ' LAIN applies', r.settings.applied.length > 0);
    list('Will apply', r.settings.applied.map(function (s) { return s.key + ' = ' + JSON.stringify(s.value); }));
    list(r.settings.unsupported.length + ' not imported', r.settings.unsupported.map(function (s) { return s.key + ' — ' + s.why; }));
    if (r.settings.theme) body.appendChild(el('div', 'inote', 'Colour theme “' + r.settings.theme + '” is not applied — LAIN keeps its own palette.'));
    body.appendChild(el('div', 'isec', 'Keybindings'));
    var cK = ck(r.keybindings.applied.length + ' keybinding' + (r.keybindings.applied.length === 1 ? '' : 's') + ' for editor commands', r.keybindings.applied.length > 0);
    list('Will apply', r.keybindings.applied.map(function (k) { return k.key + ' → ' + k.from; }));
    list(r.keybindings.unsupported.length + ' not imported', r.keybindings.unsupported.map(function (k) { return (k.key || '?') + ' ' + (k.command || '') + ' — ' + k.why; }));
    body.appendChild(el('div', 'isec', 'Snippets'));
    var cN = ck(r.snippets.count + ' snippet' + (r.snippets.count === 1 ? '' : 's') + (r.snippets.languages.length ? ' for ' + r.snippets.languages.join(', ') : ''), r.snippets.count > 0);
    body.appendChild(el('div', 'isec', 'Extensions (' + r.extensions.length + ')'));
    list('None of these run in LAIN — why, for each', r.extensions.map(function (x) { return x.id + ' ' + x.version + ' — ' + x.why; }));
    box.appendChild(body);
    var acts = el('div', 'dlg-actions');
    var cancel = el('button', 'btn', 'Cancel');
    var go = el('button', 'btn primary', 'Import');
    go.disabled = !(cS.checked || cK.checked || cN.checked);
    [cS, cK, cN].forEach(function (c) { c.onchange = function () { go.disabled = !(cS.checked || cK.checked || cN.checked); }; });
    var close = function () { back.remove(); };
    cancel.onclick = close;
    go.onclick = async function () {
      go.disabled = true;
      var x = await L.api('/api/import/apply', { product: ed.id, settings: cS.checked, keybindings: cK.checked, snippets: cN.checked });
      close();
      if (report(x, function (y) { var i = y.imported; return 'Imported from ' + i.label + ': ' + i.settings + ' settings, ' + i.keybindings + ' keybindings, ' + i.snippets + ' snippets'; })) {
        if (L.profile && L.profile.reload) L.profile.reload();
      }
    };
    acts.appendChild(cancel); acts.appendChild(go);
    box.appendChild(acts);
    back.appendChild(box);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
  }

  function draw() {
    if (!host) return;
    var keepScroll = host.scrollTop;
    host.textContent = '';
    var box = el('div', 'xp');
    // ---- search Open VSX ----
    var s = el('div', 'xsearch');
    var q = document.createElement('input');
    q.placeholder = 'Search Open VSX';
    q.value = E.q;
    q.oninput = function () { E.q = q.value; };
    q.onkeydown = function (e) { if (e.key === 'Enter') search(); };
    s.appendChild(q);
    box.appendChild(s);
    var sc = el('div', 'xscope');
    sc.appendChild(el('span', '', 'Install to'));
    [['global', 'LAIN'], ['workspace', 'This project']].forEach(function (o) {
      var b = el('button', '', o[1]);
      b.setAttribute('aria-pressed', String(E.scope === o[0]));
      b.disabled = o[0] === 'workspace' && !E.workspace;
      b.onclick = function () { E.scope = o[0]; draw(); };
      sc.appendChild(b);
    });
    box.appendChild(sc);
    // ---- the views, as VS Code arranges them ----
    var tabs = el('div', 'xscope');
    VIEWS.forEach(function (v) {
      var b = el('button', '', v[1]);
      b.setAttribute('aria-pressed', String(E.view === v[0]));
      b.setAttribute('data-xview', v[0]);
      b.onclick = function () { E.view = v[0]; if (v[0] === 'machine' && !E.found) loadFound(); if (v[0] === 'updates' && !E.updates) loadUpdates(); draw(); };
      tabs.appendChild(b);
    });
    box.appendChild(tabs);
    if (E.busy) box.appendChild(el('div', 'none', E.busy));
    if (E.searching) box.appendChild(el('div', 'none', 'Searching Open VSX…'));
    if (E.view === 'search') {
      var mk = el('div', 'xbtns');
      // THE MARKETPLACE IS OPENED, NOT SCRAPED: its terms limit it to Microsoft’s products.
      mk.appendChild(btn('Open Marketplace ↗', function () { L.openExternal('https://marketplace.visualstudio.com/search?target=VSCode&term=' + encodeURIComponent(E.q || '')); }));
      box.appendChild(mk);
    }
    if (E.view === 'machine') {
      head(box, 'Installed in VS Code / Cursor' + (E.found ? ' · ' + E.found.length : ''));
      if (!E.found) box.appendChild(el('div', 'none', 'Looking…'));
      else if (!E.found.length) box.appendChild(el('div', 'none', 'No VS Code or Cursor extensions were found.'));
      (E.found || []).forEach(function (f) { box.appendChild(foundRow(f)); });
      box.appendChild(el('div', 'xnote', 'Read-only: LAIN reads each package.json and never writes in the editors’ folders. “Use in LAIN” copies the package once into LAIN’s content-addressed store, verified by hash; its settings and state in LAIN are LAIN’s own.'));
    }
    if (E.view === 'updates') {
      head(box, 'Updates');
      if (!E.updates) box.appendChild(el('div', 'none', 'Checking…'));
      else if (!E.updates.length) box.appendChild(el('div', 'none', 'Everything is current.'));
      (E.updates || []).forEach(function (u) {
        var r = el('div', 'xrow');
        var t = el('div', 'xt'); t.appendChild(el('b', '', u.name)); t.appendChild(el('span', '', ' ' + u.from + ' → ' + u.to)); r.appendChild(t);
        r.appendChild(el('small', '', u.via === 'openvsx' ? 'Open VSX' : 'a newer copy in ' + u.product));
        var a = el('div', 'xa');
        a.appendChild(btn('Update', function () {
          act('Updating ' + u.name + '…', async function () {
            if (u.via === 'openvsx') report(await L.api('/api/extensions/update', { id: u.id, scope: u.scope }), function () { return 'Updated ' + u.name; });
            else report(await L.api('/api/extensions/reuse', { product: u.product, id: u.id }), function () { return 'Updated ' + u.name + ' from ' + u.product; });
            loadUpdates();
          });
        }, 'primary'));
        r.appendChild(a);
        box.appendChild(r);
      });
    }
    if (E.results && E.view === 'search') {
      head(box, 'Open VSX · ' + E.results.length);
      if (!E.results.length) box.appendChild(el('div', 'none', 'Nothing found.'));
      E.results.forEach(function (x) { box.appendChild(resultRow(x)); });
    }
    var xb = el('div', 'xbtns');
    if (E.view !== 'search' && E.view !== 'installed') xb.hidden = true;
    xb.appendChild(btn('Install .vsix…', async function () {
      var p = await L.hostCall('pickFile', { title: 'Install an extension', kind: 'vsix' });
      if (p && p.ok && !p.cancelled && p.path) install({ vsix: p.path }, p.path.split(/[\\/]/).pop());
    }));
    xb.appendChild(btn('From folder…', async function () {
      var p = await L.hostCall('pickFolder', { title: 'An unpacked extension (with package.json)' });
      if (p && p.ok && !p.cancelled && p.path) install({ folder: p.path }, p.path.split(/[\\/]/).pop());
    }));
    xb.appendChild(btn('From URL…', async function () {
      var v = await L.dialog({ title: 'Install from a URL', text: 'An https link to a .vsix file.', fields: [{ key: 'url', label: 'URL', placeholder: 'https://…/extension.vsix' }], ok: 'Install' });
      if (v && v.url) install({ url: v.url.trim() }, v.url.trim());
    }));
    box.appendChild(xb);
    // ---- installed ----
    if (E.view === 'installed') {
      head(box, 'Installed' + (E.list ? ' · ' + E.list.length : ''));
      if (!E.list) box.appendChild(el('div', 'none', 'Reading…'));
      else if (!E.list.length) box.appendChild(el('div', 'none', 'No extensions installed.'));
      (E.list || []).forEach(function (e) { box.appendChild(installedRow(e)); });
    }
    // ---- the project's recommendations ----
    var recs = (E.recs || []).filter(function (id) { return !(E.list || []).some(function (e) { return e.id.toLowerCase() === String(id).toLowerCase(); }); });
    if (E.view === 'recommended' && !recs.length) box.appendChild(el('div', 'none', 'This project recommends nothing (.vscode/extensions.json).'));
    if (recs.length && E.view === 'recommended') {
      head(box, 'Recommended by this project');
      recs.forEach(function (id) {
        var r = el('div', 'xrow');
        var t = el('div', 'xt'); t.appendChild(el('b', '', id)); r.appendChild(t);
        r.appendChild(el('small', '', 'From .vscode/extensions.json. Installed from Open VSX if it is published there.'));
        var a = el('div', 'xa'); a.appendChild(btn('Install from Open VSX', function () { install({ openvsx: id }, id); })); r.appendChild(a);
        box.appendChild(r);
      });
    }
    if (E.view !== 'installed' && E.view !== 'machine') { host.appendChild(box); host.scrollTop = keepScroll; return; }
    // ---- import ----
    head(box, 'Import from VS Code / Cursor');
    var eds = (E.editors || []).filter(function (x) { return x.present; });
    if (!E.editors) box.appendChild(el('div', 'none', 'Looking…'));
    else if (!eds.length) box.appendChild(el('div', 'none', 'Neither VS Code nor Cursor was found on this machine.'));
    eds.forEach(function (x) {
      var r = el('div', 'xrow');
      var t = el('div', 'xt'); t.appendChild(el('b', '', x.label)); r.appendChild(t);
      r.appendChild(el('small', '', [x.settings ? 'settings' : null, x.keybindings ? 'keybindings' : null, x.snippetFiles ? x.snippetFiles + ' snippet files' : null, x.extensions + ' extensions'].filter(Boolean).join(' · ')));
      var a = el('div', 'xa'); a.appendChild(btn('Preview import…', function () { previewImport(x); })); r.appendChild(a);
      box.appendChild(r);
    });
    var cur = L.profile && L.profile.current && L.profile.current();
    var imp = cur && cur.profile && cur.profile.importedFrom;
    if (imp) {
      var r2 = el('div', 'xrow');
      r2.appendChild(el('small', '', 'In use: imported from ' + imp.label + ' ' + new Date(imp.at).toLocaleString() + ' — ' + imp.settings + ' settings, ' + imp.keybindings + ' keybindings, ' + imp.snippets + ' snippets.'));
      var a2 = el('div', 'xa');
      a2.appendChild(btn('Clear imported', async function () {
        if (!(await L.confirm('Remove the imported settings, keybindings and snippets from LAIN? ' + imp.label + ' itself is not affected.', { ok: 'Clear' }))) return;
        act('…', async function () { report(await L.api('/api/editor/profile/clear', {}), function () { return 'Cleared the imported editor profile'; }); });
      }));
      r2.appendChild(a2);
      box.appendChild(r2);
    }
    // ---- LAIN plugins ----
    head(box, 'LAIN plugins' + (E.plugins ? ' · ' + E.plugins.length : ''));
    if (E.plugins && !E.plugins.length) box.appendChild(el('div', 'none', 'No plugins installed.'));
    (E.plugins || []).forEach(function (p) { box.appendChild(pluginRow(p)); });
    var pb = el('div', 'xbtns');
    pb.appendChild(btn('Install plugin from folder…', async function () {
      var p = await L.hostCall('pickFolder', { title: 'A LAIN plugin folder (with lain-plugin.json)' });
      if (!p || !p.ok || p.cancelled || !p.path) return;
      act('Installing…', async function () { report(await L.api('/api/plugins/install', { folder: p.path }), function (x) { return 'Installed ' + x.plugin.name + ' — disabled until you grant ' + x.plugin.permissions.join(', '); }); });
    }));
    box.appendChild(pb);
    box.appendChild(el('div', 'xnote', 'Extensions are VS Code packages. LAIN uses what its API supports — each one says FULL, PARTIAL or UNSUPPORTED and why — and runs extension code only in its own host, with the permissions you allow. LAIN plugins are LAIN’s own: their commands run as Coding Agent turns limited to the permissions you grant. MCP servers live in Settings › MCP; skills are instructions for models.'));
    host.appendChild(box);
    host.scrollTop = keepScroll;
  }

  L.extensions = {
    mount: function (box) { host = box; draw(); load(); },
    reload: load,
  };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
