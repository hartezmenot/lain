'use strict';

/**
 * THE USAGE TRACKER — the ring at the top right of every surface, and its dropdown.
 *
 *   ◔ 74% left ▾        the ring: what REMAINS of the active route's tightest window
 *                       the provider reported — or an empty ring and "Usage" when
 *                       nothing was reported. Never a number LAIN made up.
 *
 *   ┌ OVERALL ─────────────────────────── This month ▾ ┐   LAIN-OBSERVED: its own
 *   │ (donut: models)   Tokens observed   1.24M         │   receipts, whatever the
 *   │                   Requests            312         │   provider. Nothing here is
 *   │                   Cache reuse         31%         │   a quota.
 *   ├ ACTIVE ROUTE ──────────────────── Coding Agent ──┤   THE PROVIDER'S windows for
 *   │ Codex · Personal · GPT-6 Sol                      │   the route in front, each
 *   │ ◔ 5-hour  74% remaining · resets in 2h 13m        │   with what LAIN observed
 *   │           142K observed this window               │   inside it.
 *   ├───────────────────────────────────────────────────┤
 *   │              View full usage →                    │
 *   └───────────────────────────────────────────────────┘
 *
 * THE TWO HALVES ARE NEVER COMBINED: unrelated providers' windows do not add up to
 * anything, so there is no "overall quota". Reads are local (receipts, cached
 * telemetry) and happen when the dropdown opens — nothing polls a provider.
 */

