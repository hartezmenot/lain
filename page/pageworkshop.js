'use strict';

/**
 * THE FRONTEND WORKSHOP, IN THE APPLICATION.
 *
 * ------------------------------------------------------------------------
 * IT IS CONTEXTUAL, NOT A TAB.
 *
 * The Workshop is the right-hand half of an ENGINEERING SESSION, and only while
 * it is open. There is no top-level Workshop destination, because a person does
 * not go to the Workshop — they are fixing a page, and the page is the thing
 * they need beside the conversation.
 *
 * ------------------------------------------------------------------------
 * IT DRIVES THE REAL BROWSER; IT IS NOT AN IFRAME.
 *
 * The preview is a project-bound Chromium the Harness launched, driven over
 * CDP by src/workshop. An iframe would give the page a chance to refuse
 * framing, would give LAIN no console, no network, no accessibility tree and no
 * element picker, and would run in the browser the APPLICATION is in rather
 * than the one under test.
 *
 * So what this panel shows is a SCREENSHOT stream plus structured observations
 * — the DOM, the accessibility tree, the console, the network — which is what
 * the instruments actually produce.
 *
 * ------------------------------------------------------------------------
 * IT PRODUCES EVIDENCE AND SETTLES NOTHING.
 *
 * `Verify` collects observations at each viewport and files screenshots as
 * Harness artifacts. Whether the TASK is done remains harness/verify.js and
 * completion.js's decision, from that evidence. A green panel here is not a
 * finished task and never says it is.
 */

/** The preview, as a split beside the editor. Shown only while it is the open panel. */
const HTML = `
<section class="workshop" id="workshop" hidden>
  <div class="ws-head">
    <span class="ws-title">Preview</span>
    <span class="spacer"></span>
    <button class="btn small" id="wsClose">Close</button>
  </div>
  <div class="ws-server" id="wsServer" hidden>
    <span class="sdot" id="wsServerDot"></span>
    <span id="wsServerText"></span>
    <span class="url" id="wsUrl"></span>
    <span class="spacer"></span>
    <button class="btn small" id="wsRestart">Reload</button>
  </div>
  <div class="ws-bar">
    <button class="vp" data-vp="desktop" aria-selected="true">Desktop</button>
    <button class="vp" data-vp="tablet" aria-selected="false">Tablet</button>
    <button class="vp" data-vp="mobile" aria-selected="false">Mobile</button>
    <span class="spacer"></span>
    <button class="btn small" id="wsExternal" title="Open this page in your own browser">Open externally</button>
    <button class="btn small" id="wsPick" aria-pressed="false" title="Then click an element in the preview; LAIN opens the code that owns it">Pick element</button>
    <button class="btn small" id="wsReload">Refresh</button>
  </div>
  <div class="ws-body" id="wsBody"></div>
  <div class="ws-foot">
    <button class="btn small" id="wsBefore">Capture before</button>
    <button class="btn small" id="wsAfter">Capture after</button>
    <button class="btn small go" id="wsVerify">Verify all viewports</button>
    <button class="btn small" id="wsAttach" disabled>Ask about selection</button>
  </div>
</section>`;

