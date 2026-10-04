'use strict';

/**
 * THE PROJECT'S OWN VITE, WITH DESIGN'S ID PLUGIN (D9) — run as a child process whose working directory is the
 * project (Tailwind, PostCSS and friends resolve their config from there, exactly as `npm run dev` would). The
 * project's vite.config is loaded as usual and Design's plugin is added at createServer; no file is written.
 *
 *   node vitehost.js <root> <port>
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const root = path.resolve(process.argv[2] || '.');
  const port = Number(process.argv[3]) || 0;
  const pkgFile = require.resolve('vite/package.json', { paths: [root] });
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const pick = (e) => (typeof e === 'string' ? e : e && (pick(e.import) || pick(e.default)));
  const rel = pick(pkg.exports && (pkg.exports['.'] || pkg.exports)) || pkg.module || pkg.main;
  const mod = await import(pathToFileURL(path.join(path.dirname(pkgFile), rel)).href);
  const vite = mod.createServer ? mod : mod.default;
  const server = await vite.createServer({ root, plugins: [require('./plugins').vitePlugin({ root })], css: { devSourcemap: true }, server: { host: '127.0.0.1', port, strictPort: Boolean(port) }, clearScreen: false });
  await server.listen();
  const a = server.httpServer.address();
  process.stdout.write(`LAIN Design · Vite ${pkg.version} · Local: http://127.0.0.1:${a.port}/\n`);
  const stop = () => server.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.stdin.on('end', stop);
})().catch((e) => { process.stderr.write(`${e && e.stack || e}\n`); process.exit(1); });
