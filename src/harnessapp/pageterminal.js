'use strict';

/**
 * THE TERMINAL PANEL'S CLIENT — reading a real shell, and drawing it honestly.
 *
 * ------------------------------------------------------------------------
 * IT READS BY OFFSET, NOT BY REFETCHING.
 *
 * The shell keeps running while the panel is shut and its output accumulates in
 * Core (src/pty.js). Asking for the whole buffer on every poll would make the
 * terminal the most expensive thing in the application; asking for what is new
 * after `since` costs what actually changed.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A TERMINAL EMULATOR, AND THE LINE IT DRAWS IS DELIBERATE.
 *
 * There is no cursor addressing, no scroll region and no alternate screen: a
 * full emulator is a different project, and a WRONG one is worse than none
 * because it would draw a build log that is subtly not what the build said.
 *
 * What IS implemented is the part where stripping was itself the lie:
 *
 *   CARRIAGE RETURN OVERWRITES. Every progress bar, download meter and spinner
 *   on Windows redraws one line by returning to its start. Turning CR into a
 *   newline — which this did — took one line that said "100%" and drew fifty
 *   lines ending in "2%", "5%", "9%"… That is not what the build said.
 *
 *   BACKSPACE DELETES, and erase-in-line and erase-in-display clear, for the
 *   same reason: they are how a line is corrected, and dropping them leaves
 *   the correction and the thing it corrected both on screen.
 *
 *   SGR IS COLOUR, and colour cannot misrepresent text — it only styles it. A
 *   test runner's red is information, and a pseudoconsole exists to carry it.
 *
 * Everything else is still dropped. A sequence this does not implement leaves
 * no trace rather than printing as mojibake.
 *
 * ------------------------------------------------------------------------
 * NO BACKSLASHES IN THE EMITTED SCRIPT. This file is one template literal, so
 * every escape is consumed once before the page sees it and a half-escaped
 * regex becomes a parse error in the window. The patterns are built from
 * character codes for that reason.
 */

