'use strict';

/**
 * THE PREVIEW'S PAGE, FROM A TEST — the page the Harness shows in its frame runs out of process (its origin is Core's
 * loopback proxy, not the Harness), so it is reached the way DevTools reaches any out-of-process frame: the page
 * target auto-attaches its frames (flattened), and the frame's own session evaluates inside it.
 *
 *   const pf = await require('./previewframe')(d);   // d = appdriver.open(...)
 *   await pf.settled()                // no load in flight; the shown page is complete
 *   await pf.eval("document.getElementById('q').value")
 *   await pf.rect('#pay')            // the element's box in the frame's CSS pixels
 *   await pf.point('#pay')           // …and where that is in the window (through the frame's scale)
 *
 * THE SHOWN FRAME, EXACTLY: the Preview double-buffers (two frames, one shown), so the session is the one whose target
 * IS the shown frame element's content frame (DOM.describeNode → frameId = the frame's target id), never a guess by URL.
 * Read-only by construction: it evaluates expressions; input still goes through the window (real mouse, keys).
 */

module.exports = async function previewFrame(d, { timeoutMs = 20000 } = {}) {
  const conn = d.page.conn;
  const sessions = new Map();   // sessionId -> { targetId, url, type }
  conn.on((method, params) => {
    if (method === 'Target.attachedToTarget' && params && params.targetInfo) sessions.set(params.sessionId, { targetId: params.targetInfo.targetId, url: params.targetInfo.url, type: params.targetInfo.type });
    if (method === 'Target.detachedFromTarget' && params) sessions.delete(params.sessionId);
  });
  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  /** The shown buffer's content-frame id (= its out-of-process target's id), from the Harness's own DOM. */
  async function shownFrameId() {
    const r = await conn.send('Runtime.evaluate', { expression: "[document.getElementById('wsFrame'), document.getElementById('wsFrameB')].find((x) => x && !x.hidden) || null", returnByValue: false });
    if (!r || !r.result || !r.result.objectId) return null;
    const desc = await conn.send('DOM.describeNode', { objectId: r.result.objectId }).catch(() => null);
    return desc && desc.node ? desc.node.frameId || null : null;
  }
  async function session() {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const fid = await shownFrameId();
      if (fid) for (const [id, s] of sessions) if (s.targetId === fid) return id;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`the preview frame did not attach (${[...sessions.values()].map((s) => `${s.type}:${s.url}`).join(', ') || 'none'})`);
  }

  async function evaluate(expression) {
    const id = await session();
    const r = await conn.sendTo(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 10000);
    if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r && r.result ? r.result.value : undefined;
  }
  /** No load in flight in the Harness, and the shown page has finished loading. */
  async function settled(ms = timeoutMs) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const busy = await d.js('!!(LAIN.workshop.state().loading)').catch(() => true);
      if (!busy) {
        const ready = await evaluate('document.readyState').catch(() => '');
        if (ready === 'complete') return true;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('the preview did not settle');
  }
  async function rect(selector) {
    return evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  }
  /** Frame CSS px → window px, through the frame element's box and the device scale (real viewports are scaled to fit). */
  async function point(selector, fx = 0.5, fy = 0.5) {
    const r = await rect(selector);
    if (!r) throw new Error(`${selector} is not on the preview's page`);
    return d.js(`(() => { const f = [document.getElementById('wsFrame'), document.getElementById('wsFrameB')].find((x) => x && !x.hidden) || document.getElementById('wsFrame'); const b = f.getBoundingClientRect(); const dev = document.getElementById('pvDevice'); const k = b.width / (parseFloat(dev.style.width) || b.width);
      const e = ${JSON.stringify(r)}; return { x: b.left + (e.x + e.w * ${fx}) * k, y: b.top + (e.y + e.h * ${fy}) * k }; })()`);
  }
  return { eval: evaluate, rect, point, session, settled };
};
