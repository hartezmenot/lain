'use strict';

/**
 * MODEL › Local — models that run on this PC (Ollama, llama.cpp, model directories), and the runtimes LAIN
 * can drive. Each local model is a row: what it is, what it costs to run, whether it is ready; its technical
 * detail opens in a side sheet. EVERYTHING IS POST /api/fabric (src/harnessapp/fabricroutes.js); nothing here
 * polls — Refresh is a click. A local model has no provider quota and says so.
 */

const CSS = `
.chatonly{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.06em;padding:1px 6px;border-radius:3px;background:rgba(245,166,35,.12);color:var(--warning);border:1px solid var(--warning)}
.cap{display:inline-block;font-size:9.5px;font-weight:600;letter-spacing:.04em;padding:1px 5px;border-radius:3px;border:1px solid var(--border-subtle);color:var(--text-secondary);margin:0 3px 2px 0}
.cap.agent{border-color:var(--positive);color:var(--positive)}
.cap.no{border-style:dashed;color:var(--text-muted)}
.fst{display:inline-flex;align-items:center;gap:5px;font-size:12px}
.fst.ok{color:var(--positive)} .fst.warn{color:var(--warning)} .fst.bad{color:var(--danger)} .fst.busy{color:var(--text-muted)}
.fuse{font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;min-width:0}
.fuse .q-bar{width:60px;flex:none}
.fdet{background:var(--surface-base);border:1px solid var(--separator);border-radius:8px;padding:14px 16px;position:sticky;top:0;min-width:0}
.fdet h3{margin:0 0 2px;font-size:15px;display:flex;align-items:center;gap:8px}
.fdet .sub{font-size:12px;color:var(--text-muted);margin-bottom:10px}
.fdet dl{display:grid;grid-template-columns:118px minmax(0,1fr);gap:4px 10px;font-size:12px;margin:0 0 8px}
.fdet dt{color:var(--text-muted)} .fdet dd{margin:0;overflow-wrap:anywhere}
.fdet h5{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin:14px 0 6px;font-weight:600}
.fdet .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.fdet .note{font-size:12px;color:var(--text-muted);margin:6px 0}
.fdet .warnline{font-size:12px;color:var(--warning);margin:6px 0}
.fdet .probe{display:grid;grid-template-columns:18px 110px minmax(0,1fr);gap:6px;font-size:12px;padding:2px 0}
.fdet .probe .p{color:var(--positive)} .fdet .probe .f{color:var(--danger)}
.fdet .advgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.fdet .advgrid label{font-size:11px;color:var(--text-muted)}
.fdet .advgrid input{width:100%}
.plan{border:1px solid var(--separator);border-radius:8px;padding:12px;margin:8px 0;background:var(--surface-raised)}
.plan .pk{font-size:10px;letter-spacing:.12em;color:var(--text-muted);font-weight:700}
.plan .pn{font-size:16px;font-weight:600;margin:4px 0}
.plan .bal{font-size:12px;color:var(--text-secondary)}
.rtcard{background:var(--surface-base);border:1px solid var(--separator);border-radius:8px;padding:12px 14px;margin-bottom:10px;max-width:1100px}
.rtcard .rh{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rtcard .rh b{font-size:14px}
.rtcard .rh .spacer{flex:1}
.rtcard .rh small{color:var(--text-muted)}
.rtstate{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;border:1px solid var(--border-subtle);color:var(--text-secondary)}
.rtstate.ok{border-color:var(--positive);color:var(--positive)} .rtstate.warn{border-color:var(--warning);color:var(--warning)} .rtstate.bad{border-color:var(--danger);color:var(--danger)}
.rt3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
@media (max-width:900px){.rt3{grid-template-columns:minmax(0,1fr)}}
.rtcaps{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.rtcaps .cap{display:inline-flex;gap:5px;align-items:baseline;border:1px solid var(--separator);border-radius:5px;padding:2px 7px;font-size:10.5px;cursor:default}
.rtcaps .ck{color:var(--text-muted);letter-spacing:.06em}
.rtcaps .ok .cl,.rtcaps .cap.ok .cl{color:var(--positive)} .rtcaps .cap.mid .cl{color:var(--warning)} .rtcaps .cap.nr .cl{color:var(--text-secondary)} .rtcaps .cap.no .cl{color:var(--danger)}
.vsel{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:3px 6px;font-size:12px;max-width:260px}
.rt3 .c{border:1px solid var(--separator);border-radius:6px;padding:8px 10px;font-size:12px;min-width:0}
.rt3 .c .k{font-size:10px;letter-spacing:.1em;color:var(--text-muted);font-weight:700;display:flex;gap:6px;align-items:center}
.rt3 .c .k .y{color:var(--positive)} .rt3 .c .k .n{color:var(--danger)}
.rt3 .c .v{margin-top:4px;color:var(--text-secondary);overflow-wrap:anywhere}
.rtcard .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var data = null, loading = false, at = 0, listeners = [];
  var selected = null, filterText = '', roleFilter = 'all';
  var ticker = null;


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
  /** The bar is what REMAINS. `pct` is what the provider reported USED (every source does); 100% remaining is never red. */
  function qbar(pct) {
    var wrap = el('span', 'q-bar'); var fill = el('span', 'q-fill'); wrap.appendChild(fill);
    var rem = pct == null ? null : Math.max(0, Math.min(100, 100 - pct));
    fill.style.width = (rem == null ? 0 : rem) + '%';
    var tone = rem == null ? '' : (L.kit ? L.kit.quotaTone(rem) : (rem <= 5 ? 'bad' : rem <= 20 ? 'warn' : ''));
    fill.className = 'q-fill' + (tone ? ' ' + tone : '');
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



  // ---- MODELS, AS A PERSON READS THEM (Phase 8) -------------------------------------------------
  // One row per model: what it is, where it runs and as whom, what it may do, how much of its
  // provider allowance is left, and whether it is ready. Choosing a row only SHOWS it —
  // selection is state, never a request (the "Use for…" buttons set roles; they send nothing).
  function capWords(r) {
    var map = { CHAT: 'Chat', BOT: 'Bot', AGENT: 'Agent' };
    var words = (r.roles || []).map(function (x) { return map[x] || x; });
    if (r.kind === 'local') { if ((r.roles || []).indexOf('AGENT') >= 0) words = words.filter(function (w) { return w !== 'Agent'; }).concat(['Agent verified']); if (r.detail && r.detail.vision) words.push('Vision'); words.unshift('Local'); }
    if (r.capabilityLabel) words.push(r.capabilityLabel);
    return words.join(' \u00b7 ') || (r.kind === 'plan' ? 'No execution' : '\u2014');
  }

  // THE SIDE SHEET — the model's full detail, wide enough to read.



  // ---- details, per kind of source ------------------------------------------
  function kv(dl, k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(v))); }
  function detail(host, r) {
    var d = el('aside', 'fdet');
    d.setAttribute('data-fdetail', r.key);
    var h = el('h3', ''); h.appendChild(L.kit.mark(r.kind === 'local' ? 'local' : (r.icon || r.provider), 20)); h.appendChild(document.createTextNode(r.label)); if (r.capabilityLabel) h.appendChild(el('span', 'chatonly', r.capabilityLabel)); d.appendChild(h);
    d.appendChild(el('div', 'sub', r.via + (r.account ? ' · ' + r.account : '')));
    if (r.kind === 'local') detailLocal(d, r);
    else if (r.kind === 'runtime' || r.kind === 'runtime-summary') detailRuntime(d, r);
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
      else { kv(dl2, 'State', 'not running — Noema starts it on first use'); kv(dl2, 'Needs about', x.estimate ? gb(x.estimate.total) + ' (weights ' + gb(x.estimate.weights) + (x.estimate.projector ? ', projector ' + gb(x.estimate.projector) : '') + ', context)' : null); }
      d.appendChild(dl2);
      var sp = x.speed || {};
      if (sp.requests) {
        d.appendChild(el('h5', '', 'Measured on this machine'));
        var dl3 = el('dl', ''); kv(dl3, 'Prompt', sp.promptTokPerSec == null ? '—' : sp.promptTokPerSec + ' tok/s'); kv(dl3, 'Generation', sp.tokPerSec == null ? '—' : sp.tokPerSec + ' tok/s'); kv(dl3, 'Requests', sp.requests); d.appendChild(dl3);
        if (sp.firstReplySecs && sp.firstReplySecs > 60) d.appendChild(el('div', 'warnline', 'Noema’s BOT request is about ' + sp.botRequestTokens.toLocaleString() + ' tokens (instructions and tool schemas). At ' + sp.promptTokPerSec + ' tok/s the first reply takes about ' + Math.round(sp.firstReplySecs / 60) + ' min here; later turns reuse that prefix and only process what is new.'));
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
      row.appendChild(el('span', '', w.label)); row.appendChild(el('span', '', w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent) + '% remaining'));
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
    if (r.kind === 'runtime' && (r.roles || []).indexOf('BOT') >= 0) d.appendChild(el('div', 'note', 'As the BOT, a runtime model answers in text; Noema\u2019s own tools are not handed to another program. As the Agent, it works in the project with its own tools.'));
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
    if (rt && rt.id === 'claude-code') d.appendChild(el('div', 'note', 'Choosing another model disconnects nothing: Claude Code keeps its own sign-in. Signing out of Claude is done in Claude Code (claude auth logout), never by Noema.'));
  }
  function disconnectBtn(rt) {
    return act(rt.disconnected ? 'Reconnect to Noema' : 'Disconnect from Noema', async function () {
      if (!rt.disconnected) { var ok = await L.confirm('Stop offering ' + rt.label + '’s models in Noema? This does not sign you out of ' + rt.label + ' — its own sign-in stays where it is.', { ok: 'Disconnect from Noema' }); if (!ok) return; }
      var r = await L.api('/api/runtimes/disconnect', { id: rt.id, reconnect: Boolean(rt.disconnected) });
      L.toast(r.ok ? (rt.disconnected ? rt.label + ' is offered again.' : r.note) : r.why, !r.ok); await load();
    }, rt.disconnected ? '' : 'danger');
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
    var U = L.kit;
    if (!data) { pane.appendChild(el('div', 'u-empty', loading ? 'Reading local models…' : 'Not read yet.')); if (!loading) load(); return; }
    var rts = data.runtimes || [];
    var llama = rts.filter(function (x) { return x.id === 'llamacpp'; })[0];
    var oll = rts.filter(function (x) { return x.id === 'ollama'; })[0];
    var dirs = (data.local && data.local.dirs) || [];
    var od = oll ? oll.discovery : {};

    // A LOCAL MODEL, as a row: what it is, what it costs to run, whether it is ready. Click for the technical detail.
    function modelRows(rows, sec) {
      var list = el('div', 'u-rows');
      rows.forEach(function (r) {
        var row = el('div', 'u-row click'); row.setAttribute('data-key', r.key); row.setAttribute('role', 'button'); row.tabIndex = 0;
        var idc = el('div', 'u-id'); var nm = el('div', 'u-nm'); nm.appendChild(el('span', '', r.label));
        var st = el('span', 'u-st'); st.appendChild(U.dot(r.status && r.status.cls === 'ok' ? 'ok' : r.status && r.status.cls === 'bad' ? 'bad' : 'warn')); st.appendChild(document.createTextNode((r.status && r.status.word) || '')); nm.appendChild(st);
        idc.appendChild(nm);
        if (r.current && (r.current.bot || r.current.coding || r.current.chat)) idc.appendChild(el('div', 'u-who', 'In use · ' + [r.current.chat ? 'Chat' : null, r.current.bot ? 'Bot' : null, r.current.coding ? 'Agent' : null].filter(Boolean).join(' · ')));
        row.appendChild(idc);
        var facts = r.detail ? [r.detail.quantization, r.detail.size, r.detail.contextLength ? 'ctx ' + r.detail.contextLength.toLocaleString() : null].filter(Boolean).join(' · ') : '';
        row.appendChild(el('div', 'u-note', facts || capWords(r)));
        row.appendChild(U.overflow([{ label: 'Details', run: function () { open(r); } }], 'More about ' + r.label));
        row.onclick = function () { open(r); };
        row.onkeydown = function (e) { if (e.key === 'Enter') open(r); };
        list.appendChild(row);
      });
      sec.appendChild(list);
    }
    function open(r) { var sh = U.sheet({ title: r.label, meta: r.via + (r.account ? ' · ' + r.account : ''), mark: 'local', id: 'local-' + r.key }); detail(sh.body, r); }
    var sec;

    // OLLAMA
    var oState = od.running ? 'Running' + (od.version ? ' · ' + od.version : '') : od.installed ? 'Installed · not running' : 'Not installed';
    var oActs = [U.button('Refresh', 'ghost sm', async function () { await L.api('/api/local/ollama/refresh', {}); await L.api('/api/runtimes', { id: 'ollama', refresh: true }); await load(); }, 'refresh')];
    if (!od.installed && oll && oll.install) oActs.push(U.button('Install help', 'line sm', function () { return L.openExternal(oll.install.docs); }));
    sec = U.section({ id: 'ollama', title: 'Ollama', mark: 'local', meta: oState + ' · ' + (od.endpoint || 'http://127.0.0.1:11434'), actions: oActs });
    sec.classList.add('first'); sec.setAttribute('data-local', 'ollama');
    var olRows = allRows().filter(function (r) { return r.kind === 'local' && r.provider === 'ollama'; });
    if (olRows.length) modelRows(olRows, sec);
    else sec.appendChild(el('div', 'u-note', od.running ? 'Ollama lists no models. Pull one with Ollama, then Refresh.' : 'Noema does not start or install Ollama. When it runs at this address, its models appear here.'));
    pane.appendChild(sec);

    // LLAMA.CPP
    var lState = llama && llama.discovery.ok ? 'Installed' + (llama.discovery.version ? ' · ' + llama.discovery.version : '') : 'Not installed';
    sec = U.section({ id: 'llamacpp', title: 'llama.cpp', mark: 'local', meta: lState + (llama && llama.discovery.ok ? ' · ' + llama.discovery.binary : '') });
    sec.setAttribute('data-local', 'llamacpp');
    var llamaRows = allRows().filter(function (r) { return r.kind === 'local' && r.provider === 'llama.cpp'; });
    if (llamaRows.length) modelRows(llamaRows, sec);
    else sec.appendChild(el('div', 'u-note', dirs.length ? 'No text models in your directories.' : 'Add a model directory to see models here.'));
    var other = (data.local && data.local.other) || [];
    if (other.length) { var det = el('details', 'u-note'); det.appendChild(el('summary', '', other.length + ' other GGUF file(s) — not text models llama-server can serve')); other.forEach(function (o) { det.appendChild(el('div', '', o.name + (o.quantization ? ' · ' + o.quantization : '') + (o.sizeBytes ? ' · ' + gb(o.sizeBytes) : ''))); }); sec.appendChild(det); }
    pane.appendChild(sec);

    // MODEL DIRECTORIES
    var dActs = [U.button('Add directory', 'line sm', addDir, 'plus')];
    if (dirs.length) dActs.unshift(U.button('Rescan all', 'ghost sm', async function () { await L.api('/api/local/dirs/rescan', {}); await load(); }));
    sec = U.section({ id: 'dirs', title: 'Model directories', meta: 'Folders with .gguf files. Noema keeps only the path, reads each file’s header, and never copies, moves or deletes a model.', actions: dActs });
    var dl = el('div', 'u-rows');
    dirs.forEach(function (dd) {
      var row = el('div', 'u-row plain'); row.setAttribute('data-dir', dd.id);
      var idc = el('div', 'u-id'); idc.appendChild(el('div', 'u-nm', dd.path));
      idc.appendChild(el('div', 'u-who', dd.exists ? (dd.counts.gguf + ' GGUF · ' + dd.counts.text + ' text model(s) · ' + dd.counts.projector + ' projector(s)' + (dd.counts.other ? ' · ' + dd.counts.other + ' other' : '') + (dd.scannedAt ? ' · scanned ' + L.fmt.time(dd.scannedAt) : '')) : 'folder not found'));
      row.appendChild(idc);
      row.appendChild(U.overflow([
        { label: 'Rescan', run: async function () { await L.api('/api/local/dirs/rescan', { id: dd.id }); await load(); } },
        { label: 'Remove reference', danger: true, run: async function () {
          var ok = await L.confirm('Forget ' + dd.path + '? Only Noema’s reference is removed — the folder and every model in it stay exactly where they are.', { ok: 'Remove reference' });
          if (!ok) return; var r = await L.api('/api/local/dirs/remove', { id: dd.id }); L.toast(r.ok ? r.note : r.why, !r.ok); await load();
        } },
      ], 'More about ' + dd.path));
      dl.appendChild(row);
    });
    if (dirs.length) sec.appendChild(dl); else sec.appendChild(el('div', 'u-note', 'No model directory yet.'));
    pane.appendChild(sec);
    ensureTicker();
  }
  async function addDir() {
    var p = null;
    try { var r = await L.hostCall('pickFolder', { title: 'Model directory (folders with .gguf files)' }); p = r && (r.path || r.value || (typeof r === 'string' ? r : null)); } catch (e) { p = null; }
    if (!p) {
      var v = await L.dialog({ title: 'Add Model Directory', text: 'The folder that holds your .gguf models. Noema keeps only this path.', fields: [{ key: 'path', label: 'Folder', placeholder: 'E:\\AI\\models' }], ok: 'Add' });
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
      var h = el('div', 'rh'); h.appendChild(L.kit.mark(rt.id === 'llamacpp' || rt.id === 'ollama' ? 'local' : (rt.icon || rt.id), 20)); h.appendChild(el('b', '', rt.label));
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
      if (rt.id === 'opencode' && rt.discovery.ok && rt.detail && (rt.detail.models || []).length) a.appendChild(verifyPicker(rt));
      if (rt.id === 'zcode' && rt.discovery.ok) a.appendChild(act('Open ZCode', function () { return L.api('/api/runtimes/open', { id: 'zcode' }).then(function (o) { if (!o.ok) L.toast(o.why, true); }); }));
      if (rt.kind === 'runtime' && rt.discovery.ok) a.appendChild(disconnectBtn(rt));
      if (!rt.discovery.ok && rt.install && rt.install.docs) a.appendChild(act('Install help ↗', function () { return L.openExternal(rt.install.docs); }));
      else if (rt.install && rt.install.docs) a.appendChild(act('Docs ↗', function () { return L.openExternal(rt.install.docs); }));
      c.appendChild(a);
      pane.appendChild(c);
    });
    pane.appendChild(el('div', 'missing', 'Every runtime runs as its own program with its own sign-in. Noema never copies a runtime\u2019s credentials, never calls the service behind it, and never downloads a runtime by itself. Processes Noema starts are registered and stopped by Noema; nothing is stopped by name.'));
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
    if (rt.id === 'claude-code') return (t.identity ? (t.identity.signedIn ? 'signed in' : 'not signed in') + (t.identity.plan ? ' · ' + t.identity.plan : '') + (t.identity.email ? ' · ' + t.identity.email : '') : '') + (t.limits ? ' · windows: ' + t.limits.windows.map(function (w) { return w.label + ' ' + Math.round(100 - w.usedPercent) + '% remaining'; }).join(', ') : ' · windows after the first run');
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

  L.local = {
    load: load, get: function () { return { data: data, loading: loading, at: at }; }, on: function (f) { listeners.push(f); },
    renderLocal: renderLocal, renderRuntimes: renderRuntimes, addDir: addDir, rows: allRows,
  };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
