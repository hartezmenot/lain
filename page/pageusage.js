'use strict';

/**
 * THE USAGE VIEW — what was consumed, and how much of each provider window is
 * used. Two questions, two kinds of number, never one.
 *
 *   Overview   the range at a glance: requests, input, output, reasoning, cache
 *              read/write, latency, cost, tool calls — and where it went
 *              (API · Local · Runtime · Website), local speed, and what a
 *              website session was OBSERVED to use (estimated by LAIN)
 *   Tokens     grouped by Project · Session · Task · Model · Provider · Account
 *              · Role · Source · Time — input, output, reasoning, cache read,
 *              cache write, hits and misses, never one ambiguous cache number
 *   Cost       the provider's own figure; a runtime's own computed figure (kept
 *              apart — e.g. Claude Code's API-equivalent on a subscription);
 *              "Estimated" only from prices the person configured
 *   Context efficiency   provider caching and LAIN's own reuse, apart; and the
 *              answer to "why did this use so many tokens?" — fixed prompt, tool
 *              schema, conversation, FocusPacket
 *   Limits     grouped by what sources actually report: active windows,
 *              credits & plans, nothing reported (collapsed), local (no quota)
 *
 * FILTERS: every dimension, combinable, from the values actually present.
 * READS: POST /api/usage and POST /api/usage/limits. Nothing here polls a provider.
 */

const HTML = `
<section class="view usagev split" id="vUsage" data-view="usage" hidden>
  <nav class="snav-col" id="usageNav"></nav>
  <div class="spane" id="usagePane"></div>
</section>`;

