'use strict';

/**
 * THE IDE'S SIDE PANES AND PROBLEMS — Search, Source Control, Run, Problems.
 *
 * ------------------------------------------------------------------------
 * EACH DRAWS AN OWNER, NONE IS ONE.
 *
 *   Search          POST /api/files/search, /api/files/replace (fileops.js):
 *                   the model's own walker and binary sniff, so the panel and
 *                   the BOT agree about what a project contains
 *   Source Control  POST /api/git/* (gitops.js) — git's porcelain, nothing
 *                   remembered here; diffs open in Monaco's diff editor
 *   Run             the project's own .vscode/tasks.json and package.json
 *                   scripts, run in the IDE terminal where their output is
 *                   what the BOT reads when asked "why did that fail"
 *   Problems        LAIN.editor.problems(): the editor's language services and
 *                   Core's syntax checks
 *
 * The familiar geometry — a query box with Aa / ab / .* toggles, results
 * grouped by file, a commit box over staged and unstaged lists — is VS Code's,
 * on purpose.
 */

const CSS = `
.pane-pad{padding:6px 10px 10px}
.srch-row{display:flex;align-items:center;gap:4px;margin-bottom:5px}
.srch-row input{flex:1;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:4px 7px;font-size:12.5px;min-width:0}
.srch-row input:focus{border-color:var(--accent-border)}
.tg{width:22px;height:22px;border-radius:3px;font-size:11px;color:var(--text-muted);font-family:var(--mono);flex:none}
.tg[aria-pressed=true]{background:var(--selection);color:var(--accent-primary);box-shadow:inset 0 0 0 1px var(--accent-border)}
.srch-sum{font-size:11.5px;color:var(--text-muted);padding:2px 2px 6px;display:flex;gap:8px;align-items:center}
.srch-sum .spacer{flex:1}
.rfile{display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:3px 10px;font-size:12.5px;color:var(--text-primary)}
.rfile:hover{background:var(--surface-active)}
.rfile small{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfile .n{margin-left:auto;font-size:10.5px;color:var(--text-secondary);background:var(--surface-active);border-radius:8px;padding:0 6px}
.rline{display:block;width:100%;text-align:left;padding:2px 10px 2px 28px;font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)}
.rline:hover{background:var(--surface-active);color:var(--text-primary)}
.rline mark{background:#8f9bff33;color:var(--text-primary);border-radius:2px}
.scm-box textarea{width:100%;min-height:54px;resize:vertical;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:6px 8px;font-size:12.5px;display:block}
.scm-box textarea:focus{border-color:var(--accent-border)}
.scm-head{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);font-weight:600;padding:10px 10px 4px}
.scm-head .n{font-size:10.5px;color:var(--text-secondary);background:var(--surface-active);border-radius:8px;padding:0 6px;letter-spacing:0}
.scm-head .spacer{flex:1}
.scm-row{display:flex;align-items:center;gap:6px;padding:2px 6px 2px 10px;font-size:12.5px}
.scm-row:hover{background:var(--surface-active)}
.scm-row .f{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)}
.scm-row .f small{color:var(--text-muted);margin-left:6px}
.scm-row .st{width:14px;text-align:center;font-family:var(--mono);font-size:11px;font-weight:700}
.scm-row .st.modified{color:var(--warning)} .scm-row .st.added,.scm-row .st.untracked{color:var(--positive)} .scm-row .st.deleted,.scm-row .st.conflict{color:var(--danger)} .scm-row .st.renamed{color:var(--accent-primary)}
.scm-row .a{opacity:0;color:var(--text-muted);width:20px;height:20px;border-radius:3px;font-size:14px;line-height:1}
.scm-row:hover .a{opacity:1}
.scm-row .a:hover{color:var(--text-primary);background:var(--surface-raised)}
.scm-branch{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);padding:0 10px 6px}
.run-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:4px 10px;font-size:12.5px}
.run-row:hover{background:var(--surface-active)}
.run-row small{color:var(--text-muted);font-family:var(--mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto;max-width:55%}
.prob{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;padding:2px 4px;font-size:12.5px;color:var(--text-primary)}
.prob:hover{background:var(--surface-active)}
.prob .sv{width:14px;flex:none;font-weight:700;font-size:11px}
.prob .sv.error{color:var(--danger)} .prob .sv.warning{color:var(--warning)} .prob .sv.info,.prob .sv.hint{color:var(--accent-primary)}
.prob .loc{color:var(--text-muted);font-size:11.5px;font-family:var(--mono);flex:none}
.prob .src2{color:var(--text-muted);font-size:11px;flex:none}
.prob .msg2{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.diffhost{position:absolute;inset:0;z-index:4;display:grid;grid-template-rows:auto 1fr;background:var(--canvas)}
.diffbar{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--separator)}
.diffbar .spacer{flex:1}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;

  function tg(label, title, on, flip) {
    var b = el('button', 'tg', label);
    b.title = title;
    b.setAttribute('aria-pressed', String(on));
    b.onclick = function () { flip(); b.setAttribute('aria-pressed', String(!on)); on = !on; };
    return b;
  }
  function input(ph, value) { var i = document.createElement('input'); i.placeholder = ph; i.value = value || ''; i.spellcheck = false; return i; }

  // ---- SEARCH --------------------------------------------------------------------------------
  var S = { q: '', rep: '', inc: '', exc: '', cs: false, ww: false, rx: false, res: null, busy: false, showRep: false, collapsed: {} };
  function history() { try { return JSON.parse(localStorage.getItem('lain.searchHistory') || '[]'); } catch (e) { return []; } }
  function remember(q) { try { var h = history().filter(function (x) { return x !== q; }); h.unshift(q); localStorage.setItem('lain.searchHistory', JSON.stringify(h.slice(0, 15))); } catch (e) { /* storage unavailable */ } }

  var seq = 0;
  async function run() {
    var mine = ++seq;
    if (!S.q) { S.res = null; drawSearch(); return; }
    S.busy = true; drawSearchSummary();
    var r = await L.api('/api/files/search', { query: S.q, regex: S.rx, caseSensitive: S.cs, wholeWord: S.ww, include: S.inc, exclude: S.exc });
    if (mine !== seq) return;
    S.busy = false;
    S.res = r;
    if (r && r.ok && r.total) remember(S.q);
    drawSearch();
  }
  var timer = 0;
  function soon() { clearTimeout(timer); timer = setTimeout(run, 300); }

  var host = null;
  function mountSearch(box) {
    host = box;
    box.textContent = '';
    var pad = el('div', 'pane-pad');
    var r1 = el('div', 'srch-row');
    var q = input('Search', S.q);
    q.id = 'paneSearchQ';
    q.oninput = function () { S.q = q.value; soon(); };
    q.onkeydown = function (e) {
      if (e.key === 'Enter') run();
      if (e.key === 'ArrowUp' && !q.value) { var h = history(); if (h.length) { q.value = h[0]; S.q = h[0]; run(); } }
    };
    r1.appendChild(q);
    r1.appendChild(tg('Aa', 'Match case', S.cs, function () { S.cs = !S.cs; run(); }));
    r1.appendChild(tg('ab', 'Match whole word', S.ww, function () { S.ww = !S.ww; run(); }));
    r1.appendChild(tg('.*', 'Use regular expression', S.rx, function () { S.rx = !S.rx; run(); }));
    pad.appendChild(r1);
    var r2 = el('div', 'srch-row');
    var rep = input('Replace', S.rep);
    rep.oninput = function () { S.rep = rep.value; };
    r2.appendChild(rep);
    var all = el('button', 'tg', '↻');
    all.title = 'Replace all in the files listed';
    all.onclick = replaceAll;
    r2.appendChild(all);
    pad.appendChild(r2);
    var r3 = el('div', 'srch-row');
    var inc = input('files to include, e.g. src/**/*.ts', S.inc);
    inc.oninput = function () { S.inc = inc.value; soon(); };
    r3.appendChild(inc);
    pad.appendChild(r3);
    var r4 = el('div', 'srch-row');
    var exc = input('files to exclude', S.exc);
    exc.oninput = function () { S.exc = exc.value; soon(); };
    r4.appendChild(exc);
    pad.appendChild(r4);
    var sum = el('div', 'srch-sum');
    sum.id = 'srchSum';
    pad.appendChild(sum);
    box.appendChild(pad);
    var list = el('div', '');
    list.id = 'srchList';
    box.appendChild(list);
    drawSearch();
  }
  function drawSearchSummary() {
    var sum = document.getElementById('srchSum');
    if (!sum) return;
    sum.textContent = '';
    var r = S.res;
    var t = S.busy ? 'Searching…' : !S.q ? '' : !r ? '' : !r.ok ? r.why : r.total ? r.total + ' result' + (r.total === 1 ? '' : 's') + ' in ' + r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + (r.truncated ? ' (first results only)' : '') : 'No results.';
    sum.appendChild(el('span', '', t));
  }
  function highlightLine(h) {
    var d = el('span', '');
    var text = h.text;
    var a = Math.max(0, h.col - 1 - 30);
    var pre = (a ? '…' : '') + text.slice(a, h.col - 1);
    d.appendChild(document.createTextNode(pre));
    d.appendChild(el('mark', '', text.slice(h.col - 1, h.col - 1 + h.len)));
    d.appendChild(document.createTextNode(text.slice(h.col - 1 + h.len)));
    return d;
  }
  function drawSearch() {
    drawSearchSummary();
    var list = document.getElementById('srchList');
    if (!list) return;
    list.textContent = '';
    var r = S.res;
    if (!r || !r.ok) return;
    r.files.forEach(function (f) {
      var fr = el('button', 'rfile');
      fr.appendChild(el('span', '', f.path.split('/').pop()));
      fr.appendChild(el('small', '', f.path));
      fr.appendChild(el('span', 'n', f.hits.length));
      fr.onclick = function () { S.collapsed[f.path] = !S.collapsed[f.path]; drawSearch(); };
      list.appendChild(fr);
      if (S.collapsed[f.path]) return;
      f.hits.slice(0, 200).forEach(function (h) {
        var b = el('button', 'rline');
        b.appendChild(highlightLine(h));
        b.title = f.path + ':' + h.line;
        b.onclick = function () { L.source.openFile(f.path, { line: h.line }); };
        list.appendChild(b);
      });
    });
  }
  async function replaceAll() {
    var r = S.res;
    if (!r || !r.ok || !r.total) return;
    var dirty = L.source.state().open.filter(function (f) { return f.dirty && r.files.some(function (x) { return x.path === f.path; }); });
    if (dirty.length) return L.toast('Save ' + dirty[0].path + ' before replacing in it.', true);
    var yes = await L.confirm('Replace ' + r.total + ' occurrence' + (r.total === 1 ? '' : 's') + ' of “' + S.q + '” with “' + S.rep + '” in ' + r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + '?', { ok: 'Replace all' });
    if (!yes) return;
    var out = await L.api('/api/files/replace', { query: S.q, replacement: S.rep, regex: S.rx, caseSensitive: S.cs, wholeWord: S.ww, files: r.files.map(function (f) { return { path: f.path, hash: f.hash }; }) });
    if (!out.ok) return L.toast(out.why, true);
    L.toast('Replaced ' + out.total + ' in ' + out.replaced.length + ' file' + (out.replaced.length === 1 ? '' : 's') + (out.skipped.length ? ' — skipped ' + out.skipped.length + ' that changed' : ''));
    L.source.refresh(true);
    run();
  }
  /** Search for something from elsewhere (Find All References, the palette). */
  function searchFor(q, opts) {
    S.q = q; S.cs = Boolean(opts && opts.caseSensitive); S.ww = Boolean(opts && opts.wholeWord); S.rx = Boolean(opts && opts.regex);
    L.ide.showPane('search', true);
    if (host) mountSearch(host);
    run();
  }

  // ---- SOURCE CONTROL -------------------------------------------------------------------
  var G = { st: null, busy: false, msg: '', again: false, inflight: null };
  /**
   * ONE `git status` AT A TIME. Pane switches, window focus, stage and commit each ask for a
   * refresh; asked while one runs, they fold into ONE more run after it — with 171 changes a
   * status is the expensive part, and two at once bought nothing. Diffs are never read here:
   * a file's diff is fetched when it is opened.
   */
  async function refreshScm() {
    if (G.inflight) { G.again = true; return G.inflight; }
    G.busy = true;
    G.inflight = (async function () {
      try {
        do { G.again = false; G.st = await L.api('/api/git/status', {}); } while (G.again);
        return G.st;
      } finally { G.busy = false; G.inflight = null; }
    })();
    var r = await G.inflight;
    drawScm();
    if (L.ide && L.ide.gitChanged) L.ide.gitChanged(r);
    return r;
  }
  var scmHost = null;
  function mountScm(box) { scmHost = box; drawScm(); refreshScm(); }
  function letter(f) { return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!', copied: 'C' }[f.state] || 'M'; }
  function row(f, staged) {
    var r = el('div', 'scm-row');
    var b = el('button', 'f', f.path.split('/').pop());
    b.appendChild(el('small', '', f.path));
    b.title = f.path + (f.from ? ' (from ' + f.from + ')' : '');
    b.onclick = function () { openDiff(f.path, staged); };
    r.appendChild(b);
    var open = el('button', 'a', '↗');
    open.title = 'Open file';
    open.onclick = function () { L.source.openFile(f.path); };
    r.appendChild(open);
    var act = el('button', 'a', staged ? '−' : '+');
    act.title = staged ? 'Unstage' : 'Stage';
    act.onclick = async function () {
      var x = await L.api(staged ? '/api/git/unstage' : '/api/git/stage', { paths: [f.path] });
      if (!x.ok) L.toast(x.why, true);
      refreshScm();
    };
    r.appendChild(act);
    r.appendChild(el('span', 'st ' + f.state, letter(f)));
    return r;
  }
  function drawScm() {
    var box = scmHost;
    if (!box) return;
    box.textContent = '';
    var st = G.st;
    if (!st) { box.appendChild(el('div', 'none', 'Reading git…')); return; }
    if (!st.ok) { box.appendChild(el('div', 'none', st.why)); return; }
    if (!st.repo) { box.appendChild(el('div', 'none', 'This project is not a git repository.')); return; }
    var br = el('div', 'scm-branch');
    br.appendChild(L.icon('changes', 13));
    br.appendChild(el('span', '', st.branch || '(no branch)'));
    if (st.ahead || st.behind) br.appendChild(el('span', '', '↑' + (st.ahead || 0) + ' ↓' + (st.behind || 0)));
    var sw = el('button', 'a', '…');
    sw.title = 'Switch branch';
    sw.style.opacity = '1';
    sw.onclick = switchBranch;
    br.appendChild(el('span', 'spacer'));
    br.appendChild(sw);
    box.appendChild(br);
    var cb = el('div', 'pane-pad scm-box');
    var ta = document.createElement('textarea');
    ta.placeholder = 'Message (Ctrl+Enter to commit)';
    ta.value = G.msg;
    ta.oninput = function () { G.msg = ta.value; };
    ta.onkeydown = function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commit(); };
    cb.appendChild(ta);
    var staged = st.files.filter(function (f) { return f.staged; });
    var changes = st.files.filter(function (f) { return f.unstaged || f.state === 'untracked'; });
    var cm = el('button', 'btn small primary', 'Commit' + (staged.length ? ' (' + staged.length + ')' : ''));
    cm.style.marginTop = '6px';
    cm.disabled = !staged.length;
    cm.onclick = commit;
    cb.appendChild(cm);
    box.appendChild(cb);
    var section = function (title, list, isStaged) {
      var h = el('div', 'scm-head');
      h.appendChild(el('span', '', title));
      h.appendChild(el('span', 'n', list.length));
      h.appendChild(el('span', 'spacer'));
      if (list.length) {
        var all = el('button', 'a', isStaged ? '−' : '+');
        all.style.opacity = '1';
        all.title = isStaged ? 'Unstage all' : 'Stage all';
        all.onclick = async function () { var x = await L.api(isStaged ? '/api/git/unstage' : '/api/git/stage', { paths: list.map(function (f) { return f.path; }) }); if (!x.ok) L.toast(x.why, true); refreshScm(); };
        h.appendChild(all);
      }
      box.appendChild(h);
      list.forEach(function (f) { box.appendChild(row(f, isStaged)); });
    };
    if (staged.length) section('Staged Changes', staged, true);
    section('Changes', changes, false);
    // THIS SESSION'S OWN EDITS, from Core's checkpoint ledger — what LAIN
    // changed, which git alone cannot tell apart from the person's edits.
    var S2 = L.state();
    var mine = (S2 && S2.changes) || [];
    if (mine.length) {
      var h2 = el('div', 'scm-head');
      h2.appendChild(el('span', '', 'Changed by Noema this session'));
      h2.appendChild(el('span', 'n', mine.length));
      box.appendChild(h2);
      mine.forEach(function (c) {
        var r = el('div', 'scm-row');
        var b = el('button', 'f', c.path.split('/').pop());
        b.appendChild(el('small', '', c.path + '  +' + (c.added || 0) + ' -' + (c.removed || 0)));
        b.onclick = function () { L.source.openFile(c.path); };
        r.appendChild(b);
        box.appendChild(r);
      });
    }
  }
  async function commit() {
    var m = (G.msg || '').trim();
    if (!m) return L.toast('Write a commit message first.', true);
    var r = await L.api('/api/git/commit', { message: m });
    if (!r.ok) return L.toast(r.why, true);
    G.msg = '';
    L.toast('Committed ' + (r.commit || '') + ' — ' + r.summary);
    refreshScm();
  }
  async function switchBranch() {
    var r = await L.api('/api/git/branches', {});
    if (!r.ok) return L.toast(r.why, true);
    var anchor = scmHost.querySelector('.scm-branch');
    L.popover(anchor, function (p) {
      p.appendChild(el('h4', '', 'Switch branch'));
      r.branches.forEach(function (b) {
        var o = el('button', 'opt', b.name);
        o.setAttribute('aria-selected', String(b.current));
        o.onclick = async function () { L.closePop(); var x = await L.api('/api/git/checkout', { branch: b.name }); if (!x.ok) L.toast(x.why, true); refreshScm(); L.source.refresh(true); };
        p.appendChild(o);
      });
    });
  }

  /** SIDE-BY-SIDE DIFF in Monaco's diff editor: git's version against the file on disk. */
  var diffEd = null;
  async function openDiff(rel, staged) {
    var M = L.editor && L.editor.monaco();
    if (!M) { var d0 = await L.api('/api/git/diff', { path: rel, staged: staged }); L.dialog({ title: rel, text: (d0 && d0.diff) || 'no diff', ok: 'Close', cancel: 'Close' }); return; }
    var base = await L.api('/api/git/show', { path: rel, ref: 'HEAD' });
    var right;
    if (staged) right = await L.api('/api/git/show', { path: rel, ref: ':' });
    else right = await L.api('/api/files/open', { path: rel });
    var host2 = document.getElementById('diffHost');
    if (!host2) {
      host2 = el('div', 'diffhost');
      host2.id = 'diffHost';
      var bar = el('div', 'diffbar');
      bar.id = 'diffBar';
      host2.appendChild(bar);
      var body = el('div', '');
      body.id = 'diffBody';
      host2.appendChild(body);
      document.getElementById('srcEdit').appendChild(host2);
    }
    host2.hidden = false;
    var barEl = document.getElementById('diffBar');
    barEl.textContent = '';
    barEl.appendChild(el('span', '', rel + (staged ? ' (staged vs HEAD)' : ' (working tree vs HEAD)')));
    barEl.appendChild(el('span', 'spacer'));
    var op = el('button', 'btn small', 'Open file');
    op.onclick = function () { host2.hidden = true; L.source.openFile(rel); };
    var cl = el('button', 'btn small', 'Close diff');
    cl.onclick = function () { host2.hidden = true; };
    barEl.appendChild(op);
    barEl.appendChild(cl);
    if (!diffEd) diffEd = M.editor.createDiffEditor(document.getElementById('diffBody'), { theme: 'lain-dark', automaticLayout: true, readOnly: true, renderSideBySide: true, fontFamily: '"Cascadia Code",Consolas,monospace', fontSize: 13 });
    var lang = (right && right.mode) || undefined;
    var old = diffEd.getModel();
    diffEd.setModel({
      original: M.editor.createModel((base && base.text) || '', lang),
      modified: M.editor.createModel((right && (right.text != null ? right.text : right.body)) || '', lang),
    });
    if (old) { old.original.dispose(); old.modified.dispose(); }
  }

  // ---- RUN: the project's own tasks and scripts --------------------------------------
  var R = { vscode: null, scripts: null };
  var runHost = null;
  async function mountRun(box) {
    runHost = box;
    drawRun();
    var v = await L.api('/api/workspace/vscode', {});
    R.vscode = v && v.ok ? v : null;
    var pj = await L.api('/api/files/open', { path: 'package.json' });
    try { R.scripts = pj && pj.ok ? (JSON.parse(pj.body).scripts || {}) : {}; } catch (e) { R.scripts = {}; }
    drawRun();
  }
  function runCommand(cmd) {
    if (!L.terminal || !L.terminal.run) return L.toast('The terminal is not available.', true);
    L.terminal.run(cmd);
  }
  function drawRun() {
    var box = runHost;
    if (!box) return;
    box.textContent = '';
    var scripts = R.scripts || {};
    var names = Object.keys(scripts);
    var head = function (t) { box.appendChild(el('div', 'scm-head', t)); };
    // THE DEBUGGER FIRST (Phase 8.2): Run and Debug is a real activity — configuration, controls,
    // Variables, Watch, Call Stack, Breakpoints (pagedebug.js). What runs without a debugger follows.
    if (L.debug && L.debug.renderSide) { var dbg = el('div', 'dbgside'); box.appendChild(dbg); L.debug.renderSide(dbg); }
    head('Run \u00b7 package.json scripts');
    if (!R.scripts) box.appendChild(el('div', 'none', 'Reading…'));
    else if (!names.length) box.appendChild(el('div', 'none', 'No scripts.'));
    names.forEach(function (n) {
      var b = el('button', 'run-row');
      b.appendChild(L.icon('arrow', 13));
      b.appendChild(el('span', '', n));
      b.appendChild(el('small', '', scripts[n]));
      b.title = 'npm run ' + n;
      b.onclick = function () { runCommand('npm run ' + n); };
      box.appendChild(b);
    });
    var v = R.vscode;
    if (v && v.present) {
      head('Tasks (.vscode/tasks.json)');
      if (!v.tasks.length) box.appendChild(el('div', 'none', 'No tasks.'));
      v.tasks.forEach(function (t) {
        var b = el('button', 'run-row');
        b.appendChild(L.icon('arrow', 13));
        b.appendChild(el('span', '', t.label || t.command));
        b.appendChild(el('small', '', t.command || t.type));
        b.disabled = !t.command || (t.type && t.type !== 'shell' && t.type !== 'process');
        b.title = b.disabled ? 'Only shell and process tasks run here' : t.command;
        b.onclick = function () { runCommand(t.command); };
        box.appendChild(b);
      });
      if (v.launch.length) {
        head('Launch configurations (.vscode/launch.json)');
        // A CONFIGURATION STARTS ONLY WHERE AN ADAPTER THIS MACHINE CAN RUN MATCHES ITS TYPE — the rest say why.
        var ads = (L.debug && L.debug.adapters) ? L.debug.adapters() : [];
        v.launch.forEach(function (c) {
          var ad = ads.filter(function (a) { return (a.types || [a.id]).indexOf(c.type) >= 0 || a.id === c.type; })[0];
          var ok = Boolean(ad && ad.available && c.program);
          var r = el('button', 'run-row');
          r.appendChild(L.icon(ok ? 'play' : 'warn', 13));
          r.appendChild(el('span', '', c.name));
          r.appendChild(el('small', '', ok ? c.type + ' \u00b7 ' + String(c.program).replace('${workspaceFolder}/', '') : (c.type + ' \u00b7 ' + (ad ? (ad.available ? 'no program in this configuration' : ad.why) : 'no ' + c.type + ' debug adapter on this machine'))));
          r.disabled = !ok;
          r.onclick = function () { if (L.debug && L.debug.startProgram) L.debug.startProgram(String(c.program).replace('${workspaceFolder}/', ''), ad.id); };
          box.appendChild(r);
        });
      }
      if (v.recommendations.length) {
        head('Recommended extensions');
        v.recommendations.forEach(function (id) {
          var b = el('button', 'run-row');
          b.appendChild(el('span', '', id));
          b.appendChild(el('small', '', 'open in Extensions'));
          b.onclick = function () { if (L.ide && L.ide.showPane) L.ide.showPane('extensions', true); if (L.extensions) L.extensions.find(id); };
          box.appendChild(b);
        });
      }
    }
  }

  // ---- PROBLEMS -----------------------------------------------------------------------------
  function problemsPanel(body) {
    var list = L.editor ? L.editor.problems() : [];
    body.textContent = '';
    if (!list.length) { body.appendChild(el('div', 'obs', 'No problems have been detected in the open files.')); return; }
    list.forEach(function (p) {
      var b = el('button', 'prob');
      b.appendChild(el('span', 'sv ' + p.severity, p.severity === 'error' ? '✕' : p.severity === 'warning' ? '!' : 'i'));
      b.appendChild(el('span', 'msg2', p.message));
      b.appendChild(el('span', 'src2', p.source || ''));
      b.appendChild(el('span', 'loc', p.path + ':' + p.line + ':' + p.col));
      b.onclick = function () { L.source.openFile(p.path, { line: p.line }); };
      body.appendChild(b);
    });
  }
  function counts() {
    var list = L.editor ? L.editor.problems() : [];
    return { errors: list.filter(function (p) { return p.severity === 'error'; }).length, warnings: list.filter(function (p) { return p.severity === 'warning'; }).length };
  }

  L.panes = {
    mountSearch: mountSearch, searchFor: searchFor, mountScm: mountScm, refreshScm: refreshScm, mountRun: mountRun,
    problemsPanel: problemsPanel, counts: counts, openDiff: openDiff, git: function () { return G.st; },
  };
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
