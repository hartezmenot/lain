'use strict';

/**
 * LAIN for Chrome — background service worker.
 *
 * Owns the connection to the local LAIN bridge (src/lainchrome.js) and the
 * one piece of state that actually matters for safety: which tabs the
 * person has explicitly authorized. Nothing is dispatched to a tab that
 * is not in `authorizedTabIds` — that check happens HERE, not on the LAIN
 * side, because the extension is the one thing that can see the real tab
 * list and the person's own clicks in the popup.
 *
 * chrome.storage.session (not .local) on purpose: it clears when the browser
 * closes, so a token from a previous browser session can never be replayed
 * by a LAIN process that outlived it.
 */

const LAIN_ORIGIN = 'http://127.0.0.1:8934';
let polling = false;

async function getState() {
  const s = await chrome.storage.session.get(['token', 'authorizedTabIds']);
  return { token: s.token || null, authorizedTabIds: new Set(s.authorizedTabIds || []) };
}

async function setToken(token) {
  await chrome.storage.session.set({ token });
}

async function setAuthorized(ids) {
  await chrome.storage.session.set({ authorizedTabIds: [...ids] });
}

async function reportAuthorizedTabs() {
  const { token, authorizedTabIds } = await getState();
  if (!token) return;
  const tabs = [];
  for (const id of authorizedTabIds) {
    try { const t = await chrome.tabs.get(id); tabs.push({ id, url: t.url, title: t.title }); }
    catch { authorizedTabIds.delete(id); } // the tab closed — drop it silently
  }
  await setAuthorized(authorizedTabIds);
  await fetch(`${LAIN_ORIGIN}/lain-chrome/tabs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, tabs }),
  }).catch(() => { /* LAIN may not be listening right now; the next report retries */ });
}

async function register(token) {
  const r = await fetch(`${LAIN_ORIGIN}/lain-chrome/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error || 'registration refused');
  await setToken(token);
  await reportAuthorizedTabs();
  startPolling();
  return body;
}

async function authorizeTab(tabId) {
  const { authorizedTabIds } = await getState();
  authorizedTabIds.add(tabId);
  await setAuthorized(authorizedTabIds);
  await reportAuthorizedTabs();
}

async function revokeTab(tabId) {
  const { authorizedTabIds } = await getState();
  authorizedTabIds.delete(tabId);
  await setAuthorized(authorizedTabIds);
  await reportAuthorizedTabs();
}

async function disconnect() {
  const { token } = await getState();
  polling = false;
  await chrome.storage.session.clear();
  if (token) {
    await fetch(`${LAIN_ORIGIN}/lain-chrome/disconnect`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    }).catch(() => { /* best effort — clearing local state is what actually matters */ });
  }
}

/**
 * THE CONTENT SCRIPT, INJECTED WHEN IT IS NEEDED.
 *
 * Nothing declared it and nothing injected it, so on a real Chrome every DOM op
 * failed with "Could not establish connection. Receiving end does not exist"
 * (Chrome 153, 2026-09-19) — the fixture-level tests never had a page. It is
 * injected into an AUTHORIZED tab only, only when no listener answers (a fresh
 * page or a navigation — so it is never registered twice), using the site
 * access the person granted when they authorized the tab (popup.js).
 */
async function toContent(tabId, command) {
  try { return await chrome.tabs.sendMessage(tabId, command); } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e && e.message))) {
      return { ok: false, error: `content script unreachable: ${e.message}` };
    }
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (inj) {
    return { ok: false, error: `LAIN for Chrome cannot reach this page (${inj.message}). Authorize the tab again from the popup to grant access to its site.` };
  }
  try { return await chrome.tabs.sendMessage(tabId, command); } catch (e2) {
    return { ok: false, error: `content script unreachable after injection: ${e2.message}` };
  }
}

