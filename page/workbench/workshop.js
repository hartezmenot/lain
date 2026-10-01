'use strict';

/**
 * THE PREVIEW — the project's real frontend, rendered by the window (2026-09-30).
 *
 * ------------------------------------------------------------------------
 * REAL FRONTEND, BACKEND DORMANT. The page is an iframe on Core's preview proxy
 * (src/workshop/proxy.js): the project's own dev server, browser-native —
 * scrolling, hover, typing, animation and video behave as they do in a browser,
 * because they are a browser. Nothing is streamed; screenshots are evidence for
 * a model, taken only when asked for. The backend stays asleep; its pieces
 * (playback, database, scanner…) are answered by the capability broker — off,
 * preview data, or live when the person turns one on here.
 *
 *   ┌ ◧ Preview  [⌕ localhost:5173/library  ⟳]  Desktop Tablet Mobile Custom  ⊕ ⤢ ▭ ✕ ┐
 *   │ Backend dormant · playback off · database-read preview data              ▾   │
 *   │ ┌────────────── the page, at its real CSS size, scaled to fit ─────────────┐ │
 *   │ │                                                                           │ │
 *   │ └───────────────────────────────────────────────────── 1440 × 900 · 62% ──┘ │
 *   │ ┌ LibraryFilter · src/components/LibraryFilter.tsx:12 ─ 358 × 54 at 24,96 ┐ │
 *   │ │ [Ask about this] [Edit size] [Edit spacing] [Move] [Open source] [Reset]  │ │
 *   │ [ Ask or change LibraryFilter…                                         ➜ ] │
 *
 * INSPECTING: a normal click is the page's. HOLD (~280 ms) and the bridge
 * inspects instead — DRAG draws a region, RELEASE selects; ⊕ arms a one-shot
 * pick. The selection becomes Core's canonical Selection (GUG + sourceBinding),
 * and the framework's own dev hints (component, file:line) come with it.
 * Dragging a corner of the selection resizes it as a DRAFT on the page; Apply
 * turns the delta into a scoped change for the Coding Agent.
 *
 * ONE PREVIEW, EVERY SURFACE. Chat, the Coding Agent and the IDE show the same
 * page (Core's S.workshop.frame: URL, viewport, capabilities). The panel is one
 * element that floats over whichever room's slot is on screen — so going from
 * Chat to the IDE never reloads the page.
 */

const HTML = `
<section class="workshop" id="workshop" hidden aria-label="Preview">
  <div class="pv-bar">
    <span class="pv-title"><span class="pv-tic" id="pvTitleIc"></span><span class="pv-tt">Preview</span></span>
    <div class="pv-url"><span id="pvUrlIc"></span><input id="wsUrl" spellcheck="false" autocomplete="off" aria-label="Preview address"><button class="u-ib" id="wsReload" aria-label="Reload"></button></div>
    <div class="pv-vps" id="pvVps"></div>
    <span class="pv-errs" id="pvErrs" hidden></span>
    <button class="u-ib" id="wsPick" aria-label="Inspect an element" aria-pressed="false"></button>
    <button class="u-ib" id="wsMore" aria-label="More"></button>
    <button class="u-ib" id="wsDetach" aria-label="Open in its own window"></button>
    <button class="u-ib" id="wsClose" aria-label="Close the preview"></button>
  </div>
  <div class="pv-caps" id="pvCaps"></div>
  <div class="pv-stage" id="wsBody">
    <div class="pv-device" id="pvDevice">
      <iframe id="wsFrame" title="Preview" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture"></iframe>
      <iframe id="wsFrameB" title="Preview (loading)" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture" hidden></iframe>
    </div>
    <div class="pv-wait" id="wsWait"><span class="spin"></span><span id="wsWaitText">Starting the preview…</span></div>
    <div class="pv-size" id="pvSize"></div>
    <div class="pv-hint" id="pvHint">Hold and drag on the page to inspect</div>
  </div>
  <div class="pv-insp" id="pvInsp" hidden></div>
  <div class="pv-say" id="wsSay">
    <button class="pv-scope" id="wsScope" hidden></button>
    <div class="pv-in"><textarea id="wsSayIn" rows="1" placeholder="Ask to change this page…" autocomplete="off" spellcheck="false"></textarea><button class="act-send" id="wsSayGo" aria-label="Send the change"></button></div>
  </div>
</section>`;

