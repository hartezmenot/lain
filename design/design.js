/*
 * LAIN DESIGN — THE SURFACE. Loaded by page/shell/designentry.js the first time the Design room opens, and only when
 * LAIN Design is installed. It shows; Core decides. Every change the person makes here is sent to Core's /api/design
 * routes, which compute the source splice, write it behind the stale-edit guard and record it for Undo; the preview
 * reloads itself. Nothing here writes a file, and nothing here reaches the model except the prompt bar's message.
 *
 *   left    Screens (each with its layers) and "+" to add a component
 *   center  the canvas: every screen in a device frame, Design / Flow, zoom and pan, snapping guides, wires
 *   right   the Inspector: position, size, look, Animation, Behavior
 *   bottom  the prompt bar: one status line, the diff, the test result
 *   top     device, Design / Flow, Undo / Redo, Live, Run test, Open in IDE
 */
(function () {
  'use strict';
  const L = window.LAIN = window.LAIN || {};
  if (L.designUI) return;

  let D = null;            // deps from the entry: api, hostCall, notice, toast, icon, openInIde, status
  let root = null;         // the view element
  const st = {
    open: null, device: null, mode: 'design', zoom: 0.6, pan: { x: 40, y: 60 },
    frames: new Map(),     // screen file -> frame
    sel: null,             // { screen, node, layout, info }
    follow: null,          // a node to reselect after the next reload
    layers: new Map(),     // screen -> elements
    openScreens: new Set(),
    live: false, recording: [], session: null, polling: null, relayTimer: null, activityTimer: null,
    seq: 0, waits: new Map(), shown: false, layoutSave: null,
  };
  const $ = (id) => document.getElementById(id);
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function icon(name, size) { try { return D.icon(name, size || 15); } catch (e) { return h('span'); } }
  function btn(label, cls, onclick, ic) { const b = h('button', cls || 'dz-btn'); if (ic) b.appendChild(icon(ic, 14)); if (label) b.appendChild(document.createTextNode(label)); b.onclick = onclick; return b; }
  async function api(path, body) { try { return await D.api(path, body || {}); } catch (e) { return { ok: false, why: e.message }; } }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** A drag owns the mouse: the frames stop taking pointer events until it ends (else the iframe swallows the release). */
  function track(mv, up) {
    root.classList.add('dz-dragging');
    const end = (ev) => { root.classList.remove('dz-dragging'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', end); up(ev); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', end);
  }

  // ---- skeleton ---------------------------------------------------------------------------------------------------
  function build() {
    root.innerHTML = '';
    const dz = h('div', 'dz'); dz.id = 'dz';
    // TOP
    const top = h('div', 'dz-top');
    const dev = h('select'); dev.id = 'dzDevice'; dev.setAttribute('aria-label', 'Device');
    dev.onchange = () => { st.device = (st.open.devices || []).find((d) => d.id === dev.value) || st.device; saveLayout(); layoutFrames(); };
    top.appendChild(dev);
    const seg = h('div', 'dz-seg');
    const bD = btn('Design', '', () => setMode('design')); bD.id = 'dzModeDesign';
    const bF = btn('Flow', '', () => setMode('flow')); bF.id = 'dzModeFlow';
    seg.appendChild(bD); seg.appendChild(bF); top.appendChild(seg);
    top.appendChild(btn('', 'dz-btn', () => undo(false), 'undo')).id = 'dzUndo';
    const redo = btn('', 'dz-btn', () => undo(true), 'undo'); redo.id = 'dzRedo'; redo.style.transform = 'scaleX(-1)'; top.appendChild(redo);
    top.appendChild(h('span', 'sp'));
    const live = btn('Live', 'dz-btn', () => setLive(!st.live), 'pointer'); live.id = 'dzLive'; live.setAttribute('aria-pressed', 'false'); live.title = 'Use the screens like the app (and record a test)';
    top.appendChild(live);
    top.appendChild(btn('Run test', 'dz-btn', runTest, 'play')).id = 'dzRun';
    top.appendChild(btn('Open in IDE', 'dz-btn', openInIde, 'code')).id = 'dzIde';
    dz.appendChild(top);
    const banner = h('div', 'dz-banner'); banner.id = 'dzBanner'; banner.hidden = true; dz.appendChild(banner);
    // BODY
    const body = h('div', 'dz-body');
    const left = h('aside', 'dz-left'); left.id = 'dzLeft';
    const lh = h('div', 'dz-h'); lh.appendChild(h('span', '', 'Screens')); lh.appendChild(h('span', 'sp'));
    const add = btn('', 'dz-btn', () => addDialog(), 'plus'); add.id = 'dzAdd'; add.title = 'Add a component'; lh.appendChild(add);
    left.appendChild(lh);
    const list = h('div'); list.id = 'dzScreens'; left.appendChild(list);
    body.appendChild(left);
    const center = h('main', 'dz-center'); center.id = 'dzCenter';
    const vp = h('div', 'dz-vp'); vp.id = 'dzVp';
    const world = h('div', 'dz-world'); world.id = 'dzWorld';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'dz-flows'); svg.id = 'dzFlows'; svg.setAttribute('width', '1'); svg.setAttribute('height', '1');
    world.appendChild(svg);
    vp.appendChild(world); center.appendChild(vp);
    const zoom = h('div', 'dz-zoom');
    zoom.appendChild(btn('−', 'dz-btn', () => setZoom(st.zoom / 1.2)));
    const zl = h('span'); zl.id = 'dzZoom'; zoom.appendChild(zl);
    zoom.appendChild(btn('+', 'dz-btn', () => setZoom(st.zoom * 1.2)));
    zoom.appendChild(btn('Fit', 'dz-btn', fit));
    center.appendChild(zoom);
    body.appendChild(center);
    const right = h('aside', 'dz-right'); right.id = 'dzRight'; body.appendChild(right);
    dz.appendChild(body);
    // BOTTOM: the prompt bar
    const bar = h('div', 'dz-bar');
    const status = h('div', 'dz-status'); status.id = 'dzStatus'; status.appendChild(h('span', 'dot')); status.appendChild(h('span', '', 'Select a layer, or describe a change.'));
    bar.appendChild(status);
    const diff = h('details'); diff.id = 'dzDiffBox'; diff.hidden = true; diff.appendChild(h('summary', '', 'Changes')); const pre = h('pre', 'dz-diff'); pre.id = 'dzDiff'; diff.appendChild(pre); bar.appendChild(diff);
    const test = h('div', 'dz-test'); test.id = 'dzTest'; test.hidden = true; bar.appendChild(test);
    const inRow = h('div', 'in');
    const ta = h('textarea'); ta.id = 'dzPrompt'; ta.rows = 1; ta.placeholder = 'Describe a change to the selection or this screen…';
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); } };
    inRow.appendChild(ta);
    const go = btn('Send', 'dz-btn primary', sendPrompt); go.id = 'dzSend'; inRow.appendChild(go);
    bar.appendChild(inRow);
    dz.appendChild(bar);
    root.appendChild(dz);
    wireCanvas();
    paintInspector();
  }

  // ---- status line, diff, test result -------------------------------------------------------------------------------
  function status(text, kind) {
    const s = $('dzStatus'); if (!s) return;
    s.firstChild.className = `dot${kind ? ` ${kind}` : ''}`;
    s.lastChild.textContent = text;
  }
  function showDiff(text) {
    const box = $('dzDiffBox'); const pre = $('dzDiff');
    if (!text) { box.hidden = true; return; }
    box.hidden = false; pre.innerHTML = '';
    String(text).split('\n').forEach((ln) => { const s = h('span', /^\+ /.test(ln) ? 'a' : /^- /.test(ln) ? 'd' : '', `${ln}\n`); pre.appendChild(s); });
  }
  function showTest(steps, shot) {
    const box = $('dzTest'); box.innerHTML = '';
    if (!steps) { box.hidden = true; return; }
    box.hidden = false;
    const ol = h('ol');
    steps.forEach((s) => {
      const li = h('li', s.ok && !(s.errors || []).length ? '' : 'bad', `${s.action}${s.target ? ` ${typeof s.target === 'string' ? s.target : JSON.stringify(s.target)}` : ''} — ${s.ok ? 'ok' : `failed: ${s.why}`}${s.url ? ` · ${s.url}` : ''}${s.navigated ? ' (navigated)' : ''}${(s.errors || []).length ? ` · errors: ${s.errors.join(' | ')}` : ''}`);
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (shot) { const img = h('img'); img.src = shot; img.alt = 'Last step'; box.appendChild(img); }
  }

  // ---- opening ----------------------------------------------------------------------------------------------------
  async function open() {
    status('Opening the project…', 'run');
    const r = await api('/api/design/open', {});
    if (!r.ok) { status(r.why || 'Design could not open this project', 'bad'); banner(r.why); return; }
    st.open = r;
    const lay = r.layout || {};
    st.device = (r.devices || []).find((d) => d.id === lay.device) || (r.devices || [])[0];
    if (Number.isFinite(lay.zoom)) st.zoom = lay.zoom;
    const dev = $('dzDevice'); dev.innerHTML = '';
    (r.devices || []).forEach((d) => { const o = h('option', '', `${d.name} · ${d.width}×${d.height}`); o.value = d.id; dev.appendChild(o); });
    if (st.device) dev.value = st.device.id;
    const ro = r.readOnly ? r.why : r.editBlock ? `Read-only: ${r.editBlock}` : null;
    banner(ro || (r.previewWhy ? `No live preview: ${r.previewWhy}` : null));
    root.classList.toggle('dz-ro', Boolean(ro));
    st.screens = r.screens || [];
    st.flows = r.flows || [];
    paintScreens();
    buildFrames();
    setMode(st.mode);
    status(`${r.kind === 'web-react' ? 'React' : r.kind === 'web-html' ? 'Web' : r.kind} · ${st.screens.length} screen${st.screens.length === 1 ? '' : 's'}${r.readOnly ? ' · read-only' : ''}`, r.readOnly ? 'bad' : 'ok');
    startRelay();
  }
  function banner(text) { const b = $('dzBanner'); if (!b) return; b.hidden = !text; b.textContent = text || ''; }

  // ---- screens and layers (left) ----------------------------------------------------------------------------------
  function paintScreens() {
    const list = $('dzScreens'); list.innerHTML = '';
    (st.screens || []).forEach((s) => {
      const box = h('div', `dz-scr${st.openScreens.has(s.file) ? ' open' : ''}`);
      const row = h('button', `dz-scr-row${st.sel && st.sel.screen === s.file ? ' on' : ''}`);
      const car = h('span', 'dz-car'); car.appendChild(icon('chevron', 13)); row.appendChild(car);
      row.appendChild(h('span', '', s.name));
      row.appendChild(h('small', '', s.file));
      row.onclick = async (e) => {
        if (e.target.closest('.dz-car') || st.openScreens.has(s.file)) { if (st.openScreens.has(s.file)) st.openScreens.delete(s.file); else st.openScreens.add(s.file); }
        else st.openScreens.add(s.file);
        if (st.openScreens.has(s.file)) await loadLayers(s.file);
        focusFrame(s.file);
        paintScreens();
      };
      box.appendChild(row);
      if (st.openScreens.has(s.file)) box.appendChild(layerTree(s.file));
      list.appendChild(box);
    });
  }
  async function loadLayers(screen) {
    const r = await api('/api/design/screen', { screen });
    if (r.ok) st.layers.set(screen, r.elements);
    return r.ok ? r.elements : [];
  }
  function layerTree(screen) {
    const box = h('div', 'dz-layers');
    const els = st.layers.get(screen) || [];
    const by = new Map(els.map((e) => [e.id, e]));
    const depth = (e) => { let d = 0; let p = e.parent; while (p && by.has(p) && d < 14) { d += 1; p = by.get(p).parent; } return d; };
    els.slice(0, 400).forEach((e) => {
      const row = h('button', `dz-layer${st.sel && st.sel.node === e.id ? ' on' : ''}`);
      row.style.paddingLeft = `${6 + depth(e) * 12}px`;
      row.appendChild(h('span', 'tg', e.tag));
      row.appendChild(h('span', '', e.name !== e.tag ? e.name : ''));
      row.dataset.node = e.id;
      row.onclick = () => select(screen, e.id);
      // REORDER BY DRAGGING a layer before a sibling (same parent).
      row.draggable = !isReadOnly();
      row.ondragstart = (ev) => { ev.dataTransfer.setData('text/plain', e.id); ev.dataTransfer.effectAllowed = 'move'; };
      row.ondragover = (ev) => { const id = st.dragLayer; if (!id) return; const a = by.get(id); if (a && a.parent === e.parent && id !== e.id) { ev.preventDefault(); row.classList.add('drop-before'); } };
      row.ondragleave = () => row.classList.remove('drop-before');
      row.ondrop = async (ev) => {
        ev.preventDefault(); row.classList.remove('drop-before');
        const id = ev.dataTransfer.getData('text/plain'); const a = by.get(id); if (!a || a.parent !== e.parent) return;
        const sibs = (e.parent ? (by.get(e.parent) || {}).children || [] : els.filter((x) => !x.parent).map((x) => x.id)).filter((x) => x !== id);
        await edit({ op: 'reorder', node: id, index: Math.max(0, sibs.indexOf(e.id)) }, screen);
      };
      row.addEventListener('dragstart', () => { st.dragLayer = e.id; });
      row.addEventListener('dragend', () => { st.dragLayer = null; });
      box.appendChild(row);
    });
    return box;
  }

  // ---- the canvas -------------------------------------------------------------------------------------------------
  function buildFrames() {
    const world = $('dzWorld');
    for (const f of st.frames.values()) f.el.remove();
    st.frames.clear();
    (st.screens || []).forEach((s) => {
      const fr = h('div', 'dz-frame'); fr.dataset.screen = s.file;
      const lab = h('div', 'dz-flabel'); lab.appendChild(h('b', '', s.name)); lab.appendChild(h('span', '', s.file));
      fr.appendChild(lab);
      const dev = h('div', 'dz-device'); const scr = h('div', 'dz-screen');
      const ifr = h('iframe'); ifr.title = s.name; ifr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
      if (st.open.preview) ifr.src = `${st.open.preview}${s.route}`;
      scr.appendChild(ifr);
      const ov = h('div', 'dz-ov'); scr.appendChild(ov);
      dev.appendChild(scr); fr.appendChild(dev);
      world.appendChild(fr);
      const frame = { screen: s.file, info: s, el: fr, dev, scr, iframe: ifr, ov, label: lab, ready: false, nodes: [], scroll: { x: 0, y: 0 } };
      st.frames.set(s.file, frame);
      lab.onmousedown = (e) => frameDrag(e, frame);
    });
    layoutFrames();
  }
  function positions() {
    const out = {}; const saved = ((st.open && st.open.layout) || {}).screens || {};
    const w = (st.device ? st.device.width : 390) + 120; const hgt = (st.device ? st.device.height : 844) + 160;
    (st.screens || []).forEach((s, i) => {
      if (st.mode === 'flow' && saved[s.file]) out[s.file] = saved[s.file];
      else out[s.file] = st.mode === 'flow' ? { x: (i % 3) * (w + 160), y: Math.floor(i / 3) * hgt } : { x: i * w, y: 0 };
    });
    return out;
  }
  function layoutFrames() {
    const pos = positions(); const d = st.device || { width: 390, height: 844, mobile: true };
    for (const f of st.frames.values()) {
      const p = pos[f.screen] || { x: 0, y: 0 };
      f.el.style.left = `${p.x}px`; f.el.style.top = `${p.y}px`;
      f.dev.classList.toggle('desktop', !d.mobile);
      f.iframe.style.width = `${d.width}px`; f.iframe.style.height = `${d.height}px`;
      f.pos = p;
    }
    applyView();
    drawFlows();
    drawSelection();
  }
  function applyView() {
    const w = $('dzWorld'); if (!w) return;
    w.style.transform = `translate(${st.pan.x}px, ${st.pan.y}px) scale(${st.zoom})`;
    const z = $('dzZoom'); if (z) z.textContent = `${Math.round(st.zoom * 100)}%`;
  }
  function setZoom(z, at) {
    const nz = Math.max(0.1, Math.min(3, z));
    if (at) { st.pan.x = at.x - ((at.x - st.pan.x) * nz) / st.zoom; st.pan.y = at.y - ((at.y - st.pan.y) * nz) / st.zoom; }
    st.zoom = nz; applyView(); saveLayout();
  }
  function fit() {
    const vp = $('dzVp'); if (!vp || !st.frames.size) return;
    let maxX = 0; let maxY = 0;
    for (const f of st.frames.values()) { maxX = Math.max(maxX, f.pos.x + f.el.offsetWidth); maxY = Math.max(maxY, f.pos.y + f.el.offsetHeight); }
    const z = Math.min((vp.clientWidth - 80) / Math.max(1, maxX), (vp.clientHeight - 100) / Math.max(1, maxY), 1.2);
    st.zoom = Math.max(0.1, z); st.pan = { x: 40, y: 60 }; applyView(); saveLayout();
  }
  function focusFrame(screen) {
    const f = st.frames.get(screen); const vp = $('dzVp'); if (!f || !vp) return;
    st.pan.x = vp.clientWidth / 2 - (f.pos.x + f.el.offsetWidth / 2) * st.zoom;
    st.pan.y = 60 - f.pos.y * st.zoom;
    applyView();
  }
  function wireCanvas() {
    const vp = $('dzVp');
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setZoom(st.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
      else { st.pan.x -= e.deltaX; st.pan.y -= e.deltaY; applyView(); }
    }, { passive: false });
    vp.addEventListener('mousedown', (e) => {
      if (e.target !== vp && e.target !== $('dzWorld') && e.target.id !== 'dzFlows') return;
      const s = { x: e.clientX, y: e.clientY, px: st.pan.x, py: st.pan.y };
      vp.classList.add('panning');
      track((ev) => { st.pan.x = s.px + ev.clientX - s.x; st.pan.y = s.py + ev.clientY - s.y; applyView(); }, () => vp.classList.remove('panning'));
    });
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', (e) => {
      if (!st.shown || !root.offsetParent) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(e.shiftKey); }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); undo(true); }
      else if (k === 'escape') { select(null, null); }
      else if ((k === 'delete' || k === 'backspace') && st.sel && st.sel.node) { e.preventDefault(); edit({ op: 'remove', node: st.sel.node }); }
    });
  }
  function frameDrag(e, f) {
    if (st.mode !== 'flow') return;
    e.preventDefault();
    const s = { x: e.clientX, y: e.clientY, fx: f.pos.x, fy: f.pos.y };
    const mv = (ev) => { f.pos = { x: Math.round(s.fx + (ev.clientX - s.x) / st.zoom), y: Math.round(s.fy + (ev.clientY - s.y) / st.zoom) }; f.el.style.left = `${f.pos.x}px`; f.el.style.top = `${f.pos.y}px`; drawFlows(); drawSelection(); };
    track(mv, () => { const lay = (st.open.layout = st.open.layout || {}); lay.screens = lay.screens || {}; lay.screens[f.screen] = f.pos; saveLayout(); });
  }
  /** The sidecar holds canvas layout only (device, zoom, Flow positions). */
  function saveLayout() {
    if (!st.open || st.open.readOnly) return;
    clearTimeout(st.layoutSave);
    st.layoutSave = setTimeout(() => {
      const lay = st.open.layout || {};
      api('/api/design/layout', { set: { device: st.device && st.device.id, zoom: st.zoom, screens: lay.screens || {} } });
    }, 400);
  }
  function setMode(m) {
    st.mode = m === 'flow' ? 'flow' : 'design';
    $('dzModeDesign').setAttribute('aria-pressed', String(st.mode === 'design'));
    $('dzModeFlow').setAttribute('aria-pressed', String(st.mode === 'flow'));
    root.classList.toggle('dz-mode-flow', st.mode === 'flow');
    layoutFrames();
    if (st.mode === 'flow') refreshFlows();
  }
  function setLive(on) {
    st.live = Boolean(on);
    $('dzLive').setAttribute('aria-pressed', String(st.live));
    if (st.live) { st.recording = []; status('Live: use the screens; what you do is recorded for Run test', 'run'); } else if (st.recording.length) status(`Recorded ${st.recording.length} step(s) — Run test replays them`, 'ok');
    for (const f of st.frames.values()) post(f, { type: 'mode', mode: st.live ? 'live' : 'design', drawSel: false });
    drawSelection();
  }

  // ---- talking to the frames' runtime -----------------------------------------------------------------------------
  function post(f, msg) { try { f.iframe.contentWindow.postMessage(Object.assign({ lainDesign: 1 }, msg), '*'); } catch (e) { /* not loaded */ } }
  function ask(f, msg, type, ms) {
    const seq = ++st.seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { st.waits.delete(seq); resolve(null); }, ms || 3000);
      st.waits.set(seq, { type, resolve: (d) => { clearTimeout(t); resolve(d); } });
      post(f, Object.assign({}, msg, { seq }));
    });
  }
  function frameOf(win) { for (const f of st.frames.values()) if (f.iframe.contentWindow === win) return f; return null; }
  function onMessage(e) {
    const d = e.data; if (!d || !d.lainDesign) return;
    const f = frameOf(e.source); if (!f) return;
    if (d.type === 'ready') {
      f.ready = true;
      post(f, { type: 'mode', mode: st.live ? 'live' : 'design', drawSel: false });
      measureFrame(f).then(() => {
        if (st.follow && st.follow.screen === f.screen) { const id = st.follow.node; st.follow = null; select(f.screen, id, { quiet: true }); } else if (st.sel && st.sel.screen === f.screen) select(f.screen, st.sel.node, { quiet: true });
        drawFlows();
      });
      if (d.actSeq && st.waits.has(d.actSeq)) { const w = st.waits.get(d.actSeq); st.waits.delete(d.actSeq); w.resolve({ result: { ok: true }, observation: d.observation, navigated: true }); }
      return;
    }
    if (d.seq && st.waits.has(d.seq)) { const w = st.waits.get(d.seq); if (!w.type || w.type === d.type) { st.waits.delete(d.seq); w.resolve(d); return; } }
    if (d.type === 'select' && !st.live) { if (st.wiring) return; select(f.screen, d.id); return; }
    if (d.type === 'record' && st.live && d.step) { st.recording.push(Object.assign({ screen: f.screen }, d.step)); status(`Live · ${st.recording.length} step(s) recorded`, 'run'); }
  }
  async function measureFrame(f, id) {
    const r = await ask(f, { type: 'measure', id: id || null }, 'measured');
    if (r) { f.nodes = r.nodes || []; f.scroll = r.scroll || { x: 0, y: 0 }; }
    return r;
  }

  // ---- selection, overlay, drag, resize, snapping ------------------------------------------------------------------
  async function select(screen, node, opts) {
    if (!screen || !node) { st.sel = null; drawSelection(); paintInspector(); paintScreens(); return; }
    const f = st.frames.get(screen);
    st.sel = { screen, node, layout: null, info: null };
    if (f) { const m = await measureFrame(f, node); if (st.sel && st.sel.node === node) st.sel.layout = m ? m.layout : null; }
    const info = await api('/api/design/inspect', { node });
    if (!st.sel || st.sel.node !== node) return;
    st.sel.info = info.ok ? info : null;
    if (!info.ok && info.gone) { st.sel = null; }
    if (!st.layers.has(screen)) await loadLayers(screen);
    st.openScreens.add(screen);
    drawSelection(); paintInspector(); paintScreens();
    if (!(opts && opts.quiet) && info.ok) status(`${info.tag}${info.elementId ? `#${info.elementId}` : ''}${info.classes.length ? `.${info.classes.join('.')}` : ''} — ${info.file}:${info.line}`, '');
  }
  function rectInFrame(f, r) { return { x: r.x - f.scroll.x, y: r.y - f.scroll.y, w: r.w, h: r.h }; }
  function drawSelection() {
    for (const f of st.frames.values()) f.ov.innerHTML = '';
    if (!st.sel || !st.sel.layout || st.live) return;
    const f = st.frames.get(st.sel.screen); if (!f) return;
    const lay = st.sel.layout; const r = rectInFrame(f, lay.rect);
    const box = h('div', `dz-sel${/absolute|fixed/.test(lay.position) ? '' : ' static'}`);
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const tag = h('div', 'tag', `${lay.tag} ${Math.round(r.w)}×${Math.round(r.h)}`); box.appendChild(tag);
    if (!isReadOnly()) {
      const hd = h('div', 'hd'); box.appendChild(hd);
      hd.onmousedown = (e) => resizeDrag(e, f, lay);
      const w = h('div', 'wire', '→'); w.title = 'Drag to a screen to wire it'; box.appendChild(w);
      w.onmousedown = (e) => wireDrag(e, f);
      box.onmousedown = (e) => { if (e.target === box || e.target === tag) moveDrag(e, f, lay); };
    }
    f.ov.appendChild(box);
  }
  function guidesFor(moving, lay) {
    // THE SAME RULE AS design-core's snap.js: edges and centres of the parent's content box and the siblings, within 6px.
    const T = 6 / Math.max(st.zoom, 0.2);
    const targets = [];
    if (lay.parent) { const p = lay.parent.rect; const pd = lay.parent.padding || { top: 0, right: 0, bottom: 0, left: 0 }; targets.push({ x: p.x + pd.left, y: p.y + pd.top, w: p.w - pd.left - pd.right, h: p.h - pd.top - pd.bottom }); }
    (lay.siblings || []).filter((s) => s.id !== lay.id).forEach((s) => targets.push(s.rect));
    const xs = (r) => [r.x, r.x + r.w / 2, r.x + r.w]; const ys = (r) => [r.y, r.y + r.h / 2, r.y + r.h];
    let bx = null; let by = null;
    for (const t of targets) {
      for (const a of xs(moving)) for (const b of xs(t)) { const d = b - a; if (Math.abs(d) <= T && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: b }; }
      for (const a of ys(moving)) for (const b of ys(t)) { const d = b - a; if (Math.abs(d) <= T && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: b }; }
    }
    return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, gx: bx ? bx.at : null, gy: by ? by.at : null };
  }
  function moveDrag(e, f, lay) {
    e.preventDefault(); e.stopPropagation();
    const s = { x: e.clientX, y: e.clientY }; const r0 = rectInFrame(f, lay.rect);
    const ghost = h('div', 'dz-ghost'); f.ov.appendChild(ghost);
    const gv = h('div', 'dz-guide v'); const gh = h('div', 'dz-guide h'); f.ov.appendChild(gv); f.ov.appendChild(gh);
    let dx = 0; let dy = 0;
    const mv = (ev) => {
      dx = (ev.clientX - s.x) / st.zoom; dy = (ev.clientY - s.y) / st.zoom;
      const moving = { x: lay.rect.x + dx, y: lay.rect.y + dy, w: lay.rect.w, h: lay.rect.h };
      const g = ev.altKey ? { dx: 0, dy: 0, gx: null, gy: null } : guidesFor(moving, lay);
      dx += g.dx; dy += g.dy;
      Object.assign(ghost.style, { left: `${r0.x + dx}px`, top: `${r0.y + dy}px`, width: `${r0.w}px`, height: `${r0.h}px` });
      gv.style.display = g.gx == null ? 'none' : 'block'; gh.style.display = g.gy == null ? 'none' : 'block';
      if (g.gx != null) Object.assign(gv.style, { left: `${g.gx - f.scroll.x}px`, top: '0px', height: '100%' });
      if (g.gy != null) Object.assign(gh.style, { top: `${g.gy - f.scroll.y}px`, left: '0px', width: '100%' });
    };
    track(mv, async (ev) => {
      ghost.remove(); gv.remove(); gh.remove();
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const drop = { x: lay.rect.x + lay.rect.w / 2 + dx, y: lay.rect.y + lay.rect.h / 2 + dy };
      await edit({ op: 'move', node: st.sel.node, dx: Math.round(dx), dy: Math.round(dy), layout: lay, drop }, f.screen, { at: { x: ev.clientX, y: ev.clientY } });
    });
  }
  function resizeDrag(e, f, lay) {
    e.preventDefault(); e.stopPropagation();
    const s = { x: e.clientX, y: e.clientY }; const r0 = rectInFrame(f, lay.rect);
    const ghost = h('div', 'dz-ghost'); f.ov.appendChild(ghost);
    let dw = 0; let dh = 0;
    const mv = (ev) => { dw = Math.round((ev.clientX - s.x) / st.zoom); dh = Math.round((ev.clientY - s.y) / st.zoom); Object.assign(ghost.style, { left: `${r0.x}px`, top: `${r0.y}px`, width: `${Math.max(1, r0.w + dw)}px`, height: `${Math.max(1, r0.h + dh)}px` }); };
    track(mv, async () => {
      ghost.remove();
      if (!dw && !dh) return;
      await edit({ op: 'resize', node: st.sel.node, dw, dh, layout: lay, corner: 'se' }, f.screen);
    });
  }
  /** Drag the selection's wire handle onto another screen: the Behavior section opens with that target. */
  function wireDrag(e, f) {
    e.preventDefault(); e.stopPropagation();
    st.wiring = true;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); $('dzFlows').appendChild(line);
    const lay = st.sel.layout; const r = rectInFrame(f, lay.rect);
    const from = worldPoint(f, { x: r.x + r.w, y: r.y + r.h / 2 });
    const toWorld = (ev) => { const vp = $('dzVp').getBoundingClientRect(); return { x: (ev.clientX - vp.left - st.pan.x) / st.zoom, y: (ev.clientY - vp.top - st.pan.y) / st.zoom }; };
    const mv = (ev) => { const p = toWorld(ev); line.setAttribute('d', `M${from.x},${from.y} C${from.x + 80},${from.y} ${p.x - 80},${p.y} ${p.x},${p.y}`); };
    track(mv, (ev) => {
      line.remove(); st.wiring = false;
      const p = toWorld(ev);
      for (const g of st.frames.values()) {
        if (g === f) continue;
        if (p.x >= g.pos.x && p.x <= g.pos.x + g.el.offsetWidth && p.y >= g.pos.y - 30 && p.y <= g.pos.y + g.el.offsetHeight) { st.wireTarget = g.screen; paintInspector(); const sec = $('dzBehavior'); if (sec) sec.scrollIntoView({ block: 'nearest' }); status(`Wire to ${g.info.name}: choose the trigger and transition, then Add`, ''); return; }
      }
    });
  }
  function worldPoint(f, p) {
    const pad = f.dev.offsetLeft + (f.scr.offsetLeft || 0);
    return { x: f.pos.x + f.dev.offsetLeft + 10 + p.x, y: f.pos.y + f.dev.offsetTop + 10 + p.y + (pad ? 0 : 0) };
  }

  // ---- flows (Flow mode) --------------------------------------------------------------------------------------------
  async function refreshFlows() {
    const r = await api('/api/design/flows', {});
    if (r.ok) { st.flows = r.flows; st.presets = r.presets; st.easings = r.easings; }
    drawFlows();
  }
  function drawFlows() {
    const svg = $('dzFlows'); if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (st.mode !== 'flow') return;
    let maxX = 0; let maxY = 0;
    for (const f of st.frames.values()) { maxX = Math.max(maxX, f.pos.x + f.el.offsetWidth + 200); maxY = Math.max(maxY, f.pos.y + f.el.offsetHeight + 200); }
    svg.setAttribute('width', String(maxX)); svg.setAttribute('height', String(maxY));
    const seen = new Set();
    (st.flows || []).forEach((w) => {
      const a = st.frames.get(w.screen); const b = st.frames.get(w.target);
      if (!a || !b || a === b) return;
      const n = a.nodes.find((x) => x.id === w.source.node);
      const key = `${w.screen}|${w.source.node}|${w.target}`; if (seen.has(key)) return; seen.add(key);
      const r = n ? rectInFrame(a, n.rect) : { x: (st.device ? st.device.width : 390) - 10, y: 20, w: 10, h: 10 };
      const p0 = worldPoint(a, { x: r.x + r.w, y: r.y + r.h / 2 });
      const p1 = { x: b.pos.x, y: b.pos.y + 40 };
      const back = p1.x < p0.x;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const c1 = back ? { x: p0.x + 60, y: p0.y - 120 } : { x: p0.x + (p1.x - p0.x) / 2, y: p0.y };
      const c2 = back ? { x: p1.x - 60, y: p1.y - 120 } : { x: p0.x + (p1.x - p0.x) / 2, y: p1.y };
      path.setAttribute('d', `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p1.x},${p1.y}`);
      path.setAttribute('class', w.origin === 'design' ? 'design' : 'code');
      path.setAttribute('marker-end', 'url(#dzArrow)');
      svg.appendChild(path);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String((p0.x + p1.x) / 2)); t.setAttribute('y', String((p0.y + p1.y) / 2 - 6)); t.setAttribute('class', 'wl');
      t.textContent = `${w.trigger}${w.transition && w.transition !== 'none' ? ` · ${w.transition}` : ''}`;
      t.onclick = () => select(w.screen, w.source.node);
      svg.appendChild(t);
    });
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="dzArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9B8AFB"/></marker>';
    svg.appendChild(defs);
  }

  // ---- edits --------------------------------------------------------------------------------------------------------
  function isReadOnly() { return Boolean(!st.open || st.open.readOnly || st.open.editBlock); }
  /**
   * ONE EDIT through Core. A question (shared class, flex child) is asked here, and the edit repeated with the answer.
   */
  async function edit(op, screen, opts) {
    if (isReadOnly()) { status(st.open && (st.open.why || st.open.editBlock) ? `Read-only: ${st.open.why || st.open.editBlock}` : 'Read-only', 'bad'); return null; }
    status('Changing the source…', 'run');
    const r = await api('/api/design/edit', { op });
    if (!r.ok) { status(r.why || 'not changed', 'bad'); return r; }
    if (!r.applied) {
      if (r.needs && r.needs.scope) {
        const pick = await question(r.needs.scope.question, [{ id: 'only', label: 'Only this one' }, { id: 'all', label: `All ${r.needs.scope.uses} uses` }]);
        if (!pick) { status('Not changed', ''); return r; }
        return edit(Object.assign({}, op, { scope: pick }), screen, opts);
      }
      if (r.needs && r.needs.choice) {
        const c = r.needs.choice;
        const pick = await chooser(c, opts && opts.at);
        if (!pick) { status('Not changed', ''); return r; }
        return edit(Object.assign({}, op, { choice: pick }), screen, opts);
      }
      status(r.why || 'not changed', 'bad');
      if (r.stale) refreshAll();
      return r;
    }
    status(r.summary, 'ok'); showDiff(r.diff);
    const scr = screen || (st.sel && st.sel.screen);
    if (r.followId && scr) st.follow = { screen: scr, node: r.followId };
    if (scr) st.layers.delete(scr);
    await afterEdit(scr);
    return r;
  }
  /** After a commit the preview reloads by itself (the runtime's reload channel, or Vite); re-read what we show. */
  async function afterEdit(screen) {
    if (screen && st.openScreens.has(screen)) await loadLayers(screen);
    paintScreens();
    if (st.mode === 'flow') refreshFlows();
    // a React screen hot-reloads without a 'ready': re-measure shortly
    setTimeout(() => { for (const f of st.frames.values()) measureFrame(f).then(() => { if (st.follow && st.follow.screen === f.screen) { const id = st.follow.node; st.follow = null; select(f.screen, id, { quiet: true }); } else if (st.sel && st.sel.screen === f.screen) select(f.screen, st.sel.node, { quiet: true }); drawFlows(); }); }, 900);
  }
  async function refreshAll() { await open(); }
  async function undo(redo) {
    const r = await api('/api/design/undo', { redo: Boolean(redo) });
    if (!r.ok || r.applied === false) { status(r.why || 'nothing to undo', 'bad'); return; }
    status(`${redo ? 'Redid' : 'Undid'}: ${r.label}`, 'ok'); showDiff('');
    st.layers.clear();
    await afterEdit(st.sel && st.sel.screen);
  }
  function question(text, options) {
    return new Promise((resolve) => {
      const m = h('div', 'dz-modal'); const box = h('div', 'box');
      box.appendChild(h('h4', '', text));
      const row = h('div', 'row');
      row.appendChild(btn('Cancel', 'dz-btn', () => { m.remove(); resolve(null); }));
      options.forEach((o, i) => row.appendChild(btn(o.label, i === 0 ? 'dz-btn primary' : 'dz-btn', () => { m.remove(); resolve(o.id); })));
      box.appendChild(row); m.appendChild(box); document.body.appendChild(m);
      m.onclick = (e) => { if (e.target === m) { m.remove(); resolve(null); } };
    });
  }
  /** The flex/grid child's choice: a chip at the drop point, the default first. */
  function chooser(c, at) {
    return new Promise((resolve) => {
      const pop = h('div', 'dz-pop'); pop.id = 'dzChoice';
      pop.appendChild(h('p', '', c.flexChild ? 'This sits in a flex/grid row. Move it how?' : 'This flows with the page. Move it how?'));
      const order = c.choices.slice().sort((a, b) => (a.id === c.default ? -1 : b.id === c.default ? 1 : 0));
      order.forEach((x) => pop.appendChild(btn(`${x.label}${x.index != null ? ` (to ${x.index + 1})` : ''}`, x.id === c.default ? 'dz-btn primary' : 'dz-btn', () => { pop.remove(); resolve(x.id); })));
      pop.appendChild(btn('Cancel', 'dz-btn', () => { pop.remove(); resolve(null); }));
      const center = $('dzCenter'); const cr = center.getBoundingClientRect();
      pop.style.left = `${Math.max(8, ((at && at.x) || cr.left + cr.width / 2) - cr.left)}px`; pop.style.top = `${Math.max(8, ((at && at.y) || cr.top + 100) - cr.top)}px`;
      center.appendChild(pop);
    });
  }

  // ---- the Inspector (right) -----------------------------------------------------------------------------------------
  function px(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function field(sec, label, opts) {
    const row = h('div', 'dz-f'); row.appendChild(h('label', '', label));
    const rng = h('input'); rng.type = 'range'; rng.min = String(opts.min); rng.max = String(opts.max); rng.step = String(opts.step || 1); rng.value = String(opts.value);
    const num = h('input'); num.type = 'number'; num.step = String(opts.step || 1); num.value = String(opts.value);
    rng.oninput = () => { num.value = rng.value; };
    num.oninput = () => { rng.value = num.value; };
    const commit = () => opts.commit(Number(num.value));
    rng.onchange = commit; num.onchange = commit;
    if (isReadOnly() || opts.disabled) { rng.disabled = true; num.disabled = true; }
    rng.setAttribute('aria-label', label); rng.dataset.prop = opts.prop || label.toLowerCase();
    row.appendChild(rng); row.appendChild(num); sec.appendChild(row);
    return rng;
  }
  function sel2(sec, label, values, value, onchange) {
    const row = h('div', 'dz-f2'); row.appendChild(h('label', '', label));
    const s = h('select'); values.forEach((v) => { const o = h('option', '', typeof v === 'string' ? v : v.label); o.value = typeof v === 'string' ? v : v.id; s.appendChild(o); });
    if (value != null) s.value = value; if (onchange) s.onchange = () => onchange(s.value);
    row.appendChild(s); sec.appendChild(row); return s;
  }
  function setStyle(props) { return edit({ op: 'setStyle', node: st.sel.node, props }, st.sel.screen); }
  function paintInspector() {
    const right = $('dzRight'); if (!right) return;
    right.innerHTML = '';
    if (!st.sel || !st.sel.info) {
      right.appendChild(h('div', 'dz-h', 'Inspector'));
      right.appendChild(h('div', 'dz-ins-empty', st.open && st.open.readOnly ? st.open.why : 'Click a layer on the canvas or in Screens. Drag it to move it; the corner resizes it; the → handle wires it to another screen. Every change is made in the source, and Ctrl+Z undoes it.'));
      return;
    }
    const info = st.sel.info; const lay = st.sel.layout || { rect: { x: 0, y: 0, w: 0, h: 0 }, position: 'static', style: {} };
    const dec = info.declared || {}; const cs = lay.style || {};
    const box = h('div', 'dz-ins');
    box.appendChild(h('h3', '', `${info.tag}${info.elementId ? `#${info.elementId}` : ''}`));
    const src = h('div', 'src'); src.appendChild(h('span', '', `${info.file}:${info.line}`));
    const oi = h('button', '', 'Open'); oi.onclick = () => D.openInIde(info.file, info.line); src.appendChild(oi); box.appendChild(src);
    const tgt = info.target || {};
    box.appendChild(h('div', 'dz-note', tgt.kind === 'shared' ? `.${tgt.cls} is used ${tgt.uses}×: a change asks whether to change all of them.` : tgt.kind === 'scoped' ? `New styles go to a new class .${tgt.cls}.` : tgt.kind === 'class' ? `Styles go to .${tgt.cls} (${tgt.sheet}).` : tgt.kind === 'tailwind' ? 'Styles are written as Tailwind utilities.' : 'Styles go to the inline style.'));
    // LAYOUT
    const s1 = h('div', 'dz-sec'); s1.appendChild(h('div', 'dz-h', 'Layout'));
    const abs = /absolute|fixed/.test(lay.position);
    const c = lay.containing || { x: 0, y: 0, w: 400, h: 800 };
    field(s1, 'X', { prop: 'x', min: -200, max: Math.round(c.w + 200), value: Math.round(lay.rect.x - c.x), disabled: !abs, commit: (v) => edit({ op: 'move', node: st.sel.node, dx: v - Math.round(lay.rect.x - c.x), dy: 0, layout: lay }, st.sel.screen) });
    field(s1, 'Y', { prop: 'y', min: -200, max: Math.round(c.h + 200), value: Math.round(lay.rect.y - c.y), disabled: !abs, commit: (v) => edit({ op: 'move', node: st.sel.node, dx: 0, dy: v - Math.round(lay.rect.y - c.y), layout: lay }, st.sel.screen) });
    if (!abs) s1.appendChild(h('div', 'dz-note', `Positioned by its parent (${lay.parentDisplay || 'flow'}). Drag it to reorder or offset it.`));
    field(s1, 'W', { prop: 'width', min: 0, max: 1200, value: Math.round(lay.rect.w), commit: (v) => setStyle({ width: `${v}px` }) });
    field(s1, 'H', { prop: 'height', min: 0, max: 1600, value: Math.round(lay.rect.h), commit: (v) => setStyle({ height: `${v}px` }) });
    if (/flex|grid/.test(lay.display || '')) field(s1, 'Gap', { prop: 'gap', min: 0, max: 80, value: px(dec.gap ? dec.gap.value : cs.gap), commit: (v) => setStyle({ gap: `${v}px` }) });
    field(s1, 'Padding', { prop: 'padding', min: 0, max: 80, value: px(dec.padding ? dec.padding.value : cs.padding), commit: (v) => setStyle({ padding: `${v}px` }) });
    box.appendChild(s1);
    // LOOK
    const s2 = h('div', 'dz-sec'); s2.appendChild(h('div', 'dz-h', 'Look'));
    field(s2, 'Radius', { prop: 'border-radius', min: 0, max: 200, value: px(dec['border-radius'] ? dec['border-radius'].value : cs.borderRadius), commit: (v) => setStyle({ 'border-radius': `${v}px` }) });
    field(s2, 'Opacity', { prop: 'opacity', min: 0, max: 1, step: 0.05, value: Number(dec.opacity ? dec.opacity.value : (cs.opacity || 1)), commit: (v) => setStyle({ opacity: String(Math.round(v * 100) / 100) }) });
    field(s2, 'Rotation', { prop: 'rotate', min: -180, max: 180, value: px(dec.rotate ? dec.rotate.value : 0), commit: (v) => setStyle({ rotate: `${v}deg` }) });
    field(s2, 'Font size', { prop: 'font-size', min: 6, max: 96, value: px(dec['font-size'] ? dec['font-size'].value : cs.fontSize), commit: (v) => setStyle({ 'font-size': `${v}px` }) });
    const colorRow = h('div', 'dz-f2'); colorRow.appendChild(h('label', '', 'Color'));
    const col = h('input'); col.type = 'color'; col.value = hex(dec.color ? dec.color.value : cs.color); col.onchange = () => setStyle({ color: col.value }); col.disabled = isReadOnly(); colorRow.appendChild(col); s2.appendChild(colorRow);
    const bgRow = h('div', 'dz-f2'); bgRow.appendChild(h('label', '', 'Fill'));
    const bg = h('input'); bg.type = 'color'; bg.value = hex(dec['background-color'] ? dec['background-color'].value : cs.backgroundColor, '#ffffff'); bg.onchange = () => setStyle({ 'background-color': bg.value }); bg.disabled = isReadOnly(); bgRow.appendChild(bg); s2.appendChild(bgRow);
    box.appendChild(s2);
    // ANIMATION
    const s3 = h('div', 'dz-sec'); s3.appendChild(h('div', 'dz-h', 'Animation'));
    const presets = (st.presets || [{ id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' }, { id: 'scale', label: 'Scale' }, { id: 'slide-up', label: 'Slide up' }]).filter((p) => p.id !== 'expand-from-element');
    const ap = sel2(s3, 'Preset', presets, (dec.animation && /lain-([\w-]+)/.exec(dec.animation.value) || [])[1] || 'none');
    const ad = h('div', 'dz-f2'); ad.appendChild(h('label', '', 'Duration')); const adIn = h('input'); adIn.type = 'number'; adIn.value = '300'; adIn.min = '0'; adIn.step = '50'; ad.appendChild(adIn); s3.appendChild(ad);
    const ae = sel2(s3, 'Easing', st.easings || ['ease-out', 'ease', 'ease-in', 'ease-in-out', 'linear'], 'ease-out');
    const aBtn = btn('Apply animation', 'dz-btn', () => edit({ op: 'setAnimation', node: st.sel.node, preset: ap.value, duration: Number(adIn.value) || 300, easing: ae.value }, st.sel.screen)); aBtn.disabled = isReadOnly();
    s3.appendChild(aBtn);
    box.appendChild(s3);
    // BEHAVIOR (wires)
    const s4 = h('div', 'dz-sec'); s4.id = 'dzBehavior'; s4.appendChild(h('div', 'dz-h', 'Behavior'));
    (info.wires || []).forEach((w) => {
      const row = h('div', 'dz-wire'); row.appendChild(h('span', 'o', w.origin));
      row.appendChild(h('span', 't', `${w.trigger} → ${w.action}${w.target ? ` ${w.target}` : ''}${w.transition && w.transition !== 'none' ? ` · ${w.transition}` : ''}`));
      if (w.origin === 'design' && !isReadOnly()) { const x = btn('×', '', () => edit({ op: 'removeWire', id: w.id }, st.sel.screen)); x.title = 'Remove this wire'; row.appendChild(x); } else if (w.origin !== 'design') { const o = btn('', '', () => D.openInIde(w.file, w.line), 'code'); o.title = `${w.file}:${w.line}`; row.appendChild(o); }
      s4.appendChild(row);
    });
    if (!(info.wires || []).length) s4.appendChild(h('div', 'dz-note', 'No wires. Drag the → handle to a screen, or choose here.'));
    const trig = sel2(s4, 'Trigger', ['click', 'longpress', 'swipe-left', 'swipe-right', 'swipe-up', 'swipe-down', 'change'], 'click');
    const act = sel2(s4, 'Action', [{ id: 'navigate', label: 'Go to screen' }, { id: 'toggleDropdown', label: 'Toggle dropdown' }, { id: 'openModal', label: 'Open as modal' }, { id: 'back', label: 'Back' }, { id: 'setState', label: 'Set state' }], 'navigate');
    const tgtSel = sel2(s4, 'Target', (st.screens || []).map((s) => ({ id: s.file, label: s.name })), st.wireTarget || null);
    const allPresets = st.presets || [{ id: 'none', label: 'None' }, { id: 'slide-left', label: 'Slide left' }, { id: 'fade', label: 'Fade' }, { id: 'expand-from-element', label: 'Expand from element' }];
    const tr = sel2(s4, 'Transition', allPresets, 'none');
    const tdRow = h('div', 'dz-f2'); tdRow.appendChild(h('label', '', 'Duration')); const td = h('input'); td.type = 'number'; td.value = '300'; td.step = '50'; tdRow.appendChild(td); s4.appendChild(tdRow);
    const te = sel2(s4, 'Easing', st.easings || ['ease-out', 'ease', 'ease-in', 'ease-in-out', 'linear'], 'ease-out');
    const add = btn('Add wire', 'dz-btn primary', async () => {
      const items = act.value === 'toggleDropdown' ? (st.screens || []).filter((s) => s.file !== st.sel.screen).map((s) => ({ label: s.name, target: s.file })) : undefined;
      const r = await edit({ op: 'addWire', node: st.sel.node, trigger: trig.value, action: act.value, target: act.value === 'navigate' || act.value === 'openModal' ? tgtSel.value : null, transition: tr.value, duration: Number(td.value) || 300, easing: te.value, items }, st.sel.screen);
      if (r && r.applied) { st.wireTarget = null; refreshFlows(); }
    });
    add.disabled = isReadOnly(); s4.appendChild(add);
    box.appendChild(s4);
    right.appendChild(box);
  }
  function hex(v, dflt) {
    const s = String(v || '');
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split('').map((c) => c + c).join('')}`;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return dflt || '#000000';
  }

  // ---- "+" add a component -------------------------------------------------------------------------------------------
  function addDialog() {
    if (isReadOnly()) return;
    const screen = (st.sel && st.sel.screen) || (st.screens[0] && st.screens[0].file);
    if (!screen) return;
    const m = h('div', 'dz-modal'); const box = h('div', 'box'); box.id = 'dzAddBox';
    box.appendChild(h('h4', '', 'Add a component'));
    const row = (label, input) => { const r = h('div', 'dz-f2'); r.appendChild(h('label', '', label)); r.appendChild(input); box.appendChild(r); return input; };
    const name = row('Name', Object.assign(h('input'), { type: 'text', placeholder: 'logout', id: 'dzAddName' }));
    const kind = h('select'); kind.id = 'dzAddKind'; ['button', 'text', 'image', 'container'].forEach((k) => { const o = h('option', '', k); o.value = k; kind.appendChild(o); }); row('Kind', kind);
    const text = row('Text', Object.assign(h('input'), { type: 'text', placeholder: 'Log out', id: 'dzAddText' }));
    const assetRow = h('div', 'dz-f2'); assetRow.appendChild(h('label', '', 'Asset'));
    const asset = Object.assign(h('input'), { type: 'text', placeholder: '.png / .ico / .svg (optional)', id: 'dzAddAsset' });
    const pick = btn('…', 'dz-btn', async () => { const r = D.hostCall ? await D.hostCall('pickFile', { title: 'Choose an image', kind: 'image' }) : null; if (r && r.path) asset.value = r.path; });
    const wrap = h('div'); wrap.style.display = 'flex'; wrap.style.gap = '6px'; asset.style.flex = '1'; wrap.appendChild(asset); wrap.appendChild(pick); assetRow.appendChild(wrap); box.appendChild(assetRow);
    const wire = h('select'); wire.id = 'dzAddWire'; [{ id: '', label: 'No wire' }].concat((st.screens || []).map((s) => ({ id: s.file, label: `Go to ${s.name}` }))).forEach((o) => { const op = h('option', '', o.label); op.value = o.id; wire.appendChild(op); }); row('Wire', wire);
    const parentNote = h('div', 'dz-note', st.sel && st.sel.info ? `Inside ${st.sel.info.tag}${st.sel.info.elementId ? `#${st.sel.info.elementId}` : ''} (the selection).` : 'Inside the screen\'s first section. Select a container first to put it there.');
    box.appendChild(parentNote);
    const actions = h('div', 'row');
    actions.appendChild(btn('Cancel', 'dz-btn', () => m.remove()));
    const ok = btn('Add', 'dz-btn primary', async () => {
      const els = st.layers.get(screen) || await loadLayers(screen);
      const parent = st.sel && st.sel.node ? st.sel.node : (els.find((e) => !e.parent) || {}).id;
      if (!parent) { status('Select where it goes first', 'bad'); return; }
      m.remove();
      const r = await edit({ op: 'insert', parent, name: name.value || kind.value, kind: kind.value, text: text.value || name.value, asset: asset.value || undefined }, screen);
      if (r && r.applied && wire.value && r.followId) {
        const w = await edit({ op: 'addWire', node: r.followId, trigger: 'click', action: 'navigate', target: wire.value, transition: 'slide-left', duration: 300, easing: 'ease-out' }, screen);
        if (w && w.applied) refreshFlows();
      }
    }); ok.id = 'dzAddOk';
    actions.appendChild(ok); box.appendChild(actions);
    m.appendChild(box); document.body.appendChild(m);
    m.onclick = (e) => { if (e.target === m) m.remove(); };
    name.focus();
  }

  // ---- top-bar actions -----------------------------------------------------------------------------------------------
  function openInIde() {
    if (st.sel && st.sel.info) D.openInIde(st.sel.info.file, st.sel.info.line);
    else if (st.screens && st.screens[0]) D.openInIde((st.sel && st.sel.screen) || st.screens[0].file, 1);
  }
  async function runTest() {
    status('Running the test…', 'run');
    const steps = st.recording.length ? st.recording.map((s) => { const c = Object.assign({}, s); delete c.screen; return c; }) : null;
    const screen = st.recording.length ? st.recording[0].screen : (st.sel && st.sel.screen) || (st.screens[0] && st.screens[0].file);
    const r = await api('/api/design/test', { steps, screen, device: st.device && st.device.id });
    if (!r.ok) { status(r.why, 'bad'); return; }
    const last = r.steps[r.steps.length - 1];
    showTest(r.steps, last && last.screenshot);
    status(r.passed ? `Test passed · ${r.steps.length} step(s)` : 'Test found a problem', r.passed ? 'ok' : 'bad');
  }

  // ---- the prompt bar --------------------------------------------------------------------------------------------------
  async function sendPrompt() {
    const ta = $('dzPrompt'); const text = ta.value.trim(); if (!text) return;
    status('Sending to the Agent…', 'run');
    const r = await api('/api/design/prompt', { prompt: text, node: st.sel && st.sel.node, screen: (st.sel && st.sel.screen) || (st.screens[0] && st.screens[0].file), device: st.device && st.device.id });
    if (!r.ok) { status(r.why, 'bad'); return; }
    ta.value = '';
    st.session = r.session;
    status('The Agent is working…', 'run'); showDiff(''); showTest(null);
    clearInterval(st.activityTimer);
    st.activityTimer = setInterval(watchActivity, 1500);
  }
  async function watchActivity() {
    if (!st.session) return;
    const r = await api('/api/design/activity', { session: st.session });
    if (!r.ok) return;
    const edits = (r.calls || []).filter((c) => c.name === 'design_edit' || c.name === 'design_flow' || c.name === 'design_snapshot');
    const tests = (r.calls || []).filter((c) => c.name === 'design_interact');
    if (edits.length) { const last = edits[edits.length - 1].text.split('\n'); status(`${r.running ? 'Working · ' : ''}${last[0]}`, r.running ? 'run' : /^NOT CHANGED|failed/.test(last[0]) ? 'bad' : 'ok'); showDiff(edits.map((e) => e.text.split('\n').slice(1).join('\n')).filter(Boolean).join('\n')); }
    if (tests.length) { const t = tests[tests.length - 1].text.split('\n').filter((l) => /^\d+\./.test(l)); showTest(t.map((l) => ({ action: l.replace(/^\d+\.\s*/, ''), ok: !/FAILED|console errors:/.test(l) }))); }
    if (!r.running) {
      clearInterval(st.activityTimer); st.activityTimer = null;
      if (!edits.length) status(r.reply ? r.reply.split('\n')[0].slice(0, 160) : 'Done', 'ok');
      st.layers.clear(); afterEdit(st.sel && st.sel.screen);
    }
  }

  // ---- the relay: design_interact drives this canvas while it is open ----------------------------------------------------
  function startRelay() {
    clearInterval(st.relayTimer);
    st.relayTimer = setInterval(async () => {
      if (!st.shown || !root.offsetParent || st.relaying) return;
      const r = await api('/api/design/relay/next', {});
      if (!r.ok || !r.job) return;
      st.relaying = true;
      try { await api('/api/design/relay/done', { id: r.job.id, steps: await runJob(r.job) }); } finally { st.relaying = false; }
    }, 1200);
  }
  async function runJob(job) {
    const f = st.frames.get(job.screen) || st.frames.values().next().value;
    if (!f) return [{ step: 1, ok: false, why: 'no screen is open in Design' }];
    focusFrame(f.screen);
    const was = st.live; if (!was) for (const g of st.frames.values()) post(g, { type: 'mode', mode: 'live', drawSel: false });
    status('The Agent is testing on the canvas…', 'run');
    const out = [];
    for (let i = 0; i < job.steps.length; i++) {
      const s = job.steps[i];
      if (s.action === 'wait') { await sleep(Math.min(10000, s.ms || 500)); out.push({ step: i + 1, action: 'wait', ok: true }); continue; }
      const target = typeof s.target === 'string' ? { id: s.target } : s.target && s.target.node ? { id: s.target.node } : s.target;
      const d = await ask(f, { type: 'act', action: Object.assign({}, s, { target }), settleMs: s.settleMs || 400 }, null, 12000);
      if (d && d.navigated) { post(f, { type: 'mode', mode: 'live', drawSel: false }); await sleep(300); }
      const obs = (d && d.observation) || {};
      out.push({ step: i + 1, action: s.action, target: s.target || null, ok: Boolean(d && d.result && d.result.ok), why: d ? (d.result && d.result.why) : 'the frame did not answer', url: obs.url, navigated: Boolean(d && d.navigated), changes: obs.changes || null, errors: obs.errors || [] });
      if (!(d && d.result && d.result.ok)) break;
    }
    if (!was) for (const g of st.frames.values()) post(g, { type: 'mode', mode: 'design', drawSel: false });
    // THE LAST STEP'S PICTURE: LAIN's own window (never the desktop), cropped to this screen's frame.
    if ((job.screenshots || 'last') !== 'none' && out.length) { const shot = await frameShot(f); if (shot) out[out.length - 1].screenshot = shot; }
    showTest(out, out.length && out[out.length - 1].screenshot);
    // A TEST THAT NAVIGATED leaves the frame on another page: it goes back to its own screen.
    if (out.some((x) => x.navigated) && st.open.preview) setTimeout(() => { f.ready = false; f.iframe.src = `${st.open.preview}${f.info.route}`; }, 600);
    status(out.every((x) => x.ok && !(x.errors || []).length) ? 'Canvas test passed' : 'Canvas test found a problem', out.every((x) => x.ok) ? 'ok' : 'bad');
    return out;
  }

  async function frameShot(f) {
    try {
      const c = D.hostCall ? await D.hostCall('capture', {}) : null;
      if (!c || !c.ok || !c.png) return null;
      const img = new Image(); img.src = c.png; await img.decode();
      const r = f.scr.getBoundingClientRect(); const k = img.naturalWidth / window.innerWidth;
      const cv = document.createElement('canvas'); cv.width = Math.round(r.width * k); cv.height = Math.round(r.height * k);
      cv.getContext('2d').drawImage(img, r.left * k, r.top * k, r.width * k, r.height * k, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    } catch (e) { return null; }
  }

  // ---- the surface's entry points --------------------------------------------------------------------------------------
  L.designUI = {
    mount(view, deps) { D = deps; root = view; build(); },
    show() { st.shown = true; if (!st.open) open(); else { refreshFlows(); } },
    hide() { st.shown = false; },
    _state: st,
  };
}());
