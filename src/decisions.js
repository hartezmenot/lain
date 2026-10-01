'use strict';

/**
 * ONE PENDING DECISION, MANY SURFACES (§39–40).
 *
 * A question LAIN needs a person to answer — ask_user, a permission, a MANUAL
 * step, a capability request, a download — is ONE Core record:
 *
 *     { id, sessionId, type, title, question, options, expires, nonce, sig }
 *
 * The CLI panel, the Harness window and Telegram all resolve the SAME record,
 * across processes: the record is a file in the LAIN home, and an answer is a
 * second file created with O_EXCL — so the FIRST valid answer wins and every
 * later one is told who answered. The process that asked watches for the
 * answer file and closes its own panel the moment another surface answers.
 *
 * A remote answer must carry the signature: a truncated HMAC over
 * (id, nonce, session, expiry) keyed by a per-install secret that never leaves
 * this machine. The Telegram button token is id+signature (24 hex), which is
 * exactly the shape the existing `lain:<id>:<n>` callback path carries.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TYPES = Object.freeze(['ASK_USER', 'PERMISSION_REQUEST', 'CAPABILITY_REQUEST', 'DOWNLOAD_REQUEST', 'BLOCKED']);
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 400;

const bus = new EventEmitter();
bus.setMaxListeners(50);
const mine = new Map();       // decisions this process created, by id
let timer = null;

function dir() {
  const d = path.join(require('./config').configDir(), 'decisions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function key() {
  const f = path.join(dir(), '.key');
  try { return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); } catch { /* first use */ }
  const k = crypto.randomBytes(32);
  try { fs.writeFileSync(f, k.toString('hex'), { flag: 'wx', mode: 0o600 }); return k; } catch { /* lost a race */ }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}

function sign(d) {
  return crypto.createHmac('sha256', key()).update(`${d.id}|${d.nonce}|${d.sessionId}|${d.expires}`).digest('hex').slice(0, 16);
}

const recordFile = (id) => path.join(dir(), `${id}.json`);
const answerFile = (id) => path.join(dir(), `${id}.answer.json`);
const safeId = (id) => /^[0-9a-f]{8}$/.test(String(id || ''));

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function prune() {
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(dir(), n);
    try { if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f); } catch { /* in use */ }
  }
}

function create({ type = 'ASK_USER', sessionId = '', title = '', question = '', options = [], ttlMs = DEFAULT_TTL_MS, meta = null, project = '' } = {}) {
  const d = {
    id: crypto.randomBytes(4).toString('hex'),
    sessionId: String(sessionId || ''),
    project: String(project || ''),
    type: TYPES.includes(type) ? type : 'ASK_USER',
    title: String(title || ''),
    question: String(question || ''),
    options: (options || []).map(String).slice(0, 8),
    createdAt: Date.now(),
    expires: Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
    nonce: crypto.randomBytes(8).toString('hex'),
    meta: meta || null,
    pid: process.pid,
  };
  d.sig = sign(d);
  if (Math.random() < 0.05) prune();
  writeAtomic(recordFile(d.id), d);
  mine.set(d.id, { ...d, state: 'PENDING' });
  watch();
  bus.emit('created', { ...d, state: 'PENDING' });
  return { ...d, state: 'PENDING' };
}

/** The current state of a decision, from disk — whoever created it. */
function get(id) {
  if (!safeId(id)) return null;
  const d = read(recordFile(id));
  if (!d) return null;
  const a = read(answerFile(id));
  if (a) return { ...d, state: a.state || 'RESOLVED', answer: a.answer, surface: a.surface, answeredAt: a.at };
  if (Date.now() > d.expires) return { ...d, state: 'EXPIRED' };
  // THE PROCESS THAT ASKED IS GONE: nobody is waiting for this answer any more,
  // so no surface may offer it (§80 — resume never resurrects stale approvals).
  if (d.pid && d.pid !== process.pid && !alive(d.pid)) return { ...d, state: 'ABANDONED' };
  return { ...d, state: 'PENDING' };
}

