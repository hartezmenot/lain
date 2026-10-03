'use strict';

/**
 * THE RELEVANT AREA (the four-gate spec §103): a screenshot about an element is that element's area, not the page.
 * harness/browser.js `screenshot({ selector })` clips to the element's box plus a margin; the browser harness passes
 * the selector through for an observation and for a screenshot step. A fake connection records what was asked.
 */

const assert = require('assert');
const { test } = require('../helpers');

function fakeConn(box) {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: box } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      return {};
    },
    on() { return () => {}; },
  };
}

module.exports = async function () {
  await test('ELEMENT SHOT (§103): a selector clips the capture to that element plus a margin; no selector is the page', async () => {
    const { BrowserSession } = require('../../src/harness/browser');
    const conn = fakeConn({ x: 100, y: 250, w: 120, h: 40 });
    const s = new BrowserSession(conn, {});
    const el = await s.screenshot({ selector: '#pay' });
    assert.ok(el.ok);
    const shot = conn.calls.find((c) => c.method === 'Page.captureScreenshot');
    assert.deepStrictEqual(shot.params.clip, { x: 84, y: 234, width: 152, height: 72, scale: 1 }, 'the element and a 16px margin');
    assert.strictEqual(shot.params.captureBeyondViewport, true);
    const page = fakeConn(null);
    const p = new BrowserSession(page, {});
    assert.ok((await p.screenshot()).ok);
    assert.ok(!page.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip, 'no selector: the page');
    const gone = await new BrowserSession(fakeConn(null), {}).screenshot({ selector: '#nope' });
    assert.strictEqual(gone.ok, false);
    assert.match(gone.why, /#nope is not on the page/);
    // AT THE PAGE'S EDGE the margin is cut, never negative.
    const edge = fakeConn({ x: 4, y: 0, w: 50, h: 20 });
    await new BrowserSession(edge, {}).screenshot({ selector: '#logo' });
    assert.deepStrictEqual(edge.calls.find((c) => c.method === 'Page.captureScreenshot').params.clip, { x: 0, y: 0, width: 70, height: 36, scale: 1 });
  });
};
