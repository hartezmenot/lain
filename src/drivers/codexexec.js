'use strict';

/** A NATIVE CODEX ACCOUNT AS A LAIN ROUTE (Phase 8.2) — Chat answered by the account's own Codex, so "Codex · Account 3 › GPT-6 Sol" is exactly that… */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function workDir() {
  const d = path.join(require('../config').configDir(), 'codex-chat');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* reported by the spawn */ }
  return d;
}

/** The instance a route names: runtime:codex:<instance id>. */
function instanceOf(pc) { return String((pc && (pc.instanceId || pc.connectionId)) || '').replace(/^runtime:codex:/, ''); }

/** The arguments of one Chat request — read-only, ephemeral, nothing of the person's config. */
function argsFor(model, effort = null) {
  const a = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--cd', workDir()];
  if (model) a.push('--model', String(model));
  // THE LANE'S EFFORT as Codex's own config override (fabric/effortcaps.js) — a level this account listed.
  a.push(...require('../fabric/effortcaps').runtimeArgs('codex', effort));
  a.push('-');
  return a;
}

/** One line of Codex's JSONL event stream → LAIN's event vocabulary (or null). */
function mapEvent(m) {
  if (!m || typeof m !== 'object') return null;
  const item = m.item || (m.msg && m.msg.item) || null;
  if (m.type === 'item.completed' && item && item.type === 'agent_message' && item.text) return { type: 'text', chunk: String(item.text) };
  if (m.type === 'turn.completed' && m.usage) {
    const u = m.usage;
    return { type: 'usage', inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0, cacheReadTokens: Number(u.cached_input_tokens) || 0, cacheCreationTokens: 0, cacheReported: u.cached_input_tokens != null };
  }
  if (m.type === 'turn.failed' || m.type === 'error') return { type: 'error', message: String((m.error && (m.error.message || m.error)) || m.message || 'Codex reported an error') };
  return null;
}

async function* chat(pc, messages, opts = {}) {
  const app = opts.app || null;
  const id = instanceOf(pc);
  const ai = require('../accountinstances');
  const rec = ai.record(id);
  if (!rec || rec.driver_id !== 'codex') { const e = new Error(`no Codex account "${id}"`); e.status = 404; throw e; }
  const h = ai.handle(app, id);
  if (!h || !h.layout) { const e = new Error('that Codex account has no home'); e.status = 409; throw e; }
  // AN OVERLAY HOME is assembled (links to the shared home, its own sign-in) before Codex runs in it.
  try { require('./codexhome').materialize(h.layout); } catch { /* a direct home needs nothing */ }
  // THE SAME PROGRAM this account's app-server runs (a configured path, else codex on PATH).
  const root = (app && app._sibling) || app;
  const bin = (h.binary && h.binary()) || require('../providerdrivers').get('codex').binary((root && root.cfg) || {});
  if (!bin) { const e = new Error('Codex is not installed (no codex on PATH)'); e.status = 503; throw e; }
  const { system, prompt } = require('./runtimechat').flatten(messages);
  // LAIN'S POLICY in Codex's own frame (discipline/constitution.js) — rendered from LAIN, not a second authority.
  const text = system ? `${require('../discipline/constitution').wrap('codex', system)}\n\n${prompt}` : prompt;
  const args = [...(bin.args || []), ...argsFor(pc.model, pc.reasoningEffort || null)];
  const child = spawn(bin.command, args, { env: { ...process.env, CODEX_HOME: h.layout.home }, cwd: workDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const work = require('../accountwork').begin('codex', id, { kind: 'chat', pid: child.pid });   // this account is working until the process ends
  const reg = require('../runtimeregistry').register(child, { purpose: 'runtime:codex-chat', label: `codex exec (${rec.display_name})`, command: `${bin.command} ${args.join(' ')}`, policy: { onOwnerExit: 'stop' } });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdin.on('error', () => { /* it exited before reading; reported below */ });
  child.stdin.end(text);
  const signal = opts.signal || null;
  // STOPPED BY ITS OWN REGISTERED HANDLE — the whole tree it started, never anything by name.
  const kill = () => { try { require('../runtimeregistry').stop(reg); } catch { try { child.kill(); } catch { /* gone */ } } };
  if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
  const lines = [];
  let wake = null; let ended = false; let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lines.push(l); } if (wake) { const w = wake; wake = null; w(); } });
  const done = new Promise((resolve) => child.on('close', (code) => { if (buf.trim()) lines.push(buf.trim()); ended = true; if (wake) { const w = wake; wake = null; w(); } resolve(code); }));
  child.on('error', (e) => { stderr += `\n${e.message}`; });
  done.then(() => require('../accountwork').end(work));
  let said = false; let failure = null;
  try {
    for (;;) {
      while (lines.length) {
        const l = lines.shift();
        let m; try { m = JSON.parse(l); } catch { continue; }
        const ev = mapEvent(m);
        if (!ev) continue;
        if (ev.type === 'error') { failure = ev.message; continue; }
        if (ev.type === 'text') { said = true; yield ev; continue; }
        yield ev;
      }
      if (ended) break;
      // eslint-disable-next-line no-await-in-loop -- waiting on the process's next line
      await new Promise((r) => { wake = r; });
    }
    const code = await done;
    if (signal && signal.aborted) { const e = new Error('cancelled'); e.status = 499; e.cancelled = true; throw e; }
    if (failure || (code !== 0 && !said)) {
      const e = new Error(`Codex (${rec.display_name}): ${require('../redact').text(failure || stderr.trim().split(/\r?\n/).slice(-2).join(' ') || `exit ${code}`).slice(0, 300)}`);
      e.status = /sign|auth|login/i.test(failure || stderr) ? 401 : 502;
      throw e;
    }
    yield { type: 'finish', reason: 'stop' };
  } finally {
    if (signal) signal.removeEventListener('abort', kill);
    if (!ended) kill();   // (an exited process leaves the registry by itself)
  }
}

module.exports = { chat, argsFor, mapEvent, instanceOf, workDir, homeOf: (h) => (h && h.layout ? h.layout.home : os.homedir()) };
