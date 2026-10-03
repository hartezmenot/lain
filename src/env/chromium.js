'use strict';

/** THE ONE CHROMIUM AUTHORITY — which binary, whose profile, which port, who cleans it up. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cdp = require('../harness/cdp');
const purpose = require('./purpose');
const failures = require('./failures');
const install = require('./chromiuminstall');
const { SCRATCH_PREFIXES, SCRATCH_RE } = require('../harness/processcleanup');

/** The scratch-profile prefix, taken from the module that VALIDATES it. */
const VERIFY_PREFIX = SCRATCH_PREFIXES[SCRATCH_PREFIXES.length - 1];
if (!SCRATCH_RE.test(`${VERIFY_PREFIX}aA0`)) {
  // A prefix the cleaner would refuse must never reach `mkdtemp`. Failing at
  // load is loud; failing at cleanup time is a detached process nobody reads.
  throw new Error(`the verification profile prefix ${VERIFY_PREFIX} is not one processcleanup.js will remove`);
}

const { PURPOSE } = purpose;
const { CODE } = failures;

/** How long a freshly launched browser gets to announce its debug port. */
const LAUNCH_TIMEOUT_MS = 15000;
/** How often the port file is polled while it boots. */
const POLL_MS = 60;
/** How long a stopped browser gets to actually exit before its profile is removed. */
const STOP_TIMEOUT_MS = 8000;

/** WHERE A BORROWED BROWSER MIGHT BE. */
function systemCandidates() {
  return require('../harness/browser').findBrowser();
}

/** WHICH BROWSER, AND IS IT OURS? */
function resolve({ policy = 'prefer-managed', explicit = null } = {}) {
  const tried = [];
  const want = explicit || process.env.LAIN_CHROMIUM || null;
  if (want) {
    tried.push(want);
    try {
      if (fs.statSync(want).isFile()) {
        return { ok: true, path: want, owned: true, managed: false, source: 'configured', version: install.versionAt(want), tried };
      }
    } catch { /* falls through to a MISCONFIGURED answer below */ }
    return {
      ok: false, tried, source: 'configured',
      ...failures.fail(CODE.CHROMIUM_FAILED, `the configured browser is missing: ${want}`),
    };
  }

  const managed = install.installed();
  if (managed.ok) {
    tried.push(managed.path);
    return { ok: true, path: managed.path, owned: true, managed: true, source: 'managed', version: managed.version, tried };
  }
  tried.push(...(managed.tried || []));

  if (policy === 'managed') {
    return {
      ok: false, tried, source: 'managed',
      ...failures.fail(
        CODE.CHROMIUM_FAILED,
        'no Harness-owned Chromium is installed, and policy forbids borrowing the system browser',
        `looked in ${(managed.tried || []).join(', ')}`,
        { remedy: install.INSTALL_HINT },
      ),
    };
  }

  const sys = systemCandidates();
  tried.push(...(sys.tried || []));
  if (sys.ok) {
    // BORROWED. The binary is the person's; the profile never is.
    return { ok: true, path: sys.path, owned: false, managed: false, source: 'system', version: install.versionAt(sys.path), tried };
  }
  return {
    ok: false, tried, source: 'none',
    ...failures.fail(
      CODE.CHROMIUM_FAILED,
      `no browser was found (looked in ${tried.length} places)`,
      tried.join('\n'),
      { remedy: install.INSTALL_HINT },
    ),
  };
}

/** THE LAUNCH FLAGS FOR ONE PURPOSE. */
function argsFor(kind, profileDir, { headless }) {
  const t = purpose.traits(kind);
  const args = [
    // PORT ZERO, ALWAYS. A fixed port is how two Harness browsers collide, and 9222 in particular is how one adopts somebody else's. The browser picks a…
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
  ];
  // AN EXTENSION IS UNCONTROLLED INPUT TO A VERDICT — except for the web-model
  // browser, where a person's password manager is genuinely part of logging in.
  if (!t.extensions) args.push('--disable-extensions');
  if (kind === PURPOSE.VERIFY) args.push('--mute-audio');
  if (headless) args.push('--headless=new', '--disable-gpu');
  return args;
}

/** THE APPLICATION-WINDOW FLAGS. */
function appWindowArgs(url, profileDir, { width = 1440, height = 900 } = {}) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
  ];
}

