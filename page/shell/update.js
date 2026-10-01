'use strict';

/**
 * UPDATES AND EXIT (Noema packaging pass §J, §K) — drawn only from Core's state (S.update, S.workbench).
 *
 *   Update           beside Usage, ONLY when an update is available or downloaded; hidden otherwise. The dropdown
 *                    says what is new and offers Download / Restart Noema / Later — and while the Coding Agent
 *                    works, "Restart after current checkpoint" and "Restart after task". Nothing restarts Noema
 *                    without the person choosing it (src/harnessapp/updateroutes.js, src/update/lifecycle.js).
 *   ⏻ Exit Noema     in the rail's footer. The window's X closes the WINDOW (Noema keeps working in the tray);
 *                    Exit ends Noema — after a confirmation when idle, and by the person's choice when the Agent is
 *                    working: keep it running with the window closed, exit at the next checkpoint, or stop and exit.
 */

const CSS = `
.updbtn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px 0 9px;border-radius:var(--radius-md);background:var(--secondary-weak);color:var(--accent-secondary);font-size:var(--fs-small);font-weight:600;white-space:nowrap;flex:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-secondary) 35%,transparent);transition:background var(--t-hover) var(--ease)}
.updbtn[hidden]{display:none}
.updbtn:hover,.updbtn[aria-expanded=true]{background:color-mix(in srgb,var(--accent-secondary) 22%,transparent)}
.updbtn .ud-ic{display:flex}
.updbtn[data-state=available]{background:transparent;color:var(--text-secondary);box-shadow:inset 0 0 0 1px var(--border-subtle)}
.updpop{width:min(380px,calc(100vw - 16px));padding:14px 16px;border-radius:var(--radius-lg)}
.updpop h4{margin:0 0 2px;font-size:var(--fs-body);font-weight:650}
.updpop .up-sub,.choice-list .up-sub{color:var(--text-secondary);font-size:var(--fs-caption);margin:2px 0 8px;font-weight:400}
.updpop ul{margin:6px 0 10px 18px;padding:0;color:var(--text-primary);font-size:var(--fs-small)}
.updpop .up-busy{padding:8px 10px;border-radius:var(--radius-sm);background:var(--surface-raised);font-size:var(--fs-small);margin:8px 0}
.updpop .up-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
@media (max-width: 1180px){.updbtn .ud-t{display:none}.updbtn{padding:0 9px}}
.choice-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.choice-list button{display:block;text-align:left;padding:10px 12px;height:auto;width:100%}
.choice-list button b{display:block;font-size:var(--fs-body)}
`;

