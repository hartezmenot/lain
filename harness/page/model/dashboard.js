'use strict';

/**
 * THE MODEL DASHBOARD — the one secure management surface for every LAIN frontend. The Harness shows it as
 * MODEL; the CLI opens it with `/model manage`, `/account add` and `/api add` (fabric/dashlaunch.js); the tray
 * opens it from "Models & Accounts". It reads and writes the ONE Core-owned intelligence fabric (/api/intel/*,
 * /api/migrate/*) — nothing here keeps a copy, and nothing sends a request to a model.
 *
 *   Accounts   one flat plane per provider (model/model.js tints them): the name, "N accounts", the account
 *              policy ("Automatic ▾"), "+ Account", ⋯ — and the CONNECTED accounts as rows on it: name,
 *              masked identity, status, and only the quota windows the provider reported, as what REMAINS.
 *              What is not capacity (imported entries that need a sign-in, profiles found on this PC) is a
 *              notice line that opens its own page — never part of the list.
 *   Setup      those entries, each with its migration class and the factual reason: a portable sign-in
 *              migrates, a native profile is adopted — neither signs in again; only a sign-in that cannot
 *              be carried over (another app's OAuth client, app-bound, expired, metadata only) asks for one.
 *   Models     the logical catalog by provider, searched in Core's index
 *   API        API sources only (keys go straight to the Windows secret store). Z.ai is an API here:
 *              LAIN integrates Z.ai through its API, and never through a ZCode sign-in.
 *   Defaults   one row per kind of work: "Codex · GPT-6 Sol · High"
 *
 * A KEY IS ENTERED ONLY HERE (API › Add API key), never in the terminal and never in a conversation.
 */