function js() {
  return `
LAIN.terminal = (function () {
  'use strict';
  var api, notice, render, ui, poll;

  /** The same one-line node helper pagescript uses; this module needs its own. */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  // state.lines is the screen: each is an array of cells, each cell a character
  // and the style it was written in. state.col is where the next character lands,
  // which is what makes carriage return an OVERWRITE rather than a new line.
  var state = {
    procs: null, at: 0, busy: false, id: null, since: 0,
    lines: [[]], col: 0, sgr: '', text: '', pending: '', pumping: false,
  };

  var ESC = String.fromCharCode(27);
  var BEL = String.fromCharCode(7);
  var LB = String.fromCharCode(91);
  var CR = String.fromCharCode(13);
  var NL = String.fromCharCode(10);
  var BS = String.fromCharCode(8);

  /** How many lines of scrollback the panel keeps. A terminal is not a log. */
  var MAX_LINES = 1200;

  // ---- WHAT AN SGR CODE MEANS ------------------------------------------
  //
  // The sixteen ANSI colours and the ordinary attributes. 256-colour and
  // truecolour forms are accepted and reduced to the nearest of these rather
  // than ignored, because a line that arrives uncoloured is better than a line
  // with its escape printed in it.
  var FG = ['#000', '#e86a6a', '#4ec98a', '#e0b341', '#49b6ff', '#c678dd', '#56b6c2', '#dfe6ee'];
  var BRIGHT = ['#5b6675', '#ff8787', '#79e0a8', '#ffd479', '#8fd3ff', '#d9a2e8', '#87dfe8', '#ffffff'];

  function sgrStyle(codes) {
    var css = '';
    var parts = codes.split(';');
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (isNaN(n)) n = 0;
      if (n === 0) css = '';
      else if (n === 1) css += 'font-weight:600;';
      else if (n === 2) css += 'opacity:.7;';
      else if (n === 3) css += 'font-style:italic;';
      else if (n === 4) css += 'text-decoration:underline;';
      else if (n >= 30 && n <= 37) css += 'color:' + FG[n - 30] + ';';
      else if (n >= 90 && n <= 97) css += 'color:' + BRIGHT[n - 90] + ';';
      else if (n >= 40 && n <= 47) css += 'background:' + FG[n - 40] + ';';
      else if (n >= 100 && n <= 107) css += 'background:' + BRIGHT[n - 100] + ';';
      else if (n === 38 || n === 48) {
        // 38;5;N and 38;2;R;G;B — consumed so their arguments are not read as
        // attributes of their own, and reduced to a readable default.
        var mode = parseInt(parts[i + 1], 10);
        if (mode === 5) i += 2; else if (mode === 2) i += 4; else i += 1;
        if (n === 38) css += 'color:' + BRIGHT[7] + ';';
      }
    }
    return css;
  }

  function put(ch) {
    var line = state.lines[state.lines.length - 1];
    line[state.col] = { c: ch, s: state.sgr };
    state.col += 1;
  }

  function newline() {
    state.lines.push([]);
    state.col = 0;
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  }

  /**
   * FEED THE BYTES IN. One pass, no regex: a regex that removes escapes cannot
   * also act on them, and acting on CR, BS and SGR is the whole point.
   */
  function feed(s2) {
    // ---- A SEQUENCE CAN ARRIVE IN TWO PIECES ---------------------------
    //
    // Reads are byte ranges, not message boundaries: a chunk can end halfway
    // through an escape. Dropping the half that arrived would leave the rest to
    // be parsed as ordinary text, so a colour change split across two polls
    // would print "1mRED" into the log. The tail is held and prepended.
    var str = state.pending + String(s2);
    state.pending = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === ESC) {
        if (i + 1 >= str.length) { state.pending = str.slice(i); return; }
        var next = str[i + 1];
        if (next === ']') {                       // OSC — a window title. Dropped.
          var end = str.indexOf(BEL, i);
          var st = str.indexOf(ESC + String.fromCharCode(92), i);
          if (end < 0 && st < 0) { state.pending = str.slice(i); return; }
          i = (end >= 0 && (st < 0 || end < st)) ? end : st + 1;
          continue;
        }
        if (next === LB) {                        // CSI
          var j = i + 2;
          while (j < str.length && str.charCodeAt(j) >= 0x20 && str.charCodeAt(j) <= 0x3f) j += 1;
          if (j >= str.length) { state.pending = str.slice(i); return; }
          var fin = str[j];
          var args = str.slice(i + 2, j);
          if (fin === 'm') state.sgr = sgrStyle(args.replace(/[^0-9;]/g, '') || '0');
          else if (fin === 'K') {                 // erase in line
            var mode = parseInt(args, 10) || 0;
            var ln = state.lines[state.lines.length - 1];
            if (mode === 0) ln.length = Math.min(ln.length, state.col);
            else if (mode === 1) { for (var k = 0; k < state.col; k++) ln[k] = { c: ' ', s: '' }; }
            else { ln.length = 0; state.col = 0; }
          } else if (fin === 'J') {               // erase in display
            state.lines = [[]]; state.col = 0;
          }
          i = j;
          continue;
        }
        i += 1;                                    // a two-character escape
        continue;
      }
      if (ch === CR) { state.col = 0; continue; }
      if (ch === NL) { newline(); continue; }
      if (ch === BS) { if (state.col > 0) state.col -= 1; continue; }
      if (ch < ' ') continue;                      // any other control byte
      put(ch);
    }
  }

  /** The screen as plain text — what a copy, a test or a search reads. */
  function asText() {
    var out = [];
    for (var i = 0; i < state.lines.length; i++) {
      var line = state.lines[i], s2 = '';
      for (var j = 0; j < line.length; j++) s2 += (line[j] ? line[j].c : ' ');
      out.push(s2);
    }
    return out.join(NL);
  }

  /** The screen as nodes, one span per run of identical style. */
  function draw(into) {
    into.textContent = '';
    for (var i = 0; i < state.lines.length; i++) {
      var line = state.lines[i];
      var run = '', style = null;
      for (var j = 0; j < line.length; j++) {
        var cell = line[j] || { c: ' ', s: '' };
        if (style === null) style = cell.s;
        if (cell.s !== style) {
          into.appendChild(span(run, style));
          run = ''; style = cell.s;
        }
        run += cell.c;
      }
      if (run) into.appendChild(span(run, style || ''));
      if (i < state.lines.length - 1) into.appendChild(document.createTextNode(NL));
    }
  }

  function span(text, style) {
    var n = document.createElement('span');
    n.textContent = text;
    if (style) n.setAttribute('style', style);
    return n;
  }

  async function pump() {
    if (!state.id || state.pumping) return;
    state.pumping = true;
    try {
      var r = await api('/api/terminal/read', { id: state.id, since: state.since });
      if (r && r.ok) {
        if (r.data) {
          feed(atob(r.data));
          state.text = asText();
          state.since = r.at;
          if (ui.drawer === 'terminal') render();
        }
        if (!r.alive) { state.id = null; feed(NL + '[the shell exited]' + NL); state.text = asText(); render(); }
      }
    } catch (e) { /* the next tick tries again */ }
    state.pumping = false;
  }

  function reset() { state.lines = [[]]; state.col = 0; state.sgr = ''; state.text = ''; state.pending = ''; }

  async function open() {
    var r = await api('/api/terminal/open', { cols: 120, rows: 28 });
    if (!r.ok) return notice(r.why, true);
    state.id = r.id; state.since = 0;
    reset();
    render();
    pump();
  }

  async function send(data) {
    if (!state.id) return;
    await api('/api/terminal/input', { id: state.id, data: btoa(data) });
    pump();
  }

  // ---- the project's processes, and the way out to a real terminal -------
  //
  // FETCHED WHEN THE PANEL IS OPEN, never in the poll: a build log is large and
  // the panel is usually shut, so putting it in /api/state would ship one every
  // 1.5 seconds to nobody.
  async function terminalRefresh() {
    var T = state;
    if (T.busy) return;
    T.busy = true;
    try {
      var r = await api('/api/terminal/processes', {});
      if (r.ok) { T.procs = r.processes || []; T.at = Date.now(); }
    } catch (e) { /* the next poll tries again */ }
    T.busy = false;
  }

  /**
   * THE PANEL ITSELF — the shell, its controls, and the project's processes.
   *
   * It lives here rather than in pagescript.js because it is the terminal's
   * own surface: it reads this module's state, calls its open/send/draw, and
   * changes when the terminal changes. It moved when pagescript reached 697 of
   * the 700 lines the god-object guard allows — the guard asking for the seam
   * that was already there.
   */
  function renderPanel(body) {
    var T = state;
    var head = el('div', 'termhead');
    // OPEN CLI — an explicit secondary action, never the default. It opens a
    // REAL terminal on this session outside the application; the conversation
    // you are looking at IS the LAIN interface, so this is for people who want
    // the terminal-native one. See terminalroutes.js.
    var cli = el('button', 'btn', 'Open CLI');
    cli.title = 'Open a terminal running LAIN on this session. The session moves to it.';
    cli.onclick = async function () {
      var r = await api('/api/desktop/opencli', {});
      notice(r.ok ? 'A terminal opened on this session.' : r.why, !r.ok);
      await poll();
    };
    head.appendChild(cli);

    // ---- THE SHELL ITSELF ------------------------------------------------
    if (!T.id) {
      var openBtn = el('button', 'btn', 'Open shell');
      openBtn.title = 'A real shell in this project. It keeps running while this panel is shut.';
      openBtn.onclick = function () { open(); };
      head.insertBefore(openBtn, head.firstChild);
    } else {
      // ---- CTRL+C IS OFFERED, AND IT IS NOT GUARANTEED --------------------
      //
      // The event really is raised on the shell's console (src/pty.js), and
      // PowerShell does not always act on it — measured against Start-Sleep in
      // four different process arrangements, none of which stopped it. A button
      // that silently does nothing is worse than one that says so, so pressing
      // it names End shell as the thing that always works.
      var stopBtn = el('button', 'btn', 'Ctrl+C');
      stopBtn.title = 'Ask the shell to interrupt what it is running. PowerShell does not always stop — use End shell if it keeps going.';
      stopBtn.onclick = async function () {
        var r = await api('/api/terminal/interrupt', { id: T.id });
        notice(r.ok
          ? 'Interrupt sent. If the command keeps running, End shell stops it.'
          : r.why, !r.ok);
        pump();
      };
      var endBtn = el('button', 'btn', 'End shell');
      endBtn.onclick = async function () { await api('/api/terminal/close', { id: T.id }); T.id = null; render(); };
      head.insertBefore(endBtn, head.firstChild);
      head.insertBefore(stopBtn, head.firstChild);
    }
    body.appendChild(head);

    if (T.id) {
      // DRAWN AS RUNS, not as one text node: the shell's colour is information
      // (a failing test is red) and a pseudoconsole exists to carry it. See
      // pageterminal.js for what is rendered and what is still dropped.
      var pre = el('pre', 'out shell');
      draw(pre);
      body.appendChild(pre);
      pre.scrollTop = pre.scrollHeight;
      var line = el('input', 'shellin');
      line.placeholder = 'type a command and press Enter';
      line.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        var v = line.value;
        line.value = '';
        send(v + String.fromCharCode(13));
      };
      body.appendChild(line);
      // KEEP READING WHILE THE PANEL IS OPEN. When it is shut the shell keeps
      // running and its output accumulates in Core — the panel catches up by
      // byte offset when it comes back, which is what the since field is for.
      pump();
    }

    if (T.procs === null) { body.appendChild(el('div', 'obs', 'Reading the project\\u2019s processes\\u2026')); terminalRefresh().then(render); return; }
    if (!T.procs.length) {
      body.appendChild(el('div', 'obs', 'Nothing is running in this project. Commands LAIN starts in the background, and any dev server it owns, appear here.'));
      return;
    }
    T.procs.forEach(function (p) {
      var r = el('div', 'proc');
      var h = el('div', 'row');
      h.appendChild(el('span', 'st ' + (p.running ? 'on' : 'off'), p.running ? '\\u25cf' : '\\u25cb'));
      h.appendChild(el('span', 'path', p.command));
      h.appendChild(el('span', 'src', p.state + (p.code == null ? '' : ' \\u00b7 exit ' + p.code)));
      // STOPPING IS OFFERED; STARTING IS NOT. Ending something is the direction
      // that is always safe.
      if (p.running && p.kind === 'command') {
        var stop = el('button', 'btn', 'Stop');
        stop.onclick = async function () { await api('/api/terminal/stop', { id: p.id }); await terminalRefresh(); render(); };
        h.appendChild(stop);
      }
      r.appendChild(h);
      if (p.lines) r.appendChild(el('pre', 'out', p.lines));
      body.appendChild(r);
    });
  }
  function boot(deps) {
    api = deps.api; notice = deps.notice; render = deps.render; ui = deps.ui; poll = deps.poll;
  }

  return {
    boot: boot, state: state, open: open, send: send, pump: pump,
    feed: feed, asText: asText, draw: draw, reset: reset,
    renderPanel: renderPanel, refresh: terminalRefresh,
  };
}());
`;
}

module.exports = { js };
