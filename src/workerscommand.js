'use strict';

/** `/workers` — THE DIAGNOSTIC SURFACE for specialist workers. */

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
      else if (v === 'on') { try { require('./layacontext').prewarm(app); } catch { /* loads on first use */ } }
    }
  } else if (a !== 'status') { w(C.dim('  usage: /workers [status|auto|off|locate on|off|laya [auto|on|off]]\n')); return; }

  w('\n' + C.bold('Workers') + C.dim(`  policy ${rt.policyOf(app).toUpperCase()} · a specialist serves only a use its gate passed, unless forced on\n`));
  const loc = String(process.env.LAIN_LOCATE || app.cfg.workers.locate || 'off').toLowerCase();
  w(`  locate    file shortlist     ${loc === 'on' ? 'on' : 'off (opt-in: /workers locate on)'}\n`);
  // INSTALLED ≠ LOADED ≠ PARTICIPATING. Each is its own line: the runtime,
  // then every role with its mode and what it actually did this session.
  const invoked = roleCounts(app);
  for (const s of rt.status(app)) {
    if (s.status === 'EXCLUDED') { w(`  ${s.id.padEnd(9)} EXCLUDED\n`); w(C.dim(`            ${s.reason}\n`)); continue; }
    w(`  ${s.id.padEnd(9)} runtime ${s.status === 'INSTALLED' ? 'installed' : 'not installed'} · ${s.warm ? `loaded (${s.state})` : s.state === 'LOADING' ? 'loading' : 'not loaded'} · switch ${s.switch}\n`);
    for (const r of s.roles || []) {
      const n = invoked[`${s.id}:${r.role}`] || { invoked: 0, background: 0, critical: 0 };
      w(`            ${r.role.padEnd(28)} ${r.mode.padEnd(6)}${r.explicit ? ' (set)' : '      '} invoked ${n.invoked} · background ${n.background} · critical-path ${n.critical}\n`);
    }
    for (const [use, g] of Object.entries(s.gates)) w(C.dim(`            gate ${use}: ${g.pass ? 'PASS' : 'FAIL'} · ${g.detail || ''}\n`));
    if (s.verdict) w(C.dim(`            verdict ${s.verdict}\n`));
  }
  try {
    const lm = require('./layacontext').metrics(app);
    w(C.dim(`  laya background: ${lm.queued} queued${lm.running ? ' · running' : ''} · critical-path calls ${lm.criticalPathCalls} · self-dispatch refused ${lm.selfDispatchRefused}\n`));
    for (const [role, m] of Object.entries(lm.roles)) {
      if (!m.dispatched) continue;
      w(C.dim(`            ${role}: dispatched ${m.dispatched} · skipped ${m.skipped} · validated ${m.validated} · invalid ${m.invalid} · late ${m.late} · consumed ${m.consumed}`
        + `${m.referentRecall != null ? ` · referent recall ${m.referentRecall}` : ''}${m.compression != null ? ` · compression ×${m.compression}` : ''}\n`));
    }
  } catch { /* metrics only */ }
  const retired = rt.retired();
  for (const [id, r] of Object.entries(retired)) w(C.dim(`  ${id.padEnd(9)} RETIRED ${r.retiredAt || ''} · ${r.why || ''}\n`));
  // WHAT CORE ASSIGNED THIS SESSION (dispatch.js) — availability is not invocation.
  const ds = require('./dispatch').summary(app.session);
  if (ds.inputs) {
    const m = ds.migration;
    w(C.dim(`  dispatch  ${ds.inputs} input(s) · ${Object.entries(ds.byClass).map(([k, n]) => `${k} ${n}`).join(' · ')}\n`));
    w(C.dim(`            migration_plan eligible ${m.eligible} · offered ${m.offered} · invoked ${m.invoked} · used ${m.used}\n`));
    for (const [k, j] of Object.entries(ds.jobs)) w(C.dim(`            job ${k} · dispatched ${j.dispatched} · shadow ${j.shadow} · consumed ${j.consumed} · late ${j.late}\n`));
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

/** WHAT EACH ROLE ACTUALLY DID this session: Core-dispatched job rows (dispatch.js ledger, awaited on a turn = critical path unless SHADOW) and… */
function roleCounts(app) {
  const out = {};
  const add = (k, f) => { const o = out[k] = out[k] || { invoked: 0, background: 0, critical: 0 }; f(o); };
  for (const d of (app.session && app.session.dispatchLedger) || []) {
    for (const j of d.jobs || []) {
      if (!j.worker || j.worker === 'CORE' || /SKIPPED|NOT_DISPATCHED/.test(String(j.mode))) continue;
      add(`${String(j.worker).toLowerCase()}:${j.role}`, (o) => { o.invoked += 1; if (j.mode !== 'SHADOW') o.critical += 1; else o.background += 1; });
    }
  }
  try {
    for (const [role, m] of Object.entries(require('./layacontext').metrics(app).roles)) {
      if (m.completed || m.failed) add(`laya:${role}`, (o) => { o.invoked += m.completed + m.failed; o.background += m.completed + m.failed; });
    }
  } catch { /* metrics only */ }
  return out;
}

/** THE WORKER HOST, when one is running: each model's residency, apart from the per-session numbers above. */
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

/** One worker's readiness for one project, both axes and the verdict: model HOT_IDLE · project index READY 82 files · generation 76ea06… · ready for… */
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
