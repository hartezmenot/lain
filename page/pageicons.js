'use strict';

/**
 * LAIN'S ICONS — one small line set, drawn inline.
 *
 * There is no icon font and no CDN (the page is one self-contained document,
 * which the Core test pins). Each icon is a 24-unit SVG path list stroked in
 * currentColor, so it takes the colour of whatever it sits in and never needs
 * a second palette. Deliberately few: an icon earns its place by being the
 * fastest way to recognise one of LAIN's surfaces, not by decorating a row.
 */

const PATHS = {
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5',
  ide: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14',
  chat: 'M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 16.5h-8.5L6 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6.5A1.5 1.5 0 0 1 5 5Z',
  bot: 'M12 3v3M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3ZM9.5 13h.01M14.5 13h.01M9.5 16.5h5',
  model: 'M12 3.5 20 8l-8 4.5L4 8l8-4.5ZM4 12l8 4.5 8-4.5M4 16l8 4.5 8-4.5',
  usage: 'M4 20.5h16M6.5 17v-5M11 17V7M15.5 17v-8M20 17V4',
  session: 'M12 7v5l3.5 2M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 4v4h-4',
  settings: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.7 1l-.3 2H10.7l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 1.8-3.1 1.9.7a7 7 0 0 1 1.7-1l.3-2h3.6l.3 2a7 7 0 0 1 1.7 1l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 3Z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20',
  files: 'M6 3.5h7l4.5 4.5v12.5H6ZM13 3.5V8h4.5',
  folder: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z',
  plus: 'M12 5v14M5 12h14',
  changes: 'M7 4.5v10M7 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17 9.5c0 4-10 2.5-10 5',
  terminal: 'M4 5.5h16v13H4ZM7.5 9.5l2.5 2.5-2.5 2.5M12 15h4.5',
  preview: 'M3.5 6h17v12h-17ZM3.5 9.5h17M6 7.75h.01M8 7.75h.01',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  gear: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.7 1l-.3 2H10.7l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 1.8-3.1 1.9.7a7 7 0 0 1 1.7-1l.3-2h3.6l.3 2a7 7 0 0 1 1.7 1l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 3Z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  plug: 'M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0ZM12 16.5v4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  shield: 'M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6Z',
  spark: 'M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  panel: 'M3.5 5h17v14h-17ZM3.5 14.5h17',
  sidebar: 'M3.5 5h17v14h-17ZM9 5v14',
  attach: 'M16.5 7.5 9.3 14.7a2 2 0 0 0 2.8 2.8l7.2-7.2a4 4 0 0 0-5.7-5.7L6.4 11.8a6 6 0 0 0 8.5 8.5l5.1-5.1',
  send: 'M4.5 12 19.5 4.5 15 19.5l-3-6.5Z',
  stop: 'M7 7h10v10H7Z',
  play: 'M8 5.5v13l10.5-6.5Z',
  enter: 'M19.5 5v7a3 3 0 0 1-3 3H6M10 11l-4 4 4 4',
  ext: 'M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM16.5 13v7M13 16.5h7',
  ask: 'M9.2 9.2a2.9 2.9 0 1 1 3.9 2.7c-.7.3-1.1.9-1.1 1.6v.5M12 17.2h.01M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z',
};

/** An icon as markup. Only ever called with a key from PATHS. */
function svg(name, size = 16) {
  const d = PATHS[name] || PATHS.spark;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** The paths, for the renderer to build icons at runtime (LAIN.icon). */
function js() {
  return `window.LAIN = window.LAIN || {};
window.LAIN.icon = (function () {
  var P = ${JSON.stringify(PATHS)};
  return function (name, size) {
    size = size || 16;
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', P[name] || P.spark);
    s.appendChild(p);
    return s;
  };
})();`;
}

module.exports = { svg, js, PATHS };
