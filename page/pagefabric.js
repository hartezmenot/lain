'use strict';

/**
 * MODEL › Models · Local · Runtimes — what intelligence LAIN can actually use.
 *
 *   ┌ CURRENT ─────────────────────────────────────────────────────────────┐
 *   │ CHAT  ChatGPT Chat  CHAT ONLY │ BOT  Qwen3-VL-4B · llama.cpp │ AGENT …│
 *   ├ AVAILABLE ───────────────────────────────────────────┬ detail ───────┤
 *   │ Model · Provider/runtime · Account/source · Caps ·   │ (per source:  │
 *   │ Usage/limit · Status — grouped Local / Runtimes &    │  local model, │
 *   │ plans / Chat sources / Cloud APIs                    │  plan, …)     │
 *   └──────────────────────────────────────────────────────┴───────────────┘
 *
 * EVERYTHING IS POST /api/fabric (src/harnessapp/fabricroutes.js). A row
 * exists because a source is configured or found; a percentage exists
 * because a provider or runtime reported it; a local model says "No provider
 * quota" because it has none. Nothing here polls: Refresh is a click.
 *
 * ICONS are neutral LAIN monograms in distinct shapes and colours — not
 * provider logos (none are bundled with permission to redistribute).
 */

const CSS = `
.fab-cur{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px;max-width:1280px}
@media (max-width:1000px){.fab-cur{grid-template-columns:minmax(0,1fr)}}
.fab-role{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;min-width:0}
.fab-role .rk{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600;display:flex;align-items:center;gap:6px}
.fab-role .rn{display:flex;align-items:center;gap:8px;margin:8px 0 2px;min-width:0}
.fab-role .rn b{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fab-role .rv{font-size:12px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fab-role .ra{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
.chatonly{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.06em;padding:1px 6px;border-radius:3px;background:rgba(245,166,35,.12);color:var(--warn);border:1px solid var(--warn)}
.fab-bar{display:flex;align-items:center;gap:8px;margin:0 0 10px;flex-wrap:wrap}
.fab-bar input{width:260px;max-width:100%}
.fab-bar .chipb{font-size:11.5px;padding:3px 9px;border-radius:12px;border:1px solid var(--line2);color:var(--dim);background:transparent}
.fab-bar .chipb[aria-pressed=true]{border-color:var(--accent);color:var(--ink);background:var(--raise)}
.fab{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:14px;align-items:start}
@media (max-width:1280px){.fab{grid-template-columns:minmax(0,1fr)}.fab .fdet{position:static}}
.fab-grp{margin-bottom:18px}
.fab-grp h4{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 6px;font-weight:600;display:flex;gap:8px;align-items:center}
.fab-grp h4 small{letter-spacing:0;text-transform:none;font-weight:400}
.fab-tw{overflow-x:auto}
.fabtbl{width:100%;min-width:860px;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
.fabtbl th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-weight:600}
.fabtbl td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fabtbl td.capcell{white-space:normal;line-height:1.9}
.fabtbl tr.frow{cursor:pointer}
.fabtbl tr.frow:hover td{background:var(--surface)}
.fabtbl tr.frow[aria-selected=true] td{background:var(--raise)}
.fabtbl .mn{display:flex;align-items:center;gap:9px;min-width:0}
.fabtbl .mn .t{min-width:0;overflow:hidden}
.fabtbl .mn b{font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis}
.fabtbl .mn small{display:block;color:var(--faint);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.fabtbl .cur{font-size:9.5px;color:var(--accent);font-weight:700;letter-spacing:.06em;margin-left:4px}
.cap{display:inline-block;font-size:9.5px;font-weight:600;letter-spacing:.04em;padding:1px 5px;border-radius:3px;border:1px solid var(--line2);color:var(--dim);margin:0 3px 2px 0}
.cap.agent{border-color:var(--ok);color:var(--ok)}
.cap.no{border-style:dashed;color:var(--faint)}
.fst{display:inline-flex;align-items:center;gap:5px;font-size:12px}
.fst.ok{color:var(--ok)} .fst.warn{color:var(--warn)} .fst.bad{color:var(--bad)} .fst.busy{color:var(--faint)}
.fuse{font-size:12px;color:var(--dim);display:flex;align-items:center;gap:6px;min-width:0}
.fuse .q-bar{width:60px;flex:none}
.fdet{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;position:sticky;top:0;min-width:0}
.fdet h3{margin:0 0 2px;font-size:15px;display:flex;align-items:center;gap:8px}
.fdet .sub{font-size:12px;color:var(--faint);margin-bottom:10px}
.fdet dl{display:grid;grid-template-columns:118px minmax(0,1fr);gap:4px 10px;font-size:12px;margin:0 0 8px}
.fdet dt{color:var(--faint)} .fdet dd{margin:0;overflow-wrap:anywhere}
.fdet h5{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:14px 0 6px;font-weight:600}
.fdet .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.fdet .note{font-size:12px;color:var(--faint);margin:6px 0}
.fdet .warnline{font-size:12px;color:var(--warn);margin:6px 0}
.fdet .probe{display:grid;grid-template-columns:18px 110px minmax(0,1fr);gap:6px;font-size:12px;padding:2px 0}
.fdet .probe .p{color:var(--ok)} .fdet .probe .f{color:var(--bad)}
.fdet .advgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.fdet .advgrid label{font-size:11px;color:var(--faint)}
.fdet .advgrid input{width:100%}
.plan{border:1px solid var(--line);border-radius:8px;padding:12px;margin:8px 0;background:var(--surface)}
.plan .pk{font-size:10px;letter-spacing:.12em;color:var(--faint);font-weight:700}
.plan .pn{font-size:16px;font-weight:600;margin:4px 0}
.plan .bal{font-size:12px;color:var(--dim)}
.picon{flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;font-weight:700;color:#fff;font-size:10.5px;letter-spacing:-.02em;line-height:1}
.rtcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;max-width:1100px}
.rtcard .rh{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rtcard .rh b{font-size:14px}
.rtcard .rh .spacer{flex:1}
.rtcard .rh small{color:var(--faint)}
.rtstate{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;border:1px solid var(--line2);color:var(--dim)}
.rtstate.ok{border-color:var(--ok);color:var(--ok)} .rtstate.warn{border-color:var(--warn);color:var(--warn)} .rtstate.bad{border-color:var(--bad);color:var(--bad)}
.rt3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
@media (max-width:900px){.rt3{grid-template-columns:minmax(0,1fr)}}
.rtcaps{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.rtcaps .cap{display:inline-flex;gap:5px;align-items:baseline;border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:10.5px;cursor:default}
.rtcaps .ck{color:var(--faint);letter-spacing:.06em}
.rtcaps .ok .cl,.rtcaps .cap.ok .cl{color:var(--ok)} .rtcaps .cap.mid .cl{color:var(--warn)} .rtcaps .cap.nr .cl{color:var(--dim)} .rtcaps .cap.no .cl{color:var(--bad)}
.vsel{background:var(--surface);border:1px solid var(--line2);border-radius:var(--radius-s);padding:3px 6px;font-size:12px;max-width:260px}
.rt3 .c{border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;min-width:0}
.rt3 .c .k{font-size:10px;letter-spacing:.1em;color:var(--faint);font-weight:700;display:flex;gap:6px;align-items:center}
.rt3 .c .k .y{color:var(--ok)} .rt3 .c .k .n{color:var(--bad)}
.rt3 .c .v{margin-top:4px;color:var(--dim);overflow-wrap:anywhere}
.rtcard .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.lsec{max-width:1100px;margin-bottom:20px}
.lsec h4{font-size:12px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.dirrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:12.5px}
.dirrow small{display:block;color:var(--faint)}
.empty-card{border:1px dashed var(--line2);border-radius:8px;padding:14px 16px;color:var(--faint);font-size:12.5px;max-width:1100px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var data = null, loading = false, at = 0, listeners = [];
  var selected = null, filterText = '', roleFilter = 'all';
  var ticker = null;

  // ---- neutral provider monograms ------------------------------------------
  var MARK = {
    openai: ['OA', '#0f8a6b', 12], anthropic: ['A', '#c96442', 6], 'claude-code': ['CC', '#c96442', 6], google: ['G', '#3367d6', 11],
    gemini: ['G', '#3367d6', 11], zai: ['Z', '#1f2937', 4], zcode: ['ZC', '#3f3cbb', 4], opencode: ['OC', '#374151', 2], 'opencode-runtime': ['OC', '#374151', 2],
    freebuff: ['FB', '#9333ea', 11], ollama: ['Ol', '#525252', 11], llamacpp: ['ll', '#15803d', 6], 'llama.cpp': ['ll', '#15803d', 6], local: ['◆', '#15803d', 6],
    deepseek: ['DS', '#4d6bfe', 6], openrouter: ['OR', '#6566f1', 6], xai: ['X', '#111827', 6], custom: ['·', '#6b7280', 6], lain: ['L', '#4f46e5', 6],
  };
  function picon(provider, size) {
    var key = String(provider || '').toLowerCase();
    var m = MARK[key] || [String(provider || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?', '#6b7280', 6];
    var s = el('span', 'picon', m[0]);
    var z = size || 22;
    s.style.cssText = 'width:' + z + 'px;height:' + z + 'px;background:' + m[1] + ';border-radius:' + m[2] + 'px;font-size:' + Math.round(z * 0.45) + 'px';
    s.title = provider || '';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
  L.picon = picon;

  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* a view's problem */ } }); }
  async function load(refresh) {
    loading = true; emit();
    var r = await L.api('/api/fabric', { refresh: Boolean(refresh) });
    loading = false;
    if (r && r.ok) { data = r; at = Date.now(); }
    else if (r) L.toast(r.why || 'could not read MODEL', true);
    emit();
    return data;
  }
  function allRows() { var out = []; ((data && data.groups) || []).forEach(function (g) { g.rows.forEach(function (r) { out.push(r); }); }); return out; }
  function rowByKey(k) { return allRows().filter(function (r) { return r.key === k; })[0] || null; }
  function act(label, fn, cls, title) { var b = el('button', 'btn small' + (cls ? ' ' + cls : ''), label); if (title) b.title = title; b.onclick = async function () { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }; return b; }
  function gb(n) { return n == null ? '—' : (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1) + ' GB'; }
  function countdown(ms) {
    if (ms <= 0) return 'now';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : (s % 60) + 's';
  }
  function qbar(pct) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    fill.style.width = (pct == null ? 0 : Math.max(2, Math.min(100, pct))) + '%';
    fill.className = 'q-fill' + (pct == null ? '' : pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : '');
    return wrap;
  }
  function caps(roles, extra) {
    var box = el('span', '');
    (roles || []).forEach(function (c) { box.appendChild(el('span', 'cap' + (c === 'AGENT' ? ' agent' : ''), c)); });
    if (extra) box.appendChild(el('span', 'cap no', extra));
    return box;
  }

  async function useAs(row, lane) {
    var r = await L.api('/api/session/intel/set', { lane: lane, value: row.modelId, scope: 'session' });
    if (!r.ok) return L.toast(r.why, true);
    L.toast((lane === 'bot' ? 'BOT' : 'Coding Agent') + ' now uses ' + row.label + ' in this session.');
    if (L.composer && L.composer.refresh) L.composer.refresh();
    await load();
  }
  async function useInChat(row) {
    var r = await L.api('/api/models/select', { lane: 'chat', source: row.source || 'lain', modelId: row.modelId || '' });
    if (!r || !r.ok) return L.toast((r && r.why) || 'could not choose it', true);
    L.toast('CHAT now uses ' + row.label + '.');
    await load();
  }

  // ---- CURRENT -------------------------------------------------------------
  function roleCard(host, key, title, cur, extra) {
    var c = el('div', 'fab-role');
    c.setAttribute('data-role', key);
    var k = el('div', 'rk', title); c.appendChild(k);
    var n = el('div', 'rn');
    n.appendChild(picon(cur.icon || (cur.chatOnly ? 'openai' : (cur.local ? (cur.runtime === 'ollama' ? 'ollama' : 'llamacpp') : cur.runtime ? cur.runtime : 'lain')), 22));
    n.appendChild(el('b', '', cur.label || '—'));
    if (cur.chatOnly) n.appendChild(el('span', 'chatonly', 'CHAT ONLY'));
    c.appendChild(n);
    c.appendChild(el('div', 'rv', cur.via || ''));
    if (extra) c.appendChild(el('div', 'rv', extra));
    host.appendChild(c);
    return c;
  }
  function renderCurrent(pane) {
    var cur = data.current;
    var box = el('div', 'fab-cur');
    var ch = cur.chat;
    roleCard(box, 'chat', 'CHAT', ch.chatOnly ? { label: ch.label, via: ch.sourceLabel + (ch.alias ? ' · LAIN alias: ' + ch.alias : ''), chatOnly: true, icon: 'openai' } : { label: ch.label, via: ch.via, local: /Local/.test(ch.via || '') }, ch.chatOnly ? 'the CHAT view only — never the BOT or the Agent' : null);
    roleCard(box, 'bot', 'BOT', cur.bot, cur.bot.scope !== 'global' ? 'chosen for this ' + cur.bot.scope : 'default');
    roleCard(box, 'coding', 'CODING AGENT', cur.coding, cur.coding.delegated ? 'works through its runtime, with the runtime’s own tools' : (cur.coding.scope !== 'global' ? 'chosen for this ' + cur.coding.scope : 'default'));
    pane.appendChild(box);
  }

  // ---- AVAILABLE -----------------------------------------------------------
  function matches(r) {
    if (roleFilter === 'bot' && (r.roles || []).indexOf('BOT') < 0) return false;
    if (roleFilter === 'agent' && (r.roles || []).indexOf('AGENT') < 0) return false;
    if (roleFilter === 'chat' && (r.roles || []).indexOf('CHAT') < 0) return false;
    if (roleFilter === 'local' && r.kind !== 'local') return false;
    if (!filterText) return true;
    var q = filterText.toLowerCase();
    return [r.label, r.via, r.account, r.provider, r.modelId].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function usageCell(r) {
    var u = r.usage || {};
    var box = el('span', 'fuse');
    if (u.kind === 'windows' && u.windows && u.windows.length) {
      var w = u.windows.slice().sort(function (a, b) { return (b.usedPercent || 0) - (a.usedPercent || 0); })[0];
      box.appendChild(qbar(w.usedPercent)); box.appendChild(el('span', '', u.text || ''));
      box.title = u.basis || '';
      return box;
    }
    if (u.kind === 'percent') { box.appendChild(qbar(u.percent)); box.appendChild(el('span', '', u.text)); return box; }
    if (r.expectedReset && r.expectedReset.resetsAt) {
      var t = el('span', '', (u.text || '') + ' · resets in '); var cd = el('span', ''); cd.setAttribute('data-cd', String(r.expectedReset.resetsAt)); cd.textContent = countdown(r.expectedReset.resetsAt - Date.now()) + ' (expected)';
      box.appendChild(t); box.appendChild(cd); return box;
    }
    box.appendChild(el('span', u.kind === 'text' && /No provider quota/.test(u.text || '') ? '' : 'missing', u.text || '—'));
    return box;
  }
  function table(host, rows) {
    var wrap = el('div', 'fab-tw');
    var t = el('table', 'fabtbl');
    var cols = [['Model', '27%'], ['Provider / runtime', '15%'], ['Account / source', '17%'], ['Capabilities', '15%'], ['Usage / limit', '16%'], ['Status', '10%']];
    var hr = el('tr', ''); cols.forEach(function (c) { var th = el('th', '', c[0]); th.style.width = c[1]; hr.appendChild(th); });
    var th = el('thead', ''); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody', '');
    rows.forEach(function (r) {
      var tr = el('tr', 'frow');
      tr.setAttribute('data-key', r.key);
      tr.setAttribute('aria-selected', String(selected === r.key));
      tr.onclick = function () { selected = r.key; emit(); };
      var n = el('td', ''); var mn = el('div', 'mn'); mn.appendChild(picon(r.icon || r.provider, 24));
      var tt = el('div', 't'); var b = el('b', '', r.label); tt.appendChild(b);
      if (r.current && (r.current.bot || r.current.coding || r.current.chat)) b.appendChild(el('span', 'cur', [r.current.chat ? 'CHAT' : null, r.current.bot ? 'BOT' : null, r.current.coding ? 'AGENT' : null].filter(Boolean).join(' · ')));
      if (r.capabilityLabel) { var co = el('span', 'chatonly', r.capabilityLabel); co.style.marginLeft = '6px'; b.appendChild(co); }
      if (r.kind === 'local' && r.detail) tt.appendChild(el('small', '', [r.detail.quantization, r.detail.size, r.detail.contextLength ? 'ctx ' + r.detail.contextLength.toLocaleString() : null].filter(Boolean).join(' · ')));
      else if (r.modelCount != null) tt.appendChild(el('small', '', r.modelCount + ' models'));
      mn.appendChild(tt); n.appendChild(mn); tr.appendChild(n);
      var v = el('td', '', r.via); v.title = r.via; tr.appendChild(v);
      var a = el('td', '', r.account || '—'); a.title = r.account || ''; tr.appendChild(a);
      var c = el('td', 'capcell'); c.appendChild(caps(r.roles, r.kind === 'local' && (r.roles || []).indexOf('AGENT') < 0 ? 'AGENT ' + (r.agent === 'partial' ? 'partial' : r.agent === 'unsupported' ? 'unsupported' : 'not verified') : r.kind === 'plan' && !(r.roles || []).length ? 'no execution' : null)); tr.appendChild(c);
      var u = el('td', ''); u.appendChild(usageCell(r)); tr.appendChild(u);
      var s = el('td', ''); var st = el('span', 'fst ' + ((r.status && r.status.cls) || '')); st.appendChild(el('span', 'sdot', '●')); st.appendChild(el('span', '', (r.status && r.status.word) || '—')); s.appendChild(st); tr.appendChild(s);
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
  }

  function renderModels(pane) {
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading what LAIN can use…' : 'Not read yet.')); if (!loading) load(); return; }
    renderCurrent(pane);
    var bar = el('div', 'fab-bar');
    var q = document.createElement('input'); q.placeholder = 'Filter models…'; q.value = filterText; q.setAttribute('data-fabfilter', '1');
    q.oninput = function () { filterText = q.value; var pos = q.selectionStart; emit(); var n = document.querySelector('[data-fabfilter]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* not a text input */ } } };
    bar.appendChild(q);
    [['all', 'All'], ['bot', 'BOT'], ['agent', 'AGENT'], ['chat', 'CHAT'], ['local', 'Local']].forEach(function (f) {
      var b = el('button', 'chipb', f[1]); b.setAttribute('aria-pressed', String(roleFilter === f[0])); b.onclick = function () { roleFilter = f[0]; emit(); }; bar.appendChild(b);
    });
    pane.appendChild(bar);
    var wrap = el('div', 'fab');
    var left = el('div', '');
    var first = null;
    data.groups.forEach(function (g) {
      var rows = g.rows.filter(matches);
      var box = el('div', 'fab-grp');
      box.setAttribute('data-group', g.id);
      var h = el('h4', '', g.title); h.appendChild(el('small', '', rows.length + (rows.length !== g.rows.length ? ' of ' + g.rows.length : ''))); box.appendChild(h);
      if (!g.rows.length) { box.appendChild(el('div', 'empty-card', g.empty)); left.appendChild(box); return; }
      if (!rows.length) { box.appendChild(el('div', 'missing', 'Nothing here matches the filter.')); left.appendChild(box); return; }
      if (!first) first = rows[0].key;
      table(box, rows);
      left.appendChild(box);
    });
    wrap.appendChild(left);
    var r = rowByKey(selected) || rowByKey(first);
    if (r) detail(wrap, r);
    pane.appendChild(wrap);
    ensureTicker();
  }

  // ---- details, per kind of source ------------------------------------------
  function kv(dl, k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(v))); }
  function detail(host, r) {
    var d = el('aside', 'fdet');
    d.setAttribute('data-fdetail', r.key);
    var h = el('h3', ''); h.appendChild(picon(r.icon || r.provider, 24)); h.appendChild(document.createTextNode(r.label)); if (r.capabilityLabel) h.appendChild(el('span', 'chatonly', r.capabilityLabel)); d.appendChild(h);
    d.appendChild(el('div', 'sub', r.via + (r.account ? ' · ' + r.account : '')));
    if (r.kind === 'local') detailLocal(d, r);
    else if (r.kind === 'runtime' || r.kind === 'runtime-summary') detailRuntime(d, r);
    else if (r.key === 'zcode:start-plan') detailStartPlan(d, r);
    else if (r.key === 'freebuff') detailFreebuff(d, r);
    else if (r.kind === 'plan') detailPlan(d, r);
    else if (r.kind === 'chat') detailChat(d, r);
    else detailApi(d, r);
    host.appendChild(d);
  }

  function detailLocal(d, r) {
    var x = r.detail || {};
    var dl = el('dl', '');
    kv(dl, 'Source', r.provider === 'ollama' ? 'Ollama runtime' : 'llama.cpp'); kv(dl, 'File', x.file);
    kv(dl, 'Architecture', x.architecture); kv(dl, 'Parameters', x.sizeLabel || x.parameterSize);
    kv(dl, 'Quantization', x.quantization ? x.quantization + (x.quantSource === 'file name' ? ' (from the file name)' : '') : null);
    kv(dl, 'Size', x.size); kv(dl, 'Context', x.contextLength ? x.contextLength.toLocaleString() + ' tokens (model maximum)' : 'not stated');
    kv(dl, 'Tokenizer', x.tokenizer); kv(dl, 'Chat template', x.chatTemplate ? (x.chatTemplate.present ? 'present (' + x.chatTemplate.chars + ' chars)' : 'absent') : null);
    kv(dl, 'Provider quota', 'none — a local model');
    d.appendChild(dl);
    d.appendChild(el('h5', '', 'Capabilities'));
    d.appendChild(caps(r.roles, (r.roles || []).indexOf('AGENT') < 0 ? 'AGENT ' + r.agent : null));
    if (r.provider === 'llama.cpp') {
      d.appendChild(el('h5', '', 'Vision projector'));
      d.appendChild(el('div', 'note', x.projector ? x.projector.split(/[\\/]/).pop() + ' — ' + x.pairing : (x.pairing || 'none')));
      var projs = (data.local && data.local.projectors) || [];
      if (projs.length) {
        var sel = document.createElement('select');
        [['', 'Automatic'], ['none', 'No projector']].concat(projs.map(function (p) { return [p.file, p.name]; })).forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
        sel.onchange = async function () { await L.api('/api/local/pair', { model: x.file, projector: sel.value === '' ? undefined : sel.value === 'none' ? null : sel.value }); await load(); };
        d.appendChild(sel);
      }
      d.appendChild(el('h5', '', 'Runtime'));
      var srv = x.server;
      var dl2 = el('dl', '');
      if (srv) { kv(dl2, 'State', srv.state); kv(dl2, 'PID', srv.pid); kv(dl2, 'Port', srv.port); kv(dl2, 'Context', srv.ctx); kv(dl2, 'Process memory', srv.memoryBytes ? gb(srv.memoryBytes) + ' (working set, measured — not VRAM)' : 'not readable'); kv(dl2, 'Requests', srv.requests); if (srv.lastError) kv(dl2, 'Last error', srv.lastError); }
      else { kv(dl2, 'State', 'not running — LAIN starts it on first use'); kv(dl2, 'Needs about', x.estimate ? gb(x.estimate.total) + ' (weights ' + gb(x.estimate.weights) + (x.estimate.projector ? ', projector ' + gb(x.estimate.projector) : '') + ', context)' : null); }
      d.appendChild(dl2);
      var sp = x.speed || {};
      if (sp.requests) {
        d.appendChild(el('h5', '', 'Measured on this machine'));
        var dl3 = el('dl', ''); kv(dl3, 'Prompt', sp.promptTokPerSec == null ? '—' : sp.promptTokPerSec + ' tok/s'); kv(dl3, 'Generation', sp.tokPerSec == null ? '—' : sp.tokPerSec + ' tok/s'); kv(dl3, 'Requests', sp.requests); d.appendChild(dl3);
        if (sp.firstReplySecs && sp.firstReplySecs > 60) d.appendChild(el('div', 'warnline', 'LAIN’s BOT request is about ' + sp.botRequestTokens.toLocaleString() + ' tokens (instructions and tool schemas). At ' + sp.promptTokPerSec + ' tok/s the first reply takes about ' + Math.round(sp.firstReplySecs / 60) + ' min here; later turns reuse that prefix and only process what is new.'));
      }
      // ADVANCED: runtime defaults, kept out of the picker.
      var adv = el('details', ''); adv.appendChild(el('summary', '', 'Advanced — runtime defaults'));
      var g = el('div', 'advgrid'); var vals = {};
      [['ctx', 'Context', x.runtime && x.runtime.ctx], ['ngl', 'GPU layers', x.runtime && x.runtime.ngl], ['threads', 'Threads', x.runtime && x.runtime.threads]].forEach(function (f) {
        var w = el('div', ''); w.appendChild(el('label', '', f[1])); var i = document.createElement('input'); i.value = f[2] == null ? '' : String(f[2]); i.placeholder = 'default'; vals[f[0]] = i; w.appendChild(i); g.appendChild(w);
      });
      adv.appendChild(g);
      adv.appendChild(act('Save defaults', async function () { var r2 = await L.api('/api/local/defaults', { file: x.file, values: { ctx: vals.ctx.value, ngl: vals.ngl.value, threads: vals.threads.value } }); L.toast(r2.ok ? 'Saved. A running server keeps its settings until it restarts.' : r2.why, !r2.ok); await load(); }));
      d.appendChild(adv);
    }
    if (x.agentTest) {
      d.appendChild(el('h5', '', 'Agent test' + (x.agentTest.stale ? ' — out of date' : '') + ' · ' + x.agentTest.result));
      (x.agentTest.probes || []).forEach(function (p) { var row = el('div', 'probe'); row.appendChild(el('span', p.pass ? 'p' : 'f', p.pass ? '✓' : '✗')); row.appendChild(el('span', '', p.id)); var dd = el('span', 'missing', p.detail); dd.title = p.detail; row.appendChild(dd); d.appendChild(row); });
      if (x.agentTest.stale) d.appendChild(el('div', 'warnline', 'The model file, runtime version or configuration changed since this test — test again.'));
    }
    var acts = el('div', 'acts');
    acts.appendChild(act('Use as BOT', function () { return useAs(r, 'bot'); }, 'primary'));
    var ag = act('Use as Agent', function () { return useAs(r, 'coding'); }, '', (r.roles || []).indexOf('AGENT') < 0 ? 'Run the Agent test first' : '');
    if ((r.roles || []).indexOf('AGENT') < 0) ag.disabled = true;
    acts.appendChild(ag);
    acts.appendChild(act(r.agent === 'testing…' ? 'Testing…' : 'Test for Agent', async function () { var t = await L.api('/api/local/agent-test', { model: r.modelId }); if (!t.ok) return L.toast(t.why, true); L.toast('Testing ' + r.label + ' — a few short requests.'); await load(); pollTests(); }));
    if (r.provider === 'llama.cpp') {
      var srv2 = x.server;
      if (!srv2) acts.appendChild(act('Start', async function () { L.toast('Starting ' + r.label + '…'); var s = await L.api('/api/local/llama/start', { model: r.modelId }); L.toast(s.ok ? r.label + ' is ready.' : s.why, !s.ok); await load(); }));
      else { acts.appendChild(act('Stop', async function () { var s = await L.api('/api/local/llama/stop', { model: r.modelId }); L.toast(s.ok ? 'Stopped (pid ' + s.pid + ').' : s.why, !s.ok); await load(); })); acts.appendChild(act('Restart', async function () { var s = await L.api('/api/local/llama/restart', { model: r.modelId }); L.toast(s.ok ? 'Restarted.' : s.why, !s.ok); await load(); })); }
    }
    d.appendChild(acts);
  }
  var testPoll = null;
  function pollTests() {
    if (testPoll) return;
    testPoll = setInterval(async function () { await load(); if (!data || !(data.testing || []).length) { clearInterval(testPoll); testPoll = null; } }, 4000);
  }

  function windowsBlock(d, u) {
    if (!u || u.kind !== 'windows') return;
    d.appendChild(el('h5', '', 'Usage windows'));
    u.windows.forEach(function (w) {
      var row = el('div', 'probe'); row.style.gridTemplateColumns = '120px 70px minmax(0,1fr)';
      row.appendChild(el('span', '', w.label)); row.appendChild(el('span', '', w.usedPercent == null ? '?' : Math.round(w.usedPercent) + '% used'));
      var rs = el('span', 'missing'); if (w.resetsAt) { rs.setAttribute('data-cd', String(w.resetsAt)); rs.textContent = 'resets in ' + countdown(w.resetsAt - Date.now()); } row.appendChild(rs);
      d.appendChild(row);
    });
    if (u.basis) d.appendChild(el('div', 'note', 'Reported by ' + u.basis.replace(/^reported by /, '') + (u.at ? ' at ' + L.fmt.time(u.at) : '') + '. Windows are never combined.'));
  }
  function detailRuntime(d, r) {
    var rt = ((data.runtimes || []).filter(function (x) { return r.via.indexOf(x.label) === 0; })[0]) || null;
    var dl = el('dl', '');
    kv(dl, 'Source', r.via); kv(dl, 'Authentication', rt ? rt.authentication : null);
    if (r.detail && r.detail.identity) kv(dl, 'Identity', [r.detail.identity.email, r.detail.identity.plan, r.detail.identity.method].filter(Boolean).join(' · ') + (r.detail.identity.signedIn ? '' : ' (not signed in)'));
    if (r.detail && r.detail.resolved) kv(dl, 'Resolves to', r.detail.resolved);
    if (r.detail && r.detail.entitlement) kv(dl, 'Entitlement', r.detail.entitlement.label);
    kv(dl, 'Status', rt ? rt.state : (r.status && r.status.word));
    d.appendChild(dl);
    d.appendChild(el('h5', '', 'Capabilities'));
    d.appendChild(caps(r.roles));
    if (rt) {
      d.appendChild(el('div', 'note', 'BOT: ' + (rt.execution.chat.ok ? rt.execution.chat.how : rt.execution.chat.why)));
      d.appendChild(el('div', 'note', 'Agent: ' + (rt.execution.agent.ok ? rt.execution.agent.how : rt.execution.agent.why)));
    }
    windowsBlock(d, r.usage);
    if (r.kind === 'runtime' && (r.roles || []).indexOf('BOT') >= 0) d.appendChild(el('div', 'note', 'As the BOT, a runtime model answers in text; LAIN\u2019s own tools are not handed to another program. As the Agent, it works in the project with its own tools.'));
    var acts = el('div', 'acts');
    if (r.modelId && (r.roles || []).indexOf('BOT') >= 0) acts.appendChild(act('Use for BOT', function () { return useAs(r, 'bot'); }, 'primary'));
    if (r.modelId && (r.roles || []).indexOf('AGENT') >= 0) acts.appendChild(act('Use for Agent', function () { return useAs(r, 'coding'); }));
    if (rt && r.modelId) acts.appendChild(act('Test', async function () {
      var ok = await L.confirm('Send one short prompt ("Reply with OK") through ' + rt.label + '? It uses a little of that account\u2019s allowance.', { ok: 'Send test' });
      if (!ok) return;
      var t = await L.api('/api/runtimes/test', { id: rt.id, model: r.modelId });
      L.toast(t.ok ? rt.label + ' answered "' + t.text + '" in ' + Math.round(t.ms / 100) / 10 + ' s.' : t.why, !t.ok);
      await load(true);
    }));
    if (rt) acts.appendChild(act('Refresh', async function () { await L.api('/api/runtimes', { id: rt.id, refresh: true }); await load(); }));
    if (rt && rt.install && rt.install.docs) acts.appendChild(act('Open docs ↗', function () { return L.openExternal(rt.install.docs); }));
    if (rt && rt.kind === 'runtime') acts.appendChild(disconnectBtn(rt));
    d.appendChild(acts);
    if (rt && rt.id === 'claude-code') d.appendChild(el('div', 'note', 'Choosing another model disconnects nothing: Claude Code keeps its own sign-in. Signing out of Claude is done in Claude Code (claude auth logout), never by LAIN.'));
  }
  function disconnectBtn(rt) {
    return act(rt.disconnected ? 'Reconnect to LAIN' : 'Disconnect from LAIN', async function () {
      if (!rt.disconnected) { var ok = await L.confirm('Stop offering ' + rt.label + '’s models in LAIN? This does not sign you out of ' + rt.label + ' — its own sign-in stays where it is.', { ok: 'Disconnect from LAIN' }); if (!ok) return; }
      var r = await L.api('/api/runtimes/disconnect', { id: rt.id, reconnect: Boolean(rt.disconnected) });
      L.toast(r.ok ? (rt.disconnected ? rt.label + ' is offered again.' : r.note) : r.why, !r.ok); await load();
    }, rt.disconnected ? '' : 'danger');
  }
  function detailStartPlan(d, r) {
    var x = r.detail || {};
    var p = el('div', 'plan');
    p.appendChild(el('div', 'pk', 'START PLAN'));
    p.appendChild(el('div', 'pn', 'GLM-5.3-Flash'));
    var sp = x.plan && x.plan.startPlan;
    p.appendChild(el('div', 'bal', sp ? (sp.status === 'available' ? 'Active' : 'Unavailable — ' + (r.usage.text.replace(/^unavailable — /, ''))) : 'Status not read yet'));
    if (x.plan && x.plan.recordedAt) p.appendChild(el('div', 'note', 'As ZCode recorded it at ' + new Date(x.plan.recordedAt).toLocaleString() + '.'));
    p.appendChild(el('div', 'note', 'Balance and expiry: not exposed by ZCode\u2019s runtime protocol — open ZCode to see them.'));
    d.appendChild(p);
    var dl = el('dl', '');
    kv(dl, 'Group', 'Z.ai / ZCode'); kv(dl, 'Model', 'GLM-5.3-Flash');
    if (x.plan && x.plan.codingPlan) kv(dl, 'Coding Plan', x.plan.codingPlan.status === 'available' ? 'available (as ZCode recorded)' : 'unavailable');
    if (x.runtimeUsage) kv(dl, 'Used through ZCode', (x.runtimeUsage.totalTokens || 0).toLocaleString() + ' tokens · ' + (x.runtimeUsage.requestCount || 0) + ' requests (last 30 days, reported by the ZCode runtime)');
    d.appendChild(dl);
    d.appendChild(el('h5', '', 'Execution'));
    d.appendChild(el('div', 'warnline', (x.execution && x.execution.why) || 'not available'));
    var acts = el('div', 'acts');
    acts.appendChild(act('Open ZCode to claim or check', function () { return L.api('/api/runtimes/open', { id: 'zcode' }).then(function (o) { if (!o.ok) L.toast(o.why, true); }); }, 'primary'));
    acts.appendChild(act('Refresh', async function () { await L.api('/api/runtimes', { id: 'zcode', refresh: true }); await load(); }));
    d.appendChild(acts);
  }
  function detailFreebuff(d, r) {
    var x = r.detail || {};
    var p = el('div', 'plan');
    p.appendChild(el('div', 'pk', 'CREDITS'));
    p.appendChild(el('div', 'pn', 'not reported'));
    p.appendChild(el('div', 'bal', 'Freebuff shows its credits only inside its own window. LAIN shows no figure rather than guess one.'));
    if (r.expectedReset) { var cd = el('div', 'note'); cd.setAttribute('data-cd', String(r.expectedReset.resetsAt)); cd.setAttribute('data-cd-prefix', 'Expected reset in '); cd.textContent = 'Expected reset in ' + countdown(r.expectedReset.resetsAt - Date.now()); p.appendChild(cd); p.appendChild(el('div', 'note', r.expectedReset.basis)); }
    d.appendChild(p);
    var dl = el('dl', '');
    kv(dl, 'Discovery', 'installed ' + (r.account || ''));
    kv(dl, 'Telemetry', 'not available — no status command or API');
    kv(dl, 'Execution', (x.execution && x.execution.chat && x.execution.chat.why) || 'not available');
    if (x.sessions) kv(dl, 'Sessions', x.sessions.count + ' project folder(s) with Freebuff history');
    d.appendChild(dl);
  }
  function detailPlan(d, r) {
    var dl = el('dl', '');
    kv(dl, 'Source', r.via); kv(dl, 'Identity', r.account); kv(dl, 'Status', r.status && r.status.word);
    d.appendChild(dl);
    windowsBlock(d, r.usage);
    if (r.detail && r.detail.execution) d.appendChild(el('div', 'note', r.detail.execution));
    var acts = el('div', 'acts');
    acts.appendChild(act('Open account', function () { L.nav.go('model', { section: 'instances' }); if (L.instances && r.detail && r.detail.instance) L.instances.select(r.detail.instance); }));
    d.appendChild(acts);
  }
  function detailChat(d, r) {
    var dl = el('dl', '');
    kv(dl, 'Source', r.via); if (r.modelId) kv(dl, 'LAIN alias', r.modelId + ' (a LAIN route name — not an OpenAI model id)');
    kv(dl, 'Capability', 'CHAT ONLY'); kv(dl, 'Status', r.status && r.status.word);
    if (r.detail && r.detail.siteModel) kv(dl, 'Site option', r.detail.siteModel);
    kv(dl, 'Usage', 'observed by LAIN (sizes, time) — estimated tokens, never billed figures');
    d.appendChild(dl);
    d.appendChild(el('div', 'note', 'Not Codex, not the OpenAI API, not ChatGPT identity. It can answer in CHAT; it cannot be the BOT, the Coding Agent, a worker or a fallback.'));
    var acts = el('div', 'acts');
    acts.appendChild(act('Use in CHAT', function () { return useInChat(r); }, 'primary'));
    acts.appendChild(act('Sign-in…', function () { L.nav.go('model', { section: 'signins' }); }));
    d.appendChild(acts);
  }
  function detailApi(d, r) {
    var dl = el('dl', '');
    kv(dl, 'Source', r.via); kv(dl, 'Account', r.account); kv(dl, 'Models', r.modelCount); kv(dl, 'Status', r.status && r.status.word);
    kv(dl, 'Limit', r.usage && r.usage.text);
    d.appendChild(dl);
    if (r.detail && r.detail.models && r.detail.models.length) { d.appendChild(el('h5', '', 'Models')); d.appendChild(el('div', 'missing', r.detail.models.slice(0, 24).join(', ') + (r.modelCount > 24 ? ' …' : ''))); }
    var acts = el('div', 'acts');
    acts.appendChild(act('Open provider', function () { L.nav.go('model', { section: 'p:' + r.provider }); }, 'primary'));
    acts.appendChild(act('Accounts', function () { L.nav.go('model', { section: 'instances' }); }));
    d.appendChild(acts);
  }

  // ---- LOCAL -----------------------------------------------------------------
  function renderLocal(pane) {
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading local models…' : 'Not read yet.')); if (!loading) load(); return; }
    var rts = data.runtimes || [];
    var llama = rts.filter(function (x) { return x.id === 'llamacpp'; })[0];
    var oll = rts.filter(function (x) { return x.id === 'ollama'; })[0];
    var sec = el('div', 'lsec'); sec.setAttribute('data-local', 'llamacpp');
    var h = el('h4', ''); h.appendChild(picon('llamacpp', 20)); h.appendChild(document.createTextNode('llama.cpp'));
    h.appendChild(el('span', 'rtstate ' + (llama && llama.discovery.ok ? 'ok' : 'bad'), llama && llama.discovery.ok ? 'Installed · ' + (llama.discovery.version || '') : 'Not installed'));
    sec.appendChild(h);
    if (llama && llama.discovery.ok) sec.appendChild(el('div', 'missing', 'llama-server: ' + llama.discovery.binary));
    var dirs = (data.local && data.local.dirs) || [];
    var bar = el('div', 'acts'); bar.style.cssText = 'display:flex;gap:6px;margin:10px 0';
    bar.appendChild(act('Add Model Directory', addDir, 'primary'));
    if (dirs.length) bar.appendChild(act('Rescan all', async function () { await L.api('/api/local/dirs/rescan', {}); await load(); }));
    sec.appendChild(bar);
    if (!dirs.length) sec.appendChild(el('div', 'empty-card', 'No model directory yet. Choose a folder with .gguf files — LAIN stores the folder\u2019s path only, reads each file\u2019s header, and never copies, moves or deletes a model.'));
    dirs.forEach(function (dd) {
      var row = el('div', 'dirrow'); row.setAttribute('data-dir', dd.id);
      var t = el('div', ''); t.appendChild(el('b', '', dd.path));
      t.appendChild(el('small', '', dd.exists ? (dd.counts.gguf + ' GGUF · ' + dd.counts.text + ' text model(s) · ' + dd.counts.projector + ' projector(s)' + (dd.counts.other ? ' · ' + dd.counts.other + ' other (not text models)' : '') + (dd.scannedAt ? ' · scanned ' + L.fmt.time(dd.scannedAt) : '')) : 'folder not found — the reference is kept until you remove it'));
      row.appendChild(t);
      var a = el('div', ''); a.style.cssText = 'display:flex;gap:6px';
      a.appendChild(act('Rescan', async function () { await L.api('/api/local/dirs/rescan', { id: dd.id }); await load(); }));
      a.appendChild(act('Remove reference', async function () {
        var ok = await L.confirm('Forget ' + dd.path + '? Only LAIN\u2019s reference is removed — the folder and every model in it stay exactly where they are.', { ok: 'Remove reference' });
        if (!ok) return; var r = await L.api('/api/local/dirs/remove', { id: dd.id }); L.toast(r.ok ? r.note : r.why, !r.ok); await load();
      }));
      row.appendChild(a); sec.appendChild(row);
    });
    var llamaRows = allRows().filter(function (r) { return r.kind === 'local' && r.provider === 'llama.cpp'; });
    if (llamaRows.length) { var wrap = el('div', 'fab'); var left = el('div', ''); table(left, llamaRows); wrap.appendChild(left); var sel = rowByKey(selected); detail(wrap, sel && sel.provider === 'llama.cpp' ? sel : llamaRows[0]); sec.appendChild(wrap); }
    var other = (data.local && data.local.other) || [];
    if (other.length) { var det = el('details', ''); det.appendChild(el('summary', '', other.length + ' other GGUF file(s) — not text models llama-server can serve')); other.forEach(function (o) { det.appendChild(el('div', 'missing', o.name + (o.quantization ? ' · ' + o.quantization : '') + (o.sizeBytes ? ' · ' + gb(o.sizeBytes) : '') + (o.why ? ' · ' + o.why : ''))); }); sec.appendChild(det); }
    pane.appendChild(sec);

    var s2 = el('div', 'lsec'); s2.setAttribute('data-local', 'ollama');
    var h2 = el('h4', ''); h2.appendChild(picon('ollama', 20)); h2.appendChild(document.createTextNode('Ollama'));
    var od = oll ? oll.discovery : {};
    h2.appendChild(el('span', 'rtstate ' + (od.running ? 'ok' : od.installed ? 'warn' : 'bad'), od.running ? 'Running · ' + (od.version || '') : od.installed ? 'Installed · not running' : 'Not installed'));
    s2.appendChild(h2);
    s2.appendChild(el('div', 'missing', 'Endpoint: ' + (od.endpoint || 'http://127.0.0.1:11434') + (od.endpointConfigured ? ' (configured)' : ' (default)') + (od.why ? ' — ' + od.why : '')));
    var b2 = el('div', 'acts'); b2.style.cssText = 'display:flex;gap:6px;margin:10px 0';
    b2.appendChild(act('Refresh', async function () { await L.api('/api/local/ollama/refresh', {}); await L.api('/api/runtimes', { id: 'ollama', refresh: true }); await load(); }));
    if (!od.installed && oll && oll.install) b2.appendChild(act('Install help ↗', function () { return L.openExternal(oll.install.docs); }));
    b2.appendChild(act('Open settings', function () { L.nav.go('settings', { section: 'models' }); }));
    s2.appendChild(b2);
    var olRows = allRows().filter(function (r) { return r.kind === 'local' && r.provider === 'ollama'; });
    if (olRows.length) table(s2, olRows);
    else s2.appendChild(el('div', 'empty-card', od.running ? 'Ollama lists no models. Pull one with Ollama, then Refresh.' : 'LAIN does not start or install Ollama. When it runs at the endpoint above, its models appear here.'));
    pane.appendChild(s2);
    ensureTicker();
  }
  async function addDir() {
    var p = null;
    try { var r = await L.hostCall('pickFolder', { title: 'Model directory (folders with .gguf files)' }); p = r && (r.path || r.value || (typeof r === 'string' ? r : null)); } catch (e) { p = null; }
    if (!p) {
      var v = await L.dialog({ title: 'Add Model Directory', text: 'The folder that holds your .gguf models. LAIN keeps only this path.', fields: [{ key: 'path', label: 'Folder', placeholder: 'E:\\AI\\models' }], ok: 'Add' });
      p = v && v.path;
    }
    if (!p) return;
    L.toast('Scanning ' + p + ' — headers only…');
    var a = await L.api('/api/local/dirs/add', { path: p });
    L.toast(a.ok ? 'Found ' + a.scan.gguf + ' GGUF file(s) in ' + p + '.' : a.why, !a.ok);
    await load();
  }

  // ---- RUNTIMES ------------------------------------------------------------
  function stateCls(s) { return /Operational|Ready|Running/.test(s) ? 'ok' : /Not installed|Error/.test(s) ? 'bad' : 'warn'; }
  function renderRuntimes(pane) {
    if (!data) { pane.appendChild(el('div', 'missing', loading ? 'Reading runtimes…' : 'Not read yet.')); if (!loading) load(); return; }
    var bar = el('div', 'acts'); bar.style.cssText = 'display:flex;gap:6px;margin:0 0 12px';
    bar.appendChild(act('Refresh all', async function () { L.toast('Asking each runtime… (a few seconds)'); await load(true); }, 'primary'));
    pane.appendChild(bar);
    (data.runtimes || []).forEach(function (rt) {
      var c = el('div', 'rtcard'); c.setAttribute('data-runtime', rt.id);
      var h = el('div', 'rh'); h.appendChild(picon(rt.icon || rt.id, 26)); h.appendChild(el('b', '', rt.label));
      if (rt.discovery.version) h.appendChild(el('small', '', rt.discovery.version));
      h.appendChild(el('span', 'spacer', ''));
      h.appendChild(el('span', 'rtstate ' + stateCls(rt.state), rt.state));
      c.appendChild(h);
      var tri = el('div', 'rt3');
      var cell = function (k, yes, text) { var x = el('div', 'c'); var kk = el('div', 'k'); kk.appendChild(el('span', yes ? 'y' : 'n', yes ? '✓' : '✗')); kk.appendChild(document.createTextNode(k)); x.appendChild(kk); x.appendChild(el('div', 'v', text)); tri.appendChild(x); };
      cell('DISCOVERY', rt.discovery.ok, rt.discovery.ok ? (rt.discovery.binary || rt.discovery.endpoint || 'found') : (rt.discovery.why || 'not found'));
      var tt = rt.telemetry.ok ? telemetryText(rt) : (rt.telemetry.why || 'not read yet');
      cell('TELEMETRY', rt.telemetry.ok, tt);
      var ex = rt.execution;
      cell('EXECUTION', ex.chat.ok || ex.agent.ok, 'BOT: ' + (ex.chat.ok ? ex.chat.how : ex.chat.why) + ' · Agent: ' + (ex.agent.ok ? ex.agent.how : ex.agent.why) + (ex.startPlan ? ' · Start Plan: ' + ex.startPlan.why : ''));
      c.appendChild(tri);
      // THE CAPABILITY MATRIX (runtimecaps.js) — eleven answers, each with its reason.
      if (rt.capabilities) {
        var mx = el('div', 'rtcaps');
        ['discovery', 'telemetry', 'execution', 'sessions', 'usage', 'limits', 'streaming', 'cancel', 'bot', 'chat', 'agent'].forEach(function (k) {
          var cc = rt.capabilities[k]; if (!cc) return;
          var x = el('div', 'cap ' + (/Operational/.test(cc.level) ? 'ok' : /Available|Telemetry|Detected/.test(cc.level) ? 'mid' : /Not reported/.test(cc.level) ? 'nr' : 'no'));
          x.appendChild(el('span', 'ck', k.toUpperCase()));
          x.appendChild(el('span', 'cl', cc.level));
          if (cc.why) x.title = cc.why;
          mx.appendChild(x);
        });
        c.appendChild(mx);
      }
      var a = el('div', 'acts');
      a.appendChild(act('Refresh', async function () { await L.api('/api/runtimes', { id: rt.id, refresh: true }); await load(); }));
      if (rt.id === 'llamacpp' || rt.id === 'ollama') a.appendChild(act('Open', function () { L.nav.go('model', { section: 'local' }); }));
      if (rt.id === 'freebuff' && rt.discovery.ok) a.appendChild(act('Launch Freebuff', function () { return L.api('/api/runtimes/open', { id: 'freebuff' }).then(function (o) { if (!o.ok) L.toast(o.why, true); else L.toast('Freebuff opened in its own window (in ' + o.cwd + ') — it runs there, not through LAIN.'); }); }));
      if (rt.id === 'opencode' && rt.discovery.ok && rt.detail && (rt.detail.models || []).length) a.appendChild(verifyPicker(rt));
      if (rt.id === 'zcode' && rt.discovery.ok) a.appendChild(act('Open ZCode', function () { return L.api('/api/runtimes/open', { id: 'zcode' }).then(function (o) { if (!o.ok) L.toast(o.why, true); }); }));
      if (rt.kind === 'runtime' && rt.discovery.ok) a.appendChild(disconnectBtn(rt));
      if (!rt.discovery.ok && rt.install && rt.install.docs) a.appendChild(act('Install help ↗', function () { return L.openExternal(rt.install.docs); }));
      else if (rt.install && rt.install.docs) a.appendChild(act('Docs ↗', function () { return L.openExternal(rt.install.docs); }));
      c.appendChild(a);
      pane.appendChild(c);
    });
    pane.appendChild(el('div', 'missing', 'Every runtime runs as its own program with its own sign-in. LAIN never copies a runtime\u2019s credentials, never calls the service behind it, and never downloads a runtime by itself. Processes LAIN starts are registered and stopped by LAIN; nothing is stopped by name.'));
  }
  /** VERIFY an OpenCode model for CHAT / BOT / AGENT — LAIN's compatibility test, run through OpenCode itself. */
  function verifyPicker(rt) {
    var box = el('span', ''); box.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
    var sel = el('select', 'vsel');
    var ver = (rt.detail && rt.detail.verified) || {};
    (rt.detail.models || []).filter(function (m) { return m.runtimeBound || (m.entitlement && m.entitlement.runtimeBound) || /free|big-pickle/.test(m.id); }).concat((rt.detail.models || []).filter(function (m) { return !(m.runtimeBound || (m.entitlement && m.entitlement.runtimeBound) || /free|big-pickle/.test(m.id)); })).forEach(function (m) {
      var v = ver[m.id];
      var o = el('option', '', m.id + (v ? (v.chat && v.agent ? '  ✓ CHAT·BOT·AGENT' : v.chat ? '  ✓ CHAT·BOT, ✗ AGENT' : '  ✗ failed') : ''));
      o.value = m.id; sel.appendChild(o);
    });
    box.appendChild(sel);
    box.appendChild(act('Verify', async function () {
      L.toast('Verifying ' + sel.value + ' through OpenCode (a chat probe and a small agent task in a scratch folder)…');
      var r = await L.api('/api/runtimes/verify', { id: 'opencode', model: sel.value });
      if (!r || !r.ok) return L.toast((r && r.why) || 'verification failed', true);
      L.toast(sel.value + ': chat ' + (r.chat ? '✓' : '✗') + ' · agent ' + (r.agent ? '✓' : '✗') + (r.detail ? ' — ' + r.detail : ''), !(r.chat && r.agent));
      await load();
    }));
    return box;
  }
  function telemetryText(rt) {
    var t = rt.detail || {};
    if (rt.id === 'claude-code') return (t.identity ? (t.identity.signedIn ? 'signed in' : 'not signed in') + (t.identity.plan ? ' · ' + t.identity.plan : '') + (t.identity.email ? ' · ' + t.identity.email : '') : '') + (t.limits ? ' · windows: ' + t.limits.windows.map(function (w) { return w.label + ' ' + Math.round(w.usedPercent) + '%'; }).join(', ') : ' · windows after the first run');
    if (rt.id === 'opencode') return (t.models || []).length + ' models (' + ((t.counts && t.counts.runtimeBound) || 0) + ' runtime-bound free)' + (t.providers ? ' · ' + t.providers.length + ' provider credential(s) held by OpenCode' : '') + (t.sessions ? ' · ' + t.sessions.count + ' session(s)' : '');
    if (rt.id === 'zcode') return (t.usage && t.usage.summary ? (t.usage.summary.totalTokens || 0).toLocaleString() + ' tokens in ' + t.usage.range + ' (runtime-reported)' : 'usage not read') + ' · ' + (t.models || []).length + ' model(s) it serves standalone' + (t.plan && t.plan.startPlan ? ' · Start Plan ' + t.plan.startPlan.status : '');
    if (rt.id === 'llamacpp') return (t.models || []).length + ' model(s) in ' + (t.dirs || []).length + ' director(ies)' + ((t.servers || []).length ? ' · ' + t.servers.length + ' running' : '');
    if (rt.id === 'ollama') return (t.models || []).length + ' model(s)' + ((t.loaded || []).length ? ' · ' + t.loaded.length + ' loaded' : '');
    return 'read';
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(function () {
      var nodes = document.querySelectorAll('[data-cd]');
      if (!nodes.length) return;
      Array.prototype.forEach.call(nodes, function (n) {
        var t = Number(n.getAttribute('data-cd')); if (!t) return;
        var pre = n.getAttribute('data-cd-prefix');
        var left = t - Date.now();
        n.textContent = left <= 0 ? (pre ? pre.replace(/ in $/, '') + ': due — not confirmed' : 'reset due — not confirmed') : (pre || (/resets in/.test(n.textContent) ? 'resets in ' : '')) + countdown(left) + (/(expected)/.test(n.textContent) ? ' (expected)' : '');
      });
    }, 1000);
  }

  L.fabric = {
    load: load, get: function () { return { data: data, loading: loading, at: at }; }, on: function (f) { listeners.push(f); },
    renderModels: renderModels, renderLocal: renderLocal, renderRuntimes: renderRuntimes, addDir: addDir, select: function (k) { selected = k; emit(); },
    rows: allRows, picon: picon,
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
