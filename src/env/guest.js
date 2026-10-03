'use strict';

/** THE GUEST BRIDGE — how work happens inside a VM, and how little of LAIN goes in with it. */

const path = require('path');
const environments = require('./environments');
const failures = require('./failures');
const purpose = require('./purpose');
const { CODE } = failures;

/** How long a guest gets to answer before READY is refused. */
const READY_TIMEOUT_MS = 180_000;
/** How often it is asked while it boots. */
const READY_POLL_MS = 3000;

/** Where LAIN puts its own things inside a guest. One root, so cleanup is one path. */
const GUEST_ROOT_WIN = 'C:\\lain-harness';
const GUEST_ROOT_POSIX = '/tmp/lain-harness';

/** Resolve an environment to its provider, or say precisely why not. */
function bind(spec) {
  const p = environments.providerFor(spec);
  if (!p.ok) return p;
  if (p.kind === 'host') {
    return failures.fail(CODE.VM_UNAVAILABLE, 'this operation needs a VM environment, and the task is bound to the host');
  }
  return { ok: true, provider: p.provider, env: p.describe };
}

/** The guest's own path separator convention, from what a person registered. */
function guestRoot(env) {
  return /win/i.test(String(env.guestOs || 'windows')) ? GUEST_ROOT_WIN : GUEST_ROOT_POSIX;
}

function guestJoin(env, ...parts) {
  const root = guestRoot(env);
  const sep = root.includes('\\') ? '\\' : '/';
  return [root, ...parts].join(sep);
}

/** BRING A VM UP AND WAIT UNTIL IT CAN ACTUALLY TAKE WORK. */
async function ready(spec, { clean = false, timeoutMs = READY_TIMEOUT_MS, signal = null } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const { provider, env } = b;

  const avail = provider.available();
  if (!avail.available) {
    return failures.fail(CODE.VM_UNAVAILABLE, avail.why, avail.detail, { state: provider.STATE.UNAVAILABLE });
  }

  if (clean) {
    const r = await provider.restore(env);
    if (!r.ok) return r;
  }

  const st = await provider.status(env);
  if (!st.ok) return st;
  if (!st.powered) {
    const started = await provider.start(env);
    if (!started.ok) return started;
  }

  const deadline = Date.now() + timeoutMs;
  let last = 'the guest was not asked yet';
  while (Date.now() < deadline && !(signal && signal.aborted)) {
    // eslint-disable-next-line no-await-in-loop -- a boot is a poll by nature.
    const h = await provider.health(env, { timeoutMs: Math.min(30_000, deadline - Date.now()) });
    if (h.ok && h.ready) return { ok: true, state: provider.STATE.READY, environment: env.spec, id: env.id };
    last = (h && (h.why || h.detail)) || last;
    // eslint-disable-next-line no-await-in-loop -- same.
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  if (signal && signal.aborted) return failures.fail(CODE.VM_NOT_READY, 'waiting for the guest was cancelled');
  return failures.fail(
    CODE.VM_NOT_READY,
    `${env.id} is powered on but never became ready`,
    `Last answer: ${last}. A VM that is running is not necessarily a VM that can take work — VMware Tools must be installed and the guest logged in for guest operations to work.`,
    { state: provider.STATE.BUSY },
  );
}

/** Run one command in the guest. A primitive: it decides nothing. */
async function exec(spec, command, args = [], opts = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  return b.provider.exec(b.env, command, args, opts);
}

/** PUT A KNOWN TREE INTO THE GUEST. */
async function sync(spec, hostArchive, { name = 'project' } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const dest = guestJoin(b.env, `${name}${path.extname(String(hostArchive)) || '.zip'}`);
  const put = await b.provider.copyIn(b.env, hostArchive, dest);
  if (!put.ok) return put;
  return { ok: true, guestPath: dest };
}

/** BRING EVIDENCE BACK, THROUGH THE ARTIFACT AUTHORITY. */
async function collect(spec, guestPath, { store = null, taskId = null, kind = 'screenshot', name = null, note = '' } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  const fs = require('fs');
  const os = require('os');
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-guest-'));
  } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `could not prepare a landing directory: ${(e && e.message) || e}`);
  }
  const base = String(guestPath).split(/[\\/]/).pop() || 'artifact';
  const local = path.join(tmp, base);
  const got = await b.provider.copyOut(b.env, guestPath, local);
  if (!got.ok) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } return got; }

  if (!store) return { ok: true, path: local, from: guestPath, artifact: null };
  let body;
  try { body = fs.readFileSync(local); } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `the file arrived but could not be read: ${(e && e.message) || e}`);
  }
  try {
    const art = store.put(taskId, { kind, name: name || base, body, note: note || `from ${b.env.spec}` });
    return { ok: true, artifact: art, from: guestPath, environment: b.env.spec };
  } catch (e) {
    return failures.fail(CODE.ARTIFACT_TRANSFER_FAILED, `the artifact store refused it: ${(e && e.message) || e}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** LAUNCH A HARNESS CHROMIUM INSIDE THE GUEST. */
async function launchChromium(spec, kind, { taskId = null, headless = true } = {}) {
  const b = bind(spec);
  if (!b.ok) return b;
  if (!purpose.isPurpose(kind)) return failures.fail(CODE.CHROMIUM_FAILED, `unknown browser purpose: ${kind}`);
  // A GUEST'S PROFILE IS THE GUEST'S.
  const profileDir = guestJoin(b.env, 'profiles', String(kind));
  const exe = b.env.chromium || null;
  if (!exe) {
    return failures.fail(
      CODE.CHROMIUM_FAILED,
      `${b.env.id} has no guest Chromium registered`,
      'Register the guest browser path with `chromium` on the environment entry, or install one in the guest image.',
    );
  }
  const args = require('./chromium').argsFor(kind, profileDir, { headless });
  const started = await b.provider.exec(b.env, exe, args, { wait: false });
  if (!started.ok) return { ...started, code: CODE.CHROMIUM_FAILED };
  return { ok: true, environment: b.env.spec, profileDir, args, exe, taskId };
}

/** Stop everything LAIN started in this guest. Best effort, and it says so. */
async function cleanup(spec) {
  const b = bind(spec);
  if (!b.ok) return b;
  return { ok: true, environment: b.env.spec, note: 'guest cleanup is delegated to the clean-snapshot restore before the next run' };
}

module.exports = {
  READY_TIMEOUT_MS, READY_POLL_MS, GUEST_ROOT_WIN, GUEST_ROOT_POSIX,
  bind, ready, exec, sync, collect, launchChromium, cleanup, guestRoot, guestJoin,
};