const CSS = `
.utop{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.utop .spacer{flex:1}
.utop select{min-width:0}
.ufilters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.ufilters .fchip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:2px 4px 2px 9px;border-radius:12px;border:1px solid var(--accent);color:var(--ink);background:var(--raise)}
.ufilters .fchip button{border:0;background:transparent;color:var(--faint);cursor:pointer;font-size:13px;padding:0 4px}
.ufilters select{font-size:12px}
.ucards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;max-width:1200px;margin-bottom:16px}
@media (max-width:1100px){.ucards{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:820px){.ucards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ucard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-width:0}
.ucard .k{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600}
.ucard .v{font-size:20px;font-weight:600;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.ucard .n{font-size:11.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis}
.usec{max-width:1200px;margin:6px 0 18px}
.usec h4{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 8px;font-weight:600}
.srcbar{display:grid;grid-template-columns:200px minmax(0,1fr) 150px;gap:10px;align-items:center;font-size:12.5px;padding:4px 0}
.srcbar .track{height:8px;border-radius:4px;background:var(--surface);overflow:hidden}
.srcbar .track span{display:block;height:100%;background:var(--accent)}
.srcbar .num{color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.stack{display:flex;height:14px;border-radius:4px;overflow:hidden;max-width:760px;margin:6px 0}
.stack span{display:block;height:100%}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-bottom:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.uempty{border:1px dashed var(--line2);border-radius:8px;padding:16px 18px;max-width:1200px;margin-bottom:16px}
.uempty b{display:block;font-size:14px;margin-bottom:4px}
.uempty .missing{margin-top:4px}
.uempty ul{margin:8px 0 0;padding-left:18px;font-size:12.5px;color:var(--dim)}
.utw{overflow-x:auto;max-width:1200px}
.utbl{width:100%;min-width:760px;border-collapse:collapse;font-size:12.5px}
.utbl th{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}
.utbl th:first-child,.utbl td:first-child{text-align:left}
.utbl td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.utbl td:first-child{max-width:340px;overflow:hidden;text-overflow:ellipsis}
.utbl tr.click{cursor:pointer}
.utbl tr.click:hover td{background:var(--surface)}
.lgrp{margin-bottom:18px;max-width:1200px}
.lgrp > h4{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 8px;font-weight:600}
.lcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.lcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-width:0}
.lcard h4{margin:0;font-size:13px;display:flex;align-items:center;gap:8px}
.lcard .who{font-size:11.5px;color:var(--faint);margin:2px 0 8px}
.lcard .big{font-size:18px;font-weight:600;margin:4px 0}
.lwin{display:grid;grid-template-columns:78px 1fr 40px;gap:8px;align-items:center;font-size:12px;padding:3px 0}
.lwin .q-bar{width:auto}
.lwin .rs{grid-column:1 / -1;font-size:11px;color:var(--faint);margin-top:-2px}
.lwin .rs.exp{color:var(--warn)}
.effrow{display:grid;grid-template-columns:240px 1fr;gap:10px;font-size:12.5px;padding:6px 0;border-top:1px solid var(--line);max-width:860px}
.effrow span:first-child{color:var(--faint)}
.uhint{font-size:12px;color:var(--faint);max-width:860px;margin:10px 0}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var section = 'overview', range = '7d', by = 'model', limitView = 'grouped';
  var filters = {};
  var data = null, lim = null, loading = false, ticker = null;
  var DIM_LABEL = { project: 'Project', session: 'Session', task: 'Task', model: 'Model', provider: 'Provider', account: 'Account', role: 'Role', via: 'Source', origin: 'Origin', day: 'Time (day)', source: 'Receipt source' };
  var FILTER_DIMS = ['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'via', 'origin'];

  function fmt(x) { return x == null ? '—' : Number(x).toLocaleString(); }
  function money(x) { return '$' + (Math.round(x * 100) / 100).toFixed(2); }
  function countdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
  }
  function qbar(pct) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    fill.style.width = (pct == null ? 0 : Math.max(2, Math.min(100, pct))) + '%';
    fill.className = 'q-fill' + (pct == null ? '' : pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : '');
    return wrap;
  }
  function short(k, dim) { if (dim === 'session' || dim === 'task') return String(k).slice(0, 18); return k; }

  async function load() {
    loading = true; draw();
    var a = await L.api('/api/usage', { range: range, by: by, filters: filters });
    var b = await L.api('/api/usage/limits', {});
    loading = false;
    if (a && a.ok) data = a;
    if (b && b.ok) lim = b;
    draw();
  }

  function nav() {
    var box = $('usageNav'); box.textContent = '';
    var item = function (id, label, icon) {
      var b = el('button', 'snav'); b.appendChild(L.icon(icon, 15)); b.appendChild(el('span', '', label));
      b.setAttribute('aria-selected', String(section === id));
      b.setAttribute('data-usage', id);
      b.onclick = function () { section = id; draw(); };
      box.appendChild(b);
    };
    box.appendChild(el('h5', '', 'Consumption'));
    item('overview', 'Overview', 'usage');
    item('tokens', 'Tokens', 'files');
    item('cost', 'Cost', 'spark');
    item('efficiency', 'Context efficiency', 'refresh');
    box.appendChild(el('h5', '', 'Provider limits'));
    item('limits', 'Limits', 'shield');
  }

  function top(pane, title, sub, withGroup) {
    var t = el('div', 'utop');
    var h = el('div', ''); h.appendChild(el('h2', '', title)); if (sub) { var s = el('div', 'sub', sub); s.style.margin = '0'; h.appendChild(s); } t.appendChild(h);
    t.appendChild(el('span', 'spacer'));
    if (section !== 'limits') {
      var r = document.createElement('select'); r.setAttribute('data-range', '1');
      [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (o[0] === range) op.selected = true; r.appendChild(op); });
      r.onchange = function () { range = r.value; load(); };
      t.appendChild(r);
    }
    if (withGroup) {
      var g = document.createElement('select');
      g.setAttribute('data-by', '1');
      ['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'via', 'origin', 'day'].forEach(function (k) { var op = document.createElement('option'); op.value = k; op.textContent = 'By ' + DIM_LABEL[k]; if (k === by) op.selected = true; g.appendChild(op); });
      g.onchange = function () { by = g.value; load(); };
      t.appendChild(g);
    }
    var rf = el('button', 'btn small', loading ? 'Reading…' : 'Refresh'); rf.disabled = loading; rf.onclick = load; t.appendChild(rf);
    pane.appendChild(t);
    if (section !== 'limits') filterBar(pane);
  }

  // ---- filters: every dimension, from the values present in range -----------
  function filterBar(pane) {
    var box = el('div', 'ufilters'); box.setAttribute('data-filters', '1');
    Object.keys(filters).forEach(function (k) {
      var c = el('span', 'fchip'); c.appendChild(document.createTextNode(DIM_LABEL[k] + ': ' + short(filters[k], k)));
      var x = el('button', '', '×'); x.title = 'Remove this filter'; x.onclick = function () { delete filters[k]; load(); }; c.appendChild(x); box.appendChild(c);
    });
    var facets = (data && data.facets) || {};
    var dimSel = document.createElement('select'); dimSel.setAttribute('data-filterdim', '1');
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '+ Filter…'; dimSel.appendChild(o0);
    FILTER_DIMS.forEach(function (k) { if (filters[k] || !(facets[k] || []).length) return; var op = document.createElement('option'); op.value = k; op.textContent = DIM_LABEL[k]; dimSel.appendChild(op); });
    var valSel = null;
    dimSel.onchange = function () {
      if (valSel) valSel.remove();
      var k = dimSel.value; if (!k) return;
      valSel = document.createElement('select'); valSel.setAttribute('data-filterval', '1');
      var z = document.createElement('option'); z.value = ''; z.textContent = 'choose ' + DIM_LABEL[k].toLowerCase() + '…'; valSel.appendChild(z);
      (facets[k] || []).forEach(function (f) { var op = document.createElement('option'); op.value = f.key; op.textContent = short(f.key, k) + ' (' + f.n + ')'; valSel.appendChild(op); });
      valSel.onchange = function () { if (valSel.value) { filters[k] = valSel.value; load(); } };
      box.appendChild(valSel);
    };
    box.appendChild(dimSel);
    pane.appendChild(box);
  }

  function card(host, k, v, n, title) { var c = el('div', 'ucard'); c.appendChild(el('div', 'k', k)); c.appendChild(el('div', 'v', v)); if (n) { var nn = el('div', 'n', n); nn.title = n; c.appendChild(nn); } if (title) c.title = title; host.appendChild(c); }

  // ---- empty state: no fake numbers, but not a blank screen ------------------
  function emptyState(pane) {
    var box = el('div', 'uempty');
    box.appendChild(el('b', '', Object.keys(filters).length ? 'No requests match these filters in this period.' : 'No usage in ' + ({ today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'any period' })[range] + '.'));
    box.appendChild(el('div', 'missing', 'Once LAIN makes a request, input, output, cache and latency appear here — per model, account, role and source. Run a model, or choose another date range.'));
    var F = L.fabric && L.fabric.get().data;
    if (F) {
      var ul = el('ul', '');
      (F.runtimes || []).forEach(function (r) { if (r.discovery.ok) ul.appendChild(el('li', '', r.label + ' · ' + r.state + (r.id === 'llamacpp' ? ' · ' + (((F.groups || []).filter(function (g) { return g.id === 'local'; })[0] || { rows: [] }).rows.filter(function (x) { return x.provider === 'llama.cpp'; }).length) + ' local model(s)' : ''))); });
      ((F.groups || []).filter(function (g) { return g.id === 'chat'; })[0] || { rows: [] }).rows.forEach(function (r) { ul.appendChild(el('li', '', r.label + ' · ' + (r.status && r.status.word))); });
      var api = ((F.groups || []).filter(function (g) { return g.id === 'cloud'; })[0] || { rows: [] }).rows.length;
      if (api) ul.appendChild(el('li', '', api + ' API account(s)'));
      if (ul.childNodes.length) { box.appendChild(el('div', 'missing', 'Connected sources:')); box.appendChild(ul); }
    } else if (L.fabric) L.fabric.load();
    pane.appendChild(box);
    if (lim && lim.grouped && (lim.grouped.active.length || lim.grouped.plans.length)) {
      var s = el('div', 'usec'); s.appendChild(el('h4', '', 'Limits right now'));
      lim.grouped.active.slice(0, 6).forEach(function (a) { s.appendChild(el('div', 'missing', a.name + ': ' + a.windows.map(function (w) { return w.label + ' ' + (w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '%'); }).join(' · '))); });
      lim.grouped.plans.forEach(function (p) { s.appendChild(el('div', 'missing', p.name + ': ' + (p.state === 'active' ? 'active' : p.state === 'installed' ? 'credits not reported' : p.state + (p.reason ? ' — ' + p.reason : '')))); });
      var go = el('button', 'btn small', 'All limits'); go.onclick = function () { section = 'limits'; draw(); }; s.appendChild(go);
      pane.appendChild(s);
    }
  }

  function overview(pane) {
    top(pane, 'Usage', 'What LAIN’s requests consumed. Provider limits are under Limits, never mixed in.');
    if (!data) { pane.appendChild(el('div', 'missing', 'Reading…')); return; }
    var t = data.totals;
    if (!t.requests) { emptyState(pane); return; }
    var cards = el('div', 'ucards');
    card(cards, 'Requests', fmt(t.requests), t.failed ? t.failed + ' failed' : 'none failed');
    card(cards, 'Input', fmt(t.input), t.reported.tokens < t.requests - t.estimated.rows ? (t.requests - t.estimated.rows - t.reported.tokens) + ' request(s) without a usage report' : 'as reported');
    card(cards, 'Output', fmt(t.output), 'as reported');
    card(cards, 'Reasoning', t.reported.reasoning ? fmt(t.reasoning) : '—', t.reported.reasoning ? 'reported by ' + t.reported.reasoning + ' request(s)' : 'not reported');
    card(cards, 'Cache read', t.reported.cache ? fmt(t.cacheRead) : '—', t.reported.cache ? t.cacheHits + ' hit · ' + t.cacheMisses + ' miss' : 'no cache reported');
    card(cards, 'Cache write', t.reported.cache ? fmt(t.cacheWrite) : '—', t.reported.cache ? 'provider cache writes' : 'no cache reported');
    card(cards, 'Latency', t.latency.avgMs == null ? '—' : t.latency.avgMs + ' ms', t.latency.p95Ms == null ? '' : 'p50 ' + t.latency.p50Ms + ' · p95 ' + t.latency.p95Ms + ' ms');
    card(cards, 'Cost', t.cost.actualRows ? money(t.cost.actualUsd) : t.cost.estimatedRows ? 'Estimated ' + money(t.cost.estimatedUsd) : '—', t.cost.actualRows ? 'as providers reported' : t.cost.estimatedRows ? 'Estimated from configured prices' : (t.cost.runtimeRows ? 'runtime-computed ' + money(t.cost.runtimeUsd) + ' — see Cost' : 'no provider figure, no configured price'));
    card(cards, 'Tool calls', t.reported.toolCalls ? fmt(t.toolCalls) : '—', 'tool schema sent: ' + fmt(t.toolSchemaChars) + ' chars');
    card(cards, 'Fixed prompt', fmt(t.systemChars), 'system-prompt chars re-sent');
    if (t.local.rows) card(cards, 'Local speed', t.local.tokPerSec == null ? '—' : t.local.tokPerSec + ' tok/s', 'prompt ' + (t.local.promptTokPerSec == null ? '—' : t.local.promptTokPerSec + ' tok/s') + (t.local.avgLoadMs ? ' · load ' + Math.round(t.local.avgLoadMs / 100) / 10 + ' s' : '') + ' · ' + t.local.rows + ' request(s)');
    if (t.estimated.rows) card(cards, 'Website (observed)', fmt(t.estimated.input + t.estimated.output), 'Estimated by LAIN · ' + t.estimated.rows + ' request(s) · not billed tokens');
    if (data.context && data.context.packets) card(cards, 'FocusPacket', fmt(data.context.packets), 'avg ' + fmt(data.context.avgChars) + ' chars · ' + fmt(data.context.fullReadsAvoided) + ' full reads avoided');
    pane.appendChild(cards);
    sources(pane);
    groups(pane, 6);
    var more = el('button', 'btn small', 'All groupings, all columns →'); more.onclick = function () { section = 'tokens'; draw(); }; pane.appendChild(more);
  }

  function sources(pane) {
    var list = data.bySource || [];
    if (!list.length) return;
    var s = el('div', 'usec'); s.appendChild(el('h4', '', 'Where it went'));
    var max = Math.max.apply(null, list.map(function (x) { return x.requests; }));
    list.forEach(function (x) {
      var r = el('div', 'srcbar'); r.style.cursor = 'pointer'; r.title = 'Filter to ' + x.key;
      r.onclick = function () { filters.via = x.key; load(); };
      r.appendChild(el('span', '', x.key));
      var tr = el('span', 'track'); var f = el('span', ''); f.style.width = Math.max(2, Math.round((x.requests / max) * 100)) + '%'; tr.appendChild(f); r.appendChild(tr);
      var tokens = (x.input || 0) + (x.output || 0);
      r.appendChild(el('span', 'num', x.requests + ' req · ' + (tokens ? fmt(tokens) + ' tok' : x.estimated && x.estimated.rows ? '~' + fmt(x.estimated.input + x.estimated.output) + ' est.' : '—')));
      s.appendChild(r);
    });
    pane.appendChild(s);
  }

  function groups(pane, limit) {
    var rows = (data.groups || []).slice(0, limit || 200);
    if (!rows.length) { pane.appendChild(el('div', 'missing', 'No requests in this range.')); return; }
    var wrap = el('div', 'utw'); var tbl = el('table', 'utbl');
    var hr = el('tr', '');
    [DIM_LABEL[by], 'Requests', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Hit / miss', 'Tool calls', 'Avg ms'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    var th = el('thead', ''); th.appendChild(hr); tbl.appendChild(th);
    var tb = el('tbody', '');
    rows.forEach(function (g) {
      var tr = el('tr', FILTER_DIMS.indexOf(by) >= 0 ? 'click' : '');
      if (FILTER_DIMS.indexOf(by) >= 0) { tr.title = 'Filter to this ' + DIM_LABEL[by].toLowerCase(); tr.onclick = function () { filters[by] = g.key; load(); }; }
      var name = el('td', '', short(g.key, by)); name.title = g.key; tr.appendChild(name);
      var est = g.estimated && g.estimated.rows && !g.reported.tokens;
      [fmt(g.requests), est ? '~' + fmt(g.estimated.input) + ' est.' : fmt(g.input), est ? '~' + fmt(g.estimated.output) + ' est.' : fmt(g.output), g.reported.reasoning ? fmt(g.reasoning) : '—', g.reported.cache ? fmt(g.cacheRead) : '—', g.reported.cache ? fmt(g.cacheWrite) : '—', g.reported.cache ? g.cacheHits + ' / ' + g.cacheMisses : '—', g.reported.toolCalls ? fmt(g.toolCalls) : '—', g.latency.avgMs == null ? '—' : g.latency.avgMs].forEach(function (x) { tr.appendChild(el('td', '', String(x))); });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); pane.appendChild(wrap);
    pane.appendChild(el('div', 'uhint', '— means the source did not report that figure; LAIN does not fill it in. "est." is estimated by LAIN from observed sizes (a website session), never a billed count. Local models have no provider cache.'));
  }

  function localTable(pane) {
    var rows = (data.groups || []).filter(function (g) { return g.local && g.local.rows; });
    if (!rows.length) return;
    var s = el('div', 'usec'); s.appendChild(el('h4', '', 'Local runtime metrics'));
    var wrap = el('div', 'utw'); var tbl = el('table', 'utbl');
    var hr = el('tr', ''); [DIM_LABEL[by], 'Requests', 'Gen tok/s', 'Prompt tok/s', 'Generated', 'Prompt tokens', 'Avg load'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    var th = el('thead', ''); th.appendChild(hr); tbl.appendChild(th); var tb = el('tbody', '');
    rows.forEach(function (g) {
      var tr = el('tr', ''); tr.appendChild(el('td', '', short(g.key, by)));
      [g.local.rows, g.local.tokPerSec == null ? '—' : g.local.tokPerSec, g.local.promptTokPerSec == null ? '—' : g.local.promptTokPerSec, fmt(g.local.genTokens), fmt(g.local.promptTokens), g.local.avgLoadMs ? Math.round(g.local.avgLoadMs / 100) / 10 + ' s' : '—'].forEach(function (x) { tr.appendChild(el('td', '', String(x))); });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); s.appendChild(wrap);
    s.appendChild(el('div', 'uhint', 'As the runtime reported them (llama.cpp timings, Ollama durations). Memory is on MODEL › Local — process working set, not VRAM.'));
    pane.appendChild(s);
  }

  function tokens(pane) {
    top(pane, 'Tokens', 'Grouped by one dimension at a time; click a row to filter. Accounts are account instances — never merged by email.', true);
    if (!data) { pane.appendChild(el('div', 'missing', 'Reading…')); return; }
    if (!data.totals.requests) { emptyState(pane); return; }
    groups(pane);
    localTable(pane);
  }

  function cost(pane) {
    top(pane, 'Cost', 'The provider’s own figure where it gave one. A runtime’s own computed figure is kept apart. Otherwise an estimate — labelled Estimated — only from prices you configured.', true);
    if (!data) { pane.appendChild(el('div', 'missing', 'Reading…')); return; }
    if (!data.totals.requests) { emptyState(pane); return; }
    var wrap = el('div', 'utw'); var tbl = el('table', 'utbl');
    var hr = el('tr', ''); [DIM_LABEL[by], 'Requests', 'Reported by provider', 'Computed by runtime', 'Estimated', 'Not priced'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    var th = el('thead', ''); th.appendChild(hr); tbl.appendChild(th);
    var tb = el('tbody', '');
    (data.groups || []).forEach(function (g) {
      var tr = el('tr', '');
      tr.appendChild(el('td', '', short(g.key, by)));
      tr.appendChild(el('td', '', fmt(g.requests)));
      tr.appendChild(el('td', '', g.cost.actualRows ? money(g.cost.actualUsd) : '—'));
      tr.appendChild(el('td', '', g.cost.runtimeRows ? money(g.cost.runtimeUsd) : '—'));
      tr.appendChild(el('td', '', g.cost.estimatedRows ? 'Estimated ' + money(g.cost.estimatedUsd) : '—'));
      tr.appendChild(el('td', '', g.cost.unpriced ? g.cost.unpriced + ' req' : '—'));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); pane.appendChild(wrap);
    pane.appendChild(el('div', 'uhint', '"Computed by runtime" is a runtime’s own figure for its run — Claude Code reports an API-equivalent cost even on a subscription, where no per-token charge is made. It is never added to billed cost.'));
    if (!data.priced) pane.appendChild(el('div', 'uhint', 'No prices are configured (Settings › usage.prices, per 1M tokens). LAIN ships no price list it cannot keep current.'));
  }

  function efficiency(pane) {
    top(pane, 'Context efficiency', 'Provider caching and LAIN’s own reuse are different mechanisms, reported apart.');
    if (!data) { pane.appendChild(el('div', 'missing', 'Reading…')); return; }
    var e = data.efficiency; var t = data.totals; var c = data.context || { packets: 0 };
    var row = function (host, k, v) { var r = el('div', 'effrow'); r.appendChild(el('span', '', k)); r.appendChild(el('span', '', v)); host.appendChild(r); };
    // WHY SO MANY TOKENS: what each request carried, by part.
    var why = el('div', 'usec'); why.appendChild(el('h4', '', 'Why did this use so many tokens?'));
    var parts = [['Fixed prompt', e.lain.avgSystemChars, '#8b5cf6'], ['Tool schemas', e.lain.avgToolSchemaChars, '#f59e0b'], ['Conversation', e.lain.avgMessageChars, '#3b82f6']];
    var total = parts.reduce(function (a, p) { return a + (p[1] || 0); }, 0);
    if (total) {
      var lg = el('div', 'legend'); parts.forEach(function (p) { var s = el('span', ''); var i = el('i', ''); i.style.background = p[2]; s.appendChild(i); s.appendChild(document.createTextNode(p[0] + ' ' + Math.round(((p[1] || 0) / total) * 100) + '% · ' + fmt(p[1]) + ' chars')); lg.appendChild(s); }); why.appendChild(lg);
      var st = el('div', 'stack'); parts.forEach(function (p) { var s = el('span', ''); s.style.width = ((p[1] || 0) / total * 100) + '%'; s.style.background = p[2]; st.appendChild(s); }); why.appendChild(st);
      why.appendChild(el('div', 'uhint', 'Average per API request in this range (' + e.lain.requests + ' request(s)' + (e.lain.avgToolCount != null ? ', ' + e.lain.avgToolCount + ' tools offered on average' : '') + '). Measured by LAIN from what it sent.'));
    } else why.appendChild(el('div', 'missing', 'No API requests in this range to break down.'));
    pane.appendChild(why);
    var pc = el('div', 'usec'); pc.appendChild(el('h4', '', 'Provider caching (as reported)'));
    row(pc, 'Cache read', t.reported.cache ? fmt(t.cacheRead) + ' tokens' : 'not reported');
    row(pc, 'Cache write', t.reported.cache ? fmt(t.cacheWrite) + ' tokens' : 'not reported');
    row(pc, 'Hit / miss (requests)', t.reported.cache ? t.cacheHits + ' / ' + t.cacheMisses : 'not reported');
    row(pc, 'Cache hit ratio (tokens)', e.provider.hitRatio == null ? 'not reported' : Math.round(e.provider.hitRatio * 1000) / 10 + '% of ' + fmt(e.provider.totalInput) + ' input');
    row(pc, 'Requests reporting cache', fmt(e.provider.reportedRows) + (e.provider.notReportedRows ? ' (' + e.provider.notReportedRows + ' did not report)' : ''));
    if (t.local.rows) row(pc, 'Local models', 'no provider cache — unsupported for local runtimes');
    pane.appendChild(pc);
    var lc = el('div', 'usec'); lc.appendChild(el('h4', '', 'LAIN context efficiency'));
    row(lc, 'FocusPacket', c.packets ? fmt(c.packets) + ' packet(s) · avg ' + fmt(c.avgChars) + ' chars (~' + fmt(Math.round(c.avgChars / 4)) + ' tokens)' : 'none built in this range');
    row(lc, 'Fixed prompt (avg chars)', fmt(e.lain.avgSystemChars));
    row(lc, 'Tool schemas (avg chars)', fmt(e.lain.avgToolSchemaChars));
    row(lc, 'Conversation (avg chars)', fmt(e.lain.avgMessageChars));
    row(lc, 'Selection reuse', c.selection ? c.selection.reused + ' of ' + c.selection.packets + ' packet(s)' : 'not measured in this range');
    row(lc, 'Evidence reuse', c.evidence ? c.evidence.reused + ' of ' + c.evidence.packets + ' packet(s)' : 'not measured in this range');
    row(lc, 'GUG reuse', c.gug ? c.gug.hits + ' of ' + c.gug.lookups + ' lookup(s)' : 'not measured in this range');
    row(lc, 'LSP cache', c.lsp ? c.lsp.cached + ' cached of ' + (c.lsp.requests + c.lsp.cached) + ' answer(s)' : 'not measured in this range');
    row(lc, 'Project graph', c.packets ? c.projectGraph.reused + ' reused · ' + fmt(c.projectGraph.rescannedFiles) + ' file(s) rescanned' : 'not measured in this range');
    row(lc, 'Full-file reads avoided', c.packets ? fmt(c.fullReadsAvoided) : 'not measured in this range');
    row(lc, 'Whole-file rereads', 'not measured across sessions');
    pane.appendChild(lc);
  }

  function resetText(w) {
    if (!w.resetsAt) return { t: '', exp: false };
    var left = w.resetsAt - Date.now();
    return left > 0 ? { t: 'resets in ' + countdown(left) + ' · ' + new Date(w.resetsAt).toLocaleString(), exp: false } : { t: 'reset expected — not confirmed until refreshed', exp: true };
  }
  function winRow(host, w) {
    var r = el('div', 'lwin');
    var exp = w.expired || (w.resetsAt && Date.now() >= w.resetsAt);
    r.appendChild(el('span', '', w.label));
    r.appendChild(qbar(exp ? null : w.usedPercent));
    r.appendChild(el('span', '', exp ? '—' : w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '%'));
    var rt = resetText(w);
    var rs = el('div', 'rs' + (rt.exp ? ' exp' : ''), rt.t);
    rs.setAttribute('data-reset', String(w.resetsAt || ''));
    r.appendChild(rs);
    host.appendChild(r);
  }
  function accountCard(grid, a) {
    var c = el('div', 'lcard'); c.setAttribute('data-account', a.id);
    var h = el('h4', ''); if (L.picon) h.appendChild(L.picon(a.provider || a.driver, 20)); h.appendChild(document.createTextNode(a.name)); c.appendChild(h);
    c.appendChild(el('div', 'who', [a.provider || a.driver, a.identity && a.identity.email, a.identity && a.identity.planType].filter(Boolean).join(' · ')));
    if (!a.windows.length) c.appendChild(el('div', 'missing', a.notReported));
    a.windows.forEach(function (w) { winRow(c, w); });
    if (a.observedAt) c.appendChild(el('div', 'missing', 'Reported ' + L.fmt.time(a.observedAt) + ' by ' + a.reportedBy));
    if (a.source === 'runtime' && a.driver === 'codex') { var rb = el('button', 'btn small', 'Refresh'); rb.onclick = async function () { rb.disabled = true; var r = await L.api('/api/usage/refresh-limits', { id: a.id }); if (r.ok) lim = r; else L.toast(r.why, true); draw(); }; c.appendChild(rb); }
    grid.appendChild(c);
  }
  function limits(pane) {
    top(pane, 'Limits', 'Each account’s windows exactly as its provider or runtime reported them. Windows are never combined into one percentage.');
    if (!lim) { pane.appendChild(el('div', 'missing', 'Reading…')); return; }
    var sw = el('div', 'utop');
    [['grouped', 'By kind'], ['windows', 'By window']].forEach(function (o) { var b = el('button', 'btn small' + (limitView === o[0] ? ' primary' : ''), o[1]); b.onclick = function () { limitView = o[0]; draw(); }; sw.appendChild(b); });
    pane.appendChild(sw);
    var G = lim.grouped || { active: [], plans: [], none: [], local: [] };
    if (limitView === 'grouped') {
      var g1 = el('div', 'lgrp'); g1.setAttribute('data-lgroup', 'active'); g1.appendChild(el('h4', '', 'Active limits'));
      if (!G.active.length) g1.appendChild(el('div', 'missing', 'No account has reported a window yet. Codex accounts report when refreshed; Claude Code after its first run through LAIN; an API route when its responses carry rate-limit headers.'));
      else { var grid = el('div', 'lcards'); G.active.forEach(function (a) { accountCard(grid, a); }); g1.appendChild(grid); }
      pane.appendChild(g1);
      if (G.plans.length) {
        var g2 = el('div', 'lgrp'); g2.setAttribute('data-lgroup', 'plans'); g2.appendChild(el('h4', '', 'Credits & plans'));
        var grid2 = el('div', 'lcards');
        G.plans.forEach(function (p) {
          var c = el('div', 'lcard'); c.setAttribute('data-plan', p.id);
          var h = el('h4', ''); if (L.picon) h.appendChild(L.picon(p.id === 'freebuff' ? 'freebuff' : 'zcode', 20)); h.appendChild(document.createTextNode(p.name)); c.appendChild(h);
          if (p.id === 'freebuff') {
            c.appendChild(el('div', 'big', 'credits not reported'));
            c.appendChild(el('div', 'who', p.creditsWhy));
            if (p.expectedReset) { var rs = el('div', 'lwin'); var t = el('div', 'rs', 'expected reset in ' + countdown(p.expectedReset.resetsAt - Date.now()) + ' — ' + p.expectedReset.basis); t.setAttribute('data-reset', String(p.expectedReset.resetsAt)); t.setAttribute('data-plain', '1'); rs.appendChild(t); c.appendChild(rs); }
          } else {
            c.appendChild(el('div', 'who', p.model + ' · Z.ai / ZCode'));
            c.appendChild(el('div', 'big', p.state === 'active' ? 'active' : p.state === 'unavailable' ? 'unavailable' : 'unknown'));
            if (p.reason) c.appendChild(el('div', 'who', p.reason));
            c.appendChild(el('div', 'missing', (p.balanceWhy || 'Balance not reported by ZCode') + '. Expiry is not exposed by ZCode either.' + (p.recordedAt ? ' Status recorded by ZCode ' + new Date(p.recordedAt).toLocaleString() + '.' : '')));
            if (p.includes && p.includes.length) c.appendChild(el('div', 'missing', 'Plan includes: ' + p.includes.join(', ') + ' (' + p.includesBasis + ') — runs inside ZCode only; LAIN reads its status.'));
            if (p.runtimeUsage) c.appendChild(el('div', 'missing', fmt(p.runtimeUsage.tokens) + ' tokens · ' + fmt(p.runtimeUsage.requests) + ' requests through ZCode (' + p.runtimeUsage.range + ', runtime-reported)'));
          }
          grid2.appendChild(c);
        });
        g2.appendChild(grid2); pane.appendChild(g2);
      }
      if (G.none.length) {
        var g3 = el('details', 'lgrp'); g3.setAttribute('data-lgroup', 'none');
        g3.appendChild(el('summary', '', G.none.length + ' account(s) with no reported limit'));
        G.none.forEach(function (n) { g3.appendChild(el('div', 'missing', n.name + ' — ' + n.why)); });
        pane.appendChild(g3);
      }
      if (G.local.length) {
        var g4 = el('details', 'lgrp'); g4.setAttribute('data-lgroup', 'local');
        g4.appendChild(el('summary', '', G.local.length + ' local model(s) — no provider quota'));
        G.local.forEach(function (n) { g4.appendChild(el('div', 'missing', n.name + ' · ' + n.via + ' · Local — no provider quota')); });
        pane.appendChild(g4);
      }
    } else {
      var wrap = el('div', 'utw'); var tbl = el('table', 'utbl');
      var hr = el('tr', ''); ['Account', 'Window', 'Used', 'Resets'].forEach(function (x) { hr.appendChild(el('th', '', x)); });
      var th = el('thead', ''); th.appendChild(hr); tbl.appendChild(th);
      var tb = el('tbody', '');
      (lim.windows || []).slice().sort(function (a, b) { return (b.usedPercent || 0) - (a.usedPercent || 0); }).forEach(function (w) {
        var tr = el('tr', '');
        tr.appendChild(el('td', '', w.name));
        tr.appendChild(el('td', '', w.label));
        var exp = w.expired || (w.resetsAt && Date.now() >= w.resetsAt);
        tr.appendChild(el('td', '', exp ? 'reset (unconfirmed)' : w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '%'));
        var rs = el('td', 'rs', resetText(w).t); rs.setAttribute('data-reset', String(w.resetsAt || '')); tr.appendChild(rs);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl); pane.appendChild(wrap);
      if (!(lim.windows || []).length) pane.appendChild(el('div', 'missing', 'No window reported yet.'));
    }
    if (!ticker) ticker = setInterval(tick, 1000);
  }
  function tick() {
    if (L.nav.tab() !== 'usage' || section !== 'limits') { clearInterval(ticker); ticker = null; return; }
    var crossed = false;
    Array.prototype.forEach.call(document.querySelectorAll('#usagePane [data-reset]'), function (n) {
      var t = Number(n.getAttribute('data-reset')); if (!t) return;
      var left = t - Date.now();
      if (n.getAttribute('data-plain')) { n.textContent = left > 0 ? 'expected reset in ' + countdown(left) + ' — not reported by the runtime' : 'reset due — not confirmed'; return; }
      n.textContent = left > 0 ? 'resets in ' + countdown(left) + ' · ' + new Date(t).toLocaleString() : 'reset expected — not confirmed until refreshed';
      if (left <= 0) n.classList.add('exp');
      if (left <= 0 && left > -1100) crossed = true;
    });
    // AT A RESET the old figure is no longer the provider's word: redraw it as
    // expired now; the next Refresh is what confirms the new one.
    if (crossed) draw();
  }

  function draw() {
    if (L.nav.tab() !== 'usage') return;
    nav();
    var pane = $('usagePane'); var keep = pane.scrollTop; pane.textContent = '';
    if (section === 'tokens') tokens(pane);
    else if (section === 'cost') cost(pane);
    else if (section === 'efficiency') efficiency(pane);
    else if (section === 'limits') limits(pane);
    else overview(pane);
    pane.scrollTop = keep;
  }

  L.onBoot(function () {
    L.nav.onShow('usage', function (o) {
      if (o && o.section && /^(overview|tokens|cost|efficiency|limits)$/.test(o.section)) section = o.section;
      if (o && o.filters) filters = Object.assign({}, o.filters);
      if (!data && !loading) load(); else draw();
    });
    if (L.fabric) L.fabric.on(function () { if (L.nav.tab() === 'usage' && data && !data.totals.requests) draw(); });
  });
  L.usageView = { load: load, show: function (s, f) { section = s || 'overview'; if (f) filters = Object.assign({}, f); L.nav.go('usage', { section: section, filters: f || null }); } };
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
