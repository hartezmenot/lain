'use strict';

/**
 * WHO WROTE THESE LINES — Core's provenance ledger (editledger.js), shown.
 *
 *   in the editor   a thin gutter mark on each region of the file in front:
 *                   you (USER), the Coding Agent (AGENT), the formatter, or a
 *                   change LAIN saw but did not make (EXTERNAL, lines unknown).
 *                   Hovering says who and when. Evidence, never a lock.
 *   on request      "Who changed what": the history, filtered to what you
 *                   changed, what LAIN changed, or everything.
 *
 * Nothing here decides anything: the regions come from POST
 * /api/provenance/file, the history from /api/provenance/summary.
 */

const CSS = `
.prov-user{border-left:3px solid #6fb3ff;margin-left:3px}
.prov-agent{border-left:3px solid #c38bff;margin-left:3px}
.prov-formatter{border-left:3px solid #7d8590;margin-left:3px}
.provdlg{width:min(720px,calc(100vw - 32px))}
.provdlg .pf{display:flex;gap:6px;margin:0 0 10px}
.provdlg .pf button[aria-pressed=true]{background:var(--accent-weak);color:var(--ink);border-color:var(--accent-line)}
.provdlg .plist{max-height:min(420px,56vh);overflow:auto;border:1px solid var(--line);border-radius:var(--radius-s)}
.provdlg .prow{display:grid;grid-template-columns:78px minmax(0,1fr) auto;gap:10px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--line);font-size:12.5px}
.provdlg .prow:last-child{border-bottom:0}
.provdlg .prow .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);text-align:left}
.provdlg .prow .w{font-size:11px;color:var(--faint);white-space:nowrap}
.pbadge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10.5px;font-weight:700;letter-spacing:.06em}
.pbadge.USER{background:#6fb3ff22;color:#6fb3ff}
.pbadge.AGENT{background:#c38bff22;color:#c38bff}
.pbadge.EXTERNAL{background:#e3b34122;color:#e3b341}
.pbadge.FORMATTER,.pbadge.UNKNOWN,.pbadge.BOT,.pbadge.EXTENSION{background:var(--raise);color:var(--dim)}
.provdlg .psum{font-size:12px;color:var(--dim);margin:0 0 8px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var deco = null, lastKey = '', busy = false, stamp = 0;
  var WHO = { USER: 'you', AGENT: 'the Coding Agent', FORMATTER: 'the formatter', EXTERNAL: 'outside LAIN', BOT: 'the BOT', EXTENSION: 'an extension', UNKNOWN: 'unknown' };

  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }

  /** The gutter marks for the file in front. Cheap: only when the file or its hash moves. */
  async function refresh(force) {
    var ed = L.editor && L.editor.editor && L.editor.editor();
    var M = L.editor && L.editor.monaco && L.editor.monaco();
    var f = L.source && L.source.current && L.source.current();
    if (!ed || !M || !f || f.kind !== 'text') return;
    var key = f.path + '|' + f.hash;
    if (!force && (key === lastKey || busy)) return;
    lastKey = key;
    busy = true;
    var mine = ++stamp;
    var r;
    try { r = await L.api('/api/provenance/file', { path: f.path }); } catch (e) { r = null; }
    busy = false;
    if (mine !== stamp || !r || !r.ok) return;
    var cur = L.source.current();
    if (!cur || cur.path !== f.path) return;
    var items = (r.regions || []).filter(function (g) { return g.source === 'USER' || g.source === 'AGENT' || g.source === 'FORMATTER'; }).map(function (g) {
      return {
        range: new M.Range(g.startLine, 1, Math.max(g.startLine, g.endLine), 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'prov-' + g.source.toLowerCase(),
          hoverMessage: { value: 'Written by ' + WHO[g.source] + ', ' + ago(g.at) + (g.taskId ? ' (task ' + g.taskId + ')' : '') + (r.approximate ? ' — the file also changed outside LAIN since, so these lines are approximate' : '') },
        },
      };
    });
    if (deco) deco.clear();
    deco = ed.createDecorationsCollection ? ed.createDecorationsCollection(items) : null;
  }

  /** "Who changed what" — the ledger's history for this project. */
  function history(filter) {
    var want = filter || 'all';
    var back = el('div', 'dlg-back');
    var box = el('div', 'dlg provdlg');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Who changed what');
    box.appendChild(el('h3', '', 'Who changed what'));
    var pf = el('div', 'pf');
    var sum = el('p', 'psum', 'Reading…');
    var list = el('div', 'plist');
    var close = function () { back.remove(); document.removeEventListener('keydown', key, true); };
    var key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    var load = async function () {
      Array.prototype.forEach.call(pf.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.f === want)); });
      var body = want === 'all' ? {} : { source: want };
      var r = await L.api('/api/provenance/summary', body);
      list.textContent = '';
      if (!r.ok) { sum.textContent = r.why || 'no project'; return; }
      var c = r.counts || {};
      sum.textContent = Object.keys(c).length ? Object.keys(c).map(function (k) { return (WHO[k] || k) + ': ' + c[k]; }).join(' · ') : 'Nothing recorded yet. LAIN records who changed a file from the moment it sees the change; older history is in git, without who.';
      (r.rows || []).forEach(function (row) {
        var d = el('div', 'prow');
        var b = el('span', 'pbadge ' + row.source, row.source);
        d.appendChild(b);
        var p = el('button', 'p', row.path + (row.first ? ':' + row.first : ''));
        p.title = 'Open ' + row.path;
        p.onclick = function () { close(); L.house.run('ide.open_file', { path: row.path, line: row.first }); };
        d.appendChild(p);
        d.appendChild(el('span', 'w', (row.linesUnknown ? 'lines unknown' : '+' + (row.added || 0) + ' −' + (row.removed || 0)) + ' · ' + ago(row.at)));
        list.appendChild(d);
      });
    };
    [['all', 'Everything'], ['USER', 'What I changed'], ['LAIN', 'What LAIN changed'], ['EXTERNAL', 'Outside LAIN']].forEach(function (x) {
      var b = el('button', 'btn small', x[1]);
      b.dataset.f = x[0];
      b.onclick = function () { want = x[0]; load(); };
      pf.appendChild(b);
    });
    box.appendChild(pf);
    box.appendChild(sum);
    box.appendChild(list);
    var acts = el('div', 'dlg-actions');
    var ok = el('button', 'btn primary', 'Close');
    ok.onclick = close;
    acts.appendChild(ok);
    box.appendChild(acts);
    back.appendChild(box);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    document.addEventListener('keydown', key, true);
    load();
    setTimeout(function () { ok.focus(); }, 0);
  }

  L.prov = { refresh: refresh, history: history };
  L.onRender(function () { if (L.nav.tab() === 'ide') refresh(false); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
