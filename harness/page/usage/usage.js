'use strict';

/**
 * THE USAGE VIEW — what was consumed, and how much of each provider window is
 * used. Two questions, two kinds of number, never one.
 *
 *   Windows    (Phase 8, the default) each PROVIDER RESET WINDOW — the 5-hour,
 *              weekly, monthly… as the provider names it — with the provider's
 *              own used/remaining %, and beside it what LAIN OBSERVED inside that
 *              window: input, output, reasoning, cache read, cache write,
 *              requests (cost only where reported). Current vs previous window,
 *              and a breakdown by project / session / model / account whose
 *              percentages are SHARES OF LAIN-OBSERVED USAGE, not of the quota.
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
<section class="view usagev" id="vUsage" data-view="usage" hidden>
  <div class="upane" id="usagePane"></div>
</section>`;

/**
 * THE LOOK: every block is a flat plane (surface-1; a provider's windows in its tint, as on MODEL); figures are
 * readable, not billboards — a window's remaining share at 26 px, the rest at body size.
 */
const CSS = `
.usagev{display:flex;flex-direction:column;min-height:0;height:100%}
.upane{flex:1;min-height:0;overflow-y:auto}
.ubody{display:flex;flex-direction:column;gap:12px;min-width:0}
.ubody > .u-sec{background:var(--surface-base);border-radius:var(--radius-md);padding:14px 18px 8px;margin:0}
.ubody > .u-sec + .u-sec{margin-top:0}
.ubody .u-sec[data-sec$=odex],.ubody .u-sec[data-sec=codex]{background:var(--plane-blue)}
.ubody .u-sec[data-sec$=laude]{background:var(--plane-violet)}
.ubody .u-sec[data-sec$=ntigravity]{background:var(--plane-teal)}
.ubody .u-sec[data-sec$=penCode],.ubody .u-sec[data-sec$=opencode]{background:var(--plane-amber)}
.ubody .u-sec > .u-sech h3{font-size:12.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.ubody .title3{font:600 14px/1.35 var(--sans);color:var(--text-primary);margin:0}
.ubody .lede{font-size:12.5px;color:var(--text-secondary);margin:3px 0 10px;line-height:1.5}
.ubody .kicker{font-size:11px}
.wmid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px}
.wmid > .winfo:only-child{grid-column:1 / -1}
.wobs{background:var(--surface-base);border-radius:var(--radius-md);padding:14px 18px;min-width:0}
.wtot{font:600 26px/1.15 var(--display);margin:2px 0 10px}
.wstack{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--surface-active)}
.wstack i{display:block;height:100%}
.wlegend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}
.wlegend > div{display:grid;grid-template-columns:12px 1fr;column-gap:8px;align-items:center}
.wlegend .dot{width:8px;height:8px;border-radius:50%}
.wlegend .k{color:var(--text-secondary);font-size:12.5px} .wlegend b{grid-column:2;font:600 15px/1.3 var(--sans)} .wlegend small{grid-column:2;color:var(--text-muted);font-size:11.5px}
.winfo{display:grid;grid-template-columns:1fr;gap:12px}
.winfo > div{background:var(--surface-base);border-radius:var(--radius-md);padding:12px 16px}
.winfo b{display:block;font-size:13px;margin-bottom:4px} .winfo p{margin:0;color:var(--text-secondary);font-size:12.5px;line-height:1.5}
.wbd{background:var(--surface-base);border-radius:var(--radius-md);padding:14px 18px;overflow-x:auto}
.wbd table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:620px}
.wbd th{text-align:right;font-weight:500;color:var(--text-muted);font-size:11.5px;padding:6px 8px;border-bottom:1px solid var(--separator)}
.wbd th:first-child,.wbd td:first-child{text-align:left}
.wbd td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--separator);white-space:nowrap;font-variant-numeric:tabular-nums}
.wbd tr:last-child td{border-bottom:0}
.wbd td.share{width:170px} .wbd .sb{display:inline-block;width:90px;height:5px;border-radius:3px;background:var(--surface-active);vertical-align:middle;margin-left:8px;overflow:hidden} .wbd .sb i{display:block;height:100%;background:var(--accent-primary)}
.utop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.utop h2{font:600 14px/1.3 var(--sans);margin:0}
.utop .sub{font-size:12.5px;color:var(--text-secondary)}
.utop .spacer{flex:1}
.utop select{min-width:0}
.ufilters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ufilters:empty{display:none}
.ufilters .fchip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:2px 4px 2px 9px;border-radius:var(--radius-sm);background:var(--selection);color:var(--text-primary)}
.ufilters .fchip button{border:0;background:transparent;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px}
.ufilters select{font-size:12px}
.ucard{background:var(--surface-base);border-radius:var(--radius-md);padding:12px 14px;min-width:0}
.ucard .k{font-size:11px;color:var(--text-muted);font-weight:600}
.ucard .v{font-size:18px;font-weight:600;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.ucard .n{font-size:11.5px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.usec{background:var(--surface-base);border-radius:var(--radius-md);padding:12px 16px}
.usec h4{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px;font-weight:600}
.srcbar{display:grid;grid-template-columns:180px minmax(0,1fr) 150px;gap:10px;align-items:center;font-size:12.5px;padding:3px 0}
.srcbar .track{height:6px;border-radius:3px;background:var(--surface-active);overflow:hidden}
.srcbar .track span{display:block;height:100%;background:var(--chart-1)}
.srcbar .num{color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums}
.stack{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0}
.stack span{display:block;height:100%}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-bottom:6px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.uempty{background:var(--surface-base);border-radius:var(--radius-md);padding:14px 18px}
.uempty b{display:block;font-size:13.5px;margin-bottom:4px}
.uempty .missing{margin-top:4px;font-size:12.5px;color:var(--text-secondary)}
.uempty ul{margin:8px 0 0;padding-left:18px;font-size:12.5px;color:var(--text-secondary)}
.missing{font-size:12.5px;color:var(--text-muted)}
.utw{overflow-x:auto;background:var(--surface-base);border-radius:var(--radius-md);padding:6px 12px}
.utbl{width:100%;min-width:720px;border-collapse:collapse;font-size:12.5px}
.utbl th{font-size:11px;color:var(--text-muted);text-align:right;padding:6px 8px;border-bottom:1px solid var(--separator);font-weight:600;white-space:nowrap}
.utbl th:first-child,.utbl td:first-child{text-align:left}
.utbl td{padding:6px 8px;border-bottom:1px solid var(--separator);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.utbl tr:last-child td{border-bottom:0}
.utbl td:first-child{max-width:340px;overflow:hidden;text-overflow:ellipsis}
.utbl tr.click{cursor:pointer}
.utbl tr.click:hover td{background:var(--hover)}
.lgrp > h4{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px;font-weight:600}
.lgrp summary{font-size:12.5px;color:var(--text-secondary);cursor:pointer}
.lcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.lcard{background:var(--surface-base);border-radius:var(--radius-md);padding:12px 14px;min-width:0}
.lcard h4{margin:0;font-size:13px;display:flex;align-items:center;gap:8px}
.lcard .who{font-size:11.5px;color:var(--text-muted);margin:2px 0 8px}
.lwin{display:grid;grid-template-columns:78px 1fr auto;gap:8px;align-items:center;font-size:12px;padding:3px 0}
.lwin .q-bar{display:block;height:4px;border-radius:2px;background:color-mix(in srgb,var(--text-primary) 10%,transparent);overflow:hidden}
.lwin .q-fill{display:block;height:100%;background:var(--quota-ok)} .lwin .q-fill.warn{background:var(--quota-warn)} .lwin .q-fill.bad{background:var(--quota-bad)}
.lwin .rs{grid-column:1 / -1;font-size:11px;color:var(--text-muted);margin-top:-2px}
.lwin .rs.exp{color:var(--warning)}
.effrow{display:grid;grid-template-columns:240px 1fr;gap:10px;font-size:12.5px;padding:6px 0;border-top:1px solid var(--separator)}
.effrow:first-of-type{border-top:0}
.effrow span:first-child{color:var(--text-muted)}
.uhint{font-size:11.5px;color:var(--text-muted);margin:0}
@media (max-width: 1000px){.wmid{grid-template-columns:minmax(0,1fr)}.wlegend{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width: 640px){.srcbar{grid-template-columns:110px minmax(0,1fr) 110px}.effrow{grid-template-columns:1fr}}
/* ---- THE DASHBOARD (Overview): planes of charts, overall first ------------------------------------------------- */
.ug{display:grid;gap:14px}
.ug-top{grid-template-columns:minmax(0,1.45fr) minmax(0,1fr)}
.ug-mid{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr)}
.ubody .uplane{border-radius:var(--radius-lg);box-shadow:inset 0 0 0 1px var(--separator);padding:16px 18px 18px;min-width:0;margin:0}
.ubody .uplane .u-ph{margin-bottom:14px}
.uo-body{display:grid;grid-template-columns:auto minmax(0,1fr);gap:26px;align-items:center}
.uo-donut{display:flex;flex-direction:column;align-items:center;gap:12px}
.uo-donut .u-ring.lg .ctr b{font-size:30px}
.uo-leg{flex-direction:row;gap:14px}
.uo-leg > div{grid-template-columns:10px auto auto;gap:6px}
.uo-leg em{display:none}
.uo-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px}
.ub-seg{margin:0 0 14px;display:flex}
.ub-seg > button{flex:1;justify-content:center}
.ub-note{margin-top:14px;padding:10px 12px;border-radius:var(--radius-md);background:var(--secondary-weak);font-size:var(--fs-small);color:var(--text-secondary);line-height:1.5}
.ut-leg{margin-left:auto;display:flex;gap:12px;font-size:var(--fs-caption);color:var(--text-secondary)}
.ut-leg i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.uf-chips{margin:0 0 2px}
.uw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.uw-card{border-radius:var(--radius-md);padding:12px;background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator)}
.uw-card.blue{background:var(--plane-blue)} .uw-card.violet{background:var(--plane-violet)} .uw-card.teal{background:var(--plane-teal)} .uw-card.amber{background:var(--plane-amber)} .uw-card.rose{background:var(--plane-rose)}
.uw-ch{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.uw-mark{width:36px;height:36px;border-radius:var(--radius-sm);display:grid;place-items:center;background:color-mix(in srgb,var(--text-primary) 7%,transparent);color:var(--text-primary);flex:none}
.uw-ct{min-width:0}
.uw-ct b{display:block;font-size:var(--fs-body);font-weight:600;color:var(--text-primary)}
.uw-st{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-small);color:var(--text-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uw-upd{margin-left:auto;font-size:var(--fs-caption);color:var(--text-muted)}
.uw-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.uw-tile{border-radius:var(--radius-sm);padding:10px 10px 9px;background:color-mix(in srgb,var(--canvas) 45%,transparent)}
.uw-h{display:flex;gap:8px;align-items:flex-start;color:var(--text-secondary)}
.uw-h .ic{margin-top:1px;flex:none}
.uw-h b{display:block;font-size:var(--fs-small);font-weight:600;color:var(--text-primary)}
.uw-h small{display:block;font-size:var(--fs-caption);color:var(--text-muted)}
.uw-row{display:flex;align-items:center;gap:10px;margin-top:10px}
.uw-row .u-ring .ctr b{font-size:var(--fs-small)}
.uw-kv{display:grid;grid-template-columns:auto auto;gap:3px 10px;margin:0;font-size:var(--fs-caption)}
.uw-kv dt{color:var(--text-muted)} .uw-kv dd{margin:0;text-align:right;color:var(--text-primary);font-variant-numeric:tabular-nums} .uw-kv dd.pos{color:var(--positive)}
.uw-cap{margin-top:9px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:var(--fs-caption);color:var(--text-muted)}
.uw-cap b{color:var(--text-primary);font-weight:500}
.uw-cap em{font-style:normal;padding:1px 8px;border-radius:999px;background:var(--surface-active);color:var(--text-secondary)}
.uw-cap em.conf-high{background:var(--secondary-weak);color:var(--accent-secondary)} .uw-cap em.conf-medium{background:color-mix(in srgb,var(--info) 14%,transparent);color:var(--info)} .uw-cap em.conf-low{background:var(--warning-weak);color:var(--warning)}
@media (max-width:1180px){.ug-mid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.ug-mid .u-time{grid-column:1 / -1}}
@media (max-width:900px){.ug-top,.ug-mid{grid-template-columns:minmax(0,1fr)}.uo-body{grid-template-columns:minmax(0,1fr);justify-items:center}.uo-stats{width:100%}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var section = 'overview', range = 'month', by = 'model', limitView = 'grouped';
  var RANGE_WORD = { today: 'today', '7d': 'the last 7 days', month: 'this month', '30d': 'the last 30 days', all: 'all time' };
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
  /** The bar is what REMAINS. `pct` is what the provider reported USED (every source does); 100% remaining is never red. */
  function qbar(pct) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    var rem = pct == null ? null : Math.max(0, Math.min(100, 100 - pct));
    fill.style.width = (rem == null ? 0 : rem) + '%';
    var tone = rem == null ? '' : (L.kit ? L.kit.quotaTone(rem) : (rem <= 5 ? 'bad' : rem <= 20 ? 'warn' : ''));
    fill.className = 'q-fill' + (tone ? ' ' + tone : '');
    return wrap;
  }
  function short(k, dim) { if (dim === 'session' || dim === 'task') return String(k).slice(0, 18); return k; }

  async function load() {
    loading = true; draw();
    var a = await L.api('/api/usage', { range: range, by: by, filters: filters, also: ['provider', 'account', 'model'] });
    if (!wins && !winLoading) loadWindows();
    var b = await L.api('/api/usage/limits', {});
    loading = false;
    if (a && a.ok) data = a;
    if (b && b.ok) lim = b;
    draw();
  }

  var TABS = [['overview', 'Overview'], ['windows', 'Windows'], ['tokens', 'Tokens'], ['cost', 'Cost'], ['efficiency', 'Efficiency'], ['limits', 'Limits']];
  function tabsBar() {
    var box = L.kit.tabs(TABS, section, function (id) { section = id; draw(); if (id === 'windows' && !wins && !winLoading) loadWindows(); });
    box.id = 'usageNav';
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) { b.setAttribute('data-usage', b.getAttribute('data-tab')); });
    return box;
  }

  // ---- WINDOWS: provider reset windows, and what LAIN observed inside each ------------------------
  var wins = null, winLoading = false, winBy = 'project', winWhich = 'current';
  var updating = {};        // source id -> true while its provider limits are being re-read
  var bgAt = 0;
  async function loadWindows() {
    winLoading = true; if (section === 'windows' && !wins) draw();
    var r = await L.api('/api/usage/windows', { by: winBy });   // LOCAL: the usage index + cached telemetry — instant
    winLoading = false;
    if (r && r.ok) wins = r.windows;
    if (section === 'windows') draw();
    backgroundRefresh();
  }
  // PROVIDER LIMITS REFRESH BEHIND THE PAGE (Phase 8.1): the page is already drawn from
  // the index; each account's own reading is re-asked in the background (at most once a
  // minute), and only its cards say "Updating provider limits…".
  function backgroundRefresh() {
    if (!wins || Date.now() - bgAt < 60000) return;
    bgAt = Date.now();
    var ids = {};
    wins.forEach(function (w) { if (w.source && w.source !== 'claude-code' && !/^lain:|^api:/.test(w.source)) ids[w.source] = true; });
    Object.keys(ids).forEach(function (id) {
      updating[id] = true;
      L.api('/api/usage/refresh-limits', { id: id }).then(function () { delete updating[id]; return L.api('/api/usage/windows', { by: winBy }); }, function () { delete updating[id]; return null; })
        .then(function (r) { if (r && r.ok) wins = r.windows; if (section === 'windows') draw(); });
    });
    if (Object.keys(ids).length && section === 'windows') draw();
  }
  function kfmt(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n); }
  function windowCard(w, i) {
    var cur = winWhich === 'previous' && w.previous ? w.previous : w;
    var c = el('div', 'wcard2 ' + (i % 2 ? 'hotw' : 'accw'));
    var h = el('div', 'wc-head');
    var t = el('div', '');
    t.appendChild(el('div', 'kicker', 'Provider reset window'));
    t.appendChild(el('div', 't', (winWhich === 'previous' ? 'Previous ' : 'Current ') + (w.label || w.window) + ' window'));
    h.appendChild(t);
    var r = el('div', 'r');
    if (winWhich === 'current' && w.resetsAt) { r.appendChild(document.createTextNode('Resets in')); var cd = el('b', '', countdown(w.resetsAt - Date.now())); cd.setAttribute('data-reset', String(w.resetsAt)); r.appendChild(cd); }
    else if (cur.start) { r.appendChild(document.createTextNode('Window')); r.appendChild(el('b', '', new Date(cur.start).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' \u2192 ' + new Date(cur.end).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))); }
    h.appendChild(r);
    c.appendChild(h);
    var used = winWhich === 'previous' ? (w.previous && w.previous.usedPercent) : w.usedPercent;
    var past = winWhich === 'previous';
    var p = el('div', 'wc-pct');
    // THE CURRENT WINDOW SAYS WHAT REMAINS; A PAST ONE, WHAT WAS USED BY ITS END. Each figure is labelled — never a bare percentage.
    p.appendChild(el('span', 'n', used != null ? Math.round(past ? used : 100 - used) + '%' : '\u2014'));
    p.appendChild(el('span', 'l', used != null ? (past ? 'of provider quota used' : 'of provider quota remaining') : (past ? (w.previous && w.previous.usedPercentBasis) || 'not recorded' : 'provider % not reported')));
    if (used != null && !past) { var rem = el('span', 'rem'); rem.appendChild(el('b', '', Math.round(used) + '%')); rem.appendChild(document.createTextNode('used')); p.appendChild(rem); }
    c.appendChild(p);
    var left = used == null ? null : (past ? used : Math.max(0, Math.min(100, 100 - used)));
    var bar = el('div', 'wc-bar'); var fill = el('i');
    fill.style.width = (left != null ? Math.max(past ? 1 : 0, Math.min(100, left)) : 0) + '%';
    if (!past && left != null && L.kit && L.kit.quotaTone(left)) fill.className = L.kit.quotaTone(left);
    bar.appendChild(fill); c.appendChild(bar);
    if (updating[w.source]) c.appendChild(el('div', 'wc-note', 'Updating provider limits\u2026'));
    var o = cur.observed;
    if (o) {
      var g = el('div', 'wc-obs');
      [['Input', o.input], ['Output', o.output], ['Reasoning', o.reported && o.reported.reasoning ? o.reasoning : null], ['Cache read', o.reported && o.reported.cache ? o.cacheRead : null], ['Cache write', o.reported && o.reported.cache ? o.cacheWrite : null], ['Requests', o.requests]].forEach(function (x) {
        var d = el('div'); d.appendChild(el('span', '', x[0])); d.appendChild(el('b', '', x[1] == null ? '\u2014' : x[0] === 'Requests' ? String(x[1]) : kfmt(x[1]))); g.appendChild(d);
      });
      c.appendChild(g);
      c.appendChild(el('div', 'wc-note', 'LAIN-observed inside this window' + (o.costUsd != null ? ' \u00b7 reported cost $' + o.costUsd : '') + '. The provider % covers all use of the account, in LAIN or not.'));
    } else c.appendChild(el('div', 'wc-note', w.why || 'LAIN cannot place this window in time.'));
    return c;
  }
  function windows(pane) {
    var U = L.kit;
    var tools = el('div', 'u-acts'); tools.style.margin = '0 0 var(--space-4)'; tools.style.justifyContent = 'space-between';
    var chips = el('div', 'u-chips');
    [['current', 'Current'], ['previous', 'Previous']].forEach(function (x) { var b = el('button', 'u-chip', x[1]); b.setAttribute('aria-pressed', String(winWhich === x[0])); b.onclick = function () { winWhich = x[0]; draw(); }; chips.appendChild(b); });
    tools.appendChild(chips);
    var right = el('div', 'u-acts');
    right.appendChild(U.select('By ' + winBy, ['project', 'session', 'model', 'account'].map(function (k) { return { label: 'By ' + k, checked: winBy === k, run: function () { winBy = k; loadWindows(); } }; }), { id: 'usage-by' }));
    right.appendChild(U.button(winLoading ? 'Reading…' : 'Refresh', 'ghost', function () { loadWindows(); if (L.intel) L.intel.load(true); }, 'refresh'));
    tools.appendChild(right);
    pane.appendChild(tools);
    if (!wins) { pane.appendChild(el('div', 'u-empty', winLoading ? 'Reading provider windows…' : 'Not read yet.')); if (!winLoading) loadWindows(); return; }
    var bounded = wins.filter(function (w) { return w.category !== 'CREDITS'; });
    if (!bounded.length) pane.appendChild(U.empty('No provider has reported a usage window yet', 'Windows appear when a provider states them — Claude Code after its first run through LAIN, a Codex account when it is read. LAIN never invents a window or a percentage.'));
    // PROVIDER → ACCOUNT → the windows THAT ACCOUNT reported (5-hour, weekly, monthly, credits — never an empty label).
    var provs = {}; var order = [];
    wins.forEach(function (w) {
      var fl = (L.dash && L.dash.families && (L.dash.families() || []).filter(function (f) { return f.id === w.family; })[0]) || null;
      var pk = fl ? fl.label : (w.family === 'api' ? 'API' : w.family ? w.family.charAt(0).toUpperCase() + w.family.slice(1) : (w.sourceLabel || w.source));
      if (!provs[pk]) { provs[pk] = { accts: {}, order: [], family: w.family || pk }; order.push(pk); }
      var P = provs[pk];
      if (!P.accts[w.source]) { P.accts[w.source] = { name: w.sourceLabel || w.account || pk, who: w.account, basis: w.basis, ws: [] }; P.order.push(w.source); }
      P.accts[w.source].ws.push(w);
    });
    var biggest = null;
    order.forEach(function (pk) {
      var P = provs[pk];
      var sec = U.section({ id: pk, title: pk, mark: P.family || String(pk).toLowerCase(), meta: P.order.length + ' account' + (P.order.length === 1 ? '' : 's') });
      var rows = el('div', 'u-rows');
      P.order.forEach(function (src) {
        var A = P.accts[src];
        var row = el('div', 'u-row plain'); row.setAttribute('data-usage-source', src);
        row.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1.3fr)';
        var idc = el('div', 'u-id'); idc.appendChild(el('div', 'u-nm', A.name)); var wh = [A.who && A.who !== A.name ? A.who : null, A.basis].filter(Boolean).join(' · '); if (wh) idc.appendChild(el('div', 'u-who', wh));
        if (updating[src]) idc.appendChild(el('div', 'u-who', 'Updating provider limits…'));
        row.appendChild(idc);
        var qs = el('div', 'u-qs');
        A.ws.forEach(function (w) {
          var cur = winWhich === 'previous' && w.previous ? w.previous : w;
          var used = winWhich === 'previous' ? (w.previous && w.previous.usedPercent) : w.usedPercent;
          var q = U.qbar({ label: w.label || w.window, usedPercent: used, resetsAt: winWhich === 'current' ? w.resetsAt : null, credits: w.category === 'CREDITS' && w.credits ? w.credits.available : null });
          if (q) {
            var o = cur.observed;
            if (winWhich === 'current' && w.resetsAt) { var rs = U.resetText(w.resetsAt); if (rs) q.title = 'Resets ' + rs + (o ? ' · LAIN observed ' + kfmt((o.input || 0) + (o.output || 0)) + ' tokens in this window' : ''); }
            qs.appendChild(q);
          }
          if (cur.breakdown && cur.breakdown.length && (!biggest || (w.durationMins || 0) > (biggest.w.durationMins || 0))) biggest = { w: w, rows: cur.breakdown };
        });
        if (!qs.children.length) qs.appendChild(el('div', 'u-qn', A.ws[0] && A.ws[0].why || 'The provider has not reported a window for this account.'));
        row.appendChild(qs);
        rows.appendChild(row);
      });
      sec.appendChild(rows);
      pane.appendChild(sec);
    });
    // LAIN-OBSERVED, AS ONE BAR: where the tokens of the longest window went (not the provider quota).
    var obsW = biggest && biggest.w;
    var mid = el('div', 'wmid');
    if (obsW) {
      var ow = winWhich === 'previous' && obsW.previous ? obsW.previous.observed : obsW.observed;
      var ob = el('div', 'wobs');
      ob.appendChild(el('div', 'title3', 'LAIN-observed usage'));
      ob.appendChild(el('p', 'lede', 'Tokens LAIN sent and received in the ' + (winWhich === 'previous' ? 'previous ' : 'current ') + (obsW.label || obsW.window) + ' window — not provider quota.'));
      var parts = [['Input', ow.input, 'var(--text-primary)'], ['Output', ow.output, 'var(--accent-primary)'], ['Cache read', ow.reported && ow.reported.cache ? ow.cacheRead : 0, 'color-mix(in srgb,var(--accent-primary) 55%,var(--surface-base))'], ['Cache write', ow.reported && ow.reported.cache ? ow.cacheWrite : 0, 'var(--accent-tertiary)']];
      var tot = parts.reduce(function (a, p) { return a + (p[1] || 0); }, 0);
      ob.appendChild(el('div', 'kicker', 'Total tokens'));
      ob.appendChild(el('div', 'wtot', kfmt(tot)));
      var sb = el('div', 'wstack');
      parts.forEach(function (p) { if (!p[1] || !tot) return; var i = el('i'); i.style.width = (100 * p[1] / tot) + '%'; i.style.background = p[2]; i.title = p[0]; sb.appendChild(i); });
      ob.appendChild(sb);
      var lg = el('div', 'wlegend');
      parts.forEach(function (p) {
        var d = el('div'); var dot = el('span', 'dot'); dot.style.background = p[2]; d.appendChild(dot);
        d.appendChild(el('span', 'k', p[0])); d.appendChild(el('b', '', p[0].indexOf('Cache') === 0 && !(ow.reported && ow.reported.cache) ? '—' : kfmt(p[1])));
        d.appendChild(el('small', '', tot && p[1] ? Math.round(100 * p[1] / tot) + '%' : ''));
        lg.appendChild(d);
      });
      ob.appendChild(lg);
      mid.appendChild(ob);
    }
    if (biggest) {
      var bd = el('div', 'wbd');
      bd.appendChild(el('div', 'title3', 'Usage by ' + winBy + ' \u2014 ' + (winWhich === 'previous' ? 'previous ' : 'current ') + (biggest.w.label || biggest.w.window) + ' window'));
      bd.appendChild(el('p', 'lede', 'LAIN-observed tokens and requests. Share is of LAIN-observed usage in this window \u2014 not of the provider quota.'));
      var t = el('table'); var hr = el('tr');
      [winBy.charAt(0).toUpperCase() + winBy.slice(1), 'Input', 'Output', 'Cache read', 'Cache write', 'Requests', 'Share'].forEach(function (x) { hr.appendChild(el('th', '', x)); });
      t.appendChild(hr);
      biggest.rows.slice(0, 20).forEach(function (r) {
        var tr = el('tr');
        [r.name || r.key, kfmt(r.input), kfmt(r.output), r.reported && r.reported.cache ? kfmt(r.cacheRead) : '\u2014', r.reported && r.reported.cache ? kfmt(r.cacheWrite) : '\u2014', String(r.requests)].forEach(function (x) { tr.appendChild(el('td', '', x)); });
        var sh = el('td', 'share', r.share + '%'); var sb = el('span', 'sb'); var si = el('i'); si.style.width = Math.max(1, r.share) + '%'; sb.appendChild(si); sh.appendChild(sb); tr.appendChild(sh);
        t.appendChild(tr);
      });
      bd.appendChild(t);
      pane.appendChild(bd);
    }
    var info = el('div', 'winfo' + (obsW ? ' side' : ''));
    var i1 = el('div'); i1.appendChild(el('b', '', 'Provider quota')); i1.appendChild(el('p', '', 'Limits set by the provider \u2014 a 5-hour, weekly or monthly window, or credits. Tracked by the provider and covering all use of your account, including use outside LAIN.'));
    var i2 = el('div'); i2.appendChild(el('b', '', 'LAIN-observed tokens')); i2.appendChild(el('p', '', 'What LAIN itself sent and received inside each window, from its own request receipts. It explains where the usage went; it is not the provider\u2019s quota unless that quota is itself counted in tokens.'));
    info.appendChild(i1); info.appendChild(i2);
    mid.appendChild(info);
    // The observed bar and the explanation sit between the windows and the breakdown.
    var bdNode = pane.querySelector('.wbd');
    if (bdNode) pane.insertBefore(mid, bdNode); else pane.appendChild(mid);
  }

  function top(pane, title, sub, withGroup) {
    var t = el('div', 'utop');
    var h = el('div', ''); h.appendChild(el('h2', '', title)); if (sub) { var s = el('div', 'sub', sub); s.style.margin = '0'; h.appendChild(s); } t.appendChild(h);
    t.appendChild(el('span', 'spacer'));
    if (section !== 'limits') {
      var r = document.createElement('select'); r.setAttribute('data-range', '1');
      [['today', 'Today'], ['7d', 'Last 7 days'], ['month', 'This month'], ['30d', 'Last 30 days'], ['all', 'All time']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (o[0] === range) op.selected = true; r.appendChild(op); });
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
    box.appendChild(el('b', '', Object.keys(filters).length ? 'No requests match these filters in this period.' : 'No usage ' + (range === 'all' ? 'recorded yet' : 'in ' + RANGE_WORD[range]) + '.'));
    box.appendChild(el('div', 'missing', 'Once LAIN makes a request, input, output, cache and latency appear here — per model, account, role and source. Run a model, or choose another date range.'));
    // WHAT IS CONNECTED — from the one fabric (model/intel.js), so an empty range never reads as "nothing set up".
    var fams = (L.intel && L.intel.families()) || [];
    var ul = el('ul', '');
    fams.forEach(function (f) { if (f.accounts.length) ul.appendChild(el('li', '', f.label + ' · ' + f.accounts.length + ' account' + (f.accounts.length === 1 ? '' : 's'))); });
    if (ul.childNodes.length) { box.appendChild(el('div', 'missing', 'Connected:')); box.appendChild(ul); } else if (L.intel) L.intel.load();
    pane.appendChild(box);
    if (lim && lim.grouped && lim.grouped.active.length) {
      var s = el('div', 'usec'); s.appendChild(el('h4', '', 'Limits right now'));
      lim.grouped.active.slice(0, 6).forEach(function (a) { s.appendChild(el('div', 'missing', a.name + ': ' + a.windows.map(function (w) { return w.label + ' ' + (w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent) + '% remaining'); }).join(' · '))); });
      var go = el('button', 'btn small', 'All limits'); go.onclick = function () { section = 'limits'; draw(); }; s.appendChild(go);
      pane.appendChild(s);
    }
  }

  // ---- OVERVIEW: the dashboard (2026-09-30) — overall first, then where it went, then each provider's windows ------
  //
  //   ┌ Overall usage ─────────────────────────────┐ ┌ Usage breakdown  [Cache reuse|Accounts|Sources] ┐
  //   │ (donut: input · output)   stats            │ │ (donut)  legend · what the figure means          │
  //   ├ Usage over time ──────────┐ ┌ By provider ─┐ ┌ By model ────┐
  //   ├ Provider token windows: each family's plane, each account's windows — ring, reset, observed ──────┤
  //
  // EVERY FIGURE HAS ITS SOURCE ON SCREEN: LAIN-observed tokens (receipts), provider-reported windows (the
  // provider's own %), and nothing in between. An estimate is labelled "Estimated" with its confidence.
  var breakTab = 'cache';
  function hueAt(i) { return ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'][i % 6]; }
  function planeOf(icon, title, sub, cls, actions) {
    var p = L.kit.plane({ cls: 'uplane' + (cls ? ' ' + cls : '') });
    p.appendChild(L.kit.planeHead(icon, title, sub, actions));
    return p;
  }
  function shareSegments(groups, max) {
    var rows = (groups || []).filter(function (g) { return (g.input || 0) + (g.output || 0) > 0; });
    var top = rows.slice(0, max).map(function (g, i) { return { key: g.key, label: g.key === '(none)' || g.key === 'unknown' ? 'Unattributed' : (L.fmt && L.fmt.model && /\//.test(g.key) ? L.fmt.model(g.key) : g.key), value: (g.input || 0) + (g.output || 0), color: hueAt(i) }; });
    var rest = rows.slice(max).reduce(function (a, g) { return a + (g.input || 0) + (g.output || 0); }, 0);
    if (rest > 0) top.push({ key: '', label: 'Other', value: rest, color: 'var(--text-muted)' });
    return top;
  }
  function overallPlane(t) {
    var p = planeOf('layers', 'Overall usage', 'LAIN-observed usage across every provider and model — ' + RANGE_WORD[range] + '.', 'u-over');
    var tok = (t.input || 0) + (t.output || 0);
    var body = el('div', 'uo-body');
    var segs = [{ key: 'input', label: 'Input', value: t.input || 0, color: 'var(--chart-2)' }, { key: 'output', label: 'Output', value: t.output || 0, color: 'var(--chart-1)' }];
    var dn = L.kit.donut(segs, { size: 168, stroke: 18, label: L.kit.fmtNum(tok), sub: 'tokens', legend: false });
    var left = el('div', 'uo-donut'); left.appendChild(dn);
    var lg = L.kit.legend(segs); lg.classList.add('uo-leg'); left.appendChild(lg);
    body.appendChild(left);
    var stats = el('div', 'uo-stats');
    var hit = data.efficiency && data.efficiency.provider ? data.efficiency.provider.hitRatio : null;
    stats.appendChild(L.kit.stat('database', 'Tokens observed', L.kit.fmtNum(tok), 'input + output'));
    stats.appendChild(L.kit.stat('activity', 'Requests', L.kit.fmtNum(t.requests), t.failed ? t.failed + ' failed' : ''));
    stats.appendChild(L.kit.stat('bolt', 'Cache read', t.reported.cache ? L.kit.fmtNum(t.cacheRead) : '—', t.reported.cache ? 'tokens served from cache' : 'not reported', 'sec'));
    stats.appendChild(L.kit.stat('percent', 'Cache reuse', hit != null ? Math.round(hit * 100) + '%' : '—', hit != null ? 'of eligible input' : 'not reported', 'sec'));
    stats.appendChild(L.kit.stat('brain', 'Reasoning', t.reported.reasoning ? L.kit.fmtNum(t.reasoning) : '—', t.reported.reasoning ? 'part of output' : 'not reported'));
    var nr = nextReset();
    stats.appendChild(L.kit.stat('clock', 'Next reset', nr ? nr.text : '—', nr ? nr.label : 'no window reported'));
    body.appendChild(stats);
    p.appendChild(body);
    return p;
  }
  /** The soonest reset among the windows providers reported (a fact, not a forecast). */
  function nextReset() {
    var best = null;
    (wins || []).forEach(function (w) { if (w.resetsAt && w.resetsAt > Date.now() && (!best || w.resetsAt < best.resetsAt)) best = w; });
    if (!best) return null;
    return { text: countdown(best.resetsAt - Date.now()), label: (best.sourceLabel || best.source) + ' · ' + L.kit.winLabel(best.label || best.window) };
  }
  function breakdownPlane(t) {
    var seg = L.kit.segmented([['cache', 'Cache reuse'], ['account', 'Accounts'], ['source', 'Sources']], breakTab, function (id) { breakTab = id; draw(); }, { cls: 'ub-seg' });
    var p = planeOf('pie', 'Usage breakdown', 'Different views of the same receipts.', 'u-break');
    p.appendChild(seg);
    var body = el('div', 'ub-body');
    if (breakTab === 'cache') {
      var e = (data.efficiency && data.efficiency.provider) || {};
      var cached = e.cachedTokens || 0, total = e.totalInput || 0;
      var segs = [{ key: 'hit', label: 'Cache hit (reused)', value: cached, color: 'var(--accent-secondary)' }, { key: 'miss', label: 'Processed input', value: Math.max(0, total - cached), color: 'var(--accent-primary)' }];
      body.appendChild(L.kit.donut(segs, { size: 150, stroke: 16, label: e.hitRatio != null ? Math.round(e.hitRatio * 100) + '%' : '—', sub: e.hitRatio != null ? 'reused' : 'not reported', empty: 'No provider reported cache use in this period.' }));
      p.appendChild(body);
      p.appendChild(el('div', 'ub-note', e.reportedRows
        ? 'The provider served ' + L.kit.fmtNum(cached) + ' input tokens from its cache on ' + e.reportedRows + ' of LAIN’s API requests. Runtime sessions (Codex, Claude Code) are counted under Cache read above; neither is ever turned into quota.'
        : 'No request in this period reported provider caching.'));
      return p;
    }
    var groups = breakTab === 'account' ? (data.groupsBy && data.groupsBy.account) : (data.bySource || []).map(function (x) { return { key: x.key, input: x.input, output: x.output }; });
    var segs2 = shareSegments(groups, 5);
    body.appendChild(L.kit.donut(segs2, { size: 150, stroke: 16, sub: 'tokens', onPick: breakTab === 'account' ? function (s) { if (s.key) { filters.account = s.key; load(); } } : function (s) { if (s.key) { filters.via = s.key; load(); } } }));
    p.appendChild(body);
    p.appendChild(el('div', 'ub-note', breakTab === 'account' ? 'Account instances as LAIN recorded them — never merged by e-mail. Click one to filter.' : 'Where the requests went: an API route, a runtime, a local model or a website session. Click one to filter.'));
    return p;
  }
  function timePlane() {
    var p = planeOf('trend', 'Usage over time', 'LAIN-observed tokens per day.', 'u-time');
    var days = data.daily || [];
    if (!days.length) { p.appendChild(el('div', 'u-note', 'Nothing recorded in this period.')); return p; }
    var pts = days.slice(-45).map(function (d) {
      var dt = new Date(d.key + 'T00:00:00');
      var label = isNaN(dt.getTime()) ? d.key : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return { label: label, parts: [{ value: d.input || 0, color: 'var(--chart-2)' }, { value: d.output || 0, color: 'var(--chart-1)' }] };
    });
    var lg = el('div', 'ut-leg');
    [['Input', 'var(--chart-2)'], ['Output', 'var(--chart-1)']].forEach(function (x) { var s = el('span', ''); var i = el('i', ''); i.style.background = x[1]; s.appendChild(i); s.appendChild(document.createTextNode(x[0])); lg.appendChild(s); });
    p.querySelector('.u-ph').appendChild(lg);
    p.appendChild(L.kit.bars(pts, { height: 150 }));
    return p;
  }
  function sharePlane(dim, title, sub) {
    var p = planeOf(dim === 'model' ? 'spark' : 'box', title, sub, 'u-share');
    var groups = dim === 'model' ? (by === 'model' ? data.groups : data.groupsBy && data.groupsBy.model) : data.groupsBy && data.groupsBy[dim];
    var segs = shareSegments(groups, 5);
    p.appendChild(L.kit.donut(segs, { size: 136, stroke: 15, sub: 'tokens', onPick: function (s) { if (s.key) { filters[dim] = s.key; load(); } } }));
    return p;
  }
  /** WINDOW → what the provider said, and what LAIN saw inside it; an estimate only when the data supports one. */
  function windowTile(w) {
    var rem = w.remainingPercent != null ? Math.round(w.remainingPercent) : (w.usedPercent != null ? Math.round(100 - w.usedPercent) : null);
    var tile = el('div', 'uw-tile');
    tile.setAttribute('data-window', L.kit.winLabel(w.label || w.window));
    var head = el('div', 'uw-h');
    head.appendChild(L.icon(/week|7|10080/i.test(String(w.label || w.window) + (w.durationMins || '')) ? 'calendar' : 'clock', 15));
    var ht = el('div', ''); ht.appendChild(el('b', '', L.kit.winLabel(w.label || w.window) + ' window'));
    var rs = w.expired ? 'reset — updates on the next read' : w.resetsAt ? L.kit.resetText(w.resetsAt) : 'reset not reported';
    ht.appendChild(el('small', '', rs.charAt(0).toUpperCase() + rs.slice(1))); head.appendChild(ht);
    tile.appendChild(head);
    var row = el('div', 'uw-row');
    row.appendChild(L.kit.ring(rem, { size: 58, stroke: 6, color: rem != null ? L.kit.toneColor(rem) : undefined, label: rem != null ? rem + '%' : '—', sub: rem != null ? 'left' : '' }));
    var o = w.observed;
    var kv = el('dl', 'uw-kv');
    var put = function (k, v, cls) { kv.appendChild(el('dt', '', k)); kv.appendChild(el('dd', cls || '', v)); };
    put('Observed', o ? L.kit.fmtNum(o.tokens) + ' tokens' : '—');
    put('Quota used', w.usedPercent != null ? Math.round(w.usedPercent) + '%' : '—');
    put('Remaining', rem != null ? rem + '%' : '—', 'pos');
    row.appendChild(kv);
    tile.appendChild(row);
    // ESTIMATED EFFECTIVE CAPACITY: Core's estimate from observed tokens against the provider's own % movement —
    // shown only as an estimate, with its confidence; "Insufficient data" until there is enough to say anything.
    var cap = w.capacity;
    var ce = el('div', 'uw-cap');
    ce.appendChild(el('span', '', 'Estimated effective capacity'));
    if (cap && cap.tokens) { ce.appendChild(el('b', '', '~' + L.kit.fmtNum(cap.tokens) + ' equivalent tokens')); ce.appendChild(el('em', 'conf-' + String(cap.confidence || 'low').toLowerCase(), cap.confidence || 'Low')); ce.title = cap.basis || ''; }
    else ce.appendChild(el('em', 'conf-none', (cap && cap.confidence) || 'Insufficient data'));
    tile.appendChild(ce);
    return tile;
  }
  function windowsPlane() {
    var p = planeOf('layers', 'Provider token windows', 'Each provider’s own windows, with what LAIN observed inside them. A provider’s % covers all use of the account, in LAIN or not.', 'u-wins', [L.kit.button('Manage providers', 'sm ghost', function () { L.nav.go('model'); }, 'arrow')]);
    if (!wins) { p.appendChild(el('div', 'u-note', winLoading ? 'Reading provider windows…' : 'Not read yet.')); if (!winLoading) loadWindows(); return p; }
    var list = wins.filter(function (w) { return w.category !== 'CREDITS'; });
    if (!list.length) { p.appendChild(el('div', 'u-note', 'No provider has reported a usage window yet — Claude Code reports after its first run through LAIN, a Codex account when it is read. LAIN never invents one.')); return p; }
    var fams = {}; var order = [];
    list.forEach(function (w) {
      var fk = w.family || 'other';
      if (!fams[fk]) { fams[fk] = { accts: {}, order: [] }; order.push(fk); }
      if (!fams[fk].accts[w.source]) { fams[fk].accts[w.source] = { name: w.sourceLabel || w.account || w.source, who: w.account, ws: [] }; fams[fk].order.push(w.source); }
      fams[fk].accts[w.source].ws.push(w);
    });
    var grid = el('div', 'uw-grid');
    order.forEach(function (fk) {
      var F = fams[fk];
      var fam = L.intel && L.intel.findFamily ? L.intel.findFamily(fk) : null;
      F.order.forEach(function (src) {
        var A = F.accts[src];
        var card = el('div', 'uw-card ' + (L.kit.tintOf(fk) || ''));
        card.setAttribute('data-usage-source', src);
        var h = el('div', 'uw-ch');
        var mk = el('span', 'uw-mark'); mk.appendChild(L.kit.mark(fk, 22)); h.appendChild(mk);
        var t = el('div', 'uw-ct');
        t.appendChild(el('b', '', (fam ? fam.label : fk.charAt(0).toUpperCase() + fk.slice(1))));
        var st = el('span', 'uw-st'); st.appendChild(L.kit.dot('ok')); st.appendChild(document.createTextNode(A.name)); t.appendChild(st);
        h.appendChild(t);
        if (updating[src]) h.appendChild(el('span', 'uw-upd', 'Updating…'));
        card.appendChild(h);
        var tiles = el('div', 'uw-tiles');
        A.ws.forEach(function (w) { tiles.appendChild(windowTile(w)); });
        card.appendChild(tiles);
        grid.appendChild(card);
      });
    });
    p.appendChild(grid);
    return p;
  }
  function filterChips(pane) {
    var keys = Object.keys(filters);
    if (!keys.length) return;
    var box = el('div', 'u-chips uf-chips');
    keys.forEach(function (k) {
      var c = el('button', 'u-chip');
      c.setAttribute('aria-pressed', 'true');
      c.appendChild(document.createTextNode(DIM_LABEL[k] + ': ' + short(filters[k], k) + '  ×'));
      c.setAttribute('data-tip', 'Remove this filter');
      c.onclick = function () { delete filters[k]; load(); };
      box.appendChild(c);
    });
    pane.appendChild(box);
  }
  function overview(pane) {
    if (!data) { pane.appendChild(el('div', 'u-empty', loading ? 'Reading LAIN’s receipts…' : 'Not read yet.')); return; }
    var t = data.totals;
    filterChips(pane);
    if (!t.requests) { emptyState(pane); pane.appendChild(windowsPlane()); return; }
    var g1 = el('div', 'ug ug-top'); g1.appendChild(overallPlane(t)); g1.appendChild(breakdownPlane(t)); pane.appendChild(g1);
    var g2 = el('div', 'ug ug-mid'); g2.appendChild(timePlane()); g2.appendChild(sharePlane('provider', 'Usage by provider', 'Tokens across providers. Click to filter.')); g2.appendChild(sharePlane('model', 'Usage by model', 'Which models used the most. Click to filter.')); pane.appendChild(g2);
    pane.appendChild(windowsPlane());
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
    r.appendChild(el('span', '', exp ? '—' : w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent) + '% remaining'));
    var rt = resetText(w);
    var rs = el('div', 'rs' + (rt.exp ? ' exp' : ''), rt.t);
    rs.setAttribute('data-reset', String(w.resetsAt || ''));
    r.appendChild(rs);
    host.appendChild(r);
  }
  function accountCard(grid, a) {
    var c = el('div', 'lcard'); c.setAttribute('data-account', a.id);
    var h = el('h4', ''); h.appendChild(L.kit.mark(a.driver || a.provider, 18)); h.appendChild(document.createTextNode(a.name)); c.appendChild(h);
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
        tr.appendChild(el('td', '', exp ? 'reset (unconfirmed)' : w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent) + '% remaining'));
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

  var redrawLater = null;
  function draw() {
    if (L.nav.tab() !== 'usage') return;
    // A MENU IS OPEN: a redraw would remove the control it is anchored to and close it under the person's hand.
    // The page is redrawn a moment after it closes.
    if (L.popDepth && L.popDepth() > 0) { clearTimeout(redrawLater); redrawLater = setTimeout(draw, 400); return; }
    var host = $('usagePane'); var keep = host.scrollTop; host.textContent = '';
    var page = el('div', 'u-page wide');
    var rs = L.kit.select(({ today: 'Today', '7d': 'Last 7 days', month: 'This month', '30d': 'Last 30 days', all: 'All time' })[range], [['today', 'Today'], ['7d', 'Last 7 days'], ['month', 'This month'], ['30d', 'Last 30 days'], ['all', 'All time']].map(function (x) { return { label: x[1], checked: range === x[0], run: function () { range = x[0]; load(); } }; }), { id: 'usage-range', alignRight: true });
    rs.classList.add('u-range');
    page.appendChild(L.kit.head('Usage analytics', 'Your LAIN-observed usage and each provider’s own windows — two kinds of number, never one.', [rs, L.kit.button(loading ? 'Reading…' : 'Refresh', 'ghost', function () { load(); loadWindows(); }, 'refresh')]));
    page.appendChild(tabsBar());
    var pane = el('div', 'ubody'); page.appendChild(pane); host.appendChild(page);
    if (section === 'windows') windows(pane);
    else if (section === 'tokens') tokens(pane);
    else if (section === 'cost') cost(pane);
    else if (section === 'efficiency') efficiency(pane);
    else if (section === 'limits') limits(pane);
    else overview(pane);
    host.scrollTop = keep;
  }

  L.onBoot(function () {
    L.nav.onShow('usage', function (o) {
      if (o && o.section && /^(windows|overview|tokens|cost|efficiency|limits)$/.test(o.section)) section = o.section;
      var changed = Boolean(o && o.filters && JSON.stringify(o.filters) !== JSON.stringify(filters));
      if (o && o.filters) filters = Object.assign({}, o.filters);
      if ((!data && !loading) || changed) load(); else draw();
    });
  });
  L.usageView = { load: load, show: function (s, f) { section = s || 'overview'; if (f) filters = Object.assign({}, f); L.nav.go('usage', { section: section, filters: f || null }); } };
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
