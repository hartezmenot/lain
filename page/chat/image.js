'use strict';

/**
 * THE NATIVE IMAGE VIEWER.
 *
 * A screenshot is evidence, and looking at evidence used to mean opening a
 * browser tab on a generated file:// page (see src/imageview.js for what that
 * was and why it is gone). This is the replacement: the picture, in the window
 * the person is already in.
 *
 * WHAT IT HAS TO DO, and each one is why it is not just an <img> tag:
 *
 *   FIT          a 3840×2160 screenshot in a 900px panel is unreadable at 1:1,
 *                and unfindable if it overflows. Fit is the resting state.
 *   ZOOM         the reason somebody opens a screenshot is usually to read
 *                something small in it.
 *   PAN          zoomed in, the thing you want is rarely in the middle.
 *   1:1          "what does it actually look like" needs the real pixels, so
 *                the natural size is one click and the true dimensions are on
 *                screen rather than implied.
 *   PROVENANCE   which task this belongs to, and where it came from. A picture
 *                with no source is an illustration, not evidence.
 *   EXTERNAL     offered, never taken. Some people want their own viewer.
 *
 * The bytes arrive ONCE, by reference, as base64 from /api/image/read — they
 * are not in the poll payload, or a screenshot would be re-sent every poll to a
 * window that already has it.
 */

const HTML = `
      <div class="imgview" id="imgView" hidden>
        <div class="iv-bar">
          <b id="ivName"></b>
          <span class="iv-facts" id="ivFacts"></span>
          <span class="spacer"></span>
          <button class="btn" id="ivOut" title="Zoom out">&#8722;</button>
          <button class="btn" id="ivZoom" title="Fit / actual size">Fit</button>
          <button class="btn" id="ivIn" title="Zoom in">+</button>
          <button class="btn" id="ivExternal" title="Open in this machine's own image viewer">Open externally</button>
          <button class="btn" id="ivClose" title="Close (Esc)">&#215;</button>
        </div>
        <div class="iv-stage" id="ivStage"><img id="ivImg" alt=""></div>
        <div class="iv-foot" id="ivFoot"></div>
      </div>`;

const CSS = `
/* ---- the image viewer --------------------------------------------------
   A NEUTRAL MID-GREY GROUND, not the application's near-black and not white: a
   screenshot judged against either extreme reads darker or lighter than it is,
   which is the exact error somebody opens an image to avoid. */
.imgview{position:absolute;inset:0;z-index:50;background:var(--canvas);display:grid;
         grid-template-rows:auto 1fr auto}
.iv-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--separator)}
.iv-bar b{font-weight:600}
.iv-facts{color:var(--text-secondary);font-family:var(--mono);font-size:12px}
.iv-stage{overflow:auto;background:#6b6b6b;display:grid;place-items:center;cursor:grab}
.iv-stage.panning{cursor:grabbing}
.iv-stage img{display:block;image-rendering:pixelated;transform-origin:top left}
.iv-foot{padding:7px 14px;border-top:1px solid var(--separator);color:var(--text-muted);
         font-size:11.5px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

const SCRIPT = `
(function () {
  var api = null, notice = null;
  var state = { ref: null, scale: 1, fit: true, natural: { w: 0, h: 0 } };

  function $(id) { return document.getElementById(id); }

  function apply() {
    var img = $('ivImg');
    if (!state.natural.w) return;
    if (state.fit) {
      var stage = $('ivStage').getBoundingClientRect();
      var sx = (stage.width - 24) / state.natural.w;
      var sy = (stage.height - 24) / state.natural.h;
      // NEVER ENLARGE TO FIT. A 16×16 icon blown up to fill a panel is a lie
      // about what it looks like.
      state.scale = Math.min(1, Math.max(0.02, Math.min(sx, sy)));
    }
    img.style.width = Math.round(state.natural.w * state.scale) + 'px';
    img.style.height = Math.round(state.natural.h * state.scale) + 'px';
    $('ivZoom').textContent = state.fit ? 'Fit' : Math.round(state.scale * 100) + '%';
    $('ivFacts').textContent = state.natural.w + '\\u00d7' + state.natural.h
      + (state.scale === 1 ? '  \\u00b7  1:1' : '  \\u00b7  ' + Math.round(state.scale * 100) + '%');
  }

  function zoom(by) {
    state.fit = false;
    state.scale = Math.min(8, Math.max(0.05, state.scale * by));
    apply();
  }

  async function load(v) {
    if (!v) { $('imgView').hidden = true; state.ref = null; return; }
    $('imgView').hidden = false;
    if (state.ref === v.ref) return;         // already showing it
    state.ref = v.ref;
    state.fit = true;
    $('ivName').textContent = v.name;
    // PROVENANCE, SAID PLAINLY. A picture with no source is an illustration.
    var where = [];
    if (v.adopted) where.push('artifact of task ' + v.taskId);
    else where.push('not adopted — no task was running');
    if (v.provenance) where.push(v.provenance);
    where.push(v.path);
    $('ivFoot').textContent = where.join('  \\u00b7  ');
    var r = await api('/api/image/read', { ref: v.ref });
    if (!r.ok) { $('ivFoot').textContent = r.why; return; }
    var img = $('ivImg');
    img.onload = function () {
      state.natural = { w: img.naturalWidth, h: img.naturalHeight };
      apply();
    };
    img.src = 'data:' + r.image.mime + ';base64,' + r.image.data;
  }

  function boot(deps) {
    api = deps.api; notice = deps.notice;
    $('ivClose').onclick = function () { api('/api/image/close', {}); $('imgView').hidden = true; state.ref = null; };
    $('ivIn').onclick = function () { zoom(1.25); };
    $('ivOut').onclick = function () { zoom(0.8); };
    $('ivZoom').onclick = function () {
      // ONE BUTTON, TWO ANSWERS: whichever you are not looking at now.
      if (state.fit) { state.fit = false; state.scale = 1; } else { state.fit = true; }
      apply();
    };
    $('ivExternal').onclick = async function () {
      var r = await api('/api/image/external', { ref: state.ref });
      if (!r.ok) notice(r.why, true);
    };
    // THE WHEEL ZOOMS, because that is what a wheel does over a picture.
    $('ivStage').addEventListener('wheel', function (e) {
      if (!state.natural.w) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    // PAN BY DRAGGING, which only means anything once it is bigger than the box.
    var drag = null;
    var stage = $('ivStage');
    stage.addEventListener('mousedown', function (e) {
      drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
      stage.classList.add('panning');
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      stage.scrollLeft = drag.l - (e.clientX - drag.x);
      stage.scrollTop = drag.t - (e.clientY - drag.y);
    });
    window.addEventListener('mouseup', function () { drag = null; stage.classList.remove('panning'); });
    window.addEventListener('resize', function () { if (state.fit) apply(); });
    // ESC CLOSES, because every overlay in every application does.
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('imgView').hidden) { $('ivClose').click(); }
    });
  }

  window.LAIN = window.LAIN || {};
  window.LAIN.imageview = { boot: boot, render: load };
})();`;

module.exports = { HTML, CSS, SCRIPT };
