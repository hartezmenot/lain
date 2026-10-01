'use strict';
// Render the Noema mark to PNGs (transparent) with headless Edge, then pack noema.ico (PNG-compressed entries).
// node render.js <brandDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Connection } = require('../../src/harness/cdp');
const dir = process.argv[2];
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ico(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dirs = []; let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    offset += buf.length; dirs.push(e);
  }
  return Buffer.concat([head, ...dirs, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-render-'));
  const br = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--force-device-scale-factor=1', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const out = [];
  try {
    let dt = null; for (let i = 0; i < 100 && !dt; i++) { try { dt = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; } catch { await wait(150); } }
    const list = await (await fetch(`http://127.0.0.1:${dt}/json/list`)).json();
    const c = new Connection(list.find((x) => x.type === 'page').webSocketDebuggerUrl); await c.connect();
    await c.send('Page.enable', {});
    await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    fs.mkdirSync(path.join(dir, 'png'), { recursive: true });
    for (const s of SIZES) {
      const svg = fs.readFileSync(path.join(dir, s <= 24 ? 'noema-small.svg' : 'noema.svg'), 'utf8').replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`);
      await c.send('Emulation.setDeviceMetricsOverride', { width: s, height: s, deviceScaleFactor: 1, mobile: false });
      const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
      await c.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
      await wait(300);
      const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: s, height: s, scale: 1 } });
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(dir, 'png', `noema-${s}.png`), buf);
      out.push({ size: s, buf });
    }
    // A REVIEW SHEET: each size at 1× on dark and light, and the small ones magnified 6×.
    const cells = SIZES.map((s) => `<div style="display:inline-block;margin:8px;text-align:center;font:11px system-ui;color:#888"><img src="data:image/png;base64,${out.find((o) => o.size === s).buf.toString('base64')}"><br>${s}</div>`).join('');
    const mags = [16, 20, 24, 32].map((s) => `<img style="image-rendering:pixelated;width:${s * 6}px;height:${s * 6}px;margin:8px" src="data:image/png;base64,${out.find((o) => o.size === s).buf.toString('base64')}">`).join('');
    const sheet = `<!doctype html><body style="margin:0;font:12px system-ui"><div style="background:#202020;padding:10px">${cells}</div><div style="background:#f3f3f3;padding:10px">${cells}</div><div style="background:#202020;padding:10px">${mags}</div></body>`;
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(sheet).toString('base64')}` });
    await wait(500);
    const sh = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, 'review-sheet.png'), Buffer.from(sh.data, 'base64'));
    c.close();
  } finally { try { execFileSync('taskkill', ['/PID', String(br.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } await wait(500); try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* held */ } }
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  fs.writeFileSync(path.join(dir, 'noema.ico'), ico(out.filter((o) => icoSizes.includes(o.size))));
  console.log('rendered', out.map((o) => `${o.size}:${o.buf.length}B`).join(' '), '| ico', fs.statSync(path.join(dir, 'noema.ico')).size, 'bytes');
})();
