'use strict';

/**
 * THE IDE TERMINAL — real terminals, drawn by xterm.js (the emulator VS Code's
 * terminal uses), running in Core's pseudoconsoles (src/pty.js).
 *
 * ------------------------------------------------------------------------
 * CORE OWNS THE SHELLS. Each terminal is a pty Core started in the project
 * (`/api/terminal/open`); keystrokes go to it verbatim (`/api/terminal/input`),
 * output is read by byte offset (`/api/terminal/read`), a resize is told to it
 * (`/api/terminal/resize`). A shell keeps running while the panel is shut and
 * the terminal catches up when it is shown again. The BOT reads the same bytes
 * from Core — never from this page (idecontext.js).
 *
 * ------------------------------------------------------------------------
 * WHAT A SERIOUS TERMINAL NEEDS, and where each comes from:
 *   cursor, colour, alternate screen, TUI programs   xterm.js
 *   Ctrl+C                                           the byte, to the shell
 *   copy / paste                                     Core's clipboard (copy.js),
 *                                                    the app's one clipboard
 *   history, completion                              the shell itself
 *   several terminals                                one pty each
 *
 * WITHOUT THE VENDORED EMULATOR, pageterminal.js's built-in view stays in
 * charge (`available()` is false).
 */

const CSS = `
.xt-wrap{display:grid;grid-template-columns:minmax(0,1fr) 150px;height:100%;min-height:0}
.xt-host{position:relative;min-height:0;min-width:0;padding:4px 0 0 6px;background:var(--bg)}
.xt-host .xterm{height:100%}
.xt-list{border-left:1px solid var(--line);overflow-y:auto;font-size:12px}
.xt-tools{display:flex;gap:2px;padding:4px;border-bottom:1px solid var(--line)}
.xt-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:4px 8px;color:var(--dim)}
.xt-item:hover{background:var(--raise);color:var(--ink)}
.xt-item[aria-selected=true]{background:var(--accent-weak);color:var(--ink)}
.xt-item .dead{color:var(--faint)}
.xt-item .k{margin-left:auto;opacity:0;color:var(--faint)}
.xt-item:hover .k{opacity:1}
.bp-body.xt{padding:0;overflow:hidden}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var state = 'unloaded';
  var terms = [];
  var active = -1;
  var wrap = null, host = null, list = null;
  var pumping = false;
  var ro = null;

  function load() {
    if (state !== 'unloaded') return Promise.resolve(state === 'ready');
    state = 'loading';
    return new Promise(function (resolve) {
      var probe = new XMLHttpRequest();
      probe.open('GET', 'vendor/xterm/VERSION');
      probe.onload = function () {
        if (probe.status !== 200) { state = 'absent'; resolve(false); return; }
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'vendor/xterm/xterm.css';
        document.head.appendChild(css);
        // MONACO'S AMD LOADER MAY BE ON THE PAGE, and a UMD bundle that sees
        // `define.amd` registers itself as a module instead of a global. Hiding
        // the global `define` raced Monaco's own loading (it hung in "loading",
        // measured), so each file is evaluated in a scope where `define`,
        // `module` and `exports` are shadowed: the bundle falls through to
        // attaching itself to `self`, and nothing global is ever touched.
        var evalUmd = function (src) { new Function('define', 'module', 'exports', src).call(window, undefined, undefined, undefined); };
        Promise.all([fetch('vendor/xterm/xterm.js').then(function (r) { return r.text(); }), fetch('vendor/xterm/addon-fit.js').then(function (r) { return r.text(); })])
          .then(function (srcs) {
            evalUmd(srcs[0]);
            evalUmd(srcs[1]);
            state = window.Terminal && window.FitAddon ? 'ready' : 'absent';
            resolve(state === 'ready');
          }, function () { state = 'absent'; resolve(false); });
      };
      probe.onerror = function () { state = 'absent'; resolve(false); };
      probe.send();
    });
  }
  function available() { return state === 'ready'; }

  function b64(text) {
    var bytes = new TextEncoder().encode(text);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(data) {
    var s = atob(data);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  var THEME = {
    background: '#0d0e11', foreground: '#e5e7ec', cursor: '#8f9bff', cursorAccent: '#0d0e11', selectionBackground: '#3b4270',
    black: '#15171c', red: '#d9675f', green: '#5aae84', yellow: '#d8a650', blue: '#7c8cf8', magenta: '#c58af0', cyan: '#5fc3c9', white: '#c9ccd4',
    brightBlack: '#5b6070', brightRed: '#f08a82', brightGreen: '#7fd0a4', brightYellow: '#f0c77a', brightBlue: '#a3adff', brightMagenta: '#d9a9f5', brightCyan: '#8adbe0', brightWhite: '#ffffff',
  };

  function current() { return active >= 0 ? terms[active] : null; }

  async function open() {
    if (!available()) return null;
    var term = new window.Terminal({ convertEol: true, theme: THEME, fontFamily: '"Cascadia Code","Cascadia Mono",Consolas,monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    // THE SHELL STARTS AT THE SIZE IT WILL BE SEEN AT. Opened at a default and
    // shrunk afterwards, ConPTY's reflow of the first prompt disagreed with
    // xterm's, and the first command's output overwrote its own echo.
    var box = document.createElement('div');
    box.style.height = '100%';
    if (host && host.offsetParent) { host.textContent = ''; host.appendChild(box); }
    term.open(box);
    var dims = { cols: 120, rows: 24 };
    try { fit.fit(); if (term.cols > 1 && term.rows > 1) dims = { cols: term.cols, rows: term.rows }; } catch (e) { /* hidden: the default, then a resize */ }
    var r = await L.api('/api/terminal/open', dims);
    if (!r || !r.ok) { L.toast((r && r.why) || 'the terminal could not start', true); box.remove(); term.dispose(); return null; }
    var t = { id: r.id, term: term, fit: fit, since: 0, alive: true, name: (r.shell ? String(r.shell).split(/[\\/]/).pop().replace(/\.exe$/i, '') : 'shell'), el: box, cols: dims.cols, rows: dims.rows };
    // FOCUS REPORTS ARE NOT KEYSTROKES. The shell's startup output turns on
    // focus reporting (CSI ?1004h); this ConPTY bridge delivers input as
    // plain text, so xterm's ESC[I / ESC[O on focus landed in front of the
    // next command ("       echo" is not recognized).
    term.onData(function (d) { d = d.replace(/\x1b\[[IO]/g, ''); if (d && t.alive) L.api('/api/terminal/input', { id: t.id, data: b64(d) }).then(function () { pump(); }); });
    // COPY WITH A SELECTION, INTERRUPT WITHOUT ONE — the Windows Terminal rule.
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        L.api('/api/clipboard/write', { text: term.getSelection() });
        term.clearSelection();
        return false;
      }
      if (ctrl && (e.key === 'v' || e.key === 'V')) {
        L.api('/api/clipboard/read', {}).then(function (x) { if (x && x.ok && x.text) term.paste(x.text); });
        return false;
      }
      // The IDE's own keys keep working with the terminal focused.
      if (ctrl && (e.key === '`' || e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')) return false;
      return true;
    });
    terms.push(t);
    active = terms.length - 1;
    show();
    return t;
  }

  async function kill(i) {
    var t = terms[i];
    if (!t) return;
    if (t.alive) await L.api('/api/terminal/close', { id: t.id });
    t.term.dispose();
    terms.splice(i, 1);
    if (active >= terms.length) active = terms.length - 1;
    show();
  }

  function resize() {
    var t = current();
    if (!t || !host || !host.offsetParent) return;
    try { t.fit.fit(); } catch (e) { return; }
    var cols = t.term.cols, rows = t.term.rows;
    if (t.cols === cols && t.rows === rows) return;
    t.cols = cols; t.rows = rows;
    if (t.alive) L.api('/api/terminal/resize', { id: t.id, cols: cols, rows: rows });
  }

  function drawList() {
    if (!list) return;
    list.textContent = '';
    var tools = el('div', 'xt-tools');
    var add = el('button', 'iconbtn'); add.appendChild(L.icon('plus', 14)); add.title = 'New terminal';
    add.onclick = function () { open(); };
    var clr = el('button', 'iconbtn'); clr.appendChild(L.icon('refresh', 14)); clr.title = 'Clear';
    clr.onclick = function () { var t = current(); if (t) t.term.clear(); };
    var k = el('button', 'iconbtn'); k.appendChild(L.icon('close', 14)); k.title = 'Kill terminal';
    k.onclick = function () { if (active >= 0) kill(active); };
    tools.appendChild(add); tools.appendChild(clr); tools.appendChild(k);
    list.appendChild(tools);
    terms.forEach(function (t, i) {
      var b = el('button', 'xt-item');
      b.setAttribute('aria-selected', String(i === active));
      b.appendChild(L.icon('terminal', 13));
      b.appendChild(el('span', t.alive ? '' : 'dead', (i + 1) + ': ' + t.name + (t.alive ? '' : ' (exited)')));
      var x = el('span', 'k', '×');
      x.onclick = function (ev) { ev.stopPropagation(); kill(i); };
      b.appendChild(x);
      b.onclick = function () { active = i; show(); };
      list.appendChild(b);
    });
  }

  function show() {
    if (!host) return;
    host.textContent = '';
    var t = current();
    if (t) {
      host.appendChild(t.el);
      setTimeout(function () { resize(); t.term.focus(); }, 0);
    }
    drawList();
  }

  /** Read what every live shell has written since last time. */
  async function pump() {
    if (pumping || !terms.length) return;
    pumping = true;
    try {
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        if (!t.alive) continue;
        var r = await L.api('/api/terminal/read', { id: t.id, since: t.since });
        if (!r || !r.ok) continue;
        if (r.data) t.term.write(unb64(r.data));
        t.since = r.at;
        if (!r.alive) { t.alive = false; t.term.write('\r\n\u001b[90m[the shell exited]\u001b[0m\r\n'); drawList(); }
      }
    } catch (e) { /* the next tick tries again */ }
    pumping = false;
  }

  /**
   * MOUNT INTO THE IDE'S BOTTOM PANEL. The same DOM moves in and out, so a
   * shell's screen survives the panel being switched away and back.
   */
  function mount(body) {
    body.classList.add('xt');
    if (!wrap) {
      wrap = el('div', 'xt-wrap');
      host = el('div', 'xt-host');
      list = el('div', 'xt-list');
      wrap.appendChild(host);
      wrap.appendChild(list);
      if (window.ResizeObserver) { ro = new ResizeObserver(function () { resize(); }); ro.observe(host); }
    }
    if (wrap.parentNode !== body) { body.textContent = ''; body.appendChild(wrap); }
    if (!terms.length) ensureOne(); else show();
  }
  function unmount(body) { body.classList.remove('xt'); }

  /** Run a command in the IDE terminal (the Run pane, the BOT's suggestions). */
  async function run(cmd) {
    await L.ide.showPanel('TERMINAL');
    await load();
    var t = current();
    if (!t || !t.alive) t = await ensureOne();
    if (!t) return;
    await L.api('/api/terminal/input', { id: t.id, data: b64(cmd + '\r') });
    pump();
  }

  /** ONE terminal, however many callers ask at once (the panel and a Run click race). */
  var opening = null;
  function ensureOne() {
    var t = current();
    if (t && t.alive) return Promise.resolve(t);
    if (!opening) opening = open().then(function (x) { opening = null; return x; }, function () { opening = null; return null; });
    return opening;
  }

  function activeId() { var t = current(); return t && t.alive ? t.id : null; }
  /** The active terminal's screen as text — for tests and for "copy all". */
  function text() {
    var t = current();
    if (!t) return '';
    var b = t.term.buffer.active, out = [];
    for (var i = 0; i < b.length; i++) { var l = b.getLine(i); if (l) out.push(l.translateToString(true)); }
    return out.join('\n').replace(/\s+$/, '');
  }

  L.xterm = { load: load, available: available, mount: mount, unmount: unmount, open: open, run: run, activeId: activeId, text: text, host: function () { return wrap; } };
  L.onBoot(function () {
    // LIVE WHILE SHOWN, CATCH-UP WHEN NOT: a fast read while the panel is on
    // screen, a slow one otherwise so exits are still noticed.
    var tick = 0;
    setInterval(function () {
      tick += 1;
      var visible = wrap && wrap.offsetParent;
      if (visible || tick % 12 === 0) pump();
    }, 120);
    L.nav.onShow('ide', function () { load(); });
    // THE RUN PANE AND THE BOT CALL LAIN.terminal — it follows whichever terminal is in charge.
    if (L.terminal) {
      var legacyRun = L.terminal.run;
      L.terminal.run = function (cmd) {
        if (available()) return run(cmd);
        if (legacyRun) return legacyRun(cmd);
        // THE BUILT-IN VIEW: open its shell if needed, then type the command.
        return L.ide.showPanel('TERMINAL').then(function () { return L.terminal.state.id ? null : L.terminal.open(); }).then(function () { return L.terminal.send(cmd + String.fromCharCode(13)); });
      };
      L.terminal.activeId = function () { return available() ? activeId() : (L.terminal.state && L.terminal.state.id) || null; };
    }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
