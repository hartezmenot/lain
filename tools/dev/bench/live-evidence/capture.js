'use strict';

/**
 * CAPTURE ONE LIVE TORALINK OBSERVATION — once, reproducibly (2026-09-24).
 *
 *   node bench/live-evidence/capture.js [--project <toralink root>] [--query "big buck bunny"] [--port 4317]
 *
 * READ-ONLY toward the real project: it is hashed before and after (every file,
 * node_modules and .lain included) and the run fails loudly if one byte moved.
 * The app runs from a TEMP COPY of webapp/ with a TEMP state dir
 * (TORALINK_STATE_DIR), on its own port — never the person's running instance
 * or their state/password. A fresh state dir makes the server seed its own
 * documented default password, which is what logs this temp instance in.
 *
 * One real search is run so the results surface exists; nothing is downloaded
 * (the "Get" action is observed, never clicked).
 *
 * Output: bench/out/live-evidence/<stamp>/
 *   snapshot.json   DOM nodes (+ linked accessibility role/name), bounds, state,
 *                   network (with /api response summaries), console, runtime
 *   truth.json      the 8 ground-truth targets → refs, by fixed selectors
 *   screenshot.png  for the person reading the report ONLY — never sent to a model
 *   meta.json       timings, the project hash check, what ran
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PROJECT = path.resolve(arg('project', path.join(os.homedir(), 'Documents', 'toralink')));
const QUERY = arg('query', 'big buck bunny');
const PORT = Number(arg('port', '4317'));
const CHROME = arg('chrome', path.join(os.homedir(), '.lain-v2', 'chromium', '141.0.7390.54', 'chrome.exe'));
const PW = require(path.join(REPO, 'tools', 'dev', 'bench', 'specialist-workers', '.deps', 'harness', 'node_modules', 'playwright-core'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(arg('out', path.join(REPO, 'tools', 'dev', 'bench', 'out', 'live-evidence', stamp)));

function manifest(root) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(root, p).replace(/\\/g, '/')] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  })(root);
  return out;
}
function diff(a, b) {
  return { added: Object.keys(b).filter((k) => !(k in a)), removed: Object.keys(a).filter((k) => !(k in b)), modified: Object.keys(b).filter((k) => k in a && a[k] !== b[k]) };
}

/** The DOM walk, in the page. Elements in document order; the same skip rule as the CDP walk below. */
function walkDom() {
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BASE']);
  const IMPLICIT = { BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', FORM: 'form', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', UL: 'list', OL: 'list', LI: 'listitem', OPTION: 'option', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', IMG: 'img', LABEL: 'label', DIALOG: 'dialog' };
  const inputRole = (el) => { const t = (el.getAttribute('type') || 'text').toLowerCase(); return t === 'search' || el.getAttribute('inputmode') === 'search' ? 'searchbox' : t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : ['button', 'submit'].includes(t) ? 'button' : 'textbox'; };
  const KEEP_ATTR = ['type', 'placeholder', 'href', 'name', 'value', 'disabled', 'inputmode', 'enterkeyhint', 'autocomplete', 'title', 'for', 'role'];
  const out = [];
  const refOf = new Map();
  const all = document.querySelectorAll('*');
  let i = 0;
  for (const el of all) {
    if (SKIP.has(el.tagName) || el.closest('head')) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const ref = `n${i++}`;
    refOf.set(el, ref);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const attrs = {};
    for (const a of el.attributes) if (KEEP_ATTR.includes(a.name) || a.name.startsWith('aria-')) attrs[a.name] = a.value.slice(0, 120);
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') attrs.value = String(el.value || '').slice(0, 120);
    const role = el.getAttribute('role') || (el.tagName === 'INPUT' ? inputRole(el) : IMPLICIT[el.tagName] || '');
    let name = el.getAttribute('aria-label') || '';
    if (!name && el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) name = l.innerText; }
    if (!name && ['BUTTON', 'A', 'OPTION', 'LABEL', 'SUMMARY'].includes(el.tagName)) name = el.innerText;
    if (!name && el.tagName === 'INPUT') { const l = el.closest('label'); if (l) name = l.innerText; }
    const state = [];
    if (el.disabled) state.push('disabled');
    if (document.activeElement === el) state.push('focused');
    if (el.checked) state.push('checked');
    if (el.selected) state.push('selected');
    if (el.getAttribute('aria-expanded') === 'true') state.push('expanded');
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    let depth = 0; for (let p = el.parentElement; p; p = p.parentElement) depth++;
    out.push({
      ref, tag: el.tagName.toLowerCase(), id: el.id || '', classes: [...el.classList], role, name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      text: own.slice(0, 160), attrs, bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible, state, depth, parent: el.parentElement ? refOf.get(el.parentElement) || null : null, children: el.children.length,
    });
  }
  return out;
}

