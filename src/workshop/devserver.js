'use strict';

/**
 * THE PROJECT'S DEV SERVER — detected from what the project DECLARES, started
 * through the process authority that already exists, IN THE PROJECT ROOT.
 *
 * ------------------------------------------------------------------------
 * IT NEVER INVENTS A COMMAND.
 *
 * Every command below is copied out of the project's own manifest, run by the
 * package manager the project's own lockfile names. No script, no dev server,
 * and the Workshop says so — see harness/profile.js, which applies the same
 * rule to verification contracts.
 *
 * ------------------------------------------------------------------------
 * IT STARTS NOTHING ITSELF. `ProcessManager.start` owns spawning, ownership,
 * logs and cleanup. The one thing passed that matters most is `cwd`: the
 * PROJECT ROOT, never LAIN's install folder, Core's working directory or the
 * desktop executable's — pinned by tests/unit/devserver.test.js.
 *
 * ------------------------------------------------------------------------
 * A PORT ANSWERING IS NOT THIS PROJECT. THIS COST A REAL BUG.
 *
 * Probing conventional ports once attached the Workshop to an unrelated
 * application on :4000 and verified somebody else's page. So a URL is accepted
 * only on IDENTITY, from one of three sources:
 *
 *   1. THE PROJECT DECLARED THE PORT — `vite --port 4321` in its script, or
 *      `server.port` in its own vite config. The project said so.
 *   2. LAIN STARTED IT and forced the port with PORT=… (a server that honours
 *      PORT, as most Node servers and Next do).
 *   3. LAIN STARTED IT and the process ANNOUNCED its URL on its own output
 *      ("Local: http://localhost:5183/"). Measured 2026-09-16 on toradb: Vite
 *      ignores PORT, falls through 5180→5183 when ports are taken, and says
 *      where it landed. Waiting only on the forced port waited forever.
 *
 * ------------------------------------------------------------------------
 * `localhost` IS NOT `127.0.0.1`. Measured on the same run: Vite on Node 24
 * binds `::1` only, so every IPv4 probe of a healthy server was refused and
 * the Workshop reported "did not open" over a page that was serving. Every
 * readiness and adoption probe asks both loopbacks.
 *
 * A START THAT FAILS STOPS WHAT IT STARTED. The same measurement found three
 * dev servers from earlier attempts still listening hours later, each started by
 * a Workshop open that timed out and walked away from its process.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { portOpen } = require('../harness/processes');

/** SCRIPT NAMES THAT MEAN "SERVE THIS FOR DEVELOPMENT", most specific first. */
const SCRIPTS = ['dev', 'start:dev', 'serve', 'preview', 'start'];

/** Where LAIN puts a server it starts itself, when the project names no port. */
const PREFERRED_BASE = 5300;

/** Lockfile → package manager, in the order a project is likeliest to carry them. */
const MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function packageManager(root, pkg) {
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  for (const [file, pm] of MANAGERS) {
    if (fs.existsSync(path.join(root, file))) return pm;
  }
  return 'npm';
}

