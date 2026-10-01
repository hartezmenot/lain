'use strict';

/**
 * MCP & SKILLS (Phase 8.1) — how LAIN reaches other applications.
 *
 *   Installed     every MCP server and skill LAIN has, with its state
 *   Discover      (Phase 8.3) the Skills Hub — compatible skills from the sources
 *                 you added (git, skills.sh-style repositories, Hermes / Agent
 *                 Skills folders, a catalog URL), searched in LAIN's index at
 *                 once; inspect → install → validate → enable. Plus the
 *                 well-known MCP integrations, suggested with the exact command
 *   MCP servers   add a stdio / HTTP server; connect, see its tools, resources
 *                 and prompts; disable, remove (its secrets go with it)
 *   Skills        add a folder or a Git repository; validated before it can be
 *                 enabled; scripts inside are named, never run by LAIN on its own
 *   Custom        the add forms
 *
 * Core owns every fact (integrations.js); this file draws and asks.
 */

const HTML = `
<section class="view mcpv" id="vMcp" data-view="mcp" hidden>
  <div class="spane mpane" id="mcpPane"></div>
</section>`;

/**
 * THE LOOK: each group (MCP servers, skills, suggestions, a form) is one flat plane; a server or a skill is a row on
 * it, hairline-separated — name and where it runs, its state on the right, its tools under it, its actions last.
 */
