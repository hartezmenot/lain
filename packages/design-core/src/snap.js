'use strict';

/**
 * MAGNETS. A moving rect snaps to the edges and centres of its siblings and its parent, to the parent's padding, and to
 * equal spacing between siblings — within `threshold` CSS px — and says which guides it used so the canvas can draw
 * them. The same function serves the canvas (live) and the tools (exact).
 */

function edgesX(r) { return [r.x, r.x + r.w / 2, r.x + r.w]; }
function edgesY(r) { return [r.y, r.y + r.h / 2, r.y + r.h]; }

/**
 * @param moving    {x,y,w,h} after the raw drag
 * @param context   { parent: {x,y,w,h, padding:{top,right,bottom,left}}, siblings: [{x,y,w,h}] }
 * @returns { dx, dy, guides: [{axis:'x'|'y', at, kind}] } — the correction to add to the raw drag
 */
function snap(moving, { parent = null, siblings = [] } = {}, threshold = 6) {
  const cand = { x: [], y: [] };
  for (const s of siblings) { for (const v of edgesX(s)) cand.x.push({ at: v, kind: 'edge' }); for (const v of edgesY(s)) cand.y.push({ at: v, kind: 'edge' }); }
  if (parent) {
    const p = parent.padding || { top: 0, right: 0, bottom: 0, left: 0 };
    cand.x.push({ at: parent.x, kind: 'parent' }, { at: parent.x + parent.w / 2, kind: 'center' }, { at: parent.x + parent.w, kind: 'parent' });
    cand.y.push({ at: parent.y, kind: 'parent' }, { at: parent.y + parent.h / 2, kind: 'center' }, { at: parent.y + parent.h, kind: 'parent' });
    if (p.left) cand.x.push({ at: parent.x + p.left, kind: 'padding' });
    if (p.right) cand.x.push({ at: parent.x + parent.w - p.right, kind: 'padding' });
    if (p.top) cand.y.push({ at: parent.y + p.top, kind: 'padding' });
    if (p.bottom) cand.y.push({ at: parent.y + parent.h - p.bottom, kind: 'padding' });
  }
  // EQUAL SPACING: the gap two neighbours already keep, offered to the moving rect on either side of them.
  const byX = siblings.slice().sort((a, b) => a.x - b.x);
  for (let i = 1; i < byX.length; i++) {
    const gap = byX[i].x - (byX[i - 1].x + byX[i - 1].w);
    if (gap > 0) { cand.x.push({ at: byX[i].x + byX[i].w + gap, kind: 'spacing', side: 'start' }); cand.x.push({ at: byX[i - 1].x - gap, kind: 'spacing', side: 'end' }); }
  }
  const byY = siblings.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < byY.length; i++) {
    const gap = byY[i].y - (byY[i - 1].y + byY[i - 1].h);
    if (gap > 0) { cand.y.push({ at: byY[i].y + byY[i].h + gap, kind: 'spacing', side: 'start' }); cand.y.push({ at: byY[i - 1].y - gap, kind: 'spacing', side: 'end' }); }
  }
  const best = (mine, list) => {
    let out = null;
    for (const [k, v] of mine.entries()) {
      for (const c of list) {
        if (c.kind === 'spacing' && ((c.side === 'start' && k !== 0) || (c.side === 'end' && k !== 2))) continue;
        const d = c.at - v;
        if (Math.abs(d) <= threshold && (!out || Math.abs(d) < Math.abs(out.d))) out = { d, at: c.at, kind: c.kind };
      }
    }
    return out;
  };
  const bx = best(edgesX(moving), cand.x); const by = best(edgesY(moving), cand.y);
  const guides = [];
  if (bx) guides.push({ axis: 'x', at: bx.at, kind: bx.kind });
  if (by) guides.push({ axis: 'y', at: by.at, kind: by.kind });
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
}

module.exports = { snap };
