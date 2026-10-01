'use strict';

/**
 * EXTENSIONS — the whole page (2026-09-30): every source LAIN installs from, in one place.
 *
 *   Extensions                                        [Install from ▾]
 *   Browse, install and manage extensions from every source LAIN supports.
 *   [⌕ Search Open VSX…                       ]   Install to  ( LAIN | This project )
 *   Discover · Installed 4 · On this machine 12 · Updates · Recommended · LAIN plugins
 *   ┌ card ─────────┐ ┌ card ─────────┐ ┌ card ─────────┐
 *   │ ▣ Name  1.2.0 │ │               │ │               │
 *   │ publisher.id  │ │               │ │               │
 *   │ what it does… │ │               │ │               │
 *   │ [Open VSX] [Compatible]         │ │               │
 *   │ [Install] [Inspect]             │ │               │
 *
 * SOURCES: Open VSX (searched, checksum-verified) · VS Code and Cursor on this
 * machine (read-only; one verified copy into LAIN's own store) · a Git
 * repository (https, shallow, never prompts) · a folder · a .vsix file or URL.
 * The Visual Studio Marketplace is OPENED in the browser, never scraped: its
 * terms limit it to Microsoft's products.
 *
 * WHAT A PACKAGE CAN DO IN LAIN is said on every card, from Core's own reading
 * (exthost/manager.js compatibility): Compatible · Needs adapter · Unsupported.
 * Nothing is installed without the person asking.
 */

const HTML = `
<section class="view extv" id="vExt" data-view="ext" hidden>
  <div class="upane" id="extPane"></div>
</section>`;

