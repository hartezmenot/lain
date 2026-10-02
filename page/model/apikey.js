'use strict';

/**
 * ADD AN API KEY — the window's half of Core's accountops.js.
 *
 *   ┌ Add an API key ─────────────────────────────┐
 *   │ Provider   [ OpenAI / Codex            ▾ ]   │
 *   │ API key    [ ••••••••••••••••••  ] [Show]    │  Get a key ↗
 *   │ Base URL   [ https://…                  ]    │  (only when needed)
 *   │ Checking the key with OpenAI…                │
 *   │                          [Cancel] [Add key]  │
 *   └─────────────────────────────────────────────┘
 *
 * THE KEY GOES TO CORE ONCE, and Core proves it (a catalog read, no tokens
 * spent) before keeping it; a refused key is not stored and the dialog stays
 * open with the provider's own words. What comes back is the key's shape
 * (`sk-…9f2a`), never the key. The field is cleared when the dialog closes.
 *
 * "GET A KEY" OPENS THE PROVIDER'S OWN PAGE IN THE PERSON'S BROWSER through the
 * native host's `openExternal`, which opens http(s) addresses only. LAIN never
 * shows a provider's sign-in page inside its own window, and never asks for a
 * provider password.
 */

const CSS = `
.keydlg select,.keydlg input{width:100%;min-width:0}
.keydlg .dlg-line{display:flex;gap:6px;align-items:center}
.keydlg .klink{font-size:12px;color:var(--accent-primary);background:none;border:0;padding:0;cursor:pointer}
.keydlg .klink:hover{text-decoration:underline}
.keydlg .kstate{min-height:18px;font-size:12.5px;color:var(--text-secondary);margin:-4px 0 10px}
.keydlg .kstate.bad{color:var(--danger)}
.keydlg .kfine{font-size:11.5px;color:var(--text-muted);margin:0 0 12px}
`;