function runCommand(pm, script) {
  if (pm === 'yarn') return `yarn run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  if (pm === 'pnpm') return `pnpm run ${script}`;
  return `npm run ${script}`;
}

/** `server: { port: 5180 }` in the project's own vite config, when it says so. */
function viteConfigPort(root) {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    const server = /server\s*:\s*\{([\s\S]{0,600}?)\}/.exec(text);
    const m = server && /\bport\s*:\s*(\d{2,5})\b/.exec(server[1]);
    if (m) return { port: Number(m[1]), from: name };
  }
  return null;
}

/** Expand `npm:dev:web` style references one level, for port detection only. */
function scriptText(scripts, name) {
  const line = String(scripts[name] || '');
  const refs = [...line.matchAll(/npm:([\w:.-]+)/g)].map((m) => String(scripts[m[1]] || ''));
  return [line, ...refs].join(' ');
}

/**
 * THE PROJECT ROOT, CANONICAL. An 8.3 short path (`C:\Users\HARTEZ~1\…`, which
 * os.tmpdir() returns on many machines) is a working directory Vite's file
 * watcher cannot use: measured 2026-09-16, it aborts with a libuv assertion in
 * `win/fs-event.c` the moment it starts watching. The long form is the same
 * directory, so it is what a dev server is started in.
 */
function canonical(dir) {
  const abs = path.resolve(dir || process.cwd());
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

/**
 * WHAT THIS PROJECT DECLARES, or a stated reason there is nothing to run.
 *
 * `declaredPort` is the only port this module will ever ADOPT without having
 * started the process itself, because it is the only one the project vouched for.
 */
function detect(cwd) {
  const root = canonical(cwd);
  // A COMMAND THE PERSON CONFIGURED for this project's preview (Preview › Configure) outranks detection.
  const confFile = require('../projectmeta').file(root, 'preview.json');
  const confRel = `${path.basename(path.dirname(confFile))}/preview.json`;
  const conf = readJson(confFile);
  if (conf && typeof conf.command === 'string' && conf.command.trim()) {
    const port = Number(conf.port) || null;
    return { ok: true, root, script: 'configured', scriptLine: conf.command.trim(), packageManager: null, command: conf.command.trim(), why: `${conf.command.trim()} (configured for this project)`, declaredPort: port, declaredBy: port ? confRel : null, configured: true };
  }
  // A FRONTEND THAT IS FILES BESIDE ITS OWN SERVER (Gate 4, CineFlex): "static": "public" serves that folder
  // with LAIN's static server, so the project's server — its backend — stays dormant. "mount" adds paths the
  // server used to map from elsewhere in the project ("/vendor/x.js": "node_modules/x/dist/x.js"). Both stay
  // inside the project; a path that climbs out is not served.
  if (conf && typeof conf.static === 'string' && conf.static.trim()) {
    const within = (rel) => { const full = path.resolve(root, String(rel)); return (full + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase()) ? full : null; };
    const serveRoot = within(conf.static.trim());
    if (!serveRoot || !fs.existsSync(path.join(serveRoot, 'index.html'))) return { ok: false, root, why: `${confRel} names "static": "${conf.static}", which is not a folder with an index.html inside this project`, declaredPort: null };
    const mount = {};
    const given = conf.mount && typeof conf.mount === 'object' ? Object.entries(conf.mount).slice(0, 40) : [];
    for (const [u, rel] of given) { const full = /^\/[^?#\s]*$/.test(u) && typeof rel === 'string' ? within(rel) : null; if (full) mount[u] = full; }
    return { ok: true, root, script: 'static', scriptLine: 'LAIN static server', packageManager: null, static: true, configured: true,
      command: `"${process.execPath}" "${require.resolve('./staticserve')}" "${serveRoot}"`, env: Object.keys(mount).length ? { LAIN_STATIC_MOUNT: JSON.stringify(mount) } : null,
      why: `the frontend in ${path.relative(root, serveRoot) || '.'}, served by LAIN — the project's server stays dormant`, declaredPort: null, declaredBy: null };
  }
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) {
    // PLAIN FILES (Phase 8.2): an index.html is a site — LAIN serves the folder itself (staticserve.js).
    const index = ['index.html', 'public/index.html'].find((f) => fs.existsSync(path.join(root, f)));
    if (index) {
      const serveRoot = path.dirname(path.join(root, index));
      return { ok: true, root, script: 'static', scriptLine: 'LAIN static server', packageManager: null, static: true,
        command: `"${process.execPath}" "${require.resolve('./staticserve')}" "${serveRoot}"`, why: `a static site (${index}), served by LAIN`, declaredPort: null, declaredBy: null };
    }
    return { ok: false, root, why: 'no preview target detected — no package.json dev script and no index.html. Configure Preview… to name a command.', declaredPort: null };
  }
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
  const name = SCRIPTS.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
  const pm = packageManager(root, pkg);
  if (!name) {
    return {
      ok: false, root, packageManager: pm,
      why: `package.json declares no dev script (looked for ${SCRIPTS.join(', ')})`,
      declaredPort: null,
    };
  }
  const line = scriptText(scripts, name);
  const flag = /--port[= ](\d{2,5})/.exec(line) || /(?:^|\s)-p\s+(\d{2,5})\b/.exec(line) || /\bPORT=(\d{2,5})\b/.exec(line);
  const vite = /\bvite\b/.test(line) ? viteConfigPort(root) : null;
  // A PORT= INSIDE A SUB-SCRIPT THAT IS NOT THE WEB SERVER (toradb's
  // `dev:server` sets PORT=4100 for its API) is not the page's port. When a
  // Vite config names one, the config wins, because it is the page.
  const declaredPort = vite ? vite.port : (flag ? Number(flag[1]) : null);
  return {
    ok: true,
    root,
    script: name,
    scriptLine: String(scripts[name]),
    packageManager: pm,
    // A COMMAND STRING, NOT AN ARGUMENT LIST: harness/processes.js runs a bare
    // string through a shell, and `npm` is `npm.cmd` on Windows.
    command: runCommand(pm, name),
    why: runCommand(pm, name),
    declaredPort,
    declaredBy: vite ? vite.from : (flag ? `the ${name} script` : null),
  };
}

