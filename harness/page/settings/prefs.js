'use strict';

/**
 * SETTINGS PAGES OF THE PALETTE WORKBENCH (Phase 8) — drawn into the Settings
 * pane by pagesettings.js through `LAIN.prefs.draw(page, pane)`.
 *
 *   appearance   palette cards (LAIN Dark/Light, Slate, Violet, Coral,
 *                Monochrome, Custom), the five-colour custom editor, Reset to
 *                default LAIN, Light / Dark / System (independent of the
 *                palette), Typography, Interface Scale (the whole window —
 *                Ctrl +/-/0), Icon Scale, Density, and the editor Theme preset
 *   keymap       the keymap preset (independent of the theme), every command
 *                with its chord, custom overrides recorded from the keyboard
 *   agents       Agent Instructions — AGENTS.md, global and project: view,
 *                edit, save (never over a file that changed on disk without
 *                asking), Reset to default with the diff shown and confirmed,
 *                and the effective instructions the Agent receives
 *
 * Every value is Core's (POST /api/appearance, /api/agents/*); this file draws
 * and asks. Nothing here sends a prompt.
 */

const CSS = `
.pf{max-width:860px}
.pf-sec{margin:0 0 12px}
.pf h3{font:600 14px/1.3 var(--sans);letter-spacing:0;text-transform:none;color:var(--text-primary);margin:0 0 2px}
.pf .lede{font-size:12.5px;color:var(--text-secondary);margin:2px 0 10px;line-height:1.5}
.pf .seg{display:inline-flex;width:auto;max-width:100%}
.pf-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.cust{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.cust > label{display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 8px;border-radius:var(--radius-md);background:var(--surface-raised)}
.cust .dot{width:42px;height:42px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(127,127,127,.3);position:relative;overflow:hidden;cursor:pointer}
.cust .dot input[type=color]{position:absolute;inset:-8px;width:calc(100% + 16px);height:calc(100% + 16px);opacity:0;cursor:pointer}
.cust input.hex{width:100%;max-width:110px;text-align:center;font:500 12.5px var(--mono);padding:5px 6px;border-radius:var(--radius-sm);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator)}
.cust input.hex.bad{box-shadow:inset 0 0 0 1px var(--danger)}
.cust .nm{font-size:12px;color:var(--text-muted)}
.kmtable{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
.kmtable th{text-align:left;font-weight:500;color:var(--text-muted);font-size:11.5px;padding:6px 8px;border-bottom:1px solid var(--separator)}
.kmtable td{padding:6px 8px;border-bottom:1px solid var(--separator)}
.kmtable td.g{color:var(--text-muted);font-size:11.5px;width:90px}
.kmtable kbd{font:500 11.5px var(--mono);padding:2px 7px;border-radius:var(--radius-xs);background:var(--surface-raised)}
.kmtable kbd.none{color:var(--text-muted);box-shadow:inset 0 0 0 1px var(--border-subtle);background:none}
.kmtable tr.conf td{background:var(--tertiary-weak)}
.kmtable button.rec{font-size:12px;padding:3px 9px}
.kmtable button.rec.on{background:var(--accent-tertiary);color:var(--on-tertiary)}
.ag-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.ag-file{font:500 12px var(--mono);color:var(--text-muted);overflow-wrap:anywhere}
.ag-body{background:var(--surface-raised);border-radius:var(--radius-md);padding:0;overflow:hidden}
.ag-body pre{margin:0;padding:14px 16px;font:12.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:56vh;overflow:auto}
.ag-body textarea{display:block;width:100%;min-height:52vh;padding:14px 16px;font:12.5px/1.6 var(--mono);background:var(--surface-raised);color:var(--text-primary);border:0;resize:vertical;outline:none}
.ag-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
.ag-bar .spacer{flex:1}
.ag-eff{margin-top:18px}
.ag-layers{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
.ag-layers > div{background:var(--surface-raised);border-radius:var(--radius-md);padding:12px 14px}
.ag-layers b{display:flex;align-items:center;gap:8px;font-size:13px}
.ag-layers small{display:block;color:var(--text-muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere}
.diffv{max-height:52vh;overflow:auto;font:12px/1.55 var(--mono);background:var(--surface-raised);border-radius:var(--radius-md);padding:10px 0;margin:10px 0}
.diffv div{padding:0 14px;white-space:pre-wrap;overflow-wrap:anywhere}
.diffv .add{background:color-mix(in srgb,var(--positive, #5AAE84) 18%,transparent)}
.diffv .del{background:color-mix(in srgb,var(--accent-tertiary) 16%,transparent);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--accent-tertiary) 50%,transparent)}
.dlg.wide{width:min(860px,calc(100vw - 32px))}
@media (max-width: 1100px){.cust{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width: 760px){.ag-layers{grid-template-columns:minmax(0,1fr)}.cust{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var redraw = function () { if (L.settings) L.settings.draw(); };

  function seg(items, current, pick) {
    var s = el('div', 'seg');
    items.forEach(function (it) {
      var b = el('button', '', it[1]);
      b.setAttribute('aria-pressed', String(current === it[0]));
      b.onclick = function () { pick(it[0]); };
      s.appendChild(b);
    });
    return s;
  }
  function section(pane, title, sub, right) {
    var s = el('div', 'pf-sec');
    var h = el('div', 'pf-row');
    var t = el('div');
    t.appendChild(el('h3', '', title));
    if (sub) t.appendChild(el('p', 'lede', sub));
    h.appendChild(t);
    if (right) h.appendChild(right);
    s.appendChild(h);
    pane.appendChild(s);
    return s;
  }

  // ---- APPEARANCE -------------------------------------------------------------------------------
  // THE SWATCHES ARE THE PALETTES' OWN TOKENS (ui/tokens.js): canvas · surface · primary · secondary · tertiary.
  var PALS = [
    ['slate', 'Slate', 'Default — deep navy planes, a violet action, teal highlights', ['#0E131A', '#141B24', '#9B8AFB', '#2DD4BF', '#F472B6'], ['#EEF1F5', '#FFFFFF', '#6D5AE6', '#0F9E8D', '#D6428F']],
    ['lain', 'LAIN Cyan', 'Dark cyan', ['#0A1A1E', '#0F252A', '#27D9D2', '#0FA3A8', '#FF5C83'], ['#E8F2F2', '#FFFFFF', '#0FA7A2', '#0B7F84', '#FF5C83']],
    ['violet', 'Violet', 'Modern and bold', ['#12111B', '#1A1826', '#A08CF6', '#6F8EF2', '#D383F5'], ['#EEF1F5', '#FFFFFF', '#6A4ADF', '#4A6CD6', '#9F3FCB']],
    ['coral', 'Coral', 'Warm and energetic', ['#16111A', '#1F1822', '#FF7A92', '#FFA07F', '#FFC56B'], ['#EEF1F5', '#FFFFFF', '#D8405F', '#D86A48', '#B47A12']],
    ['mono', 'Monochrome', 'Minimal and clean', ['#111111', '#1A1A1A', '#E8E8E8', '#A8A8A8', '#C9C9C9'], ['#EEF1F5', '#FFFFFF', '#1A1A1A', '#555555', '#3A3A3A']],
  ];
  var DEFAULT_CUSTOM = { background: '#0F131A', surface: '#171D26', accent: '#86ADE0', secondary: '#A99DF2', warning: '#D9AE58' };
  var CUST_NAMES = { background: 'Background', surface: 'Surface', accent: 'Accent', secondary: 'Secondary', warning: 'Warning' };
  var themeList = null;

  function appearance(pane) {
    var U = L.kit;
    var A = L.appearance; var u = (A && A.get()) || { mode: 'dark', palette: 'slate', zoom: 100, type: 'medium', icons: 'medium', density: 'comfortable', theme: 'lain', custom: DEFAULT_CUSTOM };
    var light = A && A.mode() === 'light';
    var pf = el('div', 'pf');
    pane.appendChild(pf);
    // ONE CONTROL FOR A SMALL CHOICE: the current value, opening a menu. items: [[value, label]]
    var pick = function (items, current, apply, id) {
      var cur = items.filter(function (i) { return String(i[0]) === String(current); })[0];
      return U.select(cur ? cur[1] : String(current), items.map(function (i) { return { label: i[1], checked: String(i[0]) === String(current), run: function () { apply(i[0]); } }; }), { id: id });
    };

    // COLOUR PALETTE — a list, the chosen one marked; Slate is the default.
    var g1 = U.group('Colour palette');
    g1.appendChild(el('p', 'u-note', 'Applies at once, everywhere — the editor and terminal included.'));
    var list = el('div', 'u-rows');
    PALS.forEach(function (p) {
      var c = el('button', 'u-row plain palc click'); c.setAttribute('aria-pressed', String(u.palette === p[0])); c.setAttribute('data-palette', p[0]);
      var sw = el('span', 'sw'); (light ? p[4] : p[3]).forEach(function (col) { var i = el('i'); i.style.background = col; sw.appendChild(i); });
      var t = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(sw); nm.appendChild(el('span', '', p[1])); t.appendChild(nm); t.appendChild(el('div', 'u-who', p[2]));
      c.appendChild(t);
      var ck = el('span', 'u-ck'); if (u.palette === p[0]) ck.appendChild(L.icon('check', 18)); c.appendChild(ck);
      c.onclick = async function () { await A.set({ palette: p[0] }); redraw(); };
      list.appendChild(c);
    });
    var cu = el('button', 'u-row plain palc click'); cu.setAttribute('aria-pressed', String(u.palette === 'custom')); cu.setAttribute('data-palette', 'custom');
    var cc = u.custom || DEFAULT_CUSTOM;
    var csw = el('span', 'sw'); ['background', 'accent', 'warning'].forEach(function (k) { var i = el('i'); i.style.background = cc[k]; csw.appendChild(i); });
    var ct = el('div', 'u-id'); var cnm = el('div', 'u-nm'); cnm.appendChild(csw); cnm.appendChild(el('span', '', 'Custom')); ct.appendChild(cnm); ct.appendChild(el('div', 'u-who', 'Your own five colours'));
    cu.appendChild(ct); var cck = el('span', 'u-ck'); if (u.palette === 'custom') cck.appendChild(L.icon('check', 18)); cu.appendChild(cck);
    cu.onclick = async function () { await A.set({ palette: 'custom' }); redraw(); };
    list.appendChild(cu);
    g1.appendChild(list);
    pf.appendChild(g1);

    if (u.palette === 'custom') {
      var g2 = U.group('Custom palette');
      g2.appendChild(el('p', 'u-note', 'Five colours; LAIN derives the rest (text, lines, raised surfaces) with readable contrast. Light or dark follows the background you choose.'));
      var cust = el('div', 'cust');
      Object.keys(CUST_NAMES).forEach(function (k) {
        var lab = el('label');
        var dot = el('span', 'dot'); dot.style.background = cc[k];
        var pk = document.createElement('input'); pk.type = 'color'; pk.value = cc[k]; pk.setAttribute('aria-label', CUST_NAMES[k]);
        var hex = document.createElement('input'); hex.className = 'hex'; hex.value = cc[k].toUpperCase(); hex.maxLength = 7; hex.spellcheck = false;
        var commit = function (v) { if (!/^#[0-9a-f]{6}$/i.test(v)) { hex.classList.add('bad'); return; } hex.classList.remove('bad'); var patch = {}; patch[k] = v.toUpperCase(); A.set({ custom: patch }); };
        pk.oninput = function () { dot.style.background = pk.value; hex.value = pk.value.toUpperCase(); };
        pk.onchange = function () { commit(pk.value); };
        hex.onchange = function () { var v = hex.value.trim(); if (v.charAt(0) !== '#') v = '#' + v; dot.style.background = v; commit(v); };
        dot.appendChild(pk);
        lab.appendChild(dot); lab.appendChild(hex); lab.appendChild(el('span', 'nm', CUST_NAMES[k]));
        cust.appendChild(lab);
      });
      g2.appendChild(cust);
      pf.appendChild(g2);
    }

    // DISPLAY — one row per setting, the control on the right.
    var g3 = U.group('Display');
    g3.appendChild(U.setting('Theme', 'Light or dark, with any palette.', pick([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], u.mode, function (v) { A.set({ mode: v }).then(redraw); }, 'set-mode')));
    g3.appendChild(U.setting('Text size', 'Text across LAIN — settings included.', pick([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], u.type, function (v) { A.set({ type: v }).then(redraw); }, 'set-type')));
    g3.appendChild(U.setting('Interface scale', 'Everything scales, not only the editor. Ctrl + / Ctrl − / Ctrl 0.', pick((A ? A.ZOOMS : [80, 90, 100, 110, 125, 150, 175, 200]).map(function (z) { return [z, z + '%']; }), u.zoom, function (v) { A.set({ zoom: v }).then(redraw); }, 'set-zoom')));
    g3.appendChild(U.setting('Icon size', 'Navigation and interface icons.', pick([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], u.icons, function (v) { A.set({ icons: v }).then(redraw); }, 'set-icons')));
    g3.appendChild(U.setting('Density', 'Spacing between rows.', pick([['comfortable', 'Comfortable'], ['compact', 'Compact']], u.density || 'comfortable', function (v) { A.set({ density: v }).then(redraw); }, 'set-density')));
    var edSize = (function () { try { return localStorage.getItem('lain.editorSize') || '13'; } catch (e) { return '13'; } })();
    g3.appendChild(U.setting('Editor font size', 'Code editor text, on this machine.', pick([['12', '12'], ['13', '13'], ['14', '14'], ['15', '15'], ['16', '16']], edSize, function (v) {
      try { localStorage.setItem('lain.editorSize', v); } catch (e) { /* private window */ }
      var ed = L.editor && L.editor.editor && L.editor.editor(); if (ed) ed.updateOptions({ fontSize: Number(v) });
      redraw();
    }, 'set-editor')));
    g3.appendChild(U.setting('Navigation', 'The panel on the left of every surface except the IDE. Home always shows it expanded.', pick([['compact', 'Compact'], ['expanded', 'Expanded']], u.nav === 'expanded' || u.nav === 'persistent' ? 'expanded' : 'compact', function (v) { A.set({ nav: v }).then(redraw); }, 'set-nav')));
    pf.appendChild(g3);

    // EDITOR THEME PRESET
    var g4 = U.group('Editor theme');
    var opts = [['lain', 'LAIN'], ['vscode', 'VS Code'], ['cursor', 'Cursor'], ['jetbrains', 'JetBrains']];
    (themeList || []).forEach(function (t) { opts.push([t.id, t.label]); });
    var note = themeList === null ? 'Looking for colour themes in installed extensions…' : themeList.length ? 'Includes colour themes from your installed extensions, read as data (their code does not run).' : 'Themes from installed extensions appear here.';
    g4.appendChild(U.setting('Preset', 'The code editor’s and terminal’s colours, independent of the keymap. ' + note, pick(opts, u.theme || 'lain', function (v) { A.set({ theme: v }).then(redraw); }, 'set-theme')));
    if (themeList === null) { themeList = []; L.api('/api/themes/list', {}).then(function (r) { themeList = (r && r.ok && r.themes) || []; redraw(); }, function () { themeList = []; }); }
    pf.appendChild(g4);

    var g5 = U.group('Reset');
    var ra = U.button('Reset to Slate', 'line', async function () { if (await L.confirm('Reset every appearance setting to LAIN’s defaults (Slate, dark)?', { ok: 'Reset all' })) { await A.set({ reset: 'all' }); redraw(); } });
    g5.appendChild(U.setting('Back to defaults', 'Palette, mode, scale, text and icon size, theme and keymap.', ra));
    pf.appendChild(g5);
  }

  // ---- KEYMAP -----------------------------------------------------------------------------------
  var recFor = null;
  function keymap(pane) {
    var K = L.keymap; var A = L.appearance; var u = (A && A.get()) || {};
    var pf = el('div', 'pf'); pane.appendChild(pf);
    if (!K) { pf.appendChild(el('div', 'missing', 'Keymaps are not available in this build.')); return; }
    var cur = u.keymap || 'lain';
    var s1 = section(pf, 'Keymap preset', 'Which editor’s shortcuts LAIN answers to. Separate from the theme preset. Editor commands work while the code editor has focus; IDE commands inside the IDE.');
    s1.appendChild(seg(['lain', 'vscode', 'cursor', 'jetbrains', 'custom'].map(function (k) { return [k, K.LABELS[k]]; }), cur, function (v) { A.set({ keymap: v }).then(redraw); }));
    if (cur === 'custom') s1.appendChild(el('p', 'lede', 'Custom starts from LAIN’s chords. Press Change, then the new combination; Esc cancels, Backspace unbinds.'));
    var b = K.bindings(cur);
    var conf = {}; K.conflicts(cur).forEach(function (c) { conf[c[0]] = 1; conf[c[1]] = 1; });
    var t = el('table', 'kmtable');
    var hr = el('tr'); ['Command', 'Where', 'Shortcut', ''].forEach(function (x) { hr.appendChild(el('th', '', x)); }); t.appendChild(hr);
    K.COMMANDS.forEach(function (c) {
      var tr = el('tr', conf[c.id] ? 'conf' : ''); tr.setAttribute('data-cmd', c.id);
      tr.appendChild(el('td', '', c.label));
      tr.appendChild(el('td', 'g', c.scope === 'editor' ? 'Editor' : c.scope === 'ide' ? 'IDE' : 'Anywhere'));
      var kc = el('td'); var kb = el('kbd', b[c.id] ? '' : 'none', recFor === c.id ? 'Press keys…' : (b[c.id] || 'Unbound')); kc.appendChild(kb); tr.appendChild(kc);
      var ac = el('td');
      if (cur === 'custom') {
        var rb = el('button', 'fbtn small ghost rec' + (recFor === c.id ? ' on' : ''), recFor === c.id ? 'Recording' : 'Change');
        rb.onclick = function () { startRecord(c.id); };
        ac.appendChild(rb);
        if ((u.customKeys || {})[c.id] !== undefined) {
          var rs = el('button', 'fbtn small ghost', 'Default');
          rs.onclick = function () { var p = {}; p[c.id] = K.PRESETS.lain[c.id] || null; A.set({ customKeys: p }).then(redraw); };
          ac.appendChild(rs);
        }
      }
      tr.appendChild(ac);
      t.appendChild(tr);
    });
    pf.appendChild(t);
    if (Object.keys(conf).length) pf.appendChild(el('p', 'lede', 'Highlighted rows share a shortcut; the first in the list wins.'));
  }
  function startRecord(id) {
    recFor = id; redraw();
    L.keymap.record(true);
    var onKey = function (e) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') return done();
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) return done(null);
      var ch = L.keymap.chordOf(e);
      if (!ch) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^(Shift\+)?F\d{1,2}$/.test(ch)) { L.toast('Use Ctrl or Alt with a key (or a function key).', true); return; }
      done(ch);
    };
    function done(v) {
      window.removeEventListener('keydown', onKey, true);
      L.keymap.record(false);
      var cmd = recFor; recFor = null;
      if (v === undefined) { redraw(); return; }
      var p = {}; p[cmd] = v; L.appearance.set({ customKeys: p }).then(redraw);
    }
    window.addEventListener('keydown', onKey, true);
  }

  // ---- AGENT INSTRUCTIONS (AGENTS.md) ------------------------------------------------------------
  var ag = { scope: 'global', file: null, def: null, editing: false, draft: '', eff: null, loading: false, why: null };
  async function agLoad() {
    ag.loading = true; ag.why = null;
    var r = await L.api('/api/agents/read', { scope: ag.scope });
    ag.loading = false;
    if (r && r.ok) { ag.file = r.file; ag.def = r.default; } else { ag.file = null; ag.why = (r && r.why) || 'could not read'; }
    var e = await L.api('/api/agents/effective', {});
    ag.eff = e && e.ok ? e : null;
    redraw();
  }
  function diffDialog(title, lines, text, okLabel) {
    return new Promise(function (resolve) {
      var back = el('div', 'dlg-back'); var box = el('div', 'dlg wide'); box.setAttribute('role', 'dialog');
      box.appendChild(el('h3', '', title));
      box.appendChild(el('p', '', text));
      var dv = el('div', 'diffv');
      lines.forEach(function (x) { dv.appendChild(el('div', x.op === '+' ? 'add' : x.op === '-' ? 'del' : '', (x.op === ' ' ? '  ' : x.op + ' ') + x.text)); });
      box.appendChild(dv);
      var row = el('div', 'dlg-actions');
      var cancel = el('button', 'btn', 'Cancel'); var ok = el('button', 'btn danger-fill', okLabel);
      var fin = function (v) { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      var key = function (e) { if (e.key === 'Escape') { e.preventDefault(); fin(false); } };
      cancel.onclick = function () { fin(false); }; ok.onclick = function () { fin(true); };
      row.appendChild(cancel); row.appendChild(ok); box.appendChild(row);
      back.appendChild(box); document.body.appendChild(back);
      document.addEventListener('keydown', key, true);
      ok.focus();
    });
  }
  function agents(pane) {
    var pf = el('div', 'pf'); pane.appendChild(pf);
    var S = L.state() || {};
    var proj = S.workspace && S.workspace.project;
    var hasProject = Boolean(proj && proj.attached && !proj.missing);
    var s1 = section(pf, 'Agent Instructions', 'AGENTS.md: standing instructions the Coding Agent reads before it works. The global file applies to every project; a project file refines it.');
    var head = el('div', 'ag-head');
    var sg = el('div', 'seg');
    [['global', 'Global'], ['project', hasProject ? 'Project · ' + (proj.name || 'this project') : 'Project']].forEach(function (x) {
      var b = el('button', '', x[1]); b.setAttribute('aria-pressed', String(ag.scope === x[0]));
      if (x[0] === 'project' && !hasProject) { b.disabled = true; b.title = 'Attach a project to this session to edit its AGENTS.md.'; }
      b.onclick = function () { if (ag.editing && ag.draft !== (ag.file && ag.file.text)) { L.toast('Save or cancel your edit first.', true); return; } ag.scope = x[0]; ag.editing = false; ag.file = null; agLoad(); };
      sg.appendChild(b);
    });
    head.appendChild(sg);
    if (ag.file) {
      head.appendChild(el('span', 'tag ' + (!ag.file.exists ? '' : ag.file.isDefault ? 'ok' : 'accent'), !ag.file.exists ? 'Not created' : ag.file.isDefault ? 'LAIN default' : 'Edited'));
      head.appendChild(el('span', 'ag-file', ag.file.file));
    }
    s1.appendChild(head);
    if (!ag.file && !ag.loading && !ag.why) { agLoad(); s1.appendChild(el('div', 'missing', 'Reading…')); return; }
    if (ag.loading) { s1.appendChild(el('div', 'missing', 'Reading…')); return; }
    if (ag.why) { s1.appendChild(el('div', 'missing', ag.why)); return; }
    var f = ag.file;
    var body = el('div', 'ag-body');
    if (ag.editing) {
      var ta = document.createElement('textarea'); ta.value = ag.draft; ta.spellcheck = false; ta.setAttribute('aria-label', 'AGENTS.md');
      ta.oninput = function () { ag.draft = ta.value; count.textContent = new Blob([ta.value]).size + ' / ' + f.maxBytes + ' bytes'; };
      body.appendChild(ta);
      setTimeout(function () { ta.focus(); }, 0);
    } else {
      body.appendChild(el('pre', '', f.exists ? (f.text || '(empty file)') : 'No ' + (ag.scope === 'global' ? 'global' : 'project') + ' AGENTS.md yet. Edit to write one, or Reset to start from LAIN’s default.'));
    }
    s1.appendChild(body);
    var bar = el('div', 'ag-bar');
    var count = el('span', 'lede', (ag.editing ? new Blob([ag.draft]).size : f.bytes) + ' / ' + f.maxBytes + ' bytes');
    if (ag.editing) {
      var save = el('button', 'fbtn primary', 'Save');
      save.onclick = async function () {
        // NO SILENT OVERWRITE: if the file changed on disk since it was opened, ask.
        var now = await L.api('/api/agents/read', { scope: ag.scope });
        if (now && now.ok && now.file.mtime !== f.mtime && now.file.text !== f.text) {
          if (!(await L.confirm('This AGENTS.md changed on disk after you opened it. Save your version over it?', { ok: 'Overwrite', danger: true }))) return;
        }
        var r = await L.api('/api/agents/save', { scope: ag.scope, text: ag.draft });
        if (!r || !r.ok) { L.toast((r && r.why) || 'could not save', true); return; }
        ag.file = r.file; ag.editing = false; L.toast('AGENTS.md saved'); agLoad();
      };
      var cancel = el('button', 'fbtn ghost', 'Cancel');
      cancel.onclick = async function () { if (ag.draft !== f.text && !(await L.confirm('Discard your changes?', { ok: 'Discard' }))) return; ag.editing = false; redraw(); };
      bar.appendChild(save); bar.appendChild(cancel);
    } else {
      var edit = el('button', 'fbtn primary', f.exists ? 'Edit' : 'Write one');
      edit.onclick = function () { ag.editing = true; ag.draft = f.exists ? f.text : ''; redraw(); };
      bar.appendChild(edit);
      var copy = el('button', 'fbtn ghost', 'Copy');
      copy.onclick = function () { try { navigator.clipboard.writeText(f.text || ''); L.toast('Copied'); } catch (e) { L.toast('Copy is not available here', true); } };
      if (f.exists) bar.appendChild(copy);
      var reset = el('button', 'fbtn ghost', 'Reset to default');
      reset.onclick = async function () {
        var p = await L.api('/api/agents/preview-reset', { scope: ag.scope });
        if (!p || !p.ok) { L.toast((p && p.why) || 'could not compare', true); return; }
        if (!p.changes && p.exists) { L.toast('This file already matches LAIN’s default.'); return; }
        var ok = await diffDialog('Reset to LAIN’s default?', p.diff, (p.exists ? p.changes + ' line change' + (p.changes === 1 ? '' : 's') + '. ' : 'The file will be created. ') + (p.modified ? 'Your edited file is kept beside it as a backup.' : ''), p.exists ? 'Replace with default' : 'Create from default');
        if (!ok) return;
        var r = await L.api('/api/agents/reset', { scope: ag.scope, confirm: true });
        if (!r || !r.ok) { L.toast((r && r.why) || 'could not reset', true); return; }
        L.toast(r.backup ? 'Reset — backup at ' + r.backup : 'Reset to LAIN’s default'); agLoad();
      };
      bar.appendChild(reset);
    }
    bar.appendChild(el('span', 'spacer'));
    bar.appendChild(count);
    s1.appendChild(bar);

    if (ag.eff) {
      var s2 = el('div', 'ag-eff');
      s2.appendChild(el('h3', 'title3', 'Effective instructions'));
      s2.appendChild(el('p', 'lede', 'What the Coding Agent receives, in order. The project file is read after the global one, so it refines it.'));
      var ly = el('div', 'ag-layers');
      ag.eff.layers.forEach(function (x) {
        var d = el('div'); var b = el('b'); b.appendChild(el('span', 'tag ' + (x.active ? 'ok' : ''), x.active ? 'In force' : 'Not in force')); b.appendChild(document.createTextNode(x.scope === 'global' ? 'Global' : 'Project'));
        d.appendChild(b); d.appendChild(el('small', '', (x.file || '—') + ' · ' + x.note)); ly.appendChild(d);
      });
      s2.appendChild(ly);
      var det = document.createElement('details');
      det.appendChild(el('summary', '', 'Show the combined text'));
      var pre = el('div', 'ag-body'); pre.appendChild(el('pre', '', (typeof ag.eff.prompt === 'string' && ag.eff.prompt) || '(none — no AGENTS.md is in force)'));
      det.appendChild(pre);
      s2.appendChild(det);
      pf.appendChild(s2);
    }
  }

  L.prefs = {
    draw: function (page, pane) {
      if (page === 'appearance') { appearance(pane); return true; }
      if (page === 'keymap') { keymap(pane); return true; }
      if (page === 'agents') { agents(pane); return true; }
      return false;
    },
    agentsReload: function () { ag.file = null; ag.eff = null; },
  };
  L.onBoot(function () { if (L.appearance) L.appearance.onChange(function () { if (L.nav.tab() === 'settings') redraw(); }); });
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
