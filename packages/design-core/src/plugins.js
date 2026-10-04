'use strict';

/**
 * DESIGN'S VITE PLUGIN (D9) — compile-time ids for every framework Vite serves: JSX/TSX (React, Solid), Vue SFC
 * templates, Svelte markup. Added at createServer only (the project's config is read, never written); `enforce:
 * 'pre'` so it sees each module exactly as on disk — the ids are file:line:col offsets into that text.
 */

const path = require('path');

function vitePlugin({ root }) {
  const abs = path.resolve(root);
  return {
    name: 'lain-design-ids',
    enforce: 'pre',
    apply: 'serve',
    // ORDER 'pre' AT THE HOOK runs this before other pre-plugins' transforms (vite-plugin-svelte/vue compile there).
    transform: { order: 'pre', handler(code, id) {
      const file = id.split('?')[0];
      if (!file.startsWith(abs) || file.includes('node_modules') || id.includes('?') && !/\?(v=|t=)/.test(id)) return null;
      const rel = path.relative(abs, file).replace(/\\/g, '/');
      let out = code;
      if (/\.(jsx|tsx)$/i.test(file)) out = require('./jsx').instrument(code, rel);
      else if (/\.(vue|svelte)$/i.test(file)) out = require('./tmpl').instrument(code, rel);
      return out === code ? null : { code: out, map: null };
    } },
  };
}

module.exports = { vitePlugin };
