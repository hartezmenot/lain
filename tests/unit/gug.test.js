'use strict';

/**
 * THE GUG — GEOMETRIC UI GRAPH (2026-09-24). Core-owned, built only from
 * deterministic evidence. These pin: nodes and relations from a DOM
 * measurement, the source binding, a bounded canonical slice, UNKNOWN staying
 * UNKNOWN, the reverse mapping (a source edit stales the nodes it sizes; a
 * re-measure reports the visual impact), and the Workshop selection becoming
 * a semantic GUG id Core can resolve.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || tmpdir('lain-gug-home-');
const gug = require('../../src/gug');
const hc = require('../../src/harnesscontext');

/** A composer: an input and a square send button, centred vertically, 8 px from the right edge. */
function composerDom({ inputH = 48, submit = 40 } = {}) {
  const barY = 600; const barH = 68;
  return [
    { tag: 'body', classes: '', rect: { x: 0, y: 0, w: 1280, h: 800 }, parent: -1, style: {} },
    { tag: 'div', classes: 'composer', selector: 'div.composer', rect: { x: 300, y: barY, w: 660, h: barH }, parent: 0, style: { display: 'flex', 'align-items': 'center' } },
    { tag: 'input', classes: 'composer-input', selector: 'input.composer-input', label: 'Ask anything', rect: { x: 310, y: barY + (barH - inputH) / 2, w: 580, h: inputH }, parent: 1, style: { height: `${inputH}px` } },
    { tag: 'button', classes: 'submit', selector: 'button.submit', label: 'Send', rect: { x: 960 - 8 - submit, y: barY + (barH - submit) / 2, w: submit, h: submit }, parent: 1, style: { width: `${submit}px`, height: `${submit}px`, 'min-width': 'auto' } },
    { tag: 'div', classes: 'css-1x9fz2k', selector: 'div.css-1x9fz2k', rect: { x: 300, y: 700, w: 660, h: 20 }, parent: 0, style: {} },
  ];
}