/** ONE RUNNING BROWSER THIS RUNTIME STARTED. */
class Instance {
  constructor(fields) { Object.assign(this, fields); this.startedAt = Date.now(); }
  get alive() {
    if (this.child) return this.child.exitCode == null && !this.child.killed;
    if (this.proc) return Boolean(this.proc.alive);
    return false;
  }
}

class ChromiumRuntime {
  /** a test or a headless projection, which is why every task-owned launch checks for it and says so rather than starting something nothing will clean up. */
  constructor({ processes = null, events = null, policy = null } = {}) {
    this.processes = processes;
    this.events = events;
    this._policy = policy;
    this._instances = new Map();
  }

  /** Configuration, read late so a `/env` change takes effect without a restart. */
  policy() {
    if (this._policy) return this._policy;
    try { return require('../config').load().chromiumPolicy || 'prefer-managed'; } catch { return 'prefer-managed'; }
  }

  /** WHICH PROFILE DIRECTORY, and the existing owners keep owning them. */
  profileFor(kind, { projectPath = null, sourceId = null } = {}) {
    switch (kind) {
      case PURPOSE.WORKSHOP:
        return require('../workshop/profile').ensure(projectPath || process.cwd());
      case PURPOSE.WEBMODEL:
        return require('../modelsource/webprofile').ensure(sourceId || 'default');
      case PURPOSE.VERIFY:
        // DISPOSABLE, AND A NEW ONE EVERY TIME.
        return fs.mkdtempSync(path.join(os.tmpdir(), VERIFY_PREFIX));
      default:
        throw new Error(`unknown browser purpose: ${kind}`);
    }
  }

  /** START A BROWSER FOR ONE PURPOSE. */
  async launch(kind, {
    environment = 'host', projectPath = null, sourceId = null, taskId = null,
    headless = null, signal = null,
  } = {}) {
    if (!purpose.isPurpose(kind)) return failures.fail(CODE.CHROMIUM_FAILED, `unknown browser purpose: ${kind}`);
    const t = purpose.traits(kind);

    const env = String(environment || 'host');
    if (env !== 'host') {
      // INSIDE A GUEST. Same purposes, same flags, a different machine.
      return require('./guest').launchChromium(env, kind, { taskId, headless: headless == null ? t.headless : headless });
    }

    const client = cdp.clientAvailable();
    if (!client.ok) return failures.fail(CODE.CHROMIUM_FAILED, client.why);

    const found = resolve({ policy: this.policy() });
    if (!found.ok) return found;

    let profileDir;
    try { profileDir = this.profileFor(kind, { projectPath, sourceId }); } catch (e) {
      return failures.fail(CODE.CHROMIUM_FAILED, `no profile for ${kind}: ${(e && e.message) || e}`);
    }
    // THE BOUNDARY IS CHECKED AT LAUNCH, not only at construction.
    const guard = this._checkIsolation(kind, profileDir);
    if (!guard.ok) return await this._abandon(null, profileDir, t, failures.fail(CODE.CHROMIUM_FAILED, guard.why));

    const head = headless == null ? t.headless : Boolean(headless);
    const args = argsFor(kind, profileDir, { headless: head });

    // A REUSED PROFILE STILL HOLDS THE PREVIOUS RUN'S PORT FILE.
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    try { fs.rmSync(portFile, { force: true }); } catch { /* first run */ }

    const started = t.lifetime === 'task'
      ? this._startManaged(found.path, args, { taskId, profileDir, disposable: t.disposable })
      : this._startDetached(found.path, args);
    if (!started.ok) return await this._abandon(null, profileDir, t, started);

    const port = await this._awaitPort(portFile, started, signal);
    if (!port.ok) return await this._abandon(started, profileDir, t, port);

    const live = await cdp.endpoint(port.port);
    if (!live.ok) return await this._abandon(started, profileDir, t, failures.fail(CODE.CHROMIUM_FAILED, live.why));

    const inst = new Instance({
      id: `${kind}:${taskId || projectPath || sourceId || 'default'}`,
      kind, environment: 'host', port: port.port, base: live.base,
      profileDir, browserPath: found.path,
      // THE AUTHORITATIVE VERSION, from the browser itself rather than from a
      // directory name. This is what goes into the evidence.
      version: live.browser || found.version || '',
      owned: found.owned, managed: found.managed, source: found.source,
      headless: head, taskId,
      child: started.child || null, proc: started.proc || null,
      owner: t.lifetime === 'task' ? 'task' : 'session',
    });
    if (started.proc) { started.proc.port = port.port; started.proc.healthSpec = { port: port.port }; }
    this._instances.set(inst.id, inst);
    return { ok: true, instance: inst };
  }