function client() {
  var L = window.LAIN;
  var el = function (t, c, x) { return L.el(t, c, x); };

  /** A web address, in the person's default browser. Never inside LAIN. */
  async function openExternal(url) {
    var r = await L.hostCall('openExternal', { url: url });
    if (r && r.ok) return true;
    if (r && r.why) { L.toast(r.why, true); return false; }
    // An older host has no such verb: say where to go instead of failing silently.
    L.toast('Open this address in your browser: ' + url, true);
    return false;
  }

  async function addKey(preset) {
    var got = await L.api('/api/accounts/choices', {});
    var list = (got && got.ok && got.providers) || [];
    if (!list.length) { L.toast((got && got.why) || 'No providers are known to this build.', true); return null; }
    return new Promise(function (resolve) {
      var back = el('div', 'dlg-back');
      var box = el('div', 'dlg keydlg');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Add an API key');
      box.appendChild(el('h3', '', 'Add an API key'));
      var field = function (label, input, extra) {
        var row = el('label', 'dlg-field');
        row.appendChild(el('span', '', label));
        var line = el('div', 'dlg-line');
        line.appendChild(input);
        if (extra) line.appendChild(extra);
        row.appendChild(line);
        box.appendChild(row);
        return row;
      };
      var sel = document.createElement('select');
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.host ? ' — ' + p.host : '');
        sel.appendChild(o);
      });
      if (preset && list.some(function (p) { return p.id === preset; })) sel.value = preset;
      field('Provider', sel);
      var key = document.createElement('input');
      key.type = 'password';
      key.autocomplete = 'off';
      key.spellcheck = false;
      key.placeholder = 'Paste the key';
      var show = el('button', 'btn small', 'Show');
      show.type = 'button';
      show.onclick = function () { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; key.focus(); };
      field('API key', key, show);
      var link = el('button', 'klink', 'Get a key ↗');
      link.type = 'button';
      box.appendChild(link);
      var url = document.createElement('input');
      url.spellcheck = false;
      url.placeholder = 'https://api.example.com/v1';
      var urlRow = field('Base URL', url);
      var state = el('div', 'kstate', '');
      box.appendChild(state);
      box.appendChild(el('div', 'kfine', 'LAIN checks the key with the provider before keeping it, stores it in its own config, and never shows it again — only its first and last characters.'));
      var pick = function () { return list.filter(function (p) { return p.id === sel.value; })[0] || list[0]; };
      var sync = function () {
        var p = pick();
        urlRow.hidden = !p.needsBaseUrl;
        link.hidden = !p.keysUrl;
        link.onclick = function () { if (p.keysUrl) openExternal(p.keysUrl); };
        state.textContent = ''; state.className = 'kstate';
      };
      sel.onchange = sync;
      sync();
      var acts = el('div', 'dlg-actions');
      var cancel = el('button', 'btn', 'Cancel');
      var go = el('button', 'btn primary', 'Add key');
      acts.appendChild(cancel); acts.appendChild(go);
      box.appendChild(acts);
      back.appendChild(box);
      var busy = false;
      var finish = function (v) {
        key.value = '';            // the secret does not outlive the dialog
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      var submit = async function () {
        if (busy) return;
        var p = pick();
        busy = true; go.disabled = true; sel.disabled = true;
        state.className = 'kstate'; state.textContent = 'Checking the key with ' + p.label + '…';
        var r = await L.api('/api/accounts/addkey', { provider: p.id, key: key.value, baseUrl: p.needsBaseUrl ? url.value : '' });
        busy = false; go.disabled = false; sel.disabled = false;
        if (!r || !r.ok) { state.className = 'kstate bad'; state.textContent = (r && r.why) || 'The key was not added.'; key.focus(); return; }
        L.toast((r.replaced ? 'Replaced the key for ' : 'Added ') + r.label + ' · ' + r.key + ' · ' + r.models + ' model' + (r.models === 1 ? '' : 's'));
        if (L.intel) L.intel.load(true); if (L.dash) L.dash.load(true);
        finish(r);
      };
      var onKey = function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); if (!busy) finish(null); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
      };
      cancel.onclick = function () { if (!busy) finish(null); };
      go.onclick = submit;
      back.addEventListener('mousedown', function (e) { if (e.target === back && !busy) finish(null); });
      document.body.appendChild(back);
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { (preset ? key : sel).focus(); }, 0);
    });
  }

  /** Test a stored route: a catalog read, no tokens spent. */
  async function testRoute(id) {
    L.toast('Checking ' + id + '…');
    var r = await L.api('/api/accounts/test', { id: id });
    if (r && r.ok) L.toast(id + ' answered · ' + r.models + ' model' + (r.models === 1 ? '' : 's'));
    else L.toast(id + ': ' + ((r && r.why) || 'no answer'), true);
    if (L.intel) L.intel.load(true); if (L.dash) L.dash.load(true);
  }

  /** Remove a stored route — Core asks first, and says what would go. */
  async function removeRoute(id) {
    var ask = await L.api('/api/accounts/remove', { id: id });
    if (!ask || !ask.ok) { L.toast((ask && ask.why) || 'It cannot be removed here.', true); return; }
    var im = ask.impact || {};
    var text = 'Remove ' + id + '? Its stored key is deleted from LAIN’s config'
      + (im.models ? ', and its ' + im.models + ' model' + (im.models === 1 ? '' : 's') + ' leave the model list' : '') + '.'
      + (im.usedBy && im.usedBy.length ? '\n\nIt is currently ' + im.usedBy.join(' and ') + '.' : '');
    if (!(await L.confirm(text, { ok: 'Remove', danger: true }))) return;
    var r = await L.api('/api/accounts/remove', { id: id, token: ask.token });
    if (!r || !r.ok) { L.toast((r && r.why) || 'It was not removed.', true); return; }
    L.toast('Removed ' + id);
    if (L.intel) L.intel.load(true); if (L.dash) L.dash.load(true);
  }

  L.keys = { add: addKey, test: testRoute, remove: removeRoute };
  L.openExternal = openExternal;
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