module.exports = async function run() {
  await test('GUG: nodes with stable semantic ids, parent/children and MEASURED relations from DOM layout evidence', () => {
    const g = gug.fromDom(composerDom(), { root: '', url: 'http://localhost:5173/' });
    assert.ok(g.nodes.has('composer.submit'), [...g.nodes.keys()].join(','));
    assert.ok(g.nodes.has('composer.composer-input'));
    const s = g.nodes.get('composer.submit');
    assert.strictEqual(s.parent, 'composer');
    assert.deepStrictEqual(s.rect, { x: 912, y: 614, w: 40, h: 40 });
    assert.ok(g.nodes.get('composer').children.includes('composer.submit'));
    const has = (type, from, to, f = () => true) => g.edges.some((e) => e.type === type && e.from === from && e.to === to && f(e));
    assert.ok(has('PARENT_OF', 'composer', 'composer.submit'));
    assert.ok(has('CENTERED_IN', 'composer.submit', 'composer', (e) => e.axis === 'y'), 'centerY == composer.centerY');
    assert.ok(has('ANCHORED_TO', 'composer.submit', 'composer', (e) => e.insets.right === 8), 'right inset 8');
    assert.ok(has('LEFT_OF', 'composer.composer-input', 'composer.submit'));
    assert.ok(has('GAP_TO', 'composer.composer-input', 'composer.submit', (e) => e.px === 22));
    assert.ok(g.edges.every((e) => e.intent === 'UNKNOWN'), 'a relation is an observation, never a declared intent');
    // Same DOM → same ids and the same fingerprint.
    assert.strictEqual(gug.fromDom(composerDom()).fingerprint, gug.fromDom(composerDom()).fingerprint);
  });

  await test('GUG: UNKNOWN stays UNKNOWN — no limit invented, a generated class is not bound, a UIA tree has no source binding', () => {
    const root = tmpdir('lain-gug-unk-');
    fs.writeFileSync(path.join(root, 'app.css'), '.composer { display: flex; }\n');
    const g = gug.bind(gug.fromDom(composerDom(), { root }), root);
    const s = g.nodes.get('composer.submit');
    assert.strictEqual(s.limits.minW, null, '"auto" is not a number');
    assert.strictEqual(s.limits.maxW, null, 'not reported → null');
    assert.strictEqual(s.binding.confidence, 'UNKNOWN');
    const gen = [...g.nodes.values()].find((n) => n.classes.includes('css-1x9fz2k'));
    assert.strictEqual(gen.binding.confidence, 'UNKNOWN');
    const u = gug.fromUia({ controlType: 'Window', name: 'App', rect: { x: 0, y: 0, width: 800, height: 600 }, children: [{ controlType: 'Button', name: 'OK', automationId: 'okBtn', rect: { x: 700, y: 550, width: 80, height: 30 } }] });
    assert.ok(u.nodes.has('app.okbtn') || [...u.nodes.keys()].some((k) => /okbtn/.test(k)), [...u.nodes.keys()].join(','));
    assert.deepStrictEqual([...u.nodes.values()][1].provenance, ['UIA']);
    const sl = gug.slice(g, 'composer.submit');
    assert.match(sl.text, /limits: UNKNOWN/);
    assert.match(sl.text, /implementation: UNKNOWN/);
    assert.match(sl.text, /design intent is UNKNOWN/);
  });

  await test('GUG: source binding — EXACT rule with its geometry props and CSS token; MULTIPLE when two rules size it', () => {
    const root = tmpdir('lain-gug-bind-');
    fs.writeFileSync(path.join(root, 'app.css'), ':root {\n  --submit-size: 40px;\n}\n.composer .submit {\n  width: var(--submit-size);\n  height: var(--submit-size);\n  margin-top: 0px;\n}\n.composer-input { height: 48px; }\n');
    const g = gug.bind(gug.fromDom(composerDom(), { root }), root);
    const b = g.nodes.get('composer.submit').binding;
    assert.strictEqual(b.confidence, 'EXACT');
    assert.strictEqual(b.file, 'app.css');
    assert.strictEqual(b.selector, '.composer .submit');
    assert.deepStrictEqual(b.props.map((p) => p.prop), ['width', 'height', 'margin-top']);
    assert.deepStrictEqual(b.tokens.map((t) => [t.name, t.value, t.line]), [['--submit-size', '40px', 2]]);
    assert.ok(g.edges.some((e) => e.type === 'BINDS_TO_SOURCE' && e.from === 'composer.submit' && e.to === 'app.css:4'));
    assert.ok(g.edges.some((e) => e.type === 'CONTROLLED_BY_TOKEN' && e.to === '--submit-size'));
    fs.writeFileSync(path.join(root, 'more.css'), 'button.submit { width: 44px; }\n');
    const g2 = gug.bind(gug.fromDom(composerDom(), { root }), root);
    assert.strictEqual(g2.nodes.get('composer.submit').binding.confidence, 'MULTIPLE', 'two rules: the person or the flagship chooses');
  });

  await test('GUG_SLICE: bounded, canonical, never the whole graph — the steer\'s example shape', () => {
    const root = tmpdir('lain-gug-slice-');
    fs.writeFileSync(path.join(root, 'app.css'), ':root { --submit-size: 40px; }\n.submit { width: var(--submit-size); height: var(--submit-size); }\n');
    const els = composerDom();
    for (let i = 0; i < 300; i++) els.push({ tag: 'li', classes: `row r${i}`, rect: { x: 0, y: 800 + i * 20, w: 200, h: 20 }, parent: 0, style: {} });
    const g = gug.bind(gug.fromDom(els, { root, url: 'http://localhost:5173/' }), root);
    const a = gug.slice(g, 'composer.submit');
    const b = gug.slice(gug.bind(gug.fromDom(els, { root, url: 'http://localhost:5173/' }), root), 'composer.submit');
    assert.strictEqual(a.text, b.text, 'the same state renders the same bytes');
    assert.ok(a.chars <= gug.SLICE_CHARS, `${a.chars} chars`);
    assert.ok(a.chars < 1400, `hundreds of tokens, not thousands: ${a.chars} chars`);
    for (const re of [/target: composer\.submit/, /geometry: x 912 y 614 w 40 h 40/, /parent: composer/, /width == height/, /centerY == composer\.centerY/, /right 8/, /token --submit-size: 40px/, /provenance: DOM · computed-style · source-css/]) assert.match(a.text, re);
    assert.doesNotMatch(a.text, /r299/, 'unrelated nodes stay out');
    assert.strictEqual(gug.slice(g, 'no.such').found, false);
  });

  await test('GUG REVERSE MAPPING: a source edit stales the nodes it sizes; the re-measure reports the visual impact', () => {
    const root = tmpdir('lain-gug-rev-');
    fs.writeFileSync(path.join(root, 'bar.css'), '.composer-input { height: 48px; }\n');
    gug._reset(); hc._reset();
    const app = {};
    const session = { id: 's1', cwd: root, messages: [] };
    const g1 = gug.put(app, root, gug.bind(gug.fromDom(composerDom({ inputH: 48 }), { root }), root));
    assert.strictEqual(g1.generation, 1);
    assert.strictEqual(gug.put(app, root, gug.bind(gug.fromDom(composerDom({ inputH: 48 }), { root }), root)).generation, 1, 'an identical measurement is not a new generation');
    const r = hc.noteSourceEdit(app, session, { file: path.join(root, 'bar.css'), by: 'user' });
    assert.deepStrictEqual(r.gugAffected, ['composer.composer-input'], 'the reverse mapping: file → the node it sizes');
    assert.strictEqual(r.generation, 1, 'the project generation advanced');
    assert.match(gug.slice(gug.get(app, root), 'composer.composer-input').text, /STALE \(source bar\.css changed/);
    const g2 = gug.put(app, root, gug.bind(gug.fromDom(composerDom({ inputH: 54 }), { root }), root));
    assert.strictEqual(g2.generation, 2);
    const im = gug.impact(g1, g2);
    const input = im.changes.find((c) => c.id === 'composer.composer-input');
    assert.deepStrictEqual([input.dh, input.dy], [6, -3], 'height +6, re-centred');
    assert.ok(im.lines.some((l) => /composer\.composer-input height \+6px/.test(l)), im.lines.join(' | '));
    assert.strictEqual(typeof im.affectedRelations, 'number');
    // A STACK: the search bar grows 44 → 50 and the results below it move +6.
    const stack = (h) => [{ tag: 'main', classes: 'view', rect: { x: 0, y: 0, w: 800, h: 600 }, parent: -1 }, { tag: 'div', classes: 'searchbar', rect: { x: 0, y: 100, w: 800, h }, parent: 0 }, { tag: 'div', classes: 'results', rect: { x: 0, y: 100 + h + 8, w: 800, h: 300 }, parent: 0 }];
    const s2 = gug.impact(gug.fromDom(stack(44)), gug.fromDom(stack(50)));
    assert.deepStrictEqual(s2.lines, ['view.searchbar height +6px', 'view.results moved y +6px']);
    assert.strictEqual(s2.affectedRelations, 0, 'the stack held: the 8 px gap and the alignments are unchanged — reported as such, not invented');
    // …and a relation that DOES break is counted: the results stop moving and now overlap.
    const fixed = stack(50); fixed[2].rect.y = 152;
    assert.ok(gug.impact(gug.fromDom(stack(44)), gug.fromDom(fixed)).affectedRelations >= 1);
  });

  await test('WORKSHOP: a pick becomes a semantic GUG id; Core knows what "this" is without a screenshot', async () => {
    const root = tmpdir('lain-gug-ws-');
    fs.writeFileSync(path.join(root, 'app.css'), '.composer .submit { width: 40px; height: 40px; margin-top: 4px; }\n');
    gug._reset(); hc._reset();
    const app = {};
    const session = { id: 's2', cwd: root, messages: [] };
    const ws = { measure: async () => ({ ok: true, url: 'http://localhost:5173/', viewport: { w: 1280, h: 800 }, elements: composerDom() }) };
    const r = await hc.workshopPicked(app, session, ws, { selector: 'button.submit', rect: { x: 912, y: 614, w: 40, h: 40 }, tag: 'button' });
    assert.deepStrictEqual([r.id, r.generation, r.binding.confidence, r.binding.file], ['composer.submit', 1, 'EXACT', 'app.css']);
    const ref = hc.referent(app, session);
    assert.strictEqual(ref.kind, 'visual');
    assert.strictEqual(ref.gugId, 'composer.submit');
    const p = hc.packet(app, session);
    assert.match(p, /selection: Workshop node composer\.submit · GUG generation 1/);
    assert.match(p, /GUG_SLICE · generation 1/);
    assert.strictEqual(p, hc.packet(app, session), 'the packet is byte-stable while nothing changed');
  });
};
