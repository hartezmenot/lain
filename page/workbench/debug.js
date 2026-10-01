'use strict';

/**
 * THE DEBUG PANEL — Core's debugger (dap/manager.js), drawn.
 *
 *   ▶ Start / Continue (F5)  ⤼ Step Over (F10)  ↓ Into (F11)  ↑ Out (Shift+F11)  ⏸ Pause  ■ Stop (Shift+F5)
 *   Call stack │ Variables │ Watch
 *   Debug console (the program's output, and expressions evaluated in the paused frame)
 *
 * Breakpoints are set in the editor's gutter (click, or F9 on the caret line);
 * the paused line is highlighted. Everything is a call to POST /api/debug/*:
 * this file keeps no debugger state of its own beyond what the last status said.
 *
 * NO BACKTICKS BELOW: the script is composed into the page.
 */
const CSS = `
.dbg{display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:100%;min-height:0;font-size:12.5px}
.dbg .bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--separator);flex-wrap:wrap}
.dbg .bar input{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:3px 7px;font-family:var(--mono);font-size:12px;min-width:180px}
.dbg .bar select{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:3px 5px;font-size:12px}
.dbg .bar .st{margin-left:auto;color:var(--text-muted)}
.dbg .bar .st.paused{color:var(--warning)}
.dbg .cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr);min-height:0}
.dbg .col{overflow:auto;border-right:1px solid var(--separator);padding:6px 0;min-height:0}
.dbg .col:last-child{border-right:0}
.dbg .col h6{margin:0 10px 4px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted)}
.dbg .row{display:flex;gap:8px;padding:2px 10px;font-family:var(--mono);font-size:12px;cursor:default;white-space:nowrap}
.dbg .row.on{background:var(--selection)}
.dbg .row.click{cursor:pointer}
.dbg .row:hover{background:var(--surface-active)}
.dbg .row .k{color:var(--text-secondary)}
.dbg .row .v{overflow:hidden;text-overflow:ellipsis}
.dbg .row .t{color:var(--text-muted);margin-left:auto}
.dbg .cons{border-top:1px solid var(--separator);display:grid;grid-template-rows:minmax(0,110px) auto}
.dbg .cons .out{overflow:auto;padding:4px 10px;font-family:var(--mono);font-size:12px;white-space:pre-wrap}
.dbg .cons .out .err{color:var(--danger)}
.dbg .cons .out .repl{color:var(--accent-primary)}
.dbg .cons input{border:0;border-top:1px solid var(--separator);background:var(--surface-raised);padding:5px 10px;font-family:var(--mono);font-size:12px}
.dbg-bp{background:#e5484d;border-radius:50%;width:9px!important;height:9px!important;margin-left:5px;margin-top:5px}
.dbg-line{background:rgba(255,196,0,.14)}
.dbgcfg{display:flex;flex-direction:column;gap:6px;padding:4px 12px 8px}
.dbgcfg input,.dbgcfg select,.dbgadd{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:4px 8px;font-size:12.5px;color:var(--text-primary)}
.dbgcfg input,.dbgadd{font-family:var(--mono)}
.dbgbar{display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 6px}
.dbgst{padding:2px 12px 8px;font-size:12px;color:var(--text-muted)}
.dbgst.paused{color:var(--warning)}
.dbgsec{padding:0 0 8px;font-size:12.5px}
.dbgsec .row{display:flex;gap:8px;padding:2px 14px;font-family:var(--mono);font-size:12px;white-space:nowrap}
.dbgsec .row.click{cursor:pointer} .dbgsec .row:hover{background:var(--surface-active)} .dbgsec .row.on{background:var(--selection)}
.dbgsec .row .k{color:var(--text-secondary)} .dbgsec .row .v{overflow:hidden;text-overflow:ellipsis} .dbgsec .row .t{color:var(--text-muted);margin-left:auto}
.dbgscope{padding:2px 14px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em}
.dbgadd{margin:4px 14px;width:calc(100% - 28px);box-sizing:border-box}
.dbgcons{display:grid;grid-template-rows:minmax(0,1fr) auto;height:100%;min-height:0}
.dbgcons .out{overflow:auto;font-family:var(--mono);font-size:12px;white-space:pre-wrap;min-height:0}
.dbgcons .out .err{color:var(--danger)} .dbgcons .out .repl{color:var(--accent-primary)}
.dbgcons input{border:0;border-top:1px solid var(--separator);background:var(--surface-raised);padding:5px 10px;font-family:var(--mono);font-size:12px;color:var(--text-primary)}
.dbg-arrow{border-left:3px solid #ffc400}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var D = { status: null, program: '', adapter: '', timer: null, expanded: {}, decos: [], edFor: null };

  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }
  function api(p, b) { return L.api(p, b || {}); }
  function session() { return D.status && D.status.session; }
  function live() { var s = session(); return Boolean(s && (s.state === 'RUNNING' || s.state === 'PAUSED' || s.state === 'STARTING')); }

  async function refresh() {
    var r = await api('/api/debug/status');
    if (r && r.ok !== false) D.status = r;
    decorate();
    if (live()) schedule(); else stopPoll();
    if (L.ide && L.ide.rerenderPanel) L.ide.rerenderPanel();
    return D.status;
  }
  function schedule() { if (!D.timer) D.timer = setInterval(function () { refresh(); }, 1000); }
  function stopPoll() { if (D.timer) { clearInterval(D.timer); D.timer = null; } }
  function after(r) {
    if (r && r.ok === false && r.why && L.toast) L.toast(r.why, true);
    if (r && r.session && D.status) D.status.session = r.session;
    decorate();
    reveal();
    if (live()) schedule();
    redraw();
    return r;
  }

  // ---- actions (every one is Core's) -------------------------------------------------
  function currentFile() { var f = L.source && L.source.current && L.source.current(); return f ? f.path : ''; }
  async function start() {
    var program = D.program || currentFile();
    if (!program) { if (L.toast) L.toast('Open the program to debug, or type its path.', true); return; }
    D.program = program;
    after(await api('/api/debug/start', { program: program, adapter: D.adapter || null }));
    refresh();
  }
  async function control(action) { return after(await api('/api/debug/control', { action: action })); }
  async function stop() { after(await api('/api/debug/stop')); stopPoll(); refresh(); }
  async function startOrContinue() {
    var s = session();
    if (s && s.state === 'PAUSED') return control('continue');
    if (!live()) return start();
    return null;
  }

  /** The editor's breakpoints for a file, from Core's list. */
  function bpLines(p) {
    var list = (D.status && D.status.breakpoints) || [];
    var hit = list.filter(function (b) { return b.file === p; })[0];
    return hit ? hit.lines.slice() : [];
  }
  async function toggleBreakpoint(p, line) {
    if (!p || !line) return;
    if (!D.status) await refresh();
    var lines = bpLines(p);
    var i = lines.indexOf(line);
    if (i >= 0) lines.splice(i, 1); else lines.push(line);
    var r = await api('/api/debug/breakpoints', { path: p, lines: lines });
    if (r && r.ok === false) { if (L.toast) L.toast(r.why, true); return; }
    await refresh();
  }

  // ---- the editor: gutter breakpoints and the paused line ---------------------------
  function decorate() {
    var ed = L.editor && L.editor.editor && L.editor.editor();
    var M = L.editor && L.editor.monaco && L.editor.monaco();
    if (!ed || !M || !ed.getModel()) return;
    var p = currentFile();
    var decos = bpLines(p).map(function (n) {
      return { range: new M.Range(n, 1, n, 1), options: { glyphMarginClassName: 'dbg-bp', glyphMarginHoverMessage: { value: 'Breakpoint (F9 or click to remove)' } } };
    });
    var s = session();
    var top = s && s.state === 'PAUSED' && s.stack && s.stack.length ? s.stack.filter(function (f) { return f.id === s.frameId; })[0] || s.stack[0] : null;
    if (top && top.path === p) decos.push({ range: new M.Range(top.line, 1, top.line, 1), options: { isWholeLine: true, className: 'dbg-line', linesDecorationsClassName: 'dbg-arrow' } });
    D.decos = ed.deltaDecorations(D.decos, decos);
  }
  /** Paused somewhere else: bring that file and line into the editor. */
  function reveal() {
    var s = session();
    if (!s || s.state !== 'PAUSED' || !s.stack || !s.stack.length) return;
    var top = s.stack.filter(function (f) { return f.id === s.frameId; })[0] || s.stack[0];
    if (!top.path || /^\.\./.test(top.path) || /^[A-Za-z]:/.test(top.path)) return;
    if (currentFile() !== top.path) L.source.openFile(top.path, { line: top.line }).then(decorate);
    else if (L.source.gotoLine) L.source.gotoLine(top.line);
  }
  function hookEditor() {
    var ed = L.editor && L.editor.editor && L.editor.editor();
    var M = L.editor && L.editor.monaco && L.editor.monaco();
    if (!ed || !M || D.edFor === ed) return;
    D.edFor = ed;
    ed.updateOptions({ glyphMargin: true });
    ed.onMouseDown(function (e) {
      if (!e.target || e.target.type !== M.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      toggleBreakpoint(currentFile(), e.target.position.lineNumber);
    });
    ed.onDidChangeModel(function () { setTimeout(decorate, 0); });
  }

  // ---- the panel -------------------------------------------------------------------------
  var bodyEl = null;
  var sideEl = null, consoleEl = null;
  function redraw() {
    if (bodyEl && bodyEl.isConnected) renderPanel(bodyEl);
    if (sideEl && sideEl.isConnected) renderSide(sideEl);
    if (consoleEl && consoleEl.isConnected && !(document.activeElement && consoleEl.contains(document.activeElement))) renderConsole(consoleEl);
  }
  function btn(label, title, fn, disabled) { var b = el('button', 'btn small', label); b.title = title; b.disabled = Boolean(disabled); b.onclick = fn; return b; }

  function renderPanel(body) {
    bodyEl = body;
    if (!D.status) { body.appendChild(el('div', 'obs', 'Reading the debugger…')); refresh().then(redraw); return; }
    body.textContent = '';
    var s = session();
    var paused = s && s.state === 'PAUSED';
    var box = el('div', 'dbg');
    var bar = el('div', 'bar');
    var prog = document.createElement('input');
    prog.placeholder = currentFile() || 'program to debug';
    prog.value = D.program || '';
    prog.oninput = function () { D.program = prog.value.trim(); };
    bar.appendChild(prog);
    var sel = document.createElement('select');
    var auto = el('option', '', 'adapter: by file type'); auto.value = ''; sel.appendChild(auto);
    (D.status.adapters || []).forEach(function (a) {
      var o = el('option', '', a.name + (a.available ? '' : ' — unavailable'));
      o.value = a.id; o.disabled = !a.available; o.title = a.why || '';
      if (D.adapter === a.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { D.adapter = sel.value; };
    bar.appendChild(sel);
    bar.appendChild(btn(paused ? 'Continue' : 'Start', paused ? 'Continue (F5)' : 'Start debugging (F5)', startOrContinue, live() && !paused));
    bar.appendChild(btn('Step Over', 'F10', function () { control('next'); }, !paused));
    bar.appendChild(btn('Step Into', 'F11', function () { control('stepIn'); }, !paused));
    bar.appendChild(btn('Step Out', 'Shift+F11', function () { control('stepOut'); }, !paused));
    bar.appendChild(btn('Pause', 'Pause', function () { control('pause'); }, !(s && s.state === 'RUNNING')));
    bar.appendChild(btn('Stop', 'Shift+F5', stop, !live()));
    var st = el('span', 'st' + (paused ? ' paused' : ''), s ? (s.program + ' · ' + s.state.toLowerCase() + (paused && s.stopped ? ' (' + s.stopped.reason + ')' : '') + (s.why && !live() ? ' — ' + s.why : '')) : 'No debug session');
    bar.appendChild(st);
    box.appendChild(bar);

    var cols = el('div', 'cols');
    // Call stack + breakpoints
    var c1 = el('div', 'col');
    c1.appendChild(el('h6', '', 'Call stack'));
    ((s && s.stack) || []).forEach(function (f) {
      var r = el('div', 'row click' + (f.id === s.frameId ? ' on' : ''));
      r.appendChild(el('span', 'v', f.name));
      r.appendChild(el('span', 't', (f.path || '?') + ':' + f.line));
      r.onclick = async function () { after(await api('/api/debug/frame', { frameId: f.id })); if (f.path) L.source.openFile(f.path, { line: f.line }); };
      c1.appendChild(r);
    });
    if (!s || !s.stack || !s.stack.length) c1.appendChild(el('div', 'row', paused ? 'no frames' : '—'));
    c1.appendChild(el('h6', '', 'Breakpoints'));
    ((D.status && D.status.breakpoints) || []).forEach(function (b) {
      b.lines.forEach(function (n) {
        var r = el('div', 'row click');
        r.appendChild(el('span', 'v', b.file + ':' + n));
        var x = el('span', 't', '×'); x.title = 'Remove';
        x.onclick = function (e) { e.stopPropagation(); toggleBreakpoint(b.file, n); };
        r.appendChild(x);
        r.onclick = function () { L.source.openFile(b.file, { line: n }); };
        c1.appendChild(r);
      });
    });
    cols.appendChild(c1);
    // Variables
    var c2 = el('div', 'col');
    ((s && s.scopes) || []).forEach(function (sc) {
      c2.appendChild(el('h6', '', sc.name));
      (sc.variables || []).forEach(function (v) { varRow(c2, v, 0); });
      if (!sc.variables) c2.appendChild(el('div', 'row', sc.expensive ? '(not read: expensive)' : '—'));
    });
    if (!s || !s.scopes || !s.scopes.length) { c2.appendChild(el('h6', '', 'Variables')); c2.appendChild(el('div', 'row', paused ? 'none' : 'pause the program to see its variables')); }
    cols.appendChild(c2);
    // Watch
    var c3 = el('div', 'col');
    c3.appendChild(el('h6', '', 'Watch'));
    ((s && s.watches) || []).forEach(function (w, i) {
      var r = el('div', 'row');
      r.appendChild(el('span', 'k', w.expression));
      r.appendChild(el('span', 'v', w.ok === false ? '(' + w.value + ')' : w.value));
      var x = el('span', 't', '×'); x.style.cursor = 'pointer';
      x.onclick = async function () { var list = s.watches.map(function (q) { return q.expression; }); list.splice(i, 1); after(await api('/api/debug/watches', { watches: list })); };
      r.appendChild(x);
      c3.appendChild(r);
    });
    var add = document.createElement('input');
    add.placeholder = 'add a watch expression';
    add.style.cssText = 'margin:4px 10px;width:calc(100% - 20px);background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:3px 7px;font-family:var(--mono);font-size:12px';
    add.onkeydown = async function (e) {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      var list = ((s && s.watches) || []).map(function (q) { return q.expression; }).concat([add.value.trim()]);
      add.value = '';
      after(await api('/api/debug/watches', { watches: list }));
    };
    c3.appendChild(add);
    cols.appendChild(c3);
    box.appendChild(cols);

    // Debug console
    var cons = el('div', 'cons');
    var out = el('div', 'out');
    ((s && s.output) || []).slice(-120).forEach(function (o) {
      out.appendChild(el('div', o.category === 'stderr' ? 'err' : o.category === 'repl' ? 'repl' : '', o.text.replace(/\n$/, '')));
    });
    cons.appendChild(out);
    var inp = document.createElement('input');
    inp.placeholder = paused ? 'evaluate in the paused frame' : 'the debug console evaluates while paused';
    inp.disabled = !paused;
    inp.onkeydown = async function (e) { if (e.key === 'Enter' && inp.value.trim()) { var q = inp.value.trim(); inp.value = ''; after(await api('/api/debug/evaluate', { expression: q })); } };
    cons.appendChild(inp);
    box.appendChild(cons);
    body.appendChild(box);
    out.scrollTop = out.scrollHeight;
  }

  /**
   * RUN AND DEBUG, THE SIDE VIEW (Phase 8.2): what to debug, the controls, then
   * Variables · Watch · Call Stack · Breakpoints stacked as a debugger shows them.
   * Only adapters this machine can run start anything; the rest say why.
   */
  function renderSide(box) {
    sideEl = box;
    box.textContent = '';
    if (!D.status) { box.appendChild(el('div', 'obs', 'Reading the debugger\u2026')); refresh().then(redraw); return; }
    var s = session();
    var paused = s && s.state === 'PAUSED';
    var sec = function (title) { box.appendChild(el('div', 'scm-head', title)); };
    sec('Debug');
    var cfg = el('div', 'dbgcfg');
    var prog = document.createElement('input');
    prog.placeholder = currentFile() || 'program to debug (a file in the project)';
    prog.value = D.program || '';
    prog.oninput = function () { D.program = prog.value.trim(); };
    cfg.appendChild(prog);
    var sel = document.createElement('select');
    var auto = el('option', '', 'Adapter: by file type'); auto.value = ''; sel.appendChild(auto);
    (D.status.adapters || []).forEach(function (a) {
      var o = el('option', '', a.name + (a.available ? '' : ' \u2014 unavailable'));
      o.value = a.id; o.disabled = !a.available; o.title = a.why || '';
      if (D.adapter === a.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { D.adapter = sel.value; };
    cfg.appendChild(sel);
    box.appendChild(cfg);
    var bar = el('div', 'dbgbar');
    bar.appendChild(btn(paused ? '\u25b6 Continue' : '\u25b6 Start', paused ? 'Continue (F5)' : 'Start debugging (F5)', startOrContinue, live() && !paused));
    bar.appendChild(btn('Step Over', 'F10', function () { control('next'); }, !paused));
    bar.appendChild(btn('Into', 'Step Into (F11)', function () { control('stepIn'); }, !paused));
    bar.appendChild(btn('Out', 'Step Out (Shift+F11)', function () { control('stepOut'); }, !paused));
    bar.appendChild(btn('Pause', 'Pause', function () { control('pause'); }, !(s && s.state === 'RUNNING')));
    bar.appendChild(btn('Stop', 'Shift+F5', stop, !live()));
    box.appendChild(bar);
    box.appendChild(el('div', 'dbgst' + (paused ? ' paused' : ''), s ? (s.program + ' \u00b7 ' + s.state.toLowerCase() + (paused && s.stopped ? ' (' + s.stopped.reason + ')' : '') + (s.why && !live() ? ' \u2014 ' + s.why : '')) : 'No debug session. Set breakpoints in the editor gutter (F9), then Start.'));
    var unavailable = (D.status.adapters || []).filter(function (a) { return !a.available; });
    if (unavailable.length) box.appendChild(el('div', 'none', unavailable.map(function (a) { return a.name + ': ' + a.why; }).join(' \u00b7 ')));
    sec('Variables');
    var vars = el('div', 'dbgsec');
    ((s && s.scopes) || []).forEach(function (sc) {
      vars.appendChild(el('div', 'dbgscope', sc.name));
      (sc.variables || []).forEach(function (v) { varRow(vars, v, 0); });
    });
    if (!s || !s.scopes || !s.scopes.length) vars.appendChild(el('div', 'none', paused ? 'none' : 'Pause the program to see its variables.'));
    box.appendChild(vars);
    sec('Watch');
    var wbox = el('div', 'dbgsec');
    ((s && s.watches) || []).forEach(function (w, i) {
      var r = el('div', 'row');
      r.appendChild(el('span', 'k', w.expression));
      r.appendChild(el('span', 'v', w.ok === false ? '(' + w.value + ')' : w.value));
      var x = el('span', 't', '\u00d7'); x.style.cursor = 'pointer';
      x.onclick = async function () { var list = s.watches.map(function (q) { return q.expression; }); list.splice(i, 1); after(await api('/api/debug/watches', { watches: list })); };
      r.appendChild(x);
      wbox.appendChild(r);
    });
    var add = document.createElement('input');
    add.className = 'dbgadd';
    add.placeholder = 'Add a watch expression';
    add.onkeydown = async function (e) {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      var list = ((s && s.watches) || []).map(function (q) { return q.expression; }).concat([add.value.trim()]);
      add.value = '';
      after(await api('/api/debug/watches', { watches: list }));
    };
    wbox.appendChild(add);
    box.appendChild(wbox);
    sec('Call Stack');
    var cs = el('div', 'dbgsec');
    ((s && s.stack) || []).forEach(function (f) {
      var r = el('div', 'row click' + (f.id === s.frameId ? ' on' : ''));
      r.appendChild(el('span', 'v', f.name));
      r.appendChild(el('span', 't', (f.path || '?') + ':' + f.line));
      r.onclick = async function () { after(await api('/api/debug/frame', { frameId: f.id })); if (f.path) L.source.openFile(f.path, { line: f.line }); };
      cs.appendChild(r);
    });
    if (!s || !s.stack || !s.stack.length) cs.appendChild(el('div', 'none', paused ? 'no frames' : 'Not paused.'));
    box.appendChild(cs);
    sec('Breakpoints');
    var bp = el('div', 'dbgsec');
    ((D.status && D.status.breakpoints) || []).forEach(function (b) {
      b.lines.forEach(function (n) {
        var r = el('div', 'row click');
        r.appendChild(el('span', 'v', b.file + ':' + n));
        var x = el('span', 't', '\u00d7'); x.title = 'Remove';
        x.onclick = function (e) { e.stopPropagation(); toggleBreakpoint(b.file, n); };
        r.appendChild(x);
        r.onclick = function () { L.source.openFile(b.file, { line: n }); };
        bp.appendChild(r);
      });
    });
    if (!((D.status && D.status.breakpoints) || []).length) bp.appendChild(el('div', 'none', 'Click in the editor gutter or press F9.'));
    box.appendChild(bp);
  }

  /** THE DEBUG CONSOLE — the program's output, and expressions evaluated in the paused frame. */
  function renderConsole(body) {
    consoleEl = body;
    body.textContent = '';
    if (!D.status) { body.appendChild(el('div', 'obs', 'Reading the debugger\u2026')); refresh().then(redraw); return; }
    var s = session();
    var paused = s && s.state === 'PAUSED';
    var cons = el('div', 'dbgcons');
    var out = el('div', 'out');
    ((s && s.output) || []).slice(-200).forEach(function (o) {
      out.appendChild(el('div', o.category === 'stderr' ? 'err' : o.category === 'repl' ? 'repl' : '', o.text.replace(/\n$/, '')));
    });
    if (!s || !(s.output || []).length) out.appendChild(el('div', 'none', s ? 'No output yet.' : 'Start a debug session from Run and Debug (Ctrl+Shift+D) or press F5.'));
    cons.appendChild(out);
    var inp = document.createElement('input');
    inp.placeholder = paused ? 'Evaluate in the paused frame' : 'Evaluates while the program is paused';
    inp.disabled = !paused;
    inp.onkeydown = async function (e) { if (e.key === 'Enter' && inp.value.trim()) { var q = inp.value.trim(); inp.value = ''; after(await api('/api/debug/evaluate', { expression: q })); } };
    cons.appendChild(inp);
    body.appendChild(cons);
    out.scrollTop = out.scrollHeight;
  }

  function varRow(parent, v, depth) {
    var r = el('div', 'row' + (v.ref ? ' click' : ''));
    r.style.paddingLeft = (10 + depth * 14) + 'px';
    r.appendChild(el('span', 'k', (v.ref ? (D.expanded[v.ref] ? '▾ ' : '▸ ') : '') + v.name));
    r.appendChild(el('span', 'v', v.value));
    if (v.type) r.appendChild(el('span', 't', v.type));
    parent.appendChild(r);
    if (v.ref) {
      r.onclick = async function () {
        if (D.expanded[v.ref]) { delete D.expanded[v.ref]; redraw(); return; }
        var x = await api('/api/debug/expand', { ref: v.ref });
        D.expanded[v.ref] = (x && x.variables) || [];
        redraw();
      };
      if (D.expanded[v.ref] && depth < 3) D.expanded[v.ref].forEach(function (c) { varRow(parent, c, depth + 1); });
    }
  }

  /** A launch configuration's program, with a named adapter. */
  async function startProgram(program, adapter) {
    D.program = program; D.adapter = adapter || '';
    if (L.ide && L.ide.showPanel) L.ide.showPanel('DEBUG');
    after(await api('/api/debug/start', { program: program, adapter: adapter || null }));
    schedule();
  }
  L.debug = { renderPanel: renderPanel, renderSide: renderSide, renderConsole: renderConsole, start: startOrContinue, startProgram: startProgram, adapters: function () { return (D.status && D.status.adapters) || []; }, toggleBreakpoint: toggleBreakpoint, refresh: refresh, busy: function (b) { return Boolean(b && document.activeElement && b.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'); } };

  L.onBoot(function () {
    document.addEventListener('keydown', function (e) {
      if (L.nav.tab() !== 'ide') return;
      var k = e.key;
      if (k === 'F5' && !e.shiftKey) { e.preventDefault(); if (L.ide && L.ide.showPanel) L.ide.showPanel('DEBUG'); if (L.ide && L.ide.showPane) L.ide.showPane('run', true); startOrContinue(); }
      else if (k === 'F5' && e.shiftKey) { e.preventDefault(); stop(); }
      else if (k === 'F9') { e.preventDefault(); var c = L.source.cursor && L.source.cursor(); if (c) toggleBreakpoint(currentFile(), c.line); }
      else if (k === 'F10') { e.preventDefault(); control('next'); }
      else if (k === 'F11' && !e.shiftKey) { e.preventDefault(); control('stepIn'); }
      else if (k === 'F11' && e.shiftKey) { e.preventDefault(); control('stepOut'); }
    });
    L.nav.onShow('ide', function () { setTimeout(function () { hookEditor(); refresh(); }, 300); });
  });
  L.onRender(function () { hookEditor(); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
