'use strict';

/**
 * SETTINGS › ROUTER SERVER and SETTINGS › BOTS & CHANNELS (Phase 8.1).
 *
 *   Router Server   `lain --serve` from the window: on/off, where it listens
 *                   (loopback unless remote access is explicitly allowed), the
 *                   LOCAL LAIN access token (copy / regenerate — never a
 *                   provider key), start with LAIN, how many models it exposes.
 *   Bots & Channels external bots connected to the LAIN house: their own
 *                   reported state (a live process alone is never "working"),
 *                   what each may use here, Migrate only when the bot declares
 *                   it; the assistant's own channels (Telegram …) one click away.
 */

const CSS = `
.rs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:1100px}
.rs-card{background:var(--surface-base);border-radius:16px;padding:20px 24px;min-width:0}
.rs-card h4{display:flex;align-items:center;gap:10px;font:600 18px/1.3 var(--sans);margin:0 0 10px}
.rs-card p{margin:0 0 12px;color:var(--text-secondary);font-size:15px;line-height:1.5}
.rs-kv{display:grid;grid-template-columns:140px minmax(0,1fr);gap:8px 14px;font-size:15px;margin:10px 0 14px}
.rs-kv span{color:var(--text-muted)} .rs-kv b{font-weight:500;overflow-wrap:anywhere}
.rs-kv code{font:14px var(--mono);background:var(--surface-raised);padding:2px 8px;border-radius:6px}
.rs-acts{display:flex;gap:8px;flex-wrap:wrap}
.rs-warn{margin-top:10px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--accent-tertiary) 12%,var(--surface-raised));color:var(--text-primary);font-size:14px}
.bt-list{display:flex;flex-direction:column;gap:12px;max-width:1100px}
.bt-card{background:var(--surface-base);border-radius:16px;padding:18px 22px}
.bt-top{display:flex;align-items:center;gap:12px}
.bt-top b{font:600 17px/1.3 var(--sans)} .bt-top .spacer{flex:1}
.bt-basis{margin-top:8px;color:var(--text-muted);font-size:14px}
.bt-perms{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.bt-perms label{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:var(--surface-raised);font-size:14px;cursor:pointer}
.bt-perms input{width:auto;accent-color:var(--accent-primary)}
@media (max-width: 1000px){.rs-grid{grid-template-columns:minmax(0,1fr)}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var srv = null; var bots = null; var perms = [];
  var redraw = function () { if (L.nav.tab() === 'settings' && L.settings) L.settings.draw(); };
  function btn(label, cls, fn) { var b = el('button', 'fbtn ' + (cls || ''), label); b.onclick = fn; return b; }
  function head(pf, title, sub) { var s = el('div', 'pf-sec'); s.appendChild(el('h3', '', title)); if (sub) s.appendChild(el('p', 'lede', sub)); pf.appendChild(s); }

  // ---- Router Server --------------------------------------------------------------------
  async function loadServer() { var r = await L.api('/api/server/status', {}); srv = r && r.ok ? r : { server: null, why: (r && r.why) || 'not available' }; redraw(); }
  function server(pane) {
    var pf = el('div', 'pf'); pane.appendChild(pf);
    head(pf, 'Router Server', 'Let other applications use the models Noema is connected to — without giving each one your API keys or accounts.');
    if (!srv) { pf.appendChild(el('div', 'missing', 'Reading…')); loadServer(); return; }
    var s = srv.server || {};
    var grid = el('div', 'rs-grid');
    var c1 = el('div', 'rs-card');
    var h = el('h4'); h.appendChild(L.icon('server', 20)); h.appendChild(document.createTextNode('Noema Server')); h.appendChild(el('span', 'tag ' + (s.running ? 'ok' : ''), s.running ? 'On' : 'Off')); c1.appendChild(h);
    var kv = el('div', 'rs-kv');
    var row = function (k, v) { kv.appendChild(el('span', '', k)); var b = el('b'); if (v instanceof Node) b.appendChild(v); else b.textContent = v; kv.appendChild(b); };
    row('Address', s.running ? el('code', '', s.url) : (s.host + ':' + s.port + ' (when on)'));
    row('Models exposed', String(srv.aliases || 0) + ' · as lain/<model>');
    row('Requests', String(s.requests || 0) + ' since it started');
    row('Protocols', (s.protocols || []).join(' · '));
    c1.appendChild(kv);
    var a1 = el('div', 'rs-acts');
    a1.appendChild(btn(s.running ? 'Turn off' : 'Turn on', s.running ? 'ghost' : 'primary', async function () { var r = await L.api(s.running ? '/api/server/stop' : '/api/server/start', {}); if (!r || !r.ok) L.toast((r && r.why) || 'could not change the server', true); loadServer(); }));
    c1.appendChild(a1);
    grid.appendChild(c1);
    var c2 = el('div', 'rs-card');
    var h2 = el('h4'); h2.appendChild(L.icon('shield', 20)); h2.appendChild(document.createTextNode('Access')); c2.appendChild(h2);
    c2.appendChild(el('p', '', 'Clients use a Noema access token. Your provider keys and sign-ins stay inside Noema and never reach a client.'));
    var kv2 = el('div', 'rs-kv');
    kv2.appendChild(el('span', '', 'Access token')); kv2.appendChild(el('b', '', s.token && s.token.present ? (s.token.masked || 'configured') : 'created on first start'));
    kv2.appendChild(el('span', '', 'Listens on')); kv2.appendChild(el('b', '', s.allowRemote ? s.host + ' (remote access allowed)' : 'this computer only (127.0.0.1)'));
    c2.appendChild(kv2);
    var a2 = el('div', 'rs-acts');
    a2.appendChild(btn('Copy token', 'ghost', async function () { var r = await L.api('/api/server/token', { reveal: true }); if (r && r.ok && r.token) { try { await navigator.clipboard.writeText(r.token); L.toast('Noema access token copied'); } catch (e) { L.dialog({ title: 'Noema access token', pre: r.token, ok: 'Close', cancel: 'Close' }); } } }));
    a2.appendChild(btn('Regenerate', 'ghost', async function () { if (!(await L.confirm('Make a new access token? Clients using the old one stop working until you give them the new one.', { ok: 'Regenerate' }))) return; await L.api('/api/server/regenerate', {}); L.toast('New token made — copy it into your clients'); loadServer(); }));
    c2.appendChild(a2);
    grid.appendChild(c2);
    var c3 = el('div', 'rs-card');
    var h3 = el('h4'); h3.appendChild(L.icon('settings', 20)); h3.appendChild(document.createTextNode('Options')); c3.appendChild(h3);
    var port = document.createElement('input'); port.value = String(s.port || 20790); port.style.maxWidth = '120px';
    var kv3 = el('div', 'rs-kv');
    kv3.appendChild(el('span', '', 'Port')); var pb = el('b'); pb.appendChild(port); kv3.appendChild(pb);
    c3.appendChild(kv3);
    var sw = el('label', 'bt-perms'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = Boolean(s.startWithLain); var lab = el('label'); lab.appendChild(cb); lab.appendChild(document.createTextNode('Start with Noema')); sw.appendChild(lab); c3.appendChild(sw);
    var a3 = el('div', 'rs-acts'); a3.style.marginTop = '12px';
    a3.appendChild(btn('Save', 'primary', async function () { var r = await L.api('/api/server/configure', { port: Number(port.value), startWithLain: cb.checked }); if (!r || !r.ok) L.toast((r && r.why) || 'not saved', true); else L.toast(s.running ? 'Saved — turn the server off and on to use the new port' : 'Saved'); loadServer(); }));
    a3.appendChild(btn(s.allowRemote ? 'Back to this computer only' : 'Allow remote access…', 'ghost', async function () {
      if (s.allowRemote) { await L.api('/api/server/configure', { allowRemote: false, host: '127.0.0.1' }); loadServer(); return; }
      var v = await L.dialog({ title: 'Allow remote access?', text: 'Other machines on your network could use your Noema models (and spend your quota) with the access token. Only do this on a network you trust.', fields: [{ key: 'host', label: 'Listen on', value: '0.0.0.0' }], ok: 'Allow', danger: true });
      if (!v) return;
      var r = await L.api('/api/server/configure', { allowRemote: true, host: v.host });
      if (!r || !r.ok) L.toast((r && r.why) || 'not saved', true);
      loadServer();
    }));
    c3.appendChild(a3);
    if (s.allowRemote) c3.appendChild(el('div', 'rs-warn', 'Remote access is on. Anyone on the network with the token can use your models.'));
    grid.appendChild(c3);
    var c4 = el('div', 'rs-card');
    var h4 = el('h4'); h4.appendChild(L.icon('terminal2', 20)); h4.appendChild(document.createTextNode('Use it from a client')); c4.appendChild(h4);
    c4.appendChild(el('p', '', 'Point an OpenAI-compatible client at the address above, use the access token as its API key, and pick a model named lain/<model>. From a terminal: lain --serve'));
    grid.appendChild(c4);
    pf.appendChild(grid);
  }

  // ---- Bots & Channels ------------------------------------------------------------------
  async function loadBots() {
    var r = await L.api('/api/bots/list', {});
    bots = r && r.ok ? r.bots : []; perms = (r && r.permissions) || [];
    redraw();
    for (var i = 0; i < bots.length; i++) { await L.api('/api/bots/status', { id: bots[i].id }); }
    var r2 = await L.api('/api/bots/list', {}); if (r2 && r2.ok) { bots = r2.bots; redraw(); }
  }
  var PERM_LABEL = { projects: 'Projects', schedules: 'Schedules', channels: 'Channels', mcp: 'MCP', skills: 'Skills', delegate: 'Coding Agent delegation', runtime: 'Runtime & account choice' };
  function botsPage(pane) {
    var pf = el('div', 'pf'); pane.appendChild(pf);
    head(pf, 'Bots & Channels', 'External bots can join the Noema house: Noema supervises them and lends them capabilities you allow. Your own assistant is Chat.');
    var top = el('div', 'rs-acts'); top.style.marginBottom = '18px';
    top.appendChild(btn('Connect a bot…', 'primary', async function () {
      var v = await L.dialog({ title: 'Connect a bot', text: 'The bot stays where it runs; Noema only reads its status and lends it what you allow. A bot reports its state at a status address (JSON: state, task).', fields: [{ key: 'name', label: 'Name', value: '' }, { key: 'statusUrl', label: 'Status address (optional)', value: '', placeholder: 'http://127.0.0.1:8080/status' }], ok: 'Connect' });
      if (!v) return;
      var r = await L.api('/api/bots/connect', { name: v.name, statusUrl: v.statusUrl || null, permissions: {} });
      if (!r || !r.ok) L.toast((r && r.why) || 'not connected', true); else L.toast('Connected — choose what it may use');
      loadBots();
    }));
    top.appendChild(btn('Assistant channels (Telegram …)', 'ghost', function () { L.nav.go('bot', { section: 'connections' }); }));
    pf.appendChild(top);
    if (!bots) { pf.appendChild(el('div', 'missing', 'Reading…')); loadBots(); return; }
    var list = el('div', 'bt-list');
    if (!bots.length) { var e = el('div', 'ig-empty'); e.appendChild(el('b', '', 'No connected bots')); e.appendChild(el('p', '', 'Connect a work assistant, a company bot or another AI application. Connect keeps it as it is; Migrate (when the bot offers it) brings its setup into a LAIN-owned bot.')); list.appendChild(e); }
    bots.forEach(function (b) {
      var c = el('div', 'bt-card'); c.setAttribute('data-bot', b.id);
      var t = el('div', 'bt-top'); t.appendChild(L.icon('bot', 20)); t.appendChild(el('b', '', b.name)); t.appendChild(el('span', 'spacer'));
      var st = b.lastStatus || { state: 'UNKNOWN', basis: 'not read yet' };
      t.appendChild(el('span', 'tag ' + (st.state === 'WORKING' ? 'accent' : st.state === 'IDLE' || st.state === 'RUNNING' ? 'ok' : st.state === 'ERROR' || st.state === 'OFFLINE' ? 'bad' : ''), st.state.charAt(0) + st.state.slice(1).toLowerCase()));
      t.appendChild(el('span', 'tag', b.mode === 'migrated' ? 'Migrated' : 'Connected'));
      c.appendChild(t);
      c.appendChild(el('div', 'bt-basis', (st.task ? st.task + ' — ' : '') + st.basis));
      var pp = el('div', 'bt-perms');
      perms.forEach(function (k) {
        var lab = el('label'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = Boolean(b.permissions[k]);
        cb.onchange = async function () { var p = {}; p[k] = cb.checked; await L.api('/api/bots/permissions', { id: b.id, permissions: p }); };
        lab.appendChild(cb); lab.appendChild(document.createTextNode(PERM_LABEL[k] || k)); pp.appendChild(lab);
      });
      c.appendChild(pp);
      var a = el('div', 'rs-acts'); a.style.marginTop = '12px';
      a.appendChild(btn('Refresh status', 'ghost small', async function () { await L.api('/api/bots/status', { id: b.id }); loadBots(); }));
      if (b.mode !== 'migrated' && st.migratable) a.appendChild(btn('Migrate to Noema…', 'ghost small', async function () { if (!(await L.confirm('Import this bot\'s declared setup into a Noema bot profile? The external bot is not changed or stopped.', { ok: 'Migrate' }))) return; var r = await L.api('/api/bots/migrate', { id: b.id }); L.toast(r && r.ok ? r.note : (r && r.why) || 'not migrated', !(r && r.ok)); loadBots(); }));
      a.appendChild(btn('Disconnect', 'ghost small', async function () { if (!(await L.confirm('Disconnect ' + b.name + ' from Noema? The bot keeps running wherever it runs.', { ok: 'Disconnect' }))) return; await L.api('/api/bots/remove', { id: b.id }); loadBots(); }));
      c.appendChild(a);
      list.appendChild(c);
    });
    pf.appendChild(list);
  }

  L.routerPrefs = {
    draw: function (page, pane) {
      if (page === 'router') { server(pane); return true; }
      if (page === 'bots') { botsPage(pane); return true; }
      return false;
    },
    reset: function () { srv = null; bots = null; },
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
