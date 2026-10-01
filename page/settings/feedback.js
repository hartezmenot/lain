'use strict';

/**
 * SEND FEEDBACK (Phase 8) — the drawing half of Core's feedback.js.
 *
 *   LAIN.feedback.open({type})   the dialog (Help › Send Feedback, the rail)
 *   Settings › Feedback          the same form, in the pane
 *
 * THE PERSON DECIDES WHAT GOES. Every attachment is a checkbox, off until
 * ticked: app version, the current surface, recent errors (anonymised),
 * runtime status, a screenshot of this window, recent request outcomes (no
 * prompts). API keys, tokens, provider credentials, project source, private
 * prompts and conversations are never attached — Core refuses a report that
 * looks like it carries a secret. Submit is only possible after Review, which
 * shows exactly what will be saved.
 */

const CSS = `
.fbk{display:flex;flex-direction:column;gap:14px;min-width:0}
.fbk .types{display:flex;flex-wrap:wrap;gap:8px}
.fbk .types button{padding:8px 14px;border-radius:999px;background:var(--surface-raised);font-size:14.5px;color:var(--text-secondary)}
.fbk .types button[aria-pressed=true]{background:var(--accent-primary);color:var(--on-accent)}
.fbk label.f{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--text-secondary)}
.fbk input.t,.fbk textarea{width:100%;padding:10px 14px;border-radius:10px;background:var(--surface-raised);border:1px solid var(--separator);font-size:15px;color:var(--text-primary)}
.fbk textarea{min-height:130px;resize:vertical;font-family:var(--sans)}
.fbk .att{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fbk .att label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--surface-raised);font-size:14.5px;cursor:pointer}
.fbk .att label small{display:block;color:var(--text-muted);font-size:12.5px}
.fbk .att input{width:auto;flex:none;margin-top:3px;accent-color:var(--accent-primary)}
.fbk .att label > span{flex:1;min-width:0;text-align:left}
.fbk .row label.f input{width:auto;flex:none}
.fbk .never{font-size:13.5px;color:var(--text-muted);line-height:1.5}
.fbk pre.pv{max-height:34vh;overflow:auto;margin:0;padding:12px 14px;border-radius:10px;background:var(--surface-raised);font:12.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.fbk .shot{max-width:100%;max-height:180px;border-radius:8px;border:1px solid var(--separator)}
.fbk .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.fbk .row .spacer{flex:1}
.fbkdlg{width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto}
@media (max-width: 760px){.fbk .att{grid-template-columns:1fr}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var TYPES = [['bug', 'Bug'], ['ux', 'UX problem'], ['model', 'Model/provider problem'], ['performance', 'Performance'], ['feature', 'Feature request'], ['other', 'Other']];
  var ATTACH = [
    ['version', 'App version', 'Noema, Node and Windows versions'],
    ['surface', 'Current surface', 'which view you were in (e.g. Chat)'],
    ['errors', 'Recent errors', 'anonymised: paths, names and emails removed'],
    ['runtime', 'Runtime status', 'which runtimes are detected and ready'],
    ['screenshot', 'Screenshot of this window', 'taken when you press Review'],
    ['logs', 'Recent request outcomes', 'success / failure and timing — no prompts'],
  ];

  // Window errors, for the "Recent errors" attachment only — messages, never page content.
  var clientErrors = [];
  window.addEventListener('error', function (e) { clientErrors.push({ at: new Date().toISOString(), message: String((e && e.message) || 'error').slice(0, 300) }); if (clientErrors.length > 20) clientErrors.shift(); });

  function form(host, opts) {
    opts = opts || {};
    var st = { type: opts.type || 'bug', include: {}, preview: null, shot: null, busy: false };
    var box = el('div', 'fbk');
    host.appendChild(box);
    function draw() {
      box.textContent = '';
      var types = el('div', 'types');
      TYPES.forEach(function (t) { var b = el('button', '', t[1]); b.setAttribute('aria-pressed', String(st.type === t[0])); b.onclick = function () { st.type = t[0]; st.preview = null; draw(); }; types.appendChild(b); });
      box.appendChild(types);
      var lt = el('label', 'f', 'Title'); var ti = document.createElement('input'); ti.className = 't'; ti.maxLength = 160; ti.value = st.title || ''; ti.placeholder = 'A short summary'; ti.oninput = function () { st.title = ti.value; st.preview = null; sub.disabled = true; }; lt.appendChild(ti); box.appendChild(lt);
      var ld = el('label', 'f', 'What happened — or what would help'); var de = document.createElement('textarea'); de.value = st.description || ''; de.placeholder = 'Steps, what you expected, what you saw. Please don’t paste keys, tokens or private code.'; de.oninput = function () { st.description = de.value; st.preview = null; sub.disabled = true; }; ld.appendChild(de); box.appendChild(ld);
      box.appendChild(el('div', 'kicker', 'Attach (only what you tick)'));
      var att = el('div', 'att');
      ATTACH.forEach(function (a) {
        var lab = el('label'); var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = Boolean(st.include[a[0]]); cb.setAttribute('data-attach', a[0]);
        cb.onchange = function () { st.include[a[0]] = cb.checked; st.preview = null; if (a[0] === 'screenshot' && !cb.checked) st.shot = null; sub.disabled = true; };
        lab.appendChild(cb); var t = el('span'); t.appendChild(document.createTextNode(a[1])); t.appendChild(el('small', '', a[2])); lab.appendChild(t); att.appendChild(lab);
      });
      box.appendChild(att);
      box.appendChild(el('div', 'never', 'Never included: API keys, OAuth tokens, provider credentials, project source, private prompts, or your conversations.'));
      if (st.preview) {
        box.appendChild(el('div', 'kicker', 'Review — exactly what will be saved'));
        box.appendChild(el('pre', 'pv', JSON.stringify(st.preview, null, 2)));
        if (st.shot) { var im = document.createElement('img'); im.className = 'shot'; im.src = st.shot; im.alt = 'screenshot to attach'; box.appendChild(im); }
      }
      var row = el('div', 'row');
      var issueLab = el('label', 'f'); issueLab.style.flexDirection = 'row'; issueLab.style.alignItems = 'center';
      var issue = document.createElement('input'); issue.type = 'checkbox'; issue.checked = Boolean(st.fileIssue); issue.onchange = function () { st.fileIssue = issue.checked; };
      issueLab.appendChild(issue); issueLab.appendChild(document.createTextNode(' Also open a GitHub issue (if configured)'));
      row.appendChild(issueLab);
      row.appendChild(el('span', 'spacer'));
      if (opts.cancel) { var cn = el('button', 'btn', 'Cancel'); cn.onclick = opts.cancel; row.appendChild(cn); }
      var rv = el('button', 'btn', st.busy ? 'Reviewing…' : 'Review'); rv.onclick = review; row.appendChild(rv);
      var sub = el('button', 'btn primary', 'Submit'); sub.disabled = !st.preview; sub.title = st.preview ? '' : 'Review first'; sub.onclick = submit; row.appendChild(sub);
      box.appendChild(row);
    }
    function body() {
      return { type: st.type, title: st.title || '', description: st.description || '', include: st.include, surface: L.nav.tab(), clientErrors: st.include.errors ? clientErrors.slice(-10) : [], screenshot: st.include.screenshot ? st.shot : null, fileIssue: st.fileIssue === true };
    }
    async function review() {
      if (!(st.title || '').trim() && !(st.description || '').trim()) { L.toast('Write a title or a description first.', true); return; }
      st.busy = true; draw();
      if (st.include.screenshot && !st.shot) {
        // The picture is of the window, not of this form: step aside while it is taken.
        var dlg = document.querySelector('.fbkdlg'); var back = dlg && dlg.parentNode;
        if (back) back.style.visibility = 'hidden';
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
        var c = await L.hostCall('capture', {});
        if (back) back.style.visibility = '';
        if (c && c.ok && c.png) st.shot = c.png; else { L.toast((c && c.why) || 'the screenshot could not be taken', true); st.include.screenshot = false; }
      }
      var r = await L.api('/api/feedback/preview', body());
      st.busy = false;
      if (!r || !r.ok) { L.toast((r && r.why) || 'could not build the report', true); draw(); return; }
      st.preview = r.preview; draw();
    }
    async function submit() {
      if (!st.preview) return;
      var r = await L.api('/api/feedback/submit', body());
      if (!r || !r.ok) { L.toast((r && r.why) || 'could not save the report', true); return; }
      L.toast('Thank you — feedback saved' + (r.issue ? ' and filed as ' + (r.issue.url || 'an issue') : '') + (r.why ? ' (' + r.why + ')' : ''));
      st = { type: 'bug', include: {}, preview: null, shot: null };
      if (opts.done) opts.done(r); else draw();
    }
    draw();
  }

  function open(o) {
    var back = el('div', 'dlg-back'); var box = el('div', 'dlg fbkdlg'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Send feedback');
    box.appendChild(el('h3', '', 'Send feedback'));
    var close = function () { back.remove(); document.removeEventListener('keydown', key, true); };
    var key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    form(box, { type: o && o.type, cancel: close, done: close });
    back.appendChild(box); document.body.appendChild(back);
    document.addEventListener('keydown', key, true);
    setTimeout(function () { var t = box.querySelector('input.t'); if (t) t.focus(); }, 0);
  }

  L.feedback = {
    open: open,
    page: function (pane) {
      var pf = el('div', 'pf'); pane.appendChild(pf);
      var h = el('div', 'pf-sec'); h.appendChild(el('h3', '', 'Feedback')); h.appendChild(el('p', 'lede', 'Tell us what broke or what would help. Reports are saved on this machine; you choose every attachment and review the report before it is saved.')); pf.appendChild(h);
      var c = el('div', 'gh-card'); c.style.maxWidth = '860px'; form(c, {}); pf.appendChild(c);
    },
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
