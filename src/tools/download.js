'use strict';

/**
 * DOWNLOADING IS ITS OWN PERMISSION (§41).
 *
 *   NETWORK_READ        web_fetch — read a page as text; no file is written
 *   DOWNLOAD_FILE       this tool — bytes from the network to a file, asked per
 *                       file or allowed per site for the session
 *   WRITE_PROJECT_FILE  the ordinary trust gate on the destination (gate.js)
 *   EXECUTE_FILE        running something that was downloaded — asked
 *                       separately, every time, by `executeGuard`
 *
 * Allowing a download NEVER implies allowing its execution. The card shows
 * the source, the file name, the size (when the server states it) and where
 * it will land.
 */

const fs = require('fs');
const path = require('path');

const CLASS = Object.freeze({ NETWORK_READ: 'NETWORK_READ', DOWNLOAD_FILE: 'DOWNLOAD_FILE', WRITE_PROJECT_FILE: 'WRITE_PROJECT_FILE', EXECUTE_FILE: 'EXECUTE_FILE' });
const MAX_BYTES = 512 * 1024 * 1024;
const OPTIONS = ['Allow once', 'Allow this site for the session', 'Deny'];

function grants(session) {
  if (!session._downloads) Object.defineProperty(session, '_downloads', { value: { sites: new Set(), files: new Map(), exec: new Set() }, enumerable: false, writable: true });
  return session._downloads;
}

function human(n) {
  if (!Number.isFinite(n) || n < 0) return 'size not stated';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function nameFrom(url, disposition) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(disposition || ''));
  const raw = m ? decodeURIComponent(m[1]) : path.basename(new URL(url).pathname || '') || 'download';
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'download';
}

async function head(url, signal) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal });
    return { ok: r.ok, size: Number(r.headers.get('content-length')), disposition: r.headers.get('content-disposition'), type: r.headers.get('content-type') };
  } catch { return { ok: false }; }
}

async function run(input, ctx) {
  const app = ctx && ctx.app;
  const session = ctx && (ctx.session || (app && app.session));
  let url;
  try { url = new URL(String((input && input.url) || '')); } catch { return { output: 'download_file needs an http(s) url', isError: true }; }
  if (!/^https?:$/.test(url.protocol)) return { output: 'only http and https downloads are supported', isError: true };
  const h = await head(url.href, ctx && ctx.signal);
  const name = nameFrom(url.href, h.disposition);
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const dest = path.resolve(cwd, String((input && input.dest) || path.join('downloads', name)));
  const g = session ? grants(session) : { sites: new Set(), files: new Map(), exec: new Set() };
  if (!g.sites.has(url.host)) {
    if (!app) return { output: `PERMISSION_REQUIRED (${CLASS.DOWNLOAD_FILE}): nobody can approve this download here; nothing was downloaded.`, isError: true };
    const answer = await require('../decisions').ask(app, {
      type: 'DOWNLOAD_REQUEST',
      title: 'DOWNLOAD · allow this file?',
      question: [`source       ${url.href}`, `filename     ${name}`, `size         ${human(h.size)}`, `destination  ${path.relative(cwd, dest) || dest}`,
        '', 'Allowing the download does not allow running it.'].join('\n'),
      options: OPTIONS,
      meta: { url: url.href, name, size: h.size, dest },
    }, ctx && ctx.signal);
    if (answer === OPTIONS[1]) g.sites.add(url.host);
    else if (answer !== OPTIONS[0]) return { output: `DENIED (${CLASS.DOWNLOAD_FILE}): the download was not allowed; nothing was written.`, isError: true, denied: true };
  }
  if (Number.isFinite(h.size) && h.size > MAX_BYTES) return { output: `refused: ${human(h.size)} is over the ${human(MAX_BYTES)} download cap`, isError: true };
  let res;
  try { res = await fetch(url.href, { redirect: 'follow', signal: ctx && ctx.signal }); } catch (e) { return { output: `download failed: ${e.message}`, isError: true }; }
  if (!res.ok || !res.body) return { output: `download failed: HTTP ${res.status}`, isError: true };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let bytes = 0;
  try {
    const out = fs.createWriteStream(tmp);
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { out.destroy(); throw new Error(`over the ${human(MAX_BYTES)} cap`); }
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return { output: `download failed: ${e.message}`, isError: true };
  }
  g.files.set(path.resolve(dest).toLowerCase(), { url: url.href, at: Date.now() });
  return {
    output: `DOWNLOADED ${path.relative(cwd, dest) || dest} · ${human(bytes)} · from ${url.host}\nNot executable by this permission: running it needs its own approval.`,
    mutated: [dest],
    meta: { download: { url: url.href, dest, bytes } },
  };
}

/**
 * EXECUTE_FILE: a command that names a file this session downloaded asks first,
 * every time unless allowed for that file. Returns null (nothing to ask) or a
 * verdict.
 */
async function executeGuard(ctx, name, input) {
  if (!/^(?:run_bash|run_powershell|run_cmd|process_run|python_run|run_background|service_start|observe_start)$/.test(name)) return null;
  const session = ctx && (ctx.session || (ctx.app && ctx.app.session));
  const g = session && session._downloads;
  if (!g || !g.files.size) return null;
  const text = JSON.stringify(input || {}).toLowerCase().replace(/\\\\/g, '\\').replace(/\//g, '\\');
  const hit = [...g.files.keys()].find((abs) => text.includes(abs.replace(/\//g, '\\')) || text.includes(path.basename(abs).toLowerCase()));
  if (!hit || g.exec.has(hit)) return null;
  const app = ctx.app;
  if (!app) return { ok: false, output: `DENIED (${CLASS.EXECUTE_FILE}): ${path.basename(hit)} was downloaded and running it needs approval nobody can give here.` };
  const answer = await require('../decisions').ask(app, {
    type: 'PERMISSION_REQUEST', title: 'EXECUTE a downloaded file?',
    question: `${path.basename(hit)}\nfrom ${g.files.get(hit).url}\n\nThe download was allowed; running it is a separate decision.`,
    options: ['Allow running it', 'Deny'],
  }, ctx && ctx.signal);
  if (answer === 'Allow running it') { g.exec.add(hit); return { ok: true }; }
  return { ok: false, output: `DENIED (${CLASS.EXECUTE_FILE}): running the downloaded ${path.basename(hit)} was not allowed.` };
}

const tools = {
  download_file: {
    mutates: true,
    schema: {
      name: 'download_file',
      description: 'Download a file from an http(s) URL into the project (default downloads/<name>). The person sees the source, filename, size and destination and allows it once or for the site. '
        + 'A download is NEVER permission to run it — executing a downloaded file is asked separately. To read a web page as text use web_fetch.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, dest: { type: 'string', description: 'where to save it, relative to the project' } },
        required: ['url'],
      },
    },
    run,
  },
};

module.exports = { tools, CLASS, executeGuard, nameFrom, human, OPTIONS };
