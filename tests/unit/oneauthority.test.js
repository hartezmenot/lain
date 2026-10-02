'use strict';

/**
 * ONE AUTHORITY FOR EVERY SHARED TRUTH (2026-09-25).
 *
 * Harness-side code inside Core had grown a partial second spine: its own
 * writes around the mutation transaction, its own classifier, a second model
 * request path, three selection resolvers, scattered generation bumps, two UI
 * → source mappings and four handoff records. Each was consolidated into the
 * Core owner that already existed. These guards keep it that way — some by
 * running the real path, some by reading the source.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function filesUnder(rel) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) out.push(path.relative(SRC, p).split(path.sep).join('/')); } };
  walk(path.join(SRC, rel));
  return out;
}
function grepSrc(re) {
  return filesUnder('.').filter((f) => re.test(code(f)));
}

module.exports = async function () {
  const root = isolation.tmp('authority-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nmodule.exports = a;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'const b = 2;\n');
  const { Session } = require('../../src/session');
  const session = new Session({ id: 'authority', cwd: root });
  require('../../src/sessionviews').views(session).project = { attached: true, attachedAt: new Date().toISOString() };
  const events = [];
  const app = { session, ui: null, checkpoints: null, events: { emit: (name, e) => events.push({ name, ...e }) } };
  const req = async (p, body) => (await require('../../src/harnessapp/routes').dispatch(app, 'POST', p, body)).body;
  const hc = require('../../src/harnesscontext');
  const ledger = require('../../src/editledger');
  const gen = () => require('../../src/projectgen').current(root).n;

  await test('ONE AUTHORITY · MUTATION: a manual save crosses the one transaction — actor USER, one generation, one delta', async () => {
    const g0 = gen();
    const o = await req('/api/files/open', { path: 'src/a.js' });
    const r = await req('/api/files/save', { path: 'src/a.js', body: `${o.body}// by hand\n`, hash: o.hash });
    assert.ok(r.ok, r.why);
    assert.strictEqual(gen(), g0 + 1, 'the project generation advanced exactly once');
    const rec = session.mutationReceipts[session.mutationReceipts.length - 1];
    assert.ok(rec && rec.actor === 'USER' && rec.verdict === 'KEEP', JSON.stringify(rec));
    assert.strictEqual(ledger.entries(root, { rel: 'src/a.js' }).pop().source, 'USER', 'provenance says the person, not the Agent');
    const d = events.filter((e) => e.name === 'project.delta').pop();
    assert.ok(d && d.actor === 'USER' && d.files.includes('src/a.js'), JSON.stringify(d));
  });

  await test('ONE AUTHORITY · MUTATION: create, move, replace and delete from the IDE are the same transaction', async () => {
    const before = session.mutationReceipts.length;
    assert.ok((await req('/api/files/create', { path: 'src/c.js', body: 'x\n' })).ok);
    assert.ok((await req('/api/files/rename', { from: 'src/c.js', to: 'src/d.js' })).ok);
    const found = await req('/api/files/search', { query: 'const b' });
    assert.ok((await req('/api/files/replace', { query: 'const b', replacement: 'const bb', files: found.files })).ok);
    assert.ok((await req('/api/files/delete', { path: 'src/d.js' })).ok);
    const recs = session.mutationReceipts.slice(before);
    assert.deepStrictEqual(recs.map((r) => r.tool), ['ide.create_file', 'ide.move', 'ide.replace', 'ide.delete']);
    assert.ok(recs.every((r) => r.actor === 'USER'));
    assert.strictEqual(ledger.entries(root, { rel: 'src/b.js' }).pop().source, 'USER');
  });

  await test('ONE AUTHORITY · MUTATION: no Harness-side module writes project files around the transaction', () => {
    // Each module listed here writes ONLY LAIN's own state (never the project),
    // or writes inside a `write:` callback handed to mutation.change.
    const ALLOWED = {
      'harnessapp/fileops.js': 'inside mutation.change write callbacks; the trash move',
      'harnessapp/source.js': 'inside mutation.change write callback',
      'harnessapp/sessionroutes.js': 'a leftover screenshot frame in LAIN temp',
      'harnessapp/workspaceroutes.js': 'creating a NEW project folder (no project yet)',
      'exthost/manager.js': 'extension storage / state / registry (LAIN config), and edits inside mutation.change',
      'lsp/manager.js': 'inside mutation.change write callback',
    };
    const offenders = [];
    for (const f of [...filesUnder('harnessapp'), ...filesUnder('lsp'), ...filesUnder('exthost')]) {
      const c = code(f);
      if (!/\b(writeFileSync|renameSync|rmSync|unlinkSync|appendFileSync|copyFileSync)\(/.test(c)) continue;
      if (!ALLOWED[f]) offenders.push(f);
      else if (/source\.js|fileops\.js|lsp\/manager\.js/.test(f) && !/mutation'\)\.change\(|mutation\.change\(/.test(c)) offenders.push(`${f} (writes but does not use mutation.change)`);
    }
    assert.deepStrictEqual(offenders, []);
  });

  await test('ONE AUTHORITY · GENERATION: only the transaction and an observed external change advance the project generation', () => {
    const callers = grepSrc(/noteSourceEdit\(/).filter((f) => f !== 'harnesscontext.js').sort();
    assert.deepStrictEqual(callers, ['harnessapp/source.js', 'mutation.js'], callers.join(', '));
    assert.ok(/external/.test(code('harnessapp/source.js').match(/noteSourceEdit\([^)]*\)/)[0]), 'the freshness poll reports only EXTERNAL changes');
  });

  await test('ONE AUTHORITY · ROUTING: the Harness supplies facts; Core dispatch decides what the words mean', () => {
    const br = code('harnessapp/botroute.js');
    const decide = br.slice(br.indexOf('function decide('), br.indexOf('function botOnRuntime('));
    assert.ok(/dispatch'\)\.route\(/.test(decide), 'decide delegates to dispatch.route');
    assert.ok(!/\.test\(t(ext)?\)/.test(decide), 'no word regex in the Harness decide');
    assert.ok(!/require\('\.\.\/mode'\)/.test(br), 'botroute does not consult the classifier itself');
    assert.ok(/intent\(text\)/.test(code('mode.js')) && /function route\(/.test(code('dispatch.js')));
    assert.ok(/takeRouted\(/.test(code('identify.js')), 'the same input is classified once');
  });

  await test('ONE AUTHORITY · MODELS: both transports enter the one request envelope', () => {
    assert.ok(/modelrequest'\)[\s\S]*openApi\(/.test(code('provider.js')), 'the API transport opens the envelope');
    // PHASE 8.3: the website transport is removed — nothing sends through a website source any more.
    const senders = grepSrc(/\bsource\.send\(/).sort();
    assert.deepStrictEqual(senders, [], `website sends: ${senders.join(', ')}`);
    assert.ok(/modelrequest'\)[\s\S]*TRANSPORT\.RUNTIME/.test(code('runtimedispatch.js')), 'the runtime transport opens the envelope');
    assert.ok(!/reqtrace\.begin\(/.test(code('provider.js')), 'the provider no longer opens its own trace');
  });

  await test('ONE AUTHORITY · SELECTION: one canonical Selection; consumers do not resolve their own', () => {
    const fp = code('focuspacket.js');
    assert.ok(/harnesscontext'\)/.test(fp) && /\.selection\(/.test(fp), 'the focus packet consumes the canonical Selection');
    assert.ok(!/sitesIn\(|readdirSync|RENAME\s*=|resolveIntent/.test(fp), 'and keeps no scanner or parser of its own');
    assert.ok(!/Selected text/.test(code('idecontext.js')), 'the IDE section does not render a second copy');
  });

  await test('ONE AUTHORITY · GUG: UI → source has one owner', () => {
    const callers = grepSrc(/uisource'\)\.fromElement\(/).sort();
    assert.deepStrictEqual(callers, ['gug.js'], callers.join(', '));
    assert.ok(/function sourceBinding\(/.test(code('gug.js')));
    // A PICK IS BOUND ONCE: by the canonical Selection. The only other caller
    // is /api/files/from-element, for an element handed over without selecting it.
    const binders = grepSrc(/gug'\)\.sourceBinding\(/).sort();
    assert.deepStrictEqual(binders, ['harnessapp/routes.js', 'harnesscontext.js'], binders.join(', '));
    assert.strictEqual((code('harnessapp/routes.js').match(/gug'\)\.sourceBinding\(/g) || []).length, 1, 'routes bind only the explicit from-element request');
    // BOTH PICK DOORS (the preview image, the preview window) answer through
    // pickAnswer, which reads the canonical Selection and binds nothing itself.
    const routes = code('harnessapp/routes.js');
    const helper = routes.split('async function pickAnswer(')[1].split(/\r?\n\}\r?\n/)[0];
    assert.ok(/\.selection\(app/.test(helper) && !/sourceBinding\(/.test(helper), 'the Workshop pick answers with the Selection\'s binding');
    for (const door of ["'POST /api/workshop/pick-at'", "'POST /api/workshop/picked'"]) {
      assert.ok(/pickAnswer\(app/.test(routes.split(door)[1].split("'POST /api/workshop/")[0]), `${door} answers through pickAnswer`);
    }
  });

  await test('ONE AUTHORITY · GUG: a Workshop pick (classes as one string, as the inspector reports them) finds its component evidence', () => {
    fs.writeFileSync(path.join(root, 'src', 'Search.jsx'), 'export const Search = () => <input className="search-bar" />;\n');
    const b = require('../../src/gug').sourceBinding(app, root, { tag: 'input', id: '', classes: 'search-bar', text: '' });
    assert.notStrictEqual(b.component.confidence, 'UNKNOWN', b.component.why);
    assert.ok(b.component.candidates.some((c) => c.rel === 'src/Search.jsx'), JSON.stringify(b.component.candidates));
  });

  await test('ONE AUTHORITY · HANDOFF: every door reaches the one transfer record', () => {
    assert.deepStrictEqual(grepSrc(/_delegation|_agentProposal/), [], 'no private handoff fields remain');
    assert.ok(/planhandoff'\)\.transfer\(/.test(code('journey.js')), 'the proposal is a transfer');
    assert.ok(/propose\(/.test(code('tools/handoff.js')), 'hand_to_coding_agent records a transfer');
    assert.ok(/transfer\(app, \{\s*kind: 'plan'/.test(code('planhandoff.js')), 'the plan handoff is a transfer');
    assert.ok(/planhandoff'\)\.transfer\(/.test(code('house.js')), 'entering /focus is recorded as a transfer');
  });

  await test('ONE AUTHORITY · SURFACES: presentation state stays in the window', () => {
    const j = code('journey.js');
    assert.ok(!/focusReport|cleanFocus|\bopen:\s*files/.test(j), 'the Focus workspace (tabs, caret) is not Core state');
    assert.ok(!fs.existsSync(path.join(SRC, 'spine.js')), 'no module claims to be "the Spine"');
  });

  // ---- 2026-09-25, Phase 4: the professional tooling keeps the same rule -----------------

  await test('ONE AUTHORITY · GENERATION: one counter, persisted per project; only noteSourceEdit advances it', () => {
    const advancers = grepSrc(/projectgen'\)\.advance\(|projectgen\.advance\(/).sort();
    assert.deepStrictEqual(advancers, ['harnesscontext.js'], advancers.join(', '));
    assert.ok(!/const GENS\s*=/.test(code('harnesscontext.js')), 'no second, in-memory counter');
    assert.ok(/noteSourceEdit[\s\S]*projectgen\.advance\(/.test(code('harnesscontext.js')));
  });

  await test('ONE AUTHORITY · LAYA: relevance from the canonical Selection and its evidence, never the raw selection fields', () => {
    const l = code('layacontext.js');
    assert.ok(!/textSelection|visualSelection/.test(l), 'Laya does not read the fields the Selection is resolved from');
    assert.ok(/\.selection\(app, session\)/.test(l) && /evidencerefs/.test(l));
  });

  await test('ONE AUTHORITY · LANGUAGE: the Selection is asked of the language server in one place; rename has one semantic path', () => {
    const askers = grepSrc(/lsp\/manager'\)\.(references|definition)\(/).sort();
    assert.deepStrictEqual(askers, ['harnessapp/devtoolroutes.js'], `only langfacts and the IDE's own route (Find References) ask: ${askers.join(', ')}`);
    assert.ok(/lsp\(\)\.references\(/.test(code('langfacts.js')));
    assert.ok(/semanticrename'\)\.rename\(/.test(code('tools/semantic.js')), 'rename_symbol tries the language server first');
    assert.ok(!/sitesIn\(|readdirSync/.test(code('focuspacket.js')), 'the focus packet keeps no scanner of its own');
  });

  await test('ONE AUTHORITY · TOOLS: the funnel narrows what a turn is SHOWN; execution reads the whole active set', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    const idx = code('tools/index.js');
    assert.ok(/toolfunnel'\)\.filter\(/.test(idx.split('function schemas(')[1].split('function has(')[0]), 'schemas() applies the funnel');
    const exec = idx.split('async function execute(')[1];
    assert.ok(/const tool = \(deferred \? legacyActive\(app\) : active\(\(\) => app\)\)\[name\]/.test(exec) && !/toolfunnel'\)\.(filter|shows)\(/.test(exec.split('toolfunnel\')')[0]), 'execute() is not narrowed by the funnel');
  }));

  await test('ONE AUTHORITY · DEBUG: paused state is asked for, never injected into a turn', () => {
    assert.ok(/pausedAt\(app\)/.test(code('harnesscontext.js')) && !/dap\/manager'\)\.context\(/.test(code('harnesscontext.js')), 'the packet says WHERE, not the variables');
    assert.ok(/'debug\.context'/.test(code('house.js')));
  });
};