const CSS = `
.tracker{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 10px 0 8px;border-radius:var(--radius-md);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--border-subtle);color:var(--text-primary);font-size:var(--fs-small);font-weight:500;white-space:nowrap;flex:none;transition:box-shadow var(--t-hover) var(--ease),background var(--t-hover) var(--ease)}
.tracker:hover,.tracker[aria-expanded=true]{box-shadow:inset 0 0 0 1px var(--accent-border);background:var(--surface-raised)}
.tracker .trk-ring{display:flex}
.tracker .trk-t{font-variant-numeric:tabular-nums}
.tracker .trk-x{color:var(--text-secondary);font-variant-numeric:tabular-nums}
.tracker .trk-x:empty{display:none}
.tracker .trk-car{color:var(--text-muted);display:flex}
.tracker.need .trk-t{color:var(--text-secondary)}
.tracker.warn .trk-t{color:var(--warning)} .tracker.bad .trk-t{color:var(--danger)}
#app:not([data-tab=ide]) .tracker .trk-x{display:none}

.tkpop{width:min(400px,calc(100vw - 16px));padding:0;border-radius:var(--radius-lg);animation:lain-drop var(--t-drop) var(--ease)}
.tkpop .tk-sec{padding:14px 16px}
.tkpop .tk-sec + .tk-sec{border-top:1px solid var(--separator)}
.tkpop .tk-h{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.tkpop .tk-h b{font-size:var(--fs-caption);font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text-secondary)}
.tkpop .tk-h .u-in{margin-left:auto;padding:3px 8px;font-size:var(--fs-caption);color:var(--text-secondary)}
.tkpop .tk-h small{margin-left:auto;font-size:var(--fs-caption);color:var(--text-muted)}
.tkpop .tk-over{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;align-items:center}
.tkpop .tk-facts{display:flex;flex-direction:column;gap:8px;min-width:0}
.tkpop .tk-f{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:var(--fs-small);color:var(--text-secondary)}
.tkpop .tk-f b{font:600 var(--fs-lead)/1.2 var(--display);color:var(--text-primary);font-variant-numeric:tabular-nums}
.tkpop .tk-f b.pos{color:var(--positive)}
.tkpop .tk-f b.none{font:400 var(--fs-small)/1.2 var(--sans);color:var(--text-muted)}
.tkpop .tk-leg{margin-top:12px}
.tkpop .tk-route{font-size:var(--fs-body);font-weight:600;color:var(--text-primary);margin:-4px 0 2px}
.tkpop .tk-route.need{color:var(--warning)}
.tkpop .tk-acct{font-size:var(--fs-small);color:var(--text-secondary);margin-bottom:10px}
.tkpop .tk-win{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;align-items:center;padding:8px 0}
.tkpop .tk-win + .tk-win{border-top:1px solid color-mix(in srgb,var(--separator) 70%,transparent)}
.tkpop .tk-win .wl{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.tkpop .tk-win .wl b{font-size:var(--fs-body);font-weight:600;color:var(--text-primary)}
.tkpop .tk-win .wl span{font-size:var(--fs-small);color:var(--text-primary);font-variant-numeric:tabular-nums}
.tkpop .tk-win .wl span.warn{color:var(--warning)} .tkpop .tk-win .wl span.bad{color:var(--danger)}
.tkpop .tk-win .wm{font-size:var(--fs-caption);color:var(--text-muted);font-variant-numeric:tabular-nums}
.tkpop .tk-win .wm.cap{color:var(--text-secondary);margin-top:2px}
.tkpop .tk-none{font-size:var(--fs-small);color:var(--text-secondary);line-height:1.5}
.tkpop .tk-foot{padding:12px 16px 14px}
.tkpop .tk-foot .u-btn{width:100%;padding:9px 12px}
.tkpop .tk-load{font-size:var(--fs-small);color:var(--text-muted)}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var RANGES = [['today', 'Today'], ['7d', 'Last 7 days'], ['month', 'This month'], ['30d', 'Last 30 days']];
  var range = 'month';
  try { var saved = localStorage.getItem('lain.tracker.range'); if (saved && RANGES.some(function (r) { return r[0] === saved; })) range = saved; } catch (e) { /* per viewer */ }
  var drop = null;         // the last /api/usage/tracker answer (Core's: overall + the lane's windows)
  var dropAt = 0;

  // ---- WHAT THE PILL SAYS: Core's ring for the lane in front (S.tracker, usagetracker.js) ----------------------------
  var lastSig = '';
  function laneNow() { return L.intel ? L.intel.laneNow() : 'coding'; }
  function paint(S) {
    var b = $('tracker');
    if (!b) return;
    var lane = laneNow();
    var v = S && S.tracker ? S.tracker[lane] : null;
    var ring = v && v.ring;
    var tokens = drop && drop.overall ? drop.overall.tokens : null;
    var sig = JSON.stringify([lane, v && v.route, ring, v && v.account, tokens, range]);
    if (sig === lastSig) return;
    lastSig = sig;
    b.className = 'tracker' + (!ring ? ' need' : ring.tone === 'bad' ? ' bad' : ring.tone === 'warn' ? ' warn' : '');
    var rb = $('trackerRing');
    rb.textContent = '';
    rb.appendChild(L.kit.ring(ring ? ring.remainingPercent : null, { size: 20, stroke: 3, color: ring ? L.kit.toneColor(ring.remainingPercent) : undefined, label: '' }));
    $('trackerText').textContent = ring ? ring.remainingPercent + '% left' : 'Usage';
    $('trackerExtra').textContent = tokens != null ? '· ' + L.kit.fmtNum(tokens) + ' ' + rangeWord(range) : '';
    var who = v && v.route.resolved ? (v.route.text + (v.account ? ' · ' + v.account.name : '')) : 'No route chosen';
    b.setAttribute('data-tip', ring ? who + ' — ' + L.kit.winLabel(ring.label) + ' ' + ring.remainingPercent + '% remaining' : who + ' — ' + ((v && v.note) || 'the provider has not reported quota'));
    b.setAttribute('aria-label', 'Usage' + (ring ? ', ' + ring.remainingPercent + ' percent left' : ''));
  }
  function rangeWord(r) { return r === 'today' ? 'today' : r === 'month' ? 'this month' : r === '7d' ? 'in 7 days' : 'in 30 days'; }

  // ---- THE ONE READ: Core's dropdown numbers (local receipts and cached telemetry — no provider is polled) -------------
  function load(force) {
    if (!force && drop && Date.now() - dropAt < 60000 && drop.lane && drop.lane.lane === laneNow()) return Promise.resolve(drop);
    return L.api('/api/usage/tracker', { range: range, lane: laneNow() }).then(function (r) {
      if (r && r.ok) { drop = r; dropAt = Date.now(); lastSig = ''; paint(L.state() || {}); }
      return drop;
    }, function () { return drop; });
  }

  // ---- THE DROPDOWN -------------------------------------------------------------------------------------------------
  function sectionHead(title, right) {
    var h = el('div', 'tk-h');
    h.appendChild(el('b', '', title));
    if (right) h.appendChild(right);
    return h;
  }
  function overallSection() {
    var sec = el('div', 'tk-sec');
    sec.setAttribute('data-part', 'overall');
    var pick = L.kit.select(RANGES.filter(function (r) { return r[0] === range; })[0][1], RANGES.map(function (r) {
      return { label: r[1], checked: r[0] === range, run: function () { range = r[0]; try { localStorage.setItem('lain.tracker.range', range); } catch (e) { /* per viewer */ } drop = null; open(true); } };
    }), { id: 'tracker-range', alignRight: true });
    sec.appendChild(sectionHead('Overall', pick));
    var o = drop && drop.overall;
    if (!o) { sec.appendChild(el('div', 'tk-load', 'Reading LAIN’s receipts…')); return sec; }
    var colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-6)'];
    var top = (o.models || []).map(function (m, i) { return { key: m.key, label: m.label || m.key, value: m.tokens, color: m.key === 'other' ? 'var(--chart-6)' : colors[i] }; });
    var row = el('div', 'tk-over');
    row.appendChild(L.kit.donut(top, { size: 96, stroke: 11, label: L.kit.fmtNum(o.tokens), sub: 'tokens', legend: false }));
    var facts = el('div', 'tk-facts');
    var fact = function (k, v, cls) { var f = el('div', 'tk-f'); f.appendChild(el('span', '', k)); f.appendChild(el('b', cls || '', v)); return f; };
    facts.appendChild(fact('Tokens observed', L.kit.fmtNum(o.tokens)));
    facts.appendChild(fact('Requests', L.kit.fmtNum(o.requests || 0)));
    facts.appendChild(o.cacheReuse != null ? fact('Cache reuse', Math.round(o.cacheReuse * 100) + '%', 'pos') : o.cacheRead != null ? fact('Cache read', L.kit.fmtNum(o.cacheRead), 'pos') : fact('Cache reuse', 'Not reported', 'none'));
    row.appendChild(facts);
    sec.appendChild(row);
    if (top.length) {
      // THE MODELS, clickable: Usage opens filtered to the one chosen.
      var lg = L.kit.legend(top, { onPick: function (m) { L.closePop(); L.nav.go('usage', { section: 'overview', filters: m.key === 'other' ? {} : { model: m.key } }); } });
      lg.classList.add('tk-leg');
      sec.appendChild(lg);
    } else sec.appendChild(el('div', 'tk-none', 'Nothing recorded ' + rangeWord(range) + ' yet.'));
    return sec;
  }
  function routeSection(S) {
    var lane = laneNow();
    // CORE'S VIEW OF THE LANE — the dropdown's (with observed tokens) when it is fresh, else the snapshot's ring view.
    var v = drop && drop.lane && drop.lane.lane === lane ? drop.lane : (S.tracker ? S.tracker[lane] : null);
    var sec = el('div', 'tk-sec');
    sec.setAttribute('data-part', 'route');
    sec.appendChild(sectionHead('Active route', el('small', '', lane === 'chat' ? 'Chat' : 'Coding Agent')));
    if (!v) { sec.appendChild(el('div', 'tk-load', 'Reading…')); return sec; }
    sec.appendChild(el('div', 'tk-route' + (v.route.resolved ? '' : ' need'), v.route.text));
    if (!v.route.resolved) { if (v.route.problem) sec.appendChild(el('div', 'tk-none', v.route.problem)); return sec; }
    if (v.account) sec.appendChild(el('div', 'tk-acct', 'Account · ' + v.account.name + (v.route.policy ? ' · ' + v.route.policy : '')));
    if (!v.windows.length) { sec.appendChild(el('div', 'tk-none', (v.note || 'This provider has not reported quota for this account yet') + '. LAIN does not estimate it.')); return sec; }
    v.windows.forEach(function (w) {
      var box = el('div', 'tk-win');
      box.setAttribute('data-window', L.kit.winLabel(w.label));
      box.appendChild(L.kit.ring(w.remainingPercent, { size: 34, stroke: 4, color: L.kit.toneColor(w.remainingPercent), label: '' }));
      var t = el('div', '');
      var wl = el('div', 'wl');
      wl.appendChild(el('b', '', L.kit.winLabel(w.label)));
      wl.appendChild(el('span', w.tone === 'ok' ? '' : w.tone, w.remainingPercent + '% remaining'));
      t.appendChild(wl);
      var rs = w.expired ? 'reset — updates on the next read' : L.kit.resetText(w.resetsAt);
      t.appendChild(el('div', 'wm', [rs, w.observedTokens != null ? L.kit.fmtNum(w.observedTokens) + ' observed this window' : ''].filter(Boolean).join(' · ')));
      // CORE'S ESTIMATE, only when it has one — labelled as such, with its confidence.
      if (w.capacity && w.capacity.tokens) {
        var ce = el('div', 'wm cap', 'Est. capacity ~' + L.kit.fmtNum(w.capacity.tokens) + ' equivalent tokens · ' + w.capacity.confidence);
        ce.setAttribute('data-tip', w.capacity.basis || '');
        t.appendChild(ce);
      }
      box.appendChild(t);
      sec.appendChild(box);
    });
    return sec;
  }
  function draw(p) {
    var S = L.state() || {};
    p.appendChild(overallSection());
    p.appendChild(routeSection(S));
    var foot = el('div', 'tk-foot');
    foot.appendChild(L.kit.button('View full usage', 'pri', function () { L.closePop(); L.nav.go('usage'); }, 'arrow'));
    // THE ARROW GOES AFTER THE WORDS.
    var btn = foot.firstChild; btn.appendChild(btn.firstChild);
    p.appendChild(foot);
  }
  function open(refresh) {
    var anchor = $('tracker');
    var shown = L.popover(anchor, function (p) { draw(p); }, { cls: 'tkpop', toggle: !refresh, alignRight: true, refresh: true });
    if (!shown) return;
    load(true).then(function () { if (anchor.getAttribute('aria-expanded') === 'true') L.popRefresh(); });
  }

  L.tracker = { paint: paint, open: function () { open(false); }, refresh: function () { return load(true); } };

  L.onBoot(function () {
    $('trackerCar').appendChild(L.icon('down', 14));
    $('tracker').onclick = function (e) { e.stopPropagation(); open(false); };
    // THE PILL'S TOKEN FIGURE: once shortly after start, then with each finished turn (never on a timer).
    setTimeout(function () { load(true); }, 2500);
  });
  var lastRun = '';
  L.onRender(function (S) {
    paint(S);
    var st = S.header && S.header.status ? S.header.status.state : '';
    if (lastRun === 'RUNNING' && st !== 'RUNNING') setTimeout(function () { load(true); }, 1500);
    lastRun = st;
  });
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