const CSS = `
.extv{display:flex;flex-direction:column;min-height:0;height:100%}
.ex-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}
.ex-bar .u-search{flex:1;min-width:260px;height:42px}
.ex-bar .u-search input{font-size:var(--fs-body)}
.ex-bar .ex-scope{display:flex;align-items:center;gap:8px;font-size:var(--fs-small);color:var(--text-secondary)}
.ex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.ex-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 14px 12px;border-radius:var(--radius-lg);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator);transition:box-shadow var(--t-hover) var(--ease),transform var(--t-hover) var(--ease)}
.ex-card:hover{box-shadow:inset 0 0 0 1px var(--border-subtle)}
.ex-top{display:flex;gap:12px;align-items:flex-start;min-width:0}
.ex-ic{width:40px;height:40px;border-radius:var(--radius-md);display:grid;place-items:center;flex:none;font:700 14px/1 var(--display);color:var(--on-accent);background:var(--accent-primary)}
.ex-ic.h1{background:var(--accent-secondary);color:var(--on-secondary)} .ex-ic.h2{background:var(--info);color:#fff} .ex-ic.h3{background:var(--accent-tertiary);color:var(--on-tertiary)} .ex-ic.h4{background:var(--warning);color:#1b1405}
.ex-id{min-width:0;flex:1}
.ex-id b{display:flex;align-items:baseline;gap:8px;font-size:var(--fs-body);font-weight:600;color:var(--text-primary);min-width:0}
.ex-id b span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-id b em{font-style:normal;font-weight:400;font-size:var(--fs-caption);color:var(--text-muted);flex:none}
.ex-id small{display:block;font-size:var(--fs-caption);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-desc{font-size:var(--fs-small);color:var(--text-secondary);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.9em}
.ex-tags{display:flex;gap:6px;flex-wrap:wrap}
.ex-tag{font-size:var(--fs-caption);padding:2px 9px;border-radius:999px;background:var(--surface-raised);color:var(--text-secondary);white-space:nowrap}
.ex-tag.ok{background:var(--secondary-weak);color:var(--accent-secondary)} .ex-tag.adapt{background:color-mix(in srgb,var(--info) 14%,transparent);color:var(--info)}
.ex-tag.no{background:var(--warning-weak);color:var(--warning)} .ex-tag.bad{background:var(--danger-weak);color:var(--danger)} .ex-tag.on{background:var(--accent-weak);color:var(--accent-primary)}
.ex-acts{display:flex;gap:6px;align-items:center;margin-top:auto;padding-top:4px}
.ex-acts .spacer{flex:1}
.ex-note{margin-top:18px;font-size:var(--fs-small);color:var(--text-muted);line-height:1.55;max-width:90ch}
.ex-busy{margin:0 0 12px;font-size:var(--fs-small);color:var(--accent-primary)}
.ex-src{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin:0 0 18px}
.ex-srcb{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);text-align:left}
.ex-srcb:hover{background:var(--surface-active)}
.ex-srcb .ic{color:var(--accent-primary);flex:none;margin-top:2px}
.ex-srcb b{display:block;font-size:var(--fs-small);font-weight:600;color:var(--text-primary)}
.ex-srcb small{display:block;font-size:var(--fs-caption);color:var(--text-secondary);line-height:1.4;margin-top:2px}
.ex-cap{display:grid;grid-template-columns:18px minmax(0,1fr);gap:4px 8px;font-size:var(--fs-small);padding:4px 0;border-top:1px solid var(--separator)}
.ex-cap:first-child{border-top:0}
.ex-cap .ic{margin-top:2px}
.ex-cap.ok .ic{color:var(--positive)} .ex-cap.no .ic{color:var(--warning)}
.ex-cap small{grid-column:2;color:var(--text-muted);font-size:var(--fs-caption)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var X = { tab: 'discover', scope: 'global', q: '', results: null, searching: false, list: null, workspace: false, found: null, updates: null, recs: [], plugins: null, busy: '' };

  // ---- READS -------------------------------------------------------------------------------------------------------
  async function load() {
    var got = await Promise.all([
      L.api('/api/extensions/list', {}).catch(function () { return null; }),
      L.api('/api/plugins/list', {}).catch(function () { return null; }),
      L.api('/api/workspace/vscode', {}).catch(function () { return null; }),
      L.api('/api/extensions/discover', {}).catch(function () { return null; }),
    ]);
    X.list = got[0] && got[0].ok ? got[0].extensions : [];
    X.workspace = Boolean(got[0] && got[0].workspace);
    if (!X.workspace) X.scope = 'global';
    X.plugins = got[1] && got[1].ok ? got[1].plugins : [];
    X.recs = got[2] && got[2].ok && got[2].present ? (got[2].recommendations || []) : [];
    X.found = got[3] && got[3].ok ? got[3].found : [];
    draw();
  }
  async function search() {
    var q = X.q.trim();
    if (!q) { X.results = null; draw(); return; }
    X.searching = true; X.tab = 'discover'; draw();
    var r = await L.api('/api/extensions/search', { query: q }).catch(function () { return null; });
    X.searching = false;
    X.results = r && r.ok ? r.results : [];
    if (!r || !r.ok) L.toast((r && r.why) || 'Open VSX could not be searched.', true);
    draw();
  }
  async function loadUpdates() {
    X.updates = null; draw();
    var r = await L.api('/api/extensions/updates', {}).catch(function () { return null; });
    X.updates = r && r.ok ? r.updates : [];
    if (r && !r.ok) L.toast(r.why, true);
    draw();
  }
  async function act(label, fn) {
    if (X.busy) return;
    X.busy = label; draw();
    try { await fn(); } finally { X.busy = ''; }
    await load();
    if (L.extensions && L.extensions.reload) L.extensions.reload();
    if (L.profile && L.profile.reload) L.profile.reload();
  }
  function report(r, done) {
    if (!r || !r.ok) { L.toast((r && r.why) || 'That did not work.', true); return false; }
    L.toast(done(r));
    return true;
  }
  function install(source, label) {
    return act('Installing ' + label + '…', async function () {
      report(await L.api('/api/extensions/install', { source: source, scope: X.scope }), function (x) {
        var e = x.extension;
        return (x.updated ? 'Updated ' : 'Installed ') + e.name + ' ' + e.version + (X.scope === 'workspace' ? ' (this project)' : '') + (e.uses.length ? ' · Noema uses its ' + e.uses.join(', ') : ' · nothing in it that Noema runs');
      });
    });
  }

  // ---- WHAT A PACKAGE CAN DO IN LAIN ------------------------------------------------------------------------------
  /** Compatible · Needs adapter · Unsupported — from Core's own reading; nothing guessed. */
  function stateOf(x) {
    var lvl = x.compatibility ? x.compatibility.level : x.uses ? (x.uses.length ? (x.notUsed && x.notUsed.length ? 'PARTIAL' : 'FULL') : 'UNSUPPORTED') : null;
    if (lvl === 'FULL') return ['ok', 'Compatible'];
    if (lvl === 'PARTIAL') return ['adapt', 'Needs adapter'];
    if (lvl === 'UNSUPPORTED') return ['no', 'Unsupported'];
    return null;
  }
  var SOURCE = { openvsx: 'Open VSX', vsix: '.vsix', folder: 'Folder', url: 'URL', git: 'Git', vscode: 'VS Code', cursor: 'Cursor', store: 'VS Code / Cursor' };
  function initials(name) { var w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/); return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase(); }
  function hueClass(id) { var h = 0; String(id).split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 5; }); return h ? 'h' + h : ''; }
  function card(o) {
    var c = el('div', 'ex-card');
    if (o.id) c.setAttribute('data-ext', o.id);
    var top = el('div', 'ex-top');
    top.appendChild(el('span', 'ex-ic ' + hueClass(o.id || o.name), initials(o.name)));
    var idc = el('div', 'ex-id');
    var b = el('b', ''); b.appendChild(el('span', '', o.name)); if (o.version) b.appendChild(el('em', '', o.version)); idc.appendChild(b);
    idc.appendChild(el('small', '', o.id || ''));
    top.appendChild(idc);
    c.appendChild(top);
    c.appendChild(el('div', 'ex-desc', o.desc || ''));
    var tags = el('div', 'ex-tags');
    (o.tags || []).forEach(function (t) { if (t) tags.appendChild(el('span', 'ex-tag' + (t[0] ? ' ' + t[0] : ''), t[1])); });
    c.appendChild(tags);
    var acts = el('div', 'ex-acts');
    (o.acts || []).forEach(function (a) { if (a) acts.appendChild(a); });
    c.appendChild(acts);
    return c;
  }
  function btn(label, kind, fn, icon) { var b = L.kit.button(label, 'sm ' + (kind || 'line'), fn, icon); b.disabled = Boolean(X.busy); return b; }

  // ---- INSPECT: everything LAIN knows about a package, in a side sheet --------------------------------------------------
  function inspect(o) {
    var sh = L.kit.sheet({ id: 'ext-' + (o.id || o.name), title: o.name, meta: [o.id, o.version].filter(Boolean).join(' · ') });
    var g1 = L.kit.group('Package');
    g1.appendChild(L.kit.kv([['Identifier', o.id], ['Version', o.version], ['Publisher', o.publisher], ['Source', o.sourceText], ['Installed', o.installedAt ? new Date(o.installedAt).toLocaleString() : null], ['Checksum', o.sha256 ? 'sha256 ' + String(o.sha256).slice(0, 16) + '…' : null], ['Scope', o.scope === 'workspace' ? 'This project' : o.scope ? 'Noema' : null]]));
    if (o.desc) g1.appendChild(el('p', 'u-note', o.desc));
    sh.body.appendChild(g1);
    var rows = o.compatRows || [];
    var g2 = L.kit.group('What it can do in Noema');
    if (!rows.length && o.uses) {
      o.uses.forEach(function (u) { rows.push({ ok: true, what: u }); });
      (o.notUsed || []).forEach(function (u) { rows.push({ ok: false, what: u }); });
    }
    if (!rows.length) g2.appendChild(el('div', 'u-note', o.installed ? 'Nothing in it that Noema runs or applies.' : 'Checked when it is installed — Noema reads its package first.'));
    rows.forEach(function (r) {
      var line = el('div', 'ex-cap ' + (r.ok ? 'ok' : 'no'));
      line.appendChild(L.icon(r.ok ? 'check' : 'close', 14));
      line.appendChild(el('span', '', r.what));
      if (r.why) line.appendChild(el('small', '', r.why));
      g2.appendChild(line);
    });
    sh.body.appendChild(g2);
    var g3 = L.kit.group('How it runs');
    g3.appendChild(el('p', 'u-note', 'Extension code runs only in Noema’s own extension host, with the permissions you allow — never in the window, never with your accounts. Snippets, themes and file associations are read as data.'));
    sh.body.appendChild(g3);
    if (o.sheetActs && o.sheetActs.length) { var g4 = L.kit.group('Actions'); var row = el('div', 'u-acts'); o.sheetActs.forEach(function (a) { row.appendChild(a); }); g4.appendChild(row); sh.body.appendChild(g4); }
  }

  // ---- THE TABS ------------------------------------------------------------------------------------------------------
  function installedCards(grid) {
    if (!X.list) { grid.appendChild(el('div', 'u-note', 'Reading…')); return; }
    if (!X.list.length) { grid.appendChild(L.kit.empty('No extensions installed', 'Search Open VSX, reuse one VS Code or Cursor already has, or install from Git, a folder or a .vsix.')); return; }
    X.list.forEach(function (e) {
      var st = stateOf(e);
      var o = { id: e.id, name: e.name, version: e.version, publisher: e.publisher, desc: e.description, installed: true, installedAt: e.installedAt, scope: e.scope, sha256: e.verified && e.verified.sha256, uses: e.uses || [], notUsed: e.notUsed || [],
        sourceText: e.source ? (SOURCE[e.source.kind] || e.source.kind) + (e.source.ref ? ' · ' + e.source.ref : '') : 'unknown' };
      var toggle = btn(e.enabled ? 'Disable' : 'Enable', e.enabled ? 'line' : 'pri', function () { act('…', async function () { report(await L.api('/api/extensions/enable', { id: e.id, scope: e.scope, enabled: !e.enabled }), function (x) { return e.name + (x.enabled ? ' enabled' : ' disabled'); }); }); });
      var remove = function () { return btn('Remove', 'danger', async function () { if (!(await L.confirm('Remove ' + e.name + ' from Noema?', { ok: 'Remove', danger: true }))) return; act('…', async function () { report(await L.api('/api/extensions/uninstall', { id: e.id, scope: e.scope }), function () { return 'Removed ' + e.name; }); }); }); };
      var update = e.source && e.source.kind === 'openvsx' ? function () { return btn('Update', 'line', function () { act('Checking ' + e.name + '…', async function () { report(await L.api('/api/extensions/update', { id: e.id, scope: e.scope }), function (x) { return x.current ? e.name + ' is up to date (' + x.version + ')' : 'Updated ' + e.name + ' to ' + x.extension.version; }); }); }); } : null;
      o.sheetActs = [update && update(), remove()].filter(Boolean);
      o.tags = [[e.enabled ? 'on' : '', e.enabled ? 'Enabled' : 'Disabled'], st, ['', o.sourceText.split(' · ')[0]], e.scope === 'workspace' ? ['', 'This project'] : null];
      var more = L.kit.overflow([update ? { label: 'Update', icon: 'refresh', run: function () { update().click(); } } : null, { label: 'Remove', danger: true, icon: 'trash', run: function () { remove().click(); } }].filter(Boolean));
      o.acts = [toggle, btn('Inspect', 'ghost', function () { inspect(o); }), el('span', 'spacer'), more];
      grid.appendChild(card(o));
    });
  }
  function discoverCards(grid) {
    if (X.searching) { grid.appendChild(el('div', 'u-note', 'Searching Open VSX…')); return; }
    if (!X.results) {
      var src = el('div', 'ex-src');
      [['search', 'Open VSX', 'Search the open registry — every download checked against its published checksum.', function () { var q = $('extQ'); if (q) q.focus(); }],
        ['monitor', 'VS Code & Cursor', 'Reuse what your editors already have — read-only, one verified copy into Noema.', function () { setTab('machine'); }],
        ['branch', 'Git repository', 'Install straight from an https repository — shallow, never prompts for credentials.', fromGit],
        ['folder', 'Folder', 'An unpacked extension on disk, with its package.json.', fromFolder],
        ['package', '.vsix file', 'A packaged extension you downloaded.', fromVsix],
        ['openext', 'Visual Studio Marketplace', 'Opened in your browser — its terms limit it to Microsoft’s products.', function () { L.openExternal('https://marketplace.visualstudio.com/vscode'); }]].forEach(function (s) {
        var b = el('button', 'ex-srcb'); b.appendChild(L.icon(s[0], 18)); var t = el('span', ''); t.appendChild(el('b', '', s[1])); t.appendChild(el('small', '', s[2])); b.appendChild(t); b.onclick = s[3]; src.appendChild(b);
      });
      grid.parentNode.insertBefore(src, grid);
      grid.appendChild(el('div', 'u-note', 'Search above to find extensions on Open VSX.'));
      return;
    }
    if (!X.results.length) { grid.appendChild(L.kit.empty('Nothing found', 'Try another word — or open the Visual Studio Marketplace in your browser.', 'Open Marketplace', function () { L.openExternal('https://marketplace.visualstudio.com/search?target=VSCode&term=' + encodeURIComponent(X.q)); })); return; }
    X.results.forEach(function (x) {
      var have = (X.list || []).some(function (e) { return e.id.toLowerCase() === x.id.toLowerCase() && e.scope === X.scope; });
      var o = { id: x.id, name: x.name, version: x.version, desc: x.description, sourceText: 'Open VSX' };
      o.tags = [['', 'Open VSX'], x.verified ? ['ok', 'Verified publisher'] : null, have ? ['on', 'Installed'] : null];
      o.acts = [btn(have ? 'Reinstall' : 'Install', have ? 'line' : 'pri', function () { install({ openvsx: x.id }, x.name); }, have ? null : 'download'), btn('Inspect', 'ghost', function () { inspect(o); })];
      grid.appendChild(card(o));
    });
  }
  function machineCards(grid) {
    if (!X.found) { grid.appendChild(el('div', 'u-note', 'Looking…')); return; }
    if (!X.found.length) { grid.appendChild(L.kit.empty('Nothing found on this machine', 'No VS Code or Cursor extensions were found.')); return; }
    X.found.forEach(function (f) {
      var st = stateOf(f);
      var o = { id: f.id, name: f.name, version: f.version, desc: f.productLabel + ' · ' + (f.compatibility.level === 'FULL' ? 'works in Noema as it is' : f.compatibility.level === 'PARTIAL' ? 'parts of it work in Noema' : 'nothing in it Noema can use yet'), sourceText: f.productLabel + ' (read-only)', compatRows: f.compatibility.rows };
      o.tags = [['', f.productLabel], st, f.reused ? ['on', 'In Noema ' + f.reused.version] : null];
      var can = f.compatibility.level !== 'UNSUPPORTED' && !(f.reused && f.reused.sameVersion);
      o.acts = [can ? btn(f.reused ? 'Update from ' + f.productLabel : 'Use in Noema', 'pri', function () {
        act('Copying ' + f.name + '…', async function () { report(await L.api('/api/extensions/reuse', { product: f.product, id: f.id }), function (x) { return (x.copied ? 'Copied ' : 'Already stored: ') + f.name + ' ' + x.version + ' — ' + f.productLabel + '’s folder was not changed'; }); });
      }) : null, btn('Inspect', 'ghost', function () { inspect(o); })];
      grid.appendChild(card(o));
    });
  }
  function updateCards(grid) {
    if (!X.updates) { grid.appendChild(el('div', 'u-note', 'Checking…')); if (X.updates === null && !X.busy) { X.updates = undefined; loadUpdates(); } return; }
    if (!X.updates.length) { grid.appendChild(L.kit.empty('Everything is current', 'No installed extension has a newer version on Open VSX or in your editors.')); return; }
    X.updates.forEach(function (u) {
      var o = { id: u.id, name: u.name, version: u.from + ' → ' + u.to, desc: u.via === 'openvsx' ? 'A newer version on Open VSX.' : 'A newer copy in ' + u.product + '.', sourceText: u.via === 'openvsx' ? 'Open VSX' : u.product };
      o.tags = [['on', 'Update available']];
      o.acts = [btn('Update', 'pri', function () {
        act('Updating ' + u.name + '…', async function () {
          if (u.via === 'openvsx') report(await L.api('/api/extensions/update', { id: u.id, scope: u.scope }), function () { return 'Updated ' + u.name; });
          else report(await L.api('/api/extensions/reuse', { product: u.product, id: u.id }), function () { return 'Updated ' + u.name + ' from ' + u.product; });
          X.updates = null;
        });
      }, 'refresh')];
      grid.appendChild(card(o));
    });
  }
  function recCards(grid) {
    var recs = (X.recs || []).filter(function (id) { return !(X.list || []).some(function (e) { return e.id.toLowerCase() === String(id).toLowerCase(); }); });
    if (!recs.length) { grid.appendChild(L.kit.empty('No recommendations', 'This project recommends nothing in .vscode/extensions.json — or everything it recommends is installed.')); return; }
    recs.forEach(function (id) {
      var o = { id: id, name: id.split('.').slice(1).join('.') || id, desc: 'Recommended by this project (.vscode/extensions.json). Installed from Open VSX when it is published there.', sourceText: 'Open VSX' };
      o.tags = [['', 'Recommended']];
      o.acts = [btn('Install', 'pri', function () { install({ openvsx: id }, id); }, 'download')];
      grid.appendChild(card(o));
    });
  }
  function pluginCards(grid) {
    if (!X.plugins) { grid.appendChild(el('div', 'u-note', 'Reading…')); return; }
    if (!X.plugins.length) grid.appendChild(L.kit.empty('No Noema plugins', 'Noema plugins are Noema’s own packages: their commands run as Coding Agent turns, limited to the permissions you grant.'));
    X.plugins.forEach(function (p) {
      var o = { id: p.id, name: p.name || p.id, version: p.version, desc: p.broken || p.description || '', sourceText: 'Noema plugin' };
      o.tags = [[p.enabled ? 'on' : '', p.broken ? 'Broken' : p.enabled ? 'Enabled' : 'Disabled'], ['', (p.permissions || []).join(', ') || 'read']];
      o.acts = [p.broken ? null : btn(p.enabled ? 'Disable' : 'Enable…', p.enabled ? 'line' : 'pri', async function () {
        if (p.enabled) { act('…', async function () { report(await L.api('/api/plugins/disable', { id: p.id }), function () { return p.name + ' disabled'; }); }); return; }
        var extra = (p.permissions || []).filter(function (x) { return x !== 'read'; });
        if (!(await L.confirm(p.name + ' asks to ' + (extra.length ? 'read the project and: ' + extra.join(', ') : 'read the project only') + '.\n\nIts commands run as Coding Agent turns, and Noema refuses any tool outside these permissions.', { ok: 'Grant and enable' }))) return;
        act('…', async function () { report(await L.api('/api/plugins/enable', { id: p.id, grant: p.permissions }), function () { return p.name + ' enabled'; }); });
      })];
      grid.appendChild(card(o));
    });
    var add = btn('Install plugin from folder…', 'line', async function () {
      var r = await L.hostCall('pickFolder', { title: 'A Noema plugin folder (with lain-plugin.json)' });
      if (!r || !r.ok || r.cancelled || !r.path) return;
      act('Installing…', async function () { report(await L.api('/api/plugins/install', { folder: r.path }), function (x) { return 'Installed ' + x.plugin.name + ' — disabled until you grant ' + x.plugin.permissions.join(', '); }); });
    }, 'folder');
    grid.parentNode.appendChild(add);
  }

  // ---- INSTALL FROM ------------------------------------------------------------------------------------------------------
  async function fromGit() {
    var v = await L.dialog({ title: 'Install from Git', text: 'An https repository with the extension’s package.json at its root — or name a folder after #. Noema makes a shallow clone that never asks for a password, then installs it like a folder.', fields: [{ key: 'url', label: 'Repository', placeholder: 'https://github.com/owner/repo' }, { key: 'ref', label: 'Branch or tag (optional)', placeholder: 'main' }], ok: 'Install' });
    if (v && v.url && v.url.trim()) install({ git: v.url.trim(), ref: (v.ref || '').trim() || null }, v.url.trim().split('/').pop());
  }
  async function fromFolder() {
    var p = await L.hostCall('pickFolder', { title: 'An unpacked extension (with package.json)' });
    if (p && p.ok && !p.cancelled && p.path) install({ folder: p.path }, p.path.split(/[\\/]/).pop());
  }
  async function fromVsix() {
    var p = await L.hostCall('pickFile', { title: 'Install an extension', kind: 'vsix' });
    if (p && p.ok && !p.cancelled && p.path) install({ vsix: p.path }, p.path.split(/[\\/]/).pop());
  }
  async function fromUrl() {
    var v = await L.dialog({ title: 'Install from a URL', text: 'An https link to a .vsix file.', fields: [{ key: 'url', label: 'URL', placeholder: 'https://…/extension.vsix' }], ok: 'Install' });
    if (v && v.url) install({ url: v.url.trim() }, v.url.trim());
  }

  function setTab(t) { X.tab = t; if (t === 'updates' && X.updates === undefined) X.updates = null; draw(); }
  var redrawLater = null;
  function draw() {
    if (L.nav.tab() !== 'ext') return;
    if (L.popDepth && L.popDepth() > 0) { clearTimeout(redrawLater); redrawLater = setTimeout(draw, 400); return; }
    var host = $('extPane'); var keep = host.scrollTop; host.textContent = '';
    var page = el('div', 'u-page wide');
    var from = L.kit.select('Install from', [{ label: 'Git repository…', icon: 'branch', run: fromGit }, { label: 'Folder…', icon: 'folder', run: fromFolder }, { label: '.vsix file…', icon: 'package', run: fromVsix }, { label: 'URL…', icon: 'link', run: fromUrl }], { id: 'ext-from', alignRight: true });
    from.classList.add('u-btn', 'line');
    page.appendChild(L.kit.head('Extensions', 'Browse, install and manage extensions from every source Noema supports — Open VSX, VS Code and Cursor on this machine, Git, a folder or a .vsix.', [from]));
    var bar = el('div', 'ex-bar');
    var sb = el('label', 'u-search'); sb.appendChild(L.icon('search', 16));
    var q = el('input', ''); q.id = 'extQ'; q.placeholder = 'Search Open VSX…'; q.value = X.q; q.spellcheck = false;
    q.oninput = function () { X.q = q.value; };
    q.onkeydown = function (e) { if (e.key === 'Enter') search(); if (e.key === 'Escape') { X.q = ''; X.results = null; draw(); } };
    sb.appendChild(q); bar.appendChild(sb);
    var sc = el('div', 'ex-scope'); sc.appendChild(el('span', '', 'Install to'));
    var seg = L.kit.segmented([['global', 'Noema'], ['workspace', 'This project']], X.scope, function (id) { if (id === 'workspace' && !X.workspace) { L.toast('Open a project to install into it.', true); seg.set(X.scope); return; } X.scope = id; });
    sc.appendChild(seg); bar.appendChild(sc);
    page.appendChild(bar);
    var n = function (a) { return a ? a.length : ''; };
    page.appendChild(L.kit.tabs([['discover', 'Discover'], ['installed', 'Installed', n(X.list)], ['machine', 'On this machine', n(X.found)], ['updates', 'Updates'], ['recommended', 'Recommended', (X.recs || []).length || ''], ['plugins', 'Noema plugins', n(X.plugins)]], X.tab, setTab));
    if (X.busy) page.appendChild(el('div', 'ex-busy', X.busy));
    var grid = el('div', 'ex-grid');
    page.appendChild(grid);
    if (X.tab === 'installed') installedCards(grid);
    else if (X.tab === 'machine') machineCards(grid);
    else if (X.tab === 'updates') updateCards(grid);
    else if (X.tab === 'recommended') recCards(grid);
    else if (X.tab === 'plugins') pluginCards(grid);
    else discoverCards(grid);
    page.appendChild(el('div', 'ex-note', 'Extensions are VS Code packages. Noema uses what its API supports — each one says Compatible, Needs adapter or Unsupported, and why — and runs extension code only in its own host, with the permissions you allow. Noema plugins are Noema’s own: their commands run as Coding Agent turns. MCP servers live in MCP & Skills.'));
    host.appendChild(page);
    host.scrollTop = keep;
  }

  L.extPage = { open: function (tab) { L.nav.go('ext', { tab: tab }); } };
  L.onBoot(function () {
    L.nav.onShow('ext', function (o) {
      if (o && o.tab) X.tab = o.tab;
      if (o && o.focus) X.tab = 'machine';
      draw();
      load();
    });
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
