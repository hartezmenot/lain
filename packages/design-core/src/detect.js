'use strict';

/**
 * THE DESIGN DETECTOR (D9) — what a frontend IS, read from what it declares: package.json (scripts, dependencies), the
 * lockfile, and config files. Nothing is executed and nothing is written.
 *
 *   { framework, bundler, styling: [...], router, plugin, launch: { cmd, cwd, env, script, port, inProcessVite },
 *     ports: [candidates to attach to], url: null, confidence, why }
 *
 * `plugin` names the compile-time id plugin Design can add at launch (react | vue | svelte | solid) — the `exact` tier.
 */

const fs = require('fs');
const path = require('path');

const read = (root, f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
const json = (root, f) => { try { return JSON.parse(read(root, f)); } catch { return null; } };
const has = (root, f) => fs.existsSync(path.join(root, f));
const first = (root, names) => names.find((n) => has(root, n)) || null;

const SCRIPTS = ['dev', 'start:dev', 'serve', 'start', 'preview'];
const DEFAULT_PORTS = { vite: 5173, next: 3000, nuxt: 3000, astro: 4321, angular: 4200, webpack: 8080, cra: 3000, 'vue-cli': 8080, parcel: 1234 };
/** NOTHING LEAVES THE MACHINE from a dev server Design starts. */
const QUIET_ENV = { BROWSER: 'none', NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', GATSBY_TELEMETRY_DISABLED: '1', NG_CLI_ANALYTICS: 'false', STORYBOOK_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };

function packageManager(root, pkg) {
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(root, 'yarn.lock')) return 'yarn';
  if (has(root, 'bun.lockb') || has(root, 'bun.lock')) return 'bun';
  return 'npm';
}

function stylingOf(root, deps) {
  const s = new Set();
  if (deps.tailwindcss || first(root, ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'])) s.add('tailwind');
  if (deps.sass || deps['sass-embedded'] || deps['node-sass']) s.add('scss');
  if (deps['styled-components'] || deps['@emotion/react'] || deps['@emotion/styled'] || deps['@stitches/react'] || deps['@vanilla-extract/css']) s.add('css-in-js');
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = []; try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (/^(node_modules|\.git|dist|build|\.next|\.svelte-kit|\.nuxt|out)$/.test(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel, depth + 1);
      else if (/\.module\.(css|scss|sass)$/.test(e.name)) s.add('css-modules');
      else if (/\.s[ac]ss$/.test(e.name)) s.add('scss');
      else if (/\.css$/.test(e.name)) s.add('plain');
    }
  };
  walk('', 0);
  return [...s];
}

function routerOf(root, framework, deps) {
  if (framework === 'next') return has(root, 'app') || has(root, 'src/app') ? 'next-app' : 'next-pages';
  if (framework === 'sveltekit') return 'sveltekit';
  if (framework === 'nuxt') return 'nuxt';
  if (framework === 'astro') return 'astro';
  if (framework === 'angular') return 'angular';
  if (deps['react-router-dom'] || deps['react-router'] || deps['@tanstack/react-router']) return 'react-router';
  if (deps['vue-router']) return 'vue-router';
  if (deps['svelte-spa-router']) return 'svelte-spa-router';
  return framework === 'html' ? 'files' : null;
}

/** A port the project names: script flags, PORT=, vite config server.port, angular.json serve port. */
function declaredPort(root, scriptLine, bundler) {
  const m = /--port[= ](\d{2,5})/.exec(scriptLine) || /(?:^|\s)-p\s+(\d{2,5})\b/.exec(scriptLine) || /\bPORT=(\d{2,5})\b/.exec(scriptLine);
  if (m) return Number(m[1]);
  if (bundler === 'vite') {
    for (const n of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']) {
      const t = read(root, n); const s = t && /server\s*:\s*\{([\s\S]{0,600}?)\}/.exec(t); const p = s && /\bport\s*:\s*(\d{2,5})\b/.exec(s[1]);
      if (p) return Number(p[1]);
    }
  }
  if (bundler === 'angular') { const a = json(root, 'angular.json'); const p = a && JSON.stringify(a).match(/"port"\s*:\s*(\d{2,5})/); if (p) return Number(p[1]); }
  return null;
}

/** WHAT THIS FRONTEND IS. */
function detect(root) {
  const abs = path.resolve(root);
  const pkg = json(abs, 'package.json');
  const out = { root: abs, framework: 'unknown', bundler: null, styling: [], router: null, plugin: null, launch: null, ports: [], url: null, confidence: 0, why: '' };
  if (!pkg) {
    const index = first(abs, ['index.html', 'public/index.html']);
    if (index) Object.assign(out, { framework: 'html', bundler: 'static', router: 'files', styling: stylingOf(abs, {}), launch: { static: path.dirname(index) || '.', cwd: abs, env: {} }, confidence: 0.9, why: `a static site (${index})` });
    else out.why = 'no package.json and no index.html — not a web frontend Design can open';
    return out;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const script = SCRIPTS.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
  const line = script ? String(scripts[script]) : '';
  // FRAMEWORK (most specific first) and BUNDLER.
  if (deps.next) Object.assign(out, { framework: 'next', bundler: 'next' });
  else if (deps.nuxt || deps.nuxt3) Object.assign(out, { framework: 'nuxt', bundler: 'vite' });
  else if (deps['@sveltejs/kit']) Object.assign(out, { framework: 'sveltekit', bundler: 'vite', plugin: 'svelte' });
  else if (deps.astro) Object.assign(out, { framework: 'astro', bundler: 'vite' });
  else if (deps['@angular/core']) Object.assign(out, { framework: 'angular', bundler: 'angular' });
  else if (deps['solid-js']) Object.assign(out, { framework: 'solid', bundler: deps.vite ? 'vite' : 'webpack', plugin: deps.vite ? 'solid' : null });
  else if (deps.svelte) Object.assign(out, { framework: 'svelte', bundler: deps.vite ? 'vite' : 'rollup', plugin: deps.vite ? 'svelte' : null });
  else if (deps.vue) Object.assign(out, { framework: 'vue', bundler: deps.vite ? 'vite' : (deps['@vue/cli-service'] ? 'vue-cli' : 'webpack'), plugin: deps.vite ? 'vue' : null });
  else if (deps.react) Object.assign(out, { framework: 'react', bundler: deps.vite ? 'vite' : deps['react-scripts'] ? 'cra' : deps.parcel ? 'parcel' : deps.webpack ? 'webpack' : null, plugin: deps.vite ? 'react' : null });
  else if (script) Object.assign(out, { framework: 'html', bundler: 'node' });
  out.styling = stylingOf(abs, deps);
  out.router = routerOf(abs, out.framework, deps);
  if (!script) {
    const index = first(abs, ['index.html', 'public/index.html']);
    if (index) Object.assign(out, { launch: { static: path.dirname(index) || '.', cwd: abs, env: {} }, confidence: 0.6, why: `package.json has no dev script; serving ${index} as files` });
    else out.why = `package.json declares no dev script (looked for ${SCRIPTS.join(', ')})`;
    return out;
  }
  const pm = packageManager(abs, pkg);
  const port = declaredPort(abs, line, out.bundler);
  const cmd = pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
  // VITE PROJECTS WITH A COMPILE-TIME ID PLUGIN are served by the project's own Vite, started in-process with the plugin
  // added at createServer (the config file is not touched). Everything else runs its own dev script.
  const inProcessVite = out.bundler === 'vite' && /\bvite\b/.test(line) && Boolean(out.plugin) && !/--host\b|--mode\b/.test(line);
  out.launch = { cmd, script, scriptLine: line, cwd: abs, env: { ...QUIET_ENV }, port, inProcessVite };
  const def = DEFAULT_PORTS[out.bundler] || DEFAULT_PORTS[out.framework] || null;
  out.ports = [...new Set([port, def, out.bundler === 'vite' ? 5174 : null].filter(Boolean))];
  out.confidence = out.framework === 'unknown' ? 0.3 : out.framework === 'html' ? 0.7 : 0.95;
  out.why = `${out.framework}${out.bundler ? ` · ${out.bundler}` : ''}${out.styling.length ? ` · ${out.styling.join(', ')}` : ''}${out.router ? ` · ${out.router}` : ''} — ${cmd}`;
  return out;
}

module.exports = { detect, packageManager, declaredPort, QUIET_ENV, DEFAULT_PORTS, SCRIPTS };
