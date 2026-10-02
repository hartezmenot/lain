'use strict';

/**
 * PHASE 8.3 PERFORMANCE, IN THE REAL WINDOW — against a large fixture profile:
 * 1,100+ models from an API source and eight backing accounts behind Codex.
 *
 *   Harness startup       the window open and the app shown
 *   MODEL open            the Accounts tab drawn from the fabric index
 *   picker open           the composer's model picker with its rows
 *   Models search         a keystroke to rows, served by the index
 *   Skills open           Discover drawn from the skill index
 *   idle                  Core and the host at rest for 8 s with the tray bound:
 *                         no tray push, no polling, CPU near zero
 *
 * The bounds are guards against regression, not targets; the measurements are
 * written to <configDir>/phase83-perf-real.json and printed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { test } = require('../helpers');

function hostCpuMs(pid) {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

module.exports = async function () {
  await test('PERFORMANCE (8.3): startup, MODEL, picker, search and Skills stay fast on 1,100+ models; idle stays idle with the tray bound', async () => {
    const drv = require('../harness/appdriver');
    const t0 = Date.now();
    const d = await drv.open({ width: 1600, height: 900, script: [] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const m = {};
    const store = require('../../src/fabric/store');
    try {
      await d.until("!document.getElementById('app').hidden", 30000);
      m.harnessStartupMs = Date.now() - t0;
      // WHERE STARTUP GOES (Phase P): Core + host to navigation, the document parsed and run, boot, the first state drawn.
      await d.until("performance.getEntriesByName('lain:first-state').length > 0", 30000);
      const tl = await d.js("(() => { const n = performance.getEntriesByType('navigation')[0] || {}; const at = (k) => { const e = performance.getEntriesByName(k)[0]; return e ? Math.round(e.startTime) : null; }; return { responseEnd: Math.round(n.responseEnd || 0), domInteractive: Math.round(n.domInteractive || 0), boot: at('lain:boot'), shown: at('lain:shown'), firstState: at('lain:first-state'), origin: Math.round(performance.timeOrigin) }; })()");
      m.page = tl; m.toNavigationMs = tl.origin - t0;
      process.stdout.write(`      startup: ${m.toNavigationMs} ms to navigation · document read ${tl.responseEnd} · parsed+run ${tl.domInteractive} · boot ${tl.boot} · shown ${tl.shown} · first state ${tl.firstState} (ms from navigation)\n`);
      const root = d.app._sibling || d.app;
      // EIGHT REAL CODEX ACCOUNTS (an imported pool is metadata now, never capacity), each listing 140 models, and one 1,100-model API.
      const fx = require('../harness/fabricfixtures');
      const rows = Array.from({ length: 80 }, (_, j) => ({ id: `model-${j}`, model: `model-${j}`, displayName: `Model ${j}`, hidden: false, isDefault: false, supportedReasoningEfforts: j % 3 === 0 ? [{ reasoningEffort: 'high', description: '' }, { reasoningEffort: 'xhigh', description: '' }] : [] }));
      await fx.codexAccounts(root, Array.from({ length: 8 }, (_, i) => ({ name: `Account ${i + 1}`, email: `acct${i}@example.com`, models: rows })));
      const conns = {};
      conns['lain:big'] = { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'k', models: Array.from({ length: 1100 }, (_, j) => `vendor-${j % 17}/model-${j}`) };
      root.cfg.connections = { ...(root.cfg.connections || {}), ...conns };
      require('../../src/appcatalog').invalidate();
      root._catMemo = null; root._acctMemo = null;
      // THE WINDOW'S OWN SESSION chooses, through its own route.
      const chose = await d.js("Promise.all([LAIN.api('/api/intel/choose', { lane: 'chat', family: 'codex', model: 'model-1' })]).then((r) => LAIN.poll().then(() => r.map((x) => x.ok)))");
      assert.deepStrictEqual(chose, [true]);

      // MODEL: the Accounts tab, drawn from the index.
      let t = Date.now();
      await d.surface('model');
      await d.until("!!document.querySelector('[data-family=codex]')", 20000);
      m.modelOpenMs = Date.now() - t;
      // THE COMPOSER'S MODEL PICKER — the lane's provider's models, from the index.
      await d.surface('chat');
      await d.until("!!document.querySelector('#composerCells [data-cell=model]')", 15000);
      t = Date.now();
      await d.js("(document.querySelector('#composerCells [data-cell=model]').click(), true)");
      await d.until("document.querySelectorAll('.pop .mrowx').length >= 60", 15000).catch(async (e) => { throw new Error(e.message + ' — ' + JSON.stringify(await d.js("({ pops: Array.from(document.querySelectorAll('.pop')).map((p) => p.innerText.slice(0, 200)), cell: document.querySelector('#composerCells [data-cell=model]').innerText, lane: JSON.stringify((LAIN.state().models || {}).chat || {}).slice(0, 300) })"))); });
      m.pickerOpenMs = Date.now() - t;
      await d.js("(LAIN.closePop && LAIN.closePop(), true)");
      // MODELS SEARCH: from the index, per keystroke.
      const s = await d.js("LAIN.api('/api/intel/search', { query: 'model-7', limit: 50 }).then((r) => ({ ms: r.ms, total: r.total }))");
      m.searchMs = s.ms; m.searchTotal = s.total;
      // SKILLS: Discover from the skill index (no network on open).
      t = Date.now();
      await d.surface('mcp');
      await d.js("(LAIN.mcpView.show('discover'), true)");
      await d.until("!!document.querySelector('[data-skill-results]')", 15000);
      m.skillsOpenMs = Date.now() - t;
      m.models = require('../../src/fabric/index').index(root).modelCount;

      // IDLE, WITH THE TRAY BOUND: nothing pushed, nothing polled.
      const tray = require('../../src/fabric/tray');
      tray.changed(root, { force: true });
      const ipc = require('../../src/harnessapp/ipc');
      const realToHost = ipc.toHost;
      const pushes = [];
      ipc.toHost = (v) => { if (String(v).startsWith('tray:')) pushes.push(v); return realToHost(v); };
      const insp = new (require('inspector').Session)(); insp.connect();
      const post = (m2, p) => new Promise((res, rej) => insp.post(m2, p || {}, (e, r) => (e ? rej(e) : res(r))));
      const hostBefore = hostCpuMs(d.pid);   // (the probe itself is outside the measured window)
      if (process.env.PERF83_PROFILE) { await post('Profiler.enable'); await post('Profiler.start'); }
      const cpu0 = process.cpuUsage(); const w0 = Date.now();
      await new Promise((r) => setTimeout(r, 8000));
      const cpu = process.cpuUsage(cpu0); const wall = Date.now() - w0;
      ipc.toHost = realToHost;
      if (process.env.PERF83_PROFILE) {
        const { profile } = await post('Profiler.stop');
        const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName} ${n.callFrame.url.split(/[\\/]/).slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
        const top = [...self.entries()].filter(([k]) => !/\((idle|program)\)/.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 25);
        for (const [k, v] of top) process.stdout.write(`      ${(v / 1000).toFixed(1)} ms ${k}\n`);
        // THE SHARE OF THE 8.3 CODE: self time in the fabric, the lanes and the account catalog.
        const fabricMs = [...self.entries()].filter(([k]) => /fabric\/|sessionintel|accountcatalog|pagedash/.test(k)).reduce((s, [, v]) => s + v, 0) / 1000;
        m.idleFabricMs = Math.round(fabricMs * 10) / 10;
        m.profiledMs = Math.round(profile.samples.reduce((s, id, i) => (/\((idle|program)\)/.test(byId.get(id).callFrame.functionName) ? s : s + (profile.timeDeltas[i] || 0)), 0) / 100) / 10;
        // WHO CALLS THE HOT LEAVES: the stack of the heaviest samples of each.
        const parent = new Map();
        for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
        const stacks = new Map();
        profile.samples.forEach((id, i) => {
          const n = byId.get(id);
          if (!/existsSync|spawn|readFileUtf8/.test(n.callFrame.functionName)) return;
          const chain = []; let p = id;
          while (p && chain.length < 12) { const x = byId.get(p); if (x.callFrame.url && !/^node:/.test(x.callFrame.url)) chain.push(`${x.callFrame.functionName}@${x.callFrame.url.split(/[\\/]/).slice(-2).join('/')}:${x.callFrame.lineNumber}`); p = parent.get(p); }
          const k = `${n.callFrame.functionName} <- ${chain.slice(0, 6).join(' <- ')}`;
          stacks.set(k, (stacks.get(k) || 0) + (profile.timeDeltas[i] || 0));
        });
        for (const [k, v] of [...stacks.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) process.stdout.write(`      STACK ${(v / 1000).toFixed(1)} ms ${k}\n`);
      }
      const hostAfter = hostCpuMs(d.pid);
      m.idleCorePct = Math.round(((cpu.user + cpu.system) / 1000 / wall) * 10000) / 100;
      m.idleHostPct = hostBefore != null && hostAfter != null ? Math.round(((hostAfter - hostBefore) / wall) * 10000) / 100 : null;
      m.idleTrayPushes = pushes.length;
      m.coreWorkingSetMB = Math.round(process.memoryUsage().rss / 1048576);

      fs.writeFileSync(path.join(require('../../src/config').configDir(), 'phase83-perf-real.json'), JSON.stringify(m, null, 1));
      process.stdout.write(`    ${JSON.stringify(m)}\n`);
      assert.ok(m.models >= 1100, `models: ${m.models}`);
      assert.ok(m.modelOpenMs < 3000, `MODEL open ${m.modelOpenMs} ms`);
      assert.ok(m.pickerOpenMs < 1500, `picker open ${m.pickerOpenMs} ms`);
      assert.ok(m.searchMs < 50, `search ${m.searchMs} ms`);
      assert.ok(m.skillsOpenMs < 3000, `Skills open ${m.skillsOpenMs} ms`);
      assert.strictEqual(m.idleTrayPushes, 0, 'no tray push while nothing changes');
      // IN THIS TEST the Core process also carries the CDP attachment and the test's own timers; the bound guards
      // against a regression (a poll that starts re-building catalogs), not against that overhead.
      assert.ok(m.idleCorePct < 6, `idle Core CPU ${m.idleCorePct}% (the renderer's poll answers and the test's CDP attachment included)`);
      assert.ok(m.idleHostPct == null || m.idleHostPct < 2, `idle host CPU ${m.idleHostPct}%`);
    } finally {
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
      try { await require('../harness/fabricfixtures').reset(); } catch { /* none running */ }
      try { fs.unlinkSync(store.file()); } catch { /* none */ }
      store.reset();
    }
  });
};