/** A port nothing is listening on. Asked of the OS rather than assumed. */
function freePort(from = PREFERRED_BASE) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(from, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function pickPort() {
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop -- a short ordered probe
    const p = await freePort(PREFERRED_BASE + i);
    // Binding 127.0.0.1 succeeds on Windows beside a 0.0.0.0 listener, so a bind
    // test alone would hand out a port another app serves: ask both loopbacks.
    if (p && !(await portOpen(p, '127.0.0.1')) && !(await portOpen(p, '::1'))) return p;
  }
  return 0;
}

/**
 * IS ANYTHING LISTENING ON THIS PORT ON EITHER LOOPBACK? Returns the URL host
 * that answered — `127.0.0.1`, or `localhost` for an IPv6-only listener.
 */
async function listening(port) {
  if (!port) return null;
  if (await portOpen(port, '127.0.0.1')) return '127.0.0.1';
  if (await portOpen(port, '::1')) return 'localhost';
  return null;
}

// eslint-disable-next-line no-control-regex -- ANSI colour codes are exactly what is being removed
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOOPBACK_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))\/?/i;

/**
 * THE URL A PROCESS LAIN STARTED ANNOUNCED, from its own output. A `Local:` line
 * (Vite, Next, Astro, CRA) outranks any other loopback URL printed — an API
 * server in the same `concurrently` run may print its own.
 */
function announced(log) {
  const lines = String(log || '').replace(ANSI, '').split(/\r?\n/);
  const local = lines.filter((l) => /\bLocal\b\s*:/i.test(l)).map((l) => LOOPBACK_URL.exec(l)).find(Boolean);
  const any = local || lines.map((l) => LOOPBACK_URL.exec(l)).find(Boolean);
  return any ? { port: Number(any[1]), url: any[0].replace('0.0.0.0', 'localhost').replace(/\/?$/, '/') } : null;
}

/**
 * IS THIS PROJECT ALREADY BEING SERVED, on evidence?
 */
async function adoptable(cwd, declaredPort, { processes = null } = {}) {
  if (processes && typeof processes.list === 'function') {
    try {
      for (const p of processes.list() || []) {
        const same = p && p.cwd && path.resolve(p.cwd) === path.resolve(cwd);
        if (same && p.port && p.alive !== false) {
          // eslint-disable-next-line no-await-in-loop -- at most a handful
          const host = await listening(p.port);
          if (host) {
            return { ok: true, port: p.port, url: `http://${host}:${p.port}/`, why: 'the dev server LAIN started for this project is still up', processId: p.processId || null };
          }
        }
      }
    } catch { /* the manager reporting nothing is a normal state */ }
  }
  const host = declaredPort ? await listening(declaredPort) : null;
  if (host) {
    return { ok: true, port: declaredPort, url: `http://${host}:${declaredPort}/`, why: `attached to :${declaredPort}, the port this project declares` };
  }
  return { ok: false };
}

/**
 * GET A URL TO PREVIEW.
 *
 * @param {function} onStart  told the process record the moment one exists, so
 *   a dev-server record can say STARTING with a PID rather than guessing.
 * @returns {{ok, url, port, processId, pid, adopted, command, cwd, why, log}}
 */