const CSS = `
.workshop{border-left:1px solid var(--line);display:grid;grid-template-rows:auto auto auto 1fr auto;min-height:0;min-width:0;background:var(--panel)}
.ws-head{display:flex;align-items:center;gap:10px;padding:0 12px;height:35px;border-bottom:1px solid var(--line)}
.ws-title{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:600}
.ws-server{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim)}
.ws-server .sdot{font-size:9px}
.ws-server .url{color:var(--faint);font-family:var(--mono);font-size:11px;margin-left:2px}
.ws-bar{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vp{padding:2px 9px;border-radius:var(--radius-s);font-size:12px;color:var(--dim)}
.vp[aria-selected=true]{background:var(--raise);color:var(--ink)}
.ws-body{overflow:auto;padding:12px;min-height:0}
.shot{width:100%;border:1px solid var(--line);border-radius:var(--radius-s);display:block;background:#fff}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ba figcaption{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-family:var(--mono);font-size:12px;margin:8px 0}
.kv dt{color:var(--faint)} .kv dd{margin:0;color:var(--ink);word-break:break-all}
.ws-foot{border-top:1px solid var(--line);padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap}
#wsPick[aria-pressed=true]{background:var(--accent-weak);border-color:var(--accent-line);color:var(--ink)}
.shotwrap{position:relative}
.shotwrap.picking .shot{cursor:crosshair;outline:2px dashed var(--accent-line);outline-offset:2px}
.pickbox{position:absolute;border:2px solid var(--accent);background:rgba(120,160,255,.14);pointer-events:none;border-radius:2px}
.selsrc{display:flex;flex-direction:column;gap:4px;margin:6px 0 10px}
.selsrc button{text-align:left;font-family:var(--mono);font-size:12px;padding:4px 8px;border:1px solid var(--line2);border-radius:var(--radius-s);background:var(--surface);color:var(--ink)}
.selsrc button:hover{border-color:var(--accent-line)}
.selsrc .why{color:var(--faint);font-family:var(--sans,inherit);margin-left:6px}
.selid{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin:2px 0 6px}
`;

