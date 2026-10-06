'use strict';

/**
 * COMPUTER CONTROL IN THE HARNESS (Phase CU) — drawn only from Core's state (S.computer, computercontrol.js view).
 *
 *   the chip     beside Usage: "Computer" (quiet) while off; "● Computer · Minecraft" (warning) while on — never
 *                hidden while LAIN can use the desktop. "paused (you)" when your input won, "paused (focus)" when the
 *                target left the front.
 *   the popover  Enable (Observe · Interact · Full), the target window (sensitive ones are listed and not offered),
 *                raw input for games, Turn off, and STOP — which interrupts a turn in flight and fires the kill switch.
 *                Ctrl+Alt+Pause does the same from anywhere.
 *
 * The desktop's authorization question is Core's (computermcp.authorize) and is asked on this machine.
 */

const CSS = `
.cubtn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px 0 9px;border-radius:var(--radius-md);background:transparent;color:var(--text-secondary);font-size:var(--fs-small);font-weight:600;white-space:nowrap;flex:none;box-shadow:inset 0 0 0 1px var(--border-subtle)}
.cubtn[data-on=true]{background:var(--warning-weak);color:var(--warning);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 45%,transparent)}
.cubtn[data-on=true] .cu-dot{width:8px;height:8px;border-radius:50%;background:var(--warning);animation:cuPulse 1.6s ease-in-out infinite}
.cubtn[data-killed=true]{color:var(--danger)}
@keyframes cuPulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (max-width: 1180px){.cubtn .cu-t{max-width:120px;overflow:hidden;text-overflow:ellipsis}}
.cupop{width:min(420px,calc(100vw - 16px));padding:14px 16px;border-radius:var(--radius-lg)}
.cupop h4{margin:0 0 2px;font-size:var(--fs-body);font-weight:650}
.cupop .cu-sub{color:var(--text-secondary);font-size:var(--fs-caption);margin:2px 0 10px}
.cupop .cu-tiers{display:flex;gap:6px;margin:6px 0 10px}
.cupop .cu-tiers button[aria-pressed=true]{background:var(--accent-weak);color:var(--accent-primary)}
.cupop .cu-wins{max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:2px;margin:6px 0}
.cupop .cu-wins button{text-align:left;padding:6px 8px;border-radius:var(--radius-sm);font-size:var(--fs-small);display:flex;gap:8px}
.cupop .cu-wins button small{color:var(--text-muted)}
.cupop .cu-wins button[disabled]{opacity:.5}
.cupop .cu-wins button[aria-current=true]{background:var(--accent-weak)}
.cupop .cu-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cupop label{display:flex;gap:6px;align-items:center;font-size:var(--fs-small);color:var(--text-secondary)}
`;