function client() {
  /* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template */
  var L = window.LAIN; var S = null;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function agentBusy() { var w = S && S.workbench; return Boolean(w && (w.running || (w.autoRun && w.autoRun.waiting))); }

  /** A choice in Noema's own dialog: resolves with the chosen value, or null for Cancel / Escape. */
  function choose(title, text, options) {
    return new Promise(function (resolve) {
      var back = el('div', 'dlg-back'); var box = el('div', 'dlg'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', title);
      box.appendChild(el('h3', '', title)); if (text) box.appendChild(el('p', '', text));
      var list = el('div', 'choice-list');
      var key;
      var done = function (v) { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      options.forEach(function (o) {
        var b = el('button', 'btn' + (o.primary ? ' primary' : '')); b.setAttribute('data-choice', o.value);
        b.appendChild(el('b', '', o.label)); if (o.note) b.appendChild(el('div', 'up-sub', o.note));
        b.onclick = function () { done(o.value); }; list.appendChild(b);
      });
      box.appendChild(list);
      var acts = el('div', 'dlg-actions'); var c = el('button', 'btn', 'Cancel'); c.setAttribute('data-choice', 'cancel'); c.onclick = function () { done(null); }; acts.appendChild(c); box.appendChild(acts);
      back.appendChild(box); document.body.appendChild(back);
      document.addEventListener('keydown', key, true);
      c.focus();
    });
  }

  /** The button beside Usage — shown only when there is something to act on. */
  function paint(state) {
    S = state;
    var b = document.getElementById('updateBtn'); if (!b) return;
    var u = S && S.update;
    var st = u && ((u.state === 'staged' && u.staged) || (u.state === 'available' && u.available)) ? u.state : null;
    b.hidden = !st;
    if (!st) return;
    b.setAttribute('data-state', st);
    var v = st === 'staged' ? u.staged.version : u.available.version;
    b.querySelector('.ud-t').textContent = st === 'staged' ? 'Update ready' : 'Update';
    var tip = st === 'staged' ? 'Noema ' + v + ' is downloaded — restart to use it' : 'Noema ' + v + ' is available';
    b.setAttribute('aria-label', tip); b.setAttribute('data-tip', tip);
  }

  async function act(path, body) {
    var r = await L.api(path, body || {}).catch(function (e) { return { ok: false, why: e.message }; });
    if (!r || !r.ok) L.toast((r && r.why) || 'not done', true); else if (r.said) L.toast(r.said);
    L.poll();
    return r;
  }

  function draw(p) {
    var u = S && S.update; if (!u) return;
    var staged = u.state === 'staged';
    var info = staged ? (u.staged || {}) : (u.available || {});
    p.appendChild(el('h4', '', 'Noema ' + (info.version || '')));
    p.appendChild(el('div', 'up-sub', staged ? 'Downloaded and verified · ready to restart' : 'Available · you have Noema ' + (u.current || '')));
    var notes = info.summary || (u.available && u.available.summary) || [];
    if (notes.length) { p.appendChild(el('div', 'up-sub', 'What’s new')); var ul = el('ul'); notes.slice(0, 6).forEach(function (n) { ul.appendChild(el('li', '', n)); }); p.appendChild(ul); }
    var link = info.notes || (u.available && u.available.notes);
    if (link && /^https:\/\//.test(link)) { var a = el('a', '', 'Release notes'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; p.appendChild(a); }
    if (u.pendingRestart) p.appendChild(el('div', 'up-busy', 'Restart scheduled ' + (u.pendingRestart === 'task' ? 'after the current task' : 'at the next committed checkpoint') + '.'));
    var acts = el('div', 'up-acts');
    var btn = function (label, cls, run) { var x = el('button', 'btn ' + (cls || ''), label); x.onclick = async function () { x.disabled = true; L.closePop(); await run(); }; acts.appendChild(x); };
    if (!staged) {
      if (u.installed) btn('Download', 'primary', function () { return act('/api/update/download'); });
      else p.appendChild(el('div', 'up-busy', 'This is a development checkout — install the update with the Noema installer.'));
    } else if (agentBusy()) {
      p.appendChild(el('div', 'up-busy', 'The Coding Agent is working. Noema restarts only when you choose — the task continues after the restart from its committed checkpoint.'));
      btn('Restart after current checkpoint', 'primary', function () { return act('/api/update/restart', { when: 'checkpoint' }); });
      btn('Restart after task', '', function () { return act('/api/update/restart', { when: 'task' }); });
    } else btn('Restart Noema', 'primary', function () { return act('/api/update/restart', { when: 'now' }); });
    btn('Later', '', function () { return act('/api/update/later'); });
    p.appendChild(acts);
  }
  function open(anchor) { L.popover(anchor, draw, { cls: 'updpop', toggle: true }); }

  /** EXIT NOEMA — distinct from closing the window. */
  async function exitNoema() {
    L.closePop();
    if (!agentBusy()) {
      if (!(await L.confirm('Exit Noema? Bots and background jobs stop. Closing the window instead keeps Noema running in the tray.', { ok: 'Exit Noema', danger: true }))) return null;
      return act('/api/app/exit', { mode: 'now' });
    }
    var mode = await choose('Exit Noema', 'The Coding Agent is working.', [
      { value: 'close', label: 'Close window and keep task running', note: 'Noema keeps working in the tray — open it again any time.' },
      { value: 'checkpoint', label: 'Exit after current checkpoint', note: 'The task stops at its next committed checkpoint and continues from there next time.', primary: true },
      { value: 'stop', label: 'Stop task and exit', note: 'The task is stopped now and saved — continue it next time.' },
    ]);
    if (!mode) return null;
    if (mode === 'close') { L.hostCall('hide', {}).catch(function () { return null; }); return { ok: true }; }
    return act('/api/app/exit', { mode: mode });
  }

  L.update = { paint: paint, open: open, exit: exitNoema, choose: choose };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
