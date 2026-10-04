'use strict';

/**
 * ATTACH FIRST, THEN LAUNCH (D9). Design shows the person's real running app:
 *
 *   attach   a dev server already serving THIS project (a declared or default port that answers, with evidence it
 *            is this project: its page names a file that exists here, or carries this project's title)
 *   launch   otherwise: plain files are served by Design's static server; a Vite project with an id plugin is run
 *            by the project's own Vite in-process with the plugin added at createServer; anything else runs the
 *            project's own dev script, with PORT and --port given, telemetry off, the URL read from its output.
 *
 * Nothing in the project is written. A host (Core) may pass its own `spawn` to run the script under its process
 * authority; the default spawns a process group this module owns and stops.
 */

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\/?[^\s]*/;

function get(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: 'text/html', 'accept-encoding': 'identity' } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 400000) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function portOpen(port, host = '127.0.0.1', ms = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
  });
}

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

const titleOf = (html) => { const m = /<title>([^<]*)<\/title>/i.exec(html || ''); return m ? m[1].trim() : null; };

/** Does the page at `url` belong to this project? Evidence, not hope. */
async function belongs(det, url) {
  const r = await get(url);
  if (!r || !r.body) return { ok: false, why: 'no page' };
  const html = r.body;
  const root = det.root;
  // A module script or stylesheet the page loads that exists in this project (Vite serves source paths).
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map((m) => m[1]).filter((p) => !/^\/(@|node_modules|_next|__)/.test(p));
  for (const p of refs) for (const base of ['', 'public', det.launch && det.launch.static ? det.launch.static : '']) if (fs.existsSync(path.join(root, base, p))) return { ok: true, why: `it serves ${p} from this project` };
  if (det.framework === 'next' && /\/_next\//.test(html)) {
    // A Next page whose <title> is this project's metadata.title.
    const t = titleOf(html);
    const layout = ['app/layout.jsx', 'app/layout.tsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx'].map((f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } }).join('\n');
    if (t && layout.includes(t)) return { ok: true, why: `a Next app titled "${t}", as this project's layout says` };
  }
  const t = titleOf(html);
  if (t) for (const f of ['index.html', 'public/index.html', 'src/app.html']) { try { if (titleOf(fs.readFileSync(path.join(root, f), 'utf8')) === t) return { ok: true, why: `its title "${t}" is this project's ${f}` }; } catch { /* none */ } }
  return { ok: false, why: 'it does not look like this project' };
}

/** A dev server already serving this project, or null. */
async function attach(det, { extraPorts = [] } = {}) {
  for (const port of [...new Set([...extraPorts, ...(det.ports || [])])].filter(Boolean)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of ports, in order of likelihood
    if (!(await portOpen(port))) continue;
    for (const host of ['127.0.0.1', 'localhost']) {
      const url = `http://${host}:${port}/`;
      // eslint-disable-next-line no-await-in-loop
      const b = await belongs(det, url);
      if (b.ok) return { url, port, attached: true, why: `attached to :${port} — ${b.why}`, close: async () => {} };
    }
  }
  return null;
}

async function waitHttp(url, deadline) {
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const r = await get(url, 1500);
    if (r && r.status) return r;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((s) => setTimeout(s, 300));
  }
  return null;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* gone */ } }
}

/** Run the project's dev script and wait for its first byte. */
async function runScript(det, { spawnFn = null, timeoutMs = 90000 } = {}) {
  const l = det.launch;
  const port = l.port || await freePort();
  const passPort = /\b(vite|next|astro|nuxt|ng|webpack|react-scripts|svelte-kit)\b/.test(l.scriptLine || '') && !/--port|-p\s/.test(l.scriptLine || '');
  const cmd = `${l.cmd}${passPort ? ` -- --port ${port}` : ''}`;
  const env = { ...process.env, ...(l.env || {}), PORT: String(port) };
  let log = '';
  let child = null; let close;
  const hosted = spawnFn ? await spawnFn({ command: cmd, cwd: l.cwd, env, port }) : null;
  if (hosted) { child = hosted.child || null; close = hosted.close; log = ''; if (hosted.onLog) hosted.onLog((t) => { log = (log + t).slice(-20000); }); } else {
    child = spawn(cmd, { cwd: l.cwd, env, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log = (log + d).slice(-20000); });
    child.stderr.on('data', (d) => { log = (log + d).slice(-20000); });
    close = async () => { killTree(child); };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) return { ok: false, why: `${cmd} exited (${child.exitCode}): ${log.replace(ANSI, '').trim().split('\n').slice(-3).join(' | ')}` };
    const said = URL_RE.exec(log.replace(ANSI, ''));
    const at = said ? Number(said[1]) : port;
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(at)) {
      const url = `http://127.0.0.1:${at}/`;
      // eslint-disable-next-line no-await-in-loop
      const first = await waitHttp(url, Math.min(deadline, Date.now() + 60000));
      if (first) return { ok: true, url, port: at, attached: false, why: `started ${cmd} on :${at}`, close, log: () => log };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((s) => setTimeout(s, 250));
  }
  await close();
  return { ok: false, why: `${cmd} did not answer within ${Math.round(timeoutMs / 1000)}s` };
}

/** The project's own Vite with Design's id plugin, as a child process in the project folder (vitehost.js). */
async function runVite(det, opts = {}) {
  try { require.resolve('vite/package.json', { paths: [det.root] }); } catch { return { ok: false, why: 'the project\'s Vite is not installed (run its package manager install)' }; }
  const port = det.launch.port || await freePort();
  const host = path.join(__dirname, 'vitehost.js');
  const cmd = `"${process.execPath}" "${host}" "${det.root}" ${port}`;
  const r = await runScript({ ...det, launch: { ...det.launch, cmd, scriptLine: 'lain-vitehost', port } }, opts);
  if (r.ok) r.why = `the project's Vite on :${r.port}, with Design's id plugin`;
  return r;
}

/** Design's static server for plain files (no instrumentation here — the proxy does that). */
async function runStatic(det) {
  const dir = path.join(det.root, det.launch.static || '.');
  const s = await require('./server').start(dir, { raw: true });
  return { ok: true, url: `${s.url}/`, port: s.port, attached: false, why: `served the files in ${path.relative(det.root, dir) || '.'}`, close: () => s.close(), staticRoot: dir };
}

/** Attach, or launch: { ok, url, port, attached, why, close() } — or { ok:false, why }. */
async function open(det, opts = {}) {
  if (!det.launch) return { ok: false, why: det.why || 'no way to run this project was found' };
  const found = det.launch.static ? null : await attach(det, opts);
  if (found) return { ok: true, ...found };
  if (det.launch.static) return runStatic(det);
  if (det.launch.inProcessVite) return runVite(det, opts);
  return runScript(det, opts);
}

module.exports = { open, attach, belongs, runScript, runVite, runStatic, freePort, portOpen, get, URL_RE };
