'use strict';

/**
 * THE MINIMAL BROWSER SURFACE IN THE CLI (§18–20) — not Chrome in a pane.
 *
 * What a person needs to see about a page while doing frontend work: title,
 * URL, which browser answered, viewport, a semantic outline, console and
 * network errors. Plain lines, bounded, drawn in the transient panel.
 */

function clip(s, w) { const t = String(s == null ? '' : s); return t.length > w ? `${t.slice(0, Math.max(1, w - 1))}…` : t; }

function lines(v, width = 96) {
  if (!v) return ['no page'];
  if (!v.ok) return [`${v.backend || 'browser'} · unavailable — ${clip(v.why || 'it did not answer', width - 24)}`];
  const out = [
    clip(v.title || '(untitled)', width),
    clip(v.url || '', width),
    `${v.backend}${v.viewport ? ` · ${v.viewport.width || '?'}×${v.viewport.height || '?'}` : ''}`,
  ];
  const dom = String(v.dom || '').split('\n').filter((l) => l.trim()).slice(0, 12);
  if (dom.length) { out.push('', 'DOM'); for (const l of dom) out.push(`  ${clip(l, width - 2)}`); }
  if (v.console && v.console.length) { out.push('', `CONSOLE · ${v.console.length}`); for (const c of v.console.slice(0, 5)) out.push(`  ${clip(c, width - 2)}`); }
  if (v.network && v.network.length) { out.push('', `NETWORK · ${v.network.length} failed`); for (const n of v.network.slice(0, 5)) out.push(`  ${clip(n, width - 2)}`); }
  return out;
}

module.exports = { lines };
