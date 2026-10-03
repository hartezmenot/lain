'use strict';

/**
 * GUG — a MINIMAL Geometric UI Graph, just enough to answer one question:
 * does a geometry specialist model (Violetto) beat plain arithmetic at the
 * numeric consequences of a UI change? (bench only; not wired into LAIN.)
 *
 * A node is a rect in screen coordinates (y grows DOWN). Relations are the
 * invariants a change must preserve:
 *   square            width == height
 *   centerY: parent   node.centerY == parent.centerY
 *   centerX: parent   node.centerX == parent.centerX
 *   rightInset: n     parent.right - node.right == n
 *   leftInset: n      node.left - parent.left == n
 * `apply(graph, id, {scale})` resizes one node and re-solves its relations.
 */

function rect(n) { return { x: n.x, y: n.y, w: n.w, h: n.h }; }

function apply(graph, id, { scale = 1 } = {}) {
  const n = { ...graph[id] };
  const p = n.parent ? graph[n.parent] : null;
  const rel = n.rel || {};
  n.w = +(n.w * scale).toFixed(4);
  n.h = rel.square ? n.w : +(n.h * scale).toFixed(4);
  if (p && rel.centerY) n.y = +(p.y + p.h / 2 - n.h / 2).toFixed(4);
  if (p && rel.centerX) n.x = +(p.x + p.w / 2 - n.w / 2).toFixed(4);
  if (p && rel.rightInset != null) n.x = +(p.x + p.w - rel.rightInset - n.w).toFixed(4);
  if (p && rel.leftInset != null) n.x = +(p.x + rel.leftInset).toFixed(4);
  return rect(n);
}

/** The evaluation set: each case is a graph, a change, and its words. */
const CASES = [
  {
    name: 'submit 10% smaller, square, centred, same right inset',
    graph: { composer: { x: 400, y: 900, w: 800, h: 64 }, submit: { parent: 'composer', x: 1146, y: 910, w: 44, h: 44, rel: { square: true, centerY: true, rightInset: 10 } } },
    id: 'submit', change: { scale: 0.9 },
    words: 'A square submit button is 44 px wide and vertically centred inside a 64 px tall composer bar whose top edge is at y=900 (screen y grows downward) and whose right edge is at x=1200. The button\'s right edge is inset 10 px from the composer\'s right edge. The button is made 10% smaller while staying square, vertically centred, and keeping the same right inset.',
  },
  {
    name: 'icon 25% larger, centred both ways',
    graph: { card: { x: 100, y: 200, w: 320, h: 180 }, icon: { parent: 'card', x: 244, y: 274, w: 32, h: 32, rel: { square: true, centerY: true, centerX: true } } },
    id: 'icon', change: { scale: 1.25 },
    words: 'A square 32 px icon is centred horizontally and vertically inside a card whose top-left corner is (100, 200) and whose size is 320 × 180 px (screen y grows downward). The icon is made 25% larger, still square and still centred both ways.',
  },
  {
    name: 'input 15% narrower, same left inset, centred',
    graph: { bar: { x: 0, y: 40, w: 1280, h: 56 }, input: { parent: 'bar', x: 24, y: 50, w: 600, h: 36, rel: { centerY: true, leftInset: 24 } } },
    id: 'input', change: { scale: 0.85 },
    words: 'A text input 600 × 36 px sits in a toolbar whose top-left is (0, 40) and size 1280 × 56 px (screen y grows downward). The input keeps a 24 px left inset and is vertically centred. Both its width and height are reduced by 15%, keeping the left inset and the vertical centring.',
  },
  {
    name: 'avatar 20% smaller, right inset 16, centred',
    graph: { header: { x: 0, y: 0, w: 1440, h: 72 }, avatar: { parent: 'header', x: 1384, y: 16, w: 40, h: 40, rel: { square: true, centerY: true, rightInset: 16 } } },
    id: 'avatar', change: { scale: 0.8 },
    words: 'A square 40 px avatar is vertically centred in a header whose top-left is (0, 0) and size 1440 × 72 px (screen y grows downward), with a 16 px right inset from the header\'s right edge. It is made 20% smaller, still square, still centred vertically, same right inset.',
  },
  {
    name: 'dialog button 12% wider, centred horizontally',
    graph: { dialog: { x: 520, y: 300, w: 400, h: 260 }, ok: { parent: 'dialog', x: 660, y: 500, w: 120, h: 40, rel: { centerX: true } } },
    id: 'ok', change: { scale: 1.12 },
    words: 'An OK button 120 × 40 px is centred horizontally in a dialog whose top-left is (520, 300) and size 400 × 260 px; its top edge stays at y=500 (screen y grows downward). Both its width and height grow by 12%, it stays horizontally centred, and its top edge does not move.',
  },
  {
    name: 'badge 50% larger, square, right inset 16, centred',
    graph: { row: { x: 30, y: 610, w: 500, h: 48 }, badge: { parent: 'row', x: 498, y: 626, w: 16, h: 16, rel: { square: true, centerY: true, rightInset: 16 } } },
    id: 'badge', change: { scale: 1.5 },
    words: 'A square 16 px badge sits in a list row whose top-left is (30, 610) and size 500 × 48 px (screen y grows downward). It is vertically centred with a 16 px right inset. It is made 50% larger, still square, still vertically centred, same right inset.',
  },
];

module.exports = { apply, CASES };