const CSS = `
.mcpv{display:flex;flex-direction:column;min-height:0;height:100%}
.mcpbody{display:flex;flex-direction:column;gap:12px;min-width:0}
.ig-list{display:flex;flex-direction:column;background:var(--surface-base);border-radius:var(--radius-md);padding:4px 18px}
.ig-card{padding:12px 0;border-top:1px solid var(--separator)}
.ig-sec + .ig-card,.ig-list > .ig-card:first-child{border-top:0}
.ig-top{display:flex;align-items:center;gap:12px}
.ig-top .ig-ic{width:28px;height:28px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--surface-raised);color:var(--text-secondary);flex:none}
.ig-top .ig-t{flex:1;min-width:0}
.ig-top .ig-t b{display:block;font:600 13.5px/1.35 var(--sans)}
.ig-top .ig-t small{display:block;color:var(--text-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ig-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:8px;padding-left:40px}
.ig-body .kicker{margin-bottom:4px}
.ig-body .chips{display:flex;flex-wrap:wrap;gap:2px 10px}
.ig-body .chips span{font-size:12.5px;padding:0;border-radius:0;background:none;color:var(--text-secondary)}
.ig-body .chips span.ask{color:var(--warning)}
.ig-body p{margin:0;color:var(--text-secondary);font-size:12.5px;line-height:1.5}
.ig-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;padding-left:40px}
.ig-why{margin-top:6px;padding-left:40px;color:var(--text-muted);font-size:12px}
.ig-sec{margin:14px 0 2px;display:flex;align-items:baseline;gap:10px}
.ig-sec:first-child{margin-top:8px}
.ig-sec h3{font:700 11.5px/1.3 var(--sans);letter-spacing:.12em;text-transform:uppercase;margin:0;color:var(--text-secondary)}
.ig-sec span{color:var(--text-muted);font-size:12px}
.ig-cmd{font:12px var(--mono);background:var(--surface-raised);padding:7px 10px;border-radius:var(--radius-sm);margin-top:8px;overflow-wrap:anywhere}
.ig-form{background:var(--surface-base);border-radius:var(--radius-md);padding:16px 18px;max-width:760px;display:flex;flex-direction:column;gap:10px}
.ig-form label{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--text-secondary)}
.ig-form input,.ig-form textarea{padding:8px 10px;border-radius:var(--radius-sm);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);border:0;font-size:13px;color:var(--text-primary);font-family:inherit}
.ig-form input:focus,.ig-form textarea:focus{box-shadow:inset 0 0 0 1px var(--accent-border)}
.ig-form textarea{min-height:80px;font:12.5px var(--mono)}
.ig-form .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ig-form .note{font-size:12px;color:var(--text-muted);line-height:1.5}
.ig-empty{background:var(--surface-base);border-radius:var(--radius-md);padding:16px 18px}
.ig-empty b{display:block;font:600 14px/1.3 var(--sans);margin-bottom:4px}
.ig-empty p{margin:0;color:var(--text-secondary);font-size:13px;line-height:1.55}
.ig-list .ig-empty{padding:6px 0 12px;background:none}
.ig-empty .ig-acts{padding-left:0}
@media (max-width: 1000px){.ig-body{grid-template-columns:minmax(0,1fr)}}
@media (max-width: 640px){.ig-body,.ig-acts,.ig-why{padding-left:0}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var tab = 'installed';
  var data = null; var loading = false;
  var hub = null; var hq = ''; var hseq = 0;

  async function load() {
    loading = true; draw();
    var r = await L.api('/api/integrations/state', {});
    var h = await L.api('/api/skills/hub', {});
    loading = false;
    data = r && r.ok ? r : { mcp: [], skills: [], catalog: [], recommended: [], why: (r && r.why) || 'could not read' };
    hub = h && h.ok ? h : { sources: [], suggested: [], indexed: 0, installed: [] };
    draw();
  }
  function hubOf(id) { return ((hub && hub.installed) || []).filter(function (k) { return k.id === id; })[0] || null; }
  function tabsBar() {
    var box = L.kit.tabs([['installed', 'Installed'], ['discover', 'Discover'], ['mcp', 'MCP'], ['skills', 'Skills'], ['custom', 'Custom']], tab, function (id) { tab = id; draw(); });
    box.id = 'mcpTabs';
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) { b.setAttribute('data-mcptab', b.getAttribute('data-tab')); });
    return box;
  }
  function btn(label, cls, fn) { var b = el('button', 'fbtn small ' + (cls || ''), label); b.onclick = fn; return b; }
  async function act(route, body, okMsg) {
    var r = await L.api(route, body);
    if (!r || !r.ok) { L.toast((r && r.why) || 'that did not work', true); await load(); return r; }
    if (okMsg) L.toast(okMsg);
    await load();
    return r;
  }

  function stateTag(s) {
    var w = s.state === 'CONNECTED' ? ['ok', 'Connected'] : s.state === 'DISABLED' ? ['', 'Disabled'] : s.state === 'FAILED' ? ['bad', 'Failed'] : s.state === 'CONNECTING' ? ['accent', 'Connecting…'] : ['', 'Not connected'];
    return el('span', 'tag ' + w[0], w[1]);
  }
  function mcpCard(s) {
    var c = el('div', 'ig-card'); c.setAttribute('data-mcp', s.id);
    var top = el('div', 'ig-top');
    var ic = el('span', 'ig-ic'); ic.appendChild(L.icon('mcp', 22)); top.appendChild(ic);
    var t = el('div', 'ig-t'); t.appendChild(el('b', '', s.name));
    t.appendChild(el('small', '', (s.transport === 'http' ? 'HTTP · ' + s.url : 'stdio · ' + s.command + (s.args && s.args.length ? ' ' + s.args.join(' ') : '')) + (s.server ? ' · ' + s.server.name + (s.server.version ? ' ' + s.server.version : '') : '')));
    top.appendChild(t); top.appendChild(stateTag(s));
    c.appendChild(top);
    if (s.capabilities) {
      var body = el('div', 'ig-body');
      var col = function (title, items, cls) { var d = el('div'); d.appendChild(el('div', 'kicker', title)); var ch = el('div', 'chips'); if (!items.length) ch.appendChild(el('span', '', 'none')); items.forEach(function (x) { var sp = el('span', typeof x === 'object' ? x.cls : '', typeof x === 'object' ? x.t : x); if (typeof x === 'object' && x.title) sp.title = x.title; ch.appendChild(sp); }); d.appendChild(ch); body.appendChild(d); };
      col('Tools', s.capabilities.tools.map(function (x) { return { t: x.name, cls: x.readOnly ? '' : 'ask', title: (x.readOnly ? 'read-only — runs without asking. ' : 'changes things — Noema asks before it runs. ') + x.description }; }));
      col('Resources', s.capabilities.resources.map(function (x) { return x.name; }));
      col('Prompts', s.capabilities.prompts.map(function (x) { return x.name; }));
      c.appendChild(body);
    }
    var secrets = Object.keys(s.env || {}).concat(Object.keys(s.headers || {})).filter(function (k) { return (s.env[k] && s.env[k].secret) || (s.headers[k] && s.headers[k].secret); });
    if (secrets.length) c.appendChild(el('div', 'ig-why', 'Secrets (kept in the Windows secret store, never shown to a model): ' + secrets.join(', ')));
    if (s.why) c.appendChild(el('div', 'ig-why', s.why));
    var acts = el('div', 'ig-acts');
    if (s.enabled && s.state !== 'CONNECTED') acts.appendChild(btn('Connect', 'primary', function () { act('/api/integrations/mcp/connect', { id: s.id }, s.name + ' connected'); }));
    if (s.state === 'CONNECTED') acts.appendChild(btn('Disconnect', 'ghost', function () { act('/api/integrations/mcp/disconnect', { id: s.id }); }));
    acts.appendChild(btn(s.enabled ? 'Disable' : 'Enable', 'ghost', function () { act('/api/integrations/mcp/enable', { id: s.id, enabled: !s.enabled }); }));
    acts.appendChild(btn('Remove', 'ghost', async function () { if (await L.confirm('Remove ' + s.name + ' from Noema? Its stored secrets are deleted too. Nothing is uninstalled from your machine.', { ok: 'Remove', danger: true })) act('/api/integrations/mcp/remove', { id: s.id }, 'Removed'); }));
    c.appendChild(acts);
    return c;
  }
  function skillCard(k) {
    var c = el('div', 'ig-card'); c.setAttribute('data-skill', k.id);
    var top = el('div', 'ig-top');
    var ic = el('span', 'ig-ic'); ic.appendChild(L.icon('book', 22)); top.appendChild(ic);
    var hk = hubOf(k.id);
    var from = hk && hk.hub ? 'From ' + hk.hub.source + (hk.hub.version ? ' · v' + hk.hub.version : '') : (k.source === 'git' ? 'Git · ' + (k.repo || '') : 'Folder');
    var t = el('div', 'ig-t'); t.appendChild(el('b', '', k.name)); t.appendChild(el('small', '', from + ' · ' + k.path)); top.appendChild(t);
    if (hk && hk.update && hk.update.updateAvailable) top.appendChild(el('span', 'tag accent', 'Update available'));
    if (hk && hk.update && hk.update.local && hk.update.local.modified) top.appendChild(el('span', 'tag', 'Changed locally'));
    top.appendChild(el('span', 'tag ' + (k.enabled ? 'ok' : ''), k.present ? (k.enabled ? 'Enabled' : 'Disabled') : 'Folder missing'));
    c.appendChild(top);
    var b = el('div', 'ig-body'); var d = el('div'); d.style.gridColumn = '1 / -1'; d.appendChild(el('p', '', k.description || '')); b.appendChild(d); c.appendChild(b);
    var acts = el('div', 'ig-acts');
    acts.appendChild(btn(k.enabled ? 'Disable' : 'Enable', k.enabled ? 'ghost' : 'primary', function () { k.enabled ? act('/api/integrations/skill/enable', { id: k.id, enabled: false }, 'Disabled') : enableSkill(k); }));
    if (hk && hk.update && hk.update.updateAvailable) acts.appendChild(btn('Update…', 'primary', function () { updateSkill(k); }));
    acts.appendChild(btn('Remove', 'ghost', async function () {
      var del = k.source === 'git' ? await L.dialog({ title: 'Remove ' + k.name, text: 'Remove it from Noema. The copy Noema cloned can be deleted too.', ok: 'Remove and delete the copy', cancel: 'Cancel', extra: { label: 'Remove, keep the copy', value: 'keep' } }) : await L.confirm('Remove ' + k.name + ' from Noema? The folder stays where it is.', { ok: 'Remove' });
      if (!del) return;
      act('/api/integrations/skill/remove', { id: k.id, deleteFiles: del === true && k.source === 'git' }, 'Removed');
    }));
    c.appendChild(acts);
    return c;
  }
  function section(pane, title, sub) { var h = el('div', 'ig-sec'); h.appendChild(el('h3', '', title)); if (sub) h.appendChild(el('span', '', sub)); pane.appendChild(h); }
  function empty(pane, title, text, action) { var e = el('div', 'ig-empty'); e.appendChild(el('b', '', title)); e.appendChild(el('p', '', text)); if (action) { var a = el('div', 'ig-acts'); a.appendChild(action); e.appendChild(a); } pane.appendChild(e); }

  function catalogCard(cItem, why) {
    var c = el('div', 'ig-card');
    var top = el('div', 'ig-top');
    var ic = el('span', 'ig-ic'); ic.appendChild(L.icon('mcp', 22)); top.appendChild(ic);
    var t = el('div', 'ig-t'); t.appendChild(el('b', '', cItem.name)); t.appendChild(el('small', '', 'For ' + cItem.for)); top.appendChild(t);
    if (why) top.appendChild(el('span', 'tag accent', 'Recommended'));
    c.appendChild(top);
    if (why) c.appendChild(el('div', 'ig-why', why));
    if (cItem.command) c.appendChild(el('div', 'ig-cmd', cItem.command));
    if (cItem.note) c.appendChild(el('div', 'ig-why', cItem.note));
    var acts = el('div', 'ig-acts');
    acts.appendChild(btn('Add…', 'primary', function () { tab = 'custom'; draw(); var f = document.querySelector('[data-mcpform=stdio]'); if (f) { f.querySelector('[name=name]').value = cItem.name; f.querySelector('[name=command]').value = cItem.command || ''; f.querySelector('[name=command]').focus(); } }));
    if (cItem.homepage) acts.appendChild(btn('Project page', 'ghost', function () { L.hostCall('openExternal', { url: cItem.homepage }); }));
    c.appendChild(acts);
    return c;
  }

  // ---- THE SKILLS HUB (Phase 8.3) ----------------------------------------------------------------------
  /** ENABLE: an executable skill (scripts or dependencies) only after its files are shown and confirmed. */
  async function enableSkill(k) {
    var r = await L.api('/api/integrations/skill/enable', { id: k.id, enabled: true });
    if (r && r.ok) { L.toast('Enabled — the Agent can read it when a task needs it'); load(); return; }
    if (r && r.needsConfirm) {
      var yes = await L.confirm(k.name + ' carries scripts or dependencies:\n\n' + (r.scripts || []).concat(r.dependencies || []).slice(0, 20).join('\n') + '\n\nLAIN never runs them on its own; the Agent may use them in a task, asking you like any other command. Enable it?', { ok: 'Enable', danger: true });
      if (!yes) return;
      await act('/api/integrations/skill/enable', { id: k.id, enabled: true, confirm: true }, 'Enabled');
      return;
    }
    L.toast((r && r.why) || 'not enabled', true);
  }
  /** UPDATE: never a silent overwrite of a local change — View diff · Update and overwrite · Keep local · Duplicate. */
  async function updateSkill(k) {
    var c = await L.api('/api/skills/update', { id: k.id, action: 'check' });
    if (!c || !c.ok) { L.toast((c && c.why) || 'no update', true); return; }
    var text = 'Installed ' + (c.installedVersion || '—') + ' · available ' + (c.available || 'newer') + '.' + (c.local.modified ? '\n\nYou changed this skill locally (' + c.local.changed.concat(c.local.added, c.local.removed).slice(0, 8).join(', ') + '). Updating would replace those changes.' : '');
    var pick = await L.dialog({ title: 'Update ' + k.name, text: text, ok: c.local.modified ? 'Update and overwrite' : 'Update', cancel: 'Keep local', extra: c.local.modified ? { label: 'View diff', value: 'diff' } : null });
    if (pick === 'diff') {
      var d = await L.api('/api/skills/update', { id: k.id, action: 'diff' });
      var pre = ((d && d.diff) || []).map(function (x) { return '== ' + x.file + '\n' + x.lines.join('\n'); }).join('\n\n') || 'No differences.';
      var again = await L.dialog({ title: 'Local vs incoming — ' + k.name, pre: pre, ok: 'Update and overwrite', cancel: 'Keep local', extra: { label: 'Duplicate', value: 'duplicate' } });
      pick = again;
    }
    if (pick === 'duplicate') { await act('/api/skills/update', { id: k.id, action: 'duplicate' }, 'Installed the new version beside yours (disabled)'); return; }
    if (pick === true) { var r = await act('/api/skills/update', { id: k.id, action: 'overwrite' }, 'Updated'); if (r && r.disabledForReview) L.toast('The new version adds scripts or dependencies — it waits for you to enable it again.'); return; }
    if (pick === false) await act('/api/skills/update', { id: k.id, action: 'keep' }, 'Kept your copy — this version will not be offered again');
  }
  async function inspectSkill(row) {
    var r = await L.api('/api/skills/inspect', { key: row.key });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not inspect it', true); return; }
    var s = r.skill;
    if (s.compatible === false) { L.dialog({ title: s.name || row.name, text: 'Not a compatible skill: ' + (s.why || 'it has no SKILL.md with a name and a description') + '. Noema does not pretend to support it.', ok: 'Close', cancel: null }); return; }
    var lines = ['Source: ' + s.source.label + (s.source.where ? ' (' + s.source.where + ')' : ''), 'Author: ' + (s.author || 'not stated'), 'Version: ' + (s.version || 'not stated'), 'License: ' + (s.license || 'not stated'),
      'Capabilities it asks for: ' + ((s.capabilities || []).join(', ') || 'none stated'), 'Dependencies: ' + ((s.dependencies || []).join(', ') || 'none'), 'Scripts: ' + ((s.scripts || []).join(', ') || 'none'),
      '', 'Files (' + s.files.length + '):', s.files.slice(0, 60).join('\n'), '', s.policy];
    var go = await L.dialog({ title: s.name, text: s.description, pre: lines.join('\n'), ok: s.executable ? 'Install (disabled)' : 'Install and enable', cancel: 'Close' });
    if (!go) return;
    var ins = await L.api('/api/skills/install', { key: row.key, enable: true });
    if (!ins || !ins.ok) { L.toast((ins && ins.why) || 'not installed', true); return; }
    L.toast(ins.enabled ? s.name + ' installed and enabled' : s.name + ' installed — disabled until you enable it (it carries scripts or dependencies)');
    load();
  }
  function discover(list) {
    var bar = el('div', 'ig-form'); bar.style.flexDirection = 'row'; bar.style.flexWrap = 'wrap'; bar.style.alignItems = 'center';
    var q = document.createElement('input'); q.placeholder = 'Search skills — Godot, release, migration…'; q.value = hq; q.style.flex = '1'; q.style.minWidth = '260px'; q.setAttribute('data-skillq', '1');
    bar.appendChild(q);
    bar.appendChild(btn('Refresh sources', 'ghost', async function () { await L.api('/api/skills/source/refresh', {}); L.toast('Refreshing sources in the background — the list updates when they land.'); setTimeout(function () { load(); }, 4000); }));
    list.appendChild(bar);
    var srcs = (hub && hub.sources) || [];
    list.appendChild(el('div', 'ig-why', (hub ? hub.indexed : 0) + ' skills indexed from ' + srcs.length + ' source' + (srcs.length === 1 ? '' : 's') + (srcs.some(function (s) { return s.error; }) ? ' · a source failed: ' + srcs.filter(function (s) { return s.error; }).map(function (s) { return s.label + ' (' + s.error + ')'; }).join(', ') : '')));
    var out = el('div', 'ig-list'); out.setAttribute('data-skill-results', '1'); list.appendChild(out);
    var run = function () {
      var mine = ++hseq;
      L.api('/api/skills/search', { query: hq, limit: 200 }).then(function (r) {
        if (mine !== hseq || !r || !r.ok) return;
        out.textContent = '';
        r.skills.forEach(function (s) {
          var c = el('div', 'ig-card'); c.setAttribute('data-hubskill', s.key);
          var top = el('div', 'ig-top');
          var ic = el('span', 'ig-ic'); ic.appendChild(L.icon('book', 22)); top.appendChild(ic);
          var tt = el('div', 'ig-t'); tt.appendChild(el('b', '', s.name)); tt.appendChild(el('small', '', s.sourceLabel + (s.version ? ' · v' + s.version : '') + (s.tags.length ? ' · ' + s.tags.slice(0, 5).join(', ') : ''))); top.appendChild(tt);
          if (!s.compatible) top.appendChild(el('span', 'tag', 'Not compatible'));
          else if (s.installed) top.appendChild(el('span', 'tag ok', s.updateAvailable ? 'Installed · update' : 'Installed'));
          else if (s.executable) top.appendChild(el('span', 'tag', 'Has scripts'));
          c.appendChild(top);
          if (s.description) c.appendChild(el('div', 'ig-why', s.description));
          var acts = el('div', 'ig-acts');
          acts.appendChild(btn(s.installed ? 'Inspect' : 'Inspect and install…', s.installed ? 'ghost' : 'primary', function () { inspectSkill(s); }));
          c.appendChild(acts);
          out.appendChild(c);
        });
        if (!r.skills.length) out.appendChild(el('div', 'ig-empty', hq ? 'No indexed skill matches \u201c' + hq + '\u201d.' : 'Nothing indexed yet — add a source below, then Refresh sources.'));
      });
    };
    var timer = null;
    q.oninput = function () { hq = q.value; clearTimeout(timer); timer = setTimeout(run, 60); };
    run();
    section(list, 'Sources', 'where Discover looks — read as files; no other agent runtime is started');
    srcs.forEach(function (s) {
      var c = el('div', 'ig-card'); c.setAttribute('data-hubsource', s.id);
      var top = el('div', 'ig-top'); var tt = el('div', 'ig-t'); tt.appendChild(el('b', '', s.label)); tt.appendChild(el('small', '', s.type + ' · ' + s.where + (s.refreshedAt ? ' · ' + s.count + ' skills, refreshed ' + new Date(s.refreshedAt).toLocaleString() : ' · not fetched yet'))); top.appendChild(tt); c.appendChild(top);
      var acts = el('div', 'ig-acts');
      acts.appendChild(btn('Refresh', 'ghost', async function () { var r = await L.api('/api/skills/source/refresh', { id: s.id, wait: true }); L.toast(r && r.ok && r.results && r.results[0] && r.results[0].ok ? s.label + ': ' + r.results[0].count + ' skills' : ((r && r.results && r.results[0] && r.results[0].why) || 'not refreshed'), !(r && r.ok && r.results && r.results[0] && r.results[0].ok)); load(); }));
      acts.appendChild(btn('Remove source', 'ghost', function () { act('/api/skills/source/remove', { id: s.id }, 'Source removed — installed skills stay'); }));
      c.appendChild(acts); list.appendChild(c);
    });
    ((hub && hub.suggested) || []).forEach(function (s) {
      var c = el('div', 'ig-card');
      var top = el('div', 'ig-top'); var tt = el('div', 'ig-t'); tt.appendChild(el('b', '', s.label)); tt.appendChild(el('small', '', s.compat + ' · ' + s.url)); top.appendChild(tt); top.appendChild(el('span', 'tag', 'Suggested')); c.appendChild(top);
      var acts = el('div', 'ig-acts');
      acts.appendChild(btn('Add source', 'primary', function () { act('/api/skills/source/add', { type: s.type, url: s.url, label: s.label, subdir: s.subdir || '' }, s.label + ' added — Refresh it to index its skills'); }));
      c.appendChild(acts); list.appendChild(c);
    });
    section(list, 'Well-known MCP integrations', 'suggestions — nothing is installed until you add it');
    var recs = (data.recommended || []).map(function (r) { var c = (data.catalog || []).filter(function (x) { return x.key === r.key; })[0]; return c ? { item: c, why: r.why } : null; }).filter(Boolean);
    recs.forEach(function (r) { list.appendChild(catalogCard(r.item, r.why)); });
    (data.catalog || []).forEach(function (c) { if (!recs.some(function (r) { return r.item.key === c.key; })) list.appendChild(catalogCard(c, null)); });
  }

  function customForms(pane) {
    section(pane, 'Add a skill source', 'a Git repository (skills.sh-style), a folder of skills (Hermes / Agent Skills format), or a catalog URL');
    var sf = el('div', 'ig-form'); sf.setAttribute('data-sourceform', '1');
    var sk = el('div', 'seg'); var stype = 'git';
    var sl = el('label', '', 'Repository, folder or catalog'); var sin = document.createElement('input'); sin.placeholder = 'https://github.com/owner/skills · C:\\Skills · https://example.com/skills.json'; sl.appendChild(sin);
    [['git', 'Git repository'], ['folder', 'Local folder'], ['index', 'Catalog URL']].forEach(function (x) { var b = el('button', '', x[1]); b.setAttribute('aria-pressed', String(stype === x[0])); b.onclick = function () { stype = x[0]; Array.prototype.forEach.call(sk.children, function (k) { k.setAttribute('aria-pressed', String(k.textContent === x[1])); }); }; sk.appendChild(b); });
    sf.appendChild(sk); sf.appendChild(sl);
    var sr = el('div', 'row');
    sr.appendChild(btn('Add source', 'primary', async function () { var body = stype === 'folder' ? { type: 'folder', path: sin.value } : { type: stype, url: sin.value }; var r = await act('/api/skills/source/add', body, 'Source added — refreshing it'); if (r && r.ok) { await L.api('/api/skills/source/refresh', { id: r.id, wait: true }); tab = 'discover'; load(); } }));
    sf.appendChild(sr);
    sf.appendChild(el('div', 'note', 'Skills are READ as files into Noema\u2019s own skill store — Noema never starts another agent runtime to run them, and never runs a downloaded script on its own.'));
    pane.appendChild(sf);

    section(pane, 'Add an MCP server', 'you choose what it may use; secrets go to the Windows secret store');
    var f = el('div', 'ig-form'); f.setAttribute('data-mcpform', 'stdio');
    var field = function (label, name, ph, area) { var l = el('label', '', label); var i = document.createElement(area ? 'textarea' : 'input'); i.name = name; i.placeholder = ph || ''; i.spellcheck = false; l.appendChild(i); f.appendChild(l); return i; };
    var kind = el('div', 'seg'); var tr = 'stdio';
    [['stdio', 'Local program (stdio)'], ['http', 'Remote / HTTP']].forEach(function (x) { var b = el('button', '', x[1]); b.setAttribute('aria-pressed', String(tr === x[0])); b.onclick = function () { tr = x[0]; Array.prototype.forEach.call(kind.children, function (k, i) { k.setAttribute('aria-pressed', String(i === (tr === 'stdio' ? 0 : 1))); }); cmd.parentNode.hidden = tr !== 'stdio'; url.parentNode.hidden = tr !== 'http'; }; kind.appendChild(b); });
    f.appendChild(kind);
    var name = field('Name', 'name', 'Godot MCP');
    var cmd = field('Command', 'command', 'npx -y @coding-solo/godot-mcp');
    var url = field('Server URL', 'url', 'https://example.com/mcp'); url.parentNode.hidden = true;
    var env = field('Environment (one KEY=value per line; mark secrets with !KEY=value)', 'env', 'GODOT_PATH=C:\\Godot\\godot.exe\n!API_TOKEN=…', true);
    f.appendChild(el('div', 'note', 'Noema starts a local server with only the environment you give it — never your whole environment. A tool the server does not mark read-only asks you before it runs.'));
    var row = el('div', 'row');
    row.appendChild(btn('Add server', 'primary', async function () {
      var envObj = {}; var secretEnv = []; var headers = {};
      String(env.value || '').split(/\r?\n/).forEach(function (line) { var m = /^\s*(!)?([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(line); if (!m) return; (tr === 'http' ? headers : envObj)[m[2]] = m[3]; if (m[1]) secretEnv.push(m[2]); });
      var body = tr === 'stdio' ? { name: name.value, transport: 'stdio', command: cmd.value, env: envObj, secretEnv: secretEnv } : { name: name.value, transport: 'http', url: url.value, headers: headers, secretHeaders: secretEnv };
      var r = await act('/api/integrations/mcp/add', body, 'Added — Connect it to see its tools');
      if (r && r.ok) { env.value = ''; tab = 'mcp'; draw(); }
    }));
    f.appendChild(row);
    pane.appendChild(f);

    section(pane, 'Add a skill', 'a folder with SKILL.md — validated before it can be enabled');
    var g = el('div', 'ig-form');
    var p = el('label', '', 'Skill folder'); var pin = document.createElement('input'); pin.placeholder = 'C:\\Skills\\godot-scenes'; p.appendChild(pin); g.appendChild(p);
    var r2 = el('div', 'row');
    r2.appendChild(btn('Choose folder…', 'ghost', async function () { var d = await L.ide.pickFolder('Choose the skill folder'); if (d) pin.value = d; }));
    r2.appendChild(btn('Add from folder', 'primary', async function () { var r = await act('/api/integrations/skill/add', { path: pin.value }, 'Skill added (disabled) — enable it when you have read it'); if (r && r.ok) { tab = 'skills'; draw(); } }));
    g.appendChild(r2);
    var rp = el('label', '', 'Or a Git repository'); var rin = document.createElement('input'); rin.placeholder = 'https://github.com/owner/skill.git'; rp.appendChild(rin); g.appendChild(rp);
    var r3 = el('div', 'row');
    r3.appendChild(btn('Clone and add', 'primary', async function () { if (!(await L.confirm('Clone ' + rin.value + ' into Noema\'s skills folder? Nothing in it runs until you enable the skill and a task uses it.', { ok: 'Clone' }))) return; var r = await act('/api/integrations/skill/add', { repo: rin.value }, 'Cloned and added (disabled)'); if (r && r.ok) { tab = 'skills'; draw(); } }));
    g.appendChild(r3);
    g.appendChild(el('div', 'note', 'Scripts inside a skill are listed and never run by Noema on its own — the Agent may use them in a task, with your permission like any other command.'));
    pane.appendChild(g);
  }

  var redrawLater = null;
  function draw() {
    if (L.nav.tab() !== 'mcp') return;
    // A MENU IS OPEN: a redraw would remove the control it is anchored to and close it under the person's hand.
    // The page is redrawn a moment after it closes.
    if (L.popDepth && L.popDepth() > 0) { clearTimeout(redrawLater); redrawLater = setTimeout(draw, 400); return; }
    var host = $('mcpPane'); var keep = host.scrollTop; host.textContent = '';
    var page = el('div', 'u-page wide');
    page.appendChild(L.kit.head('MCP & Skills', 'Connect Noema to the applications you work in, and teach it how your team works.'));
    page.appendChild(tabsBar());
    var pane = el('div', 'mcpbody'); page.appendChild(pane); host.appendChild(page);
    if (!data) { pane.appendChild(el('div', 'u-empty', loading ? 'Reading…' : 'Not read yet.')); if (!loading) load(); return; }
    var list = el('div', 'ig-list'); pane.appendChild(list);
    var recs = (data.recommended || []).map(function (r) { var c = (data.catalog || []).filter(function (x) { return x.key === r.key; })[0]; return c ? { item: c, why: r.why } : null; }).filter(Boolean);
    if (tab === 'installed') {
      if (recs.length) { section(list, 'This project recommends'); recs.forEach(function (r) { list.appendChild(catalogCard(r.item, r.why)); }); }
      section(list, 'MCP servers', data.mcp.length + ' configured');
      if (!data.mcp.length) empty(list, 'No MCP servers yet', 'An MCP server lets Noema work inside another application — a Godot scene, a Blender file, a browser, a database. Find one in Discover, or describe your own under Custom.', btn('Discover', 'primary', function () { tab = 'discover'; draw(); }));
      data.mcp.forEach(function (s) { list.appendChild(mcpCard(s)); });
      section(list, 'Skills', data.skills.length + ' added');
      if (!data.skills.length) empty(list, 'No skills yet', 'A skill is a folder of instructions (SKILL.md) the Agent reads when a task needs it — how your team builds scenes, releases a build, writes a migration.', btn('Add a skill', 'primary', function () { tab = 'custom'; draw(); }));
      data.skills.forEach(function (k) { list.appendChild(skillCard(k)); });
    } else if (tab === 'discover') {
      discover(list);
    } else if (tab === 'mcp') {
      if (!data.mcp.length) empty(list, 'No MCP servers yet', 'Add one from Available, or describe your own under Custom.', btn('Add a server', 'primary', function () { tab = 'custom'; draw(); }));
      data.mcp.forEach(function (s) { list.appendChild(mcpCard(s)); });
    } else if (tab === 'skills') {
      if (!data.skills.length) empty(list, 'No skills yet', 'Add a skill folder or a Git repository under Custom.', btn('Add a skill', 'primary', function () { tab = 'custom'; draw(); }));
      data.skills.forEach(function (k) { list.appendChild(skillCard(k)); });
    } else customForms(list);
    host.scrollTop = keep;
  }

  L.mcpView = { load: load, show: function (t) { if (t) tab = t; L.nav.go('mcp'); } };
  L.onBoot(function () {
    L.nav.onShow('mcp', function (o) { if (o && o.section && /^(installed|discover|available|mcp|skills|custom)$/.test(o.section)) tab = o.section === 'available' ? 'discover' : o.section; load(); });
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
