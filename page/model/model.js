'use strict';

/**
 * MODEL — what LAIN can use: accounts, models, APIs, local models, defaults.
 *
 *   Accounts   one flat PLANE per provider — Codex a shade of blue, Claude of
 *              violet, Antigravity of teal — its accounts as rows directly on it:
 *              name, masked identity, the windows the provider reported (what
 *              REMAINS). "N accounts need setup" is a notice that opens Setup;
 *              it never replaces the accounts.
 *   Setup      its own page: accounts found or imported that are not usable yet,
 *              each with the factual reason (migration class) and one action
 *   Models     the logical catalog, by provider
 *   API        API sources — the one place a key is entered (Z.ai is here: LAIN
 *              integrates Z.ai through its API)
 *   Local      llama.cpp, Ollama, model directories
 *   Defaults   what each kind of work starts with
 *
 * Every tab is drawn from the ONE Core-owned fabric (/api/intel/*, model/dashboard.js;
 * Local is model/local.js). SELECTING IS PASSIVE: nothing here sends a request to a model.
 */

const HTML = `
<section class="view modelv" id="vModel" data-view="model" hidden>
  <div class="mpane u-scroll" id="modelPane"></div>
</section>`;

const CSS = `
.modelv{display:flex;flex-direction:column;min-height:0;height:100%}
.mpane{flex:1;min-height:0;overflow-y:auto}
.mbody{min-width:0;display:flex;flex-direction:column;gap:12px}
/* EVERY TOP-LEVEL SECTION IS A PLANE: flat, a step lighter than the page, small corners, no border, no shadow. */
.mbody > .u-sec,.mbody > * > .u-sec.dsh-prov{background:var(--surface-base);border-radius:var(--radius-md);padding:14px 18px 8px;margin:0}
.mbody > .u-sec + .u-sec{margin-top:0}
.mbody > .u-sec.flat{background:transparent;padding:0}
/* PROVIDER TINTS — a few degrees of hue, never saturation. */
.mbody .u-sec[data-sec$=codex]{background:var(--plane-blue)}
.mbody .u-sec[data-sec$=claude]{background:var(--plane-violet)}
.mbody .u-sec[data-sec$=antigravity]{background:var(--plane-teal)}
.mbody .u-sec[data-sec$=opencode]{background:var(--plane-amber)}
.mbody .u-sec[data-sec$=local],.mbody .u-sec[data-sec=ollama],.mbody .u-sec[data-sec=llamacpp]{background:var(--plane-rose)}
/* A PROVIDER'S HEADER: the name as a label, the count under it, its policy and "+ Account" on the right. */
.dsh-prov > .u-sech h3{font-size:12.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.dsh-prov .u-row + .u-row{border-top-color:color-mix(in srgb,var(--text-primary) 9%,transparent)}
.dsh-provs{display:flex;flex-direction:column;gap:12px}
.mnotes{display:flex;flex-direction:column;gap:6px}
@media (max-width: 820px){.mbody > .u-sec,.mbody > * > .u-sec.dsh-prov{padding:12px 12px 6px}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var $ = L.$, el = L.el;
  var U = L.kit;
  var section = 'accts';

  // THE FIVE TABS, and which tab a sub-surface belongs to (Setup, Connect, Import and Discovered start from Accounts).
  var TABS = [['accts', 'Accounts'], ['mdl', 'Models'], ['api', 'API'], ['local', 'Local'], ['defaults', 'Defaults']];
  function tabOf(sec) {
    if (sec === 'mdl' || sec === 'models') return 'mdl';
    if (sec === 'api') return 'api';
    if (sec === 'local' || sec === 'runtimes') return 'local';
    if (sec === 'defaults' || sec === 'overview') return 'defaults';
    return 'accts';
  }
  var SUBTITLE = {
    accts: 'Your provider accounts and what each has left. Shared by Chat, the IDE, the CLI and Telegram.',
    mdl: 'Every model your accounts, APIs and local runtimes offer.',
    api: 'API sources. A key is entered here and nowhere else; it goes straight to the Windows secret store.',
    local: 'Models that run on this PC.',
    defaults: 'What each kind of work starts with when a session has not chosen.',
  };
  var connectFocus = null;

  // ---- SECURITY: plaintext keys still in config (reached from Settings) ------------------------------------
  async function security(pane) {
    var sec = U.section({ id: 'security', title: 'Security', meta: 'Where Noema keeps credentials. Keys live in the Windows secret store; config.json holds only a reference.' });
    var r = await L.api('/api/security/legacy-keys', {});
    var keys = (r && r.keys) || [];
    sec.appendChild(el('p', 'u-note', keys.length ? keys.length + ' legacy key(s) remain in config.json' : 'No plaintext keys in config.json'));
    keys.forEach(function (k) { sec.appendChild(el('div', 'u-note', k.id + ' · ' + k.provider + ' · ' + k.masked)); });
    if (keys.length) {
      var b = U.button('Move to the Windows secret store', 'pri', async function () {
        b.disabled = true;
        var m = await L.api('/api/security/migrate-keys', {});
        L.toast(m.ok ? m.migrated + ' key(s) moved; each was read back and verified before config was changed.' : (m.failed + ' key(s) could not be moved — left in config untouched.'), !m.ok);
        draw();
      });
      sec.appendChild(b);
    }
    pane.appendChild(sec);
  }

  var redrawLater = null;
  function draw() {
    if (L.nav.tab() !== 'model') return;
    // A MENU IS OPEN: a redraw would remove the control it is anchored to. The page is redrawn a moment after it closes.
    if (L.popDepth && L.popDepth() > 0) { clearTimeout(redrawLater); redrawLater = setTimeout(draw, 400); return; }
    // A ROW IS BEING DRAGGED (dashboard.js wireDrag): the rows under the pointer stay until it is released.
    if (L.dragging) { clearTimeout(redrawLater); redrawLater = setTimeout(draw, 250); return; }
    var pane = $('modelPane');
    var keep = pane.scrollTop;
    pane.textContent = '';
    if (section === 'models') section = 'mdl';
    if (section === 'overview') section = 'defaults';
    if (['accts', 'connect', 'import', 'setup', 'discovered', 'mdl', 'api', 'local', 'runtimes', 'security', 'defaults'].indexOf(section) < 0) section = 'accts';
    var page = el('div', 'u-page');
    var tab = tabOf(section);
    page.appendChild(U.head('Model', SUBTITLE[tab], L.dash ? L.dash.actions(section) : []));
    var tabs = U.tabs(TABS, tab, function (id) { section = id; draw(); });
    tabs.id = 'modelTabs';
    page.appendChild(tabs);
    var body = el('div', 'mbody');
    body.setAttribute('data-section', section);
    page.appendChild(body);
    pane.appendChild(page);
    if (section === 'accts') L.dash.accounts(body);
    else if (section === 'connect') L.dash.connect(body, connectFocus);
    else if (section === 'import') L.dash.importView(body);
    else if (section === 'setup') L.dash.setup(body);
    else if (section === 'discovered') L.dash.discoveredView(body);
    else if (section === 'mdl') L.dash.models(body);
    else if (section === 'api') L.dash.api(body);
    else if (section === 'defaults') L.dash.defaults(body);
    else if (section === 'local') L.local.renderLocal(body);
    else if (section === 'runtimes') L.local.renderRuntimes(body);
    else if (section === 'security') security(body);
    pane.scrollTop = keep;
  }

  L.modelView = { draw: function () { draw(); }, go: function (sec, item) { section = sec; connectFocus = item || null; draw(); }, section: function () { return section; } };
  L.onBoot(function () {
    L.nav.onShow('model', function (o) {
      connectFocus = null;
      if (o && (o.section === 'accounts' || o.section === 'signins' || o.section === 'accts' || o.section === 'instances' || o.section === 'sources')) section = 'accts';
      else if (o && o.section === 'models') section = 'mdl';
      else if (o && (o.section === 'roles' || o.section === 'defaults')) section = 'defaults';
      else if (o && (o.section === 'add' || o.section === 'connect')) { section = 'connect'; connectFocus = o.item || null; }
      else if (o && ['import', 'setup', 'discovered', 'runtimes', 'local', 'security', 'api', 'mdl'].indexOf(o.section) >= 0) section = o.section;
      else if (o && o.section) section = 'accts';
      if (L.dash) L.dash.load();
      if (L.local && !L.local.get().data && !L.local.get().loading && (section === 'local' || section === 'runtimes')) L.local.load();
      draw();
    });
    if (L.local) L.local.on(function () { if (section === 'local' || section === 'runtimes') draw(); });
  });
  var lastSig = '';
  L.onRender(function (S) {
    if (L.nav.tab() !== 'model') return;
    var sig = JSON.stringify([S.models && S.models.chat && S.models.chat.display, S.models && S.models.coding && S.models.coding.display]);
    if (sig !== lastSig) { lastSig = sig; draw(); }
  });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { HTML, CSS, js, client };
