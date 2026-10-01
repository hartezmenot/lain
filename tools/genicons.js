'use strict';

/**
 * BUILD-TIME: vendor the icons LAIN draws from Lucide (lucide-static, ISC) into page/ui/icons.js.
 *
 *   node tools/genicons.js <path-to-lucide-static-package>
 *
 * The page is one self-contained document (no CDN, no runtime package), so the chosen icons' element lists are
 * copied in, keyed by LAIN's own names. Lucide dropped brand marks; GitHub's mark stays LAIN-drawn.
 * Re-run after changing MAP; the output is committed like any other source file.
 */

const fs = require('fs');
const path = require('path');

// LAIN NAME → LUCIDE NAME. One icon per meaning; a surface asks for the meaning, never the glyph.
const MAP = {
  home: 'house', ide: 'code-xml', chat: 'message-square', bot: 'bot', model: 'layers', usage: 'chart-column', session: 'history',
  settings: 'settings', search: 'search', files: 'file', folder: 'folder', folderopen: 'folder-open', plus: 'plus', changes: 'git-compare',
  terminal: 'square-terminal', terminal2: 'terminal', preview: 'app-window', refresh: 'refresh-cw', close: 'x', chevron: 'chevron-right',
  down: 'chevron-down', gear: 'settings-2', arrow: 'arrow-right', back: 'arrow-left', up: 'arrow-up', plug: 'plug', mcp: 'puzzle',
  server: 'server', link: 'link', shield: 'shield', spark: 'sparkles', check: 'check', panel: 'panel-bottom', sidebar: 'panel-left',
  splitr: 'columns-2', splitd: 'rows-2', attach: 'paperclip', send: 'send-horizontal', stop: 'square', play: 'play', pause: 'pause',
  enter: 'corner-down-left', ext: 'blocks', ask: 'message-circle-question', code: 'code', branch: 'git-branch', pr: 'git-pull-request',
  bolt: 'zap', leaf: 'leaf', hourglass: 'hourglass', layers: 'layers', sliders: 'sliders-horizontal', feedback: 'message-square-warning',
  pencil: 'pencil', dots: 'ellipsis', pin: 'pin', eye: 'eye', eyeoff: 'eye-off', openext: 'external-link', palette: 'palette',
  keyboard: 'keyboard', book: 'book-open', grid: 'layout-grid', user: 'user', bell: 'bell', warn: 'triangle-alert', cloud: 'cloud',
  download: 'download', cpu: 'cpu', moon: 'moon', sun: 'sun', gauge: 'gauge', activity: 'activity', done: 'circle-check',
  circle: 'circle', dot: 'circle-dot', clock: 'clock', calendar: 'calendar', database: 'database', trend: 'trending-up', percent: 'percent',
  pie: 'chart-pie', monitor: 'monitor', tablet: 'tablet', phone: 'smartphone', pointer: 'mouse-pointer-2', scan: 'scan', move: 'move',
  resize: 'scaling', trash: 'trash-2', lock: 'lock', key: 'key-round', logout: 'log-out', chats: 'messages-square', checklist: 'list-checks',
  brain: 'brain', timer: 'timer', maximize: 'maximize-2', minimize: 'minimize-2', at: 'at-sign', wand: 'wand-sparkles', help: 'circle-help',
  undo: 'undo-2', bulb: 'lightbulb', box: 'box', package: 'package', globe: 'globe', rotate: 'rotate-ccw',
  power: 'power', update: 'circle-arrow-down',
};

// LAIN-DRAWN (brand marks Lucide does not ship): [tag, attrs] like Lucide's own nodes.
const OWN = {
  github: [['path', { d: 'M9 19.5c-4 1.3-4-2-5.5-2.5M14.5 21.5v-3.2a2.8 2.8 0 0 0-.8-2.2c2.7-.3 5.6-1.3 5.6-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.1 3.4 5.1 3.7 5.1 3.7a4.4 4.4 0 0 0-.1 3.2A4.7 4.7 0 0 0 3.7 10c0 4.7 2.9 5.7 5.6 6a2.8 2.8 0 0 0-.8 2.2v3.3' }]],
};

function main() {
  const pkg = process.argv[2];
  if (!pkg) { process.stderr.write('usage: node tools/genicons.js <lucide-static package dir>\n'); process.exit(2); }
  const meta = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  const nodes = JSON.parse(fs.readFileSync(path.join(pkg, 'icon-nodes.json'), 'utf8'));
  const out = {};
  // AN ALIAS (history, …) is not in icon-nodes.json; its SVG file carries the same elements.
  const fromSvg = (lucide) => {
    const f = path.join(pkg, 'icons', `${lucide}.svg`);
    if (!fs.existsSync(f)) return null;
    const src = fs.readFileSync(f, 'utf8');
    const els = [];
    const re = /<(path|circle|rect|line|polyline|polygon|ellipse)\s([^>]*?)\/>/g;
    let m;
    while ((m = re.exec(src))) {
      const a = {};
      m[2].replace(/([a-z-]+)="([^"]*)"/g, (x, k, v) => { a[k] = v; return x; });
      els.push([m[1], a]);
    }
    return els.length ? els : null;
  };
  for (const [name, lucide] of Object.entries(MAP)) {
    const n = nodes[lucide] || fromSvg(lucide);
    if (!n) throw new Error(`lucide has no "${lucide}" (for ${name})`);
    out[name] = n.map(([tag, attrs]) => { const a = { ...attrs }; delete a.key; return [tag, a]; });
  }
  Object.assign(out, OWN);
  const file = path.join(__dirname, '..', 'page', 'ui', 'icons.js');
  const src = `'use strict';

/**
 * LAIN'S ICONS — Lucide (lucide-static ${meta.version}, ISC — https://lucide.dev), vendored by tools/genicons.js,
 * plus the brand marks Lucide does not ship (LAIN-drawn). Each icon is its element list, drawn inline and stroked
 * in currentColor: no icon font, no CDN (the page is one self-contained document).
 *
 * ISC License — Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or
 * distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright
 * notice and this permission notice appear in all copies.
 */

const ICONS = ${JSON.stringify(out)};

function attrs(a) { return Object.keys(a).map((k) => \`\${k}="\${String(a[k]).replace(/"/g, '&quot;')}"\`).join(' '); }

/** An icon as markup (server-side HTML). */
function svg(name, size = 16) {
  const n = ICONS[name] || ICONS.spark;
  return \`<svg class="ic" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${n.map(([t, a]) => \`<\${t} \${attrs(a)}/>\`).join('')}</svg>\`;
}

/** The runtime icon function (LAIN.icon): an SVG element, sized with the icon scale (--ic). */
function js() {
  return \`window.LAIN = window.LAIN || {};
window.LAIN.icon = (function () {
  var P = \${JSON.stringify(ICONS)};
  var NS = 'http://www.w3.org/2000/svg';
  return function (name, size) {
    size = size || 16;
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.style.width = 'calc(' + size + 'px * var(--ic, 1))'; s.style.height = 'calc(' + size + 'px * var(--ic, 1))';
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.75');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (P[name] || P.spark).forEach(function (n) {
      var e = document.createElementNS(NS, n[0]);
      Object.keys(n[1]).forEach(function (k) { e.setAttribute(k, n[1][k]); });
      s.appendChild(e);
    });
    return s;
  };
})();\`;
}

module.exports = { svg, js, ICONS };
`;
  fs.writeFileSync(file, src);
  process.stdout.write(`wrote ${Object.keys(out).length} icons (lucide-static ${meta.version}) to ${path.relative(process.cwd(), file)}\n`);
}

main();
