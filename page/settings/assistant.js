'use strict';

/**
 * THE ASSISTANT — schedules, reminders, watches and their activity, drawn from
 * Core's one task store (src/assistant/store.js via /api/assistant/state).
 *
 * ------------------------------------------------------------------------
 * ONE STORE, SEVERAL WINDOWS ONTO IT. CHAT › Schedules, BOT › Assistant and
 * Home search all draw the same state; a reminder made on Telegram shows here
 * as the same task, because there is only one. Nothing on this page keeps
 * schedule state of its own.
 *
 * THE CLOCK IS CORE'S. This page never decides when anything runs: it creates,
 * pauses, resumes, cancels or asks Core to run a task now, and redraws from
 * what Core answers.
 *
 * COST IS SHOWN BEFORE IT IS SPENT. A model-backed recurring task is refused
 * by Core until the policy has been shown and confirmed (409 needsConfirm);
 * this page shows the policy and the model it resolves to and asks.
 */

const CSS = `
.asst .seg{display:inline-flex;gap:2px;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:2px;margin:0 0 12px}
.asst .seg button{padding:4px 10px;border-radius:5px;font-size:12.5px;color:var(--text-secondary)}
.asst .seg button[aria-selected=true]{background:var(--selection);color:var(--text-primary)}
.asst .trow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;padding:10px 0;border-top:1px solid var(--separator)}
.asst .trow:first-child{border-top:0}
.asst .tt{font-size:13.5px;overflow-wrap:anywhere}
.asst .tm{color:var(--text-muted);font-size:11.5px;margin-top:2px;overflow-wrap:anywhere}
.asst .tb{display:flex;gap:4px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}
.asst .pill{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:9px;background:var(--surface-active);color:var(--text-secondary);margin-right:4px}
.asst .pill.ok{color:var(--positive)} .asst .pill.warn{color:var(--warning)} .asst .pill.bad{color:var(--danger)}
.asst .newbox{display:flex;gap:8px;margin:4px 0 6px;max-width:760px}
.asst .newbox input{flex:1;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:6px 9px;font-size:13px}
.asst .hint{color:var(--text-muted);font-size:11.5px;margin:0 0 14px;max-width:760px}
.asst .act{padding:7px 0;border-top:1px solid var(--separator);font-size:12.5px}
.asst .act:first-child{border-top:0}
.asst .act .when{color:var(--text-muted);font-size:11px}
.asst .act pre{white-space:pre-wrap;margin:4px 0 0;font:12px/1.45 var(--mono);color:var(--text-secondary);max-height:160px;overflow:auto}
.asst .form{display:grid;grid-template-columns:140px minmax(0,1fr);gap:8px 12px;align-items:center;max-width:760px;margin:6px 0 14px}
.asst .form input,.asst .form select,.asst .form textarea{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:5px 8px;font-size:12.5px;color:var(--text-primary)}
.asst .form textarea{min-height:54px;resize:vertical}
.asst .quiet{display:flex;gap:6px;align-items:center}
.asst .quiet input{width:70px;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--radius-xs);padding:4px 6px;font-size:12.5px}
.chat-sched{overflow-y:auto;padding:22px 30px 40px;min-height:0}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var data = null;
  var loading = false;
  var seg = 'upcoming';
  var showForm = false;
  var mounted = [];   // { pane, draw } — every place currently showing assistant content

  function redraw() { mounted = mounted.filter(function (m) { return m.pane.isConnected; }); mounted.forEach(function (m) { try { m.draw(); } catch (e) { if (window.console) console.error(e); } }); }
  async function load() {
    if (loading) return data;
    loading = true;
    try { var r = await L.api('/api/assistant/state', {}); if (r && r.ok) data = r; } catch (e) { /* the view says it could not read */ }
    loading = false;
    redraw();
    return data;
  }
  async function call(path, body) {
    var r = await L.api(path, body);
    if (r && r.ok) { data = Object.assign({}, data || {}, r); redraw(); }
    return r;
  }

  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var now = new Date();
    var same = d.toDateString() === now.toDateString();
    var tm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (same) return 'today ' + tm;
    var t = new Date(now.getTime() + 864e5);
    if (d.toDateString() === t.toDateString()) return 'tomorrow ' + tm;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + tm;
  }
  function pill(text, cls) { return el('span', 'pill' + (cls ? ' ' + cls : ''), text); }
  var POLICY = { NO_MODEL: 'no model', BOT_MODEL: 'BOT model', LOCAL_CHEAP: 'local model', RESEARCH: 'research model', CODING_AGENT: 'Coding Agent' };
  var RECEIPT = { DELIVERED: 'ok', PARTIAL: 'warn', FAILED: 'bad', PENDING: '' };

  function taskRow(t) {
    var row = el('div', 'trow');
    row.id = 'asst-' + t.id;
    var left = el('div', '');
    left.appendChild(el('div', 'tt', t.title));
    var meta = [t.describe];
    if (t.deferredUntil) meta.push('deferred (quiet hours) to ' + when(t.deferredUntil));
    else if (t.nextRun) meta.push('next ' + when(t.nextRun));
    if (t.lastRun) meta.push('last ' + when(t.lastRun));
    meta.push('→ ' + (t.delivery.targets || []).join(' + '));
    if (t.origin && t.origin !== 'desktop') meta.push('from ' + t.origin);
    left.appendChild(el('div', 'tm', meta.filter(Boolean).join(' · ')));
    var pills = el('div', 'tm');
    pills.appendChild(pill(POLICY[t.modelPolicy] || t.modelPolicy, t.modelPolicy === 'NO_MODEL' ? '' : 'warn'));
    if (t.state !== 'scheduled' && t.state !== 'watching') pills.appendChild(pill(t.state, t.state === 'failed' ? 'bad' : t.state === 'done' ? 'ok' : ''));
    if (t.deliveryState) pills.appendChild(pill('delivery ' + t.deliveryState.toLowerCase(), RECEIPT[t.deliveryState]));
    if (t.result && t.result.summary) pills.appendChild(el('span', '', ' ' + t.result.summary.split('\n')[0].slice(0, 140)));
    left.appendChild(pills);
    row.appendChild(left);
    var b = el('div', 'tb');
    var act = function (label, action, danger) {
      var x = el('button', 'btn small' + (danger ? ' danger' : ''), label);
      x.onclick = async function () {
        x.disabled = true;
        var r = await call('/api/assistant/task/act', { id: t.id, action: action });
        if (r && !r.ok) L.toast(r.why, true);
        else if (action === 'run' && r.ran) L.toast('Ran — delivery ' + String(r.ran.deliveryState).toLowerCase(), r.ran.deliveryState === 'FAILED');
        x.disabled = false;
      };
      b.appendChild(x);
    };
    var live = ['scheduled', 'watching', 'paused'].indexOf(t.state) >= 0;
    if (live && t.type !== 'watch') act('Run now', 'run');
    if (t.state === 'paused') act('Resume', 'resume');
    else if (live) act('Pause', 'pause');
    if (live) act('Cancel', 'cancel', true);
    else act('Remove', 'remove');
    row.appendChild(b);
    return row;
  }

  function newTask(pane) {
    var box = el('div', 'newbox');
    var inp = el('input', '');
    inp.placeholder = 'Remind me in 20 minutes to stretch · Every day at 8 show my model limits · Tell me when Claude resets';
    var go = el('button', 'btn small primary', 'Add');
    var submit = async function () {
      var text = inp.value.trim();
      if (!text) return;
      go.disabled = true;
      var r = await call('/api/assistant/interpret', { text: text });
      go.disabled = false;
      if (r && r.ok) { inp.value = ''; L.toast(r.text); } else L.toast((r && r.why) || 'not understood', true);
    };
    go.onclick = submit;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    box.appendChild(inp);
    box.appendChild(go);
    var more = el('button', 'btn small', showForm ? 'Hide form' : 'Model task…');
    more.onclick = function () { showForm = !showForm; redraw(); };
    box.appendChild(more);
    pane.appendChild(box);
    pane.appendChild(el('div', 'hint', 'Understood without a model: reminders, recurring summaries (limits, usage, runtimes), test runs and watches. A task that needs a model is made with the form, which shows what it will use before it is saved.'));
    if (showForm) pane.appendChild(modelForm());
  }

  function modelForm() {
    var f = el('div', 'form');
    var field = function (label, node) { f.appendChild(el('label', '', label)); f.appendChild(node); return node; };
    var title = field('Title', el('input', ''));
    var instr = field('Instruction', el('textarea', ''));
    instr.placeholder = 'Summarise which project used the most tokens today and anything unusual.';
    var cad = field('Repeats', el('select', ''));
    [['day', 'Every day'], ['weekday', 'Weekdays'], ['week', 'Every week'], ['once', 'Once (tomorrow)']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; cad.appendChild(x); });
    var at = field('At', el('input', ''));
    at.value = '08:00';
    var pol = field('Model policy', el('select', ''));
    ['BOT_MODEL', 'LOCAL_CHEAP', 'RESEARCH'].forEach(function (p) { var x = el('option', '', POLICY[p]); x.value = p; pol.appendChild(x); });
    var inc = field('Include data', el('select', ''));
    [['', 'nothing'], ['limits', 'model limits'], ['usage', 'today’s usage'], ['limits,usage', 'limits and usage']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; inc.appendChild(x); });
    var tg = field('Deliver to', el('select', ''));
    [['desktop', 'Desktop'], ['desktop,telegram', 'Desktop + Telegram'], ['telegram', 'Telegram'], ['chat', 'Noema Chat only']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; tg.appendChild(x); });
    var save = el('button', 'btn small primary', 'Save');
    f.appendChild(el('span', ''));
    f.appendChild(save);
    save.onclick = async function () {
      if (!instr.value.trim()) return L.toast('Write the instruction', true);
      var once = cad.value === 'once';
      var sched = once ? { at: (function () { var d = new Date(); d.setDate(d.getDate() + 1); var p = at.value.split(':'); d.setHours(Number(p[0]) || 8, Number(p[1]) || 0, 0, 0); return d.getTime(); })() } : { every: cad.value, at: at.value, weekday: 1 };
      var task = { type: once ? 'scheduled' : 'recurring', title: title.value.trim() || instr.value.trim().slice(0, 60), instruction: instr.value.trim(), action: { kind: 'bot_prompt', args: { include: inc.value ? inc.value.split(',') : [] } }, modelPolicy: pol.value, schedule: sched, delivery: { targets: tg.value.split(',') } };
      var r = await L.api('/api/assistant/task', { task: task });
      if (r && r.needsConfirm) {
        var ok = await L.confirm('This task runs ' + (POLICY[r.modelPolicy] || r.modelPolicy) + (r.model ? ' (' + r.model + ')' : ' — no model is available for this policy right now') + ' every time it fires. Its cost is whatever that model’s usage is; Noema records it under USAGE › Origin. Save it?', { ok: 'Save' });
        if (!ok) return;
        r = await L.api('/api/assistant/task', { task: task, confirmPolicy: r.modelPolicy });
      }
      if (r && r.ok) { data = Object.assign({}, data || {}, r); showForm = false; redraw(); L.toast('Saved: ' + r.task.title); } else L.toast((r && r.why) || 'could not save', true);
    };
    return f;
  }

  function activity(pane, limit) {
    var rows = (data && data.activity) || [];
    var box = el('div', 'botcard');
    if (!rows.length) box.appendChild(el('div', 'summary', 'Nothing has run yet.'));
    rows.slice(0, limit || 30).forEach(function (a) {
      var r = el('div', 'act');
      var head = el('div', '');
      head.appendChild(el('span', 'when', when(a.at) + '  '));
      head.appendChild(el('span', '', a.title + ' '));
      head.appendChild(pill(a.outcome, a.outcome === 'ok' ? 'ok' : a.outcome === 'failed' ? 'bad' : 'warn'));
      if (a.deliveryState && a.outcome !== 'deferred' && a.outcome !== 'missed') head.appendChild(pill(a.deliveryState.toLowerCase(), RECEIPT[a.deliveryState]));
      if (a.model) head.appendChild(pill(a.model, 'warn'));
      r.appendChild(head);
      var miss = (a.deliveries || []).filter(function (d) { return d.state !== 'DELIVERED'; });
      if (miss.length) r.appendChild(el('div', 'tm', miss.map(function (d) { return d.target + ': ' + (d.why || d.state); }).join(' · ')));
      if (a.summary) r.appendChild(el('pre', '', a.summary));
      box.appendChild(r);
    });
    pane.appendChild(box);
  }

  /** CHAT › Schedules and BOT › Assistant › Schedules: Upcoming / Recurring / Watches / Completed. */
  function schedules(pane, opts) {
    opts = opts || {};
    var wrap = el('div', 'asst');
    pane.appendChild(wrap);
    var draw = function () {
      wrap.textContent = '';
      if (opts.title !== false) {
        wrap.appendChild(el('h2', '', 'Schedules'));
        wrap.appendChild(el('div', 'sub', 'Reminders, scheduled and recurring tasks, and watches — kept by Core, delivered by Core. The same list from the desktop, CHAT and Telegram.'));
      }
      if (!data) { wrap.appendChild(el('div', 'missing', loading ? 'Reading…' : 'Not read yet.')); return; }
      newTask(wrap);
      var s = el('div', 'seg');
      [['upcoming', 'Upcoming'], ['recurring', 'Recurring'], ['watches', 'Watches'], ['completed', 'Completed']].forEach(function (x) {
        var b = el('button', '', x[1] + ' ' + ((data[x[0]] || []).length || ''));
        b.setAttribute('aria-selected', String(seg === x[0]));
        b.onclick = function () { seg = x[0]; redraw(); };
        s.appendChild(b);
      });
      wrap.appendChild(s);
      var list = el('div', 'botcard');
      var rows = data[seg] || [];
      if (!rows.length) list.appendChild(el('div', 'summary', seg === 'watches' ? 'No watches. Try “Tell me when Claude resets”.' : seg === 'completed' ? 'Nothing finished yet.' : 'Nothing scheduled.'));
      rows.forEach(function (t) { list.appendChild(taskRow(t)); });
      wrap.appendChild(list);
      wrap.appendChild(el('h3', '', 'Activity'));
      activity(wrap, 30);
      if (opts.task) { var hit = document.getElementById('asst-' + opts.task); if (hit) hit.scrollIntoView({ block: 'center' }); }
    };
    mounted.push({ pane: wrap, draw: draw });
    draw();
    if (!data && !loading) load();
  }

  function toggle(on, fn) {
    var t = el('button', 'toggle');
    t.setAttribute('aria-checked', String(Boolean(on)));
    t.onclick = function () { fn(!on); };
    return t;
  }
  function fieldRow(box, label, desc, node) {
    var f = el('div', 'field');
    var l = el('div', '');
    l.appendChild(el('div', 'lbl', label));
    if (desc) l.appendChild(el('div', 'desc', desc));
    f.appendChild(l);
    f.appendChild(node);
    box.appendChild(f);
  }
  async function setSettings(s) { var r = await call('/api/assistant/settings', { settings: s }); if (r && !r.ok) L.toast(r.why, true); }
  async function setScopes(s) { var r = await call('/api/assistant/scopes', { scopes: s }); if (r && !r.ok) L.toast(r.why, true); }

  /** BOT › Assistant: settings, Telegram permissions, schedules, activity. */
  function botPane(pane, opts) {
    var wrap = el('div', 'asst');
    pane.appendChild(wrap);
    var draw = function () {
      wrap.textContent = '';
      wrap.appendChild(el('h2', '', 'Assistant'));
      wrap.appendChild(el('div', 'sub', 'Reminders, schedules and watches run in Noema’s Core on a timer — no model stays loaded for them. A task uses a model only when its policy says so.'));
      if (!data) { wrap.appendChild(el('div', 'missing', loading ? 'Reading…' : 'Not read yet.')); return; }
      var st = data.settings;
      var sc = data.scheduler || {};
      wrap.appendChild(el('div', 'hint', sc.running ? 'Scheduler running in this Noema (pid ' + sc.pid + ')' + (sc.lastTick ? ' · last check ' + when(sc.lastTick) : '') + (sc.lastError ? ' · last error: ' + sc.lastError : '') : 'Scheduler not running here: ' + (sc.why || 'unknown')));
      wrap.appendChild(el('h3', '', 'Notifications'));
      var f1 = el('div', 'fields');
      fieldRow(f1, 'Desktop notifications', 'A Windows notification; clicking it opens the task here.', toggle(st.notifications, function (v) { setSettings({ notifications: v }); }));
      var dt = el('select', '');
      [['desktop', 'Desktop'], ['desktop,telegram', 'Desktop + Telegram'], ['telegram', 'Telegram'], ['chat', 'Noema Chat only']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; if (o[0] === st.defaultTargets.join(',')) x.selected = true; dt.appendChild(x); });
      dt.onchange = function () { setSettings({ defaultTargets: dt.value.split(',') }); };
      fieldRow(f1, 'Default delivery', 'Where a task delivers when it does not say.', dt);
      var q = el('div', 'quiet');
      var qa = el('input', ''); qa.value = st.quietHours.start;
      var qb = el('input', ''); qb.value = st.quietHours.end;
      var qsave = function () { setSettings({ quietHours: { enabled: st.quietHours.enabled, start: qa.value.trim(), end: qb.value.trim() } }); };
      qa.onchange = qsave; qb.onchange = qsave;
      q.appendChild(toggle(st.quietHours.enabled, function (v) { setSettings({ quietHours: { enabled: v, start: qa.value.trim(), end: qb.value.trim() } }); }));
      q.appendChild(qa); q.appendChild(el('span', '', '–')); q.appendChild(qb);
      fieldRow(f1, 'Quiet hours', 'Deliveries inside them wait until they end — never dropped.', q);
      var qe = el('select', '');
      [['deliver', 'Deliver on time'], ['defer', 'Wait until quiet hours end']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; if (o[0] === st.quietExactReminders) x.selected = true; qe.appendChild(x); });
      qe.onchange = function () { setSettings({ quietExactReminders: qe.value }); };
      fieldRow(f1, 'Exact reminders in quiet hours', '“Remind me at 23:30” is something you asked for at that time.', qe);
      wrap.appendChild(f1);
      wrap.appendChild(el('h3', '', 'Schedules'));
      var f2 = el('div', 'fields');
      fieldRow(f2, 'Background execution', 'Run tests and model tasks unattended. Off: they report that they were due instead.', toggle(st.background, function (v) { setSettings({ background: v }); }));
      fieldRow(f2, 'Condition checks', 'Evaluate watches (resets, channel and runtime state) from Noema’s own state.', toggle(st.conditionChecks, function (v) { setSettings({ conditionChecks: v }); }));
      var mp = el('select', '');
      [['deliver_late', 'Deliver late, saying it was missed'], ['run_once', 'Run once now'], ['skip', 'Skip to the next time']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; if (o[0] === st.missedPolicy) x.selected = true; mp.appendChild(x); });
      mp.onchange = function () { setSettings({ missedPolicy: mp.value }); };
      fieldRow(f2, 'Missed runs', 'When Noema was not running at the time. Applies to new tasks.', mp);
      wrap.appendChild(f2);
      wrap.appendChild(el('h3', '', 'What Telegram may do'));
      var f3 = el('div', 'fields');
      var S = data.scopes || {};
      [['reminders', 'Reminders and schedules', 'Create, list and cancel reminders, schedules and watches.'], ['readUsage', 'Read usage and limits', 'Quota, runtimes, local model, token usage.'], ['readProject', 'Read project', 'Project facts the BOT already answers from.'], ['runTests', 'Run tests', 'Schedule this project’s test command.'], ['editCode', 'Edit code', 'Not available from a channel.'], ['computer', 'Computer control', 'Not available from a channel.']].forEach(function (x) {
        var locked = x[0] === 'editCode' || x[0] === 'computer';
        var t = toggle(S[x[0]] && !locked, function (v) { var o = {}; o[x[0]] = v; setScopes(o); });
        if (locked) t.disabled = true;
        fieldRow(f3, x[1], x[2], t);
      });
      wrap.appendChild(f3);
    };
    mounted.push({ pane: wrap, draw: draw });
    draw();
    schedules(pane, { task: opts && opts.task });
    if (!data && !loading) load();
  }

  /** Home search rows: every task, plus the settings pages. */
  function searchEntries() {
    if (!data && !loading) load();
    var out = [];
    var open = function (t) { return function () { L.nav.go('bot', { section: 'assistant', task: t && t.id }); }; };
    ['upcoming', 'recurring', 'watches', 'completed'].forEach(function (k) {
      ((data && data[k]) || []).slice(0, k === 'completed' ? 20 : 200).forEach(function (t) {
        var kind = k === 'watches' ? 'Watch' : k === 'recurring' ? 'Recurring' : t.type === 'reminder' ? 'Reminder' : 'Scheduled';
        var tail = k === 'completed' ? ' · ' + t.state + (t.lastRun ? ' ' + when(t.lastRun) : '') : (t.nextRun && k !== 'watches' ? ' · next ' + when(t.nextRun) : '');
        out.push({ group: 'Assistant', title: t.title, sub: kind + ' · ' + t.describe + tail, icon: 'session', kw: 'reminder schedule watch assistant ' + t.type + ' ' + (k === 'completed' ? 'completed history ' : '') + (t.instruction || ''), run: open(t) });
      });
    });
    out.push({ group: 'Assistant', title: 'Schedules', sub: 'Chat › Schedules · Upcoming, Recurring, Watches, Completed', icon: 'session', kw: 'reminders schedules watches recurring upcoming completed', run: function () { L.nav.go('chat', { section: 'schedules' }); } });
    out.push({ group: 'Assistant', title: 'Assistant settings', sub: 'Bot › Assistant · notifications, quiet hours, delivery, missed runs', icon: 'bot', kw: 'assistant notifications quiet hours delivery background condition checks missed telegram permissions', run: function () { L.nav.go('bot', { section: 'assistant' }); } });
    out.push({ group: 'Assistant', title: 'Assistant activity', sub: 'Bot › Assistant · what ran and where it was delivered', icon: 'session', kw: 'activity history delivered failed receipts', run: function () { L.nav.go('bot', { section: 'assistant' }); } });
    return out;
  }

  L.assistant = { load: load, get: function () { return data; }, schedules: schedules, botPane: botPane, searchEntries: searchEntries };
  L.onBoot(function () { setTimeout(load, 1500); setInterval(function () { if (mounted.some(function (m) { return m.pane.isConnected; })) load(); }, 20000); });
}

function js() {
  return `(${client.toString()})();`;
}

module.exports = { CSS, js, client };