function client() {
  /* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template */
  var L = window.LAIN; var S = null; var tierWanted = 'INTERACT'; var raw = false; var wins = null;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }

  function paint(state) {
    S = state;
    var b = document.getElementById('cuBtn'); if (!b) return;
    var c = (S && S.computer) || {};
    b.setAttribute('data-on', String(Boolean(c.on)));
    b.setAttribute('data-killed', String(Boolean(c.killed)));
    b.querySelector('.cu-t').textContent = c.on ? String(c.label || '● Computer').replace(/^●\s*/, '') : c.killed ? 'Computer stopped' : 'Computer';
    var tip = c.on ? c.label + ' — ' + c.tier + ' · kill switch ' + c.killSwitch : 'Computer Control is off — LAIN cannot see or use this desktop';
    b.setAttribute('data-tip', tip); b.setAttribute('aria-label', tip);
  }

  async function act(path, body) {
    var r = await L.api(path, body || {}).catch(function (e) { return { ok: false, why: e.message }; });
    if (!r || !r.ok) L.toast((r && r.why) || 'not done', true);
    L.poll();
    return r;
  }

  async function loadWindows(p) {
    var r = await L.api('/api/computer/windows', {}).catch(function () { return null; });
    wins = r && r.ok ? r.windows : [];
    L.closePop(); open(document.getElementById('cuBtn'));
    void p;
  }

  function draw(p) {
    var c = (S && S.computer) || {};
    p.appendChild(el('h4', '', 'Computer Control'));
    if (!c.on) {
      p.appendChild(el('div', 'cu-sub', c.killed ? 'Stopped by the kill switch. Turn it on again when you want LAIN to use this desktop.' : 'Off. LAIN cannot see or use this desktop in this session until you turn it on. Separate from the Preview.'));
      var tiers = el('div', 'cu-tiers');
      [['OBSERVE', 'Observe'], ['INTERACT', 'Interact'], ['FULL', 'Full']].forEach(function (t) { var x = el('button', 'btn', t[1]); x.setAttribute('aria-pressed', String(tierWanted === t[0])); x.setAttribute('data-cutier', t[0]); x.onclick = function () { tierWanted = t[0]; L.closePop(); open(document.getElementById('cuBtn')); }; tiers.appendChild(x); });
      p.appendChild(tiers);
      p.appendChild(el('div', 'cu-sub', tierWanted === 'OBSERVE' ? 'See windows and their controls; nothing is pressed or typed.' : tierWanted === 'INTERACT' ? 'Press and type — only in the window you choose, and only while it is in front.' : 'Any window, the clipboard and system keys. Still never a password field, a credential prompt or UAC.'));
      var acts = el('div', 'cu-acts');
      var en = el('button', 'btn primary', 'Enable for this session'); en.id = 'cuEnable';
      en.onclick = async function () { en.disabled = true; L.closePop(); await act('/api/computer/enable', { tier: tierWanted }); };
      acts.appendChild(en); p.appendChild(acts);
      return;
    }
    p.appendChild(el('div', 'cu-sub', c.label + ' · ' + c.tier + (c.paused ? ' · paused: ' + (c.paused === 'USER_ACTIVE' ? 'you are using the computer — your input wins' : 'the target is not in front') : '') + ' · kill switch ' + c.killSwitch));
    if (c.tier !== 'OBSERVE') {
      p.appendChild(el('div', 'cu-sub', c.target ? 'Target: ' + c.target.title + ' (' + c.target.process + ')' + (c.target.raw ? ' · raw input' : '') : 'Choose the window LAIN may use.'));
      var lab = el('label'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = raw; cb.onchange = function () { raw = cb.checked; }; lab.appendChild(cb); lab.appendChild(document.createTextNode('Raw input (games): key strokes and relative mouse motion')); p.appendChild(lab);
      if (!wins) { var lw = el('button', 'btn', 'Choose target window…'); lw.onclick = function () { loadWindows(p); }; p.appendChild(lw); } else {
        var list = el('div', 'cu-wins');
        wins.forEach(function (w) {
          var x = el('button'); x.appendChild(el('span', '', w.title)); x.appendChild(el('small', '', w.process + (w.sensitive ? ' · sensitive — not offered' : '')));
          if (w.sensitive) x.disabled = true;
          if (c.target && c.target.handle === w.handle) x.setAttribute('aria-current', 'true');
          x.onclick = async function () { wins = null; L.closePop(); await act('/api/computer/target', { handle: w.handle, raw: raw }); };
          list.appendChild(x);
        });
        p.appendChild(list);
      }
    }
    var acts2 = el('div', 'cu-acts');
    var stop = el('button', 'btn danger', 'Stop'); stop.id = 'cuStop'; stop.title = 'Interrupt, fire the kill switch, turn off (Ctrl+Alt+Pause)';
    stop.onclick = async function () { L.closePop(); await act('/api/computer/stop', {}); };
    var off = el('button', 'btn', 'Turn off'); off.onclick = async function () { L.closePop(); await act('/api/computer/disable', {}); };
    acts2.appendChild(stop); acts2.appendChild(off); p.appendChild(acts2);
  }

  function open(anchor) { L.popover(anchor, draw, { cls: 'cupop', toggle: true }); }

  L.computer = { paint: paint, open: open };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
