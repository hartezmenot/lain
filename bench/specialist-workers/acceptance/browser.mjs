// HIDDEN ACCEPTANCE — the page, measured in a real browser (Edge via playwright-core).
//   FIXTURE_DIR=<copy> node bench/specialist-workers/acceptance/browser.mjs [--json]
// Starts the copy's API and Vite on free ports, loads the page, and checks
// DESIGN.md: geometry (±0.5 px), no slop, quiet console. Also the FINAL SMOKE:
// the page loads, /api/health answers, the user's name renders, no errors.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

if (!process.env.FIXTURE_DIR) throw new Error('FIXTURE_DIR is required');
// The LONG path: Vite compares served files against its root, and an 8.3 short
// name (C:\Users\ABCDEF~1\…) is a different string — every request is a 403.
const DIR = fs.realpathSync.native(process.env.FIXTURE_DIR);
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const req = createRequire(path.join(DIR, 'package.json'));
const benchReq = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.deps', 'harness', 'package.json'));

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function main() {
  const apiPort = await free();
  const webPort = await free();
  const tmpSettings = path.join(fs.mkdtempSync(path.join(DIR, '..', 'acc-')), 'settings.json');
  fs.copyFileSync(path.join(DIR, 'data', 'workspace.json'), tmpSettings);
  const api = spawn(process.execPath, ['server/index.js'], { cwd: DIR, env: { ...process.env, API_PORT: String(apiPort), SETTINGS_FILE: tmpSettings }, stdio: 'ignore', windowsHide: true });
  let vite = null;
  let browser = null;
  const checks = [];
  const check = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail: String(detail) });
  try {
    let viteMod;
    try { viteMod = await import(pathToFileURL(req.resolve('vite')).href); } catch (e) { check('SMOKE.vite', false, `vite not resolvable: ${e.message}`); throw e; }
    process.env.API_PORT = String(apiPort);
    vite = await viteMod.createServer({ root: DIR, configFile: path.join(DIR, 'vite.config.js'), logLevel: 'silent', server: { port: webPort, strictPort: true, host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${apiPort}` } } });
    await vite.listen();
    const { chromium } = benchReq('playwright-core');
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleMsgs = [];
    page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: e.message }));
    // Failed loads by URL; the browser's own favicon probe is not the page's error.
    const failed = [];
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${apiPort}/api/health`); if (r.ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
    const health = await fetch(`http://127.0.0.1:${webPort}/api/health`).then((r) => r.status).catch(() => 0);
    check('SMOKE.health', health === 200, `status ${health}`);
    await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
      const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const gradients = [...document.querySelectorAll('*')].filter((e) => /gradient/.test(getComputedStyle(e).backgroundImage)).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''));
      const pads = (sel) => { const s = cs(sel); return s ? [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map((v) => parseFloat(v)) : null; };
      const btn = document.querySelector('#settingsForm button');
      return {
        title: document.title,
        text: document.body.innerText,
        h1: (document.querySelector('h1') || {}).textContent || '',
        h2: (document.querySelector('#settingsCard h2') || {}).textContent || '',
        user: (document.getElementById('userName') || {}).textContent || '',
        topbar: r('.topbar'), avatar: r('#avatar'), avatarRadius: cs('#avatar') && cs('#avatar').borderRadius,
        composer: r('#composer'), send: r('#send'),
        gradients, cardPad: pads('.card'), btnPad: pads('.btn'),
        btnText: btn ? btn.textContent.trim() : '', btnTransform: btn ? getComputedStyle(btn).textTransform : '',
        // v2 (2026-09-23): density, nesting, radius, control heights, composer margins.
        nested: document.querySelectorAll('.card .card').length,
        pills: [...document.querySelectorAll('.pill, .stat, .badge')].filter((e) => e.getClientRects().length).length,
        radii: [...document.querySelectorAll('.card, .btn, input, select')].map((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0),
        controls: ['#wsName', '#digest', '#settingsForm button'].map((s) => { const b = r(s); return b ? b.h : null; }),
        vw: document.documentElement.clientWidth,
      };
    });
    const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.5;
    const cy = (b) => b && b.y + b.h / 2;
    check('SMOKE.userName', m.user === 'Ada Lovelace', `"${m.user}"`);
    const errs = consoleMsgs.filter((x) => (x.type === 'error' && !/^Failed to load resource/.test(x.text)) || x.type === 'pageerror');
    check('SMOKE.noErrors', !errs.length && !failed.length, JSON.stringify([...errs.map((x) => x.text), ...failed]).slice(0, 300));
    check('G1.send.size', m.send && near(m.send.w, 40) && near(m.send.h, 40), m.send && `${m.send.w}x${m.send.h}`);
    check('G1.send.centerY', m.send && m.composer && near(cy(m.send), cy(m.composer)), m.send && `${cy(m.send)} vs ${cy(m.composer)}`);
    check('G1.send.rightInset', m.send && m.composer && near(m.composer.right - m.send.right, 12), m.send && `${(m.composer.right - m.send.right).toFixed(2)}`);
    check('G1.composer.height', m.composer && near(m.composer.h, 64), m.composer && m.composer.h);
    check('G2.avatar.size', m.avatar && near(m.avatar.w, 32) && near(m.avatar.h, 32), m.avatar && `${m.avatar.w}x${m.avatar.h}`);
    check('G2.avatar.centerY', m.avatar && m.topbar && near(cy(m.avatar), cy(m.topbar)), m.avatar && `${cy(m.avatar)} vs ${cy(m.topbar)}`);
    check('G2.avatar.circle', /50%|16px/.test(String(m.avatarRadius)), m.avatarRadius);
    const emoji = /\p{Extended_Pictographic}/u;
    check('S1.noEmoji', !emoji.test(m.text) && !emoji.test(m.title) && !emoji.test(m.btnText), (m.text.match(/\p{Extended_Pictographic}/gu) || []).join('') + (emoji.test(m.title) ? ' title' : ''));
    check('S2.noHype', !/supercharg|unleash|seamless|cutting-edge|next-generation|ai-powered/i.test(m.text + m.title), '');
    check('S3.noGradients', m.gradients.length === 0, m.gradients.join(','));
    check('S4.headings', m.h1.trim() === 'Settings' && m.h2.trim() === 'Workspace settings', `h1 "${m.h1.trim()}" h2 "${m.h2.trim()}"`);
    check('S5.button', m.btnText === 'Save changes' && m.btnTransform !== 'uppercase', `"${m.btnText}" ${m.btnTransform}`);
    const tokens = [0, 4, 8, 12, 16, 24, 32];
    check('S6.spacingTokens', m.cardPad && m.btnPad && [...m.cardPad, ...m.btnPad].every((v) => tokens.includes(v)), `card ${m.cardPad} btn ${m.btnPad}`);
    const chatter = consoleMsgs.filter((x) => (x.type === 'log' || x.type === 'debug' || x.type === 'info') && !/^\[vite\]/.test(x.text));
    check('D1.quietConsole', !chatter.length, chatter.length + ' app log lines');
    // ---- v2: anti-slop density, controls, symmetry, responsiveness ----------
    check('S7.noFakeMetrics', !m.pills && !/\b10x\b|99\.9%|teams trust us/i.test(m.text), `${m.pills} pill/stat elements`);
    check('S8.noNestedCards', m.nested === 0, `${m.nested} card(s) inside a card`);
    check('S9.radius', m.radii.every((x) => x <= 8), `max ${Math.max(...m.radii)}px`);
    check('G4.controls36', m.controls.every((h) => near(h, 36)), m.controls.join(','));
    const margins = (c, vw) => c ? [c.x, vw - c.right] : [null, null];
    const [l1, r1] = margins(m.composer, m.vw);
    check('G3.composer.symmetric', near(l1, r1) && near(l1, 24), `left ${l1} right ${r1} at ${m.vw}`);
    const phone = await browser.newPage({ viewport: { width: 375, height: 760 } });
    await phone.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await phone.waitForTimeout(300);
    const p = await phone.evaluate(() => {
      const c = document.getElementById('composer');
      const b = c ? c.getBoundingClientRect() : null;
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, composer: b ? { x: b.x, right: b.right } : null };
    });
    check('R1.narrowNoOverflow', p.sw <= p.cw, `scrollWidth ${p.sw} vs ${p.cw} at 375`);
    const [l2, r2] = margins(p.composer, p.cw);
    check('G3.composer.symmetric375', near(l2, r2), `left ${l2} right ${r2} at 375`);
  } catch (e) {
    check('SMOKE.run', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (vite) await vite.close().catch(() => {});
    api.kill();
  }
  const pass = checks.filter((c) => c.ok).length;
  const out = { pass, total: checks.length, smoke: checks.filter((c) => c.id.startsWith('SMOKE')).every((c) => c.ok), checks };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(out) + '\n');
  else for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id} ${c.detail}`);
  process.exit(0);
}

main();
