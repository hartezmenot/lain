'use strict';

/**
 * LAIN DESIGN, REAL — the Design surface (lain-harness design/) in a headless Chromium against Core's real
 * /api/design routes (tests/designbench.js), the headless preview driver, and one Design-session turn against the mock
 * provider. Every pointer and key event here is CDP input into a headless page; nothing touches this machine's mouse,
 * keyboard or windows.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  const design = require('../../src/design');
  const at = design.installed();
  if (!at.ok) { await test(`DESIGN REAL: Design is not installed here (${at.why}) — not verified`, () => assert.ok(!at.ok)); return; }
  const { findBrowser } = require(path.join(at.dir, 'src', 'headless.js'));
  if (!findBrowser()) { await test('DESIGN REAL: no Chromium on this machine — not verified here', () => assert.ok(true)); return; }
  const benchMod = require('../designbench');
  const haveUI = Boolean(benchMod.harnessDesignDir());

  /** A bench at zoom 1, the Chats frame at a known place, every frame loaded. */
  async function bench() {
    const b = await benchMod.start();
    await b.until('LAIN.designUI._state.frames.size === 4 && [...LAIN.designUI._state.frames.values()].every(f => f.ready)', 25000);
    await b.eval('(() => { const s = LAIN.designUI._state; s.zoom = 1; s.pan = { x: 30, y: 40 }; document.getElementById("dzWorld").style.transform = "translate(30px,40px) scale(1)"; })()');
    await wait(200);
    return b;
  }
  /** Select by clicking the canvas (the element must be visible there and hit itself). */
  async function selectIn(b, screen, pick) {
    const fb = await b.frameBox(screen);
    const nodes = await b.inFrame(screen);
    const n = nodes.find(pick);
    assert.ok(n, 'the element is on the canvas');
    await b.click(fb.x + n.rect.x + Math.min(10, n.rect.w / 2), fb.y + n.rect.y + n.rect.h / 2);
    await b.until(`LAIN.designUI._state.sel && LAIN.designUI._state.sel.node === ${JSON.stringify(n.id)} && LAIN.designUI._state.sel.info && LAIN.designUI._state.sel.layout`);
    return { fb, n };
  }
  /** Select through the Screens panel: open the screen's layers, click the layer's row. The canvas follows. */
  async function selectLayer(b, screen, pick) {
    const nodes = await b.inFrame(screen);
    const n = nodes.find(pick);
    assert.ok(n, 'the element is in the screen');
    const rowAt = (sel) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    if (!(await rowAt(`.dz-layer[data-node="${n.id}"]`))) {
      const scr = await b.eval(`(() => { const rows = [...document.querySelectorAll('.dz-scr-row')]; const e = rows.find(r => r.querySelector('small').textContent === ${JSON.stringify(screen)}); const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
      await b.click(scr.x, scr.y);
      await b.until(`document.querySelector('.dz-layer[data-node="${n.id}"]')`);
    }
    const p = await rowAt(`.dz-layer[data-node="${n.id}"]`);
    await b.click(p.x, p.y);
    await b.until(`LAIN.designUI._state.sel && LAIN.designUI._state.sel.node === ${JSON.stringify(n.id)} && LAIN.designUI._state.sel.info && LAIN.designUI._state.sel.layout`);
    // bring its frame into view, as the screen row does
    await b.eval(`(() => { const s = LAIN.designUI._state; const f = s.frames.get(${JSON.stringify(screen)}); s.pan = { x: 30 - f.pos.x, y: 40 }; document.getElementById('dzWorld').style.transform = 'translate(' + s.pan.x + 'px,40px) scale(1)'; })()`);
    await wait(150);
    return { fb: await b.frameBox(screen), n };
  }
  const statusText = (b) => b.eval('document.querySelector("#dzStatus").textContent');

  if (haveUI) {
    await test('DESIGN UI 1: drag the profile avatar from top-right to top-left — only its position changes in the source; Ctrl+Z is byte-exact', async () => {
      const b = await bench();
      try {
        const css0 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        const html0 = fs.readFileSync(path.join(b.root, 'index.html'), 'utf8');
        const { fb, n } = await selectIn(b, 'index.html', (x) => x.tag === 'img' && x.rect.w === 40 && x.rect.y < 30);
        const x0 = fb.x + n.rect.x + 20; const y0 = fb.y + n.rect.y + 20;
        await b.drag(x0, y0, x0 - 316, y0, 16);
        await b.until('/left 16px/.test(document.querySelector("#dzStatus").textContent)', 10000);
        const css1 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        assert.strictEqual(css1, css0.replace('right: 16px', 'left: 16px'), 'one declaration renamed and nothing else');
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'index.html'), 'utf8'), html0, 'the page untouched');
        // the preview reloaded and the avatar is where it was dropped
        await b.until('LAIN.designUI._state.sel && LAIN.designUI._state.sel.layout && LAIN.designUI._state.sel.layout.rect.x < 30', 10000);
        await b.h.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
        await b.h.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
        await b.until('document.querySelector("#dzStatus").textContent.startsWith("Undid")', 10000);
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), css0, 'byte-exact');
      } finally { await b.close(); }
    });

    await test('DESIGN UI 2: the W slider writes width to the element\'s own rule, and the preview\'s rectangle matches it', async () => {
      const b = await bench();
      try {
        await selectIn(b, 'index.html', (x) => x.tag === 'img' && x.rect.w === 40 && x.rect.y < 30);
        await b.eval('(() => { const r = document.querySelector(\'#dzRight input[type=range][data-prop="width"]\'); const num = r.parentNode.querySelector("input[type=number]"); num.value = "56"; num.dispatchEvent(new Event("input")); num.dispatchEvent(new Event("change")); })()');
        await b.until('/width: 56px/.test(document.querySelector("#dzStatus").textContent)', 10000);
        assert.match(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), /\.me-avatar \{[^}]*width: 56px/);
        await b.until('LAIN.designUI._state.sel && LAIN.designUI._state.sel.layout && LAIN.designUI._state.sel.layout.rect.w === 56', 10000);
      } finally { await b.close(); }
    });

    await test('DESIGN UI 4: a change to a shared class asks "Change all N uses, or only this one?" before anything is written', async () => {
      const b = await bench();
      try {
        const css0 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        await selectLayer(b, 'index.html', (x) => x.tag === 'a' && x.rect.y > 700);
        await b.eval('(() => { const r = document.querySelector(\'#dzRight input[type=range][data-prop="border-radius"]\'); const num = r.parentNode.querySelector("input[type=number]"); num.value = "4"; num.dispatchEvent(new Event("change")); })()');
        await b.until('document.querySelector(".dz-modal h4")', 8000);
        assert.strictEqual(await b.eval('document.querySelector(".dz-modal h4").textContent'), 'Change all 6 uses of .chip, or only this one?');
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), css0, 'nothing written while asking');
        await b.eval('[...document.querySelectorAll(".dz-modal button")].find(x => x.textContent === "Only this one").click()');
        await b.until('/new class \\.lain-/.test(document.querySelector("#dzStatus").textContent)', 10000);
        const css1 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        assert.ok(css1.startsWith(css0), 'the shared rule is untouched; a scoped rule is appended');
      } finally { await b.close(); }
    });

  }

};