/** EVERY DOM OP GOES THROUGH THE AUTHORIZATION CHECK, HERE, BEFORE THE TAB EVER SEES IT. */
async function dispatch(command) {
  const { authorizedTabIds } = await getState();
  const tabOps = new Set(['find', 'text', 'click', 'type', 'key', 'scroll', 'focus', 'submit']);
  let tabId = command.params && command.params.tabId;
  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active && active.id;
  }
  if (tabOps.has(command.op)) {
    if (!tabId || !authorizedTabIds.has(tabId)) {
      return { ok: false, error: 'that tab is not authorized — open the LAIN for Chrome popup and authorize it first' };
    }
    return toContent(tabId, command);
  }
  switch (command.op) {
    case 'tabs': {
      const tabs = [];
      for (const id of authorizedTabIds) { try { const t = await chrome.tabs.get(id); tabs.push({ id, url: t.url, title: t.title }); } catch { /* gone */ } }
      return { ok: true, tabs };
    }
    case 'active_tab': {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active || !authorizedTabIds.has(active.id)) return { ok: false, error: 'the active tab is not authorized' };
      return { ok: true, id: active.id, url: active.url, title: active.title };
    }
    case 'switch_tab':
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true, summary: `switched to tab ${tabId}` };
    case 'open_tab': {
      const created = await chrome.tabs.create({ url: command.params.url, active: false });
      return { ok: true, summary: `opened tab ${created.id} — not authorized until you authorize it in the popup`, id: created.id };
    }
    case 'close_tab':
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      await chrome.tabs.remove(tabId);
      await revokeTab(tabId);
      return { ok: true, summary: `closed tab ${tabId}` };
    case 'navigate':
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      await chrome.tabs.update(tabId, { url: command.params.url });
      return { ok: true, summary: `navigating to ${command.params.url}` };
    case 'back':
    case 'forward':
    case 'reload':
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      if (command.op === 'reload') await chrome.tabs.reload(tabId);
      else await chrome.scripting.executeScript({ target: { tabId }, func: (dir) => window.history[dir](), args: [command.op === 'back' ? 'back' : 'forward'] });
      return { ok: true, summary: command.op };
    case 'nav_state': {
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      const t = await chrome.tabs.get(tabId);
      return { ok: true, url: t.url, title: t.title, status: t.status };
    }
    case 'screenshot': {
      if (!authorizedTabIds.has(tabId)) return { ok: false, error: 'that tab is not authorized' };
      const win = await chrome.tabs.get(tabId).then((t) => t.windowId);
      // Chrome grants screenshots only through activeTab — the person clicking
      // the LAIN for Chrome icon on this tab — and a navigation revokes it. Say
      // exactly that, rather than Chrome's permission-name error.
      const dataUrl = await chrome.tabs.captureVisibleTab(win, { format: 'png' }).catch((e) => ({ error: e.message }));
      if (dataUrl && dataUrl.error) {
        return { ok: false, error: `screenshot needs Chrome's per-tab grant: click the LAIN for Chrome icon while this tab is showing (it lasts until the tab navigates). Chrome said: ${dataUrl.error}` };
      }
      return { ok: true, dataUrl };
    }
    default:
      return { ok: false, error: `background does not handle op "${command.op}"` };
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    const { token } = await getState();
    if (!token) { polling = false; break; }
    let body;
    try {
      const r = await fetch(`${LAIN_ORIGIN}/lain-chrome/poll?token=${encodeURIComponent(token)}`);
      body = await r.json();
    } catch {
      await new Promise((res) => setTimeout(res, 2000)); // LAIN not reachable right now — back off, keep trying
      continue;
    }
    if (body && body.command) {
      const result = await dispatch(body.command).catch((e) => ({ ok: false, error: e.message }));
      await fetch(`${LAIN_ORIGIN}/lain-chrome/result`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, id: body.command.id, result }),
      }).catch(() => { /* the next poll cycle will still show LAIN this session is alive */ });
    }
  }
}

function startPolling() { pollLoop(); }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'lain-connect') register(msg.token).then((r) => sendResponse({ ok: true, r })).catch((e) => sendResponse({ ok: false, error: e.message }));
  else if (msg.type === 'lain-disconnect') disconnect().then(() => sendResponse({ ok: true }));
  else if (msg.type === 'lain-authorize-tab') authorizeTab(msg.tabId).then(() => sendResponse({ ok: true }));
  else if (msg.type === 'lain-revoke-tab') revokeTab(msg.tabId).then(() => sendResponse({ ok: true }));
  else if (msg.type === 'lain-status') getState().then((s) => sendResponse({ token: Boolean(s.token), authorizedTabIds: [...s.authorizedTabIds] }));
  else return false;
  return true; // async sendResponse
});

// Resume polling across service-worker wake-ups — MV3 suspends this file
// between events, so "already connected" must be re-derived from storage,
// never assumed to still be running in memory.
getState().then((s) => { if (s.token) startPolling(); });

// ---- AND SOMETHING MUST WAKE IT ------------------------------------------
//
// Resuming "on wake-up" assumed an event would come. Chrome suspends an idle
// MV3 worker, and a suspended poller receives nothing — so once the worker was
// stopped, every LAIN request timed out ("no answer from the extension within
// 15000ms") until the person happened to open the popup. A 30-second alarm is
// the documented way to be woken: it restarts the poll loop if it is not
// running, and does nothing when it is. No connection, no polling.
chrome.alarms.create('lain-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'lain-keepalive') return;
  getState().then((s) => { if (s.token) startPolling(); });
});
