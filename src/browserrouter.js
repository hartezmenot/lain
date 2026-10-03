'use strict';

/** ONE FRONT DOOR, THREE BROWSERS (§21). */

const BACKEND = Object.freeze({ CHROME: 'chrome', WORKSHOP: 'workshop', ISOLATED: 'isolated' });

function chromeStatus(app) {
  const bridge = require('./lainchrome').existing(app);
  const s = bridge ? bridge.status() : { connected: false, authorizedTabs: [] };
  return { connected: Boolean(s.connected && s.extensionSeen !== false), tabs: (s.authorizedTabs || []).length, list: s.authorizedTabs || [] };
}

function devUrl(app) {
  try {
    const w = app && app._workshop;   // only a workshop this session already opened; never started here
    const s = w && typeof w.status === 'function' ? w.status() : null;
    return (s && (s.url || (s.devServer && s.devServer.url))) || null;
  } catch { return null; }
}

function status(app) {
  const chrome = chromeStatus(app);
  const workshop = devUrl(app);
  const current = app._browserCurrent || (chrome.list[0] ? { url: chrome.list[0].url, title: chrome.list[0].title } : (workshop ? { url: workshop } : null));
  return { chrome, workshop, current };
}

const LOCAL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

/** Which backend answers this target. Deterministic, and explained. */
function choose(app, { target = '', scope = '' } = {}) {
  const t = String(target || '').trim();
  const chrome = chromeStatus(app);
  const wantsUsers = /\b(?:my|user'?s?|current|chrome|open) (?:browser|tab|page)\b|^current$|^chrome$/i.test(t) || /user/i.test(scope);
  if (chrome.connected && (wantsUsers || chrome.list.some((x) => x.url && t && x.url.startsWith(t)))) {
    return { backend: BACKEND.CHROME, why: 'the page is in your Chrome, through the extension' };
  }
  const dev = devUrl(app);
  if ((dev && (!t || LOCAL.test(t) || /frontend|dev ?server|app/i.test(t))) || (LOCAL.test(t) && /frontend/i.test(scope))) {
    return { backend: BACKEND.WORKSHOP, why: 'the frontend dev server, through the Frontend Workshop', url: LOCAL.test(t) ? t : dev };
  }
  return { backend: BACKEND.ISOLATED, why: 'an isolated browser for verification', url: t };
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s || /^current$/i.test(s)) return '';
  return /^[a-z]+:\/\//i.test(s) ? s : (LOCAL.test(s) ? `http://${s}` : `https://${s}`);
}

async function viaChrome(app) {
  const bridge = require('./lainchrome').existing(app);
  if (!bridge) return { ok: false, why: 'LAIN for Chrome is not connected — /browser connect' };
  const nav = await bridge.request('nav_state', {});
  const found = await bridge.request('find', { query: '' });
  const text = await bridge.request('text', {});
  return {
    ok: Boolean(nav && nav.ok !== false),
    url: (nav && nav.url) || '', title: (nav && nav.title) || '',
    dom: String((found && (found.summary || found.outline)) || '').slice(0, 3000),
    text: String((text && text.text) || '').slice(0, 2000),
    console: [], network: [], viewport: (nav && nav.viewport) || null,
    why: nav && nav.ok === false ? nav.error : '',
  };
}

async function viaHarness(app, url) {
  const h = require('./harnesslink').harnessFor(app);
  if (!h) return { ok: false, why: 'no browser harness is available in this session' };
  const id = h.runtime && h.runtime.activeId;
  // `page` answers `title :: url`; the `body` element carries the visible text
  // and size; `errors` carries the console lines themselves. Measured shapes.
  const page = await h.observe('page', { url }, id);
  const body = page && page.ok ? await h.observe('element', { url, selector: 'body' }, id) : null;
  const errs = page && page.ok ? await h.observe('errors', { url }, id) : null;
  const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(String(v || '')); } catch { return null; } };
  const b = parse(body && body.ok ? body.value : null) || {};
  const head = String((page && (page.summary || page.value)) || '');
  const title = head.includes(' :: ') ? head.split(' :: ')[0] : '';
  const lines = errs && errs.ok ? String(errs.value || '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
  return {
    ok: Boolean(page && page.ok),
    url, title,
    dom: b.text ? `body${b.visible === false ? ' (hidden)' : ''}: ${String(b.text).replace(/\s+/g, ' ').slice(0, 2500)}` : head.slice(0, 3000),
    console: lines.slice(0, 20),
    network: lines.filter((l) => /\b(failed|net::|ERR_|404|500|503)\b/i.test(l)).slice(0, 10),
    viewport: b.rect ? { width: b.rect.w, height: b.rect.h } : null,
    why: page && !page.ok ? page.why : '',
  };
}

/** Look, for real, and return evidence. */
async function inspect(app, { target = '', scope = '' } = {}) {
  const pick = choose(app, { target, scope });
  const custom = app && app._browserBackends && app._browserBackends[pick.backend];
  const url = normalizeUrl(pick.url || target);
  let r;
  try {
    if (custom) r = await custom({ target, scope, url });
    else if (pick.backend === BACKEND.CHROME) r = await viaChrome(app);
    else if (!url) r = { ok: false, why: 'no page to look at: name a URL, start the dev server, or connect Chrome (/browser connect)' };
    else r = await viaHarness(app, url);
  } catch (e) {
    r = { ok: false, why: (e && e.message) || String(e) };
  }
  const out = { backend: pick.backend, route: pick.why, url, title: '', dom: '', console: [], network: [], viewport: null, ...r };
  if (out.ok && app) app._browserCurrent = { url: out.url, title: out.title, backend: out.backend };
  return out;
}

module.exports = { BACKEND, status, choose, inspect, normalizeUrl };
