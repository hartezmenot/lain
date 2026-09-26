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
.credrow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.credrow .cn span{display:block;color:var(--ink);font-size:13px}
.credrow .cn small{color:var(--faint);font-size:11px}
.credwhy{margin:0 0 6px}
@media (max-width: 620px){.credrow{grid-template-columns:minmax(0,1fr) auto}.credrow .ca{grid-column:1 / -1}}
.route{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px;max-width:900px}
.route .rh{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.route .rh b{font-size:13.5px}
.route .rh .spacer{flex:1}
.route dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;font-size:12.5px;margin:0 0 10px}
.route dt{color:var(--faint)} .route dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.wrow{display:grid;grid-template-columns:minmax(120px,210px) 1fr 44px;gap:10px;align-items:center;font-size:12.5px;padding:4px 0}
.wrow .q-bar{width:auto}
.mlist{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.racts{display:flex;gap:6px;margin-top:10px}
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
  var section = 'models';
  var addIntent = null;
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
    var I = L.instances ? L.instances.get() : { data: null };
    var F = L.fabric ? L.fabric.get() : { data: null };
    var fd = F.data;
    var count = function (g) { var x = fd && (fd.groups || []).filter(function (y) { return y.id === g; })[0]; return x ? String(x.rows.length) : ''; };
    // WHAT CAN LAIN USE — first; plumbing (providers, homes, sign-ins) after.
    box.appendChild(el('h5', '', 'Intelligence'));
    item('models', 'Models', 'model', fd ? String((fd.groups || []).reduce(function (n, g) { return n + g.rows.length; }, 0)) : '');
    item('instances', 'Accounts', 'link', I.data ? String((I.data.instances || []).length) : '');
    item('local', 'Local', 'files', count('local'));
    item('runtimes', 'Runtimes', 'terminal', fd ? String((fd.runtimes || []).filter(function (r) { return r.discovery.ok; }).length) : '');
    item('add', 'Add source', 'plus');
    box.appendChild(el('h5', '', 'Providers'));
    if (!d) box.appendChild(el('div', 'missing', a.loading ? '  Reading…' : '  Not read yet'));
    ((d && d.providers) || []).forEach(function (g) {
      var st = groupState(g, a.loading);
      item('p:' + g.provider, g.label, 'plug', st.word, st.cls);
    });
    box.appendChild(el('h5', '', 'More'));
    item('overview', 'Roles', 'spark');
    item('orchestration', 'Orchestration', 'spark');
    item('homes', 'Runtime homes', 'folder');
    item('accounts', 'Sign-ins by kind', 'shield');
    item('security', 'Security', 'shield', fd && fd.legacyKeys ? String(fd.legacyKeys) : '', fd && fd.legacyKeys ? 'warn' : '');
  }

  // ---- ADD SOURCE: cloud and runtime accounts above, local sources below -----
  function addLocal(pane) {
    pane.appendChild(el('h3', '', 'Local'));
    var grid = el('div', 'addgrid');
    var card = function (id, title, text, btn, fn) {
      var c = el('div', 'addc'); c.setAttribute('data-add', id);
      c.appendChild(el('b', '', title)); c.appendChild(el('small', '', text));
      var b = el('button', 'btn small primary', btn); b.onclick = fn; c.appendChild(b); grid.appendChild(c);
    };
    card('llamacpp', 'llama.cpp', 'Choose a folder of .gguf models. LAIN keeps the folder path, reads headers only, and starts its own llama-server when a model is used.', 'Choose model directory', function () { return L.fabric.addDir(); });
    card('ollama', 'Ollama', 'Models from a running Ollama service (localhost, or the endpoint in Settings). LAIN does not start or install Ollama.', 'Look for Ollama', async function () { await L.api('/api/local/ollama/refresh', {}); section = 'local'; L.fabric.load(true); draw(); });
    pane.appendChild(grid);
    pane.appendChild(el('div', 'missing', 'A local source is not an account: there is no credential, and no provider quota.'));
  }

  // ---- SECURITY: plaintext keys still in config -------------------------------
  async function security(pane) {
    top(pane, 'Security', 'Where LAIN keeps credentials. Keys live in the Windows secret store; config.json holds only a reference.');
    var box = el('div', 'route');
    var r = await L.api('/api/security/legacy-keys', {});
    var keys = (r && r.keys) || [];
    box.appendChild(el('b', '', keys.length ? keys.length + ' legacy key(s) remain in config.json' : 'No plaintext keys in config.json'));
    keys.forEach(function (k) { box.appendChild(el('div', 'missing', k.id + ' · ' + k.provider + ' · ' + k.masked)); });
    if (keys.length) {
      var b = el('button', 'btn small primary', 'Migrate to Windows Secret Store');
      b.style.marginTop = '10px';
      b.onclick = async function () {
        b.disabled = true;
        var m = await L.api('/api/security/migrate-keys', {});
        L.toast(m.ok ? m.migrated + ' key(s) moved; each was read back and verified before config was changed.' : (m.failed + ' key(s) could not be moved — left in config untouched.'), !m.ok);
        if (L.fabric) L.fabric.load();
        draw();
      };
      box.appendChild(b);
      box.appendChild(el('div', 'missing', 'Each key is stored, read back and compared before its config entry is replaced by a reference. No model, prompt or log sees a key.'));
    }
    pane.appendChild(box);
  }

  function top(pane, title, sub, onRefresh) {
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
    rf.onclick = function () { L.accounts.refresh(true); if (onRefresh) onRefresh(); };
    t.appendChild(rf);
    var add = el('button', 'btn small primary', 'Add account');
    add.title = 'A Codex sign-in, an API key or a website session';
    add.onclick = function () { section = 'add'; draw(); };
    t.appendChild(add);
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
    if (d && !(d.providers || []).length) {
      var none = el('div', 'missing', 'No provider routes are configured yet. ');
      var go = el('button', 'btn small primary', 'Add API key');
      go.onclick = function () { L.keys.add(null); };
      none.appendChild(go);
      list.appendChild(none);
    }
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
      if (!windows.length) card.appendChild(el('div', 'missing', 'Usage: n/a — this provider has not stated usage on a response yet, and LAIN does not estimate it.'));
      windows.forEach(function (w) {
        var row = el('div', 'wrow');
        row.appendChild(el('span', '', L.quotaWindowName ? L.quotaWindowName(w) : w.label));
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
      // WHAT CAN BE DONE TO THIS ROUTE. A bridge holds its own sign-in, and an
      // environment key lives where it was set — LAIN offers only what it owns.
      var acts = el('div', 'racts');
      var tb = el('button', 'btn small', 'Test');
      tb.title = 'Ask the provider what this route serves — no tokens spent';
      tb.onclick = function () { L.keys.test(c.id); };
      acts.appendChild(tb);
      if (c.via !== 'bridge' && c.auth === 'api_key' && c.id.indexOf('lain:') === 0) {
        var rk = el('button', 'btn small', 'Replace key');
        rk.onclick = function () { L.keys.add(g.provider); };
        acts.appendChild(rk);
        var rm = el('button', 'btn small danger', 'Remove…');
        rm.onclick = function () { L.keys.remove(c.id); };
        acts.appendChild(rm);
      }
      card.appendChild(acts);
      pane.appendChild(card);
    });
    pane.appendChild(el('div', 'missing', 'A key is checked with the provider before LAIN keeps it, and only its first and last characters are ever shown. LAIN never types a credential into a website. Routes set by environment variables or a bridge are changed where they were set.'));
  }

  // ---- ACCOUNTS, BY CREDENTIAL KIND -------------------------------------------------
  //
  // An OAuth identity, an API key and a website session are three different
  // things (Core: /api/accounts/credentials) and are never drawn as one:
  //
  //   ChatGPT identity   who you are, and nothing else — not model access
  //   API key            requests on the provider's API (proven before kept)
  //   website session    a signed-in site the BOT can answer through
  //
  // Website sign-in opens an ORDINARY browser window on LAIN's own profile with
  // nothing attached (Core's signin.js); the ChatGPT identity, when LAIN has an
  // OpenAI-registered client, opens OpenAI's page in the DEFAULT browser.
  var creds = null, credsAt = 0;
  async function loadCreds(force) {
    if (!force && creds && Date.now() - credsAt < 4000) return creds;
    var r = await L.api('/api/accounts/credentials', {});
    if (r && r.ok) { creds = r.providers; credsAt = Date.now(); }
    return creds;
  }
  function stateWord(st) { return String(st || '').toLowerCase().replace(/_/g, ' '); }
  function stateCls(st) { return /^(READY|CONNECTED|CONFIGURED)$/.test(st) ? 'ok' : /AUTH_REQUIRED|WAITING/.test(st) ? 'warn' : /FAILED/.test(st) ? 'bad' : ''; }

  async function signInSite(sourceId, label) {
    var r = await L.api('/api/source/signin', { source: sourceId });
    if (!r.ok) { L.toast(r.why, true); return; }
    L.toast('Sign in to ' + label + ' in the browser window that opened \u2014 an ordinary window, nothing attached. Close it when you are done; LAIN checks then.');
    var t = setInterval(async function () {
      var st = await L.api('/api/source/signin/status', { source: sourceId });
      if (st && st.ok && st.done) { clearInterval(t); creds = null; L.accounts.load(); draw(); if (st.result) L.toast(label + ': ' + stateWord(st.result.state)); }
    }, 2000);
  }
  async function chatgptBegin() {
    var r = await L.api('/api/accounts/chatgpt/begin', {});
    if (!r.ok) { L.toast(r.why, true); creds = null; draw(); return; }
    L.openExternal(r.url);
    L.toast('Finish signing in on OpenAI\u2019s page in your browser.');
    var t = setInterval(async function () {
      var st = await L.api('/api/accounts/chatgpt/status', {});
      if (st && st.ok && st.state !== 'WAITING') { clearInterval(t); creds = null; draw(); }
    }, 2000);
  }
  async function chatgptDisconnect() {
    var r = await L.api('/api/accounts/chatgpt/disconnect', {});
    if (!r.ok || !r.token) return L.toast(r.why || 'could not start', true);
    var yes = await L.confirm(r.impact, { title: 'Disconnect ChatGPT identity', ok: 'Disconnect', danger: true });
    if (!yes) return;
    var d = await L.api('/api/accounts/chatgpt/disconnect', { token: r.token });
    if (!d.ok) L.toast(d.why, true);
    creds = null; draw();
  }

  function accounts(pane) {
    top(pane, 'Accounts', 'Each provider\u2019s credentials by kind. An identity is not model access; a website session is not an API key.');
    if (!creds) {
      pane.appendChild(el('div', 'missing', 'Reading\u2026'));
      loadCreds(true).then(function () { draw(); });
      return;
    }
    creds.forEach(function (p) {
      var card = el('div', 'route credcard');
      var h = el('div', 'rh');
      h.appendChild(el('b', '', p.label));
      card.appendChild(h);
      p.kinds.forEach(function (k) {
        var row = el('div', 'credrow');
        row.setAttribute('data-kind', k.kind);
        var nm = el('div', 'cn');
        nm.appendChild(el('span', '', k.label));
        nm.appendChild(el('small', '', k.kind === 'oauth_identity' ? 'OAuth identity' : k.kind === 'api_key' ? 'API credential' : 'browser website session'));
        row.appendChild(nm);
        var ps = el('span', 'pstate ' + stateCls(k.state)); ps.appendChild(el('span', 'sdot', '\u25cf')); ps.appendChild(el('span', '', stateWord(k.state)));
        row.appendChild(ps);
        var act = el('div', 'ca');
        if (k.kind === 'oauth_identity') {
          if (k.state === 'CONNECTED') {
            var dc = el('button', 'btn small', 'Disconnect\u2026'); dc.onclick = chatgptDisconnect; act.appendChild(dc);
          } else {
            var si = el('button', 'btn small', 'Sign in with ChatGPT');
            si.disabled = k.state === 'NOT_AVAILABLE' || k.state === 'WAITING';
            si.onclick = chatgptBegin;
            act.appendChild(si);
          }
        } else if (k.kind === 'api_key') {
          var ak = el('button', 'btn small', k.state === 'CONFIGURED' ? 'Add another key' : 'Add API key');
          ak.onclick = function () { L.keys.add(p.provider === 'google' ? 'gemini' : p.provider); };
          act.appendChild(ak);
        } else if (k.kind === 'website_session') {
          var ws = el('button', 'btn small', k.state === 'READY' ? 'Sign in again' : 'Sign in');
          ws.onclick = function () { signInSite(k.source, k.label.replace(/ session$/, '')); };
          act.appendChild(ws);
        }
        row.appendChild(act);
        card.appendChild(row);
        var why = k.kind === 'oauth_identity' ? (k.identity ? 'Signed in as ' + (k.identity.name || '') + (k.identity.email ? ' <' + k.identity.email + '>' : '') + '. ' + k.note : (k.why ? k.why + ' ' : '') + k.note) : (k.why || '');
        if (why) card.appendChild(el('div', 'missing credwhy', why));
      });
      pane.appendChild(card);
    });
    pane.appendChild(el('div', 'missing', 'LAIN never asks for a provider password. Website sign-in happens in an ordinary browser window on LAIN\u2019s own profile, with no automation attached while you sign in; LAIN attaches afterwards to read replies. API keys are checked with the provider before they are kept.'));
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
    else if (section === 'instances') { top(pane, 'Accounts', 'Every account LAIN can reach — each with its own sign-in, usage and limits. Never merged, never rotated.'); L.instances.renderList(pane); }
    else if (section === 'add') { top(pane, 'Add source', 'Keys and sign-ins are entered here — never in the terminal, never in a conversation.'); pane.appendChild(el('h3', '', 'Cloud / Runtime')); L.instances.renderAdd(pane, addIntent); addLocal(pane); }
    else if (section === 'models') { top(pane, 'Models', 'What LAIN can use, and for which role. Usage is each source’s own figure — a local model has no provider quota.', function () { L.fabric.load(true); }); L.fabric.renderModels(pane); }
    else if (section === 'local') { top(pane, 'Local', 'Models on this machine — llama.cpp directories and Ollama. Nothing is copied, nothing leaves the machine.', function () { L.fabric.load(true); }); L.fabric.renderLocal(pane); }
    else if (section === 'runtimes') { top(pane, 'Runtimes', 'Official runtimes LAIN works through — discovery, telemetry and execution reported separately.', function () { L.fabric.load(true); }); L.fabric.renderRuntimes(pane); }
    else if (section === 'homes') { top(pane, 'Runtime homes', 'Runtime homes found on this machine. Adopt registers a home; it copies nothing.'); L.instances.renderRuntimes(pane); }
    else if (section === 'security') { security(pane); }
    else if (section === 'accounts') accounts(pane);
    else if (section === 'orchestration') orchestration(pane);
    else overview(pane);
    pane.scrollTop = keep;
  }

  L.onBoot(function () {
    L.nav.onShow('model', function (o) {
      if (o && o.item) { section = 'p:' + o.item; focusModel = o.model || null; }
      else if (o && (o.section === 'accounts' || o.section === 'signins')) section = 'accounts';
      else if (o && ['instances', 'runtimes', 'models', 'local', 'homes', 'security'].indexOf(o.section) >= 0) section = o.section;
      else if (o && o.section === 'discover') section = 'homes';
      else if (o && o.section === 'add') {
        section = 'add'; addIntent = null;
        // AN INTENT FROM `/account add`: single use, no credential — it only says which form.
        var tok = o.intent || (o.args && o.args.intent);
        if (tok) L.api('/api/instances/intent', { token: tok }).then(function (r) { if (r && r.ok) { addIntent = r.intent; draw(); } });
      }
      else if (o && /orch/.test(o.section || '')) section = 'orchestration';
      else if (o && o.section) section = 'overview';
      if (!A().data && !A().loading) L.accounts.load();
      if (L.fabric && !L.fabric.get().data && !L.fabric.get().loading) L.fabric.load();
      draw();
    });
    if (L.fabric) L.fabric.on(function () { draw(); });
    L.accounts.on(function () { draw(); });
    if (L.instances) L.instances.on(function () { draw(); });
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