/** Every decision still waiting, optionally for one session. Read from disk. */
function pending(sessionId = null) {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^([0-9a-f]{8})\.json$/.exec(n);
    if (!m) continue;
    const d = get(m[1]);
    if (d && d.state === 'PENDING' && (!sessionId || d.sessionId === sessionId)) out.push(d);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The Telegram/remote token: id + signature, 24 hex. */
function token(d) { return `${d.id}${d.sig}`; }

/**
 * First valid answer wins. A remote surface must present the signature.
 * `answer` may be an option index (0-based) or the option text.
 * @returns {{ok:boolean, why?:string, decision?:object}}
 */
function resolve(id, answer, { surface = 'cli', sig = null } = {}) {
  const d = get(id);
  if (!d) return { ok: false, why: 'unknown decision' };
  if (d.state !== 'PENDING') return { ok: false, why: d.state === 'EXPIRED' ? 'expired' : `already answered in ${d.surface}` };
  const local = surface === 'cli' || surface === 'harness';
  if (!local) {
    const want = Buffer.from(d.sig);
    const got = Buffer.from(String(sig || ''));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, why: 'bad signature' };
  }
  const value = typeof answer === 'number' ? d.options[answer] : answer;
  if (!local && d.options.length && !d.options.includes(value)) return { ok: false, why: 'not one of the options' };
  const row = { state: value == null ? 'DISMISSED' : 'RESOLVED', answer: value == null ? null : String(value), surface, at: Date.now() };
  try {
    fs.writeFileSync(answerFile(id), JSON.stringify(row), { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') { const now = get(id); return { ok: false, why: `already answered in ${now && now.surface}` }; }
    return { ok: false, why: (e && e.message) || 'could not record the answer' };
  }
  const settled = { ...d, ...row };
  if (mine.has(id)) mine.delete(id);
  bus.emit('resolved', settled);
  return { ok: true, decision: settled };
}

function cancel(id, why = 'cancelled') {
  const d = get(id);
  if (!d || d.state !== 'PENDING') return false;
  try { fs.writeFileSync(answerFile(id), JSON.stringify({ state: 'CANCELLED', answer: null, surface: why, at: Date.now() }), { flag: 'wx' }); } catch { return false; }
  mine.delete(id);
  bus.emit('resolved', { ...d, state: 'CANCELLED', answer: null, surface: why });
  return true;
}

/** Notice answers written by OTHER processes for the decisions this one is waiting on. */
function watch() {
  if (timer) return;
  timer = setInterval(() => {
    if (!mine.size) { clearInterval(timer); timer = null; return; }
    for (const id of [...mine.keys()]) {
      const d = get(id);
      if (!d || d.state === 'PENDING') continue;
      mine.delete(id);
      bus.emit('resolved', d);
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();
}

function on(event, fn) { bus.on(event, fn); return () => bus.off(event, fn); }

/**
 * Ask through every surface at once and return the first valid answer. The CLI
 * or Harness answers through `interaction.ask` (or `localAsk`); a remote answer
 * closes the local panel with the same value.
 */
async function ask(app, q = {}, signal = null, localAsk = null) {
  const d = create({
    type: q.type || 'ASK_USER',
    sessionId: (app && app.session && app.session.id) || '',
    project: (app && app.session && path.basename(app.session.cwd || '')) || '',
    title: q.title, question: q.question, options: q.options || [], meta: q.meta || null, ttlMs: q.ttlMs,
  });
  const interaction = require('./interaction');
  let settle;
  const remote = new Promise((r) => { settle = r; });
  const off = on('resolved', (x) => { if (x.id === d.id) settle(x); });
  const hasLocal = Boolean(localAsk) || interaction.available(app);
  const remoteListening = remoteSurfaces() > 0;
  if (!hasLocal && !remoteListening) { cancel(d.id, 'no surface'); off(); return null; }
  let panelRef = null;
  const local = localAsk ? localAsk()
    : hasLocal ? interaction.ask(app, { title: q.title, question: q.question, options: q.options || [] }, signal)
      : new Promise(() => {});
  if (app && app.ui && app.ui.enabled && app.ui.panel && app.ui.panel.stack) panelRef = app.ui.panel.stack[0] || null;
  const onAbort = () => cancel(d.id, 'aborted');
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const first = await Promise.race([
      Promise.resolve(local).then((answer) => ({ from: 'local', answer })),
      remote.then((x) => ({ from: 'remote', x })),
    ]);
    if (first.from === 'local') {
      const r = resolve(d.id, first.answer, { surface: interaction.port(app) ? 'harness' : 'cli' });
      if (r.ok) return r.decision.answer;
      const now = get(d.id);
      return now && now.state === 'RESOLVED' ? now.answer : null;
    }
    if (panelRef && app.ui.panel.stack && app.ui.panel.stack[0] === panelRef) app.ui.panel.close(first.x.answer);
    return first.x.state === 'RESOLVED' ? first.x.answer : null;
  } finally {
    off();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Wrap a turn's `ask` so each ask_user becomes one Core decision; null stays null. */
function wrapAsk(app, local) {
  if (!local) return null;
  return (q) => ask(app, { type: 'ASK_USER', title: 'Noema asks', question: q && q.question, options: (q && q.options) || [] },
    app && app.abort ? app.abort.signal : null, () => local(q));
}

/**
 * Is any remote surface (a running bot service) able to answer? A heartbeat
 * file the bot bridge refreshes; stale after 15s.
 */
function remoteSurfaces() {
  try {
    const st = fs.statSync(path.join(dir(), '.remote'));
    return Date.now() - st.mtimeMs < 15000 ? 1 : 0;
  } catch { return 0; }
}
function heartbeat() { try { fs.writeFileSync(path.join(dir(), '.remote'), String(Date.now())); } catch { /* best effort */ } }

/** Test seam: forget this process's waiting set and listeners. */
function _reset() { mine.clear(); bus.removeAllListeners(); if (timer) { clearInterval(timer); timer = null; } }

module.exports = { TYPES, create, get, pending, resolve, cancel, on, ask, wrapAsk, sign, token, dir, heartbeat, remoteSurfaces, _reset };
