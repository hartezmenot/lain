'use strict';

/**
 * MODEL › ACCOUNTS — every account LAIN can reach, one row each, and the one
 * selected in full beside the table.
 *
 *   ┌ Accounts ──────────────────────────────────────────┬ Codex 3 ─────────┐
 *   │ Name       Provider  Status   Source  Caps  Identity  Usage/Limit │ identity, homes, │
 *   │ ● Codex 1  OpenAI    Signed in Runtime EXT  a@… plus  5h 12% wk 3%│ windows + resets,│
 *   │ ● Codex 3  OpenAI    Signed in Runtime EXT  b@… plus  5h 87%      │ sessions, roles  │
 *   │ ● lain:ds  DeepSeek  Ready     API     BOT… key ••••9f2a  —       │ [Switch][Test]…  │
 *   └────────────────────────────────────────────────────┴──────────────────┘
 *
 * EVERYTHING IS POST /api/instances (src/harnessapp/instanceroutes.js), a
 * projection over accountinstances.js. It carries a credential REFERENCE and a
 * masked shape, never a key; a runtime account's sign-in stays in its home.
 *
 * LIMITS ARE THE PROVIDER'S WINDOWS, one per row, never averaged. A window
 * counts down locally to its reset and then reads "reset — awaiting refresh"
 * (expected, not confirmed) until the runtime is asked again. Nothing here
 * polls a provider: Refresh is a person's click.
 */

