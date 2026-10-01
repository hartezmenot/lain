'use strict';

/**
 * SETTINGS › STORAGE › CLEAR CACHE & TEMPORARY FILES — the drawing half of Core's cachecare.js (Gate 3 §77–80).
 *
 *   ┌ Clear cache & temporary files ─────────────────────────── Refresh ┐
 *   │ Browser caches              297 MB   the window, Preview, …       │
 *   │ Temporary & test files      7.9 GB   LAIN's own temp leftovers    │
 *   │ …                                                                  │
 *   │ [ Clear safe cache · 12.4 GB ]   Advanced…                         │
 *   │ Never cleared: sessions · accounts · settings · project files …   │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Core measures and clears, as jobs; this card starts them and polls their state. Advanced categories are
 * checkboxes behind "Advanced…", each with what it costs, and a confirmation that names them.
 */

const CSS = `
.cc-card{margin-top:28px;background:var(--surface-base);border-radius:var(--radius-lg);padding:18px 20px 16px;box-shadow:inset 0 0 0 1px var(--border-subtle)}
.cc-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.cc-head .cc-title{margin:0;font:600 var(--fs-lead)/1.3 var(--sans);color:var(--text-primary);letter-spacing:0;text-transform:none}
.cc-head .fbtn{margin-left:auto}
.cc-sub{color:var(--text-secondary);font-size:var(--fs-small);margin:0 0 12px}
.cc-rows{display:flex;flex-direction:column}
.cc-row{display:grid;grid-template-columns:22px minmax(0,1.1fr) 90px minmax(0,2fr);gap:12px;align-items:center;padding:9px 4px;border-top:1px solid var(--separator);font-size:var(--fs-small)}
.cc-row:first-child{border-top:0}
.cc-row b{font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row .sz{font-variant-numeric:tabular-nums;text-align:right;color:var(--text-primary)}
.cc-row .sz.zero{color:var(--text-muted)}
.cc-row .nt{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row .ck{display:flex;justify-content:center;color:var(--text-muted)}
.cc-row .ck input{accent-color:var(--accent-primary)}
.cc-acts{display:flex;align-items:center;gap:10px;margin:14px 0 4px;flex-wrap:wrap}
.cc-adv-h{font-size:var(--fs-caption);font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin:16px 0 4px}
.cc-never{margin-top:12px;color:var(--text-muted);font-size:var(--fs-caption);line-height:1.5}
.cc-done{margin-top:10px;font-size:var(--fs-small);color:var(--positive)}
.cc-done.warn{color:var(--warning)}
.cc-busy{color:var(--text-secondary);font-size:var(--fs-small)}
@media (max-width: 760px){.cc-row{grid-template-columns:22px minmax(0,1fr) 80px}.cc-row .nt{display:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var st = { state: null, timer: null, adv: false, pick: {} };
  var card = null;

  function fmt(n) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0; var v = Number(n) || 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }
  function cats() {
    var s = st.state && st.state.inspect;
    if (!s) return null;
    return s.result ? s.result.categories : (s.partial && s.partial.length ? s.partial : null);
  }
  function running() { var s = st.state; return Boolean(s && ((s.inspect && s.inspect.running) || (s.clear && s.clear.running))); }
  function poll() {
    clearTimeout(st.timer);
    st.timer = setTimeout(function () {
      L.api('/api/cache/state', {}).then(function (r) {
        if (r && r.ok) { st.state = r; paint(); }
        if (running() && card && document.body.contains(card)) poll();
      }, function () { /* the next open reads again */ });
    }, 1200);
  }
  function start(route, body) {
    return L.api(route, body || {}).then(function (r) {
      if (r && r.ok) { st.state = r; paint(); if (running()) poll(); }
      else if (r && r.why) L.toast(r.why, true);
      return r;
    });
  }

  function row(c, withBox) {
    var r = el('div', 'cc-row'); r.setAttribute('data-cache', c.id);
    var ck = el('span', 'ck');
    if (withBox) {
      var i = document.createElement('input'); i.type = 'checkbox'; i.checked = Boolean(st.pick[c.id]); i.disabled = !c.items;
      i.setAttribute('aria-label', 'Clear ' + c.label);
      i.onchange = function () { st.pick[c.id] = i.checked; paint(); };
      ck.appendChild(i);
    } else ck.appendChild(L.icon(c.items ? 'check' : 'dot', 12));
    r.appendChild(ck);
    r.appendChild(el('b', '', c.label));
    r.appendChild(el('span', 'sz' + (c.bytes ? '' : ' zero'), c.items ? fmt(c.bytes) : '—'));
    var nt = el('span', 'nt', c.note || ''); nt.title = c.note || ''; r.appendChild(nt);
    return r;
  }

  function paint() {
    if (!card) return;
    card.textContent = '';
    var head = el('div', 'cc-head');
    head.appendChild(L.icon('trash', 18));
    head.appendChild(el('div', 'cc-title', 'Clear cache & temporary files'));
    var rf = el('button', 'fbtn ghost small', running() && st.state.inspect.running ? 'Measuring…' : 'Refresh');
    rf.disabled = running();
    rf.onclick = function () { start('/api/cache/inspect', { refresh: true }); };
    head.appendChild(rf);
    card.appendChild(head);
    card.appendChild(el('p', 'cc-sub', 'What Noema can rebuild or no longer needs. Your sessions, accounts, settings and project files are never part of it.'));
    var list = cats();
    if (!list) { card.appendChild(el('div', 'cc-busy', 'Measuring…')); return; }
    var safe = list.filter(function (c) { return c.tier === 'safe'; });
    var adv = list.filter(function (c) { return c.tier === 'advanced'; });
    var rows = el('div', 'cc-rows');
    safe.forEach(function (c) { rows.appendChild(row(c, false)); });
    card.appendChild(rows);
    var total = safe.reduce(function (a, c) { return a + (c.bytes || 0); }, 0);
    var acts = el('div', 'cc-acts');
    var busyClear = st.state.clear && st.state.clear.running;
    var go = el('button', 'fbtn primary', busyClear ? 'Clearing…' : 'Clear safe cache' + (total ? ' · ' + fmt(total) : ''));
    go.setAttribute('data-cache-act', 'safe');
    go.disabled = running() || !total;
    go.onclick = function () { start('/api/cache/clear', {}); };
    acts.appendChild(go);
    var more = el('button', 'fbtn ghost', st.adv ? 'Hide advanced' : 'Advanced…');
    more.setAttribute('data-cache-act', 'advanced');
    more.onclick = function () { st.adv = !st.adv; paint(); };
    acts.appendChild(more);
    if (st.state.inspect && st.state.inspect.running) acts.appendChild(el('span', 'cc-busy', 'Measuring…'));
    card.appendChild(acts);
    if (st.adv && adv.length) {
      card.appendChild(el('div', 'cc-adv-h', 'Advanced — not cache; each has a cost'));
      var ar = el('div', 'cc-rows');
      adv.forEach(function (c) { ar.appendChild(row(c, true)); });
      card.appendChild(ar);
      var chosen = adv.filter(function (c) { return st.pick[c.id] && c.items; });
      var aa = el('div', 'cc-acts');
      var cb = el('button', 'fbtn danger', 'Clear selected' + (chosen.length ? ' · ' + fmt(chosen.reduce(function (a, c) { return a + c.bytes; }, 0)) : ''));
      cb.setAttribute('data-cache-act', 'clear-advanced');
      cb.disabled = running() || !chosen.length;
      cb.onclick = function () {
        L.confirm('Clear ' + chosen.map(function (c) { return c.label.toLowerCase(); }).join(', ') + '?\n\n' + chosen.map(function (c) { return '• ' + c.label + ': ' + c.note; }).join('\n'), { ok: 'Clear', danger: true }).then(function (yes) {
          if (!yes) return;
          start('/api/cache/clear', { ids: chosen.map(function (c) { return c.id; }), confirmAdvanced: true }).then(function () { st.pick = {}; });
        });
      };
      aa.appendChild(cb);
      card.appendChild(aa);
    }
    var done = st.state.clear && st.state.clear.result;
    if (done) {
      var left = done.skipped ? ' · ' + done.skipped + ' left because they are in use' : '';
      card.appendChild(el('div', 'cc-done' + (done.skipped ? ' warn' : ''), 'Freed ' + fmt(done.freed) + ' — ' + done.removed + ' removed' + left + '.'));
    }
    if (st.state.clear && st.state.clear.error) card.appendChild(el('div', 'cc-done warn', st.state.clear.error));
    var nv = st.state.inspect && st.state.inspect.result ? st.state.inspect.result.never : null;
    if (nv) card.appendChild(el('div', 'cc-never', 'Never cleared: ' + nv.join(' · ') + '.'));
  }

  /** Settings › Storage draws this below its folders. */
  function draw(pane) {
    card = el('div', 'cc-card'); card.id = 'cacheCard';
    pane.appendChild(card);
    paint();
    start('/api/cache/inspect', {});
  }

  L.cacheCare = { draw: draw };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