const CSS = `
/* THE PANEL FLOATS OVER A ROOM'S SLOT (an IDE column, Chat's right side) — never moved, so never reloaded. */
.workshop{position:fixed;z-index:30;container-type:inline-size;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;min-height:0;min-width:0;background:var(--surface-base);border-radius:8px;outline:1px solid var(--separator);outline-offset:-1px;overflow:hidden}
.workshop[hidden]{display:none}
.workshop.parked{visibility:hidden;pointer-events:none}
.pv-slot{min-width:0;min-height:0}
.pv-bar{display:flex;align-items:center;gap:6px;height:46px;padding:0 6px 0 12px;border-bottom:1px solid var(--separator);min-width:0}
.pv-title{display:inline-flex;align-items:center;gap:8px;font-size:var(--fs-body);font-weight:600;color:var(--text-primary);flex:none}
.pv-tic{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:var(--accent-weak);color:var(--accent-primary)}
.pv-url{flex:1;min-width:120px;display:flex;align-items:center;gap:6px;height:32px;padding:0 4px 0 10px;border-radius:var(--radius-md);background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--separator);color:var(--text-muted)}
.pv-url:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border)}
.pv-url input{flex:1;min-width:0;font:12.5px/1 var(--mono);color:var(--text-primary)}
.pv-url .u-ib{width:26px;height:26px}
.pv-vps .u-seg{padding:2px}
.pv-vps .u-seg > button{padding:4px 10px;font-size:var(--fs-caption)}
.workshop .pv-bar > .u-ib{width:30px;height:30px}
#wsPick[aria-pressed=true]{background:var(--accent-weak);color:var(--accent-primary)}
.pv-errs{flex:none;padding:3px 8px;border-radius:999px;background:var(--danger-weak);color:var(--danger);font-size:var(--fs-caption);cursor:pointer}
.pv-caps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--separator);font-size:var(--fs-caption);color:var(--text-secondary);min-height:34px}
.pv-caps:empty{display:none}
.pv-caps .pc-dorm{display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-right:4px}
.pv-caps .pc{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:var(--surface-raised);color:var(--text-secondary)}
.pv-caps .pc:hover{background:var(--surface-active);color:var(--text-primary)}
.pv-caps .pc[data-mode=live]{background:var(--secondary-weak);color:var(--accent-secondary)}
.pv-caps .pc[data-mode=adapter]{background:color-mix(in srgb,var(--info) 14%,transparent);color:var(--info)}
.pv-caps .pc i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.8}
.pv-caps .pc[data-mode=live][data-awake=no] i{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.pv-caps .pc[data-awake=waking] i{animation:pcWake 1s ease-in-out infinite}
@keyframes pcWake{50%{opacity:.25}}
/* THE STAGE: the device at its real CSS size, scaled to fit, centred on the canvas. */
.pv-stage{position:relative;min-height:0;overflow:hidden;background:var(--canvas)}
.pv-device{position:absolute;left:50%;top:50%;transform-origin:0 0;background:#fff;border-radius:6px;box-shadow:0 0 0 1px var(--separator),var(--shadow-float);overflow:hidden;transition:width var(--t-panel) var(--ease),height var(--t-panel) var(--ease)}
.pv-device iframe{position:absolute;left:0;top:0;border:0;display:block;background:#fff}
.pv-device iframe[hidden]{display:block!important;visibility:hidden}
.pv-wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;color:var(--text-secondary);font-size:var(--fs-body);background:var(--canvas)}
.pv-wait[hidden]{display:none}
.pv-size{position:absolute;right:10px;bottom:8px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--canvas) 80%,transparent);color:var(--text-muted);font:11px/1.5 var(--mono);pointer-events:none}
.pv-hint{position:absolute;left:10px;bottom:8px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--canvas) 80%,transparent);color:var(--text-muted);font-size:11px;pointer-events:none;opacity:.8}
/* THE INSPECTOR: what was selected, who owns it, its box — and what to do with it. */
.pv-insp{padding:10px 12px;border-top:1px solid var(--separator);background:var(--surface-raised);max-height:40%;overflow:auto;animation:lain-drop var(--t-panel) var(--ease)}
.pv-insp .pi-top{display:flex;align-items:baseline;gap:10px;min-width:0}
.pv-insp .pi-top b{font-size:var(--fs-body);font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-insp .pi-top small{margin-left:auto;font:11px/1.4 var(--mono);color:var(--text-muted);white-space:nowrap}
.pv-insp .pi-own{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.pv-insp .pi-own button{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 9px;border-radius:var(--radius-sm);background:var(--surface-active);font:11.5px/1.5 var(--mono);color:var(--text-primary);text-align:left}
.pv-insp .pi-own button:hover{box-shadow:inset 0 0 0 1px var(--accent-border)}
.pv-insp .pi-own button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-insp .pi-own button em{font-style:normal;color:var(--text-muted);font-family:var(--sans)}
.pv-insp .pi-css{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px 12px;margin:6px 0 8px;font:11px/1.5 var(--mono)}
.pv-insp .pi-css span{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-insp .pi-css span b{color:var(--text-secondary);font-weight:400}
.pv-insp .pi-draft{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--accent-weak);font-size:var(--fs-small);color:var(--text-primary)}
.pv-insp .pi-acts{display:flex;flex-wrap:wrap;gap:6px}
.pv-say{padding:10px 12px 12px;border-top:1px solid var(--separator)}
.pv-scope{display:inline-flex;align-items:center;gap:6px;max-width:100%;margin:0 0 6px;padding:2px 10px;border-radius:999px;background:var(--selection);color:var(--text-primary);font-size:var(--fs-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-in{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 12px;border-radius:14px;background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--border-subtle)}
.pv-in:focus-within{box-shadow:inset 0 0 0 1px var(--accent-border)}
.pv-in textarea{flex:1;min-width:0;resize:none;max-height:110px;font-size:var(--fs-body);line-height:1.45;padding:3px 0;color:var(--text-primary)}
.pv-in .act-send{width:30px;height:30px;border-radius:9px}
/* THE DETACHED PREVIEW WINDOW shows only the preview (#detached-preview). */
body.detached-preview #app{display:none!important}
body.detached-preview #workshop{left:0!important;top:0!important;width:100vw!important;height:100vh!important;border-radius:0;outline:0;visibility:visible;pointer-events:auto}
body.detached-preview #wsDetach,body.detached-preview #wsClose{display:none}
/* A NARROW PANEL keeps every control: the viewport names become icons (their names stay in the tooltips). */
@container (max-width: 760px){.pv-vps .u-seg > button span{display:none}.pv-vps .u-seg > button{padding:4px 7px}.pv-title .pv-tt{display:none}}
@container (max-width: 520px){.pv-title{display:none}.pv-hint{display:none}}
.pv-insp .pi-more{margin-left:auto}
.pv-insp .pi-css[hidden]{display:none}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var api, notice, poll;
  var VP = { desktop: { w: 1440, h: 900, label: 'Desktop', icon: 'monitor' }, tablet: { w: 768, h: 1024, label: 'Tablet', icon: 'tablet' }, mobile: { w: 390, h: 844, label: 'Mobile', icon: 'phone' } };
  var P = fresh();
  function fresh() {
    return { open: false, opening: false, url: null, origin: null, path: '/', vp: { name: 'desktop', w: 1440, h: 900 }, active: 'wsFrame', loading: null, ready: false,
      element: null, measure: null, owners: [], hints: null, draft: null, draft0: null, errors: [], room: null, arming: false, detached: false, seenUrl: null };
  }
  function frameEl(id) { return $(id || P.active); }
  function other() { return P.active === 'wsFrame' ? 'wsFrameB' : 'wsFrame'; }
  function send(type, data, id) {
    var f = frameEl(id);
    if (!f || !f.contentWindow || !P.origin) return;
    try { f.contentWindow.postMessage(Object.assign({ lain: 1, type: type }, data || {}), P.origin); } catch (e) { /* the page is navigating */ }
  }

  // ---- WHERE THE PANEL SITS: over the slot of the room on screen ---------------------------------------------------
  function slotFor() {
    if (P.detached) return null;
    var tab = L.nav && L.nav.tab ? L.nav.tab() : '';
    if (tab === 'ide') return $('pvSlotIde');
    if (tab === 'chat') return $('pvSlotChat');
    return null;
  }
  function placePanel() {
    var ws = $('workshop');
    if (!P.open) { ws.hidden = true; return; }
    ws.hidden = false;
    if (P.detached) { ws.classList.remove('parked'); fit(); return; }
    var slot = slotFor();
    var r = slot && slot.offsetParent ? slot.getBoundingClientRect() : null;
    if (!r || r.width < 40 || r.height < 40) { ws.classList.add('parked'); return; }
    ws.classList.remove('parked');
    ws.style.left = r.left + 'px'; ws.style.top = r.top + 'px'; ws.style.width = r.width + 'px'; ws.style.height = r.height + 'px';
    fit();
  }
  var ro = null;
  function watchSlots() {
    if (ro || !window.ResizeObserver) return;
    ro = new ResizeObserver(function () { placePanel(); });
    ['pvSlotIde', 'pvSlotChat'].forEach(function (id) { var s = $(id); if (s) ro.observe(s); });
    window.addEventListener('resize', placePanel);
  }
  /** Rooms say whether their slot shows (the IDE's second column, Chat's right side). */
  function layout() {
    var main = $('main');
    if (main) main.classList.toggle('with-workshop', P.open);
    var cb = $('chatBody');
    if (cb) cb.classList.toggle('with-preview', P.open);
    var pill = $('wsPill'); if (pill) pill.setAttribute('aria-selected', String(P.open));
    var cp = $('chatPreviewBtn'); if (cp) cp.setAttribute('aria-pressed', String(P.open));
    requestAnimationFrame(placePanel);
  }

  // ---- THE DEVICE: the page's real CSS viewport, scaled into the room there is --------------------------------------
  function fit() {
    var stage = $('wsBody'), dev = $('pvDevice');
    if (!stage || !stage.clientWidth) return;
    var pad = 16;
    var aw = stage.clientWidth - pad * 2, ah = stage.clientHeight - pad * 2;
    var w = P.vp.w, h = P.vp.h;
    if (P.vp.name === 'fit') { w = Math.max(240, aw); h = Math.max(240, ah); }
    var k = Math.min(1, aw / w, ah / h);
    if (!(k > 0)) k = 1;
    dev.style.width = w + 'px'; dev.style.height = h + 'px';
    dev.style.transform = 'translate(' + (-(w * k) / 2) + 'px,' + (-(h * k) / 2) + 'px) scale(' + k + ')';
    ['wsFrame', 'wsFrameB'].forEach(function (id) { var f = $(id); f.style.width = w + 'px'; f.style.height = h + 'px'; });
    $('pvSize').textContent = w + ' × ' + h + (k < 1 ? ' · ' + Math.round(k * 100) + '%' : '');
  }
  function setViewport(name, dims) {
    var v = name === 'custom' && dims ? { name: 'custom', w: dims.w, h: dims.h } : name === 'fit' ? { name: 'fit', w: P.vp.w, h: P.vp.h } : VP[name] ? { name: name, w: VP[name].w, h: VP[name].h } : null;
    if (!v) return;
    P.vp = v;
    fit();
    if (vpSeg) vpSeg.set(v.name === 'fit' ? 'custom' : v.name);
    if (P.element) setTimeout(function () { send('select', { selector: P.element.selector }); }, 250);
    // THE SAME VIEWPORT ON EVERY SURFACE: Core keeps it.
    api('/api/preview/set', { viewport: { name: v.name, w: v.w, h: v.h } }).catch(function () {});
  }
  function customMenu(anchor) {
    L.kit.menu(anchor, [
      { header: 'Viewport' },
      { label: 'Fit to the panel', note: 'the page’s viewport is whatever room there is', checked: P.vp.name === 'fit', run: function () { setViewport('fit'); } },
      { label: 'Laptop · 1280 × 800', run: function () { setViewport('custom', { w: 1280, h: 800 }); } },
      { label: 'Full HD · 1920 × 1080', run: function () { setViewport('custom', { w: 1920, h: 1080 }); } },
      { label: 'Small phone · 360 × 740', run: function () { setViewport('custom', { w: 360, h: 740 }); } },
      { label: 'Other size…', run: async function () {
        var v = await L.dialog({ title: 'Viewport size', text: 'The page’s CSS viewport, in pixels. Media queries see exactly this.', fields: [{ key: 'w', label: 'Width', value: String(P.vp.w) }, { key: 'h', label: 'Height', value: String(P.vp.h) }], ok: 'Apply' });
        if (!v) return;
        var w = Math.round(Number(v.w)), h = Math.round(Number(v.h));
        if (w >= 240 && w <= 4096 && h >= 240 && h <= 4096) setViewport('custom', { w: w, h: h }); else L.toast('A viewport is 240–4096 px each way.', true);
      } },
    ], { alignRight: true });
  }

  // ---- OPEN · LOAD · RELOAD (the last good frame stays until the new one is ready) ------------------------------------
  async function open(opts) {
    var o = opts || {};
    if (P.open) { placePanel(); return { ok: true }; }
    if (P.opening) return { ok: true };
    P.opening = true;
    P.open = true;
    $('wsWait').hidden = false;
    $('wsWaitText').textContent = 'Starting the dev server…';
    layout();
    var r = null;
    try { r = await api('/api/preview/start', {}); } catch (e) { r = { ok: false, why: e.message }; }
    P.opening = false;
    if (!r || !r.ok) {
      P.open = false; layout();
      if (r && r.configure && L.preview && L.preview.configure) { var go = await L.dialog({ title: 'Preview', text: (r.why || 'No preview target detected for this project.') + (r.detail ? '\n\n' + r.detail : ''), ok: 'Configure Preview…', cancel: 'Close' }); if (go) L.preview.configure(); }
      else notice((r && r.why) || 'the preview could not start', true);
      return r;
    }
    adopt(r.preview, true);
    // THE PAGE TAKES THE KEYBOARD — unless the person already clicked into it: focusing the frame element again resets
    // the page's own focus to its body (measured: a field clicked within ~300 ms of opening lost its caret).
    if (o.focus !== false) setTimeout(function () { var f = frameEl(); if (f && document.activeElement !== f) f.focus(); }, 300);
    poll();
    return { ok: true };
  }
  /** Take Core's preview state: its URL (the proxy), the shared viewport and page. */
  function adopt(fs, load) {
    if (!fs || !fs.url) return;
    var u; try { u = new URL(fs.url); } catch (e) { return; }
    P.origin = u.origin;
    P.url = fs.url;
    if (fs.viewport && fs.viewport.w && (fs.viewport.w !== P.vp.w || fs.viewport.h !== P.vp.h || fs.viewport.name !== P.vp.name)) { P.vp = { name: fs.viewport.name, w: fs.viewport.w, h: fs.viewport.h }; if (vpSeg) vpSeg.set(P.vp.name === 'fit' ? 'custom' : P.vp.name); }
    caps(fs.capabilities || []);
    if (load && !P.seenUrl) navigate(fs.path || u.pathname + u.search + u.hash || '/');
    fit();
  }
  function full(p) { try { return new URL(p || '/', P.url).href; } catch (e) { return P.url; } }
  /** LOAD INTO THE HIDDEN FRAME, then swap — the page never flashes blank. */
  function navigate(p) {
    if (!P.url) return;
    var next = other();
    var f = $(next);
    P.loading = next;
    P.ready = false;
    f.hidden = true;
    f.src = full(p);
    $('wsUrl').value = full(p).replace(/^https?:\/\//, '');
    clearTimeout(P.swapT);
    // A PAGE WITHOUT THE BRIDGE (a static file, a crash) is swapped in on its own load, not waited on forever.
    P.swapT = setTimeout(function () { if (P.loading === next) swap(next); }, 9000);
  }
  function swap(id) {
    clearTimeout(P.swapT);
    if (P.loading !== id) return;
    var prev = P.active;
    P.active = id; P.loading = null;
    $(id).hidden = false;
    $('wsWait').hidden = true;
    if (prev !== id) { var old = $(prev); old.hidden = true; setTimeout(function () { if (P.active !== prev) old.src = 'about:blank'; }, 300); }
    P.errors = []; paintErrors();
    // THE SELECTION COMES BACK after a reload — quietly: it never cancels a Pick the person armed, nor moves the focus.
    if (P.element) setTimeout(function () { send('select', { selector: P.element.selector, restore: true }); }, 200);
  }
  function reload() { navigate(P.path || '/'); }
  async function close() {
    P = Object.assign(fresh(), { detached: P.detached });
    ['wsFrame', 'wsFrameB'].forEach(function (id) { $(id).src = 'about:blank'; });
    $('wsFrame').hidden = false; $('wsFrameB').hidden = true;
    $('pvInsp').hidden = true;
    layout();
    await api('/api/preview/stop', {}).catch(function () {});
    poll();
  }

  // ---- THE BRIDGE: what the page tells the window --------------------------------------------------------------------
  function onMessage(e) {
    var m = e.data;
    if (!m || m.lain !== 1 || e.origin !== P.origin) return;
    var fromActive = frameEl() && e.source === frameEl().contentWindow;
    var fromLoading = P.loading && $(P.loading) && e.source === $(P.loading).contentWindow;
    if (!fromActive && !fromLoading) return;
    if (m.type === 'ready') {
      if (fromLoading) swap(P.loading);
      P.ready = true;   // the page's bridge answers: the model's actions can be delivered (actInFrame)
      setPath(m.url);
      $('pvHint').hidden = false;
      return;
    }
    if (!fromActive) return;
    if (m.type === 'nav') setPath(m.url);
    else if (m.type === 'inspecting') { $('pvHint').textContent = 'Drag to select a region — release to inspect'; }
    else if (m.type === 'selected') selected(m);
    else if (m.type === 'draft') { P.draft = { w: m.w, h: m.h, done: m.done, reset: m.reset }; if (m.reset) P.draft = null; inspector(); }
    else if (m.type === 'cancelled') { armed(false); $('pvHint').textContent = 'Hold and drag on the page to inspect'; }
    else if (m.type === 'error') { P.errors.push(m); if (P.errors.length > 50) P.errors.shift(); paintErrors(); }
    else if (m.type === 'gone') { P.element = null; inspector(); scopeLabel(); }
    else if (m.type === 'acted' && relay.waiting[m.id]) { var w = relay.waiting[m.id]; delete relay.waiting[m.id]; var r = Object.assign({}, m); delete r.lain; delete r.type; w(r); }
  }

  // ---- THE MODEL'S POINTER AND KEYBOARD (Noema §L) -------------------------------------------------------------------
  // Core queues what the model asked for (preview_click, preview_type_text …); while this Preview is open it fetches
  // the next action, hands it to the page's bridge — which acts on the page's own document and refuses anything that
  // would leave the Preview — and returns the answer. There is no OS input anywhere on this path.
  var relay = { on: false, waiting: {} };
  function actInFrame(a) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      // A PREVIEW THAT IS STILL LOADING is waited for (up to 20 s) — the first action after opening it used to fail.
      (function whenReady() {
        if (P.open && frameEl() && P.origin && P.ready) {
          var t = setTimeout(function () { delete relay.waiting[a.id]; resolve({ ok: false, why: 'the preview page did not answer — it may be busy or navigating' }); }, 15000);
          relay.waiting[a.id] = function (r) { clearTimeout(t); resolve(r); };
          send('act', a);
          return;
        }
        if (!P.open || Date.now() - t0 > 20000) { resolve({ ok: false, why: P.open ? 'the preview page did not finish loading within 20 s' : 'the Preview is not showing a page' }); return; }
        setTimeout(whenReady, 100);
      })();
    });
  }
  function relayLoop() {
    if (relay.on) return;
    relay.on = true;
    (async function loop() {
      while (P.open) {
        var r = null;
        try { r = await api('/api/preview/input/next', { waitMs: 15000 }); } catch (e) { await new Promise(function (res) { setTimeout(res, 1500); }); continue; }
        var a = r && r.action;
        if (!a || !a.id) continue;
        var out = await actInFrame(a);
        await api('/api/preview/input/result', { id: a.id, result: out }).catch(function () { return null; });
      }
      relay.on = false;
    })();
  }
  function frameLoaded(id) {
    // HELLO, after every load: the bridge answers "ready" (and learns which window may talk to it).
    var f = $(id);
    if (!f || !f.contentWindow || !P.origin || f.src === 'about:blank') return;
    var tries = 0;
    var hello = function () {
      if ((P.loading !== id && P.active !== id) || tries++ > 12) { if (P.loading === id && tries > 12) swap(id); return; }
      try { f.contentWindow.postMessage({ lain: 1, type: 'hello' }, P.origin); } catch (e) { /* navigating */ }
      if (P.loading === id) setTimeout(hello, 250);
    };
    hello();
  }
  function setPath(u) {
    if (!u) return;
    try { var pu = new URL(u); P.path = pu.pathname + pu.search + pu.hash; } catch (e) { return; }
    P.seenUrl = u;
    if (document.activeElement !== $('wsUrl')) $('wsUrl').value = u.replace(/^https?:\/\//, '');
    scopeLabel();
    api('/api/preview/set', { page: P.path }).catch(function () {});
  }
  function paintErrors() {
    var b = $('pvErrs');
    b.hidden = !P.errors.length;
    b.textContent = P.errors.length + ' error' + (P.errors.length === 1 ? '' : 's');
    b.setAttribute('data-tip', P.errors.length ? P.errors[P.errors.length - 1].message : '');
  }

  // ---- SELECTION → Core's Selection, the inspector, the scope of the next change ------------------------------------------
  function armed(on) { P.arming = on; $('wsPick').setAttribute('aria-pressed', String(on)); }
  async function selected(m) {
    if (!m.restore) armed(false);
    $('pvHint').textContent = 'Hold and drag on the page to inspect';
    P.element = m.element;
    P.draft0 = m.draft0 || null;
    P.draft = null;
    P.hints = m.element && m.element.hints ? m.element.hints : null;
    P.owners = [];
    inspector('Analyzing…');
    scopeLabel();
    var r = null;
    try { r = await api('/api/preview/select', { element: m.element, measure: m.measure, url: m.url }); } catch (e) { r = null; }
    if (r && r.ok) P.owners = r.owners || [];
    inspector();
    if (!m.restore) setTimeout(function () { var s = $('wsSayIn'); if (s) s.focus(); }, 0);
  }
  function nameOf(e) {
    if (!e) return 'this page';
    var h = e.hints || {};
    if (h.component) return h.component;
    return e.tag + (e.id ? '#' + e.id : e.classes ? '.' + String(e.classes).split(/\s+/).slice(0, 2).join('.') : '');
  }
  function inspector(status) {
    var box = $('pvInsp');
    var e = P.element;
    if (!e) { box.hidden = true; box.textContent = ''; placePanel(); return; }
    box.hidden = false;
    box.textContent = '';
    var top = el('div', 'pi-top');
    top.appendChild(el('b', '', nameOf(e)));
    if (e.rect) top.appendChild(el('small', '', e.rect.w + ' × ' + e.rect.h + ' at ' + e.rect.x + ', ' + e.rect.y));
    box.appendChild(top);
    var own = el('div', 'pi-own');
    var owners = (P.owners || []).slice();
    if (!owners.length && P.hints && P.hints.file) owners.push({ file: P.hints.file, line: P.hints.line, role: 'component', confidence: (P.hints.framework || 'framework') + ' dev hint' });
    if (status) own.appendChild(el('span', 'u-note', status));
    else if (!owners.length) own.appendChild(el('span', 'u-note', 'No source owner found yet — ask, and the Coding Agent will look.'));
    owners.slice(0, 3).forEach(function (o) {
      var b = el('button', '');
      b.appendChild(L.icon(o.role === 'style' ? 'palette' : 'code', 12));
      b.appendChild(el('span', '', String(o.file).split(/[\\/]/).slice(-3).join('/') + (o.line ? ':' + o.line : '')));
      b.appendChild(el('em', '', o.role + (o.confidence ? ' · ' + String(o.confidence).toLowerCase() : '')));
      b.setAttribute('data-tip', 'Open ' + o.file);
      b.onclick = function () { openSource(o); };
      own.appendChild(b);
    });
    box.appendChild(own);
    var css = el('div', 'pi-css');
    css.hidden = !P.showCss;
    var lay = e.layout || {};
    ['display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'font-size', 'justify-content', 'align-items'].forEach(function (k) {
      if (lay[k] == null || lay[k] === '' || lay[k] === 'normal' || lay[k] === '0px') return;
      var s = el('span', ''); s.appendChild(document.createTextNode(k + ': ')); s.appendChild(el('b', '', lay[k])); css.appendChild(s);
    });
    if (P.draft && P.draft0 && (P.draft.w !== P.draft0.w || P.draft.h !== P.draft0.h)) {
      var d = el('div', 'pi-draft');
      d.appendChild(L.icon('resize', 14));
      d.appendChild(el('span', '', 'Draft: width ' + P.draft0.w + ' → ' + P.draft.w + ' · height ' + P.draft0.h + ' → ' + P.draft.h));
      box.appendChild(d);
    }
    var acts = el('div', 'pi-acts');
    var btn = function (label, icon, fn, kind) { acts.appendChild(L.kit.button(label, 'sm ' + (kind || 'line'), fn, icon)); };
    if (P.draft && P.draft0 && (P.draft.w !== P.draft0.w || P.draft.h !== P.draft0.h)) {
      btn('Apply', 'check', applyDraft, 'pri');
      btn('Reset', 'rotate', function () { send('reset-draft'); P.draft = null; inspector(); });
    }
    btn('Ask about this', 'ask', function () { prefill('What is ' + nameOf(e) + ' and where does it come from?'); });
    btn('Edit size', 'resize', function () { L.toast('Drag a corner of the selection on the page — then Apply.'); });
    btn('Edit spacing', 'sliders', function () { prefill('Adjust the spacing of ' + nameOf(e) + ': '); });
    btn('Move', 'move', function () { prefill('Move ' + nameOf(e) + ' '); });
    if (owners.length) btn('Open source', 'code', function () { openSource(owners[0]); });
    btn('Clear', 'close', clearSel, 'ghost');
    var more = L.kit.button(P.showCss ? 'Hide computed' : 'Computed', 'sm ghost', function () { P.showCss = !P.showCss; inspector(); }, P.showCss ? 'down' : 'chevron');
    more.classList.add('pi-more');
    acts.appendChild(more);
    box.appendChild(acts);
    box.appendChild(css);
    placePanel();
  }
  function prefill(t) { var s = $('wsSayIn'); s.value = t; s.focus(); s.setSelectionRange(t.length, t.length); autosize(); }
  function clearSel() { P.element = null; P.draft = null; P.owners = []; send('clear'); inspector(); scopeLabel(); }
  function openSource(o) {
    if (!o || !o.file) return;
    var file = String(o.file).replace(/\\/g, '/');
    var S = L.state(); var root = S && S.workspace && S.workspace.project && S.workspace.project.root ? String(S.workspace.project.root).replace(/\\/g, '/') : '';
    if (root && file.toLowerCase().indexOf(root.toLowerCase() + '/') === 0) file = file.slice(root.length + 1);
    file = file.replace(/^\/+/, '');
    L.nav.go('ide');
    setTimeout(function () { Promise.resolve(L.source.openFile(file, { pin: true, line: o.line || 1 })).catch(function () {}); }, 80);
  }
  function scopeLabel() {
    var sc = $('wsScope');
    var e = P.element;
    sc.hidden = !e;
    sc.textContent = e ? 'Selected: ' + nameOf(e) + '  ×' : '';
    sc.setAttribute('data-tip', 'Clear the selection — the request then targets the whole page');
    $('wsSayIn').placeholder = e ? 'Ask or change ' + nameOf(e) + '…' : 'Ask to change this page…';
  }

  // ---- THE CHANGE: a scoped request for the Coding Agent (the same session) --------------------------------------------
  async function say(textIn) {
    var t = String(textIn != null ? textIn : $('wsSayIn').value || '').trim();
    if (!t) return;
    var b = $('wsSayGo'); b.disabled = true;
    var r = null;
    try { r = await api('/api/preview/change', { text: t, element: P.element || null, url: P.seenUrl || full(P.path) }); } catch (e) { r = { ok: false, why: e.message }; }
    b.disabled = false;
    if (!r || !r.ok) { if (r && r.projectRequired && L.work) { L.work.projectMenu(null, { reason: r.why }); return; } L.toast((r && r.why) || 'the change was not sent', true); return; }
    if (textIn == null) { $('wsSayIn').value = ''; autosize(); }
    L.toast('Sent to the Coding Agent' + (r.scope && r.scope.kind === 'element' ? ' — scoped to ' + nameOf(P.element) : ' — scoped to this page'));
    poll();
  }
  function applyDraft() {
    if (!P.draft || !P.draft0) return;
    var parts = [];
    if (P.draft.w !== P.draft0.w) parts.push('width ' + P.draft0.w + 'px → ' + P.draft.w + 'px');
    if (P.draft.h !== P.draft0.h) parts.push('height ' + P.draft0.h + 'px → ' + P.draft.h + 'px');
    say('Resize ' + nameOf(P.element) + ' (visual draft from the preview): ' + parts.join(', ') + ' at the ' + P.vp.w + '×' + P.vp.h + ' viewport. Change only what sizes this element, keep it responsive, and verify the result.');
  }
  function autosize() { var s = $('wsSayIn'); s.style.height = 'auto'; s.style.height = Math.min(110, s.scrollHeight) + 'px'; }

  // ---- THE BACKEND STRIP: dormant, and each capability's mode ----------------------------------------------------------
  function caps(list) {
    var box = $('pvCaps');
    var sig = JSON.stringify(list);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    var up = list.filter(function (c) { return c.awake; }).map(function (c) { return c.name; });
    var d = el('span', 'pc-dorm'); d.appendChild(L.icon('moon', 12)); d.appendChild(document.createTextNode(!list.length ? 'Backend dormant · requests go to the dev server' : up.length ? 'Backend dormant except ' + up.join(', ') : 'Backend dormant')); box.appendChild(d);
    list.forEach(function (c) {
      var b = el('button', 'pc');
      b.setAttribute('data-mode', c.mode);
      b.setAttribute('data-cap', c.name);
      b.setAttribute('data-awake', c.awake ? 'up' : c.waking ? 'waking' : 'no');
      b.appendChild(el('i', ''));
      var state = c.mode !== 'live' ? (c.mode === 'adapter' ? 'preview data' : 'off') : !c.wakes || c.awake ? 'live' : c.waking ? 'waking…' : 'wakes on use';
      b.appendChild(document.createTextNode(c.name + ' · ' + state));
      b.setAttribute('data-tip', (c.label || c.name) + ' — ' + c.match.join(', ') + (c.wakes ? ' · starts ' + c.command + ' on first use' : '') + (c.awake ? ' · awake' + (c.pid ? ' (pid ' + c.pid + ')' : '') : '') + (c.served ? ' · ' + c.served + ' request' + (c.served === 1 ? '' : 's') + ' answered' : '') + (c.lastPath ? ' · last ' + c.lastPath : ''));
      b.onclick = function () {
        L.kit.menu(b, [
          { header: c.name },
          { label: 'Off', note: c.awake ? 'stops the backend Noema woke for it' : 'the page sees a dormant backend', checked: c.mode === 'off', run: function () { setCap(c.name, 'off'); } },
          c.adapter ? { label: 'Preview data', note: 'answered from .lain preview data', checked: c.mode === 'adapter', run: function () { setCap(c.name, 'adapter'); } } : null,
          c.live ? { label: 'Live', note: c.wakes ? 'starts ' + c.command + ' when the page first needs it — nothing else wakes' : 'this capability’s real backend — nothing else wakes', checked: c.mode === 'live', run: function () { setCap(c.name, 'live'); } } : null,
          { sep: true },
          { label: 'As configured', note: 'back to .lain/preview.json', run: function () { setCap(c.name, 'default'); } },
        ].filter(Boolean), { alignRight: false });
      };
      box.appendChild(b);
    });
  }
  async function setCap(name, mode) {
    var r = await api('/api/preview/capability', { name: name, mode: mode }).catch(function (e) { return { ok: false, why: e.message }; });
    if (!r || !r.ok) { L.toast((r && r.why) || 'not changed', true); return; }
    caps(r.capabilities || []);
    L.toast(name + (mode === 'live' ? ' is live in this preview' : mode === 'adapter' ? ' answers from preview data' : mode === 'off' ? ' is off' : ' is back to its configured mode'));
  }

  function moreMenu(anchor) {
    L.kit.menu(anchor, [
      { label: 'Back', icon: 'back', run: function () { send('back'); } },
      { label: 'Forward', icon: 'arrow', run: function () { send('forward'); } },
      { label: 'Open in browser', note: 'the dev server’s own address', icon: 'openext', run: function () { var S = L.state(); var t = S && S.workshop && S.workshop.frame && S.workshop.frame.target; if (t && L.openExternal) L.openExternal(new URL(P.path || '/', t).href); } },
      { sep: true },
      { label: 'Configure Preview…', note: 'the command, the port, the backend capabilities', icon: 'gear', run: function () { if (L.preview && L.preview.configure) L.preview.configure(); } },
      { label: 'Stop the preview', note: 'the dev server stops if Noema started it', icon: 'stop', danger: true, run: close },
    ], { alignRight: true });
  }

  // ---- boot · render --------------------------------------------------------------------------------------------------
  var vpSeg = null;
  function boot(_api, _notice, _uiOf, _poll) {
    api = _api; notice = _notice; poll = _poll;
    $('pvTitleIc').appendChild(L.icon('preview', 14));
    $('pvUrlIc').appendChild(L.icon('globe', 13));
    $('wsReload').appendChild(L.icon('refresh', 14)); $('wsReload').setAttribute('data-tip', 'Reload (the page, not the backend)');
    $('wsPick').appendChild(L.icon('pointer', 16)); $('wsPick').setAttribute('data-tip', 'Inspect: click an element — or hold and drag on the page');
    $('wsMore').appendChild(L.icon('dots', 16)); $('wsMore').setAttribute('data-tip', 'More');
    $('wsDetach').appendChild(L.icon('openext', 15)); $('wsDetach').setAttribute('data-tip', 'Open in its own window — same page, selection and Coding Agent');
    $('wsClose').appendChild(L.icon('close', 16)); $('wsClose').setAttribute('data-tip', 'Close the preview');
    $('wsSayGo').appendChild(L.icon('send', 15));
    vpSeg = L.kit.segmented([['desktop', 'Desktop', { icon: 'monitor' }], ['tablet', 'Tablet', { icon: 'tablet' }], ['mobile', 'Mobile', { icon: 'phone' }], ['custom', 'Custom', { icon: 'resize' }]], 'desktop', function (id) { if (id === 'custom') customMenu(vpSeg.querySelector('[data-seg=custom]')); else setViewport(id); });
    $('pvVps').appendChild(vpSeg);
    $('wsReload').onclick = reload;
    $('wsPick').onclick = function () { var on = !P.arming; armed(on); send(on ? 'inspect' : 'cancel'); };
    // ESCAPE LEAVES PICK wherever the focus is: in the page the bridge hears it; in the Harness (the Pick button was
    // the last thing clicked) this does. Other Escape handlers still run — this only cancels an armed Pick.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && P.arming) { armed(false); send('cancel'); } }, true);
    $('wsMore').onclick = function (e) { e.stopPropagation(); moreMenu($('wsMore')); };
    $('wsClose').onclick = close;
    $('wsDetach').onclick = function () { L.hostCall('detach', { mode: 'preview' }).then(function (r) { if (r && r.ok === false) notice(r.why || 'the preview could not be detached', true); }); };
    $('wsSayGo').onclick = function () { say(); };
    $('wsSayIn').addEventListener('input', autosize);
    $('wsSayIn').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say(); } });
    $('wsScope').onclick = clearSel;
    $('pvErrs').onclick = function () { L.dialog({ title: 'Errors on this page', text: P.errors.slice(-12).map(function (x) { return x.message + (x.source ? '\n   ' + x.source + (x.line ? ':' + x.line : '') : ''); }).join('\n\n'), ok: 'Close', cancel: 'Clear' }).then(function (v) { if (v === false) { P.errors = []; paintErrors(); } }); };
    $('wsUrl').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var v = $('wsUrl').value.trim();
      // THE ADDRESS STAYS IN THE PREVIEW: a path on the project's own server.
      var m = /^(?:https?:\/\/[^/]+)?(\/.*)?$/.exec(v);
      navigate(m && m[1] ? m[1] : '/' + v.replace(/^\/+/, ''));
      $('wsFrame').focus();
    });
    ['wsFrame', 'wsFrameB'].forEach(function (id) { $(id).addEventListener('load', function () { frameLoaded(id); }); });
    window.addEventListener('message', onMessage);
    var pill = $('wsPill'); if (pill) pill.onclick = function () { if (L.preview) L.preview.open({ toggle: true }); else toggle(); };
    // THE DETACHED WINDOW: only the preview, on the same Core.
    if (location.hash === '#detached-preview') { document.body.classList.add('detached-preview'); P.detached = true; }
    watchSlots();
  }
  function toggle() { return P.open ? close() : open(); }
  var lastTab = '';
  function render(S) {
    var fs = S && S.workshop ? S.workshop.frame : null;
    // ANOTHER SURFACE OPENED IT (Chat, the Coding Agent, the detached window): this one shows it too.
    if (fs && !P.open && !P.opening) { P.open = true; layout(); adopt(fs, true); }
    else if (!fs && P.open && !P.opening) { P = Object.assign(fresh(), { detached: P.detached }); ['wsFrame', 'wsFrameB'].forEach(function (id) { $(id).src = 'about:blank'; }); layout(); }
    else if (fs && P.open) adopt(fs, false);
    if (P.open) relayLoop();
    var tab = L.nav && L.nav.tab ? L.nav.tab() : '';
    if (tab !== lastTab) { lastTab = tab; requestAnimationFrame(placePanel); }
    // LAIN'S OWN CHANGE LANDED (the session's changed files moved): once the turn is over, the page reloads —
    // double-buffered, so no flash. A project with hot reload has usually updated itself already; one without (a
    // plain static server) would otherwise keep showing the page from before the fix.
    var csig = JSON.stringify((S && S.changes) || []);
    var running = Boolean(S && S.header && S.header.status && S.header.status.state === 'RUNNING');
    if (lastChanges === null) lastChanges = csig;
    else if (csig !== lastChanges && !running) { lastChanges = csig; if (P.open) setTimeout(reload, 300); }
  }
  var lastChanges = null;

  L.workshop = { boot: boot, render: render, open: open, close: close, toggle: toggle, isOpen: function () { return P.open; }, place: placePanel, select: function (selector) { send('select', { selector: selector }); }, state: function () { return { open: P.open, url: P.seenUrl, element: P.element, viewport: P.vp, loading: Boolean(P.loading), active: P.active }; } };
}

function js() { return `(${client.toString()})();`; }

module.exports = { HTML, CSS, js, client };
