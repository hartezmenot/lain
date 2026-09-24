'use strict';

/**
 * `/workers` — THE DIAGNOSTIC SURFACE for specialist workers. Normal work never
 * asks for one by name; policy picks (workerruntime.uses). This is where a
 * person sees what policy is doing and can switch it:
 *
 *   /workers [status]          what is installed, switched, gated, running
 *   /workers auto | off        every specialist at once
 *   /workers locate on | off   the file shortlist (opt-in: no measured saving yet)
 *   /workers laya [auto|on|off]  one worker: auto = only where its gate passed,
 *                              on = forced (for an experiment), off
 *
 * Switches are written to the person's config (cfg.workers), never the repo.
 */

function save(app) { try { require('./config').save(app.cfg); } catch { /* applies in memory */ } }

function run(app, args, { C, gateResults = () => [] }) {
  const rt = require('./workerruntime');
  const workers = require('./workers');
  const w = (s) => app.render.write(s);
  const a = String(args[0] || 'status').toLowerCase();
  app.cfg.workers = app.cfg.workers || {};
  if (a === 'auto' || a === 'off') { app.cfg.workers.policy = a; save(app); if (a === 'off') rt.stop(app, { unload: true }); }
  else if (a === 'locate') {
    const v = String(args[1] || '').toLowerCase();
    if (v === 'on' || v === 'off') { app.cfg.workers.locate = v; save(app); }
  } else if (rt.manifest()[a]) {
    const v = String(args[1] || '').toLowerCase();
    if (['auto', 'on', 'off'].includes(v)) {
      if (rt.manifest()[a].status === 'EXCLUDED' && v !== 'off') { w(C.dim(`  ${a} is EXCLUDED on this install: ${rt.manifest()[a].reason}\n`)); return; }
      app.cfg.workers[a] = { ...(app.cfg.workers[a] || {}), enabled: v }; save(app);
      if (v === 'off') rt.stop(app, { unload: true, ids: [a] });
      else if (v === 'on') { try { require('./locateassist').prewarm(app); } catch { /* loads on first use */ } }
    }
  } else if (a !== 'status') { w(C.dim('  usage: /workers [status|auto|off|locate on|off|laya [auto|on|off]]\n')); return; }

  w('\n' + C.bold('Workers') + C.dim(`  policy ${rt.policyOf(app).toUpperCase()} · a specialist serves only a use its gate passed, unless forced on\n`));
  const loc = String(process.env.LAIN_LOCATE || app.cfg.workers.locate || 'off').toLowerCase();
  w(`  locate    file shortlist     ${loc === 'on' ? 'on' : 'off (opt-in: /workers locate on)'}\n`);
  for (const s of rt.status(app)) {
    const state = s.status === 'EXCLUDED' ? 'EXCLUDED'
      : `${s.status.toLowerCase()} · switch ${s.switch}${s.state !== 'UNLOADED' ? ` · ${s.state}` : ''}`;
    w(`  ${s.id.padEnd(9)} ${String(s.contract).padEnd(18)} ${state}\n`);
    for (const [use, g] of Object.entries(s.gates)) w(C.dim(`            gate ${use}: ${g.pass ? 'PASS' : 'FAIL'} · ${g.detail || ''}\n`));
    if (s.verdict) w(C.dim(`            verdict ${s.verdict}\n`));
    if (s.status === 'EXCLUDED') w(C.dim(`            ${s.reason}\n`));
  }
  for (const g of gateResults()) w(C.dim(`  decision gate ${g.pass ? 'PASS' : 'FAIL'} · ${g.model} · ${g.detail}\n`));
  const sum = workers.summary(app.session);
  const keys = Object.keys(sum);
  w('\n' + (keys.length ? '' : C.dim('  No worker ran in this session.\n')));
  for (const k of keys) {
    const s = sum[k];
    w(`  ${k.padEnd(18)} ${s.calls} call(s) · raw ${s.rawChars} → out ${s.outChars} chars${s.compression ? ` (×${s.compression})` : ''}`
      + ` · false-narrowing misses ${s.missed || 0} · abstain ${s.abstain} · cache ${s.cacheHits}\n`);
  }
  return hostBlock(app, w, C);
}

/**
 * THE WORKER HOST, when one is running: each model's residency, apart from
 * the per-session numbers above. HOT_IDLE is memory held, not work done.
 * Asked of a host that is already there — `/workers` never starts one.
 */
async function hostBlock(app, w, C) {
  const rt = require('./workerruntime');
  let s = null;
  try { s = await rt.hostView(app); } catch { s = null; }
  if (!s) return;
  const mb = (v) => (v == null ? '?' : `${v} MB`);
  w('\n' + C.bold('Worker host') + C.dim(`  pid ${s.pid} · up ${Math.round(s.uptimeMs / 1000)} s · ${s.leases.length} LAIN client(s) · grace ${Math.round(s.graceMs / 1000)} s after the last\n`));
  for (const v of Object.values(s.workers)) {
    w(`  ${v.id.padEnd(9)} ${v.state.padEnd(12)} load ${v.loadMs == null ? (v.loadingForMs != null ? `${Math.round(v.loadingForMs / 1000)} s so far` : '—') : `${(v.loadMs / 1000).toFixed(1)} s`}`
      + ` · resident ${mb(v.residentMB)} · ${v.inferences} inference(s) · reloads ${v.reloads}${v.idleMs != null ? ` · idle ${Math.round(v.idleMs / 1000)} s` : ''}`
      + `${v.lastError ? ` · last error ${v.lastError}` : ''}\n`);
    // MODEL HOT != PROJECT READY: the second axis, per project this host has indexed.
    for (const p of v.projects || []) for (const line of projectLines(v, p)) w(C.dim(line));
  }
}

/**
 * One worker's readiness for one project, both axes and the verdict:
 *   model HOT_IDLE · project index READY 82 files · generation 76ea06… · ready for task YES
 */
function projectLines(v, p) {
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago` : '—');
  const index = p.progress ? `${p.state} ${p.progress.done}/${p.progress.total}` : `${p.state}${p.files ? ` · ${p.files} files` : ''}`;
  const m = p.metrics || {};
  const last = m.wallMs == null ? '' : m.noop ? ' · last check: unchanged'
    : ` · last run ${m.restored ? 'restored' : 'built'}: reused ${m.reused}, embedded ${m.embedded}, removed ${m.removed} in ${(m.wallMs / 1000).toFixed(1)} s`;
  return [
    `            project ${p.root}\n`,
    `              model ${v.state} · project index ${index} · generation ${p.generation || '—'} · refreshed ${ago(p.refreshedAt)}${last}\n`,
    `              ready for task: ${require('./layaindex').readyForTask(v.state, p, v.indexing) ? 'YES' : 'NO'}${p.lastError ? ` · ${p.lastError}` : ''}\n`,
  ];
}

module.exports = { run };
