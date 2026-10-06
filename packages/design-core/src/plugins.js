'use strict';

/**
 * DESIGN'S VITE PLUGIN (D9) — compile-time ids for every framework Vite serves: JSX/TSX (React, Solid), Vue SFC
 * templates, Svelte markup. Added at createServer only (the project's config is read, never written); `enforce:
 * 'pre'` so it sees each module exactly as on disk — the ids are file:line:col offsets into that text.
 */

const path = require('path');

function vitePlugin({ root }) {
  // ONE SPELLING FOR PATHS: Vite's ids use forward slashes (and real paths); Windows paths use backslashes and any case.
  const norm = (f) => { const s = f.replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };
  let real = path.resolve(root); try { real = require('fs').realpathSync.native(real); } catch { /* keep */ }
  const abs = real;
  const base = norm(abs).replace(/\/?$/, '/');
  return {
    name: 'lain-design-ids',
    enforce: 'pre',
    apply: 'serve',
    // ORDER 'pre' AT THE HOOK runs this before other pre-plugins' transforms (vite-plugin-svelte/vue compile there).
    transform: { order: 'pre', handler(code, id) {
      let file = id.split('?')[0];
      // AN ID IN ANOTHER SPELLING (an 8.3 short name, a link) is the same file: compared by its real path.
      if (!norm(file).startsWith(base)) { try { const r = require('fs').realpathSync.native(file); if (norm(r).startsWith(base)) file = r; } catch { /* not a file on disk */ } }
      if (!norm(file).startsWith(base) || file.includes('node_modules') || id.includes('?') && !/\?(v=|t=)/.test(id)) return null;
      const rel = path.relative(abs, file).replace(/\\/g, '/');
      let out = code;
      if (/\.(jsx|tsx)$/i.test(file)) out = require('./jsx').instrument(code, rel);
      else if (/\.(vue|svelte)$/i.test(file)) out = require('./tmpl').instrument(code, rel);
      return out === code ? null : { code: out, map: null };
    } },
  };
}

module.exports = { vitePlugin };
