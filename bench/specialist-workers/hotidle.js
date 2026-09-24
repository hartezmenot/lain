'use strict';

/**
 * LAYA HOT-IDLE ACCEPTANCE — the real model in the worker host, the real
 * binary in a real terminal, the MOCK provider (zero flagship requests).
 *
 *   LAIN_TTY_PYTHON=… node bench/specialist-workers/hotidle.js
 *
 *   §52 COLD START      no host, no model: LAIN opens; when is the prompt
 *                       usable, and when is Laya HOT_IDLE? (and the same
 *                       open with Laya off, for comparison)
 *   §54 COLD PROMPT     a request while Laya is LOADING: the turn goes on
 *                       without it (bypass recorded), no wait
 *   §55 MID-TASK READY  Laya becomes hot while the session runs; a LATER turn
 *                       uses it — nothing is rewound to involve it
 *   §53 HOT PROMPT      a new LAIN process finds Laya hot: submit → dispatch →
 *                       Evidence Slice timing
 *   §44 RESULT CACHE    the same question on the same state: zero inference;
 *                       an edited file: re-evaluated
 *   §56 FAILURE         the Laya process killed; then the whole host killed:
 *                       LAIN finishes each run, bounded restart, no loop
 *   CRASH               LAIN hard-killed: the model stays hot (no reload)
 *
 * Writes out/hotidle-<stamp>.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runTty } = require('../../tests/tty/realtty');
const { runCli } = require('../../tests/helpers');
const { reset } = require('./reset');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ROOT = path.join(os.tmpdir(), 'lain-hotidle', stamp);
const HOSTDIR = path.join(ROOT, 'workerhost');
process.env.LAIN_WORKERHOST_DIR = HOSTDIR;
const host = require('../../src/workerhost');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = 'Where is the note composer send button styled, and which file saves the workspace settings?';
const Q2 = 'Which files handle signing in and the login route on the server?';

/** The host's view every 100 ms, stamped — the timeline of LOADING → HOT_IDLE. Never starts a host. */
function watch() {
  const rows = [];
  let on = true;
  (async () => {
    while (on) {
      if (host.endpoint(HOSTDIR)) {
        const s = await host.status();
        if (s.ok && s.workers.laya) rows.push({ t: Date.now(), state: s.workers.laya.state, loads: s.workers.laya.loads, pid: s.workers.laya.pid });
      }
      await sleep(100);
    }
  })();
  return { rows, stop: () => { on = false; }, first: (st) => (rows.find((r) => r.state === st) || {}).t || null };
}

function sessionOf(configDir) {
  const dir = path.join(configDir, 'sessions');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  for (const f of files) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* next */ } }
  return null;
}

const rowView = (r) => r && ({ tier: r.tier, ms: r.ms, layaMs: r.layaMs, bypass: r.layaBypass, timedOut: r.layaTimedOut, cacheHit: r.cacheHit,
  usage: r.layaUsage, rawChars: r.rawChars, outChars: r.outChars, slice: r.slice, warmWaitMs: r.warmWaitMs, at: r.at });

const ENV = { LAIN_WORKER_LAYA: 'on', LAIN_LOCATE: 'on', LAIN_WORKER_VIOLETTO: 'off', LAIN_WORKERHOST_DIR: HOSTDIR };

async function openOnly(laya) {
  // §52 comparison: how long until the prompt is usable, Laya on vs off.
  const work = reset(path.join(ROOT, `open-${laya}`));
  const t0 = Date.now();
  const out = await runTty({ cwd: work.dest, env: { ...ENV, LAIN_WORKER_LAYA: laya, LAIN_WORKERHOST_DIR: path.join(ROOT, `host-open-${laya}`) }, script: [{ text: 'unused' }],
    steps: [{ until: 'Ask LAIN', timeout: 60000 }, { snap: 'ready', settle: 50 }], timeoutMs: 120000 });
  const ready = out.marks.find((m) => m.until === 'Ask LAIN');
  try { process.env.LAIN_WORKERHOST_DIR = path.join(ROOT, `host-open-${laya}`); await host.pending(); await host.shutdown('open test over'); } finally { process.env.LAIN_WORKERHOST_DIR = HOSTDIR; }
  return { laya, cliReadyMs: ready ? ready.at : null, wallMs: Date.now() - t0, timeouts: out.timeouts };
}