async function ensure(cwd, { processes = null, taskId = null, timeoutMs = 60_000, onStart = null } = {}) {
  const root = canonical(cwd);
  const found = detect(root);

  const live = await adoptable(root, found.declaredPort, { processes });
  if (live.ok) {
    return { ok: true, url: live.url, port: live.port, processId: live.processId || null, pid: null, adopted: !live.processId, why: live.why, cwd: root, command: found.command || null };
  }
  if (!found.ok) return { ok: false, why: found.why, cwd: root };
  if (!processes) return { ok: false, why: 'no process manager, so a dev server cannot be owned or cleaned up', cwd: root };

  const port = found.declaredPort || await pickPort();
  const proc = processes.start({
    taskId,
    name: `dev:${found.script}`,
    command: found.command,
    cwd: root,
    env: port || found.env ? { ...(found.env || {}), ...(port ? { PORT: String(port) } : {}) } : null,
    port: port || null,
  });
  if (typeof onStart === 'function') { try { onStart(proc, found, port); } catch { /* a listener never breaks a start */ } }

  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const fail = async (why) => {
    const log = typeof proc.tail === 'function' ? proc.tail(60) : '';
    // WHAT WE STARTED, WE STOP. See the header: a failed open used to leave its
    // server running for hours.
    try { if (proc.alive) await processes.stop(proc.processId); } catch { /* reported by the manager */ }
    return { ok: false, why, processId: proc.processId, pid: proc.commandPid || proc.pid || null, cwd: root, command: found.command, log };
  };
  while (Date.now() < deadline) {
    if (!proc.alive) return fail(`the dev server exited: ${proc.healthWhy || `exit code ${proc.exitCode}`}`);
    // eslint-disable-next-line no-await-in-loop -- polling a port a separate process is opening
    const forced = await listening(port);
    const said = announced(proc.log);
    // eslint-disable-next-line no-await-in-loop -- same poll
    const saidHost = said && said.port !== port ? await listening(said.port) : null;
    if (forced || saidHost) {
      const usePort = forced ? port : said.port;
      const host = forced || saidHost;
      // AN ANSWER IS NOT OWNERSHIP (Phase 8.2): the listener must descend from the process LAIN
      // started — never another application that happens to hold the port (portowner.js).
      // eslint-disable-next-line no-await-in-loop -- once, when the port first answers
      const own = await require('./portowner').verify(proc.pid || proc.commandPid, usePort);
      if (own.ok === false) return fail(own.why);
      proc.port = usePort;
      return {
        ok: true,
        url: `http://${host}:${usePort}/`,
        port: usePort,
        processId: proc.processId,
        pid: proc.commandPid || proc.pid || null,
        adopted: false,
        cwd: root,
        command: found.command,
        why: forced ? `started ${found.why} on :${usePort}` : `started ${found.why}; it announced :${usePort}`,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return fail(`${found.why} did not open ${port ? `:${port}` : 'a port'} or announce a URL within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * CONFIGURE PREVIEW (Phase 8.2): the command (and port) that serves this project,
 * kept with it in `.lain/preview.json` — a file in the project, so it is written
 * through the transaction like any other project edit (mutation.js). An empty
 * command removes it (detection decides again).
 */
async function configure(app, root, { command = '', port = null } = {}) {
  const file = require('../projectmeta').file(root, 'preview.json');
  const cmd = String(command || '').trim().slice(0, 400);
  const p = Number(port) || null;
  return require('../mutation').change(app, {
    name: 'preview.configure', targets: [file], what: cmd ? `set the preview command: ${cmd}` : 'cleared the preview command',
    write: () => {
      try {
        // THE REST OF THE FILE IS KEPT — the backend capabilities (proxy.js) live beside the command.
        const prev = readJson(file) || {};
        const rest = { ...prev }; delete rest.command; delete rest.port;
        if (!cmd) {
          if (!Object.keys(rest).length) { try { fs.unlinkSync(file); } catch { /* there was none */ } }
          else fs.writeFileSync(file, JSON.stringify(rest, null, 2));
          return { ok: true, cleared: true };
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ command: cmd, port: p, ...rest }, null, 2));
        return { ok: true };
      } catch (e) { return { ok: false, why: `could not save the preview command: ${(e && e.message) || e}` }; }
    },
  });
}

module.exports = {
  detect, ensure, adoptable, canonical, freePort, pickPort, listening, announced, packageManager, viteConfigPort, configure,
  SCRIPTS, PREFERRED_BASE,
};
