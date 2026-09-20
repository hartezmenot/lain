'use strict';

/**
 * THE APPLICATION'S BEHAVIOUR — lanes, sessions, conversation, composer, picker.
 *
 * ------------------------------------------------------------------------
 * IT HOLDS UI STATE AND NOTHING ELSE.
 *
 * `LAIN.ui` is which lane is showing, which drawer is open, what is typed, and
 * the session token. Every FACT — the sessions, the conversation, the changes,
 * the verification, the model sources, the Workshop — arrives from
 * `/api/state` and is re-rendered from it.
 *
 * So there is no client-side model of the session to fall out of step with the
 * real one, and the terminal and this window cannot disagree: they are two
 * renderings of the same `App`, in the same process.
 *
 * ------------------------------------------------------------------------
 * THE POLL IS THE ONLY CLOCK.
 *
 * A turn runs for minutes; `POST /api/turn` returns as soon as it is accepted
 * and the answer appears in a later poll. Nothing here counts elapsed time
 * itself — the activity row renders what the Harness reports, because inventing
 * a "thinking" animation on a timer is exactly the fake state the design
 * forbids.
 */

/** Emitted into the page inside a `<script>`; it is JS, not a template. */
function js() {
  return `
window.LAIN = (function () {
  'use strict';
  var S = null;                    // the last state from the server
  var ui = {
    lane: 'engineering',
    // THERE IS NOTHING TO BE CONNECTED *AS*. The page runs inside LAIN's own
    // window over a pipe LAIN authenticated at launch; it holds no credential,
    // stores none, and has never had anything to type.
    busy: false,
    pollMs: 1500,
    // CHAT / CODING, WHICH PANEL IS OPEN, AND THE PLAN PROMPT are Core state
    // now (S.views.active, S.workspace.openPanel, S.plans.prompt — see
    // docs/HARNESS_UI_CONTRACT.md). LAIN.source and LAIN.plan keep their own
    // small paint-only bookkeeping (has this panel already loaded its root,
    // has this handoff's prefill already landed in the composer).
  };

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function esc(s) { return String(s == null ? '' : s); }
  /** ms -> "mm:ss". The one clock format in the product; see the crumb and the rail. */
  function fmtElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60), sec = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // WHAT A LIVE SESSION'S DOT LOOKS LIKE. Five states, one glyph each, no
  // animation — see the CSS note in page.js. The words are sessionpool.js's.
  var MARK = { RUNNING: '\\u25cf', WAITING: '\\u25d0', DONE: '\\u2713', STOPPED: '!', IDLE: '\\u25cb' };

  // ---- talking to Core -------------------------------------------------
  //
  // THE ONLY PLACE THE UI KNOWS WHAT IT IS RUNNING INSIDE, and there is now
  // exactly one answer. Everything above this function - sessions, lanes, the
  // composer, Cowork, the Workshop, the Computer card - is written against
  // api(path, body) and nothing else.
  //
  // THERE IS NO ORIGIN, NO COOKIE AND NO PORT. The native host holds a private
  // pipe to Core and relays this call over it (native/host.cs,
  // harnessapp/ipc.js). window.chrome.webview is how the page reaches the host
  // it is embedded in, and its presence IS the answer to "am I inside LAIN" -
  // nothing is configured and nothing is guessed.
  //
  // THE BROWSER PATH IS GONE (2026-09-15): the same-origin fetch, the session
  // cookie and the 401-reopens-the-gate dance all belonged to a Harness that
  // was a page in somebody's Chrome. A page loaded anywhere else now says so
  // rather than half-working.
  var desk = (typeof window !== 'undefined' && window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  var deskWaiting = {};
  var deskSeq = 0;
  if (desk) {
    desk.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || typeof m !== 'object') return;
      // ---- CORE SAYS ITS STATE MOVED --------------------------------------
      //
      // The poll below is a FALLBACK, not a clock. Without this, an answer that
      // existed at T appeared at up to T + pollMs, and the application looked
      // slower than the work it was reporting. A wake carries no state — the
      // window still reads /api/state, so there is one read model — it only
      // says "look now". See harnessapp/ipc.js wake().
      if (m.wake) { poll(); return; }
      if (m.id == null) return;
      var pending = deskWaiting[m.id];
      if (!pending) return;
      delete deskWaiting[m.id];
      pending(m);
    });
  }

  function deskCall(path, body) {
    return new Promise(function (resolve, reject) {
      var id = ++deskSeq;
      var timer = setTimeout(function () {
        delete deskWaiting[id];
        reject(new Error('the desktop host did not answer'));
      }, 120000);
      deskWaiting[id] = function (m) {
        clearTimeout(timer);
        if (m.error) return reject(new Error(m.error));
        resolve(m.body);
      };
      desk.postMessage({ id: id, method: body === undefined ? 'GET' : 'POST', path: path, body: body || {} });
    });
  }

  async function api(path, body) {
    if (!desk) throw new Error('this page is not running inside LAIN Desktop');
    return deskCall(path, body);
  }

  function notice(text, bad) {
    var n = $('notice');
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.className = 'note' + (bad ? ' bad' : '');
    n.textContent = text;
  }

  // ---- sessions ---------------------------------------------------------
  function renderSessions() {
    var box = $('sessions');
    box.textContent = '';
    var list = (S.sessions && S.sessions[ui.lane]) || [];
    $('asideHead').textContent = ui.lane === 'engineering' ? 'Engineering sessions' : 'Cowork sessions';
    var nw = el('button', 'aside-new', 'New');
    nw.id = 'asideNew';
    nw.onclick = function () { LAIN.cowork.newSession(ui.lane); };
    $('asideHead').appendChild(nw);
    if (!list.length) {
      var e = el('div', 'empty');
      e.textContent = ui.lane === 'engineering'
        ? 'No engineering sessions yet. Ask something to start one.'
        : 'No Cowork sessions. LAIN binds one when work arrives from Telegram, Discord, WhatsApp or here.';
      box.appendChild(e);
      return;
    }
    list.forEach(function (s) {
      var row = el('div', 'sessrow');
      var b = el('button', 'sess');
      b.setAttribute('aria-current', String(!!s.current));
      var p = el('div', 'p', s.project || '(no project)');
      if (s.source && s.source !== 'harness') p.appendChild(el('span', 'src', s.source));
      // ---- WHAT IT IS DOING, WITHOUT BEING IN IT --------------------------
      //
      // The whole reason a person may leave a working session: the row says
      // whether it is still going. Only LIVE sessions carry one — a transcript
      // on disk is not doing anything, and a dot invented for it would be a
      // guess dressed as a reading. s.state is the richer SessionStatus
      // (state, elapsed, summary) stateviews.js now adds; s.status/s.detail
      // are the older sessionpool word, kept for a session neither one covers.
      if (s.status) {
        var dot = el('span', 'sdot ' + s.status, MARK[s.status] || '');
        dot.title = s.status.toLowerCase() + (s.detail ? ' \\u00b7 ' + s.detail : '');
        p.appendChild(dot);
      }
      b.appendChild(p);
      // LINE TWO: the task, not the mechanism — the conversation's own
      // headline, which is the closest honest read of "what this session is
      // for" that exists. Nothing here summarises or guesses at intent.
      b.appendChild(el('div', 't', s.title));
      // LINE THREE: a live row shows its real elapsed time when the richer
      // status carries one ("Running \\u00b7 01:42"); short of that, the old
      // word plus detail; a resting transcript shows when it was last touched.
      // Never more than one of these at once.
      var w = el('div', 'w' + (s.status ? ' ' + s.status : ''));
      if (s.state && s.state.state && s.state.state !== 'IDLE') {
        var word = s.state.state.charAt(0) + s.state.state.slice(1).toLowerCase().replace(/_/g, ' ');
        var bits = [word];
        if (typeof s.state.elapsed === 'number' && s.state.elapsed > 0) bits.push(fmtElapsed(s.state.elapsed));
        else if (s.state.summary) bits.push(s.state.summary);
        w.textContent = bits.join('  \\u00b7  ');
      } else {
        w.textContent = s.status
          ? s.status.charAt(0) + s.status.slice(1).toLowerCase() + (s.detail ? '  \\u00b7  ' + s.detail : '')
          : s.when + (s.turns ? '  \\u00b7  ' + s.turns + ' turns' : '');
      }
      b.appendChild(w);
      // ---- THE ROW IS THE VIEW, NOT THE EXECUTION --------------------------
      //
      // Clicking a session looks at it. It does not stop, start, move or wait
      // for anything: a turn running in another session keeps running, and one
      // running in THIS session was already running before you looked. The
      // server no longer has any state that can refuse this — see
      // sessionroutes.js and src/sessionpool.js.
      b.title = s.current ? 'The session you are viewing' : 'Open this session';
      b.onclick = function () {
        // CHOOSING ONE PUTS THE PANEL AWAY. At narrow widths the rail is an
        // overlay ON the conversation, so leaving it open would cover the very
        // thing you just asked to look at. Harmless at wide widths, where the
        // class means nothing.
        $('main').classList.remove('rail-open');
        $('railBtn').setAttribute('aria-expanded', 'false');
        if (!s.current) LAIN.cowork.resume(s.id);
      };
      row.appendChild(b);
      // CLOSE THE VIEW. Never delete: the conversation stays in /resume and a
      // turn inside it keeps running. The tooltip says so, because a small x on
      // a list is otherwise assumed to destroy things.
      if (s.live && !s.current) {
        var x = el('button', 'sessx', '\\u00d7');
        x.title = 'Close this view. The conversation is kept and any work in it carries on.';
        x.onclick = function (ev) { ev.stopPropagation(); LAIN.cowork.closeSession(s.id); };
        row.appendChild(x);
      }
      // ---- DELETING IS ITS OWN ACTION, NEVER THE CLOSE BUTTON -------------
      //
      // A separate control, a different glyph, and a confirmation that names
      // what is about to go. Overloading the x with delete is how a person
      // tidying their sidebar loses a week of work — so the two are deliberately
      // not the same gesture. The current session has neither: you cannot
      // delete the conversation you are in.
      if (!s.current) {
        var del = el('button', 'sessdel', '\\u2326');
        del.title = 'Delete this conversation permanently.';
        del.onclick = function (ev) {
          ev.stopPropagation();
          var what = (s.project || 'this conversation') + (s.title ? ' \\u2014 ' + s.title : '');
          if (!window.confirm('Delete ' + what + '?\\n\\nThe conversation and its history are removed permanently. This cannot be undone.')) return;
          LAIN.cowork.deleteSession(s.id);
        };
        row.appendChild(del);
      }
      box.appendChild(row);
    });
  }

  // ---- the conversation -------------------------------------------------
  function renderStream() {
    var box = $('stream');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.textContent = '';
    (S.conversation || []).forEach(function (m) {
      var wrap = el('div', 'msg ' + m.role);
      var who = el('div', 'who', m.role === 'user' ? 'You' : 'LAIN');
      // WHO ANSWERED, when it was not LAIN's own runtime. Stamped at execution
      // time and carried on the message — never re-derived from what the picker
      // happens to show now.
      if (m.provenance) who.appendChild(el('span', 'prov', m.provenance.label));
      wrap.appendChild(who);
      wrap.appendChild(el('div', 'body', m.text));
      box.appendChild(wrap);
    });
    var plan = LAIN.plan.buildCard(S);
    if (plan) box.appendChild(plan);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---- activity, from the Harness's own words ---------------------------
  function renderActivity() {
    var h = S.harness;
    var row = $('act');
    if (!h || !h.task) { row.hidden = true; return; }
    var a = h.activity || {};
    var state = String(a.state || h.task.state || '');
    // IDLE IS NOT NEWS. A row reading "idle · operation ended" under a finished
    // conversation is the program narrating its own plumbing.
    if (/^IDLE$/.test(String(a.state || '')) && !/PASSED|FAILED|VERIFYING|BLOCKED/.test(String(h.task.state || ''))) { row.hidden = true; return; }
    row.hidden = false;
    var dot = $('actDot');
    dot.className = 'dot' + (
      /RUNNING|READING|WRITING|THINKING|EXECUTING|OBSERVING|VERIFYING/.test(state) ? ' run'
        : /PASSED/.test(h.task.state) ? ' ok'
        : /FAILED|ERROR/.test(state + h.task.state) ? ' bad'
        : /WAITING|BLOCKED/.test(state) ? ' warn' : '');
    $('actText').textContent = [state.toLowerCase(), a.action, a.target].filter(Boolean).join('  \\u00b7  ')
      || h.task.title || '';
    $('actClock').textContent = '';
  }

  // ---- contextual drawers ----------------------------------------------
  /**
   * WHICH WORKSPACE PANEL IS OPEN — one Core-held value for Project Files,
   * Workshop, Changes, Plan, Terminal and Verification alike
   * (S.workspace.openPanel, docs/HARNESS_UI_CONTRACT.md §7). This function is
   * the single place that reads it and is the only thing allowed to decide
   * what is visible; nothing here keeps its own idea of "which tab is open".
   *
   * Project Files and Workshop get their own composer pills and grid columns
   * (below); Changes/Plan/Terminal/Verification render as the bottom drawer,
   * exactly as before — only their open/closed state moved from client ui
   * state to Core.
   */
  function currentPanel() {
    var codingView = S.current.lane === 'engineering' && S.views && S.views.active === 'coding';
    return { codingView: codingView, ws: codingView ? S.workspace : null };
  }

  async function togglePanel(id) {
    var open = (S.workspace && S.workspace.openPanel) || 'NONE';
    await api('/api/workspace/panel', { action: open === id ? 'close' : 'open', panel: id });
    poll();
  }

  /**
   * PROJECT FILES WITH NOTHING ATTACHED — a session can genuinely have none
   * (docs/HARNESS_UI_CONTRACT.md section 6). Never falls back to LAIN's own
   * folder: with no project, the panel offers Add project instead of a tree.
   */
  async function loadRecentProjects() {
    var box = $('recentProjects');
    box.textContent = '';
    var r = await api('/api/project/recent', {});
    if (!r.ok || !(r.recent || []).length) return;
    var list = el('div', 'recent');
    r.recent.slice(0, 8).forEach(function (p) {
      var b = el('button', '');
      b.appendChild(el('div', '', p.name));
      b.appendChild(el('div', 'path', p.root));
      b.onclick = function () { attachProject(p.root); };
      list.appendChild(b);
    });
    box.appendChild(list);
  }

  async function attachProject(path) {
    var r = await api('/api/project/attach', { path: path });
    if (!r.ok) return notice(r.why, true);
    notice('');
    poll();
  }

  function syncProjectFiles(panelCtx) {
    var open = Boolean(panelCtx.ws && panelCtx.ws.openPanel === 'PROJECT_FILES');
    var attached = Boolean(S.workspace && S.workspace.project && S.workspace.project.attached);
    var showAdd = open && !attached;
    LAIN.source.sync(open && attached);
    $('srcNoProject').hidden = !showAdd;
    $('main').classList.toggle('with-source', open);
    $('codePill').setAttribute('aria-selected', String(open));
    if (showAdd) {
      if (!ui._recentLoaded) { ui._recentLoaded = true; loadRecentProjects(); }
    } else {
      ui._recentLoaded = false;
    }
  }

  var DRAWER_IDS = ['CHANGES', 'PLAN', 'TERMINAL', 'VERIFICATION'];

  function renderDrawers() {
    var bar = $('drawers');
    var body = $('drawer');
    bar.textContent = '';
    var cur = currentPanel();
    var panels = (cur.ws && cur.ws.panels || []).filter(function (p) {
      return DRAWER_IDS.indexOf(p.id) >= 0 && p.available;
    });
    var openPanel = cur.ws ? cur.ws.openPanel : 'NONE';
    if (!panels.length) { body.hidden = true; return; }
    panels.forEach(function (p) {
      var b = el('button', 'tab', p.label);
      if (p.badge != null) b.appendChild(el('span', 'n', p.badge));
      b.setAttribute('aria-selected', String(openPanel === p.id));
      b.onclick = function () { togglePanel(p.id); };
      bar.appendChild(b);
    });
    if (DRAWER_IDS.indexOf(openPanel) < 0) { body.hidden = true; return; }
    body.hidden = false;
    body.textContent = '';
    if (openPanel === 'CHANGES') {
      (S.changes || []).forEach(function (c) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'path', c.path));
        if (c.added) r.appendChild(el('span', 'add', '+' + c.added));
        if (c.removed) r.appendChild(el('span', 'del', '-' + c.removed));
        body.appendChild(r);
      });
    } else if (openPanel === 'VERIFICATION') {
      var v = S.harness && S.harness.verification;
      if (!v) { body.appendChild(el('div', 'obs', 'no verification evidence yet')); return; }
      var d = el('div', 'verdict');
      d.appendChild(el('b', v.verdict, v.verdict));
      d.appendChild(el('span', '', '  ' + [
        v.passed ? v.passed + ' passed' : '',
        v.failed ? v.failed + ' failed' : '',
        v.inconclusive ? v.inconclusive + ' inconclusive' : '',
      ].filter(Boolean).join('  \\u00b7  ')));
      body.appendChild(d);
      if (v.why) body.appendChild(el('div', 'obs', v.why));
    } else if (openPanel === 'PLAN') {
      if (!S.plan) { body.appendChild(el('div', 'obs', 'no plan is executing in this session yet')); return; }
      (S.plan.steps || []).forEach(function (s) {
        var r = el('div', 'row');
        r.appendChild(el('span', '', s.status === 'done' ? '\\u2713' : s.status === 'active' ? '\\u25b8' : '\\u25cb'));
        r.appendChild(el('span', 'path', s.text));
        if (s.origin && s.origin !== 'llm') r.appendChild(el('span', 'src', s.origin));
        body.appendChild(r);
      });
    } else if (openPanel === 'TERMINAL') {
      LAIN.terminal.renderPanel(body);
    }
  }


  /**
   * DIAGNOSTICS: host, browser, environment — moved off the composer row and
   * behind the "i" control in the header (§24). Nobody types a question with
   * "host · Chromium 141" sitting under it any more; a person who wants that
   * fact clicks for it.
   *
   * NO BACKTICKS BELOW THIS LINE, comments included — everything from here to
   * the end of the emitted script lives inside one template literal.
   */
  function renderEnv() {
    var btn = $('diagBtn');
    if (!btn) return;
    var e = S.environment;
    // A quiet mark, not a colour pill: a borrowed browser is the one state
    // worth a person noticing before they open the panel at all.
    btn.style.color = (e && e.browser && !e.browser.owned) ? 'var(--warn)' : '';
  }

  function openDiagnostics() {
    var e = S.environment || {};
    var ex = S.execution || {};
    popover($('diagBtn'), function (p) {
      p.appendChild(el('h4', '', 'Diagnostics'));
      var box = el('div', 'diag');
      var dl = el('dl');
      var put = function (k, v) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
      put('Environment', e.kind === 'vm' ? 'VM \\u00b7 ' + String(e.task || '').replace(/^vm:/, '') : 'Host');
      if (e.browser) put('Browser', (e.browser.owned ? 'LAIN-owned Chromium ' : 'Borrowed browser ') + (e.browser.version || ''));
      else if (e.why) put('Browser', e.why);
      if (e.running && e.running.length) put('Running', e.running.join(', '));
      put('Session status', ex.word || 'READY');
      if (ex.detail) put('Detail', ex.detail);
      put('Lane', S.current && S.current.lane === 'cowork' ? 'Cowork' : 'Chat / Coding');
      box.appendChild(dl);
      p.appendChild(box);
    });
  }

  function popover(anchor, build) {
    closePop();
    var p = el('div', 'pop');
    p.id = 'pop';
    build(p);
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
    p.style.top = Math.max(8, r.top - p.offsetHeight - 8) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', onAway, true); }, 0);
  }
  function onAway(e) { var p = $('pop'); if (p && !p.contains(e.target)) closePop(); }
  function closePop() {
    var p = $('pop');
    if (p) p.remove();
    document.removeEventListener('mousedown', onAway, true);
  }

  // ---- asking -----------------------------------------------------------
  async function send() {
    var t = $('ask').value.trim();
    if (!t || ui.busy) return;
    ui.busy = true;
    $('send').disabled = true;
    notice('');
    // A TURN CARRIES ITS VIEW on an engineering session (chat or coding), so
    // Core can refuse a Chat sentence steering a Coding turn and vice versa —
    // docs/HARNESS_UI_CONTRACT.md §4. Cowork sessions have no views at all;
    // omitting the field there keeps the terminal-compatible behaviour.
    var body = { text: t };
    if (S.current.lane === 'engineering' && S.views) body.view = S.views.active;
    var r = await api('/api/turn', body);
    ui.busy = false;
    $('send').disabled = false;
    if (!r.ok) {
      if (r.projectRequired) return notice('attach a project before coding \\u2014 open Project Files', true);
      return notice(r.why, true);
    }
    $('ask').value = '';
    $('ask').style.height = 'auto';
    poll();
  }

  /**
   * CHAT / CODING — S.views.active (Core-held, docs §4) decides which mode is
   * showing and which contextual workspace controls appear. Switching is a
   * navigation call, not a local flag: POST /api/view/select, then re-poll.
   */
  function syncModes() {
    var eng = S.current.lane === 'engineering' && S.views;
    $('modes').hidden = !eng;
    var active = eng ? S.views.active : null;
    $('modeChat').setAttribute('aria-selected', String(active === 'chat'));
    $('modeCode').setAttribute('aria-selected', String(active === 'coding'));
    var coding = !eng || active === 'coding';
    $('codePill').hidden = !coding;
    $('wsPill').hidden = !coding;

    // COWORK / BOT — the lane's own two views, shown only on that lane.
    var onCowork = ui.lane === 'cowork';
    $('botModes').hidden = !onCowork;
    var botActive = onCowork && LAIN.bot.isActive();
    $('modeCowork').setAttribute('aria-selected', String(!botActive));
    $('modeBot').setAttribute('aria-selected', String(botActive));
    $('main').classList.toggle('bot-view', botActive);
    if (!onCowork && LAIN.bot.isActive()) LAIN.bot.close();
  }

  async function selectView(view) {
    var r = await api('/api/view/select', { view: view });
    if (r && !r.ok) return notice(r.why, true);
    poll();
  }

  /**
   * THE SESSION HEADER'S STATUS + STOP (§2, §9) — S.header.status is the one
   * SessionStatus authority the terminal's status strip and window title also
   * read; S.header.canStop says whether Stop applies. Nothing here derives
   * "is it running" a second way.
   */
  function renderCrumbStatus() {
    var h = S.header || {};
    var st = h.status || {};
    var row = $('crumbStatus');
    if (!st.state || st.state === 'IDLE' || st.state === 'DONE') { row.hidden = true; $('crumbStop').hidden = true; return; }
    row.hidden = false;
    var level = st.state === 'FAILED' ? 'bad'
      : (st.state === 'WAITING' || st.state === 'QUEUED' || st.state === 'NEEDS_INPUT') ? 'warn' : 'working';
    row.className = 'status ' + level;
    $('crumbDot').textContent = level === 'working' ? '\\u25cf' : level === 'bad' ? '!' : '\\u25d0';
    var word = st.state.charAt(0) + st.state.slice(1).toLowerCase().replace(/_/g, ' ');
    var bits = [word];
    if (typeof st.elapsed === 'number' && st.elapsed > 0) bits.push(fmtElapsed(st.elapsed));
    if (st.summary) bits.push(st.summary);
    $('crumbWord').textContent = bits.join('  \\u00b7  ');
    $('crumbStop').hidden = !h.canStop;
  }

  // ---- the frame --------------------------------------------------------
  function render() {
    if (!S) return;
    $('proj').textContent = S.current.project || '(no project)';
    // THE PROJECT IS GONE. Said once, where the project name is, rather than
    // letting the next turn fail on every read with nothing on screen to explain
    // why. See sessionpool.reattachProject.
    $('proj').title = S.current.projectMissing
      ? 'This session\\u2019s project is no longer at ' + (S.current.cwd || 'its recorded path')
      : (S.current.cwd || '');
    $('proj').className = S.current.projectMissing ? 'proj gone' : 'proj';
    $('goal').textContent = S.current.projectMissing
      ? '\\u00b7  its project folder is missing'
      : (S.current.goal ? '\\u00b7  ' + S.current.goal : '');
    syncModes();
    renderCrumbStatus();
    renderSessions();
    renderStream();
    LAIN.plan.applyPrefill(S);
    renderActivity();
    renderDrawers();
    var panelCtx = currentPanel();
    syncProjectFiles(panelCtx);
    LAIN.models.render(S);
    LAIN.workshop.render(S, ui);
    renderEnv();
    LAIN.cowork.render(S, ui);
    LAIN.bot.render(S, ui);
    // A PICTURE SOMEBODY ASKED TO SEE. S.viewing is null almost always; when it
    // is not, the overlay fetches the bytes ONCE by reference. See pageimage.js.
    LAIN.imageview.render(S.viewing);
    LAIN.settings.render();
    $('conn').textContent = S.current.lane === 'cowork' ? 'Cowork session' : '';
  }

  async function poll() {
    try {
      var r = await api('/api/state');
      if (r && r.ok) { S = r.state; render(); }
    } catch (e) { /* not connected yet, or the server went away */ }
  }

  function boot() {
    $('laneEng').onclick = function () { ui.lane = 'engineering'; syncLanes(); render(); };
    $('laneCo').onclick = function () { ui.lane = 'cowork'; syncLanes(); render(); };
    // THE NARROW-WINDOW RAIL. At wide widths this button is not on screen at
    // all (CSS decides that, not JS — the layout owns the breakpoint), and the
    // class it toggles does nothing there.
    $('railBtn').onclick = function () {
      var open = $('main').classList.toggle('rail-open');
      $('railBtn').setAttribute('aria-expanded', String(open));
    };
    $('send').onclick = send;
    $('ask').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(180, this.scrollHeight) + 'px';
    });
    $('ask').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    LAIN.models.boot(api, notice, poll);
    LAIN.plan.boot(api, notice, poll, render);
    LAIN.workshop.boot(api, notice, function () { return ui; }, poll);
    LAIN.source.boot(api, notice, poll);
    LAIN.cowork.boot(api, notice, poll, function () { return ui; });
    LAIN.bot.boot(api, notice, poll);
    LAIN.terminal.boot({ api: api, notice: notice, render: render, ui: ui, poll: poll });
    LAIN.imageview.boot({ api: api, notice: notice });
    LAIN.menu.boot({ api: api, notice: notice });
    LAIN.settings.boot(api, notice, function () {
      LAIN.settings.close();
      ui.lane = 'cowork';
      syncLanes();
      LAIN.bot.open();
      render();
    });
    $('diagBtn').onclick = openDiagnostics;
    $('modeChat').onclick = function () { selectView('chat'); };
    $('modeCode').onclick = function () { selectView('coding'); };
    $('modeCowork').onclick = function () { LAIN.bot.close(); syncModes(); };
    $('modeBot').onclick = function () { LAIN.bot.open(); syncModes(); };
    $('crumbStop').onclick = async function () {
      $('crumbStop').disabled = true;
      var r = await api('/api/interrupt', {});
      $('crumbStop').disabled = false;
      if (r && !r.ok) notice(r.why, true);
      poll();
    };
    // PROJECT FILES IS A WORKSPACE PANEL LIKE THE OTHERS NOW (§7): the click
    // only asks Core to open or close it. What actually shows is decided in
    // render() -> LAIN.source.sync(), from S.workspace.openPanel.
    $('codePill').onclick = function () { togglePanel('PROJECT_FILES'); };
    $('addProjectBtn').onclick = function () {
      var path = window.prompt('Project folder (full path)');
      if (path == null || !path.trim()) return;
      attachProject(path.trim());
    };
    // A CREDENTIAL AN OLDER BUILD STORED IS DISCARDED. The browser Harness put a
    // session there; it authenticates nothing now and has no business sitting in
    // storage on a machine that upgraded.
    try { sessionStorage.removeItem('lain.session'); } catch (e) { /* storage unavailable */ }
    $('app').hidden = false;
    poll();
    // ALWAYS POLLING. A poll that fails is Core restarting, and the next one is
    // the reconnect - the host owns saying so in its own chrome (native/host.cs).
    setInterval(poll, ui.pollMs);
  }

  function syncLanes() {
    renderEnv();
    // THE EDITOR LEARNS ABOUT LAIN'S EDITS ON THE SAME CLOCK as everything
    // else — one poll, not a second timer with its own idea of when.
    var ctx = S ? currentPanel() : null;
    if (ctx && ctx.ws && ctx.ws.openPanel === 'PROJECT_FILES' && LAIN.source) LAIN.source.refresh();
    $('laneEng').setAttribute('aria-selected', String(ui.lane === 'engineering'));
    $('laneCo').setAttribute('aria-selected', String(ui.lane === 'cowork'));
  }

  return { boot: boot, api: function () { return api.apply(null, arguments); },
           state: function () { return S; }, ui: function () { return ui; },
           notice: notice, el: el, poll: poll };
})();
`;
}

module.exports = { js };
