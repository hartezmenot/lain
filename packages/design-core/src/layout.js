'use strict';

/**
 * DRAG MUST NOT LIE. What a drag writes depends on how the element is laid out, measured in the preview:
 *
 *   absolute / fixed   top/left/right/bottom — keeping the anchor the person used, switching it when the element is
 *                      moved across the middle of its containing block (right → left), so the code still says what
 *                      the screen shows when the window changes size
 *   flex / grid child  a choice: REORDER (dropped in a gap between siblings — the default there), OFFSET (translate),
 *                      or MAKE ABSOLUTE; the default elsewhere is Offset
 *   in normal flow     Offset or Make absolute (Reorder too when there are siblings)
 *
 * `layout` is what the preview runtime measured: { position, display, parentDisplay, flexDirection, rect, margin,
 * containing, siblings: [{id, rect}], translate } — rects in CSS px of the page.
 */

const px = (n) => `${Math.round(n * 100) / 100}px`;
const num = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || '').trim()); return m ? Number(m[1]) : null; };

/** Which anchors are in force: { h: 'left'|'right', v: 'top'|'bottom' } from the declared values. */
function anchors(declared = {}) {
  const has = (p) => declared[p] != null && declared[p] !== 'auto';
  return { h: has('right') && !has('left') ? 'right' : 'left', v: has('bottom') && !has('top') ? 'bottom' : 'top' };
}

/** A drag of an absolutely positioned element by (dx, dy): the properties to write. */
function moveAbsolute(layout, declared, dx, dy) {
  const cb = layout.containing; const r = layout.rect; const m = layout.margin || { top: 0, right: 0, bottom: 0, left: 0 };
  const nx = r.x + dx; const ny = r.y + dy;
  const a = anchors(declared);
  const out = {};
  const cx = nx + r.w / 2; const cy = ny + r.h / 2;
  const mid = { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 };
  // CROSSING THE MIDDLE MOVES THE ANCHOR to the side the element is now nearer to.
  const h = dx === 0 ? a.h : (a.h === 'right' && cx < mid.x ? 'left' : a.h === 'left' && cx > mid.x && declared.right != null ? 'right' : a.h);
  const v = dy === 0 ? a.v : (a.v === 'bottom' && cy < mid.y ? 'top' : a.v === 'top' && cy > mid.y && declared.bottom != null ? 'bottom' : a.v);
  if (dx !== 0 || h !== a.h) {
    if (h === 'left') out.left = px(nx - cb.x - m.left); else out.right = px(cb.x + cb.w - (nx + r.w) - m.right);
    if (h !== a.h) out[a.h] = null;
  }
  if (dy !== 0 || v !== a.v) {
    if (v === 'top') out.top = px(ny - cb.y - m.top); else out.bottom = px(cb.y + cb.h - (ny + r.h) - m.bottom);
    if (v !== a.v) out[a.v] = null;
  }
  return out;
}

/** Is a drop point in a gap between siblings (along the main axis, within the parent's cross range)? Returns the index. */
function gapIndex(layout, point) {
  const sibs = (layout.siblings || []).filter((s) => s.id !== layout.id);
  if (!sibs.length) return null;
  const row = /row/.test(layout.flexDirection || '') && !/column/.test(layout.flexDirection || '');
  const main = (rc) => (row ? rc.x + rc.w / 2 : rc.y + rc.h / 2);
  const p = row ? point.x : point.y;
  const cross = (rc) => (row ? [rc.y, rc.y + rc.h] : [rc.x, rc.x + rc.w]);
  const lo = Math.min(...sibs.map((s) => cross(s.rect)[0])); const hi = Math.max(...sibs.map((s) => cross(s.rect)[1]));
  const q = row ? point.y : point.x;
  if (q < lo || q > hi) return null;
  let i = 0; while (i < sibs.length && main(sibs[i].rect) < p) i += 1;
  return i;
}

/**
 * THE DRAG: { kind: 'absolute', props } for a positioned element; otherwise { kind: 'choice', choices: [...], default }
 * where each choice is { id: 'reorder'|'offset'|'absolute', props?, index? }.
 */
function drag(layout, declared, { dx = 0, dy = 0, drop = null } = {}) {
  if (layout.position === 'absolute' || layout.position === 'fixed') return { kind: 'absolute', props: moveAbsolute(layout, declared, dx, dy) };
  const choices = [];
  const flexy = /flex|grid/.test(layout.parentDisplay || '');
  const point = drop || { x: layout.rect.x + layout.rect.w / 2 + dx, y: layout.rect.y + layout.rect.h / 2 + dy };
  const gi = gapIndex(layout, point);
  // A REORDER only when the drop lands at another place among the siblings; dropped where it already is, it is an offset.
  const own = (layout.siblings || []).findIndex((x) => x.id === layout.id);
  if ((layout.siblings || []).length > 1 && gi != null && gi !== own) choices.push({ id: 'reorder', index: gi, label: 'Reorder' });
  const t = layout.translate || { x: 0, y: 0 };
  choices.push({ id: 'offset', props: { translate: `${px(t.x + dx)} ${px(t.y + dy)}` }, label: 'Offset' });
  const cb = layout.containing || { x: 0, y: 0 }; const m = layout.margin || { top: 0, left: 0 };
  choices.push({ id: 'absolute', props: { position: 'absolute', left: px(layout.rect.x + dx - cb.x - m.left), top: px(layout.rect.y + dy - cb.y - m.top) }, label: 'Make absolute' });
  const def = flexy && choices[0].id === 'reorder' ? 'reorder' : 'offset';
  return { kind: 'choice', choices, default: def, flexChild: flexy };
}

/** A resize by (dw, dh) from a corner: width/height, plus the position change a top/left corner implies. */
function resize(layout, declared, { dw = 0, dh = 0, corner = 'se' } = {}) {
  const out = { width: px(Math.max(1, layout.rect.w + dw)), height: px(Math.max(1, layout.rect.h + dh)) };
  if ((layout.position === 'absolute' || layout.position === 'fixed') && /n|w/.test(corner)) {
    Object.assign(out, moveAbsolute(layout, declared, /w/.test(corner) ? -dw : 0, /n/.test(corner) ? -dh : 0));
  }
  return out;
}

module.exports = { drag, resize, moveAbsolute, anchors, gapIndex, px, num };