  /** Task-owned: the ProcessManager cleans the profile up with the task. */
  _startManaged(command, args, { taskId, profileDir, disposable }) {
    if (!this.processes) {
      return failures.fail(CODE.CHROMIUM_FAILED, 'no process manager, so a browser cannot be owned or cleaned up');
    }
    try {
      const proc = this.processes.start({
        taskId, name: 'browser', command, args,
        // ONLY A DISPOSABLE PROFILE IS DELETED.
        cleanupPaths: disposable ? [profileDir] : [],
      });
      return { ok: true, proc };
    } catch (e) {
      return failures.fail(CODE.CHROMIUM_FAILED, `the browser would not start: ${(e && e.message) || e}`);
    }
  }

  /** Session-owned: it must outlive tasks, so it is this module's to close. */
  _startDetached(command, args) {
    let child;
    try {
      child = require('child_process').spawn(command, args, { detached: false, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      return failures.fail(CODE.CHROMIUM_FAILED, `the browser would not start: ${(e && e.message) || e}`);
    }
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.on('error', () => { exited = exited == null ? -1 : exited; });
    return { ok: true, child, exitedAt: () => exited };
  }

  /** Wait for the browser to announce its port, or say precisely why it did not. */
  async _awaitPort(portFile, started, signal) {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    const dead = () => (started.child ? started.exitedAt() != null : !(started.proc && started.proc.alive));
    while (Date.now() < deadline && !dead() && !(signal && signal.aborted)) {
      try {
        const n = Number(String(fs.readFileSync(portFile, 'utf8')).split(/\r?\n/)[0]);
        if (n > 0) return { ok: true, port: n };
      } catch { /* still booting */ }
      // eslint-disable-next-line no-await-in-loop -- waiting on a file another
      // process writes is a poll by nature; the deadline bounds it.
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (signal && signal.aborted) return failures.fail(CODE.CHROMIUM_FAILED, 'browser startup cancelled');
    if (dead()) {
      return failures.fail(
        CODE.CHROMIUM_FAILED,
        'the browser exited immediately — another browser may be using this profile',
        started.proc ? String(started.proc.healthWhy || '') : `exit code ${started.exitedAt()}`,
      );
    }
    return failures.fail(CODE.CHROMIUM_FAILED, `the browser did not announce a debug port within ${LAUNCH_TIMEOUT_MS}ms`);
  }

  /** A LAUNCH THAT FAILED MUST NOT LEAVE ITS PROFILE BEHIND. */
  async _abandon(started, profileDir, traits, result) {
    // THE KILL IS AWAITED, AND THAT IS THE WHOLE FIX FOR THE CANCELLATION CASE.
    if (started) await this._kill(started);
    if (traits && traits.disposable && profileDir) {
      try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the owner task cleanup is the backstop */ }
    }
    return result;
  }

  async _kill(started) {
    try { if (started.child) started.child.kill(); } catch { /* already gone */ }
    try { if (started.proc && this.processes) await this.processes.stop(started.proc.processId); } catch { /* already gone */ }
  }

  /** The purpose boundary, checked against the OTHER two roots. */
  _checkIsolation(kind, dir) {
    const roots = {
      [PURPOSE.WORKSHOP]: () => require('../workshop/profile').root(),
      [PURPOSE.WEBMODEL]: () => require('../modelsource/webprofile').root(),
    };
    for (const [other, rootOf] of Object.entries(roots)) {
      if (other === kind) continue;
      let root;
      try { root = rootOf(); } catch { continue; }
      const sep = purpose.separate(dir, root, kind, other);
      if (!sep.ok) return sep;
    }
    return { ok: true, why: '' };
  }

  /** What a status surface may know about one instance. Never contents. */
  status(instance) {
    const i = instance && typeof instance === 'string' ? this._instances.get(instance) : instance;
    if (!i) return { known: false, state: 'IDLE' };
    return {
      known: true,
      state: i.alive ? 'RUNNING' : 'STOPPED',
      purpose: i.kind,
      environment: i.environment,
      version: i.version,
      owned: i.owned,
      source: i.source,
      headless: i.headless,
      port: i.port,
      owner: i.owner,
      uptimeMs: Date.now() - i.startedAt,
    };
  }

  /** Every instance this runtime started, for `/env`. */
  list() { return [...this._instances.values()].map((i) => this.status(i)); }

  /** STOP ONE, AND ACTUALLY WAIT FOR IT. */
  async stop(instance) {
    const i = instance && typeof instance === 'string' ? this._instances.get(instance) : instance;
    if (!i) return { ok: true, stopped: false };

    // ASK IT TO CLOSE ITSELF FIRST
    if (i.port) {
      try {
        const live = await cdp.endpoint(i.port);
        if (live.ok && live.webSocketDebuggerUrl) {
          const conn = new cdp.Connection(live.webSocketDebuggerUrl);
          const open = await conn.connect();
          if (open.ok) {
            try { await conn.send('Browser.close', {}, 3000); } catch { /* the kill below is the fallback */ }
            try { conn.close(); } catch { /* already gone */ }
          }
        }
      } catch { /* an unreachable browser is one the kill below handles */ }
      const graceful = Date.now() + 3000;
      while (i.alive && Date.now() < graceful) {
        // eslint-disable-next-line no-await-in-loop -- waiting on a process exit.
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // A DETACHED CHILD NEEDS THE TREE KILLED, and processes.js already owns how to do that per platform (`taskkill /T /F`, or a process-group SIGKILL).
    try {
      if (i.child && i.alive) await require('../harness/processes').stopTree(i.child);
    } catch { /* already gone, or refused to die — reported below */ }
    try { if (i.proc && this.processes) await this.processes.stop(i.proc.processId); } catch { /* already gone */ }

    // THE HANDLES GO WHEN THE PROCESS DOES, not when `kill` returns.
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (i.alive && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- waiting on a process exit.
      await new Promise((r) => setTimeout(r, 50));
    }

    let cleaned = true;
    let why = '';
    if (purpose.traits(i.kind).disposable && i.profileDir) {
      try {
        fs.rmSync(i.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (e) {
        cleaned = false;
        why = `the disposable profile could not be removed: ${i.profileDir} (${(e && e.message) || e})`;
      }
    }
    this._instances.delete(i.id);
    return { ok: true, stopped: true, cleaned, why };
  }

  /** Stop everything. Called from the session shutdown path. */
  async stopAll() {
    const all = [...this._instances.values()];
    for (const i of all) await this.stop(i);
    return { ok: true, stopped: all.length };
  }

  /** CAN A BROWSER RUN AT ALL, AND WHICH ONE WOULD IT BE? */
  health() {
    const client = cdp.clientAvailable();
    const found = resolve({ policy: this.policy() });
    return {
      available: Boolean(client.ok && found.ok),
      client: client.ok,
      why: !client.ok ? client.why : (found.ok ? '' : found.why),
      policy: this.policy(),
      browser: found.ok
        ? { path: found.path, version: found.version, owned: found.owned, managed: found.managed, source: found.source }
        : null,
      remedy: found.ok ? '' : (found.remedy || ''),
      running: this.list(),
    };
  }
}

/** ONE RUNTIME PER APP, the same shape every other Harness singleton uses. */
const bound = new WeakMap();
function forApp(app) {
  if (!app) return new ChromiumRuntime();
  if (bound.has(app)) return bound.get(app);
  const harness = (() => { try { return require('../harnesslink').existing(app); } catch { return null; } })();
  const rt = new ChromiumRuntime({
    processes: harness ? harness.processes : null,
    events: app.events || null,
  });
  bound.set(app, rt);
  return rt;
}

/** THE SIGN-IN WINDOW'S FLAGS — an ORDINARY browser window on a website source's own LAIN profile, for a person to sign in by hand… */
function signInWindowArgs(url, profileDir) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ];
}

module.exports = { ChromiumRuntime, forApp, resolve, argsFor, appWindowArgs, signInWindowArgs, PURPOSE, LAUNCH_TIMEOUT_MS, STOP_TIMEOUT_MS };