(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const result = { stamp, hostDir: HOSTDIR, machine: { cpus: os.cpus().length, cpu: os.cpus()[0].model, totalMB: Math.round(os.totalmem() / 1048576) } };
  const outFile = path.join(__dirname, 'out', `hotidle-${stamp}.json`);
  const write = () => fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  result.openComparison = [await openOnly('off'), await openOnly('on')];
  write();

  // ---- SESSION 1: cold start, cold prompt, mid-task ready ----------------------
  const w = watch();
  const work = reset(path.join(ROOT, 'fixture'));
  const s1 = path.join(ROOT, 'session1');
  const spawnAt = Date.now();
  const tty1 = await runTty({
    cwd: work.dest, configDir: s1, env: ENV,
    script: [{ text: 'MOCKDONE-ONE' }, { text: 'MOCKDONE-TWO' }, { text: 'MOCKDONE-THREE' }],
    steps: [
      { until: 'Ask LAIN', timeout: 60000 }, { snap: 'ready', settle: 50 },
      { send: `${Q}\r` }, { until: 'MOCKDONE-ONE', timeout: 60000 }, { snap: 'turn1', settle: 50 },
      // LAYA BECOMES HOT WHILE THIS SESSION IS OPEN (measured loads 30–81 s).
      { wait: 110000 },
      { send: `${Q2}\r` }, { until: 'MOCKDONE-TWO', timeout: 60000 }, { snap: 'turn2', settle: 50 },
      { send: `${Q}\r` }, { until: 'MOCKDONE-THREE', timeout: 60000 }, { snap: 'turn3', settle: 50 },
    ],
    timeoutMs: 6 * 60 * 1000,
  });
  const sess1 = sessionOf(s1);
  const ledger1 = (sess1 && sess1.workerLedger) || [];
  const hotAt = w.first('HOT_IDLE');
  const loadingAt = w.first('LOADING');
  const mark = (re) => (tty1.marks.find((m) => m.until === re) || {}).at || null;
  result.session1 = {
    timeouts: tty1.timeouts,
    cliReadyMs: mark('Ask LAIN'),
    layaLoadingSeenMs: loadingAt ? loadingAt - spawnAt : null,
    layaHotIdleMs: hotAt ? hotAt - spawnAt : null,
    note: 'ms since the bench launched the terminal driver (the driver spawn adds a little before LAIN itself starts)',
    turn1: { doneMs: mark('MOCKDONE-ONE'), locate: rowView(ledger1[0]) },
    turn2: { doneMs: mark('MOCKDONE-TWO'), locate: rowView(ledger1[1]) },
    turn3: { doneMs: mark('MOCKDONE-THREE'), locate: rowView(ledger1[2]) },
    workerStats: sess1 && sess1.workerStats,
    firstLayaServedMs: (() => { const r = ledger1.find((x) => x.tier === 'laya'); return r ? r.at - spawnAt : null; })(),
  };
  const st1 = await host.status({ measure: true });
  result.hostAfterSession1 = st1.ok ? st1.workers.laya : st1;
  write();

  // ---- SESSION 2: a NEW LAIN process — hot prompt, result cache, invalidation, crash ----
  const s2 = path.join(ROOT, 'session2');
  const tty2 = await runTty({
    cwd: work.dest, configDir: s2, env: ENV,
    script: [
      { text: 'MOCKDONE-A' }, { text: 'MOCKDONE-B' },
      { text: 'Editing.', tool_calls: [{ name: 'edit_file', input: { path: 'server/store.js', old: fs.readFileSync(path.join(work.dest, 'server', 'store.js'), 'utf8').split(/\r?\n/)[0], new: '// Workspace settings store: reads and writes data/workspace.json (edited by the hot-idle bench).' } }] },
      { text: 'MOCKDONE-C' }, { text: 'MOCKDONE-D' },
    ],
    steps: [
      { until: 'Ask LAIN', timeout: 60000 },
      { send: `${Q}\r` }, { until: 'MOCKDONE-A', timeout: 60000 },
      { send: `${Q}\r` }, { until: 'MOCKDONE-B', timeout: 60000 },
      { send: 'Update the first comment line of server/store.js.\r' }, { until: 'MOCKDONE-C', timeout: 60000 },
      { send: `${Q}\r` }, { until: 'MOCKDONE-D', timeout: 60000 }, { snap: 'end', settle: 300 },
      // LET THE LAST TURN REACH THE SESSION FILE before the crash, or its ledger row is lost with it.
      { wait: 4000 },
      { hardkill: true },
    ],
    timeoutMs: 4 * 60 * 1000,
  });
  const sess2 = sessionOf(s2);
  const ledger2 = (sess2 && sess2.workerLedger) || [];
  const byTurn = (i) => rowView(ledger2[i]);
  result.session2 = {
    timeouts: tty2.timeouts, hardkilled: tty2.hardkilled,
    cliReadyMs: (tty2.marks.find((m) => m.until === 'Ask LAIN') || {}).at || null,
    hotPrompt: byTurn(0), sameStateAgain: byTurn(1), editTurn: byTurn(2), afterEdit: byTurn(3),
    ledgerRows: ledger2.length,
    workerStats: sess2 && sess2.workerStats,
  };
  await sleep(1500);
  const st2 = await host.status({ measure: true });
  result.hostAfterCrash = st2.ok ? { state: st2.workers.laya.state, loads: st2.workers.laya.loads, pid: st2.workers.laya.pid, residentMB: st2.workers.laya.residentMB, inferences: st2.workers.laya.inferences } : st2;
  write();

  // ---- §56 FAILURE: the Laya process killed, then the whole host ---------------
  const failRun = async (name) => {
    const cfg = path.join(ROOT, name);
    const t0 = Date.now();
    const r = await runCli(['-p', Q], { cwd: work.dest, configDir: cfg, env: ENV, script: [{ text: `MOCKDONE-${name}` }], timeoutMs: 120000 });
    const s = sessionOf(cfg);
    return { exit: r.code, wallMs: Date.now() - t0, finished: /MOCKDONE/.test(r.stdout), locate: rowView(((s && s.workerLedger) || [])[0]) };
  };
  const before = await host.status();
  const layaPid = before.ok && before.workers.laya ? before.workers.laya.pid : null;
  if (layaPid) try { execFileSync('taskkill', ['/PID', String(layaPid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  await sleep(800);
  const afterKill = await host.status();
  result.failure = { workerKilled: { pid: layaPid, stateAfterKill: afterKill.ok ? afterKill.workers.laya.state : null, run: await failRun('fail-worker') } };
  await sleep(500);
  const afterRun = await host.status();
  result.failure.workerKilled.stateAfterRun = afterRun.ok ? { state: afterRun.workers.laya.state, loads: afterRun.workers.laya.loads, recentFailures: afterRun.workers.laya.recentFailures } : afterRun;
  const ep = host.endpoint(HOSTDIR);
  if (ep) try { process.kill(ep.pid); } catch { /* gone */ }
  await sleep(800);
  result.failure.hostKilled = { hostPid: ep && ep.pid, run: await failRun('fail-host') };
  await host.pending();
  await sleep(1000);
  const afterHost = await host.status();
  result.failure.hostKilled.after = afterHost.ok ? { newHostPid: afterHost.pid, state: afterHost.workers.laya && afterHost.workers.laya.state } : afterHost;
  w.stop();
  result.timeline = w.rows.filter((r, i, a) => i === 0 || r.state !== a[i - 1].state || r.pid !== a[i - 1].pid).map((r) => ({ ...r, t: r.t - spawnAt }));
  try { result.hostEvents = fs.readFileSync(path.join(HOSTDIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { result.hostEvents = []; }
  await host.shutdown('bench over');
  write();
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
})().catch((e) => { console.error(e); process.exit(1); });
