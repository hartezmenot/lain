'use strict';

/**
 * THE MODEL VIEW — providers, accounts, usage, and which model does what.
 *
 * ------------------------------------------------------------------------
 * EVERYTHING IS LAIN.accounts, which is POST /api/accounts — one projection
 * over connections.js, catalogstate.js, availability.js, usagewindows.js,
 * the website sources and modelinventory.js (src/harnessapp/accounts.js).
 * This view keeps no copy of its own and invents no provider: a row exists
 * because a route is configured, and a percentage exists because the
 * provider stated it.
 *
 * ------------------------------------------------------------------------
 * ROLES ARE WHAT CORE ROUTES. Two exist today — the BOT (the Chat selection)
 * and the Coding Agent (the Coding selection) — each with a choice for this
 * session and a default for new ones. Orchestration reports the one mode
 * this build has, and is the place a router or a team will be reported when
 * Core has one; nothing here pretends it does now.
 */

const HTML = `
<section class="view modelv split" id="vModel" data-view="model" hidden>
  <nav class="snav-col" id="modelNav"></nav>
  <div class="spane" id="modelPane"></div>
</section>`;

const CSS = `
.mtop{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.mtop .spacer{flex:1}
.mtop .when{font-size:11.5px;color:var(--faint)}
.rolegrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-width:900px}
.role{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.role .rn{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.role .rm{font-size:16px;font-weight:600;margin:6px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.role .rp{font-size:12px;color:var(--faint);margin-bottom:10px}
.role .rd{font-size:12px;color:var(--dim);margin-top:10px;display:flex;align-items:center;gap:8px}
.role .rd .spacer{flex:1}
.role .qline{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim)}
.role .qline .q-bar{flex:1;width:auto}
.provlist{max-width:900px}
.prow{display:grid;grid-template-columns:minmax(0,1.2fr) 120px 150px 44px;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px;border-radius:6px;border-top:1px solid var(--line)}
.prow:hover{background:var(--surface)}
.prow .pn{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prow .pn small{display:block;color:var(--faint);font-size:11.5px}
.pstate{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim)}
.pstate .sdot{font-size:9px}
.pstate.ok{color:var(--ok)} .pstate.warn{color:var(--warn)} .pstate.bad{color:var(--bad)} .pstate.busy{color:var(--faint)}
.prow .q-bar{width:auto}
.route{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px;max-width:900px}
.route .rh{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.route .rh b{font-size:13.5px}
.route .rh .spacer{flex:1}
.route dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;font-size:12.5px;margin:0 0 10px}
.route dt{color:var(--faint)} .route dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.wrow{display:grid;grid-template-columns:120px 1fr 44px;gap:10px;align-items:center;font-size:12.5px;padding:4px 0}
.wrow .q-bar{width:auto}
.mlist{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.mchip{font-size:11.5px;font-family:var(--mono);color:var(--dim);background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:2px 7px}
.mchip.hit{border-color:var(--accent);color:var(--ink)}
.orch{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-width:900px}
.orch .o{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--panel)}
.orch .o b{display:block;font-size:13px;margin-bottom:4px}
.orch .o small{color:var(--faint);font-size:12px}
.orch .o.on{border-color:var(--accent-line)}
.orch .o .tag{float:right;font-size:10.5px;color:var(--accent)}
.orch .o.off{opacity:.55}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var section = 'overview';
  var focusModel = null;

  function A() { return L.accounts.get(); }

  function readiness(c, refreshing) {
    if (refreshing) return { word: 'refreshing…', cls: 'busy' };
    if (c.availability && c.availability.rateLimited) return { word: 'rate limited', cls: 'bad' };
    if (c.catalog && c.catalog.state && c.catalog.state !== 'OK') return { word: c.catalog.state.toLowerCase().replace(/_/g, ' '), cls: 'warn' };
    if (c.readiness === 'REQUEST_READY') return { word: 'connected', cls: 'ok' };
    if (c.readiness === 'AUTHENTICATED') return { word: 'configured', cls: 'ok' };
    if (c.readiness === 'CREDENTIAL_FOUND') return { word: 'needs a check', cls: 'warn' };
    return { word: 'no credential', cls: 'bad' };
  }
  function groupState(g, refreshing) {
    var worst = null;
    g.connections.forEach(function (c) { var r = readiness(c, refreshing); if (!worst || (r.cls === 'bad') || (r.cls === 'warn' && worst.cls !== 'bad')) worst = r; });
    return worst || { word: '', cls: '' };
  }
  function bar(reading, avail) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    var h = reading && reading.headline;
    var pct = h ? Math.round(h.percent) : null;
    fill.style.width = (pct == null ? (avail && avail.rateLimited ? 100 : 0) : Math.max(2, pct)) + '%';
    fill.className = 'q-fill' + (avail && avail.rateLimited ? ' bad' : pct == null ? '' : pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : '');
    var t = el('span', 'q-pct' + (pct == null ? ' unknown' : ''), pct == null ? (avail && avail.rateLimited ? 'limit' : 'n/a') : pct + '%');
    return { bar: wrap, pct: t };
  }

  function nav() {
    var box = $('modelNav');
    box.textContent = '';
    var a = A();
    var d = a.data;
    var item = function (id, label, icon, side, cls) {
      var b = el('button', 'snav');
      b.appendChild(L.icon(icon, 15));
      var t = el('span', '', label); t.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      b.appendChild(t);
      if (side) b.appendChild(el('span', 'sv ' + (cls || ''), side));
      b.setAttribute('aria-selected', String(section === id));
      b.onclick = function () { section = id; focusModel = null; draw(); };
      box.appendChild(b);
    };
    box.appendChild(el('h5', '', 'Model'));
    item('overview', 'Roles & usage', 'model');
    item('orchestration', 'Orchestration', 'spark');
    box.appendChild(el('h5', '', 'Providers'));
    if (!d) box.appendChild(el('div', 'missing', a.loading ? '  Reading…' : '  Not read yet'));
    ((d && d.providers) || []).forEach(function (g) {
      var st = groupState(g, a.loading);
      item('p:' + g.provider, g.label, 'plug', st.word, st.cls);
    });
    box.appendChild(el('h5', '', 'Accounts'));
    item('accounts', 'Website accounts', 'link');
  }

  function top(pane, title, sub) {
    var a = A();
    var t = el('div', 'mtop');
    var h = el('div', '');
    h.appendChild(el('h2', '', title));
    if (sub) { var s = el('div', 'sub', sub); s.style.margin = '0'; h.appendChild(s); }
    t.appendChild(h);
    t.appendChild(el('span', 'spacer'));
    t.appendChild(el('span', 'when', a.loading ? 'Refreshing…' : a.at ? 'Refreshed ' + L.fmt.time(a.at) : ''));
    var rf = el('button', 'btn small', 'Refresh');
    rf.disabled = a.loading;
    rf.title = 'Re-discover every route’s models and re-read account state';
    rf.onclick = function () { L.accounts.refresh(true); };
    t.appendChild(rf);
    pane.appendChild(t);
    if (a.why) pane.appendChild(el('div', 'note bad', a.why));
  }

  function roleCard(key, label, purpose, x, def, usage) {
    var S = L.state() || {};
    var c = el('div', 'role');
    c.appendChild(el('div', 'rn', label));
    var name = x ? (x.source && x.source !== 'lain' ? sourceLabel(S, x.source) + (x.modelId ? ' · ' + L.fmt.model(x.modelId) : '') : L.fmt.model(x.modelId) || 'not set') : '—';
    c.appendChild(el('div', 'rm', name));
    c.appendChild(el('div', 'rp', purpose));
    var ql = el('div', 'qline');
    var b = bar(usage && usage.reading, usage && usage.availability);
    ql.appendChild(el('span', '', 'Usage'));
    ql.appendChild(b.bar); ql.appendChild(b.pct);
    c.appendChild(ql);
    var rd = el('div', 'rd');
    rd.appendChild(el('span', '', (x && x.scope === 'session' ? 'Chosen for this session' : 'Using the default') + ' · default: ' + (def ? (def.source && def.source !== 'lain' ? def.source + ' ' : '') + (L.fmt.model(def.modelId) || '') : 'LAIN config')));
    rd.appendChild(el('span', 'spacer'));
    var ch = el('button', 'btn small', 'Change');
    ch.onclick = function () { if (key === 'coding') L.models.pickCoding(ch); else L.models.pickBot(ch); };
    var df = el('button', 'btn small', 'Set default');
    df.title = 'The model new sessions start with';
    df.onclick = function () { L.models.pickDefault(df, key); };
    rd.appendChild(ch); rd.appendChild(df);
    c.appendChild(rd);
    return c;
  }
  function sourceLabel(S, id) {
    var list = (S.sources && S.sources.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
    return id;
  }

  function overview(pane) {
    var S = L.state() || {};
    var d = A().data;
    top(pane, 'Models', 'Which model does what, and how much of each account is used. Percentages are the providers’ own rate-limit readings from the last response on that route.');
    pane.appendChild(el('h3', '', 'Roles'));
    var grid = el('div', 'rolegrid');
    var m = S.models || {};
    var u = S.usage || {};
    grid.appendChild(roleCard('bot', 'BOT', 'Conversation, questions, planning, deciding what to do', m.chat, d && d.roles && d.roles.defaults.bot, u.chat));
    grid.appendChild(roleCard('coding', 'Coding Agent', 'Implementation, refactoring, debugging, tests', m.coding, d && d.roles && d.roles.defaults.coding, u.coding));
    pane.appendChild(grid);
    pane.appendChild(el('div', 'missing', 'Scope: a default for new sessions, and a choice per session. Per-project overrides do not exist in this build.'));
    pane.appendChild(el('h3', '', 'Providers'));
    var list = el('div', 'provlist');
    var a = A();
    if (!d) list.appendChild(el('div', 'missing', a.loading ? 'Reading providers…' : 'Not read yet.'));
    ((d && d.providers) || []).forEach(function (g) {
      g.connections.forEach(function (c) {
        var r = el('button', 'prow');
        var n = el('div', 'pn', g.label); n.appendChild(el('small', '', c.id + ' · ' + c.host + ' · ' + c.modelCount + ' models'));
        r.appendChild(n);
        var st = readiness(c, a.loading);
        var ps = el('span', 'pstate ' + st.cls); ps.appendChild(el('span', 'sdot', '●')); ps.appendChild(el('span', '', st.word));
        r.appendChild(ps);
        var b = bar(c.usage, c.availability);
        r.appendChild(b.bar); r.appendChild(b.pct);
        r.onclick = function () { section = 'p:' + g.provider; draw(); };
        list.appendChild(r);
      });
    });
    if (d && !(d.providers || []).length) list.appendChild(el('div', 'missing', 'No provider routes are configured. Add one with /api in the LAIN terminal.'));
    pane.appendChild(list);
  }

  function provider(pane, id) {
    var d = A().data;
    var g = ((d && d.providers) || []).filter(function (x) { return x.provider === id; })[0];
    if (!g) { top(pane, 'Provider'); pane.appendChild(el('div', 'missing', A().loading ? 'Reading…' : 'This provider is not configured.')); return; }
    top(pane, g.label, g.connections.length + ' route' + (g.connections.length === 1 ? '' : 's') + ' to this provider.');
    g.connections.forEach(function (c) {
      var card = el('div', 'route');
      var h = el('div', 'rh');
      h.appendChild(el('b', '', c.id));
      h.appendChild(el('span', 'spacer'));
      var st = readiness(c, A().loading);
      var ps = el('span', 'pstate ' + st.cls); ps.appendChild(el('span', 'sdot', '●')); ps.appendChild(el('span', '', st.word));
      h.appendChild(ps);
      card.appendChild(h);
      var dl = el('dl');
      var put = function (k, v) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
      put('Endpoint', c.host);
      put('Route', c.via === 'bridge' ? 'Bridge (it holds the credential)' : 'Native');
      put('Authentication', c.auth === 'oauth' ? 'OAuth' : c.auth === 'api_key' ? 'API key' : 'None needed');
      put('Readiness', String(c.readiness).toLowerCase().replace(/_/g, ' '));
      put('Catalog', c.catalog ? c.catalog.state.toLowerCase().replace(/_/g, ' ') + (c.catalog.at ? ' · ' + new Date(c.catalog.at).toLocaleString() : '') : (c.discoveredAt ? 'discovered ' + new Date(c.discoveredAt).toLocaleString() : 'not discovered'));
      if (c.availability && c.availability.rateLimited) put('Rate limit', (c.availability.reason || 'limited') + (c.availability.resumeAt ? ' · clears ' + L.fmt.until(c.availability.resumeAt) : ''));
      card.appendChild(dl);
      var windows = (c.usage && c.usage.windows) || [];
      if (!windows.length) card.appendChild(el('div', 'missing', 'Usage: this provider has not reported rate-limit usage on a response yet.'));
      windows.forEach(function (w) {
        var row = el('div', 'wrow');
        row.appendChild(el('span', '', w.label + (w.subscription ? '' : ' limit')));
        var b = bar({ headline: w }, null);
        row.appendChild(b.bar); row.appendChild(b.pct);
        row.title = (w.limit != null ? (w.remaining + ' of ' + w.limit + ' remaining') : '') + (w.resetAt ? ' · resets ' + L.fmt.until(w.resetAt) : '');
        card.appendChild(row);
      });
      var mhead = el('div', 'missing', c.modelCount + ' model' + (c.modelCount === 1 ? '' : 's') + (c.modelCount > c.models.length ? ' (first ' + c.models.length + ' shown)' : ''));
      card.appendChild(mhead);
      var ml = el('div', 'mlist');
      c.models.slice(0, 120).forEach(function (m) { ml.appendChild(el('span', 'mchip' + (focusModel === m ? ' hit' : ''), m)); });
      card.appendChild(ml);
      pane.appendChild(card);
    });
    pane.appendChild(el('div', 'missing', 'Routes and credentials are added and changed with /api and /oauth in the LAIN terminal; LAIN never types a credential into a website.'));
  }

  function accounts(pane) {
    var d = A().data;
    top(pane, 'Website accounts', 'Signed-in websites the BOT can answer through in Chat. LAIN opens the site; you sign in there.');
    var list = ((d && d.sources) || []).filter(function (s) { return s.kind === 'WEB'; });
    if (!list.length) pane.appendChild(el('div', 'missing', d ? 'No website sources in this build.' : 'Reading…'));
    list.forEach(function (s) {
      var card = el('div', 'route');
      var h = el('div', 'rh');
      h.appendChild(el('b', '', s.label));
      h.appendChild(el('span', 'spacer'));
      var cls = s.state === 'READY' ? 'ok' : s.state === 'AUTH_REQUIRED' ? 'warn' : s.state === 'FAILED' ? 'bad' : '';
      var ps = el('span', 'pstate ' + cls); ps.appendChild(el('span', 'sdot', '●')); ps.appendChild(el('span', '', String(s.state).toLowerCase().replace(/_/g, ' ')));
      h.appendChild(ps);
      card.appendChild(h);
      if (s.why) card.appendChild(el('div', 'missing', s.why));
      if (s.model) card.appendChild(el('div', 'missing', 'Model: ' + s.model));
      var go = el('button', 'btn small', s.state === 'READY' ? 'Open site' : 'Sign in');
      go.onclick = async function () { var r = await L.api('/api/source/connect', { source: s.id }); if (!r.ok) L.toast(r.why, true); else L.toast('Sign in in the window LAIN opened.'); L.accounts.load(); };
      card.appendChild(go);
      pane.appendChild(card);
    });
  }

  function orchestration(pane) {
    var d = A().data;
    top(pane, 'Orchestration', 'How work is split across models.');
    var mode = d && d.orchestration ? d.orchestration.mode : 'SINGLE_PER_ROLE';
    var grid = el('div', 'orch');
    [['SINGLE_PER_ROLE', 'One model per role', 'The BOT and the Coding Agent each run on their own model. This is what LAIN routes today.'],
      ['ROUTER', 'Router', 'Pick a model per request by cost, speed or capability.'],
      ['TEAM', 'Team', 'An instructor delegating to coding, research and test workers.']].forEach(function (o) {
      var avail = !d || (d.orchestration.available || []).indexOf(o[0]) >= 0;
      var c = el('div', 'o' + (mode === o[0] ? ' on' : '') + (avail ? '' : ' off'));
      if (mode === o[0]) c.appendChild(el('span', 'tag', 'active'));
      else if (!avail) c.appendChild(el('span', 'tag', 'not in this build'));
      c.appendChild(el('b', '', o[1]));
      c.appendChild(el('small', '', o[2]));
      grid.appendChild(c);
    });
    pane.appendChild(grid);
  }

  function draw() {
    if (L.nav.tab() !== 'model') return;
    nav();
    var pane = $('modelPane');
    var keep = pane.scrollTop;
    pane.textContent = '';
    if (section.indexOf('p:') === 0) provider(pane, section.slice(2));
    else if (section === 'accounts') accounts(pane);
    else if (section === 'orchestration') orchestration(pane);
    else overview(pane);
    pane.scrollTop = keep;
  }

  L.onBoot(function () {
    L.nav.onShow('model', function (o) {
      if (o && o.item) { section = 'p:' + o.item; focusModel = o.model || null; }
      else if (o && o.section === 'accounts') section = 'accounts';
      else if (o && /orch/.test(o.section || '')) section = 'orchestration';
      else if (o && o.section) section = 'overview';
      if (!A().data && !A().loading) L.accounts.load();
      draw();
    });
    L.accounts.on(function () { draw(); });
  });
  var lastSig = '';
  L.onRender(function (S) {
    if (L.nav.tab() !== 'model') return;
    var sig = JSON.stringify([S.models, S.usage]);
    if (sig !== lastSig) { lastSig = sig; draw(); }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
