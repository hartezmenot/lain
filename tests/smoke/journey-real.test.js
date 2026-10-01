'use strict';

/**
 * THE SESSION JOURNEY, DRIVEN THROUGH THE REAL WINDOW (native host + WebView2, the
 * mock model, an isolated profile — tests/harness/appdriver.js).
 *
 *   PHASE 8: the IDE's right side IS the Coding Agent (no BOT/AGENT sub-tabs);
 *   questions go to the sidecar's Chat tab (the same session's Chat lane).
 *   The ⚙ popover stays at the gear through resizes and display scales, its
 *   nested chooser opens beside it, and nothing lands in the upper-left corner;
 *   the Agent sidecar changes code directly; the person's hand edit and the
 *   Agent's edit are told apart; Chat's Coding Agent lane continues the same
 *   session and "Open in IDE" shows it; the Assistant opens Settings › MCP
 *   through a house door.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

function fixture(isolation) {
  const root = isolation.tmp('journeyreal-');
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('package.json', '{"name":"demo"}\n');
  w('src/ui/button.js', "'use strict';\nconst fixButton = { label: 'Fix', key: 'fix_button' };\nfunction render() { return fixButton.label; }\nmodule.exports = { fixButton, render };\n");
  w('src/ui/actions.js', "const { fixButton } = require('./button');\nmodule.exports = () => fixButton.key;\n");
  w('src/unrelated.js', 'const other = 1;\nmodule.exports = other;\n');
  return root;
}

// THE MODEL, BY CONTENT. A Coding Agent turn may make a closing request after
// its answer (the completion check) or may not, so a strictly ordered script
// drifts by one. This answers the person's latest message instead: its first
// step, and after a tool result, that turn's final answer.
const TURNS = [
  [/what does this function do/i, { text: 'render() returns the button label.' }, null],
  [/Rename fixButton/i, { text: 'Renaming.', tool_calls: [{ name: 'rename_symbol', input: { from: 'fixButton', to: 'ButtonFix' } }] }, { text: 'Renamed fixButton to ButtonFix; "fix_button" kept.' }],
  [/Rename other/i, { text: 'Renaming in unrelated.js.', tool_calls: [{ name: 'rename_symbol', input: { from: 'other', to: 'otherValue', include: 'src/unrelated.js' } }] }, { text: 'Done in src/unrelated.js.' }],
  [/open the MCP settings/i, { text: 'Opening.', tool_calls: [{ name: 'lain_workspace', input: { action: 'do', id: 'settings.open_mcp' } }] }, { text: 'MCP settings are open.' }],
];
function responder() {
  return async function* chat(pc, messages) {
    const real = (messages || []).filter((m) => m && !m._live);
    const lastUser = real.filter((m) => m.role === 'user').slice(-1)[0];
    const last = real[real.length - 1];
    const text = String((lastUser && lastUser.content) || '');
    const turn = TURNS.find(([re]) => re.test(text));
    const step = !turn ? { text: 'Nothing further to do.' } : (last && last.role === 'tool' ? (turn[2] || { text: 'Done.' }) : turn[1]);
    for (const part of step.text.match(/\S+\s*|\s+/g) || [step.text]) yield { type: 'text', chunk: part };
    if (step.tool_calls) yield { type: 'tool_calls', calls: step.tool_calls.map((c, i) => ({ id: `journey_${Date.now()}_${i}`, name: c.name, input: c.input })) };
    yield { type: 'usage', inputTokens: 100, outputTokens: 20 };
  };
}

module.exports = async function () {
  await test('JOURNEY REAL UI: anchored popover, Agent sidecar, floating Assistant, provenance, Chat Coding lane → IDE, house doors', async () => {
    const drv = require('../harness/appdriver');
    const isolation = require('../harness/isolation');
    const root = fixture(isolation);
    const mp = require('../../src/mockprovider');
    const realChat = mp.chat;
    mp.chat = responder();
    const d = await drv.open({ cwd: root, script: [], width: 1400, height: 880 });
    if (d.skipped) mp.chat = realChat;
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const errors = [];
    await d.page.conn.send('Runtime.enable');
    d.page.conn.on((m, p) => { if (m === 'Runtime.exceptionThrown') errors.push(JSON.stringify(p.exceptionDetails).slice(0, 300)); });
    const rect = (sel) => d.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, side: e.dataset.side || '' }; })()`);
    const anchored = async () => {
      const g = await rect('#composerCells [data-route-pill]'); const p = await rect('#pop');
      assert.ok(g && p, 'route pill and popover');
      assert.ok(!(p.l <= 10 && p.t <= 10), `never the corner: ${JSON.stringify(p)}`);
      assert.ok(p.l >= 0 && p.t >= 0 && p.r <= p.vw && p.b <= p.vh, `inside the window: ${JSON.stringify(p)}`);
      assert.ok((p.b <= g.t + 1 && g.t - p.b <= 12) || (p.t >= g.b - 1 && p.t - g.b <= 12), `touching the gear: ${JSON.stringify({ g, p })}`);
    };
    const pointer = async (x, y) => {
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    let allowing = true;
    (async () => {
      while (allowing) {
        try { await d.js("(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /Allow just this one/.test(x.textContent) && x.offsetParent); if (b) b.click(); return true; })()"); } catch { /* busy */ }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
    try {
      await d.until("!document.getElementById('app').hidden");
      await d.js(`LAIN.ide.open(${JSON.stringify(root)})`);
      await d.until("!document.getElementById('main').hidden && !!document.querySelector('#ideBotHost #composerCells [data-route-pill]')", 30000);
      await d.js("LAIN.source.openFile('src/ui/button.js')");
      await d.until("!!(LAIN.editor.editor() && LAIN.editor.editor().getModel() && /fixButton/.test(LAIN.editor.editor().getValue()))", 30000);

      // THE ROUTE PILL (2026-09-30 composer) — its picker anchored at the pill, surviving resize and display scaling.
      await d.click('#composerCells [data-route-pill]');
      await d.until("document.getElementById('pop')");
      await anchored();
      // THE IDE SIDECAR'S AGENT TAB IS THE CODING AGENT: its provider picker; no website source here (ChatGPT Chat is CHAT ONLY).
      const pickText = await d.js("document.getElementById('pop').innerText");
      assert.ok(/Coding Agent/i.test(pickText) && !/ChatGPT Chat|Website sessions/i.test(pickText), `the Coding Agent's own picker; no website source in the IDE: ${pickText.slice(0, 200)}`);
      await d.press('Escape');
      // THE MODE MENU, and a chooser opened FROM it: the next level opens BESIDE it, and Escape closes one level.
      // (The popover stack is one mechanism — L.popover — whatever the chooser is.)
      await d.click('#composerCells [data-cell=exec]');
      await d.until("document.getElementById('pop') && /Run strategy/i.test(document.getElementById('pop').innerText)", 8000);
      await d.js("(() => { const a = document.querySelector('#pop .opt'); LAIN.popover(a, (p) => { p.appendChild(document.createTextNode('nested chooser')); }); return true; })()");
      await d.until("document.getElementById('pop-1') && document.getElementById('pop')", 8000);
      const n = await rect('#pop-1'); const p0 = await rect('#pop');
      assert.strictEqual(n.side, 'beside');
      assert.ok(n.r <= p0.l + 1 || n.l >= p0.r - 1, 'the nested chooser sits beside its parent');
      await d.press('Escape');
      assert.ok(await d.js("!document.getElementById('pop-1') && !!document.getElementById('pop')"), 'Escape closes one level');
      await d.press('Escape');
      await d.click('#composerCells [data-route-pill]');
      await d.until("document.getElementById('pop')");
      for (const [w, h, s] of [[1100, 760, 1], [1280, 800, 1.5], [1400, 900, 2], [960, 640, 1]]) {
        await d.page.conn.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: s, mobile: false });
        await new Promise((r) => setTimeout(r, 450));
        await anchored();
      }
      await d.page.conn.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 880, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 400));
      const ea = await rect('#editorArea');
      await pointer(ea.l + 200, ea.t + 300);
      await d.until("!document.getElementById('pop')", 3000);

      // A manual edit, saved: the person's.
      await d.js("(() => { const ed = LAIN.editor.editor(); const M = LAIN.editor.monaco(); ed.executeEdits('person', [{ range: new M.Range(3, 1, 3, 1), text: '// by hand\\n' }]); return true; })()");
      await d.js('LAIN.source.save()');
      await d.until('!LAIN.source.current().dirty', 10000);

      // A QUESTION goes to the sidecar's Chat tab (the Chat lane) — never into the Agent's work.
      await d.js("document.querySelector('#sideTabs [data-seg=chat]').click()");
      await d.until("document.getElementById('ideBot').getAttribute('data-side') === 'chat'", 5000);
      await d.type('#ask', 'what does this function do?');
      await d.click('#send');
      await d.until("document.getElementById('stream').innerText.includes('returns the button label')", 30000);
      await d.until("LAIN.state().header.status.state !== 'RUNNING'", 30000);
      await d.js("document.querySelector('#sideTabs [data-seg=agent]').click()");
      await d.until("document.getElementById('ideBot').getAttribute('data-side') === 'agent'", 5000);
      await d.until("!document.getElementById('stream').innerText.includes('returns the button label')", 8000).catch(() => { throw new Error('the Agent tab is not the conversation'); });

      // A CODE CHANGE in the Agent sidecar runs directly — the IDE's Agent is the Agent.
      await d.type('#ask', 'Rename fixButton to ButtonFix everywhere.');
      await d.click('#send');
      assert.strictEqual(await d.js("document.querySelectorAll('#tabs .gtab').length"), 7, 'HOME IDE CHAT MODEL USAGE MCP & SKILLS SETTINGS — AGENT is not a global tab');
      const renamed = () => { try { return /const ButtonFix/.test(fs.readFileSync(path.join(root, 'src/ui/button.js'), 'utf8')); } catch { return false; } };
      const t1 = Date.now() + 60000;
      while (!renamed() && Date.now() < t1) await new Promise((r) => setTimeout(r, 300));
      await d.until("LAIN.state().header.status.state !== 'RUNNING' && !(LAIN.state().workbench && LAIN.state().workbench.running)", 60000);
      const btn = fs.readFileSync(path.join(root, 'src/ui/button.js'), 'utf8');
      assert.ok(/const ButtonFix/.test(btn) && /'fix_button'/.test(btn) && /by hand/.test(btn), btn);
      assert.ok(/ButtonFix\.key/.test(fs.readFileSync(path.join(root, 'src/ui/actions.js'), 'utf8')));
      const prov = await d.js("LAIN.api('/api/provenance/file', { path: 'src/ui/button.js' })");
      const kinds = (prov.regions || []).map((g) => g.source);
      assert.ok(kinds.includes('USER') && kinds.includes('AGENT'), JSON.stringify(prov.regions));
      const sessionId = await d.js('LAIN.state().current.id');

      // CHAT'S CODING AGENT LANE is the same session; "Open in IDE" shows it.
      await d.surface('chat');
      await d.js("LAIN.chat.lane('agent')");
      await d.until("document.getElementById('laneAgent').getAttribute('aria-selected') === 'true'", 10000);
      await d.type('#ask', 'Rename other to otherValue in src/unrelated.js');
      await d.click('#send');
      await d.until("document.getElementById('stream').innerText.includes('Done in src/unrelated.js')", 60000);
      await d.until("LAIN.state().header.status.state !== 'RUNNING' && !(LAIN.state().workbench && LAIN.state().workbench.running)", 60000);
      assert.strictEqual(await d.js('LAIN.state().current.id'), sessionId, 'one canonical session for Chat, the Agent and the IDE');
      await d.js('LAIN.ide.openTask()');
      await d.until("LAIN.nav.tab() === 'ide'", 15000);
      assert.strictEqual(await d.js('LAIN.state().current.id'), sessionId, 'the IDE shows the same session');

      // THE CHAT TAB walks through a house door.
      await d.js("document.querySelector('#sideTabs [data-seg=chat]').click()");
      await d.until("document.getElementById('ideBot').getAttribute('data-side') === 'chat'", 5000);
      await d.type('#ask', 'open the MCP settings');
      await d.click('#send');
      // (Phase 8.1: MCP & Skills is its own surface — the house door opens it.)
      await d.until("LAIN.nav.tab() === 'mcp'", 30000).catch(async (e) => {
        throw new Error(`${e.message} :: ${await d.js("JSON.stringify({ nav: LAIN.state().navigate, st: LAIN.state().header.status, notice: document.getElementById('notice').textContent, tail: document.getElementById('stream').innerText.slice(-300) })")}`);
      });
      assert.strictEqual((await d.js('LAIN.state().navigate')).capability, 'settings.open_mcp');
      // SESSION (inside Chat now) records one working session and its path.
      await d.js("LAIN.nav.go('session')");
      await d.until("/What happened/i.test(document.getElementById('sessPane').innerText) && /Path/.test(document.getElementById('sessPane').innerText)", 10000);
      const sess = await d.js("document.getElementById('sessPane').innerText");
      const pathKinds = (await d.js('LAIN.state().journey.path')).map((e) => e.kind);
      assert.ok(pathKinds.includes('user.edit') && pathKinds.includes('agent.start'), JSON.stringify(pathKinds));
      assert.ok(/Rename other|Rename fixButton/.test(sess), `the Agent task names the work, not the Assistant's question: ${sess.slice(0, 400)}`);
      assert.deepStrictEqual(errors, [], 'no page exceptions');
    } finally {
      allowing = false;
      mp.chat = realChat;
      await d.close();
    }
  });
};