function js() {
  return `
LAIN.workshop = (function () {
  'use strict';
  var api, notice, uiOf, poll;
  var W = { open: false, shot: null, before: null, after: null, picking: false,
            element: null, verify: null, vp: 'desktop' };

  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = String(x); return n; }

  function boot(_api, _notice, _uiOf, _poll) {
    api = _api; notice = _notice; uiOf = _uiOf; poll = _poll;
    $('wsPill').onclick = toggle;
    $('wsClose').onclick = close;
    $('wsReload').onclick = async function () { await api('/api/workshop/reload', {}); shoot(); };
    // "RESTART" ON THE SERVER ROW IS THE SAME RELOAD ACTION AS THE ONE IN THE
    // TOOLBAR. There is no separate dev-server-process control in this build —
    // MISSING CONTRACT: a real restart-the-process route, distinct from
    // reloading the page a running server already serves.
    $('wsRestart').onclick = async function () { await api('/api/workshop/reload', {}); shoot(); };
    $('wsPick').onclick = togglePick;
    $('wsExternal').onclick = external;
    $('wsBefore').onclick = function () { capture('before'); };
    $('wsAfter').onclick = function () { capture('after'); };
    $('wsVerify').onclick = verify;
    $('wsAttach').onclick = attach;
    Array.prototype.forEach.call(document.querySelectorAll('.vp'), function (b) {
      b.onclick = function () { viewport(b.getAttribute('data-vp')); };
    });
  }

  async function toggle() {
    if (W.open) return close();
    notice('Starting the dev server and opening the preview\\u2026');
    // OPENING IS TWO CALLS, AND A POLL CAN LAND BETWEEN THEM. It did: render()
    // saw the workshop open but the panel still NONE, retracted the column, and
    // the preview was then drawn into a hidden section (workshop-real, measured
    // 2026-09-18). So nothing retracts while opening, and the first state
    // trusted afterwards is one fetched after the panel call.
    W.opening = true;
    try {
      var r = await api('/api/workshop/open', {});
      if (!r.ok) { notice(r.why, true); return; }
      // WORKSPACE PANEL STATE IS CORE-HELD (docs/HARNESS_UI_CONTRACT.md §7) —
      // this is the one call that says "Workshop is the open panel now", which
      // is what makes Project Files retract on its own next render().
      await api('/api/workspace/panel', { action: 'open', panel: 'WORKSHOP' });
      W.open = true;
      W.vp = 'desktop';
      notice('');
      layout();
      await poll();
    } finally { W.opening = false; }
    await shoot();
    poll();
  }

  async function close() {
    await api('/api/workshop/close', {});
    await api('/api/workspace/panel', { action: 'close' });
    clearInterval(W.pollT);
    W = { open: false, shot: null, before: null, after: null, picking: false, pickMode: false, pick: null, element: null, verify: null, vp: 'desktop' };
    layout();
    poll();
  }

  function layout() {
    $('workshop').hidden = !W.open;
    // A CLASS, NOT THE CLASS LIST: assigning className wiped with-source and the
    // lane state along with it.
    $('main').classList.toggle('with-workshop', W.open);
    $('wsPill').setAttribute('aria-selected', String(W.open));
  }

  /**
   * DEV SERVER STATUS — "Vite . npm run dev / RUNNING / localhost:5173" in one
   * line (§20). Reads the same ws.available/open/url/why the pill already
   * used; nothing new is asked of the backend. An HTTP 500 in the preview is
   * not a separate state Core reports — the honest thing this row can say
   * from what it has is whether the server answered at all.
   */
  function renderServer(ws) {
    var row = $('wsServer');
    if (!ws || !ws.open) { row.hidden = true; return; }
    row.hidden = false;
    var dot = $('wsServerDot');
    dot.textContent = '\\u25cf';
    dot.style.color = 'var(--accent)';
    $('wsServerText').textContent = 'Dev server \\u00b7 Running';
    $('wsUrl').textContent = ws.url || '';
  }

  /** A fresh frame of the real preview. Not persisted — see \`capture\`. */
  async function shoot() {
    var r = await api('/api/workshop/capture', {});
    if (r.ok && r.shot) { W.shot = r.shot; draw(); }
    return r;
  }

  async function viewport(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.vp'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-vp') === name));
    });
    W.vp = name;
    var r = await api('/api/workshop/viewport', { name: name });
    if (!r.ok) return notice(r.why, true);
    await shoot();
  }

  /**
   * ARM THE PICKER, then wait for the person to click IN THE PREVIEW WINDOW.
   *
   * Polled rather than pushed: the click happens in another browser entirely,
   * and there is no channel from it back to this page except asking.
   */
  async function pick() {
    var r = await api('/api/workshop/pick', {});
    if (!r.ok) return notice(r.why, true);
    W.picking = true;
    var tries = 0;
    clearInterval(W.pollT);
    W.pollT = setInterval(async function () {
      tries += 1;
      if (!W.pickMode) { clearInterval(W.pollT); W.picking = false; return; }
      var got = await api('/api/workshop/picked', {});
      if (got.ok && got.element) {
        clearInterval(W.pollT);
        W.picking = false;
        await shoot();
        applyPick(got);
      } else if (tries > 120) {
        clearInterval(W.pollT);
        W.picking = false;
        setPickMode(false);
        notice('');
      }
    }, 500);
  }

  /**
   * PICK ELEMENT — a mode, not a click handler that is always on. While it is
   * on, a click on the preview (here, or in the preview window LAIN opened)
   * selects that element; the answer is Core's canonical Selection and its one
   * source binding, and the owning source opens in the editor.
   */
  function setPickMode(on) {
    W.pickMode = Boolean(on);
    $('wsPick').setAttribute('aria-pressed', String(W.pickMode));
    var wrap = document.querySelector('#wsBody .shotwrap');
    if (wrap) wrap.classList.toggle('picking', W.pickMode);
  }
  async function togglePick() {
    if (W.pickMode) {
      setPickMode(false);
      clearInterval(W.pollT);
      notice('');
      await api('/api/workshop/unpick', {});
      return;
    }
    setPickMode(true);
    notice('Pick element: click the element in the preview. Escape or Pick element again cancels.');
    pick();
  }

  /** The person's own browser, through the host's http(s)-only door. */
  function external() {
    var st = LAIN.state();
    var url = st && st.workshop && st.workshop.url;
    if (!url) return notice('The preview has no address yet \\u2014 start it first.', true);
    if (!LAIN.openExternal) return notice('Opening your browser is not available in this window.', true);
    LAIN.openExternal(url);
  }

  /**
   * ONE ANSWER FOR BOTH PICK DOORS (Core: routes.js pickAnswer): the element,
   * the canonical Selection id and generation, its binding, and the source to
   * show. "this" now has an identity; nothing asks again.
   */
  function applyPick(r) {
    W.element = r.element || null;
    W.source = r.source || null;
    W.pick = { selection: r.selection || null, generation: r.projectGeneration, open: r.open || null, alternatives: r.alternatives || [] };
    setPickMode(false);
    clearInterval(W.pollT);
    api('/api/workshop/unpick', {}).catch(function () {});
    $('wsAttach').disabled = !W.element;
    if (r.open && LAIN.source && LAIN.source.openFile) {
      LAIN.source.openFile(r.open.file, { line: r.open.line });
      notice('Selected ' + (r.selection || '') + ' \\u2014 ' + r.open.why + ' opened: ' + r.open.file + ':' + r.open.line);
    } else {
      notice('Selected ' + (r.selection || 'the element') + ' \\u2014 no source file could be bound to it; say what it is and LAIN will look.');
    }
    draw();
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && W.pickMode) togglePick(); });

  async function capture(as) {
    var r = await api('/api/workshop/capture', { as: as });
    if (!r.ok) return notice(r.why, true);
    if (as === 'before') { W.before = r.shot; W.after = null; }
    else { W.after = r.shot; W.before = r.before || W.before; }
    W.shot = r.shot;
    draw();
  }

  /**
   * SELECT BY CLICKING THE PREVIEW HERE. The image is the page at its real CSS
   * size, so a click is scaled from the drawn size to the natural size and the
   * element at that point is read in the real browser.
   */
  async function pickAtImage(img, ev) {
    var r0 = img.getBoundingClientRect();
    var x = (ev.clientX - r0.left) * (img.naturalWidth / r0.width);
    var y = (ev.clientY - r0.top) * (img.naturalHeight / r0.height);
    notice('Selecting\\u2026');
    var r = await api('/api/workshop/pick-at', { x: x, y: y });
    if (!r.ok) return notice(r.why, true);
    applyPick(r);
  }

  async function verify() {
    notice('Verifying desktop, tablet and mobile\\u2026');
    var r = await api('/api/workshop/verify', { viewports: ['desktop', 'tablet', 'mobile'] });
    if (!r.ok) { notice(r.why || 'verification did not complete', true); return; }
    W.verify = r;
    notice('');
    draw();
    poll();
  }

  /** Send the selection and the page's own failures as the NEXT question. */
  async function attach() {
    // THE QUESTION IS WHAT IS IN THE COMPOSER — the one place a person types.
    // A blocking browser prompt was a second input box, and one nobody could
    // automate or see beside the conversation.
    var box = $('ask');
    var q = box.value.trim();
    if (!q) { box.focus(); notice('Type what you want to know or change about the selected element, then press Ask about selection.'); return; }
    var r = await api('/api/workshop/attach', {
      text: q, selector: W.element ? W.element.selector : null,
    });
    if (!r.ok) return notice(r.why, true);
    box.value = '';
    notice('');
    poll();
  }

  // ---- drawing ----------------------------------------------------------
  function shotFig(label, shot) {
    var f = document.createElement('figure');
    f.style.margin = '0';
    f.appendChild(el('figcaption', '', label));
    var i = document.createElement('img');
    i.className = 'shot';
    i.src = shot.dataUrl;
    f.appendChild(i);
    return f;
  }

  function draw() {
    var body = $('wsBody');
    body.textContent = '';
    var st = LAIN.state();
    var ws = st && st.workshop;
    $('wsUrl').textContent = (ws && ws.url) || '';

    // ---- BEFORE / AFTER, when there is a pair ---------------------------
    if (W.before && W.after) {
      var ba = el('div', 'ba');
      ba.appendChild(shotFig('Before', W.before));
      ba.appendChild(shotFig('After', W.after));
      body.appendChild(ba);
    } else if (W.shot) {
      var live = shotFig((W.before ? 'Before captured \\u00b7 live' : 'Preview \\u00b7 ' + W.vp) + (W.reloaded ? '  \\u00b7  ' + W.reloaded : '') + (W.pickMode ? '  \\u00b7  click an element' : ''), W.shot);
      var img = live.querySelector('img');
      img.id = 'wsShot';
      var wrap = el('div', 'shotwrap' + (W.pickMode ? ' picking' : ''));
      img.parentNode.replaceChild(wrap, img);
      wrap.appendChild(img);
      img.onclick = function (ev) { if (W.pickMode) pickAtImage(img, ev); };
      // THE PICKED ELEMENT, OUTLINED where the real browser measured it.
      if (W.element && W.element.rect) {
        var box = el('div', 'pickbox');
        wrap.appendChild(box);
        var place = function () {
          if (!img.naturalWidth) return;
          var k = img.clientWidth / img.naturalWidth;
          var R = W.element.rect;
          box.style.left = (R.x * k) + 'px'; box.style.top = (R.y * k) + 'px';
          box.style.width = (R.w * k) + 'px'; box.style.height = (R.h * k) + 'px';
        };
        if (img.complete) place(); else img.onload = place;
      }
      body.appendChild(live);
    }

    // ---- THE SELECTED ELEMENT ------------------------------------------
    if (W.element) {
      var e = W.element;
      body.appendChild(el('div', 'ws-title', 'Selected element'));
      if (W.pick && W.pick.selection) body.appendChild(el('div', 'selid', 'Selection ' + W.pick.selection + (W.pick.generation != null ? '  \\u00b7  project generation ' + W.pick.generation : '')));
      if (W.pick && W.pick.alternatives && W.pick.alternatives.length) {
        var srcs = el('div', 'selsrc');
        W.pick.alternatives.forEach(function (a) {
          var b = el('button', '');
          b.appendChild(document.createTextNode(a.file + ':' + a.line));
          b.appendChild(el('span', 'why', a.why));
          b.onclick = function () { LAIN.source.openFile(a.file, { line: a.line }); };
          srcs.appendChild(b);
        });
        body.appendChild(srcs);
      }
      var dl = el('dl', 'kv');
      var put = function (k, v) { if (!v) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
      put('selector', e.selector);
      put('role', [e.role, e.name].filter(Boolean).join(' \\u2014 '));
      put('tag', e.tag + (e.id ? '#' + e.id : ''));
      if (e.rect) put('box', e.rect.w + '\\u00d7' + e.rect.h + ' at ' + e.rect.x + ',' + e.rect.y);
      if (e.layout) {
        ['display', 'position', 'align-items', 'justify-content', 'margin', 'text-align'].forEach(function (k) {
          if (e.layout[k] && String(e.layout[k]).trim()) put(k, String(e.layout[k]).trim());
        });
      }
      if (e.parent) put('parent', '<' + e.parent.tag + '> ' + e.parent.display
        + (e.parent.justify ? ' / ' + e.parent.justify : '') + (e.parent.align ? ' / ' + e.parent.align : ''));
      if (W.source && W.source.candidates && W.source.candidates.length && W.source.confidence !== 'UNKNOWN') {
        var top = W.source.candidates[0];
        var hit = (top.hits || [])[0];
        put('source', top.rel + (hit ? ':' + hit.line : '') + '  (' + String(W.source.confidence).toLowerCase() + ')');
      }
      body.appendChild(dl);
    }

    // ---- CONSOLE AND NETWORK, summarised ------------------------------
    //
    // COUNTS FIRST, DETAIL UNDER THEM. A panel that dumps every request by
    // default is a log, and a log is the thing nobody reads.
    if (ws && ws.observations && ws.observations.console) {
      // THE REPORTS ARE ALREADY SUMMARIES — {errors,total,entries} and
      // {total,failed,entries}. Filtering them again as arrays produced an empty
      // panel over a page that really did have errors. Found by a real run.
      var c = ws.observations.console, n = ws.observations.network || {};
      body.appendChild(el('div', 'ws-title', 'Console \u00b7 ' + (c.errors ? c.errors + ' error(s) of ' + c.total : 'clean')));
      (c.entries || []).slice(0, 6).forEach(function (x) { body.appendChild(el('div', 'obs err', x.text)); });
      body.appendChild(el('div', 'ws-title', 'Network \u00b7 ' + (n.failed ? n.failed + ' failed of ' + n.total : 'clean')));
      (n.entries || []).slice(0, 6).forEach(function (x) { body.appendChild(el('div', 'obs err', x.status + '  ' + x.url)); });
    }

    // ---- WHAT VERIFICATION OBSERVED ------------------------------------
    if (W.verify && W.verify.results) {
      body.appendChild(el('div', 'ws-title', 'Verification evidence'));
      W.verify.results.forEach(function (r) {
        var line = el('div', 'obs' + (r.ok ? '' : ' err'));
        // A check entry is {name, ok, detail}. There was never a 'what' field,
        // and reading one printed undefined beside every viewport. Found by a
        // real run against the fixture project, not by reading the code.
        var failed = (r.checks || []).filter(function (c) { return !c.ok; });
        line.textContent = (r.ok ? '\u2713 ' : '\u2717 ') + r.viewport
          + (r.width ? '  ' + r.width + 'px' : '')
          + (failed.length ? '  \u00b7  ' + failed.map(function (c) { return c.name + ' (' + c.detail + ')'; }).join(', ') : '');
        body.appendChild(line);
      });
      body.appendChild(el('div', 'obs', 'Evidence only. The task is settled by the Harness, not by this panel.'));
    }
  }

  /** Called on every poll. Keeps the panel honest about the real browser. */
  function render(S) {
    var ws = S && S.workshop;
    if (!ws) return;
    // THE PILL SAYS WHAT IS POSSIBLE, not what we wish were. A machine with no
    // browser says so here rather than failing when the button is pressed.
    $('wsPill').disabled = !ws.available && !W.open;
    $('wsPill').title = ws.available ? '' : (ws.why || 'no browser is available on this machine');
    if (W.opening) { renderServer(ws); return; }
    if (!ws.open && W.open) { W.open = false; layout(); }
    // ANOTHER PANEL TOOK OVER. workspace.openPanel is one Core-held value for
    // Project Files, Workshop and the drawer panels alike (§7) — opening any
    // other one retracts this column without a separate "close Workshop" call.
    var eng = S.current && S.current.lane === 'engineering' && S.views && S.views.active === 'coding';
    var openPanel = eng && S.workspace ? S.workspace.openPanel : 'NONE';
    if (openPanel !== 'WORKSHOP' && W.open) { W.open = false; layout(); }
    renderServer(ws);
    // ---- HOT RELOAD AWARENESS ----------------------------------------------
    //
    // When LAIN changes a file in this project, the preview is reloaded and a
    // fresh frame drawn — the change is SEEN, not assumed. The trigger is the
    // checkpoint ledger's list of changed files, the same fact the Changes
    // drawer shows; nothing here watches the disk itself.
    var sig = JSON.stringify((S.changes || []).map(function (c) { return [c.path, c.added, c.removed]; }));
    // A CHANGE SEEN WHILE A RELOAD IS IN FLIGHT WAITS FOR IT, rather than being
    // recorded as seen: the ledger lists a file at its checkpoint, a moment
    // BEFORE the write lands, so the first reload can race ahead of the bytes and
    // the counts that follow the write are the change that must not be missed.
    if (W.reloading) return;
    if (W.open && W.changeSig != null && sig !== W.changeSig) {
      W.reloading = true;
      var changed = (S.changes || []).map(function (c) { return c.path; }).slice(-2).join(', ');
      api('/api/workshop/reload', {}).then(function () { return shoot(); }).then(function () {
        // THE SELECTION IS RE-READ, not kept: its box and styles described the
        // page before the change.
        return W.element && W.element.selector
          ? api('/api/workshop/element', { selector: W.element.selector }).then(function (e) { if (e && e.ok) W.element = e.element; })
          : null;
      }).then(function () {
        W.reloaded = 'reloaded after ' + changed + ' changed';
        W.reloading = false;
        draw();
      }, function () { W.reloading = false; });
    }
    W.changeSig = sig;
  }

  /** THE focus.pick_element DOOR: open the preview if it is closed, then enter pick mode. */
  async function startPick() {
    if (!W.open) await toggle();
    if (W.open && !W.pickMode) togglePick();
  }

  return { boot: boot, render: render, draw: draw, startPick: startPick };
})();
`;
}

module.exports = { HTML, CSS, js };
