'use strict';

function send(msg) { return chrome.runtime.sendMessage(msg); }

async function render() {
  const s = await send({ type: 'lain-status' });
  const statusEl = document.getElementById('status');
  const connectForm = document.getElementById('connectForm');
  const connectedPanel = document.getElementById('connectedPanel');

  if (!s.token) {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'status';
    connectForm.style.display = '';
    connectedPanel.style.display = 'none';
    return;
  }

  statusEl.textContent = `Connected · ${s.authorizedTabIds.length} tab(s) authorized`;
  statusEl.className = 'status connected';
  connectForm.style.display = 'none';
  connectedPanel.style.display = '';

  const list = document.getElementById('authorizedList');
  list.innerHTML = '';
  for (const id of s.authorizedTabIds) {
    let tab;
    try { tab = await chrome.tabs.get(id); } catch { continue; }
    const row = document.createElement('div');
    row.className = 'tab-row';
    row.textContent = tab.title || tab.url;
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.onclick = async () => { await send({ type: 'lain-revoke-tab', tabId: id }); render(); };
    row.appendChild(revoke);
    list.appendChild(row);
  }
}

document.getElementById('connectBtn').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  if (!token) return;
  const r = await send({ type: 'lain-connect', token });
  if (!r.ok) { alert(`Could not connect: ${r.error}`); return; }
  render();
});

document.getElementById('authorizeBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // SITE ACCESS FOR THIS TAB'S ORIGIN, asked in the same click — the one user
  // gesture Chrome accepts. Without it the content script cannot be injected
  // and LAIN could reach the tab but not the page (background.js toContent).
  try {
    const origin = new URL(tab.url).origin;
    if (/^https?:/.test(origin)) await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch { /* a page Chrome does not let extensions touch; ops will say so */ }
  await send({ type: 'lain-authorize-tab', tabId: tab.id });
  render();
});

document.getElementById('disconnectBtn').addEventListener('click', async () => {
  await send({ type: 'lain-disconnect' });
  render();
});

render();
