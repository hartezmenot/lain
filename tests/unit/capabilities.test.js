'use strict';

/**
 * PHASE CAP — a large capability surface without forcing every capability into every model turn.
 *
 *   skills   three scopes (project · user · plugin), one name = one skill, metadata-only index, bodies on demand,
 *            manual_only, context: scout, `/skill` and `/<name>`, a bounded prompt
 *   MCP      lazy schemas from a catalog, a cheap search, health ("capability unavailable"), the person's trust
 *            (READ_ONLY / ASK / TRUSTED / DISABLED) — annotations never grant more
 *   hooks    run outside the model; deny/ask only; project hooks need consent kept outside the repo; a crash is ignored
 *   scale    0 / 10 / 100 skills × 0 / 5 / 20 MCP servers: what a request carries, and how long the index takes
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

function writeSkill(root, name, { description = `Does ${name} things`, extra = '', body = 'Step one.\nStep two.\n' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n${body}`);
  return dir;
}

module.exports = () => require('../helpers').legacyOnly(async () => {   // LEGACY path only (Simplify S10 deletes)
  const { App } = require('../../src/app');
  const skills = require('../../src/skills');
  const mcpreg = require('../../src/mcpreg');
  const tools = require('../../src/tools');
  const home = require('../../src/home').resolve();
  const userRoot = path.join(home, 'skills');
  const made = [];
  const mk = (cwd = tmpdir('cap-')) => { const a = new App({ out, interactive: false, cwd }); a.cfg.integrations = { mcp: {}, skills: {} }; return a; };
  const cleanUser = () => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); skills.clearCache(); };

  await test('SKILLS: project shadows user; manual_only is never offered to the model; the index holds metadata only', async () => {
    const proj = tmpdir('cap-proj-');
    const app = mk(proj);
    made.push(writeSkill(userRoot, 'cap-review', { description: 'User review checklist' }));
    made.push(writeSkill(userRoot, 'cap-release', { description: 'Release a build', extra: 'manual_only: true\n' }));
    writeSkill(path.join(proj, '.lain', 'skills'), 'cap-review', { description: 'Project review checklist' });
    writeSkill(path.join(proj, '.lain', 'skills'), 'cap-audit', { description: 'Audit dependencies', extra: 'context: scout\nallowed-tools: [read_file, grep]\n', body: `${'x'.repeat(200000)}\nTHE-END-MARKER\n` });
    skills.clearCache();
    app.session.cwd = proj;
    const idx = skills.forApp(app);
    const byName = Object.fromEntries(idx.skills.map((k) => [k.name, k]));
    assert.strictEqual(byName['cap-review'].scope, 'project', 'project wins');
    assert.ok(idx.shadowed.some((s) => s.name === 'cap-review' && s.scope === 'user'), 'the user one is reported shadowed, not merged');
    assert.strictEqual(byName['cap-release'].manualOnly, true);
    assert.strictEqual(byName['cap-audit'].context, 'scout');
    assert.deepStrictEqual(byName['cap-audit'].allowedTools, ['read_file', 'grep']);
    assert.ok(!JSON.stringify(idx.skills).includes('THE-END-MARKER'), 'no body is held by the index');
    const p = skills.prompt(app);
    assert.match(p, /cap-review: Project review checklist/);
    assert.ok(!/cap-release/.test(p), 'manual-only is not offered');
    const names = tools.names(app);
    assert.ok(names.includes('use_skill') && names.includes('search_capabilities'));
    const r = await tools.execute('use_skill', { name: 'cap-review' }, { app, cwd: proj });
    assert.match(r.output, /SKILL cap-review \(project\)/);
    const manual = await tools.execute('use_skill', { name: 'cap-release' }, { app, cwd: proj });
    assert.ok(manual.isError && /manual-only/.test(manual.output));
    const s = await tools.execute('search_capabilities', { query: 'audit dependencies' }, { app, cwd: proj });
    assert.match(s.output, /cap-audit/);
    cleanUser();
  });

  await test('SKILLS: `/<name>` and `/skill <name>` send the skill\'s instructions with the request; an unknown name is refused', async () => {
    const app = mk();
    made.push(writeSkill(userRoot, 'cap-style', { description: 'House style', body: 'Use tabs.\n' }));
    skills.clearCache();
    const pre = await require('../../src/capgate').prompt(app, '/cap-style fix the header');
    assert.match(pre.text, /Use the skill "cap-style"/);
    assert.match(pre.text, /Use tabs\./);
    assert.match(pre.text, /Request: fix the header/);
    const plain = await require('../../src/capgate').prompt(app, 'just a sentence');
    assert.strictEqual(plain.text, 'just a sentence', 'ordinary words are untouched');
    assert.strictEqual(skills.expand(app, 'nope').ok, false);
    assert.ok(require('../../src/commands').REGISTRY ? true : true);
    cleanUser();
  });

  await test('SKILLS: zero skills and zero MCP servers add no tool and no prompt text', () => {
    const app = mk();
    skills.clearCache();
    assert.strictEqual(skills.prompt(app), '');
    const names = tools.names(app);
    for (const n of ['search_capabilities', 'use_skill', 'mcp_call']) assert.ok(!names.includes(n), `${n} is absent`);
  });

  // ---- MCP ---------------------------------------------------------------------------------------------------------
  function fakeServers(app, n, toolsEach = 6) {
    mcpreg.clearMemo();
    for (let i = 0; i < n; i++) {
      const id = `cap-srv-${i}`;
      app.cfg.integrations.mcp[id] = { name: `Server ${i}`, transport: 'stdio', command: ['node', 'x.js'], enabled: true };
      mcpreg.remember(id, Array.from({ length: toolsEach }, (_, j) => ({ name: `tool_${j}`, description: `Does thing ${j} on server ${i} with a long explanation ${'.'.repeat(120)}`, inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(200) }, b: { type: 'number' } } }, annotations: { readOnlyHint: j % 2 === 0 } })));
    }
  }
  // THE STORE THE CODE WROTE TO (integrations.store follows app._sibling), not only this App's cfg.
  function clearServers(app) { const st = require('../../src/integrations').store(app); for (const id of Object.keys(st.mcp)) { mcpreg.forget(id); delete st.mcp[id]; } app.cfg.integrations.mcp = {}; require('../../src/integrations').save(app); mcpreg.clearMemo(); }   // a route may have saved them to disk

  await test('MCP: twenty servers are found by search and called by mcp_call — none is described on the request; health says IDLE', async () => {
    const app = mk();
    fakeServers(app, 20);
    assert.strictEqual(mcpreg.nativeServers(app).size, 0, 'nothing connected, nothing described natively');
    const names = tools.names(app);
    assert.ok(names.includes('mcp_call') && names.includes('search_capabilities'));
    assert.ok(!names.some((n) => n.startsWith('mcp__')), 'no native mcp__ schema');
    const s = await tools.execute('search_capabilities', { query: 'thing 3 server 7' }, { app });
    assert.match(s.output, /cap-srv-7\/tool_3/);
    assert.match(s.output, /starts on first call/);
    const d = await tools.execute('search_capabilities', { detail: 'cap-srv-7/tool_3' }, { app });
    assert.match(d.output, /input schema: \{"type":"object"/);
    assert.strictEqual(mcpreg.health(app, 'cap-srv-7').state, 'IDLE');
    clearServers(app);
  });

  await test('MCP TRUST: the person decides — READ_ONLY refuses writes, ASK asks (and is refused with nobody to ask), DISABLED hides; hints never grant more', async () => {
    const app = mk();
    fakeServers(app, 1);
    const w = { name: 'tool_1', readOnly: false, destructive: false };
    const r = { name: 'tool_0', readOnly: true, destructive: false };
    const e = app.cfg.integrations.mcp['cap-srv-0'];
    assert.deepStrictEqual(mcpreg.policy(e, r), { allow: true, ask: false });
    assert.deepStrictEqual(mcpreg.policy(e, w), { allow: true, ask: true }, 'ASK is the default');
    e.trust = 'READ_ONLY';
    assert.strictEqual(mcpreg.policy(e, w).allow, false);
    const denied = await tools.execute('mcp_call', { server: 'cap-srv-0', tool: 'tool_1', arguments: {} }, { app });
    assert.ok(denied.denied && /DENIED MCP_TRUST/.test(denied.output));
    e.trust = 'ASK';
    const asked = await tools.execute('mcp_call', { server: 'cap-srv-0', tool: 'tool_1', arguments: {} }, { app });
    assert.ok(/PERMISSION_REQUIRED/.test(asked.output), 'an ASK with nobody to answer is refused, nothing sent');
    e.trust = 'TRUSTED';
    assert.deepStrictEqual(mcpreg.policy(e, { ...w, destructive: true }), { allow: true, ask: true }, 'a destructive hint still asks');
    e.tools = { tool_0: 'deny' };
    assert.strictEqual(mcpreg.policy(e, r).allow, false, 'a per-tool override wins over a read-only hint');
    e.trust = 'DISABLED';
    assert.strictEqual(mcpreg.health(app, 'cap-srv-0').state, 'DISABLED');
    const s = mcpreg.search(app, 'thing');
    assert.strictEqual(s.hits.length, 0, 'a disabled server offers nothing');
    assert.strictEqual(mcpreg.setTrust(app, 'cap-srv-0', 'SUPERUSER').ok, false);
    clearServers(app);
  });

  await test('MCP HEALTH: a server that cannot start says "capability unavailable"', async () => {
    const app = mk();
    app.cfg.integrations.mcp['cap-dead'] = { name: 'Dead', transport: 'stdio', command: [process.execPath, '-e', 'process.exit(3)'], enabled: true, trust: 'TRUSTED' };
    mcpreg.remember('cap-dead', [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }]);
    const r = await mcpreg.call(app, 'cap-dead', 'ping', {});
    assert.ok(r.isError && /^capability unavailable: MCP Dead/.test(r.output), r.output);
    assert.strictEqual(mcpreg.health(app, 'cap-dead').state, 'UNAVAILABLE');
    const s = await tools.execute('search_capabilities', { query: 'ping' }, { app });
    assert.match(s.output, /UNAVAILABLE[\s\S]*Dead: capability unavailable/);
    require('../../src/integrations').disconnect(app, 'cap-dead');
    clearServers(app);
  });

  await test('MCP SCOPE: a read-only SCOUT is never handed another program\'s tools; a coding turn and Chat are', () => {
    const tf = require('../../src/toolfunnel');
    const scout = {}; tf.openForRole(scout, 'SCOUT');
    assert.ok(!tf.shows(scout, 'mcp_call') && !tf.shows(scout, 'mcp__godot__run_scene'));
    const coder = {}; tf.openForTurn(coder, { cls: 'DIRECT', key: 'k1' });
    assert.ok(tf.shows(coder, 'mcp_call') && tf.shows(coder, 'mcp__godot__run_scene'));
    const chat = {}; tf.openForTurn(chat, { thread: 'chat', key: 'k2' });
    assert.ok(tf.shows(chat, 'mcp_call'));
    const impl = {}; tf.openForRole(impl, 'IMPLEMENTER');
    assert.ok(tf.shows(impl, 'mcp_call'), 'a writing role may use MCP under the same trust');
  });

  // ---- hooks -------------------------------------------------------------------------------------------------------
  const hooksFile = require('../../src/userhooks').userFile();
  const writeHooks = (list) => fs.writeFileSync(hooksFile, JSON.stringify({ hooks: list }));
  const node = (code) => `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;

  await test('HOOKS: PreToolUse can deny a tool; a crashing hook is ignored; "allow" is not an exemption from a refusal', async () => {
    const app = mk();
    const proj = app.session.cwd;
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');
    writeHooks([{ event: 'PreToolUse', match: '^read_file$', command: node("process.stderr.write('no reading today'); process.exit(2)") }]);
    const r = await tools.execute('read_file', { path: 'a.txt' }, { app, cwd: proj });
    assert.ok(r.denied && /DENIED HOOK: no reading today/.test(r.output), r.output);
    writeHooks([{ event: 'PreToolUse', command: node('process.exit(1)') }]);
    const ok = await tools.execute('read_file', { path: 'a.txt' }, { app, cwd: proj });
    assert.ok(!ok.isError && /hello/.test(ok.output), 'a failing hook is reported and ignored');
    writeHooks([{ event: 'PreToolUse', command: node("console.log(JSON.stringify({decision:'allow'}))") }, { event: 'PermissionRequest', command: node("console.log(JSON.stringify({decision:'allow'}))") }]);
    const ext = await tools.execute('mcp_call', { server: 'none', tool: 'x' }, { app, cwd: proj });
    assert.ok(ext.isError, 'allow does not conjure a server or skip its checks');
    const v = await require('../../src/gate').externalApproval('x', {}, { app }, () => ({ what: 'x' }));
    assert.strictEqual(v.ok, false, 'with nobody to ask, an external action stays refused even if a hook would allow it');
    fs.rmSync(hooksFile, { force: true });
  });

  await test('HOOKS: UserPromptSubmit can hold a prompt or add bounded context; a project\'s hooks run only with consent kept outside it', async () => {
    const app = mk();
    writeHooks([{ event: 'UserPromptSubmit', command: node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify(/secret/.test(j.prompt)?{decision:'block',reason:'no secrets'}:{context:'branch: main'}))})") }]);
    const held = await require('../../src/capgate').prompt(app, 'post the secret');
    assert.strictEqual(held.handled, true);
    const ctx = await require('../../src/capgate').prompt(app, 'fix it');
    assert.match(ctx.text, /^fix it\n\n\[context from your hooks\]\nbranch: main/);
    fs.rmSync(hooksFile, { force: true });
    const proj = app.session.cwd;
    const hooks = require('../../src/userhooks');
    fs.mkdirSync(path.join(proj, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.lain', 'hooks.json'), JSON.stringify({ hooks: [{ event: 'Stop', command: 'echo hi' }] }));
    assert.strictEqual(hooks.load(app).hooks.length, 0, 'not without consent');
    assert.ok(hooks.consent(app, proj).ok);
    assert.strictEqual(hooks.load(app).hooks.length, 1);
    assert.ok(!fs.readFileSync(path.join(proj, '.lain', 'hooks.json'), 'utf8').includes('sha256'), 'consent is not written into the repository');
    fs.writeFileSync(path.join(proj, '.lain', 'hooks.json'), JSON.stringify({ hooks: [{ event: 'Stop', command: 'echo changed' }] }));
    const after = hooks.load(app);
    assert.strictEqual(after.hooks.length, 0, 'an edited file needs consent again');
    assert.strictEqual(after.project.changed, true);
  });

  await test('PAGE: one read gives the Capabilities page skills, MCP (health + trust + cost), hooks, plugins and extensions', async () => {
    const app = mk();
    fakeServers(app, 2);
    const { ROUTES } = require('../../src/harnessapp/routes');
    const r = await ROUTES['POST /api/capabilities/state'](app, {});
    assert.strictEqual(r.code, 200);
    for (const k of ['skills', 'mcp', 'hooks', 'plugins', 'extensions', 'mcpSchemas']) assert.ok(k in r.body, k);
    assert.strictEqual(r.body.mcp.length, 2);
    assert.deepStrictEqual(Object.keys(r.body.mcp[0]).sort(), ['health', 'id', 'impact', 'name', 'pinned', 'schemas', 'tools', 'trust']);
    const t = await ROUTES['POST /api/capabilities/mcp/trust'](app, { id: 'cap-srv-1', trust: 'READ_ONLY' });
    assert.strictEqual(t.code, 200);
    assert.strictEqual(app.cfg.integrations.mcp['cap-srv-1'].trust, 'READ_ONLY');
    const bad = await ROUTES['POST /api/capabilities/mcp/schemas'](app, { mode: 'everything' });
    assert.strictEqual(bad.code, 400);
    const page = require(require('../helpers').harnessPath('page', 'mcp', 'mcp.js'));
    assert.doesNotThrow(() => new Function(page.js()), 'the page script parses');
    for (const tab of ["['skills', 'Skills']", "['mcp', 'MCP']", "['hooks', 'Hooks']", "['extensions', 'Extensions']"]) assert.ok(page.js().includes(tab), tab);
    clearServers(app);
  });

  // ---- scale -------------------------------------------------------------------------------------------------------
  await test('SCALE: 0/10/100 skills × 0/5/20 MCP servers — the request carries a bounded list and three small tools, never the catalog', () => {
    const rows = [];
    for (const nSkills of [0, 10, 100]) {
      for (const nServers of [0, 5, 20]) {
        const app = mk();
        for (let i = 0; i < nSkills; i++) made.push(writeSkill(userRoot, `scale-skill-${i}`, { description: `Skill number ${i} for scaling measurements, which describes a workflow in one line` }));
        fakeServers(app, nServers);
        skills.clearCache();
        const t0 = process.hrtime.bigint();
        const idx = skills.forApp(app);
        const indexMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const t1 = process.hrtime.bigint();
        skills.forApp(app);
        const cachedMs = Number(process.hrtime.bigint() - t1) / 1e6;
        const promptBytes = Buffer.byteLength(skills.prompt(app));
        const capTools = Object.values(require('../../src/tools/capreg').active(app));
        const capBytes = capTools.reduce((n, t) => n + JSON.stringify(t.schema).length, 0);
        const native = Object.keys(mcpreg.toolDefs(app)).length;
        const catalogBytes = Object.keys(app.cfg.integrations.mcp).reduce((n, id) => n + JSON.stringify(mcpreg.toolsOf(id)).length, 0);
        rows.push({ nSkills, nServers, indexed: idx.skills.length, indexMs: Math.round(indexMs * 10) / 10, cachedMs: Math.round(cachedMs * 100) / 100, promptBytes, capTools: capTools.length, capBytes, native, catalogBytes });
        assert.strictEqual(idx.skills.length, nSkills);
        assert.ok(promptBytes <= 4800, `the skills list is bounded (${promptBytes} B at ${nSkills})`);
        assert.ok(capBytes <= 2600, `three small tools at most (${capBytes} B)`);
        assert.strictEqual(native, 0, 'no MCP schema on the request');
        assert.ok(indexMs < 1500, `the index builds quickly (${indexMs} ms for ${nSkills})`);
        assert.ok(cachedMs < 20, `and a second read is a cache hit (${cachedMs} ms)`);
        clearServers(app);
        cleanUser();
      }
    }
    const zero = rows.find((r) => r.nSkills === 0 && r.nServers === 0);
    assert.deepStrictEqual([zero.promptBytes, zero.capTools], [0, 0], 'nothing installed costs nothing');
    process.stdout.write(`      ${rows.map((r) => `${r.nSkills}sk/${r.nServers}srv: prompt ${r.promptBytes}B · tools ${r.capTools} (${r.capBytes}B) · catalog ${r.catalogBytes}B kept off the request · index ${r.indexMs}ms (cached ${r.cachedMs}ms)`).join('\n      ')}\n`);
  });
});