/** The same elements via CDP, for their backend node ids (to link the accessibility tree). */
function cdpElements(root) {
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BASE']);
  const out = [];
  (function walk(n, inHead, inSvg) {
    if (n.nodeType === 1) {
      const tag = n.nodeName.toUpperCase();
      const head = inHead || tag === 'HEAD';
      if (!SKIP.has(tag) && !head && !(inSvg && tag !== 'SVG')) out.push({ tag: tag.toLowerCase(), backend: n.backendNodeId });
      for (const c of n.children || []) walk(c, head, inSvg || tag === 'SVG');
    } else for (const c of n.children || []) walk(c, inHead, inSvg);
  })(root, false, false);
  return out;
}

function summarizeJson(text) {
  try {
    const j = JSON.parse(text);
    const shape = (v) => (Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 12).join(',')}}` : typeof v);
    const parts = Object.entries(j).map(([k, v]) => `${k}: ${shape(v)}`);
    const first = Array.isArray(j.results) && j.results[0] ? ` · results[0] keys ${Object.keys(j.results[0]).join(',')}` : '';
    return `${parts.join(' · ')}${first}`;
  } catch { return `${String(text).length} chars (not JSON)`; }
}

async function waitFor(fn, ms, step = 250) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); } return false; }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const before = manifest(PROJECT);
  const tHash = Date.now() - t0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toralink-live-'));
  const work = path.join(tmp, 'webapp');
  const state = path.join(tmp, 'state');
  const src = path.join(PROJECT, 'webapp');
  // Only the app's OWN logs/ and dist/ stay behind (a fresh build is made); a package's dist/ is code.
  const skip = new Set([path.join(src, 'logs'), path.join(src, 'dist')]);
  const meta = { project: PROJECT, query: QUERY, port: PORT, chrome: CHROME, hashMs: tHash, files: Object.keys(before).length };
  let browser;
  let server = null;
  let serverLog = '';
  try {
    fs.cpSync(src, work, { recursive: true, filter: (s) => !skip.has(s) });
    const vite = path.join(work, 'node_modules', 'vite', 'bin', 'vite.js');
    const build = spawnSync(process.execPath, [vite, 'build'], { cwd: work, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`vite build failed: ${String(build.stderr).slice(-800)}`);
    const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'production', TORALINK_STATE_DIR: state };
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    if (!(await waitFor(() => /listening on/.test(serverLog), 60000))) throw new Error(`server did not start: ${serverLog.slice(-600)}`);
    const password = (/Default password auto-set: (\S+)/.exec(serverLog) || [])[1];
    if (!password) throw new Error('the temp instance did not seed its default password — refusing to guess one');
    browser = await PW.chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const network = [];
    const consoleLog = [];
    const started = new Map();
    page.on('request', (r) => started.set(r, Date.now()));
    page.on('response', async (res) => {
      const r = res.request();
      const u = new URL(r.url());
      const row = { method: r.method(), url: u.origin === `http://127.0.0.1:${PORT}` ? `${u.pathname}${u.search}` : r.url(), status: res.status(), type: r.resourceType(), ms: started.has(r) ? Date.now() - started.get(r) : null };
      if (/^\/api\//.test(row.url)) { try { const body = await res.text(); row.bytes = body.length; row.body = summarizeJson(body); } catch { /* streamed */ } }
      network.push(row);
    });
    page.on('console', (m) => consoleLog.push({ level: m.type(), text: m.text().slice(0, 400) }));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    const pw = page.locator('input[type=password]');
    if (await pw.count()) {
      await pw.first().fill(password);
      await page.locator('button.btn').first().click();
    }
    await page.locator('input.search-input').waitFor({ timeout: 30000 });
    const settled = async () => { const h = await page.locator('.search-hint').innerText().catch(() => ''); return h && !/Searching|Refreshing/.test(h); };
    await waitFor(settled, 90000, 500);
    meta.initialHint = await page.locator('.search-hint').innerText().catch(() => '');
    await page.locator('input.search-input').fill(QUERY);
    await page.locator('input.search-input').press('Enter');
    await waitFor(async () => /Searching|Refreshing/.test(await page.locator('.search-hint').innerText().catch(() => '')), 5000, 100);
    await waitFor(settled, 120000, 500);
    await page.waitForTimeout(500);
    meta.hint = await page.locator('.search-hint').innerText().catch(() => '');
    meta.results = await page.locator('div.result').count();
    const nodes = await page.evaluate(walkDom);
    // ACCESSIBILITY, linked by backend node id where the two walks agree element for element.
    const cdp = await context.newCDPSession(page);
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
    const els = cdpElements(doc.root);
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const axBy = new Map(ax.nodes.filter((n) => n.backendDOMNodeId).map((n) => [n.backendDOMNodeId, n]));
    meta.axLinked = els.length === nodes.length && els.every((e, k) => e.tag === nodes[k].tag);
    if (meta.axLinked) {
      nodes.forEach((n, k) => {
        const a = axBy.get(els[k].backend);
        if (a && !a.ignored) n.ax = { role: (a.role && a.role.value) || '', name: (a.name && a.name.value) || '' };
      });
    }
    meta.axNodes = ax.nodes.length;
    const cookies = (await context.cookies()).map((c) => c.name);
    const runtime = await page.evaluate(() => ({ location: location.href, title: document.title, readyState: document.readyState, viewport: `${innerWidth}×${innerHeight}`, localStorageKeys: Object.keys(localStorage), activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : '' }));
    await page.screenshot({ path: path.join(OUT, 'screenshot.png') });
    const snapshot = {
      kind: 'dom', url: `http://127.0.0.1:${PORT}/`, capturedAt: new Date().toISOString(), viewport: { width: 1280, height: 900 },
      nodes,
      network: network.filter((r) => !/favicon/.test(r.url)),
      console: consoleLog,
      runtime: {
        ...runtime, cookieNames: cookies,
        server: `node --import tsx server/index.ts (Express, NODE_ENV=production) on :${PORT}; serves the built client from dist/client and /api/* on the same origin`,
        searchFlow: 'the search form submits on Enter (no submit button); the client calls GET /api/search?q=… on the same origin',
        query: QUERY, hintAfterSearch: meta.hint, resultsRendered: meta.results,
      },
    };
    fs.writeFileSync(path.join(OUT, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
    // GROUND TRUTH — fixed selectors decided from the source BEFORE any model saw anything.
    const pick = (fn) => nodes.filter(fn).map((n) => n.ref);
    const has = (n, c) => (n.classes || []).includes(c);
    const byRef = new Map(nodes.map((n) => [n.ref, n]));
    const inSearchbar = (n) => { for (let p = byRef.get(n.parent); p; p = byRef.get(p.parent)) if (has(p, 'searchbar')) return true; return false; };
    const truth = {
      T1_search_input: pick((n) => n.tag === 'input' && has(n, 'search-input')),
      T2_search_submit: pick((n) => n.tag === 'form' && inSearchbar(n)),
      T3_source_control: pick((n) => (n.tag === 'select' && has(n, 'sort-select')) || (n.tag === 'button' && has(n, 'notice-action'))),
      T4_status_surface: pick((n) => has(n, 'search-hint') || (has(n, 'notice-banner') && has(n, 'subtle')) || has(n, 'error-banner')),
      T5_results_container: pick((n) => n.tag === 'div' && has(n, 'results')),
      T6_result_item: pick((n) => n.tag === 'div' && has(n, 'result')),
      T7_download_action: pick((n) => n.tag === 'button' && has(n, 'dl-btn')),
      T8_search_endpoint: snapshot.network.filter((r) => /^\/api\/search\b/.test(r.url)).map((r) => `${r.method} ${r.url}`),
    };
    fs.writeFileSync(path.join(OUT, 'truth.json'), JSON.stringify(truth, null, 1));
    meta.nodes = nodes.length;
    meta.visibleNodes = nodes.filter((n) => n.visible).length;
    meta.renderedChars = null;
    meta.networkRows = snapshot.network.length;
    meta.truthCounts = Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, v.length]));
  } finally {
    if (browser) await browser.close().catch(() => null);
    if (server) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F']); } catch { server.kill(); } }
    await new Promise((r) => setTimeout(r, 800));
    meta.serverLogTail = serverLog.replace(/password[^\n]*/gi, 'password <redacted>').slice(-1500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { meta.cleanup = String(e.message); }
    const after = manifest(PROJECT);
    meta.projectDiff = diff(before, after);
    meta.byteIdentical = !meta.projectDiff.added.length && !meta.projectDiff.removed.length && !meta.projectDiff.modified.length;
    meta.wallMs = Date.now() - t0;
    fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
    console.log(JSON.stringify({ out: OUT, nodes: meta.nodes, results: meta.results, hint: meta.hint, axLinked: meta.axLinked, truth: meta.truthCounts, byteIdentical: meta.byteIdentical, wallMs: meta.wallMs }, null, 1));
    if (!meta.byteIdentical) process.exitCode = 3;
  }
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