const CSS = `
.u-nm .u-mark{width:18px;height:18px}
.dsh-back{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:13px;color:var(--text-secondary)}
.dsh-back:hover{color:var(--text-primary)}
.dsh-h{font:600 17px/1.25 var(--display);margin:0;color:var(--text-primary)}
.dsh-toggle{margin-right:-4px;transition:transform .12s ease}
.dsh-apilinks{margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px dashed var(--separator);display:flex;flex-direction:column;gap:2px}
.dsh-al-h{font-size:var(--fs-caption);font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin:0 0 4px 8px}
.dsh-al{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-sm);background:none;border:0;color:var(--text-secondary);text-align:left;font:inherit;font-size:var(--fs-small);cursor:pointer}
.dsh-al:hover{background:var(--surface-active)}
.dsh-al .n{color:var(--text-primary);font-weight:500;white-space:nowrap}
.dsh-al .m{color:var(--text-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.u-row[data-inuse] .u-nm{color:var(--text-primary)}
.dsh-auth{padding:12px 16px;border-radius:var(--radius-md);background:var(--plane-accent)}
.dsh-auth-t{font:600 14px/1.3 var(--sans);color:var(--text-primary);margin-bottom:4px}
.dsh-steps{margin:0;font-size:12.5px;color:var(--text-muted)}
.dsh-steps b{color:var(--text-primary);font-weight:600}
.dsh-acts{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.dsh-class{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dsh-class.ok{color:var(--positive)} .dsh-class.warn{color:var(--warning)} .dsh-class.bad{color:var(--danger)}
.dsh-mrow small{display:block;font-size:12px;color:var(--text-muted);font-weight:400;margin-top:1px}
.dsh-roles .u-row{grid-template-columns:140px minmax(0,1fr) 18px;align-items:center}
.dsh-roles .u-row .v{font-size:13.5px;color:var(--text-primary)}
.dsh-roles .u-row .v.none{color:var(--text-muted)}
.dsh-check{width:16px;height:16px;accent-color:var(--accent-primary);margin-top:2px}
.dsh-order{display:flex;gap:2px}
@media (max-width:820px){.dsh-roles .u-row{grid-template-columns:minmax(0,1fr) 18px}.dsh-roles .u-row .v{grid-column:1 / -1}}
/* ADD ACCOUNT, BOTH WAYS: two curved choices — a subscription sign-in or an API key. */
.methoddlg{width:min(460px,calc(100vw - 32px))}
.methoddlg .md-sub{margin:0 0 14px;color:var(--text-secondary);font-size:var(--fs-body)}
.md-opt{display:flex;align-items:flex-start;gap:12px;width:100%;padding:14px;margin-bottom:8px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);text-align:left;transition:box-shadow var(--t-hover) var(--ease),background var(--t-hover) var(--ease)}
.md-opt:hover,.md-opt:focus-visible{box-shadow:inset 0 0 0 1px var(--accent-border);background:var(--surface-active)}
.md-ic{width:36px;height:36px;border-radius:var(--radius-sm);display:grid;place-items:center;background:var(--accent-weak);color:var(--accent-primary);flex:none}
.md-opt[data-method=api] .md-ic{background:var(--secondary-weak);color:var(--accent-secondary)}
.md-t b{display:block;font-size:var(--fs-body);font-weight:600;color:var(--text-primary)}
.md-t small{display:block;margin-top:3px;font-size:var(--fs-small);line-height:1.45;color:var(--text-secondary)}
/* PRIORITY IS THE ORDER (2026-10-02): a quiet grip on the left; drag lifts the row and the others make room. */
.dsh-rows .u-row{grid-template-columns:18px minmax(0,1fr) minmax(0,1.25fr) 28px;gap:6px 14px;position:relative;transition:transform var(--t-drop) var(--ease),opacity var(--t-hover) var(--ease)}
.dsh-grip{width:18px;height:30px;display:grid;place-items:center;align-self:center;color:var(--text-muted);opacity:0;cursor:grab;touch-action:none;border-radius:var(--radius-sm);background:none;border:0;padding:0;transition:opacity var(--t-hover) var(--ease),color var(--t-hover) var(--ease)}
.dsh-grip svg{width:14px;height:14px}
.dsh-rows .u-row:hover .dsh-grip,.dsh-grip:focus-visible,.dsh-rows.dragging .dsh-grip{opacity:.8}
.dsh-grip:hover{color:var(--text-primary)}
.dsh-rows.dragging,.dsh-rows.dragging *{cursor:grabbing!important;user-select:none}
.dsh-rows .u-row.lift{transition:none;z-index:3;background:var(--surface-raised);box-shadow:0 10px 28px rgba(0,0,0,.28),0 0 0 1px var(--border-subtle);border-radius:var(--radius-md)}
.dsh-rows .u-row.lift + .u-row,.dsh-rows .u-row.lift{border-top-color:transparent}
.u-row[data-enabled=false] .u-id,.u-row[data-enabled=false] .u-qs{opacity:.55}
.dsh-new{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--accent-primary);padding:1px 6px;border-radius:999px;background:var(--accent-weak);margin-left:8px;vertical-align:middle}
.dsh-gone .u-nm span{color:var(--text-muted)}
.dsh-modelsnote{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-small);color:var(--accent-primary);margin-right:auto}
@media (max-width:1000px){.dsh-rows .u-row{grid-template-columns:18px minmax(0,1fr) 28px}.dsh-rows .u-row .u-qs{grid-column:2 / -1}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var U = L.kit;
  var D = {
    fams: null, lanes: null, at: 0, loading: null,
    disc: null, discLoading: null, using: {},
    q: '', filt: { family: '', capability: '' }, seq: 0,
    imp: null, refreshing: false, apiInfo: null, watch: null,
    auth: null, authTimer: null, opened: {}, install: null,
  };
  var redraw = function () { if (L.modelView) L.modelView.draw(); };
  var EFF = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  var POLICY = {
    auto: ['Automatic', 'Automatic fallback', 'The next healthy account that serves the same model and effort'],
    ask: ['Ask on limit', 'Ask before switching', 'LAIN proposes the next account and waits for you'],
    pinned: ['One account', 'Use one account only', 'Never switched without asking'],
  };
  var AUTH = { oauth: 'OAuth — signed in through the provider’s own flow', runtime: 'Runtime — the provider’s own program keeps the sign-in', api: 'API key', local: 'Local — nothing to sign in to' };

  // ---- data ---------------------------------------------------------------------------------------------------
  function load(force) {
    if (!force && D.fams && Date.now() - D.at < 8000) return Promise.resolve(D.fams);
    if (D.loading) return D.loading;
    D.loading = L.api('/api/intel/families', {}).then(function (r) {
      D.loading = null;
      if (r && r.ok) { D.fams = r.families; D.groups = r.groups || []; D.lanes = r.lanes; D.at = Date.now(); }
      redraw();
      return D.fams;
    }, function () { D.loading = null; return D.fams; });
    return D.loading;
  }
  /** DISCOVER: native profiles on this PC. Existence only — asked whenever Accounts opens and on Refresh. */
  function loadDisc(force) {
    if (D.discLoading) return D.discLoading;
    if (!force && D.disc) return Promise.resolve(D.disc);
    D.discLoading = L.api('/api/intel/discovered', { force: Boolean(force) }).then(function (r) {
      D.discLoading = null;
      var next = (r && r.ok && r.discovered) || [];
      var changed = JSON.stringify(next) !== JSON.stringify(D.disc);
      D.disc = next;
      if (changed) redraw();
      return D.disc;
    }, function () { D.discLoading = null; return D.disc; });
    return D.discLoading;
  }
  function fam(id) { return (D.fams || []).filter(function (f) { return f.id === id; })[0] || null; }
  function activeOn(a) { var l = D.lanes || {}; return (l.chat && l.chat.account === a.id) || (l.coding && l.coding.account === a.id); }
  function laneOn(f, m) { var l = D.lanes || {}; var u = []; if (l.chat && l.chat.family === f.id && (!m || l.chat.model === m)) u.push('Chat'); if (l.coding && l.coding.family === f.id && (!m || l.coding.model === m)) u.push('Coding'); return u; }
  function confirmThen(text, ok, fn) { L.confirm(text, { ok: ok, danger: true }).then(function (y) { if (y) fn(); }); }
  async function after(r, done) {
    if (!r || !r.ok) { L.toast((r && r.why) || 'not done', true); return false; }
    if (done) L.toast(done);
    await load(true);
    L.poll();
    return true;
  }
  function go(sec, item) { if (L.modelView && L.modelView.go) L.modelView.go(sec, item); else L.nav.go('model', { section: sec, item: item || null }); }
  function timeOf(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---- toolbar per tab (drawn in the page heading) ------------------------------------------------------------
  /** What is waiting apart from the daily list: entries to finish, old entries, profiles found on this PC. */
  function counts() {
    var setup = 0, obsolete = 0;
    (D.fams || []).forEach(function (f) { (f.setup || []).forEach(function (p) { setup++; if (p.obsolete) obsolete++; }); });
    return { setup: setup, obsolete: obsolete, disc: (D.disc || []).length };
  }
  function actions(sec) {
    if (sec === 'accts') {
      var c = counts();
      var rf = U.button(D.refreshing ? 'Refreshing…' : 'Refresh all', 'ghost', refresh, 'refresh'); rf.disabled = D.refreshing; rf.setAttribute('data-act', 'refresh'); rf.title = 'Re-read every account (identity, health, quota) and every provider’s model list';
      var cn = U.button('Add account', 'pri', function () { go('connect'); }, 'plus'); cn.setAttribute('data-act', 'connect');
      // DAILY USE IS THE ACCOUNTS; migration and discovery live behind this menu.
      var more = U.overflow([
        { label: 'Discovered accounts' + (c.disc ? ' (' + c.disc + ')' : ''), run: function () { go('discovered'); } },
        { label: 'Finish setup' + (c.setup ? ' (' + c.setup + ')' : ''), note: 'accounts that are not usable yet, and why', run: function () { go('setup'); } },
        { sep: true },
        { label: 'Import accounts', run: function () { go('import'); } },
      ], 'More account actions'); more.setAttribute('data-act', 'accounts-more');
      return [rf, cn, more];
    }
    if (sec === 'api') { var ad = U.button('Add API key', 'pri', addApi, 'plus'); ad.setAttribute('data-act', 'add-api'); return [ad]; }
    if (sec === 'models') {
      var out = [];
      var nn = newModelCount();
      if (nn) { var note = el('span', 'dsh-modelsnote', nn + ' new model' + (nn === 1 ? '' : 's')); note.setAttribute('data-newmodels', String(nn)); out.push(note); }
      var rm = U.button(D.modelsRefreshing ? 'Refreshing…' : 'Refresh models', 'ghost', function () { refreshModels(null); }, 'refresh'); rm.disabled = Boolean(D.modelsRefreshing); rm.setAttribute('data-act', 'refresh-models'); rm.title = 'Ask every provider which models it serves now — nothing is selected for you';
      out.push(rm);
      return out;
    }
    return [];
  }
  /** REFRESH ALL — deliberately both: every account (identity, health, quota) and every provider's model list. */
  async function refresh() {
    if (D.refreshing) return;
    D.refreshing = true; redraw();
    try {
      await Promise.all([L.api('/api/intel/refresh', { force: true }).catch(function () { return null; }), loadDisc(true)]);
      var r = await L.api('/api/models/refresh', {}).catch(function () { return null; });
      announceModels(r);
      await load(true);
    } finally { D.refreshing = false; redraw(); }
  }
  /**
   * REFRESH MODELS — one provider (`fid`) or all: the provider's own listing, as a new catalog generation. A model that
   * appears is only made available: the default and every session keep what they had.
   */
  async function refreshModels(fid) {
    if (D.modelsRefreshing) return;
    D.modelsRefreshing = fid || 'all'; redraw();
    try {
      var r = await L.api('/api/models/refresh', fid ? { family: fid } : {}).catch(function (e) { return { ok: false, why: e.message }; });
      if (!r || !r.ok) L.toast((r && r.why) || 'The model lists could not be read', true);
      else announceModels(r, fid);
      await load(true);
    } finally { D.modelsRefreshing = null; redraw(); }
  }
  function announceModels(r, fid) {
    if (!r || !r.ok) return;
    var s = (r.summaries || []).filter(Boolean);
    if (!s.length) { if (fid !== undefined) L.toast('Models are up to date' + (fid ? ' for ' + ((fam(fid) || {}).label || fid) : '') + '.'); return; }
    L.toast(s.slice(0, 2).join('\n\n'));
  }
  function newModelCount() { return (D.fams || []).reduce(function (n, f) { return n + (f.newModels || 0); }, 0); }

  // ===============================================================================================================
  // ACCOUNTS — the connected accounts, one plane per provider. Nothing else.
  // ===============================================================================================================
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function collapsedSet() { try { return JSON.parse(localStorage.getItem('lain.dash.collapsed') || '{}') || {}; } catch (e) { return {}; } }
  function setCollapsed(id, on) { try { var c = collapsedSet(); if (on) c[id] = 1; else delete c[id]; localStorage.setItem('lain.dash.collapsed', JSON.stringify(c)); } catch (e) { /* private window */ } }

  function accounts(pane) {
    if (!D.fams) { pane.appendChild(el('div', 'u-empty', D.loading ? 'Reading your providers…' : 'Not read yet.')); load(); return; }
    loadDisc();
    var strip = authStrip(); if (strip) pane.appendChild(strip);
    var c = counts();
    // WHAT IS WAITING is a NOTICE — "3 accounts need setup" — that opens its own page. It is never part of the list.
    if (c.setup || c.disc) {
      var note = el('div', 'mnotes');
      if (c.setup) { var b1 = U.notice(plural(c.setup, 'account needs setup', 'accounts need setup'), function () { go('setup'); }, 'Review →'); b1.setAttribute('data-notice', 'setup'); note.appendChild(b1); }
      if (c.disc) { var b2 = U.notice(plural(c.disc, 'account found on this PC', 'accounts found on this PC'), function () { go('discovered'); }, 'Review →'); b2.setAttribute('data-notice', 'discovered'); note.appendChild(b2); }
      pane.appendChild(note);
    }
    var fams = D.fams.filter(function (f) { return (f.kind === 'oauth' || f.kind === 'runtime') && f.accounts.length; });
    if (!fams.length) {
      var e = U.section({ id: 'none', title: '' }); e.appendChild(U.empty('No accounts yet', 'Add a Codex, Claude or Antigravity account to use it in Chat and the Coding Agent. An API key is added under API.', 'Add account', function () { go('connect'); })); pane.appendChild(e);
      return;
    }
    var wrap = el('div', 'dsh-provs');
    fams.forEach(function (f) { wrap.appendChild(providerSection(f)); });
    pane.appendChild(wrap);
  }

  /** DISCOVERED ON THIS PC — its own surface (Accounts › ⋯ › Discovered accounts). */
  function discoveredView(pane) {
    pane.appendChild(backLink('Accounts', 'accts'));
    loadDisc(true);
    var list = D.disc || [];
    var sec = U.section({ id: 'discovered', title: 'Discovered on this PC', meta: 'Sign-ins that already exist here. Nothing is used until you choose it — and nothing is copied.' });
    sec.classList.add('first');
    if (!list.length) { sec.appendChild(U.empty('Nothing new found', 'Refresh looks again. A profile LAIN already uses is not listed.', 'Refresh', function () { refresh(); })); pane.appendChild(sec); return; }
    var rows = el('div', 'u-rows');
    list.forEach(function (d) {
      var row = el('div', 'u-row plain'); row.setAttribute('data-discovered', d.key);
      var id = el('div', 'u-id');
      var nm = el('div', 'u-nm'); nm.appendChild(U.mark(d.family)); nm.appendChild(el('span', '', d.familyLabel));
      id.appendChild(nm);
      id.appendChild(el('div', 'u-who', d.label + ' · ' + d.where));
      row.appendChild(id);
      var busy = Boolean(D.using[d.key]);
      var b = U.button(busy ? 'Adding…' : 'Use in LAIN', 'pri sm', function () { useDiscovered(d); }); b.disabled = busy; b.setAttribute('data-use', d.key);
      row.appendChild(b);
      rows.appendChild(row);
    });
    sec.appendChild(rows);
    pane.appendChild(sec);
  }
  async function useDiscovered(d) {
    D.using[d.key] = true; redraw();
    var r = await L.api('/api/intel/use', { key: d.key });
    delete D.using[d.key];
    if (!r || !r.ok) L.toast((r && r.why) || 'could not use that profile', true);
    else L.toast(d.familyLabel + ' profile added — LAIN asked it who it is.');
    await loadDisc(true); await load(true); L.poll(); redraw();
  }

  function providerSection(f) {
    var n = f.accounts.length;
    var collapsed = Boolean(collapsedSet()[f.id]);
    var limited = f.accounts.filter(function (a) { return a.limited && a.enabled !== false; });
    var off = f.accounts.filter(function (a) { return a.enabled === false; }).length;
    var meta = el('span', '');
    meta.appendChild(document.createTextNode(off ? (n - off) + ' enabled · ' + off + ' disabled' : plural(n, 'account', 'accounts')));
    if (limited.length) meta.appendChild(document.createTextNode(' · ' + limited.length + ' rate limited'));
    if (collapsed) {
      // COLLAPSED: the one thing worth reading — the account in use and its tightest window.
      var cur = f.accounts.filter(function (a) { return activeOn(a); })[0] || f.accounts[0];
      var w = (cur.quota || []).filter(function (x) { return x.remainingPercent != null; }).sort(function (x, y) { return x.remainingPercent - y.remainingPercent; })[0];
      if (w) meta.appendChild(document.createTextNode(' · ' + U.winLabel(w.label) + ' ' + Math.round(w.remainingPercent) + '% remaining'));
    }
    var acts = [];
    var pol = policySelect(f);
    acts.push(pol);
    var rmb = U.button(D.modelsRefreshing === f.id ? 'Refreshing…' : 'Refresh models', 'ghost sm', function () { refreshModels(f.id); }, 'refresh'); rmb.disabled = Boolean(D.modelsRefreshing); rmb.setAttribute('data-refresh-models', f.id); rmb.title = 'Ask ' + f.label + ' which models it serves now';
    acts.push(rmb);
    var add = U.button('Account', 'ghost sm', function () { connect(f.id); }, 'plus'); add.title = 'Add a ' + f.label + ' account'; add.setAttribute('data-add', f.id); acts.push(add);
    var owned = f.accounts.some(function (a) { return a.ownership === 'lain'; });
    acts.push(U.overflow([
      { label: 'Manage accounts', run: function () { providerSheet(f.id); } },
      { label: 'Refresh accounts', note: 'identity, health and quota', run: function () { refreshFamily(f); } },
      { label: 'Change account policy', run: function () { setTimeout(function () { pol.click(); }, 0); } },
      { sep: true },
      { label: 'Detach all from LAIN', danger: true, run: function () { detachAll(f, false); } },
      owned ? { label: 'Sign out all LAIN-owned accounts', danger: true, run: function () { detachAll(f, true); } } : null,
    ], 'More about ' + f.label));
    var sec = U.section({ id: f.id, title: f.label, mark: f.id, meta: meta, actions: acts });
    sec.classList.add('dsh-prov'); sec.setAttribute('data-family', f.id); sec.setAttribute('data-collapsed', String(collapsed));
    var h = sec.querySelector('.u-sech');
    var tg = U.iconButton('chevron', collapsed ? 'Show accounts' : 'Hide accounts', function () { setCollapsed(f.id, !collapsed); redraw(); });
    tg.setAttribute('data-toggle', f.id); tg.setAttribute('aria-expanded', String(!collapsed)); tg.style.transform = collapsed ? '' : 'rotate(90deg)'; tg.classList.add('dsh-toggle');
    h.insertBefore(tg, h.firstChild);
    var h3 = sec.querySelector('h3'); h3.style.cursor = 'pointer'; h3.setAttribute('role', 'button'); h3.tabIndex = 0; h3.title = 'Provider details';
    h3.onclick = function () { providerSheet(f.id); };
    h3.onkeydown = function (e) { if (e.key === 'Enter') providerSheet(f.id); };
    if (collapsed) {
      // ALERTS DO NOT COLLAPSE.
      limited.forEach(function (a) { var l = el('div', 'u-warnline', a.name + ' is rate limited' + (a.limited.until ? ' until ' + timeOf(a.limited.until) : '') + '.'); l.style.marginTop = 'var(--space-2)'; sec.appendChild(l); });
      return sec;
    }
    var rows = el('div', 'u-rows dsh-rows'); rows.setAttribute('data-family-rows', f.id);
    f.accounts.forEach(function (a) { rows.appendChild(accountRow(f, a)); });
    if (f.accounts.length > 1) wireDrag(rows, f);
    sec.appendChild(rows);
    var links = apiLinks(f); if (links) sec.appendChild(links);
    return sec;
  }

  // ---- PRIORITY BY DRAG (2026-10-02) ----------------------------------------------------------------------------
  /**
   * Hold the grip, move, release: the order IS the fallback priority (Core's fabric/store order — one mutation on
   * release). The lifted row follows the pointer; the others make room with a short settle; nothing is redrawn.
   */
  function wireDrag(box, f) {
    Array.prototype.forEach.call(box.querySelectorAll('.dsh-grip'), function (g) {
      g.addEventListener('click', function (e) { e.stopPropagation(); });
      g.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        var row = g.closest('.u-row');
        var rows = Array.prototype.slice.call(box.children).filter(function (r) { return r.classList.contains('u-row'); });
        var from = rows.indexOf(row);
        if (from < 0 || rows.length < 2) return;
        var rects = rows.map(function (r) { return r.getBoundingClientRect(); });
        var h = rects[from].height;
        var y0 = e.clientY; var to = from; var moved = false;
        try { g.setPointerCapture(e.pointerId); } catch (x) { /* older engines */ }
        function move(ev) {
          var dy = Math.max(rects[0].top - rects[from].top, Math.min(rects[rows.length - 1].bottom - rects[from].bottom, ev.clientY - y0));
          if (!moved && Math.abs(dy) < 3) return;
          if (!moved) { moved = true; L.dragging = true; row.classList.add('lift'); box.classList.add('dragging'); }
          row.style.transform = 'translateY(' + dy + 'px) scale(1.012)';
          // THE LEADING EDGE decides: moving up, the row's top passing a neighbour's middle; moving down, its bottom.
          var topEdge = rects[from].top + dy; var bottomEdge = rects[from].bottom + dy;
          to = from;
          for (var i = 0; i < rects.length; i++) {
            var c = rects[i].top + rects[i].height / 2;
            if (i < from && topEdge <= c && i < to) to = i;
            if (i > from && bottomEdge >= c && i > to) to = i;
          }
          rows.forEach(function (r, i) {
            if (i === from) return;
            var s = (from < to && i > from && i <= to) ? -h : (from > to && i >= to && i < from) ? h : 0;
            r.style.transform = s ? 'translateY(' + s + 'px)' : '';
          });
        }
        function up() {
          g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
          if (!moved) return;
          setTimeout(function () { L.dragging = false; }, 200);
          var target = to > from ? rects[to].bottom - rects[from].bottom : to < from ? rects[to].top - rects[from].top : 0;
          row.classList.remove('lift');
          row.style.transition = 'transform var(--t-drop) var(--ease)';
          row.style.transform = 'translateY(' + target + 'px)';
          setTimeout(function () {
            rows.forEach(function (r) { r.style.transition = 'none'; r.style.transform = ''; });
            if (to !== from) box.insertBefore(row, to > from ? rows[to].nextSibling : rows[to]);
            void box.offsetHeight;   // the new order is laid out before transitions come back: no jump, no jitter
            rows.forEach(function (r) { r.style.transition = ''; });
            box.classList.remove('dragging');
            if (to !== from) persistOrder(f, Array.prototype.map.call(box.querySelectorAll('.u-row'), function (r) { return r.getAttribute('data-account'); }));
          }, 160);
        }
        g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
      });
    });
  }
  /** One mutation, and the local order follows it — no reload, no redraw. */
  async function persistOrder(f, ids) {
    var by = {}; f.accounts.forEach(function (a) { by[a.id] = a; });
    f.accounts = ids.map(function (id, i) { var a = by[id]; if (a) a.priority = i + 1; return a; }).filter(Boolean);
    var r = await L.api('/api/intel/order', { family: f.id, order: ids }).catch(function (e) { return { ok: false, why: e.message }; });
    if (!r || !r.ok) { L.toast((r && r.why) || 'The new order could not be saved', true); await load(true); redraw(); return; }
    var n = by[ids[0]]; if (n) L.toast(n.name + ' is now first for ' + f.label);
  }
  /** THE PROVIDER FAMILY (Core's groups): the brand of this source, with every way it is reached. */
  function groupOf(f) { return (D.groups || []).filter(function (g) { return ['subscription', 'api', 'runtime', 'local'].some(function (k) { return (g[k] || []).indexOf(f.id) >= 0; }); })[0] || null; }
  /**
   * THE SAME PROVIDER BY API KEY (§61, §68): listed under the subscription, never mixed with it — its own models, its own
   * limits, billed per token. Its details live under API.
   */
  function apiLinks(f) {
    var g = groupOf(f);
    if (!g || !g.api.length) return null;
    var box = el('div', 'dsh-apilinks'); box.setAttribute('data-brand', g.id);
    box.appendChild(el('div', 'dsh-al-h', g.label + ' API'));
    g.api.forEach(function (id) {
      var af = fam(id); if (!af) return;
      var a = af.accounts[0] || {};
      var r = el('button', 'dsh-al'); r.setAttribute('data-api-link', id);
      r.appendChild(L.icon('key', 14));
      r.appendChild(el('span', 'n', af.label));
      r.appendChild(el('span', 'm', [a.usable === false ? (a.stateLabel || 'Not ready') : 'Ready', plural(af.modelCount, 'model', 'models'), 'billed per token — separate from ' + f.label + '’s windows'].join(' · ')));
      r.title = 'An API source — its models and limits are its own, never this subscription’s';
      r.onclick = function () { go('api'); };
      box.appendChild(r);
    });
    return box;
  }

  /** "Automatic ▾" — the provider's account policy. Chosen once, here; never repeated on an account. */
  function policySelect(f) {
    var btn = null;
    function set(pol, pinned) { return L.api('/api/intel/policy', { family: f.id, policy: pol, pinned: pinned }).then(function (r) { return after(r, f.label + ': ' + POLICY[pol][1]); }).then(function () { redraw(); }); }
    var items = [{ header: 'Account switching' }];
    ['auto', 'ask', 'pinned'].forEach(function (k) {
      items.push({
        label: POLICY[k][1], note: POLICY[k][2], checked: f.policy === k,
        run: function () {
          if (k !== 'pinned') { set(k); return; }
          if (f.accounts.length < 2) { set('pinned', f.accounts[0] && f.accounts[0].id); return; }
          setTimeout(function () {
            U.menu(btn, f.accounts.map(function (a) { return { label: a.name, checked: f.pinned === a.id, run: function () { set('pinned', a.id); } }; }), { title: 'Use only…' });
          }, 0);
        },
      });
    });
    var pinnedName = f.policy === 'pinned' && f.pinned ? (f.accounts.filter(function (a) { return a.id === f.pinned; })[0] || {}).name : null;
    btn = U.select(pinnedName ? 'Only ' + pinnedName : POLICY[f.policy][0], items, { id: 'policy-' + f.id });
    btn.title = 'When the account in use is rate limited';
    return btn;
  }

  function statusOf(a) {
    if (a.enabled === false) return { dot: '', text: 'Disabled' };
    if (a.inUse) return { dot: 'acc', text: 'In use' };
    if (a.limited) return { dot: 'warn', text: 'Rate limited' + (a.limited.until ? ' · resets ' + timeOf(a.limited.until) : '') };
    // SIGNED IN, NOT YET SHOWN TO ANSWER (Antigravity): its capabilities wait for a real message.
    if (a.verified === false) return { dot: 'warn', text: 'Not verified' };
    if (!a.usable) return { dot: 'warn', text: /models/i.test(a.why || '') ? 'Refresh to load models' : 'Not ready' };
    if (activeOn(a)) return { dot: 'acc', text: 'Active' };
    return { dot: 'ok', text: 'Ready' };
  }
  /** The masked identity and the plan — what a person recognises an account by. Never an internal id. */
  function whoOf(a) {
    var id = a.identity || {};
    var bits = [];
    if (id.email && a.name !== id.email) bits.push(id.email);
    else if (a.alias && a.providerName && a.providerName !== a.name) bits.push(a.providerName);
    if (id.plan) bits.push(cap(id.plan));
    return bits.join(' · ');
  }
  function accountRow(f, a) {
    var row = el('div', 'u-row click'); row.setAttribute('data-account', a.id); row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.setAttribute('data-enabled', String(a.enabled !== false));
    if (a.inUse) row.setAttribute('data-inuse', a.inUse.by);
    // THE GRIP: the order is the priority. Quiet until hover; keyboard: ↑ / ↓ on the grip (and Move… in ⋯).
    var grip = el('button', 'dsh-grip'); grip.type = 'button'; grip.setAttribute('data-grip', a.id);
    grip.setAttribute('aria-label', 'Reorder ' + a.name + ' — priority ' + (a.priority || '') + ' of ' + f.accounts.length + '. Arrow keys move it.');
    grip.title = f.accounts.length > 1 ? 'Drag to change the fallback order' : '';
    grip.appendChild(L.icon('grip', 14));
    grip.onkeydown = function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault(); e.stopPropagation();
      moveTo(f, a, (a.priority || 1) - 1 + (e.key === 'ArrowUp' ? -1 : 1), true);
    };
    if (f.accounts.length < 2) grip.style.visibility = 'hidden';
    row.appendChild(grip);
    var idc = el('div', 'u-id');
    var nm = el('div', 'u-nm'); nm.appendChild(el('span', '', a.name));
    var st = statusOf(a);
    var s = el('span', 'u-st'); s.appendChild(U.dot(st.dot)); s.appendChild(document.createTextNode(st.text)); nm.appendChild(s);
    idc.appendChild(nm);
    var who = whoOf(a); if (who) idc.appendChild(el('div', 'u-who', who));
    row.appendChild(idc);
    row.appendChild(U.quota(a.quota, a.quotaNote));
    row.appendChild(U.overflow(accountMenu(f, a), 'More about ' + a.name));
    row.onclick = function () { accountSheet(f.id, a.id); };
    row.onkeydown = function (e) { if (e.key === 'Enter') accountSheet(f.id, a.id); };
    return row;
  }
  /** EVERY connected account has this menu; only what applies to THIS account is in it. */
  function accountMenu(f, a) {
    var n = f.accounts.length; var used = Boolean(a.inUse);
    var items = [];
    if (used) {
      items.push({ header: 'In use by ' + a.inUse.by });
      items.push({ label: 'View task', run: function () { L.nav.go(a.inUse.by === 'Coding Agent' ? 'ide' : 'chat'); } });
      items.push({ label: 'Stop task…', run: function () { stopTask(a); } });
      items.push({ sep: true });
    }
    var off = a.enabled === false;
    items.push({ label: 'Details', run: function () { accountSheet(f.id, a.id); } });
    items.push({ label: 'Rename…', run: function () { rename(f, a); } });
    if (!off) items.push({ label: 'Refresh quota', run: function () { refreshAccount(f, a); } });
    if (n > 1 && f.pinned !== a.id && !off) items.push({ label: 'Use only this account', run: function () { pinOnly(f, a); } });
    items.push(off ? { label: 'Enable account', run: function () { setEnabled(f, a, true); } } : { label: 'Disable account', note: 'kept, never used for new requests', run: function () { setEnabled(f, a, false); } });
    if (n > 1) {
      var p = (a.priority || 1) - 1;
      items.push({ sep: true });
      items.push({ label: 'Move up', disabled: p <= 0, run: function () { moveTo(f, a, p - 1); } });
      items.push({ label: 'Move down', disabled: p >= n - 1, run: function () { moveTo(f, a, p + 1); } });
      items.push({ label: 'Move to top', disabled: p <= 0, run: function () { moveTo(f, a, 0); } });
      items.push({ label: 'Move to bottom', disabled: p >= n - 1, run: function () { moveTo(f, a, n - 1); } });
    }
    if (a.verified === false && !off) items.push({ label: 'Run a test message', disabled: used, run: function () { verifyAccount(f, a); } });
    items.push({ sep: true });
    items.push({ label: 'Detach from LAIN', danger: true, disabled: used, run: function () { detach(f, a); } });
    if (a.ownership === 'lain') items.push({ label: 'Sign out', danger: true, disabled: used, run: function () { signOut(f, a); } });
    return items;
  }
  async function rename(f, a) {
    var v = await L.dialog({ title: 'Rename ' + a.name, text: 'A name for you. The account’s identity is unchanged.', fields: [{ key: 'n', label: 'Name', value: a.alias || '' }], ok: 'Rename' });
    if (!v) return;
    await after(await L.api('/api/intel/alias', { id: a.id, name: v.n }), 'Renamed'); redraw();
  }
  async function pinOnly(f, a) { await after(await L.api('/api/intel/policy', { family: f.id, policy: 'pinned', pinned: a.id }), f.label + ': only ' + a.name); redraw(); }
  async function moveIn(f, a, d) { return moveTo(f, a, (a.priority || 1) - 1 + d); }
  /** Keyboard parity with the drag: the same one mutation, then the grip keeps focus. */
  async function moveTo(f, a, j, refocus) {
    var ids = f.accounts.map(function (x) { return x.id; });
    var i = ids.indexOf(a.id);
    if (i < 0 || j < 0 || j >= ids.length || i === j) return;
    ids.splice(i, 1); ids.splice(j, 0, a.id);
    await persistOrder(f, ids);
    redraw();
    if (refocus) setTimeout(function () { var g = document.querySelector('[data-grip="' + a.id + '"]'); if (g) g.focus(); }, 0);
  }
  /**
   * ENABLE / DISABLE: Core state. A disabled account keeps its sign-in, quota history, models and place; it is never
   * chosen for a new request. One a request is using right now is disabled AFTER that request — never cut off.
   */
  async function setEnabled(f, a, on) {
    if (!on && a.inUse) {
      var y = await L.confirm(a.name + ' is serving a request for the ' + a.inUse.by + ' right now. Disable it after the current request? That request finishes where it is.', { ok: 'Disable after current request' });
      if (!y) return;
    }
    var r = await L.api('/api/intel/enable', { id: a.id, enabled: on }).catch(function (e) { return { ok: false, why: e.message }; });
    if (!r || !r.ok) { L.toast((r && r.why) || 'not changed', true); return; }
    L.toast(on ? a.name + ' is enabled — back at its place in the order.' : (r.afterCurrent ? a.name + ' will not be used after the current request.' : a.name + ' is disabled — kept, not used.'));
    await load(true); L.poll(); redraw();
  }
  async function refreshAccount(f, a) {
    L.toast('Asking for ' + a.name + '’s limits…');
    var r = await L.api('/api/intel/refresh', { family: f.id, id: a.id, force: true }).catch(function () { return null; });
    await load(true); redraw();
    if (r && r.ok) L.toast(a.name + ': quota read');
  }
  /** ONE SHORT REAL MESSAGE through this account. Only its answer makes Chat and Assistant available for it. */
  async function verifyAccount(f, a) {
    L.toast('Sending one test message through ' + a.name + '…');
    var r = await L.api('/api/intel/verify', { id: a.id });
    if (!r || !r.ok) { L.toast((r && r.why) || a.name + ' did not answer.', true); return; }
    L.toast(a.name + ' answered — Chat and Assistant are now available for it.');
    await load(true); L.poll(); redraw();
  }
  async function refreshFamily(f) { L.toast('Reading ' + f.label + '’s accounts…'); await L.api('/api/intel/refresh', { family: f.id, force: true }).catch(function () { return null; }); await load(true); redraw(); }

  // ---- REMOVING AN ACCOUNT: three different acts, never "delete account" ------------------------------------------------
  /** A refusal because a request is running through the account: said plainly, with the way out. */
  function refusedBusy(r) { L.toast((r && r.why) || 'That account is in use.', true); return load(true).then(redraw); }
  function detach(f, a) {
    confirmThen('Detach ' + a.name + ' from LAIN? LAIN forgets it — nothing is signed out' + (a.ownership === 'lain' ? '' : ', and your own profile is untouched') + '.', 'Detach', async function () {
      var r = await L.api('/api/intel/detach', { id: a.id, mode: 'detach' });
      if (r && r.busy) return refusedBusy(r);
      await after(r, a.name + ' detached'); redraw();
    });
  }
  function signOut(f, a) {
    confirmThen('Sign ' + a.name + ' out of ' + f.label + '? This uses the provider’s own sign-out, in this account’s own directory only — no other account is touched.', 'Sign out', async function () {
      var r = await L.api('/api/intel/detach', { id: a.id, mode: 'sign-out', confirm: true });
      if (r && r.busy) return refusedBusy(r);
      await after(r, a.name + ' signed out'); redraw();
    });
  }
  function removeProfile(f, a) {
    confirmThen('Sign ' + a.name + ' out and delete the profile LAIN made for it? Other accounts are not touched.', 'Remove profile', async function () {
      var r = await L.api('/api/intel/detach', { id: a.id, mode: 'remove-profile', confirm: true });
      if (r && r.busy) return refusedBusy(r);
      await after(r, 'Profile removed'); redraw();
    });
  }
  async function stopTask(a) {
    var y = await L.confirm('Stop the task now running through ' + a.name + '? It ends where it is; nothing else changes.', { ok: 'Stop task', danger: true });
    if (!y) return;
    await L.api('/api/interrupt', {});
    L.toast('Stopping…'); setTimeout(function () { load(true).then(redraw); }, 1200);
  }
  /** DETACH ALL — every account of this provider; one in use is left alone and named. A LAIN-owned sign-out is a stronger, separate act. */
  async function detachAll(f, signOutOwned) {
    var names = f.accounts.map(function (a) { return a.name; });
    var busy = f.accounts.filter(function (a) { return a.inUse; });
    var owned = f.accounts.filter(function (a) { return a.ownership === 'lain'; });
    if (!signOutOwned) {
      var text = 'Detach all ' + names.length + ' ' + f.label + ' account' + (names.length === 1 ? '' : 's') + ' from LAIN (' + names.join(', ') + ')? LAIN forgets them. Nothing is signed out, and your own profiles are untouched.';
      if (busy.length) text += '\n\n' + busy.map(function (a) { return a.name; }).join(', ') + ' ' + (busy.length === 1 ? 'is' : 'are') + ' in use right now and will be left.';
      var y = await L.confirm(text, { ok: 'Detach all', danger: true });
      if (!y) return;
    } else {
      var v = await L.dialog({ title: 'Sign out all LAIN-owned ' + f.label + ' accounts', text: 'This signs out ' + owned.length + ' account' + (owned.length === 1 ? '' : 's') + ' LAIN made (' + owned.map(function (a) { return a.name; }).join(', ') + ') through the provider’s own sign-out, in each one’s own directory, and deletes those profiles. Your own profiles are never signed out. Accounts in use are left.', fields: [{ key: 'w', label: 'Type SIGN OUT to confirm', value: '' }], ok: 'Sign out all' });
      if (!v || String(v.w).trim() !== 'SIGN OUT') { if (v) L.toast('Nothing was signed out — the confirmation did not match.', true); return; }
    }
    var r = await L.api('/api/intel/detach-all', { family: f.id, signOut: signOutOwned, confirm: true });
    if (!r || !r.ok) { L.toast((r && r.why) || 'not done', true); return; }
    L.toast(plural(r.removed, 'account', 'accounts') + (signOutOwned ? ' signed out' : ' detached') + (r.skipped && r.skipped.length ? ' — ' + r.skipped.map(function (x) { return x.name; }).join(', ') + ' in use, left as it was' : ''));
    await load(true); L.poll(); redraw();
  }

  // ---- SETUP: its own page (Accounts › “N accounts need setup”) ------------------------------------------------------------
  function setupRow(f, p) {
    var row = el('div', 'u-row plain'); row.setAttribute('data-setup', p.id); row.setAttribute('data-lifecycle', p.lifecycle);
    var idc = el('div', 'u-id');
    var nm = el('div', 'u-nm'); nm.appendChild(el('span', '', p.name)); idc.appendChild(nm);
    // THE CLASS AND THE FACTUAL REASON (fabric/migrate.js): why this one needs a sign-in, or cannot be used.
    var unsupported = p.state === 'UNSUPPORTED';
    var cls = el('div', 'dsh-class ' + (unsupported ? 'bad' : 'warn'), unsupported ? 'Unsupported' : p.lifecycle === 'DISCONNECTED' ? 'Signed out' : 'Needs sign-in');
    idc.appendChild(cls);
    var line = [p.identityHint, p.obsolete ? p.obsoleteWhy : p.note].filter(Boolean).join(' · ');
    if (line) { var who = el('div', 'u-who', line); who.style.whiteSpace = 'normal'; idc.appendChild(who); }
    row.appendChild(idc);
    var acts = el('div', 'dsh-acts');
    if (!p.obsolete && p.state !== 'UNSUPPORTED') { var fs = U.button('Sign in', 'pri sm', function () { finishSignIn(f, p); }); fs.setAttribute('data-finish-signin', p.id); acts.appendChild(fs); }
    var dc = U.button(p.instanceId ? 'Remove' : 'Discard', 'danger sm', function () { discard(f, p); }); dc.setAttribute('data-discard', p.id); acts.appendChild(dc);
    row.appendChild(acts);
    return row;
  }
  function setupView(pane) {
    pane.appendChild(backLink('Accounts', 'accts'));
    var strip = authStrip(); if (strip) pane.appendChild(strip);
    if (!D.fams) { pane.appendChild(el('div', 'u-empty', 'Reading…')); load(); return; }
    var fresh = [], old = [];
    D.fams.forEach(function (f) { (f.setup || []).forEach(function (p) { (p.obsolete ? old : fresh).push({ f: f, p: p }); }); });
    pane.appendChild(el('h2', 'dsh-h', 'Setup'));
    pane.appendChild(el('p', 'u-note', 'These are not used until they are signed in — never counted, never chosen for fallback. A sign-in that could be carried over was migrated or adopted already; the ones here could not, and each says why.'));
    if (!fresh.length) { var none = U.section({ id: 'setup', title: '' }); none.appendChild(U.empty('Nothing needs setup', 'Every account LAIN knows about is either connected or was dealt with.')); pane.appendChild(none); }
    var byFam = {}; var order = [];
    fresh.forEach(function (x) { if (!byFam[x.f.id]) { byFam[x.f.id] = []; order.push(x.f); } byFam[x.f.id].push(x); });
    order.forEach(function (f) {
      var g = U.section({ id: 'setup-' + f.id, title: f.label, mark: f.id, meta: plural(byFam[f.id].length, 'account', 'accounts') });
      g.setAttribute('data-setup-family', f.id);
      var rows = el('div', 'u-rows');
      byFam[f.id].forEach(function (x) { rows.appendChild(setupRow(x.f, x.p)); });
      g.appendChild(rows); pane.appendChild(g);
    });
    if (old.length) {
      var os = U.section({ id: 'old-setup', title: plural(old.length, 'old entry', 'old entries'), meta: 'Left over from earlier imports. Nothing is deleted until you say so.' });
      os.setAttribute('data-old-setup', String(old.length));
      var orows = el('div', 'u-rows');
      old.forEach(function (x) { orows.appendChild(setupRow(x.f, x.p)); });
      os.appendChild(orows);
      var all = U.button('Discard all ' + old.length, 'line sm', function () {
        confirmThen('Discard ' + plural(old.length, 'old setup entry', 'old setup entries') + '? Nothing is signed out anywhere.', 'Discard all', async function () {
          for (var i = 0; i < old.length; i++) await L.api('/api/intel/detach', { id: old[i].p.id, mode: 'detach' });
          await load(true); L.toast('Old entries discarded'); redraw();
        });
      });
      all.setAttribute('data-discard-old', '1'); all.style.marginTop = 'var(--space-3)';
      os.appendChild(all);
      pane.appendChild(os);
    }
  }
  async function finishSignIn(f, p) {
    if (p.instanceId) {
      // A LAIN-made Claude or Antigravity account signs in AGAIN in its OWN directory (an AuthSession that reuses it);
      // Codex signs its own home in through Codex. Never another account's directory.
      if (f.id === 'claude' || f.id === 'antigravity') return startAuth(f.id, { reuse: p.instanceId });
      var r = await L.api('/api/instances/login', { id: p.instanceId });
      if (r && r.ok && r.login && r.login.url && L.openExternal) { L.openExternal(r.login.url); L.toast('Finish the sign-in in your browser.'); watchConnect(f.id); }
      else L.toast((r && r.why) || 'the sign-in did not start', true);
      return;
    }
    connect(f.id);
  }
  function discard(f, p) {
    confirmThen((p.instanceId ? 'Remove ' : 'Discard ') + p.name + ' from LAIN? Nothing is signed out anywhere.', p.instanceId ? 'Remove' : 'Discard', async function () {
      var r = await L.api('/api/intel/detach', { id: p.id, mode: 'detach' });
      if (r && r.busy) return refusedBusy(r);
      await after(r, 'Removed'); redraw();
    });
  }

  // ---- PROVIDER DETAILS: accounts, models, quota, policy, authentication -----------------------------------------
  async function providerSheet(id) {
    var r = await L.api('/api/intel/family', { id: id });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not read it', true); return; }
    var f = r.family;
    var sh = U.sheet({ title: f.label, meta: f.accounts.length + ' connected' + (f.setup.length ? ' · ' + f.setup.length + ' setup pending' : ''), mark: f.id, id: 'provider-' + f.id, onClose: function () { load(true); } });
    var b = sh.body;
    // POLICY
    var g = U.group('Account switching');
    if (f.accounts.length) {
      var pol = POLICY[f.policy];
      g.appendChild(U.setting(pol[1], pol[2], policySelect(f)));
    } else g.appendChild(el('div', 'u-note', 'No connected accounts yet.'));
    b.appendChild(g);
    // ACCOUNTS + PRIORITY
    var ga = U.group('Accounts');
    if (f.accounts.length > 1) ga.appendChild(el('div', 'u-note', 'The order below is the automatic-fallback order.'));
    var rows = el('div', 'u-rows');
    f.accounts.forEach(function (a, i) {
      var row = el('div', 'u-row plain'); row.setAttribute('data-account', a.id);
      var idc = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(el('span', '', (f.accounts.length > 1 ? (i + 1) + '  ' : '') + a.name)); var st = statusOf(a); var s = el('span', 'u-st'); s.appendChild(U.dot(st.dot)); s.appendChild(document.createTextNode(st.text)); nm.appendChild(s); idc.appendChild(nm);
      var who = whoOf(a); if (who) idc.appendChild(el('div', 'u-who', who));
      row.appendChild(idc);
      var ord = el('div', 'dsh-order');
      if (f.accounts.length > 1) {
        var up = U.iconButton('chevron', 'Earlier in the fallback order', function () { reorder(f, i, -1, sh); }); up.disabled = i === 0; up.style.transform = 'rotate(-90deg)'; up.setAttribute('data-move', 'up');
        var dn = U.iconButton('chevron', 'Later in the fallback order', function () { reorder(f, i, 1, sh); }); dn.disabled = i === f.accounts.length - 1; dn.style.transform = 'rotate(90deg)'; dn.setAttribute('data-move', 'down');
        ord.appendChild(up); ord.appendChild(dn);
      }
      var mo = U.overflow(accountMenu(f, a), 'More about ' + a.name); ord.appendChild(mo);
      row.appendChild(ord);
      row.classList.add('click'); row.onclick = function () { sh.close(); accountSheet(f.id, a.id); };
      rows.appendChild(row);
    });
    ga.appendChild(rows);
    var addb = U.button('Add account', 'line sm', function () { sh.close(); connect(f.id); }, 'plus'); addb.style.marginTop = 'var(--space-3)'; ga.appendChild(addb);
    b.appendChild(ga);
    // QUOTA
    var gq = U.group('Quota');
    var labels = []; f.accounts.forEach(function (a) { (a.quota || []).forEach(function (w) { var l = U.winLabel(w.label); if (l && labels.indexOf(l) < 0) labels.push(l); }); });
    gq.appendChild(el('div', 'u-note', labels.length ? 'Reported windows: ' + labels.join(' · ') + '.' : 'This provider has not reported any quota window.'));
    b.appendChild(gq);
    // MODELS
    var gm = U.group('Models');
    var ml = f.models || [];
    if (!ml.length) gm.appendChild(el('div', 'u-note', 'No models yet.'));
    var mrows = el('div', 'u-rows');
    ml.slice(0, 40).forEach(function (m) {
      var row = el('div', 'u-row plain click'); row.setAttribute('data-model', f.id + '|' + m.id);
      var idc = el('div', 'u-id'); idc.appendChild(el('div', 'u-nm', m.label)); row.appendChild(idc);
      row.appendChild(el('div', 'u-note', (m.effortLabels && m.effortLabels.length) ? m.effortLabels.join(' · ') : ''));
      row.onclick = function () { sh.close(); modelSheet(f.id, m.id); };
      mrows.appendChild(row);
    });
    gm.appendChild(mrows);
    if (ml.length > 40) { var more = el('button', 'u-link', '+' + (ml.length - 40) + ' more — in Models'); more.onclick = function () { sh.close(); D.q = ''; D.filt.family = f.id; go('mdl'); }; gm.appendChild(more); }
    b.appendChild(gm);
    // AUTHENTICATION
    var gu = U.group('Authentication');
    gu.appendChild(U.kv([['Method', AUTH[f.kind] || ''], ['Endpoint', f.endpoint || null]]));
    b.appendChild(gu);
    // RECENT
    if ((r.events || []).length) {
      var ge = U.group('Recent');
      r.events.slice(-6).reverse().forEach(function (e) { ge.appendChild(el('div', 'u-note', new Date(e.at).toLocaleString() + ' · ' + (e.type === 'fallback' ? 'switched ' + ((e.from && e.from.name) || '') + ' → ' + ((e.to && e.to.name) || '') + (e.reason ? ' · ' + e.reason : '') : e.type))); });
      b.appendChild(ge);
    }
  }
  async function reorder(f, i, d, sh) {
    var ids = f.accounts.map(function (a) { return a.id; });
    var j = i + d; if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    await after(await L.api('/api/intel/order', { family: f.id, order: ids }), 'Fallback order saved');
    sh.close(); providerSheet(f.id);
  }

  // ---- ACCOUNT DETAILS --------------------------------------------------------------------------------------------
  async function accountSheet(fid, aid) {
    await load();
    var f = fam(fid); var a = f && f.accounts.filter(function (x) { return x.id === aid; })[0];
    if (!a) { L.toast('That account is no longer here.', true); return; }
    var st = statusOf(a);
    var sh = U.sheet({ title: a.name, meta: f.label + ' account', mark: f.id, id: 'account-' + a.id, onClose: function () { load(true); } });
    var b = sh.body;
    var g1 = U.group('Identity');
    g1.appendChild(U.kv([['Account', (a.identity && a.identity.email) || a.name], ['Plan', a.identity && a.identity.plan ? cap(a.identity.plan) : null], ['Authentication', AUTH[f.kind] || ''], ['Status', st.text], ['Answers requests', a.verified === true ? 'Yes — a real message succeeded' : a.verified === false ? 'Not yet — send a test message' : null], ['Priority', f.accounts.length > 1 ? a.priority + ' of ' + f.accounts.length : null]]));
    b.appendChild(g1);
    var g2 = U.group('Quota'); g2.appendChild(U.quota(a.quota, a.quotaNote)); b.appendChild(g2);
    var g3 = U.group('Actions'); var col = el('div', 'u-acts-col');
    var used = Boolean(a.inUse);
    var act = function (label, kind, fn, off) { var x = U.button(label, kind || 'ghost', function () { fn(); }); if (off) x.disabled = true; col.appendChild(x); return x; };
    if (used) col.appendChild(el('div', 'u-note', 'In use by ' + a.inUse.by + ' — Detach and Sign out wait until it finishes, or you stop it.'));
    if (used) { act('View task', 'ghost', function () { sh.close(); L.nav.go(a.inUse.by === 'Coding Agent' ? 'ide' : 'chat'); }); act('Stop task…', 'ghost', function () { sh.close(); stopTask(a); }); }
    act('Rename…', 'ghost', function () { sh.close(); rename(f, a); });
    if (f.accounts.length > 1 && f.pinned !== a.id) act('Use only this account', 'ghost', function () { sh.close(); pinOnly(f, a); });
    if (f.accounts.length > 1) {
      if (a.priority > 1) act('Move priority earlier', 'ghost', function () { movePriority(f, a, -1, sh); });
      if (a.priority < f.accounts.length) act('Move priority later', 'ghost', function () { movePriority(f, a, 1, sh); });
    }
    act('Refresh quota', 'ghost', function () { sh.close(); refreshAccount(f, a); });
    if (a.verified === false) act('Run a test message', 'ghost', function () { sh.close(); verifyAccount(f, a); }, used);
    act('Detach from LAIN', 'danger', function () { sh.close(); detach(f, a); }, used);
    if (a.ownership === 'lain') {
      act('Sign out', 'danger', function () { sh.close(); signOut(f, a); }, used);
      act('Remove LAIN-owned profile', 'danger', function () { sh.close(); removeProfile(f, a); }, used);
    } else col.appendChild(el('div', 'u-note', 'This is your own profile. Detach only makes LAIN forget it — to sign out, do it inside ' + f.label + '.'));
    g3.appendChild(col); b.appendChild(g3);
    // DETAILS — the technical facts, for the rare time they are wanted.
    var g4 = U.group('Details'); b.appendChild(g4);
    L.api('/api/instances', {}).then(function (r) {
      var v = ((r && r.instances) || []).filter(function (x) { return x.id === a.instanceId; })[0] || null;
      g4.appendChild(U.kv([
        ['Account ID', a.instanceId || a.id],
        ['Ownership', a.ownership === 'lain' ? 'LAIN-owned profile' : a.ownership === 'external_native' ? 'Your own profile (external)' : null],
        ['Profile location', v && v.config_home ? v.config_home : null],
        ['Created', v && v.created_at ? new Date(v.created_at).toLocaleString() : null],
        ['Last refresh', v && v.refreshed_at ? new Date(v.refreshed_at).toLocaleString() : null],
        ['Priority', String(a.priority)],
      ]));
    }, function () { g4.appendChild(U.kv([['Account ID', a.instanceId || a.id]])); });
  }
  async function movePriority(f, a, d, sh) {
    var ids = f.accounts.map(function (x) { return x.id; });
    var i = ids.indexOf(a.id), j = i + d; if (i < 0 || j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    await after(await L.api('/api/intel/order', { family: f.id, order: ids }), 'Priority saved');
    sh.close(); accountSheet(f.id, a.id);
  }

  // ===================================================================================================================
  // CONNECT — a NEW account through the provider's own sign-in
  // ===================================================================================================================
  var CONNECTABLE = [
    ['codex', 'Codex', 'ChatGPT subscription or an OpenAI API key', 'OAuth · API'],
    ['claude', 'Claude', 'Claude subscription or an Anthropic API key', 'OAuth · API'],
    ['antigravity', 'Antigravity', 'Google sign-in through Antigravity', 'OAuth'],
    ['zai', 'Z.ai', 'LAIN integrates Z.ai through its API', 'API'],
    ['opencode', 'OpenCode', 'OpenCode keeps its own sign-in', 'Runtime'],
  ];
  /**
   * HOW EACH PROVIDER CONNECTS IN LAIN (2026-09-30): both ways (a chooser — they are different sources with
   * different quotas, never the same thing), OAuth only (straight to the provider's sign-in), API only (straight to
   * the key). The result is recorded as what it is: a subscription account, or an API connection.
   */
  var METHODS = {
    codex: { oauth: 'Your ChatGPT subscription, through Codex’s own sign-in in your browser. Its 5-hour and weekly windows are the subscription’s.', api: ['openai', 'An OpenAI API key — billed per token by OpenAI. Its limits are the API’s, never the subscription’s.'] },
    claude: { oauth: 'Your Claude subscription (Pro or Max), signed in through Claude’s own flow in a private profile.', api: ['anthropic', 'An Anthropic API key — billed per token by Anthropic. Its limits are the API’s, never the subscription’s.'] },
    antigravity: { oauth: 'Google sign-in through Antigravity’s own server.' },
    zai: { api: ['zai', 'LAIN integrates Z.ai through its API.'] },
  };
  /** OAuth or API key? A small dialog of two choices; resolves 'oauth', 'api' or null. */
  function chooseMethod(fid, m) {
    return new Promise(function (resolve) {
      var back = el('div', 'dlg-back');
      var box = el('div', 'dlg methoddlg'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Add ' + (LABEL[fid] || fid));
      box.appendChild(el('h3', '', 'Add ' + (LABEL[fid] || fid)));
      box.appendChild(el('p', 'md-sub', 'How do you want to connect?'));
      var done = function (v) { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      var opt = function (id, icon, title, text) {
        var b = el('button', 'md-opt'); b.setAttribute('data-method', id);
        var ic = el('span', 'md-ic'); ic.appendChild(L.icon(icon, 20)); b.appendChild(ic);
        var t = el('span', 'md-t'); t.appendChild(el('b', '', title)); t.appendChild(el('small', '', text)); b.appendChild(t);
        b.onclick = function () { done(id); };
        box.appendChild(b);
        return b;
      };
      var first = opt('oauth', 'user', 'OAuth / Subscription', m.oauth);
      opt('api', 'key', 'API key', m.api[1]);
      var acts = el('div', 'dlg-actions'); var c = el('button', 'btn', 'Cancel'); c.onclick = function () { done(null); }; acts.appendChild(c); box.appendChild(acts);
      back.appendChild(box);
      var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      back.onclick = function (e) { if (e.target === back) done(null); };
      document.body.appendChild(back);
      setTimeout(function () { first.focus(); }, 0);
    });
  }
  var LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' };
  function backLink(label, to) { var b = el('button', 'dsh-back'); b.appendChild(L.icon('back', 16)); b.appendChild(document.createTextNode(label)); b.onclick = function () { go(to); }; return b; }
  function connectView(pane, focus) {
    pane.appendChild(backLink('Accounts', 'accts'));
    var strip = authStrip(); if (strip) pane.appendChild(strip);
    var sec = U.section({ id: 'connect', title: 'Add account', meta: 'A new account, signed in through the provider’s own flow — in its own private profile, so no account you already have is changed. An API key (OpenAI, Anthropic, Z.ai, DeepSeek…) is not an account: add it under API.' });
    sec.classList.add('first');
    var rows = el('div', 'u-rows');
    CONNECTABLE.forEach(function (c) {
      var row = el('div', 'u-row plain'); row.setAttribute('data-connect', c[0]);
      var idc = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(U.mark(c[0])); nm.appendChild(el('span', '', c[1])); var how = el('span', 'u-st', c[3]); how.style.marginLeft = 'var(--space-2)'; nm.appendChild(how); idc.appendChild(nm); idc.appendChild(el('div', 'u-who', c[2])); row.appendChild(idc);
      var b = U.button('Add account', 'line sm', function () { connect(c[0]); }, 'plus');   // spec §58: one verb, "+ Add account" b.setAttribute('data-connect-go', c[0]);
      row.appendChild(b);
      rows.appendChild(row);
    });
    sec.appendChild(rows);
    pane.appendChild(sec);
  }
  /** "+ Account" / "Add account": every provider is the same action; the provider-specific part is inside the flow. */
  async function connect(fid) {
    if (fid === 'opencode') return L.dialog({ title: 'OpenCode', text: 'OpenCode keeps its own sign-in (opencode auth login) and serves its models inside OpenCode. Sign in there, then Refresh here.', ok: 'OK', cancel: null });
    // WHICH WAY: API-only providers go straight to the key (Z.ai is an API in LAIN — never a ZCode sign-in);
    // providers with both ask; OAuth-only ones go straight to their sign-in.
    var m = METHODS[fid] || { oauth: '' };
    if (m.api && !m.oauth) { go('api'); return L.keys.add(m.api[0]); }
    if (m.api && m.oauth) {
      var how = await chooseMethod(fid, m);
      if (!how) return;
      if (how === 'api') { go('api'); return L.keys.add(m.api[0]); }
    }
    // A NAME for the new account (optional) — the account itself is created by the sign-in, never by this dialog.
    var v = await L.dialog({ title: 'Add ' + (LABEL[fid] || fid) + ' account', text: 'A new account, signed in through ' + (LABEL[fid] || fid) + '’s own flow in your browser. LAIN never sees the password, and the accounts you already have are not changed.', fields: [{ key: 'n', label: 'Name (optional)', value: '', placeholder: 'Personal, Work…' }], ok: 'Continue' });
    if (!v) return;
    return startAuth(fid, { name: v.n || '' });
  }
  async function startAuth(fid, opts) {
    var r = await L.api('/api/intel/auth/start', { family: fid, name: opts.name || '', reuse: opts.reuse || null, device: Boolean(opts.device) });
    if (!r || !r.ok) {
      if (r && r.needs === 'install-acp') return offerInstall(fid, opts);
      L.toast((r && r.why) || 'the sign-in did not start', true);
      return;
    }
    trackAuth(r.session, fid);
  }
  /** ONE SIGN-IN ON SCREEN: polled every 1.5 s (a small read) until it ends — MODEL, the CLI and running work are untouched meanwhile. */
  function trackAuth(session, fid) {
    D.auth = session; D.authFamily = fid;
    clearInterval(D.authTimer);
    redraw();
    D.authTimer = setInterval(async function () {
      var r = await L.api('/api/intel/auth/status', { id: D.auth && D.auth.id }).catch(function () { return null; });
      var s2 = r && r.ok && r.session;
      if (!s2) return;
      var was = D.auth && D.auth.state;
      D.auth = s2;
      if (s2.url && !D.opened[s2.id] && (fid === 'codex' || fid === 'antigravity') && L.openExternal) { D.opened[s2.id] = true; L.openExternal(s2.url); }
      if (!s2.active) {
        clearInterval(D.authTimer);
        if (s2.state === 'CONNECTED') { L.toast((LABEL[fid] || fid) + ' account connected.'); await load(true); L.poll(); D.auth = null; go('accts'); return; }
      }
      if (was !== s2.state || s2.url) redraw();
    }, 1500);
  }
  /**
   * ANTIGRAVITY'S SERVER, NEVER SILENTLY: the size, where it comes from and WHY it is needed are read from Core
   * (drivers/antigravity.js installStatus) and said before anything is downloaded — with what is already installed.
   */
  async function offerInstall(fid, opts) {
    var st = await L.api('/api/intel/antigravity/status', {}).then(function (r) { return r && r.ok ? r.status : null; }, function () { return null; });
    var rel = (st && st.release) || {};
    var mb = rel.bytes ? Math.round(rel.bytes / 1048576) + ' MB' : 'a large download';
    var text = (st && st.need ? st.need + '\n\n' : '') + 'It is ' + mb + ' from ' + (rel.source || 'dl.google.com') + (rel.version ? ' (version ' + rel.version + ')' : '') + ', checked against its published checksum before it is unpacked, and kept in LAIN’s own folder. Nothing else on this PC is changed.'
      + (st && st.installedCli ? '\n\nAlready installed: ' + st.installedCli.note + '.' : '');
    var y = await L.dialog({ title: 'Antigravity needs Google’s ACP server', text: text, ok: 'Download ' + mb, cancel: 'Not now' });
    if (!y) return;
    var r = await L.api('/api/intel/antigravity/install', { confirm: true });
    if (!r || !r.ok) { L.toast((r && r.why) || 'the download did not start', true); return; }
    D.install = { fid: fid, opts: opts };
    watchInstall();
  }
  function watchInstall() {
    clearInterval(D.installTimer);
    redraw();
    D.installTimer = setInterval(async function () {
      var r = await L.api('/api/intel/antigravity/status', {}).catch(function () { return null; });
      var st = r && r.ok && r.status;
      if (!st) return;
      D.install = Object.assign(D.install || {}, { status: st });
      if (st.state === 'installed' || st.state === 'failed') {
        clearInterval(D.installTimer);
        var again = D.install && D.install.state !== 'failed' ? D.install : null;
        if (st.state === 'failed') { L.toast(st.why || 'the download failed', true); D.install = { failed: st.why }; redraw(); return; }
        D.install = null; redraw();
        if (again && again.fid) startAuth(again.fid, again.opts || {});
        return;
      }
      redraw();
    }, 1500);
  }
  /** The contained setup state — a strip in the page, not a modal. "Existing sessions will not be changed." is true and is said. */
  function authStrip() {
    var s2 = D.auth; var inst = D.install;
    if (!s2 && !inst) return null;
    var box = el('div', 'dsh-auth'); box.setAttribute('data-auth', s2 ? s2.state : 'install');
    var label = LABEL[(s2 && s2.family) || (inst && inst.fid)] || 'account';
    if (inst && !s2) {
      var st = inst.status || {};
      box.appendChild(el('div', 'dsh-auth-t', inst.failed ? 'The Antigravity server was not installed' : 'Installing Antigravity’s official server…'));
      box.appendChild(el('div', 'u-note', inst.failed ? inst.failed : (st.total ? Math.round(100 * (st.bytes || 0) / st.total) + '% of ' + Math.round(st.total / 1048576) + ' MB — verified against its checksum before it is used.' : 'Starting the download…')));
      if (inst.failed) { var dis = U.button('Dismiss', 'ghost sm', function () { D.install = null; redraw(); }); box.appendChild(dis); }
      return box;
    }
    var active = s2.active;
    box.appendChild(el('div', 'dsh-auth-t', s2.state === 'FAILED' ? 'The ' + label + ' sign-in did not complete' : s2.state === 'CANCELLED' ? 'Sign-in cancelled' : s2.state === 'VERIFYING' ? 'Checking the ' + label + ' account…' : 'Connecting ' + label + ' account…'));
    var lines = [];
    if (s2.state === 'AWAITING_BROWSER' || s2.state === 'STARTING') lines.push(s2.note || 'Browser sign-in opened.');
    if (s2.userCode) lines.push('Code: ' + s2.userCode);
    if (s2.state === 'FAILED' || s2.state === 'CANCELLED') lines.push(s2.why || '');
    if (active) lines.push('Existing ' + label + ' sessions will not be changed.');
    lines.filter(Boolean).forEach(function (t) { box.appendChild(el('div', 'u-note', t)); });
    var acts = el('div', 'u-acts'); acts.style.marginTop = 'var(--space-3)';
    if (active && s2.url) { var op = U.button('Open sign-in page', 'line sm', function () { if (L.openExternal) L.openExternal(s2.url); }); op.setAttribute('data-auth-open', '1'); acts.appendChild(op); }
    if (active) { var cn = U.button('Cancel', 'ghost sm', async function () { await L.api('/api/intel/auth/cancel', { id: s2.id }); clearInterval(D.authTimer); D.auth = null; await load(true); redraw(); }); cn.setAttribute('data-auth-cancel', '1'); acts.appendChild(cn); }
    else { var ok = U.button(s2.state === 'FAILED' ? 'Try again' : 'Dismiss', s2.state === 'FAILED' ? 'line sm' : 'ghost sm', function () { var fid = s2.family; D.auth = null; if (s2.state === 'FAILED' && s2.needs !== 'install') connect(fid); else redraw(); }); acts.appendChild(ok); }
    box.appendChild(acts);
    return box;
  }
  /** While a Codex sign-in that is not an AuthSession (an existing signed-out account) is in progress. */
  function watchConnect(fid) {
    var f0 = fam(fid); var before = f0 ? f0.accounts.length : 0;
    var until = Date.now() + 180000;
    clearInterval(D.watch);
    D.watch = setInterval(async function () {
      if (Date.now() > until || L.nav.tab() !== 'model') { clearInterval(D.watch); return; }
      await load(true);
      var f = fam(fid);
      if (f && f.accounts.length > before) { clearInterval(D.watch); L.toast(f.label + ' account connected.'); go('accts'); }
    }, 3000);
  }

  // ===================================================================================================================
  // IMPORT — a wizard: find → choose → finish
  // ===================================================================================================================
  /** THE MIGRATION CLASS, said plainly (fabric/migrate.js CLASS). A and B never sign in again; C and D say why they must. */
  var STATUS = {
    migrate: ['Migrates — no sign-in', 'ok'], transfer: ['Migrates — no sign-in', 'ok'], adopt: ['Adopts your profile — no sign-in', 'ok'],
    reauth: ['Needs sign-in', 'warn'], duplicate: ['Already connected', 'acc'], unsupported: ['Unsupported', 'bad'],
  };
  function statusFor(x) {
    if (x.action === 'reauth' && x.reauth && x.reauth.supported === false) return STATUS.unsupported;
    if (x.action === 'duplicate' && x.duplicate && x.duplicate.kind === 'placeholder') return STATUS.reauth;
    return STATUS[x.action] || STATUS.reauth;
  }
  function importView(pane) {
    pane.appendChild(backLink('Accounts', 'accts'));
    var p = D.imp;
    var step = !p ? 1 : p.results ? 3 : 2;
    var steps = el('p', 'dsh-steps'); steps.innerHTML = '';
    [['Find', 1], ['Choose', 2], ['Finish', 3]].forEach(function (s, i) { if (i) steps.appendChild(document.createTextNode('  ›  ')); var t = el(step === s[1] ? 'b' : 'span', '', s[0]); steps.appendChild(t); });
    pane.appendChild(steps);
    if (!p) return importFind(pane);
    if (!p.results) return importChoose(pane, p);
    return importDone(pane, p);
  }
  function importFind(pane) {
    var sec = U.section({ id: 'import', title: 'Import accounts', meta: 'A one-time move from another installation (9Router, OmniRoute, an export file). A sign-in that is complete and portable is migrated into LAIN’s own profile and verified; a native profile is adopted as it is. Only a sign-in that cannot be carried over asks you to sign in again — and says why. LAIN does not depend on the other product afterwards.' });
    sec.classList.add('first');
    var acts = el('div', 'u-acts'); acts.style.marginTop = 'var(--space-4)';
    var d1 = U.button('Find accounts', 'pri', function () { discover(null); }); d1.setAttribute('data-import-find', '1');
    var d2 = U.button('From an export file…', 'line', async function () { var pth = await L.hostCall('pickFile', { title: 'Choose a router export (JSON)' }).catch(function () { return null; }); if (pth && pth.path) discover(pth.path); });
    acts.appendChild(d1); acts.appendChild(d2);
    sec.appendChild(acts);
    pane.appendChild(sec);
  }
  async function discover(file) {
    var r = await L.api('/api/migrate/discover', file ? { exportFile: file } : {});
    if (!r || !r.ok) { L.toast((r && r.why) || 'nothing found', true); return; }
    var picked = {}, decisions = {};
    r.plan.forEach(function (x) { var st = statusFor(x); picked[x.key] = x.action !== 'duplicate' && st !== STATUS.unsupported; if (x.action === 'duplicate') decisions[x.key] = 'keep'; });
    D.imp = { token: r.token, plan: r.plan, picked: picked, decisions: decisions, results: null, why: r.exportError };
    redraw();
  }
  function importChoose(pane, p) {
    var sec = U.section({ id: 'import', title: 'Choose what to bring in', meta: p.plan.length ? p.plan.length + ' account' + (p.plan.length === 1 ? '' : 's') + ' found' : '' });
    sec.classList.add('first');
    if (p.why) sec.appendChild(el('div', 'u-warnline', p.why));
    if (!p.plan.length) { sec.appendChild(U.empty('Nothing found', 'No accounts were found to import.', 'Start over', function () { D.imp = null; redraw(); })); pane.appendChild(sec); return; }
    var rows = el('div', 'u-rows');
    p.plan.forEach(function (x) {
      var st = statusFor(x);
      var row = el('div', 'u-row plain'); row.setAttribute('data-import', x.key); row.setAttribute('data-status', st[0]);
      var idc = el('div', 'u-id');
      var nm = el('div', 'u-nm');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'dsh-check'; cb.checked = Boolean(p.picked[x.key]); cb.disabled = st === STATUS.unsupported || (x.action === 'duplicate' && p.decisions[x.key] === 'keep');
      cb.onchange = function () { p.picked[x.key] = cb.checked; countBtn(); };
      nm.appendChild(cb);
      nm.appendChild(U.mark(x.family));
      var fl = (fam(x.family) || {}).label || cap(x.family);
      nm.appendChild(el('span', '', fl + (x.label ? ' · ' + x.label : '') + (x.identity ? ' · ' + x.identity : '')));
      var s = el('span', 'u-st'); s.appendChild(U.dot(st[1])); s.appendChild(document.createTextNode(st[0])); nm.appendChild(s);
      idc.appendChild(nm);
      var why = el('div', 'u-who', (st === STATUS.reauth || st === STATUS.unsupported ? 'Why: ' : '') + x.text + (x.reauth && x.action === 'reauth' && x.reauth.how ? ' ' + x.reauth.how : '')); why.style.whiteSpace = 'normal';
      idc.appendChild(why);
      row.appendChild(idc);
      if (x.action === 'duplicate') {
        var lab = { keep: 'Keep existing', replace: 'Replace', separate: 'Add separately' };
        var sel = U.select(lab[p.decisions[x.key]], ['keep', 'replace', 'separate'].map(function (k) { return { label: lab[k], checked: p.decisions[x.key] === k, run: function () { p.decisions[x.key] = k; p.picked[x.key] = k !== 'keep'; redraw(); } }; }), { id: 'dup-' + x.key });
        row.appendChild(sel);
      } else row.appendChild(el('span', ''));
      rows.appendChild(row);
    });
    sec.appendChild(rows);
    var acts = el('div', 'u-acts'); acts.style.marginTop = 'var(--space-6)';
    var go1 = U.button('Import', 'pri', apply); go1.setAttribute('data-import-apply', '1');
    function countBtn() { var n = Object.keys(p.picked).filter(function (k) { return p.picked[k]; }).length; go1.textContent = n ? 'Import ' + n + ' account' + (n === 1 ? '' : 's') : 'Import'; go1.disabled = !n; }
    acts.appendChild(go1); acts.appendChild(U.button('Start over', 'ghost', function () { D.imp = null; redraw(); }));
    sec.appendChild(acts); countBtn();
    pane.appendChild(sec);
    async function apply() {
      var keys = Object.keys(p.picked).filter(function (k) { return p.picked[k]; });
      var rr = await L.api('/api/migrate/apply', { token: p.token, keys: keys, decisions: p.decisions });
      if (!rr || !rr.ok) { L.toast((rr && rr.why) || 'not imported', true); return; }
      p.results = rr.results; await load(true); redraw();
    }
  }
  function importDone(pane, p) {
    var sec = U.section({ id: 'import', title: 'Done', meta: 'Migrated and adopted accounts are connected now, and were verified without spending quota. The rest wait under Setup until you sign in.' });
    sec.classList.add('first');
    var rows = el('div', 'u-rows');
    p.results.forEach(function (res) {
      var x = p.plan.filter(function (y) { return y.key === res.key; })[0] || {};
      var row = el('div', 'u-row plain'); row.setAttribute('data-result', res.result);
      var idc = el('div', 'u-id'); var nm = el('div', 'u-nm');
      nm.appendChild(U.mark(x.family)); nm.appendChild(el('span', '', ((fam(x.family) || {}).label || cap(x.family || 'Account')) + (x.label ? ' · ' + x.label : '') + (x.identity ? ' · ' + x.identity : '')));
      idc.appendChild(nm); idc.appendChild(el('div', 'u-who', resultText(res))); row.appendChild(idc);
      if (res.result === 'reauth-required') { var fs = U.button('Sign in', 'pri sm', function () { connect(x.family); }); row.appendChild(fs); } else row.appendChild(el('span', ''));
      rows.appendChild(row);
    });
    sec.appendChild(rows);
    var acts = el('div', 'u-acts'); acts.style.marginTop = 'var(--space-6)';
    acts.appendChild(U.button('Open Accounts', 'pri', function () { D.imp = null; go('accts'); }));
    sec.appendChild(acts);
    pane.appendChild(sec);
  }
  function resultText(r) {
    if (r.result === 'transferred') return 'Connected — ' + (r.label || 'the API') + ' is now a LAIN API source.';
    if (r.result === 'migrated') return 'Migrated — the sign-in now lives in LAIN’s own profile, and the provider confirmed it. No sign-in was needed.';
    if (r.result === 'connected') return 'Adopted — LAIN uses the profile on this PC. No sign-in was needed.';
    if (r.result === 'connected-other') return 'The profile on this PC is a different account — it is connected. This one still needs to sign in.';
    if (r.result === 'reauth-required') return 'Needs sign-in' + (r.reason ? ' — ' + r.reason : '') + '. It waits under Finish setup.';
    if (r.result === 'unsupported') return r.how || 'No supported sign-in yet.';
    if (r.result === 'kept-existing') return 'Kept the account LAIN already has.';
    if (r.result === 'needs-decision') return 'This account appears to already exist — choose Keep existing, Replace or Add separately.';
    return r.why || r.result;
  }

  // ===================================================================================================================
  // MODELS — the logical catalog, by provider
  // ===================================================================================================================
  function models(pane) {
    if (!D.fams) { pane.appendChild(el('div', 'u-empty', 'Reading…')); load(); return; }
    var bar = el('div', 'u-acts'); bar.style.marginBottom = 'var(--space-4)'; bar.style.flexWrap = 'nowrap';
    var sb = el('label', 'u-search'); sb.style.flex = '1'; sb.appendChild(L.icon('search', 16));
    var q = document.createElement('input'); q.placeholder = 'Search models'; q.value = D.q; q.setAttribute('data-dshq', '1'); sb.appendChild(q);
    bar.appendChild(sb);
    var famLabel = D.filt.family ? ((fam(D.filt.family) || {}).label || 'Provider') : 'All providers';
    var items = [{ label: 'All providers', checked: !D.filt.family, run: function () { D.filt.family = ''; redraw(); } }];
    D.fams.forEach(function (f) { if (f.modelCount) items.push({ label: f.label, checked: D.filt.family === f.id, run: function () { D.filt.family = f.id; redraw(); } }); });
    bar.appendChild(U.select(famLabel, items, { id: 'filter-family' }));
    pane.appendChild(bar);
    var chips = el('div', 'u-chips'); chips.style.marginBottom = 'var(--space-4)';
    [['capability', 'chat', 'Chat'], ['capability', 'coding', 'Coding']].forEach(function (c) {
      var b = el('button', 'u-chip', c[2]); b.setAttribute('aria-pressed', String(D.filt.capability === c[1]));
      b.onclick = function () { D.filt.capability = D.filt.capability === c[1] ? '' : c[1]; redraw(); };
      chips.appendChild(b);
    });
    pane.appendChild(chips);
    var out = el('div', 'mbody'); out.setAttribute('data-models', '1'); pane.appendChild(out);
    var timer = null;
    q.oninput = function () { D.q = q.value; clearTimeout(timer); timer = setTimeout(run, 60); };
    function run() {
      var mine = ++D.seq;
      L.api('/api/intel/search', { query: D.q, family: D.filt.family || null, capability: D.filt.capability || null, limit: 300 }).then(function (r) {
        if (mine !== D.seq || !r || !r.ok) return;
        out.textContent = '';
        var groups = {}; var order = [];
        r.models.forEach(function (m) { if (!groups[m.family]) { groups[m.family] = []; order.push(m.family); } groups[m.family].push(m); });
        order.forEach(function (fid) {
          var f = fam(fid) || { label: fid };
          var sec = U.section({ id: 'models-' + fid, title: f.label, mark: fid, meta: groups[fid].length + ' model' + (groups[fid].length === 1 ? '' : 's') });
          var rows = el('div', 'u-rows');
          groups[fid].forEach(function (m) { rows.appendChild(modelRow(fid, f, m)); });
          sec.appendChild(rows); out.appendChild(sec);
        });
        // NO LONGER REPORTED: kept, labelled, never chosen — a session that used one still reads.
        (D.fams || []).forEach(function (f) {
          if (D.filt.family && D.filt.family !== f.id) return;
          var gone = (f.unavailable || []).filter(function (g) { return !D.q || (g.label + ' ' + g.id).toLowerCase().indexOf(D.q.toLowerCase()) >= 0; });
          if (!gone.length) return;
          var gs = U.section({ id: 'gone-' + f.id, title: f.label + ' · no longer reported', mark: f.id, meta: 'Kept for history — not offered' });
          var gr = el('div', 'u-rows');
          gone.forEach(function (g) { var r0 = el('div', 'u-row dsh-gone'); r0.setAttribute('data-gone', f.id + '|' + g.id); var i0 = el('div', 'u-id'); var n0 = el('div', 'u-nm'); n0.appendChild(el('span', '', g.label)); var s0 = el('span', 'u-st', 'Unavailable'); n0.appendChild(s0); i0.appendChild(n0); r0.appendChild(i0); gr.appendChild(r0); });
          gs.appendChild(gr); out.appendChild(gs);
        });
        if (!order.length) { var es = U.section({ id: 'none', title: '' }); es.appendChild(D.q || D.filt.family || D.filt.capability ? U.empty('No model matches', 'Try another word, or clear the filters.') : U.empty('No models yet', 'Add an account or an API key and its models appear here.', 'Add account', function () { go('connect'); })); out.appendChild(es); }
        if (r.total > r.models.length) out.appendChild(el('div', 'u-note', r.models.length + ' of ' + r.total + ' shown — narrow the search.'));
      });
    }
    run();
  }
  function modelRow(fid, f, m) {
    var lanes = D.lanes || {};
    var on = [];
    if (lanes.chat && lanes.chat.family === fid && lanes.chat.model === m.id) on.push('Chat');
    if (lanes.coding && lanes.coding.family === fid && lanes.coding.model === m.id) on.push('Coding');
    var row = el('div', 'u-row click dsh-mrow'); row.setAttribute('data-model', fid + '|' + m.id); row.setAttribute('role', 'button'); row.tabIndex = 0;
    var idc = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(el('span', '', m.label));
    if (m.isNew) { var nb = el('b', 'dsh-new', 'NEW'); nb.title = 'Listed by ' + (f.label || fid) + ' since its last refresh — nothing was selected for you'; nm.appendChild(nb); row.setAttribute('data-new', '1'); }
    if (on.length) { var s = el('span', 'u-st'); s.appendChild(U.dot('acc')); s.appendChild(document.createTextNode('In use · ' + on.join(' · '))); nm.appendChild(s); }
    idc.appendChild(nm); row.appendChild(idc);
    var mid = el('div', 'u-qs');
    var eff = m.effortLabels && m.effortLabels.length ? m.effortLabels.join(' · ') : '';
    mid.appendChild(el('div', 'u-note', [eff, m.coding ? '' : 'Chat only'].filter(Boolean).join('  ·  ') || '—'));
    row.appendChild(mid);
    var items = [];
    if (m.chat) items.push({ label: 'Use for Chat', run: function () { use('chat', fid, m); } });
    if (m.coding) items.push({ label: 'Use for Coding Agent', run: function () { use('coding', fid, m); } });
    row.appendChild(U.overflow(items, 'Use ' + m.label));
    row.onclick = function () { modelSheet(fid, m.id); };
    row.onkeydown = function (e) { if (e.key === 'Enter') modelSheet(fid, m.id); };
    return row;
  }
  async function modelSheet(fid, mid) {
    var r = await L.api('/api/intel/family', { id: fid });
    var m = r && r.ok && r.family.models.filter(function (x) { return x.id === mid; })[0];
    if (!m) { L.toast('That model is no longer here.', true); return; }
    var f = r.family;
    var sh = U.sheet({ title: m.label, meta: f.label, mark: fid, id: 'model-' + mid });
    var g = U.group('Model');
    g.appendChild(U.kv([['Provider', f.label], ['Model id', m.id], ['Effort', m.effortLabels && m.effortLabels.length ? m.effortLabels.join(' · ') : 'Not adjustable'], ['Default effort', m.defaultEffort ? EFF[m.defaultEffort] || m.defaultEffort : null], ['Works for', [m.chat ? 'Chat' : null, m.coding ? 'Coding Agent' : null].filter(Boolean).join(' · ')], ['Served by', f.accounts.length + ' connected account' + (f.accounts.length === 1 ? '' : 's')]]));
    sh.body.appendChild(g);
    var ga = U.group('Use'); var col = el('div', 'u-acts-col');
    if (m.chat) col.appendChild(U.button('Use for Chat', 'line', function () { sh.close(); use('chat', fid, m); }));
    if (m.coding) col.appendChild(U.button('Use for Coding Agent', 'line', function () { sh.close(); use('coding', fid, m); }));
    ga.appendChild(col); sh.body.appendChild(ga);
  }
  async function use(lane, fid, m) {
    var r = await L.api('/api/intel/choose', { lane: lane, family: fid, model: m.id });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not choose that', true); return; }
    L.toast((lane === 'chat' ? 'Chat' : 'Coding Agent') + ' now uses ' + r.lane.familyLabel + ' › ' + r.lane.modelLabel + ' in this session');
    await load(true); L.poll();
  }

  // ===================================================================================================================
  // API — API sources only
  // ===================================================================================================================
  var KNOWN_API = /^(OpenAI|Anthropic|Z\.ai|Zhipu|DeepSeek|OpenRouter|Gemini|Mistral|Groq|xAI|OpenCode)/i;
  async function addApi() { await L.keys.add(null); await load(true); redraw(); }
  function api(pane) {
    if (!D.fams) { pane.appendChild(el('div', 'u-empty', 'Reading…')); load(); return; }
    if (!D.apiInfo) { L.api('/api/instances', {}).then(function (r) { var m = {}; ((r && r.instances) || []).forEach(function (v) { if (v.source_type === 'api') m[v.id] = v; }); D.apiInfo = m; redraw(); }, function () { D.apiInfo = {}; }); }
    var rows = D.fams.filter(function (f) { return f.kind === 'api'; });
    // A NAMED PROVIDER'S API (Core's brand) apart from a custom endpoint.
    var isKnown = function (f) { return f.brand ? f.brand !== 'custom' : KNOWN_API.test(f.label); };
    var known = rows.filter(isKnown);
    var custom = rows.filter(function (f) { return !isKnown(f); });
    var s1 = U.section({ id: 'connected-apis', title: 'API sources', meta: 'OpenAI, Anthropic, Z.ai, DeepSeek and other providers. Each key goes straight to the Windows secret store; only its shape is ever shown. A source appears — and can be chosen — only with a working key.' });
    if (!known.length) s1.appendChild(U.empty('No API sources yet', 'Add an API key to use a provider directly — Z.ai API included.', 'Add API key', addApi));
    else { var r1 = el('div', 'u-rows'); known.forEach(function (f) { r1.appendChild(apiRow(f)); }); s1.appendChild(r1); }
    pane.appendChild(s1);
    var s2 = U.section({ id: 'custom-endpoints', title: 'Custom endpoints', meta: 'Any OpenAI- or Anthropic-compatible address.' });
    if (!custom.length) s2.appendChild(el('div', 'u-note', 'None. Add API key also takes a custom endpoint.'));
    else { var r2 = el('div', 'u-rows'); custom.forEach(function (f) { r2.appendChild(apiRow(f)); }); s2.appendChild(r2); }
    pane.appendChild(s2);
  }
  function apiRow(f) {
    var a = f.accounts[0] || {}; var base = a.id;
    var info = (D.apiInfo && D.apiInfo[base]) || null;
    var cred = info && info.credential && info.credential.masked ? info.credential.masked : null;
    var row = el('div', 'u-row plain'); row.setAttribute('data-api', f.id);
    var idc = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(U.mark('api')); nm.appendChild(el('span', '', f.label)); idc.appendChild(nm);
    row.appendChild(idc);
    var kv = el('div', 'u-qs'); var st = statusOf(a);
    var line = function (k, v) { var q = el('div', 'u-q'); q.style.gridTemplateColumns = '96px minmax(0,1fr)'; q.appendChild(el('span', '', k)); q.appendChild(el('span', '', v)); kv.appendChild(q); };
    line('Status', a.limited ? 'Limited' : a.usable === false ? (a.stateLabel || 'Not ready') : 'Ready'); line('Models', String(f.modelCount)); if (cred) line('Credential', cred);
    if (f.endpoint) line('Endpoint', f.endpoint.replace(/^https?:\/\//, ''));
    // THE SAME BRAND'S SUBSCRIPTION, if connected — named, never merged: separate models, limits and billing.
    var g = groupOf(f);
    var subs = g ? g.subscription.map(fam).filter(function (x) { return x && x.accounts.length; }) : [];
    if (subs.length) line('Also', subs.map(function (x) { return x.label + ' subscription (' + plural(x.accounts.length, 'account', 'accounts') + ') — separate limits'; }).join(' · '));
    row.appendChild(kv);
    row.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1.3fr) 32px';
    row.appendChild(U.overflow([
      { label: 'Test', run: function () { L.keys.test(base); } },
      { label: 'Replace credential', run: async function () { await L.keys.add(null); await load(true); redraw(); } },
      { sep: true },
      { label: 'Remove credential', danger: true, run: function () { confirmThen('Delete the key LAIN keeps for ' + f.label + '? The endpoint stays, waiting for a new key. Your provider account is not touched.', 'Remove credential', async function () { await after(await L.api('/api/sources/action', { kind: 'remove-credential', id: base, confirm: true }), 'Credential removed'); redraw(); }); } },
      { label: 'Remove endpoint', danger: true, run: function () { confirmThen('Remove ' + f.label + ' and its key from LAIN? Your provider account is not touched.', 'Remove', async function () { await after(await L.api('/api/sources/action', { kind: 'remove-source', id: base, confirm: true }), 'Removed'); D.apiInfo = null; redraw(); }); } },
    ], 'More about ' + f.label));
    return row;
  }

  // ===================================================================================================================
  // DEFAULTS — one row per kind of work
  // ===================================================================================================================
  var ROLES = [['chat', 'Chat'], ['assistant', 'Assistant'], ['coding', 'Coding'], ['research', 'Research'], ['vision', 'Vision'], ['auxiliary', 'Auxiliary']];
  var ROLES_DATA = null;
  async function defaults(pane) {
    var sec = U.section({ id: 'defaults', title: 'Kinds of work', meta: 'Click a row to change it. A session can still choose for itself.' });
    pane.appendChild(sec);
    await load();
    var r = await L.api('/api/intel/roles', {});
    if (!r || !r.ok) { sec.appendChild(el('div', 'u-empty', (r && r.why) || 'could not read the defaults')); return; }
    ROLES_DATA = r.roles;
    var rows = el('div', 'u-rows dsh-roles');
    ROLES.forEach(function (role) {
      var cur = r.roles[role[0]] || {};
      var f = cur.family ? fam(cur.family) : null;
      var mdl = null;
      var row = el('div', 'u-row plain click'); row.setAttribute('data-role', role[0]); row.setAttribute('role', 'button'); row.tabIndex = 0;
      row.appendChild(el('div', 'u-nm', role[1]));
      var text = cur.family ? [f ? f.label : cur.family, cur.model ? (cur.modelLabel || cur.model) : null, cur.effort ? EFF[cur.effort] || cur.effort : null].filter(Boolean).join(' · ') : 'Not set';
      var v = el('div', 'v' + (cur.family ? '' : ' none'), text); row.appendChild(v);
      row.appendChild(L.icon('chevron', 16));
      row.onclick = function () { roleSheet(role, cur); };
      row.onkeydown = function (e) { if (e.key === 'Enter') roleSheet(role, cur); };
      rows.appendChild(row);
      if (cur.family && cur.model && f) L.api('/api/intel/family', { id: f.id }).then(function (rr) { mdl = rr && rr.ok && rr.family.models.filter(function (x) { return x.id === cur.model; })[0]; if (mdl) v.textContent = [f.label, mdl.label, cur.effort ? EFF[cur.effort] || cur.effort : null].filter(Boolean).join(' · '); });
    });
    sec.appendChild(rows);
    sec.appendChild(el('p', 'u-note', 'Chat and Coding are what the composer, the IDE, the CLI and Telegram start with; the CLI’s /model default sets the same default.'));
  }
  async function roleSheet(role, cur) {
    var st = { family: cur.family || '', model: cur.model || '', effort: cur.effort || '', execution: cur.execution && cur.execution !== 'NORMAL' ? cur.execution : '', policy: cur.policy || '', pinned: cur.pinned || '' };
    var sh = U.sheet({ title: role[1] + ' default', meta: 'Used when a session has not chosen', id: 'role-' + role[0], onClose: function () { redraw(); } });
    var g = U.group();
    sh.body.appendChild(g);
    var fsel = document.createElement('select'); var msel = document.createElement('select'); var esel = document.createElement('select'); var xsel = document.createElement('select'); var psel = document.createElement('select');
    [fsel, msel, esel, xsel, psel].forEach(function (s) { s.className = 'u-field'; });
    fsel.setAttribute('data-role-field', 'family');
    g.appendChild(U.setting('Provider', null, fsel)); g.appendChild(U.setting('Model', null, msel)); g.appendChild(U.setting('Effort', null, esel)); g.appendChild(U.setting('Execution', null, xsel)); g.appendChild(U.setting('Accounts', 'How the provider’s accounts are used', psel));
    var setC = function (s) { s.parentNode.parentNode.style.display = ''; };
    fsel.appendChild(new Option('Not set', ''));
    (D.fams || []).forEach(function (f) { if (f.modelCount) fsel.appendChild(new Option(f.label, f.id)); });
    fsel.value = st.family;
    [['', 'Normal'], ['FAST', 'Fast'], ['ECO', 'Eco']].forEach(function (x) { xsel.appendChild(new Option(x[1], x[0])); });
    xsel.value = st.execution;
    function fill() {
      var f = fam(st.family);
      msel.textContent = ''; msel.appendChild(new Option('Provider’s default', ''));
      esel.textContent = ''; esel.appendChild(new Option('Default', ''));
      psel.textContent = ''; psel.appendChild(new Option('Provider’s policy', '')); psel.appendChild(new Option('Automatic fallback', 'auto')); psel.appendChild(new Option('Ask before switching', 'ask'));
      msel.disabled = esel.disabled = psel.disabled = xsel.disabled = !f;
      if (!f) return;
      L.api('/api/intel/family', { id: f.id }).then(function (rr) {
        if (!rr || !rr.ok) return;
        rr.family.models.forEach(function (m) { msel.appendChild(new Option(m.label, m.id)); });
        msel.value = st.model;
        var m = rr.family.models.filter(function (x) { return x.id === st.model; })[0];
        (m ? m.efforts : []).forEach(function (e) { esel.appendChild(new Option(EFF[e] || e, e)); });
        esel.value = st.effort; esel.disabled = !(m && m.efforts.length);
        rr.family.accounts.forEach(function (a) { psel.appendChild(new Option('Only ' + a.name, 'pinned:' + a.id)); });
        psel.value = st.policy === 'pinned' ? 'pinned:' + st.pinned : st.policy;
      });
    }
    async function save() {
      if (!st.family) { await L.api('/api/intel/role', { role: role[0], clear: true }); L.toast(role[1] + ' default cleared'); return; }
      var pol = psel.value.indexOf('pinned:') === 0 ? 'pinned' : psel.value;
      var x = await L.api('/api/intel/role', { role: role[0], family: st.family, model: st.model || null, effort: st.effort || null, execution: st.execution || 'NORMAL', policy: pol || null, pinned: pol === 'pinned' ? psel.value.slice(7) : null });
      if (!x || !x.ok) L.toast((x && x.why) || 'not saved', true); else L.toast(role[1] + ' default saved');
    }
    fsel.onchange = function () { st.family = fsel.value; st.model = ''; st.effort = ''; fill(); save(); };
    msel.onchange = function () { st.model = msel.value; st.effort = ''; fill(); save(); };
    esel.onchange = function () { st.effort = esel.value; save(); };
    xsel.onchange = function () { st.execution = xsel.value; save(); };
    psel.onchange = function () { save(); };
    fill();
  }

  // A WINDOW OPENED BY THE TERMINAL (/model manage, /account add, /api add) starts where it was asked to —
  // Core queued a section name, nothing more (fabric/dashlaunch.js).
  L.onBoot(function () {
    setTimeout(function () {
      L.api('/api/desktop/startnav', {}).then(function (r) { if (r && r.ok && r.nav && r.nav.tab) L.nav.go(r.nav.tab, { section: r.nav.section || undefined }); }, function () {});
    }, 300);
  });

  L.dash = { load: load, startAuth: startAuth, actions: actions, accounts: accounts, setup: setupView, discoveredView: discoveredView, connect: connectView, importView: importView, models: models, api: api, defaults: defaults, providerSheet: providerSheet, accountSheet: accountSheet, details: providerSheet, families: function () { return D.fams; }, refresh: refresh, discovered: function () { return D.disc; }, reset: function () { D.fams = null; D.disc = null; D.imp = null; } };
  // A CHOICE MADE ELSEWHERE (the CLI, Telegram, the composer) is on the next draw, not in 8 s.
  L.onRender(function (S) {
    var sig = JSON.stringify(S && S.models ? [S.models.chat && [S.models.chat.family, S.models.chat.account, S.models.chat.modelId], S.models.coding && [S.models.coding.family, S.models.coding.account, S.models.coding.modelId]] : null);
    if (sig !== D.sig) { D.sig = sig; if (D.fams && L.nav.tab() === 'model') load(true); }
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
