'use strict';

/**
 * PROVIDER FIRST, IN THE WINDOW (Phase 8.3) — the provider, model and effort
 * choosers every surface uses: the Chat composer, the IDE's Coding Chat and sidecar,
 * the top-right indicator, the IDE status bar.
 *
 *     ACCOUNT  ─▶  MODEL  ─▶  EFFORT  ─▶  EXECUTION
 *
 * A model name alone never said who pays for a request (`gpt-6-sol` was shown
 * with no account). Every control here names the ACCOUNT first, and the model
 * list is what THAT account offers — never a router's thousand models.
 *
 * ------------------------------------------------------------------------
 * CORE OWNS BOTH. The chosen pair per lane is read from the polled state
 * (S.models.chat / S.models.coding — sessionintel.lane); the account list is
 * POST /api/intel/accounts (accountcatalog.js), kept here for a few seconds
 * only to draw a popover. Choosing is POST /api/intel/choose — passive: it
 * sends nothing to a model. The CLI's /account and /model make the same write.
 */

const CSS = `
.apop{width:min(400px,calc(100vw - 16px));max-height:min(560px,80vh);overflow:auto;padding:6px}
.apop h4{margin:4px 8px 6px}
.apop .agrp{margin:10px 8px 3px;font-size:11.5px;font-weight:600;color:var(--text-muted)}
.apop .arow{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;width:100%;padding:7px 8px;border-radius:var(--radius-sm);text-align:left}
.apop .arow:hover:not(:disabled){background:var(--selection)}
.apop .arow[aria-selected=true]{background:var(--selection)}
.apop .arow .dot{width:7px;height:7px;border-radius:50%;background:var(--positive)}
.apop .arow .dot.warn{background:var(--warning)} .apop .arow .dot.off{background:var(--text-muted)}
.apop .arow b{display:block;font-size:13.5px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apop .arow small{display:block;font-size:11.5px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apop .arow .aq{font-size:11.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.apop .arow:disabled{opacity:.5;cursor:default}
.apop .afoot{display:flex;flex-wrap:wrap;gap:4px;border-top:1px solid var(--separator);margin-top:6px;padding:6px 2px 2px}
.apop .afoot button{padding:5px 9px;border-radius:var(--radius-sm);color:var(--text-secondary);font-size:12.5px}
.apop .afoot button:hover{background:var(--hover);color:var(--text-primary)}
.apop input.asearch{width:100%;margin:0 0 4px;padding:7px 10px;border-radius:var(--radius-sm);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator);font-size:13px}
.apop .anote{margin:6px 8px 6px;font-size:11.5px;color:var(--text-muted);line-height:1.5}
.apop .mrowx{display:flex;align-items:baseline;justify-content:space-between;gap:12px;width:100%;padding:6px 8px;border-radius:var(--radius-sm);text-align:left;font-size:13px;color:var(--text-primary)}
.apop .mrowx:hover:not(:disabled),.apop .mrowx[aria-selected=true]{background:var(--selection)}
.apop .mrowx small{color:var(--text-muted);font-size:11.5px;white-space:nowrap}
.apop .mrowx:disabled{opacity:.45;cursor:default}
.apop .empty{padding:12px 8px;color:var(--text-muted);font-size:12.5px}
/* THE ROUTE IDENTITY — the IDE status bar and other one-line places. */
.acctid{display:inline-flex;align-items:center;min-width:0;text-align:left}
.acctid .an{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acctid .an .car{color:var(--text-muted);font-size:10px}
.acctid.need .an{color:var(--warning)}
/* AN ACCOUNT QUESTION WAITING ON THE LANE (fabric/fallback.js) — above the composer, never modal. */
.intel-decision{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 12px;border-radius:var(--radius-md);background:var(--warning-weak)}
.intel-decision[hidden]{display:none}
.intel-decision .dt{flex:1;min-width:200px;font-size:13px;color:var(--text-primary);white-space:pre-line}
.intel-decision .da{display:flex;gap:6px;flex-wrap:wrap}
/* THE ROUTE ROW — Provider · Model · Effort, one line, each part a chooser. */
.rtrow{display:flex;flex-wrap:wrap;align-items:center;gap:0 1px;min-width:0}
.rtrow .rp{font-size:12.5px;color:var(--text-secondary);padding:4px 6px;border-radius:var(--radius-sm);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.rtrow .rp:hover{background:var(--hover);color:var(--text-primary)}
.rtrow .rp-prov{color:var(--text-primary);font-weight:600}
.rtrow .rp-need{color:var(--warning);font-weight:600}
.rtrow .rp-need .car{font-weight:400;font-size:10px}
.rtrow .rs{color:var(--text-muted);font-size:12px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;

  // ---- the provider families (a short-lived copy, for drawing popovers) ----------
  var A = { fams: null, at: 0, loading: null };
  function load(force) {
    if (!force && A.fams && Date.now() - A.at < 15000) return Promise.resolve(A.fams);
    if (A.loading) return A.loading;
    A.loading = L.api('/api/intel/families', {}).then(function (r) {
      A.loading = null;
      if (r && r.ok) { A.fams = r.families; A.at = Date.now(); }
      return A.fams;
    }, function () { A.loading = null; return A.fams; });
    return A.loading;
  }
  function findFamily(id) { return (A.fams || []).filter(function (f) { return f.id === id; })[0] || null; }
  /** Compatibility: an ACCOUNT by id, from the families' backing accounts. */
  function find(id) {
    var out = null;
    (A.fams || []).forEach(function (f) { f.accounts.forEach(function (a) { if (a.id === id) out = a; }); });
    return out;
  }

  // ---- which lane a surface is about ----------------------------------------------
  function laneNow() {
    var tab = L.nav && L.nav.tab ? L.nav.tab() : '';
    // THE IDE: the sidecar's tab in front — its Chat tab is Chat's lane, everything else the Coding Agent's.
    if (tab === 'ide') return L.botpane && L.botpane.tab && L.botpane.tab() === 'chat' && L.ui && L.ui().mode === 'chat' ? 'chat' : 'coding';
    if (tab === 'chat' && L.chat && L.chat.lane) return L.chat.lane() === 'agent' ? 'coding' : 'chat';
    var S = L.state();
    return S && S.views && S.views.active === 'chat' ? 'chat' : 'coding';
  }
  function sel(lane) { var S = L.state(); var m = (S && S.models) || {}; return (lane === 'chat' ? m.chat : m.coding) || {}; }
  /** THE PROVIDER FAMILY — "Codex", "Claude Pro" — never a backing account's number. */
  function providerText(s) { return s.familyLabel || (s.family ? s.family : 'Select model'); }
  function accountText(s) { return providerText(s); }
  /** THE MODEL IN USE — empty until a provider is chosen: a stale model is never shown under "Select provider". */
  function modelText(s) {
    if (!s.family) return '';
    if (s.modelLabel) return s.modelLabel;
    if (s.modelId) return L.fmt.model(s.modelId);
    return 'Select model';
  }
  function effortText(s) { if (s.effortSource === 'lain' && s.effectiveLabel) return 'LAIN effort · ' + s.effectiveLabel + (s.effortDefaultWhy ? ' · ' + s.effortDefaultWhy : ''); return s.effortLabel || (s.efforts && s.efforts.length ? 'Default' : ''); }
  function needs(s) { return !s.ok && (s.needs === 'family' || s.needs === 'account' || s.needs === 'model' || s.needs === 'decision' || !s.family); }
  function quotaOf(a) {
    if (!a || !a.quota || !a.quota.length) return '';
    var w = a.quota[0];
    var rem = w.remainingPercent != null ? w.remainingPercent : (w.usedPercent != null ? 100 - w.usedPercent : null);
    return rem == null ? '' : (w.label + ' ' + Math.round(rem) + '% remaining');
  }

  /** The compact identity: the canonical route on one line, or "Select model" — never half a route. */
  function identity(box, lane, opts) {
    var s = sel(lane);
    var o = opts || {};
    var d = s.display || { resolved: false, text: 'Select model' };
    var sig = JSON.stringify([d, s.backing && s.backing.name]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    box.classList.add('acctid');
    box.classList.toggle('need', !d.resolved);
    var an = el('span', 'an', d.resolved ? d.text : 'Select model');
    if (o.caret !== false) an.appendChild(el('span', 'car', '▾'));
    box.appendChild(an);
    box.title = (lane === 'chat' ? 'Chat' : 'Coding Agent') + ': ' + (d.resolved ? d.text : 'Select model' + (d.problem ? ' — ' + d.problem : ''))
      + (d.resolved && s.policyLabel ? '\n' + s.policyLabel + (s.backing ? ' — now on ' + s.backing.name : '') : '');
  }

  // ---- choosing ------------------------------------------------------------------
  async function choose(lane, body, anchor) {
    var r = await L.api('/api/intel/choose', Object.assign({ lane: lane }, body));
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not choose that', true); return r; }
    if (r.lane && r.lane.effortReset) L.toast('That model does not take the effort you had — it uses its default.');
    await L.poll();
    if (L.composer && L.composer.cells) L.composer.cells();
    if (r.needsModel && anchor && anchor.isConnected) pickModel(anchor, lane);
    return r;
  }

  function familyRow(f, current, onPick) {
    var b = el('button', 'arow');
    b.setAttribute('aria-selected', String(f.id === current));
    b.setAttribute('data-family', f.id);
    var limited = f.accounts.length && f.accounts.every(function (a) { return a.limited || !a.usable; });
    b.appendChild(el('span', 'dot' + (!f.usable ? ' off' : limited ? ' warn' : '')));
    var t = el('span', '');
    t.appendChild(el('b', '', f.label));
    var n = f.accounts.length;
    t.appendChild(el('small', '', [f.kind === 'api' ? 'API' : f.kind === 'local' ? 'Local' : f.kind === 'runtime' ? 'Runtime' : 'OAuth', n > 1 ? n + ' accounts · ' + f.policyLabel : '', !f.usable ? 'no signed-in account' : ''].filter(Boolean).join(' · ')));
    b.appendChild(t);
    b.appendChild(el('span', 'aq', f.modelCount + ' model' + (f.modelCount === 1 ? '' : 's')));
    if (!f.usable) b.disabled = true;
    else b.onclick = function () { onPick(f); };
    return b;
  }

  /**
   * THE PROVIDER CHOOSER for a lane — each provider family once (Codex, Claude Pro,
   * OpenCode, Local, each API source). Backing accounts are NOT rows here: they
   * are behind "Account details". Choosing one keeps the model when it offers it.
   */
  async function pickProvider(anchor, lane, opts) {
    var o = opts || {};
    var s = sel(lane);
    L.popover(anchor, function (p) { p.appendChild(el('h4', '', 'Provider · loading…')); }, { cls: 'apop', prefer: o.prefer || 'above', alignRight: o.alignRight });
    await load(o.force);
    if (!anchor.isConnected) return;
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', (lane === 'chat' ? 'Chat' : 'Coding Agent') + ' · provider'));
      var pick = function (f) { L.closePop(); if (o.onPick) o.onPick(f); else choose(lane, { family: f.id }, anchor); };
      var groups = [['oauth', 'Accounts'], ['runtime', 'Runtimes'], ['local', 'Local'], ['api', 'API']];
      groups.forEach(function (g) {
        var rows = (A.fams || []).filter(function (f) { return f.kind === g[0] && (f.accounts.length || f.id === s.family); });
        if (!rows.length) return;
        p.appendChild(el('div', 'agrp', g[1]));
        rows.forEach(function (f) { p.appendChild(familyRow(f, s.family, pick)); });
      });
      if (!(A.fams || []).length) p.appendChild(el('div', 'empty', 'Nothing connected yet. Connect an account or add an API in Model.'));
      var foot = el('div', 'afoot');
      if (s.family) { var d = el('button', '', 'Account details'); d.onclick = function () { L.closePop(); if (L.dash) { L.nav.go('model', { section: 'accts' }); setTimeout(function () { L.dash.details(s.family); }, 50); } }; foot.appendChild(d); }
      var manage = el('button', '', 'Manage accounts…'); manage.onclick = function () { L.closePop(); L.nav.go('model', { section: 'accts' }); }; foot.appendChild(manage);
      if (s.family) { var mm = el('button', '', 'Choose model…'); mm.onclick = function () { L.closePop(); pickModel(anchor, lane); }; foot.appendChild(mm); }
      if (o.usage) { var u = el('button', '', 'Usage details'); u.onclick = function () { L.closePop(); o.usage(); }; foot.appendChild(u); }
      p.appendChild(foot);
    }, { cls: 'apop', prefer: o.prefer || 'above', alignRight: o.alignRight });
  }

  /** THE MODEL CHOOSER: the lane's PROVIDER's models, from Core's index — searchable, instant. */
  async function pickModel(anchor, lane, opts) {
    var o = opts || {};
    var s = sel(lane);
    if (!s.family) { pickProvider(anchor, lane, o); return; }
    await load();
    var f = findFamily(s.family) || { id: s.family, label: s.familyLabel || s.family };
    var q = function (text) { return L.api('/api/intel/search', { family: s.family, lane: lane, query: text || '', limit: 300 }); };
    var r = await q('');
    if (!anchor.isConnected) return;
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not read the models', true); return; }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', f.label + ' · ' + r.total + ' model' + (r.total === 1 ? '' : 's')));
      var input = el('input', 'asearch'); input.placeholder = 'Search ' + f.label + '’s models…'; input.spellcheck = false;
      p.appendChild(input);
      var list = el('div', ''); p.appendChild(list);
      var draw = function (rows, text) {
        list.textContent = '';
        rows.forEach(function (m) {
          var b = el('button', 'mrowx');
          b.setAttribute('aria-selected', String(m.id === s.modelId));
          b.setAttribute('data-model', m.id);
          b.appendChild(el('span', '', m.label));
          b.appendChild(el('small', '', m.effortLabels && m.effortLabels.length ? m.effortLabels.join(' / ') : ''));
          // THE EFFORT STEP, RIGHT AFTER THE MODEL (S12a): native levels or LAIN effort — the same popover as the effort control.
          b.onclick = async function () { L.closePop(); var cr = await choose(lane, { family: s.family, model: m.id }); if (cr && cr.ok && !cr.deferred && cr.lane && (cr.lane.efforts || []).length > 1 && anchor.isConnected) pickEffort(anchor, lane, o); };
          list.appendChild(b);
        });
        if (!rows.length) list.appendChild(el('div', 'empty', text ? 'No model matches “' + text + '” on ' + f.label + '.' : f.label + ' offers no models for this lane.'));
      };
      draw(r.models, '');
      var seq = 0;
      input.addEventListener('input', function () { var t = input.value; var mine = ++seq; q(t).then(function (rr) { if (mine === seq && rr && rr.ok) draw(rr.models, t); }); });
      var foot = el('div', 'afoot');
      var sw = el('button', '', 'Switch provider…'); sw.onclick = function () { L.closePop(); pickProvider(anchor, lane, o); }; foot.appendChild(sw);
      p.appendChild(foot);
      setTimeout(function () { input.focus(); }, 0);
    }, { cls: 'apop', prefer: o.prefer || 'above', alignRight: o.alignRight });
  }

  /** THE EFFORT CHOOSER: exactly the levels the lane's model declares — hidden when it has none. */
  function pickEffort(anchor, lane, opts) {
    var o = opts || {};
    var s = sel(lane);
    var levels = s.efforts || [];
    var labels = s.effortLabels || [];
    L.popover(anchor, function (p) {
      // ONE CONTROL, TWO HONEST MEANINGS (2026-10-02): native levels go to the provider; a model without them gets
      // LAIN's execution depth, which is never presented as hidden reasoning.
      var lainEffort = s.effortSource === 'lain';
      p.appendChild(el('h4', '', (lainEffort ? 'LAIN effort · ' : 'Effort · ') + modelText(s)));
      if (!levels.length) p.appendChild(el('div', 'empty', modelText(s) + ' has no configurable effort.'));
      levels.forEach(function (e, i) {
        var b = el('button', 'mrowx');
        b.setAttribute('aria-selected', String(e === (lainEffort ? s.effective : s.effort)));
        b.setAttribute('data-effort', e);
        b.appendChild(el('span', '', labels[i] || e));
        b.appendChild(el('small', '', lainEffort ? (e === s.effective && !s.effortExplicit ? (s.effortDefaultWhy || 'default') : '') : (e === s.defaultEffort ? 'default' : '')));
        b.onclick = async function () {
          L.closePop();
          var r = await L.api('/api/intel/effort', { lane: lane, effort: e });
          if (!r || !r.ok) { L.toast((r && r.why) || 'not set', true); return; }
          await L.poll(); if (L.composer && L.composer.cells) L.composer.cells();
        };
        p.appendChild(b);
      });
      p.appendChild(el('div', 'anote', lainEffort
        ? 'No native effort on this model: LAIN sets how much it explores, reads at once and keeps in context. Fast and Eco default to Low; your choice wins.'
        : 'How much the model reasons — sent to the provider as it declares it. Default follows execution: Fast and Eco use the lowest level, Normal the model\'s default.'));
    }, { cls: 'apop', prefer: o.prefer || 'above', alignRight: o.alignRight });
  }

  /** THE MODELS OF ANY PROVIDER (Defaults): pick one and `onPick(model)` decides what it means. */
  async function pickModelOf(anchor, familyId, lane, onPick, opts) {
    var o = opts || {};
    var r = await L.api('/api/intel/search', { family: familyId, lane: lane, query: '', limit: 300 });
    if (!anchor.isConnected) return;
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not read the models', true); return; }
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', r.total + ' model' + (r.total === 1 ? '' : 's')));
      r.models.forEach(function (m) {
        var b = el('button', 'mrowx'); b.setAttribute('aria-selected', String(m.id === o.current));
        b.appendChild(el('span', '', m.label));
        b.onclick = function () { L.closePop(); onPick(m); };
        p.appendChild(b);
      });
    }, { cls: 'apop', prefer: o.prefer || 'below', alignRight: o.alignRight });
  }

  /**
   * AN ACCOUNT QUESTION WAITING ON THE LANE (fabric/fallback.js): Ask before switching,
   * a pinned account at its limit, or no compatible account. Drawn where the lane is;
   * nothing is sent through another account until the person answers.
   */
  function decision(holder, lane) {
    var s = sel(lane);
    var p = s.pending;
    var sig = JSON.stringify(p ? [p.at, p.kind] : null);
    if (holder.dataset.sig === sig) return;
    holder.dataset.sig = sig;
    holder.textContent = '';
    holder.hidden = !p;
    if (!p) return;
    holder.className = 'intel-decision';
    holder.appendChild(el('div', 'dt', p.text || (p.familyLabel + ' is rate limited on this account.')));
    var acts = el('div', 'da');
    var answer = async function (choice, account) {
      var r = await L.api('/api/intel/decide', { choice: choice, account: account || null });
      if (!r || !r.ok) { L.toast((r && r.why) || 'not done', true); return; }
      if (r.switched) L.toast(p.familyLabel + ' switched to ' + r.to.name);
      if (r.openPicker && holder.isConnected) pickModel(holder, lane);
      L.poll();
    };
    if (p.kind === 'ask' && p.to) { var sb = el('button', 'btn small primary', 'Switch'); sb.title = 'Switch to ' + p.to.name; sb.onclick = function () { answer('switch', p.to.id); }; acts.appendChild(sb); }
    if (p.kind === 'pinned') {
      (p.candidates || []).slice(0, 4).forEach(function (c, i) { var b = el('button', 'btn small' + (i ? '' : ' primary'), 'Switch account — ' + c.name); b.onclick = function () { answer('switch-account', c.id); }; acts.appendChild(b); });
    }
    var w = el('button', 'btn small', 'Wait'); w.onclick = function () { answer('wait'); }; acts.appendChild(w);
    if (p.kind !== 'ask') { var cm = el('button', 'btn small', 'Choose another model'); cm.onclick = function () { answer('choose-model'); }; acts.appendChild(cm); }
    holder.appendChild(acts);
  }

  /**
   * THE ROUTE, on one line — Core's CANONICAL route (sessionintel `display`): Provider · Model · Effort, each part
   * its own chooser, only when the whole route RESOLVES. Anything less is one "Select model" (never half a route:
   * no model under "Select provider", no keyless API shown as active); its title says what is missing.
   */
  function route(box, lane, opts) {
    var s = sel(lane);
    var o = opts || {};
    var d = s.display || { resolved: false, text: 'Select model' };
    var sig = JSON.stringify([lane, d, s.efforts, s.family, s.policyLabel, s.backing && s.backing.name]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    box.classList.add('rtrow');
    box.setAttribute('data-route', d.resolved ? 'set' : 'none');
    var part = function (text, cls, title, fn) { var b = el('button', 'rp ' + cls, text); if (title) b.title = title; b.onclick = function () { fn(b); }; return b; };
    if (!d.resolved) {
      var need = part('Select model', 'rp-need', d.problem || 'Choose a provider and a model for ' + (lane === 'chat' ? 'Chat' : 'the Coding Agent'), function (b) { if (s.family) pickModel(b, lane, o); else pickProvider(b, lane, o); });
      need.setAttribute('data-part', 'select');
      need.appendChild(el('span', 'car', ' ▾'));
      box.appendChild(need);
      return;
    }
    var pv = part(d.sourceLabel, 'rp-prov', (s.policyLabel ? s.policyLabel + (s.backing ? ' — now on ' + s.backing.name : '') : 'Provider'), function (b) { pickProvider(b, lane, o); });
    pv.setAttribute('data-part', 'provider');
    box.appendChild(pv);
    box.appendChild(el('span', 'rs', '·'));
    var mp = part(d.modelLabel, 'rp-model', 'Model — ' + d.modelLabel, function (b) { pickModel(b, lane, o); });
    mp.setAttribute('data-part', 'model');
    box.appendChild(mp);
    if (s.efforts && s.efforts.length) {
      box.appendChild(el('span', 'rs', '·'));
      var ep = part(effortText(s) || 'Default', 'rp-eff', s.effortSource === 'lain' ? 'LAIN effort — how much LAIN explores for this model' : 'Effort — how much the model reasons', function (b) { pickEffort(b, lane, o); });
      ep.setAttribute('data-part', 'effort');
      box.appendChild(ep);
    }
  }

  /**
   * THE COMPOSER'S ROUTE (2026-09-30): the MODEL as readable text, the PROVIDER and the EFFORT as icons — each a
   * chooser with a tooltip and a small popover. The same canonical route as route(): when it does not resolve,
   * one "Select model" pill and nothing else.
   */
  function routeCompact(box, lane, opts) {
    var s = sel(lane);
    var o = opts || {};
    var d = s.display || { resolved: false, text: 'Select model' };
    var sig = JSON.stringify([lane, d, s.efforts, s.effort, s.effective, s.effortDefaultWhy, s.family, s.policyLabel, s.backing && s.backing.name]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    box.classList.add('rtc');
    box.setAttribute('data-route', d.resolved ? 'set' : 'none');
    var cell = function (cls, id, label, tip, fn) {
      var b = el('button', 'cell ' + cls);
      b.setAttribute('data-cell', id);
      b.setAttribute('data-tip', tip);
      b.setAttribute('aria-label', label + ' — ' + tip);
      b.appendChild(el('span', 'cl', label));
      b.onclick = function (e) { e.stopPropagation(); fn(b); };
      return b;
    };
    var laneName = lane === 'chat' ? 'Chat' : 'the Coding Agent';
    if (!d.resolved) {
      var need = cell('model need', 'model', 'Model', d.problem || 'Choose a provider and a model for ' + laneName, function (b) { if (s.family) pickModel(b, lane, o); else pickProvider(b, lane, o); });
      need.setAttribute('data-route-pill', '1');
      need.appendChild(el('span', 'mt', 'Select model'));
      need.appendChild(L.icon('down', 12));
      box.appendChild(need);
      return;
    }
    var pv = cell('prov', 'provider', 'Provider', d.sourceLabel + (s.backing ? ' · ' + s.backing.name : '') + (s.policyLabel ? ' · ' + s.policyLabel : ''), function (b) { pickProvider(b, lane, o); });
    pv.appendChild(L.kit.mark(s.family, 16));
    box.appendChild(pv);
    var mp = cell('model', 'model', 'Model', d.modelLabel + ' — change the model', function (b) { pickModel(b, lane, o); });
    mp.setAttribute('data-route-pill', '1');
    mp.appendChild(el('span', 'mt', d.modelLabel));
    mp.appendChild(L.icon('down', 12));
    box.appendChild(mp);
    var levels = s.efforts || [];
    if (levels.length) {
      var ep = cell('eff', 'effort', 'Effort', (s.effortSource === 'lain' ? effortText(s) + ' — how much LAIN explores for this model' : 'Effort · ' + (d.effortLabel || 'Default') + ' — how much the model reasons'), function (b) { pickEffort(b, lane, o); });
      ep.appendChild(L.icon('brain', 16));
      // A SMALL LEVEL METER: where the chosen effort sits among the ones this model declares (lowest → highest).
      var at = levels.indexOf(s.effortSource === 'lain' ? s.effective : s.effort);
      var on = at < 0 ? 2 : Math.max(1, Math.round(((at + 1) / levels.length) * 3));
      var lv = el('span', 'lvl'); for (var i = 1; i <= 3; i++) lv.appendChild(el('i', i <= on ? 'on' : ''));
      ep.appendChild(lv);
      ep.setAttribute('data-effort', s.effort || 'default');
      box.appendChild(ep);
    }
  }

  L.intel = { route: route, routeCompact: routeCompact, load: load, find: find, findFamily: findFamily, laneNow: laneNow, sel: sel, accountText: accountText, providerText: providerText, modelText: modelText, effortText: effortText, needs: needs, quotaOf: quotaOf, identity: identity,
    pickAccount: pickProvider, pickProvider: pickProvider, pickModel: pickModel, pickEffort: pickEffort, pickModelOf: pickModelOf, choose: choose, decision: decision, families: function () { return A.fams; } };

  // A CONNECTED OR REMOVED ACCOUNT is on the next popover, not in 15 s.
  L.onRender(function (S) {
    var sig = JSON.stringify(S && S.models ? [S.models.chat && [S.models.chat.family, S.models.chat.account], S.models.coding && [S.models.coding.family, S.models.coding.account]] : null);
    if (sig !== A.lastSig) { A.lastSig = sig; A.at = 0; }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
