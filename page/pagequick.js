'use strict';

/**
 * QUICK ACTIONS ON THE TOP TABS — hover (or ArrowDown on a focused tab) for
 * the few things people open that tab to do.
 *
 *   [ Model ]  ← rest on it
 *   ┌──────────────────────────┐
 *   │ Add API key              │
 *   │ Sign in to a website…    │
 *   │ Refresh models           │
 *   │ Roles & usage            │
 *   └──────────────────────────┘
 *
 * EVERY ITEM IS AN EXISTING FLOW. The menu owns no state: it calls the same
 * function the tab's own button calls (L.keys.add, L.ide.openProject,
 * L.chat.newChat, L.nav.go with a section …). If a flow is not in this build,
 * it is not on the menu.
 *
 * TIMING: opens after 450ms at rest (a pointer passing over the tab bar opens
 * nothing), stays open while the pointer is on the tab or the menu, closes
 * 250ms after it leaves both. A click on the tab still just goes to the tab.
 *
 * KEYBOARD: ArrowDown, Shift+F10 or the Menu key on a focused tab opens it
 * with the first item focused; ↑/↓ move, Enter runs, Escape returns to the tab.
 */

const CSS = `
.qmenu{position:fixed;z-index:66;background:var(--panel);border:1px solid var(--line2);border-radius:8px;padding:5px;min-width:220px;box-shadow:var(--shadow)}
.qmenu h4{margin:4px 8px 5px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600}
.qmenu .opt{display:flex;align-items:center;gap:8px}
.qmenu .opt kbd{margin-left:auto;font:11px var(--mono);color:var(--faint)}
.qmenu .opt:focus-visible{outline:1px solid var(--accent-line);background:var(--accent-weak);color:var(--ink)}
`;

function client() {
  var L = window.LAIN;
  var el = function (t, c, x) { return L.el(t, c, x); };
  var OPEN_MS = 450, CLOSE_MS = 250;
  var menu = null, owner = null, openTimer = 0, closeTimer = 0;

  // Run a flow after its tab is in front, so the flow finds its view.
  var on = function (tab, fn) { return function () { if (L.nav.tab() !== tab) L.nav.go(tab); setTimeout(fn, 0); }; };
  var goTo = function (tab, opts) { return function () { L.nav.go(tab, opts); }; };

  // EVERY ITEM IS A HOUSE DOOR (pagehouse.js / Core's house.js) or an existing
  // flow: the hover menu keeps no state and has no flow of its own.
  var door = function (id, args) { return function () { L.house.run(id, args || {}); }; };

  function items(tab) {
    if (tab === 'home') return [
      ['Open project…', door('ide.open_project')],
      ['New project…', door('ide.new_project')],
      ['Search LAIN', on('home', function () { var s = document.getElementById('hsearch'); if (s) s.focus(); })],
    ];
    if (tab === 'ide') return [
      ['+ New Project', door('ide.new_project')],
      ['Open Project', door('ide.open_project')],
      ['Recent Projects', door('ide.recent_projects')],
      ['Go to file', on('ide', function () { L.source.quickOpen(); }), 'Ctrl+P'],
      ['Terminal', on('ide', function () { L.ide.showPanel('TERMINAL'); }), 'Ctrl+`'],
    ];
    if (tab === 'chat') return [
      ['New chat', door('chat.new')],
      ['BOT model…', on('chat', function () { L.models.pickBot(document.getElementById('gearBtn') || document.getElementById('tabChat')); })],
    ];
    if (tab === 'bot') return [
      ['+ Add Telegram', door('bot.add_telegram')],
      ['+ Add WhatsApp', door('bot.add_whatsapp')],
      ['Bot Settings', door('bot.open_settings')],
    ];
    if (tab === 'model') return [
      ['+ Add Account', door('model.add_account')],
      ['+ Add API Key', door('model.add_api_key')],
      ['+ Connect Provider', door('model.connect_provider')],
      ['Refresh Models', door('model.refresh')],
    ];
    if (tab === 'session') return [
      ['New session', function () { L.sessions.create('engineering'); }],
      ['All sessions', goTo('session')],
    ];
    if (tab === 'settings') return [
      ['Appearance', goTo('settings', { section: 'appearance' })],
      ['Editor', goTo('settings', { section: 'editor' })],
      ['Keyboard shortcuts', goTo('settings', { section: 'shortcuts' })],
      ['MCP servers', door('settings.open_mcp')],
      ['Skills', door('settings.open_skills')],
      ['Privacy', goTo('settings', { section: 'privacy' })],
    ];
    return [];
  }

  function close(refocus) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (menu) { menu.remove(); menu = null; }
    if (refocus && owner) owner.focus();
    if (owner) owner.removeAttribute('aria-expanded');
    owner = null;
  }

  function open(btn, focusFirst) {
    var tab = btn.getAttribute('data-tab');
    var list = items(tab);
    if (!list.length) return;
    close(false);
    owner = btn;
    menu = el('div', 'qmenu');
    menu.id = 'qmenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', btn.textContent + ' actions');
    list.forEach(function (it) {
      var b = el('button', 'opt');
      b.setAttribute('role', 'menuitem');
      b.appendChild(el('span', '', it[0]));
      if (it[2]) b.appendChild(el('kbd', '', it[2]));
      b.onclick = function () { close(false); try { it[1](); } catch (e) { if (window.console) console.error(e); } };
      menu.appendChild(b);
    });
    menu.addEventListener('mouseenter', function () { clearTimeout(closeTimer); });
    menu.addEventListener('mouseleave', later);
    menu.addEventListener('keydown', function (e) {
      var opts = Array.prototype.slice.call(menu.querySelectorAll('.opt'));
      var i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) { var f = menu.querySelector('.opt'); if (f) f.focus(); }
  }

  function later() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () { close(false); }, CLOSE_MS);
  }

  L.onBoot(function () {
    Array.prototype.forEach.call(document.querySelectorAll('.gtab[data-tab]'), function (btn) {
      btn.setAttribute('aria-haspopup', 'menu');
      btn.addEventListener('mouseenter', function () {
        clearTimeout(closeTimer);
        if (menu && owner === btn) return;
        clearTimeout(openTimer);
        openTimer = setTimeout(function () { open(btn, false); }, menu ? 80 : OPEN_MS);
      });
      btn.addEventListener('mouseleave', later);
      btn.addEventListener('click', function () { close(false); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); open(btn, true); }
        else if (e.key === 'Escape' && menu) { e.preventDefault(); close(true); }
      });
    });
    document.addEventListener('pointerdown', function (e) { if (menu && !menu.contains(e.target) && e.target !== owner) close(false); }, true);
    window.addEventListener('blur', function () { close(false); });
  });

  L.quick = { open: function (tab) { var b = document.querySelector('.gtab[data-tab="' + tab + '"]'); if (b) open(b, true); }, close: close, items: items };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