const CSS = `
.acc{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:14px;align-items:start}
@media (max-width:1280px){.acc{grid-template-columns:minmax(0,1fr)}.acc .accdet{position:static}}
.acctblwrap{overflow-x:auto;min-width:0}
.acctbl{width:100%;min-width:880px;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
.acctbl th{font-weight:600;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.acctbl td{padding:8px;border-bottom:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.acctbl tr.arow{cursor:pointer}
.acctbl tr.arow:hover td{background:var(--surface)}
.acctbl tr.arow[aria-selected=true] td{background:var(--raise)}
.acctbl .nm{display:flex;align-items:center;gap:8px;min-width:0}
.acctbl .nm span{overflow:hidden;text-overflow:ellipsis}
.acctbl .nm small{display:block;color:var(--faint);font-size:11px}
.pbadge{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;letter-spacing:0}
.capchip{display:inline-block;font-size:9.5px;font-weight:600;letter-spacing:.04em;padding:1px 5px;border-radius:3px;border:1px solid var(--line2);color:var(--dim);margin:0 3px 2px 0}
.capchip.rt{border-color:var(--warn);color:var(--warn)}
.lim{display:flex;gap:8px;flex-wrap:wrap}
.lim .lw{display:inline-flex;align-items:center;gap:4px}
.lim .lw .q-bar{width:44px}
.lim .exp{color:var(--warn)}
.accdet{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;position:sticky;top:0}
.accdet h3{margin:0 0 2px;font-size:15px;display:flex;align-items:center;gap:8px}
.accdet .sub{margin-bottom:10px}
.accdet dl{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:12px;margin:0 0 10px}
.accdet dt{color:var(--faint)} .accdet dd{margin:0;overflow-wrap:anywhere}
.accdet h4{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:12px 0 6px}
.accdet .win{display:grid;grid-template-columns:70px 1fr 42px;gap:8px;align-items:center;font-size:12px;padding:3px 0}
.accdet .win .q-bar{width:auto}
.accdet .reset{font-size:11.5px;color:var(--faint);grid-column:1 / -1;margin-top:-2px}
.accdet .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.accdet .same{color:var(--warn);font-size:12px;margin:6px 0}
.addgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-width:900px}
@media (max-width:820px){.addgrid{grid-template-columns:minmax(0,1fr)}}
.addc{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;text-align:left}
.addc b{display:block;font-size:13.5px;margin-bottom:4px}
.addc small{color:var(--faint);font-size:12px;display:block;margin-bottom:10px}
.addc.pre{border-color:var(--accent-line)}
.addform{max-width:560px;margin-top:14px}
.addform label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
.addform input,.addform select{width:100%}
.rtrow{display:grid;grid-template-columns:minmax(0,1fr) 150px auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line);font-size:12.5px}
.rtrow small{display:block;color:var(--faint)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var data = null, loading = false, at = 0, selected = null, listeners = [];
  var ticker = null;

  var BRAND = { openai: ['O', '#10a37f'], anthropic: ['A', '#d97757'], google: ['G', '#4285f4'], gemini: ['G', '#4285f4'], deepseek: ['D', '#4d6bfe'],
    openrouter: ['R', '#6566f1'], zai: ['Z', '#2d2d2d'], opencode: ['OC', '#3b3b3b'], freebuff: ['F', '#b24bf3'], cursor: ['C', '#222'], xai: ['X', '#111'] };
  function badge(provider) {
    if (L.picon) return L.picon(provider, 22);
    var b = BRAND[String(provider || '').toLowerCase()] || [String(provider || '?').charAt(0).toUpperCase(), '#666'];
    var s = el('span', 'pbadge', b[0]); s.style.background = b[1]; s.title = provider || '';
    return s;
  }
  var STATE = { AUTHENTICATED: ['Signed in', 'ok'], REQUEST_READY: ['Ready', 'ok'], LOGIN_REQUIRED: ['Sign-in needed', 'warn'], CREDENTIAL_FOUND: ['Needs a check', 'warn'],
    NONE: ['No credential', 'bad'], UNKNOWN: ['Not checked', ''], NOT_INSTALLED: ['Runtime missing', 'bad'], ERROR: ['Error', 'bad'] };
  function status(v) {
    var k = v.runtime_state === 'NOT_INSTALLED' ? 'NOT_INSTALLED' : v.runtime_state === 'ERROR' ? 'ERROR' : v.authentication_state;
    return STATE[k] || [String(k || '—').toLowerCase().replace(/_/g, ' '), ''];
  }
  function sourceWord(v) { return v.source_type === 'runtime' ? 'Runtime' : v.source_type === 'website' ? 'Website' : 'API'; }
  function countdown(ms) {
    if (ms <= 0) return 'now';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : (s % 60) + 's';
  }
  function qbar(pct) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    fill.style.width = (pct == null ? 0 : Math.max(2, Math.min(100, pct))) + '%';
    fill.className = 'q-fill' + (pct == null ? '' : pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : '');
    return wrap;
  }
  function windowExpired(w) { return w.resetsAt && Date.now() >= w.resetsAt; }

  async function load() {
    loading = true; emit();
    var r = await L.api('/api/instances', {});
    loading = false;
    if (r && r.ok) { data = r; at = Date.now(); if (!selected && r.instances.length) selected = r.instances[0].id; }
    emit();
    return data;
  }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* a view's problem */ } }); }
  function byId(id) { return ((data && data.instances) || []).filter(function (v) { return v.id === id; })[0] || null; }

  // ---- the table ---------------------------------------------------------
  function limitCell(v) {
    var box = el('span', 'lim');
    var ws = (v.limits && v.limits.windows) || [];
    if (!ws.length) { box.appendChild(el('span', 'missing', v.limits_error ? 'not readable' : v.source_type === 'runtime' ? 'not reported' : '—')); return box; }
    ws.forEach(function (w) {
      var c = el('span', 'lw');
      c.appendChild(el('span', '', w.label));
      if (windowExpired(w)) c.appendChild(el('span', 'exp', 'reset'));
      else { c.appendChild(qbar(w.usedPercent)); c.appendChild(el('span', '', w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '%')); }
      box.appendChild(c);
    });
    return box;
  }
  function table(host, rows) {
    var t = el('table', 'acctbl');
    var cols = [['Name', '24%'], ['Provider', '10%'], ['Source', '9%'], ['Status', '12%'], ['Capabilities', '16%'], ['Identity', '14%'], ['Usage / Limit', '15%']];
    var hr = el('tr', '');
    cols.forEach(function (c) { var th = el('th', '', c[0]); th.style.width = c[1]; hr.appendChild(th); });
    var th = el('thead', ''); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody', '');
    rows.forEach(function (v) {
      var tr = el('tr', 'arow');
      tr.setAttribute('data-id', v.id);
      tr.setAttribute('aria-selected', String(selected === v.id));
      tr.onclick = function () { selected = v.id; emit(); };
      var n = el('td', ''); var nm = el('div', 'nm'); nm.appendChild(badge(v.provider));
      var nt = el('span', ''); nt.appendChild(document.createTextNode(v.display_name)); nt.appendChild(el('small', '', v.id)); nm.appendChild(nt); n.appendChild(nm); tr.appendChild(n);
      tr.appendChild(el('td', '', v.provider || '—'));
      tr.appendChild(el('td', '', sourceWord(v)));
      var st = status(v); var sc = el('td', ''); var ps = el('span', 'pstate ' + st[1]); ps.appendChild(el('span', 'sdot', '●')); ps.appendChild(el('span', '', st[0])); sc.appendChild(ps); tr.appendChild(sc);
      var cc = el('td', ''); (v.capabilities || []).forEach(function (c) { cc.appendChild(el('span', 'capchip' + (c === 'RUNTIME ONLY' ? ' rt' : ''), c)); }); tr.appendChild(cc);
      var who = v.identity ? (v.identity.email || v.identity.kind) + (v.identity.planType ? ' · ' + v.identity.planType : '') : v.credential && v.credential.masked ? 'key ' + v.credential.masked : '—';
      var ic = el('td', '', who); ic.title = who; tr.appendChild(ic);
      var lc = el('td', ''); lc.appendChild(limitCell(v)); tr.appendChild(lc);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    host.appendChild(t);
  }

  // ---- the detail panel ----------------------------------------------------
  var DASH = { openai: 'https://platform.openai.com/usage', anthropic: 'https://console.anthropic.com/settings/usage', deepseek: 'https://platform.deepseek.com/usage', openrouter: 'https://openrouter.ai/activity' };
  function dashboardFor(v) { return v.driver_id === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : DASH[v.provider] || null; }
  function act(label, fn, cls) { var b = el('button', 'btn small' + (cls ? ' ' + cls : ''), label); b.onclick = async function () { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }; return b; }
  function detail(host, v) {
    var d = el('aside', 'accdet');
    d.setAttribute('data-detail', v.id);
    var h = el('h3', ''); h.appendChild(badge(v.provider)); h.appendChild(document.createTextNode(v.display_name)); d.appendChild(h);
    d.appendChild(el('div', 'sub', v.connection || ''));
    if (v.sameIdentityAs) d.appendChild(el('div', 'same', 'Same sign-in as ' + v.sameIdentityAs + ' — kept as two accounts, never merged.'));
    var dl = el('dl', '');
    var kv = function (k, x) { if (x == null || x === '') return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(x))); };
    kv('Identity', v.identity ? [v.identity.email, v.identity.planType, v.identity.providerAccountId].filter(Boolean).join(' · ') : 'not signed in');
    kv('Provider', v.provider);
    kv('Connection', sourceWord(v) + (v.driver_id ? ' · ' + v.driver_id : ''));
    kv('Credential', v.credential_ref ? v.credential_ref + (v.credential && v.credential.masked ? '  ' + v.credential.masked : '') : v.credential && v.credential.held_by === 'runtime' ? 'held by the runtime, in this account’s home' : v.credential && v.credential.plaintext ? 'stored in config (move it to the OS store)' : '—');
    if (v.runtime) {
      kv('Runtime', v.runtime.kind + (v.runtime.pid ? ' · pid ' + v.runtime.pid : ' · not running'));
      kv('Home', v.runtime.home_mode === 'overlay' ? 'shared ' + v.config_home + ' (overlay)' : v.config_home);
      if (v.shadow_home) kv('Own sign-in in', v.shadow_home);
      kv('Sessions shared with', v.runtime.session_store);
    }
    kv('Roles', (v.assigned_roles || []).join(', ') || 'none');
    d.appendChild(dl);
    d.appendChild(el('h4', '', 'Capabilities'));
    var caps = el('div', ''); (v.capabilities || []).forEach(function (c) { caps.appendChild(el('span', 'capchip' + (c === 'RUNTIME ONLY' ? ' rt' : ''), c)); }); d.appendChild(caps);
    if ((v.models || []).length) { d.appendChild(el('h4', '', 'Models (' + v.models.length + ')')); d.appendChild(el('div', 'missing', v.models.slice(0, 12).join(', ') + (v.models.length > 12 ? ' …' : ''))); }
    d.appendChild(el('h4', '', 'Usage windows'));
    var ws = (v.limits && v.limits.windows) || [];
    if (!ws.length) d.appendChild(el('div', 'missing', v.limits_error ? 'The runtime did not report limits: ' + v.limits_error : 'Not reported by the provider. LAIN does not estimate a quota.'));
    ws.forEach(function (w) {
      var row = el('div', 'win');
      row.appendChild(el('span', '', w.label));
      row.appendChild(qbar(windowExpired(w) ? null : w.usedPercent));
      row.appendChild(el('span', '', windowExpired(w) ? '—' : (w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '%')));
      var rs = el('div', 'reset');
      rs.setAttribute('data-reset', String(w.resetsAt || ''));
      rs.textContent = resetText(w);
      row.appendChild(rs);
      d.appendChild(row);
    });
    if (v.limits && v.limits.observedAt) d.appendChild(el('div', 'missing', 'Reported by ' + (v.limits.reportedBy || 'the provider') + ' at ' + L.fmt.time(v.limits.observedAt) + '.'));
    if (v.sessions) { d.appendChild(el('h4', '', 'Sessions')); d.appendChild(el('div', 'missing', (v.sessions.held || []).length ? 'Writing to ' + v.sessions.held.join(', ') : 'Holds no thread.')); }
    if (v.login && !v.login.done) d.appendChild(el('div', 'note', 'Finish signing in in your browser' + (v.login.userCode ? ' — code ' + v.login.userCode : '') + '.'));
    var acts = el('div', 'acts');
    if (v.source_type === 'runtime') {
      acts.appendChild(act('Switch', async function () { var r = await L.api('/api/instances/foreground', { id: v.id }); L.toast(r.ok ? v.display_name + ' is in front. Nothing switches on its own.' : r.why, !r.ok); }));
      if (v.authentication_state !== 'AUTHENTICATED') acts.appendChild(act('Sign in', function () { return signIn(v, false); }, 'primary'));
      acts.appendChild(act('Refresh', async function () { var r = await L.api('/api/instances/refresh', { id: v.id }); if (!r.ok) L.toast(r.why, true); await load(); }));
      acts.appendChild(act('Test', async function () { var r = await L.api('/api/instances/refresh', { id: v.id }); L.toast(r.ok ? 'The runtime answered: ' + (r.instance.authentication_state || '') : r.why, !r.ok); await load(); }));
      acts.appendChild(act('Native sessions', async function () { var r = await L.api('/api/instances/threads', { id: v.id }); if (!r.ok) return L.toast(r.why, true); L.toast(r.threads.length + ' native session(s) visible to this account.'); }));
    } else {
      acts.appendChild(act('Test', async function () { var r = await L.api('/api/accounts/test', { id: v.id }); L.toast(r.ok ? 'It answered: ' + r.models + ' model(s).' : r.why, !r.ok); await load(); }));
      acts.appendChild(act('Replace key', async function () { await L.keys.add(v.provider); await load(); }));
    }
    acts.appendChild(act('Rename', async function () {
      var got = await L.dialog({ title: 'Rename account', fields: [{ key: 'name', label: 'Name', value: v.display_name }], ok: 'Rename' });
      if (!got || !got.name) return;
      var r = await L.api('/api/instances/rename', { id: v.id, name: got.name }); if (!r.ok) L.toast(r.why, true); await load();
    }));
    var dash = dashboardFor(v);
    if (dash) acts.appendChild(act('Open dashboard ↗', function () { return L.openExternal(dash); }));
    if (v.source_type === 'runtime') acts.appendChild(act('Disconnect', async function () {
      if (!(await L.confirm('Disconnect ' + v.display_name + '? Its runtime stops and it leaves LAIN. A home LAIN created is signed out through the runtime; a home you adopted keeps its sign-in. Native sessions stay. No other account is touched.', { ok: 'Disconnect', danger: true }))) return;
      var r = await L.api('/api/instances/disconnect', { id: v.id });
      if (!r.ok) return L.toast(r.why, true);
      L.toast(r.steps.join(' · ')); selected = null; await load();
    }, 'danger'));
    else acts.appendChild(act('Remove key', async function () { await L.keys.remove(v.id); await load(); }, 'danger'));
    d.appendChild(acts);
    host.appendChild(d);
  }
  function resetText(w) {
    if (!w.resetsAt) return '';
    var left = w.resetsAt - Date.now();
    return left > 0 ? 'Resets in ' + countdown(left) + ' (expected, ' + new Date(w.resetsAt).toLocaleString() + ')' : 'Reset expected — not confirmed until refreshed';
  }
  function tick() {
    var nodes = document.querySelectorAll('.accdet .reset[data-reset]');
    if (!nodes.length) { clearInterval(ticker); ticker = null; return; }
    var expiredNow = false;
    Array.prototype.forEach.call(nodes, function (n) {
      var t = Number(n.getAttribute('data-reset')); if (!t) return;
      var left = t - Date.now();
      n.textContent = left > 0 ? 'Resets in ' + countdown(left) + ' (expected, ' + new Date(t).toLocaleString() + ')' : 'Reset expected — not confirmed until refreshed';
      if (left <= 0 && left > -1500) expiredNow = true;
    });
    // AT THE RESET the old figure stops being the provider's word: redraw as
    // expired, then ask the runtime once (a person's view is open).
    if (expiredNow && selected) { emit(); L.api('/api/instances/refresh', { id: selected }).then(function () { load(); }); }
  }

  async function signIn(v, device) {
    var r = await L.api('/api/instances/login', { id: v.id, device: Boolean(device) });
    if (!r.ok) { L.toast(r.why, true); return; }
    if (r.login.url) L.openExternal(r.login.url);
    L.toast(r.login.userCode ? 'Enter code ' + r.login.userCode + ' on the page that opened.' : 'Finish signing in on OpenAI’s page in your browser. LAIN never sees your password.');
    var n = 0;
    var t = setInterval(async function () {
      n++;
      await load();
      var cur = byId(v.id);
      if (!cur || cur.authentication_state === 'AUTHENTICATED' || (cur.login && cur.login.done) || n > 150) {
        clearInterval(t);
        if (cur && cur.authentication_state === 'AUTHENTICATED') L.toast(cur.display_name + ': signed in as ' + ((cur.identity && cur.identity.email) || 'an account') + '.');
        else if (cur && cur.login && cur.login.error) L.toast('Sign-in did not finish: ' + cur.login.error, true);
      }
    }, 2000);
  }

  function renderList(pane) {
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading accounts…' : 'Not read yet.')); if (!loading) load(); return; }
    var rows = data.instances || [];
    if (!rows.length) { pane.appendChild(el('div', 'missing', 'No accounts yet. Add one — a Codex sign-in, an API key, or a website session.')); return; }
    var wrap = el('div', 'acc');
    var left = el('div', 'acctblwrap'); table(left, rows); wrap.appendChild(left);
    var v = byId(selected) || rows[0];
    if (v) detail(wrap, v);
    pane.appendChild(wrap);
    if (!ticker) ticker = setInterval(tick, 1000);
  }

  // ---- add an account ----------------------------------------------------
  function renderAdd(pane, intent) {
    var grid = el('div', 'addgrid');
    var card = function (id, title, text, btn, fn) {
      var c = el('div', 'addc' + (intent && (intent.driver === id || intent.provider === id) ? ' pre' : ''));
      c.setAttribute('data-add', id);
      c.appendChild(el('b', '', title)); c.appendChild(el('small', '', text));
      var b = el('button', 'btn small primary', btn); b.onclick = fn; c.appendChild(b);
      grid.appendChild(c);
    };
    card('codex', 'Codex account', 'Sign in through Codex itself (ChatGPT). Add as many as you have — each keeps its own sign-in, usage and limits.', 'Add Codex account', function () { codexForm(pane); });
    card('api', 'API key', 'A provider key, checked with the provider before it is kept, stored in the OS secret store. Only its shape is ever shown.', 'Add API key', async function () { await L.keys.add(intent && intent.provider ? intent.provider : null); await load(); });
    card('website', 'Website session', 'ChatGPT or Gemini in an ordinary browser window. Chat only — not the Codex subscription and not the API.', 'Choose…', function () { L.nav.go('model', { section: 'signins' }); });
    pane.appendChild(grid);
    // A FORM THE PERSON OPENED SURVIVES A REDRAW (the pane is rebuilt on every account read).
    if (formOpen === 'codex') codexForm(pane);
  }
  var formOpen = null, formVals = { name: '', mode: 'overlay', dev: 'browser' };
  function codexForm(pane) {
    formOpen = 'codex';
    var old = pane.querySelector('.addform'); if (old) old.remove();
    var f = el('div', 'addform');
    f.appendChild(el('h4', '', 'New Codex account'));
    var name = document.createElement('input'); name.placeholder = 'Name (e.g. Work Codex)'; name.value = formVals.name;
    name.oninput = function () { formVals.name = name.value; };
    var lab = el('label', '', 'Name'); f.appendChild(lab); f.appendChild(name);
    var mode = document.createElement('select');
    [['overlay', 'Share sessions with ~/.codex (own sign-in, shared history)'], ['direct', 'Separate Codex home (own sign-in, own history)']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; mode.appendChild(op); });
    mode.value = formVals.mode; mode.onchange = function () { formVals.mode = mode.value; };
    f.appendChild(el('label', '', 'Sessions')); f.appendChild(mode);
    var dev = document.createElement('select');
    [['browser', 'Sign in in my browser'], ['device', 'Show me a device code']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; dev.appendChild(op); });
    dev.value = formVals.dev; dev.onchange = function () { formVals.dev = dev.value; };
    f.appendChild(el('label', '', 'Sign-in')); f.appendChild(dev);
    f.appendChild(el('div', 'missing', 'Codex runs its own sign-in; LAIN opens the page and never sees your password. Nothing is copied from another account.'));
    var go = el('button', 'btn small primary', 'Add and sign in');
    go.style.marginTop = '12px';
    go.onclick = async function () {
      go.disabled = true;
      var r = await L.api('/api/instances/add', { driver_id: 'codex', display_name: formVals.name, config: { home_mode: formVals.mode } });
      if (!r.ok) { go.disabled = false; return L.toast(r.why, true); }
      var device = formVals.dev === 'device';
      formOpen = null; formVals = { name: '', mode: 'overlay', dev: 'browser' };
      selected = r.instance.id;
      await load();
      L.nav.go('model', { section: 'instances' });
      signIn(r.instance, device);
    };
    f.appendChild(go);
    var cancel = el('button', 'btn small', 'Cancel'); cancel.style.margin = '12px 0 0 8px';
    cancel.onclick = function () { formOpen = null; f.remove(); };
    f.appendChild(cancel);
    pane.appendChild(f);
    if (document.activeElement === document.body) name.focus();
  }

  var found = null, foundAt = 0;
  function renderRuntimes(pane, force) {
    if (!found || force || Date.now() - foundAt > 60000) {
      pane.appendChild(el('div', 'missing', 'Looking for runtimes on this machine…'));
      L.api('/api/instances/discover', { force: Boolean(force) }).then(function (r) { if (r && r.ok) { found = r.runtimes; foundAt = Date.now(); emit(); } });
      if (!found) return;
    }
    var rf = el('button', 'btn small', 'Look again'); rf.onclick = function () { found = null; renderRuntimes(pane, true); }; pane.appendChild(rf);
    found.forEach(function (d) {
      var r = el('div', 'rtrow');
      r.setAttribute('data-runtime', d.driver);
      var n = el('div', ''); n.appendChild(el('b', '', d.displayName));
      n.appendChild(el('small', '', d.installed ? d.binary : 'not installed'));
      r.appendChild(n);
      r.appendChild(el('span', 'pstate ' + (d.installed ? 'ok' : 'bad'), (d.installed ? 'installed' : 'not installed') + ' · ' + d.instances + ' account' + (d.instances === 1 ? '' : 's')));
      var a = el('div', '');
      if (!d.installed && d.install && d.install.docs) { var ib = el('button', 'btn small', 'Install help ↗'); ib.title = d.install.how || ''; ib.onclick = function () { L.openExternal(d.install.docs); }; a.appendChild(ib); }
      r.appendChild(a);
      pane.appendChild(r);
      d.homes.forEach(function (h) {
        var hr = el('div', 'rtrow');
        hr.style.paddingLeft = '18px';
        var hn = el('div', ''); hn.appendChild(el('span', '', h.home));
        hn.appendChild(el('small', '', (h.signInPresent === true ? 'a sign-in is present (not read)' : h.signInPresent === false ? 'no sign-in file' : 'sign-in: not detectable') + (h.sessionsPresent ? ' · native sessions present' : '')));
        hr.appendChild(hn);
        hr.appendChild(el('span', 'pstate', h.adoptedBy ? 'registered as ' + h.adoptedBy : 'found'));
        var ha = el('div', '');
        if (!h.adoptedBy && d.installed) {
          var ad = el('button', 'btn small', 'Adopt');
          ad.title = 'Register this home as an account. LAIN talks to ' + d.displayName + ' there; nothing is copied.';
          ad.onclick = async function () {
            ad.disabled = true;
            var x = await L.api('/api/instances/adopt', { driver: d.driver, home: h.home });
            if (!x.ok) { ad.disabled = false; return L.toast(x.why, true); }
            L.toast('Registered ' + x.instance.display_name + '. Nothing was copied.');
            found = null; await load();
          };
          ha.appendChild(ad);
        }
        hr.appendChild(ha);
        pane.appendChild(hr);
      });
    });
    pane.appendChild(el('div', 'missing', 'Found by looking — a home’s files are checked for existence only, never read. Adopt registers a home; it copies nothing. LAIN never downloads a runtime by itself.'));
  }

  L.instances = {
    load: load, get: function () { return { data: data, loading: loading, at: at }; }, on: function (f) { listeners.push(f); },
    renderList: renderList, renderAdd: renderAdd, renderRuntimes: renderRuntimes, select: function (id) { selected = id; emit(); },
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
