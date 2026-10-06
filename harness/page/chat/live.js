'use strict';

/**
 * THE CONVERSATION, ALIVE (2026-10-02) — what a turn is doing while it does it, and what a person can do with what
 * it said.
 *
 *   LIVE TURN    Core pushes every turn event (sessionjournal.js → ipc `turn.event`): begin, tool start/end, visible
 *                text, end. One evolving work area — "Thinking" only while nothing more specific is known, then the
 *                factual state ("Searching the web…", "Reading project…", "Running check…"); a compact timeline when
 *                more than one kind of work happened; it collapses to "▸ N activities" once the answer streams.
 *                Streaming text is appended to ONE node — the conversation is never rebuilt per token.
 *   MESSAGES     prose and code blocks (language, Copy code, Wrap); Copy on every message; Edit on the latest user
 *                message (a new branch — Core's turnedit.js); Retry and Continue on the latest answer. Actions stay
 *                hidden until hover or focus.
 *   NEVER        reasoning content, a raw tool call, or a sentence LAIN made up about what it might be doing.
 */

const CSS = `
/* ---- FULL CHAT: a document, not a messenger ---------------------------------------------------------------- */
.chat-main,.coding-center{--chat-col:840px}
.chat-main .msg .who,.coding-center .msg .who{display:none}
.chat-main .msg,.coding-center .msg{margin:0 0 26px;position:relative}
.chat-main .msg .body,.coding-center .msg .body{margin-left:0;padding:0;background:none;box-shadow:none;border-radius:0;font-size:var(--fs-chat);line-height:1.7}
.chat-main .msg.user,.coding-center .msg.user{display:flex;flex-direction:column;align-items:flex-end}
.chat-main .msg.user .body,.coding-center .msg.user .body{max-width:min(78%,640px);padding:10px 16px;border-radius:18px;background:var(--surface-raised);box-shadow:none;line-height:1.55}
.chat-main .msg.user.handoff .body,.coding-center .msg.user.handoff .body{max-width:100%;border-radius:var(--radius-lg);background:var(--plane-violet)}
.msg .body p{margin:0 0 .75em}
.msg .body p:last-child{margin-bottom:0}
.msg .body h1,.msg .body h2,.msg .body h3,.msg .body h4{font:600 1.05em/1.35 var(--sans);margin:1.1em 0 .45em;color:var(--text-primary)}
.msg .body h1{font-size:1.25em} .msg .body h2{font-size:1.15em}
.msg .body ul,.msg .body ol{margin:.2em 0 .8em;padding-left:1.4em}
.msg .body li{margin:.18em 0}
.msg .body blockquote{margin:.4em 0 .8em;padding:2px 0 2px 12px;border-left:3px solid var(--separator);color:var(--text-secondary)}
.msg .body code.ic{font:.88em/1 var(--mono);padding:1px 5px;border-radius:5px;background:var(--surface-raised);color:var(--text-primary)}
.msg .body a.lnk{color:var(--accent-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.msg .body hr{border:0;border-top:1px solid var(--separator);margin:1em 0}
/* code blocks: language · Wrap · Copy code */
.cb{margin:.5em 0 1em;border-radius:var(--radius-md);background:var(--canvas);box-shadow:inset 0 0 0 1px var(--separator);overflow:hidden}
.cb-h{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 12px;font:11.5px/1 var(--mono);color:var(--text-muted);border-bottom:1px solid var(--separator)}
.cb-h .lang{margin-right:auto;text-transform:lowercase}
.cb-b{margin:0;padding:10px 12px;overflow-x:auto;font:12.5px/1.55 var(--mono);color:var(--text-primary);white-space:pre}
.cb[data-wrap=true] .cb-b{white-space:pre-wrap;overflow-wrap:anywhere}
.mbtn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:var(--radius-sm);background:none;border:0;font:500 12px/1 var(--sans);color:var(--text-muted);cursor:pointer;transition:background var(--t-hover) var(--ease),color var(--t-hover) var(--ease)}
.mbtn:hover,.mbtn:focus-visible{background:var(--surface-active);color:var(--text-primary)}
.mbtn svg{width:14px;height:14px}
.mbtn.done{color:var(--positive)}
/* message actions: hidden until hover / focus */
.mact{display:flex;align-items:center;gap:2px;margin-top:6px;opacity:0;transition:opacity var(--t-hover) var(--ease);min-height:26px}
.msg:hover .mact,.msg:focus-within .mact,.mact.keep{opacity:1}
.msg.user .mact{justify-content:flex-end}
.mact .when{font-size:11.5px;color:var(--text-muted);padding:0 6px;font-variant-numeric:tabular-nums}
.mact .prov{font-size:11.5px;color:var(--accent-primary);padding:0 6px}
/* inline editor (Edit) */
.medit{width:min(100%,640px);display:flex;flex-direction:column;gap:8px;animation:lain-fade var(--t-drop) var(--ease)}
.medit textarea{width:100%;min-height:70px;resize:vertical;padding:10px 14px;border-radius:14px;border:0;outline:0;background:var(--surface-raised);box-shadow:inset 0 0 0 1px var(--accent-border);color:var(--text-primary);font:inherit;font-size:var(--fs-chat);line-height:1.55}
.medit .row{display:flex;gap:8px;justify-content:flex-end}
/* ---- LIVE: one evolving work area -------------------------------------------------------------------------- */
.lv{margin:0 0 26px;animation:lain-fade var(--t-drop) var(--ease)}
.lv-work{display:flex;align-items:center;gap:9px;font-size:var(--fs-body);color:var(--text-secondary);min-height:24px}
.lv-work .g{flex:none;width:10px;height:10px;border-radius:50%;background:var(--accent-primary);animation:lv-pulse 1.25s ease-in-out infinite}
.lv-work .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-work .t b{font-weight:600;color:var(--text-primary);margin-right:6px}
@keyframes lv-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.lv-tl{list-style:none;margin:6px 0 0;padding:0 0 0 19px;display:flex;flex-direction:column;gap:3px;animation:lain-fade var(--t-drop) var(--ease)}
.lv-tl li{display:grid;grid-template-columns:16px minmax(0,auto) minmax(0,1fr) auto;gap:8px;align-items:baseline;font-size:var(--fs-small);color:var(--text-secondary)}
.lv-tl li .m{color:var(--positive)} .lv-tl li.run .m{color:var(--accent-primary)} .lv-tl li.bad .m{color:var(--danger)}
.lv-tl li .n{color:var(--text-primary);white-space:nowrap}
.lv-tl li .ms{color:var(--text-muted);font-variant-numeric:tabular-nums}
.lv-meta{font-weight:400;color:var(--text-muted);font-variant-numeric:tabular-nums}
.lv-tl li .x{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-more{display:inline-flex;align-items:center;gap:6px;margin:0 0 6px;padding:2px 6px 2px 2px;border:0;background:none;font:500 12.5px/1.4 var(--sans);color:var(--text-muted);cursor:pointer;border-radius:var(--radius-sm)}
.lv-more:hover,.lv-more:focus-visible{color:var(--text-primary);background:var(--surface-active)}
.lv-more .chev{display:inline-block;transition:transform var(--t-drop) var(--ease)}
.lv-more[aria-expanded=true] .chev{transform:rotate(90deg)}
.lv-think{margin:4px 0 6px;color:var(--text-muted);font-size:var(--fs-small)}
.lv-think summary{cursor:pointer;list-style:none}
.lv-think summary::before{content:"▸ "}
.lv-think[open] summary::before{content:"▾ "}
.lv-think-text{margin:4px 0 0 14px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--canvas);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--mono);color:var(--text-muted);max-height:40vh;overflow:auto}
.lv-text{font-size:var(--fs-chat);line-height:1.7;color:var(--text-primary);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
.lv-text .caret{display:inline-block;width:7px;height:1.05em;margin-left:1px;vertical-align:-2px;background:var(--accent-primary);opacity:.7;animation:lv-blink 1s steps(2) infinite}
@keyframes lv-blink{50%{opacity:0}}
/* ---- SIDECAR: compact, implementation-focused ---------------------------------------------------------------- */
.bp-convo .lv{margin:0;padding:10px 0;border-top:1px solid var(--separator)}
.bp-convo .lv-work{font-size:12.5px}
.bp-convo .lv-tl{padding-left:0}
.bp-convo .lv-tl li{font-size:12px}
.bp-convo .lv-text{font-size:var(--fs-sidecar);line-height:1.55}
.bp-convo .msg .body{line-height:1.55}
.bp-convo .mact{margin-top:2px}
.bp-convo .mbtn{height:22px;padding:0 6px;font-size:11.5px}
.bp-convo .msg.user .body{max-width:none;padding:0;background:none;border-radius:0}
.bp-convo .cb-b{white-space:pre-wrap}
@media (prefers-reduced-motion: reduce){.lv-work .g,.lv-text .caret{animation:none}.lv,.lv-tl,.medit{animation:none}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;

  // ===== the message body: prose and code, built as DOM — never HTML from text ================================
  function inline(text, into) {
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)<>]+)/g;
    var last = 0; var m;
    while ((m = re.exec(text))) {
      if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
      var t = m[0];
      if (t.charAt(0) === '`') into.appendChild(el('code', 'ic', t.slice(1, -1)));
      else if (t.slice(0, 2) === '**') into.appendChild(el('strong', '', t.slice(2, -2)));
      else if (t.charAt(0) === '*') into.appendChild(el('em', '', t.slice(1, -1)));
      else {
        var label = t; var href = t;
        if (t.charAt(0) === '[') { label = t.slice(1, t.indexOf('](')); href = m[2]; }
        var a = el('a', 'lnk', label); a.title = href; a.setAttribute('data-href', href);
        a.onclick = (function (u) { return function (e) { e.preventDefault(); if (L.hostCall) L.hostCall('openExternal', { url: u }); }; }(href));
        into.appendChild(a);
      }
      last = m.index + t.length;
    }
    if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
  }
  function prose(text, box) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    var para = []; var list = null; var listType = '';
    function flushPara() { if (!para.length) return; var p = el('p'); inline(para.join('\n'), p); p.style.whiteSpace = 'pre-wrap'; box.appendChild(p); para = []; }
    function flushList() { if (list) { box.appendChild(list); list = null; listType = ''; } }
    lines.forEach(function (ln) {
      var h = /^(#{1,4})\s+(.*)$/.exec(ln);
      var ul = /^\s*[-*•]\s+(.*)$/.exec(ln);
      var ol = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(ln);
      var bq = /^>\s?(.*)$/.exec(ln);
      if (!ln.trim()) { flushPara(); flushList(); return; }
      if (/^(-{3,}|\*{3,})$/.test(ln.trim())) { flushPara(); flushList(); box.appendChild(el('hr')); return; }
      if (h) { flushPara(); flushList(); var hn = el('h' + Math.min(4, h[1].length + 1)); inline(h[2], hn); box.appendChild(hn); return; }
      if (ul || ol) {
        flushPara();
        var want = ul ? 'ul' : 'ol';
        if (!list || listType !== want) { flushList(); list = el(want); listType = want; if (ol && ol[1] !== '1') list.start = Number(ol[1]); }
        var li = el('li'); inline(ul ? ul[1] : ol[2], li); list.appendChild(li); return;
      }
      if (bq) { flushPara(); flushList(); var q = el('blockquote'); inline(bq[1], q); box.appendChild(q); return; }
      flushList(); para.push(ln);
    });
    flushPara(); flushList();
  }
  function codeBlock(lang, code) {
    var b = el('div', 'cb'); b.setAttribute('data-wrap', 'false');
    var h = el('div', 'cb-h');
    h.appendChild(el('span', 'lang', lang || 'text'));
    var wrap = el('button', 'mbtn', 'Wrap'); wrap.type = 'button'; wrap.title = 'Wrap long lines';
    wrap.onclick = function () { var on = b.getAttribute('data-wrap') !== 'true'; b.setAttribute('data-wrap', String(on)); wrap.textContent = on ? 'No wrap' : 'Wrap'; };
    h.appendChild(wrap);
    h.appendChild(copyButton(function () { return code; }, 'Copy code', 'copy-code'));
    b.appendChild(h);
    b.appendChild(el('pre', 'cb-b', code));
    return b;
  }
  /** Prose and fenced code — text only, never markup. */
  function body(text) {
    var box = el('div', 'body');
    var parts = String(text || '').split('```');
    parts.forEach(function (part, i) {
      if (i % 2 === 0) { if (part.trim()) prose(part.replace(/^\n+|\n+$/g, ''), box); return; }
      var nl = part.indexOf('\n');
      var lang = nl > 0 ? part.slice(0, nl).trim() : '';
      var code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
      box.appendChild(codeBlock(lang, code));
    });
    return box;
  }

  // ===== copy ======================================================================================================
  function clean(text) { return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
  async function copy(text) {
    var t = clean(text);
    try { var r = await L.api('/api/clipboard/write', { text: t }); if (r && r.ok !== false) return true; } catch (e) { /* the host may not offer it */ }
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; }
  }
  function copyButton(get, label, act) {
    var b = el('button', 'mbtn'); b.type = 'button'; b.title = label; b.setAttribute('data-act', act || 'copy'); b.setAttribute('aria-label', label);
    if (L.icon) b.appendChild(L.icon('files', 14));
    var tx = el('span', '', label === 'Copy code' ? 'Copy code' : 'Copy'); b.appendChild(tx);
    b.onclick = async function (e) {
      e.stopPropagation();
      var ok = await copy(get());
      b.classList.toggle('done', ok);
      tx.textContent = ok ? 'Copied' : 'Not copied';
      if (b.firstChild && b.firstChild.tagName === 'svg' && ok && L.icon) b.replaceChild(L.icon('check', 14), b.firstChild);
      setTimeout(function () { b.classList.remove('done'); tx.textContent = label === 'Copy code' ? 'Copy code' : 'Copy'; if (L.icon && b.firstChild && b.firstChild.tagName === 'svg') b.replaceChild(L.icon('files', 14), b.firstChild); }, 1300);
    };
    return b;
  }

  // ===== message actions ===========================================================================================
  function view() { var u = L.ui ? L.ui() : null; return u && u.mode === 'chat' ? 'chat' : 'coding'; }
  function mbtn(label, icon, act, fn) { var b = el('button', 'mbtn'); b.type = 'button'; b.setAttribute('data-act', act); b.title = label; if (icon && L.icon) b.appendChild(L.icon(icon, 14)); b.appendChild(el('span', '', label)); b.onclick = function (e) { e.stopPropagation(); fn(b); }; return b; }
  /**
   * The row under a message. ctx: { lastUser, lastAssistant, running }. Latest user message: Edit · Copy; older: Copy.
   * Latest answer: Copy · Retry · Continue (when nothing is running).
   */
  function decorate(wrap, m, ctx) {
    var row = el('div', 'mact');
    if (m.role === 'user') {
      if (ctx.lastUser && !ctx.running && m.by !== 'handoff') row.appendChild(mbtn('Edit', 'pencil', 'edit', function () { edit(wrap, m); }));
      row.appendChild(copyButton(function () { return m.text; }, 'Copy', 'copy'));
    } else {
      row.appendChild(copyButton(function () { return m.text; }, 'Copy', 'copy'));
      if (ctx.lastAssistant && !ctx.running) {
        row.appendChild(mbtn('Retry', 'rotate', 'retry', function (b) { retry(b); }));
        row.appendChild(mbtn('Continue', 'play', 'continue', function () { if (L.send) L.send('Continue.'); }));
      }
      if (m.provenance && m.provenance.label) row.appendChild(el('span', 'prov', m.provenance.label));
    }
    if (m.at) { var w = el('span', 'when', L.fmt ? L.fmt.time(Date.parse(m.at)) : ''); row.appendChild(w); }
    wrap.appendChild(row);
  }
  /** EDIT (latest user message only): inline editor → Save & resend makes a new branch (Core's turnedit.js). */
  function edit(wrap, m) {
    var old = wrap.querySelector('.body'); var acts = wrap.querySelector('.mact');
    if (!old || wrap.querySelector('.medit')) return;
    var ed = el('div', 'medit');
    var ta = document.createElement('textarea'); ta.value = m.text; ta.setAttribute('aria-label', 'Edit your message');
    var r = el('div', 'row');
    var cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    var save = el('button', 'btn primary', 'Save & resend'); save.type = 'button'; save.setAttribute('data-act', 'save-resend');
    r.appendChild(cancel); r.appendChild(save); ed.appendChild(ta); ed.appendChild(r);
    old.hidden = true; if (acts) acts.hidden = true;
    wrap.appendChild(ed);
    setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    var close = function () { ed.remove(); old.hidden = false; if (acts) acts.hidden = false; };
    cancel.onclick = close;
    ta.onkeydown = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); } };
    save.onclick = async function () {
      var text = ta.value.trim(); if (!text) return;
      save.disabled = cancel.disabled = true;
      var res = await resend('/api/turn/edit', { view: view(), text: text });
      if (!res) { save.disabled = cancel.disabled = false; return; }
      close();
    };
  }
  async function retry(btn) { btn.disabled = true; await resend('/api/turn/retry', { view: view() }); btn.disabled = false; }
  /** The Coding lane asks first when the replaced turns changed files: Undo them first (default) or Keep them. */
  async function resend(path, payload) {
    var r = await L.api(path, payload).catch(function (e) { return { ok: false, why: e.message }; });
    if (r && r.ok && r.needsChoice) {
      var list = (r.files || []).slice(0, 8).join('\n') + ((r.files || []).length > 8 ? '\n…' : '');
      var pick = await L.dialog({ title: r.why || 'The earlier request changed files', text: list + '\n\nThe earlier request and its answer are kept as a branch either way.', ok: 'Undo them first', extra: { label: 'Keep them', value: 'keep' } });
      if (!pick) return null;
      r = await L.api(path, Object.assign({}, payload, { files: pick === 'keep' ? 'keep' : 'undo' })).catch(function (e) { return { ok: false, why: e.message }; });
    }
    if (!r || !r.ok) { L.toast((r && r.why) || 'Not sent', true); return null; }
    if (r.undone && r.undone.length) L.toast('Undid ' + r.undone.length + ' file change' + (r.undone.length === 1 ? '' : 's') + ' first.');
    live.reset(); L.poll();
    return r;
  }

  // ===== the live turn =============================================================================================
  var KIND = {
    search: { run: 'Searching the web', done: 'Searched the web', unit: ['search', 'searches'] },
    web: { run: 'Reading a web page', done: 'Read the web', unit: ['page', 'pages'] },
    read: { run: 'Reading project', done: 'Read project', unit: ['file', 'files'] },
    find: { run: 'Searching project', done: 'Searched project', unit: ['search', 'searches'] },
    edit: { run: 'Editing', done: 'Edited', unit: ['file', 'files'] },
    check: { run: 'Running check', done: 'Ran checks', unit: ['check', 'checks'] },
    run: { run: 'Running command', done: 'Ran commands', unit: ['command', 'commands'] },
    preview: { run: 'Using Preview', done: 'Used Preview', unit: ['action', 'actions'] },
    agent: { run: 'Delegating', done: 'Delegated', unit: ['task', 'tasks'] },
    other: { run: 'Working', done: 'Worked', unit: ['step', 'steps'] },
  };
  function kindOf(name) {
    var n = String(name || '').toLowerCase();
    if (/web_?search|search_?web/.test(n)) return 'search';
    if (/web_?fetch|fetch_?url|download|^fetch$/.test(n)) return 'web';
    if (/preview|browser|computer|chrome/.test(n)) return 'preview';
    if (/test|verify/.test(n)) return 'check';
    if (/edit|write|patch|create_file|rename|delete|multiedit|notebook/.test(n)) return 'edit';
    if (/grep|glob|search|locate|find|symbol|semantic|concept|recall/.test(n)) return 'find';
    if (/read|list|^ls$|view|open|tree|outline|inspect/.test(n)) return 'read';
    if (/bash|powershell|cmd|shell|exec|process|run_|job/.test(n)) return 'run';
    if (/delegate|subagent|task/.test(n)) return 'agent';
    return 'other';
  }
  function short(p) { var s = String(p || ''); var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 && s.length - i < 60 ? s.slice(i + 1) : s; }

  var live = {
    sid: null, on: false, text: '', acts: [], phase: null, thinking: false, begun: 0, baseCount: -1, open: false, node: null, frame: 0, summary: null,
    think: '', thinkSince: 0, thoughts: [],   // THINKING (Core's thought events): the live tail, then one folded line per phase
    word: '', stepSince: 0, chars: 0, tick: 0,   // THE LIVE ROW (S5.2): the CLI's words, this step's time, ~tokens
    reset: function () { this.on = false; this.text = ''; this.acts = []; this.phase = null; this.thinking = false; this.baseCount = -1; this.open = false; this.think = ''; this.thinkSince = 0; this.thoughts = []; this.draw(); },
    schedule: function () { var self = this; if (this.frame) return; this.frame = requestAnimationFrame(function () { self.frame = 0; self.draw(); }); },
    draw: function () { if (this.node && this.node.isConnected) paint(this.node); },
  };
  function current() { var S = L.state ? L.state() : null; return S && S.current ? S.current.id : null; }
  function visibleCount() { var st = $stream(); return st ? st.querySelectorAll('.msg').length : 0; }
  function $stream() { return document.getElementById('stream'); }

  function onEvent(e) {
    if (!e || !e.ev || e.session !== current()) return;
    var ev = e.ev;
    if (ev.type === 'turn.begin') {
      if (live.on && live.acts.length) live.summary = { acts: live.acts.slice(), at: Date.now() };
      live.sid = e.session; live.on = true; live.text = ''; live.acts = []; live.phase = null; live.thinking = true; live.begun = Date.now(); live.baseCount = -1; live.open = false; live.think = ''; live.thinkSince = 0; live.thoughts = [];
      live.word = ''; live.stepSince = Date.now(); live.chars = 0;
      if (!live.tick) live.tick = setInterval(function () { if (live.on) live.draw(); else { clearInterval(live.tick); live.tick = 0; } }, 1000);
    } else if (!live.on) {
      return;
    } else if (ev.type === 'text') {
      if (live.baseCount < 0) live.baseCount = visibleCount();
      live.text += String(ev.text || ''); live.thinking = false; live.chars += String(ev.text || '').length;
      if (live.word !== 'Writing') { live.word = 'Writing'; }
    } else if (ev.type === 'thinking') {
      if (!live.text) live.thinking = true;
      if (!live.thinkSince) live.thinkSince = Date.now();
      if (ev.text) live.think = (live.think + ev.text).slice(-1600);
      live.chars += String(ev.text || '').length;
      if (live.word !== 'Thinking') live.word = 'Thinking';
    } else if (ev.type === 'thought') {
      live.thoughts.push({ ms: ev.ms || 0, tokens: ev.tokens, chars: ev.chars || 0, interrupted: Boolean(ev.interrupted), hidden: Boolean(ev.hidden), text: ev.text || '' });
      live.think = ''; live.thinkSince = 0;
    } else if (ev.type === 'tool.start') {
      live.text = ''; live.baseCount = -1; live.thinking = false;
      live.word = ev.word || ''; live.stepSince = Date.now();
      live.acts.push({ id: ev.id || ('a' + live.acts.length), name: ev.name || '', target: ev.target || '', word: ev.word || '', kind: kindOf(ev.name), state: 'run', at: Date.now() });
    } else if (ev.type === 'tool.end') {
      var a = null;
      for (var i = live.acts.length - 1; i >= 0; i--) { if ((ev.id && live.acts[i].id === ev.id) || (!ev.id && live.acts[i].state === 'run' && (!ev.name || live.acts[i].name === ev.name))) { a = live.acts[i]; break; } }
      if (a) { a.state = ev.ok === false ? 'bad' : 'ok'; a.ms = ev.ms || null; a.summary = ev.summary || ''; }
    } else if (ev.type === 'phase') {
      live.phase = ev.phase || null;
      if (ev.phase === 'WAITING_MODEL') { live.word = ev.word || 'Waiting for the model'; live.stepSince = Date.now(); live.chars = 0; }
    } else if (ev.type === 'turn.end') {
      live.on = false; live.thinking = false; live.think = ''; live.thinkSince = 0;
      live.acts.forEach(function (x) { if (x.state === 'run') x.state = 'ok'; });
      if (live.acts.length || live.thoughts.length) live.summary = { acts: live.acts.slice(), thoughts: live.thoughts.slice(), at: Date.now() };
      live.text = ''; live.acts = [];
      if (L.poll) L.poll();
    }
    live.schedule();
  }

  /** A group per kind of work, in the order it first happened. */
  function groups(acts) {
    var out = []; var by = {};
    acts.forEach(function (a) {
      var g = by[a.kind];
      if (!g) { g = by[a.kind] = { kind: a.kind, n: 0, running: null, bad: 0, targets: [] }; out.push(g); }
      g.n += 1; if (a.state === 'run') g.running = a; if (a.state === 'bad') g.bad += 1;
      if (a.target && g.targets.indexOf(a.target) < 0) g.targets.push(a.target);
    });
    return out;
  }
  /** The CLI's live-row words (Core sends them): Waiting for <model> · Thinking · Writing · Running <label>. */
  function headline(acts) {
    var run = acts.filter(function (a) { return a.state === 'run'; }).pop();
    if (run) { if (run.word) return run.word; var k = KIND[run.kind] || KIND.other; return k.run + (run.kind === 'edit' && run.target ? ' ' + short(run.target) : '') + '…'; }
    if (live.phase === 'RETRYING') return 'Waiting for provider…';
    return live.word || (live.thinking || !live.text ? 'Thinking' : '');
  }
  function since(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
  function liveFacts() { var bits = [since(Date.now() - (live.stepSince || live.begun))]; if (live.chars) bits.push('↓~' + fmtTok(Math.ceil(live.chars / 4))); return bits.join(' · '); }
  /** One row per tool call, with how long it took once it finished (S5.2). */
  function timeline(acts) {
    var ul = el('ul', 'lv-tl');
    acts.forEach(function (a) {
      var k = KIND[a.kind] || KIND.other;
      var li = el('li', a.state === 'run' ? 'run' : a.state === 'bad' ? 'bad' : '');
      li.appendChild(el('span', 'm', a.state === 'run' ? '●' : a.state === 'bad' ? '!' : '✓'));
      li.appendChild(el('span', 'n', a.state === 'run' ? (a.word || k.run) : k.done));
      li.appendChild(el('span', 'x', short(a.target || a.name)));
      if (a.ms != null && a.state !== 'run') li.appendChild(el('span', 'ms', (a.ms / 1000).toFixed(a.ms < 10000 ? 1 : 0) + 's'));
      ul.appendChild(li);
    });
    return ul;
  }
  function moreToggle(n, open, onToggle) {
    var b = el('button', 'lv-more'); b.type = 'button'; b.setAttribute('aria-expanded', String(Boolean(open))); b.setAttribute('data-act', 'activities');
    b.appendChild(el('span', 'chev', '▸')); b.appendChild(el('span', '', n + ' activit' + (n === 1 ? 'y' : 'ies')));
    b.onclick = function () { onToggle(); };
    return b;
  }
  /** `Thought for 2m 23s · 8.2k tokens` (or `Thinking (interrupted)`), opening to what the model thought. */
  function thoughtNode(t, opts) {
    var d = document.createElement('details'); d.className = 'lv-think';
    var secs = Math.round((t.ms || 0) / 1000);
    var dur = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + String(secs % 60).padStart(2, '0') + 's';
    var tk = t.tokens != null ? fmtTok(t.tokens) + ' tokens' : t.chars ? '~' + fmtTok(Math.ceil(t.chars / 4)) + ' tokens' : '';
    var s = document.createElement('summary'); s.textContent = (opts && opts.live ? 'Thinking… ' + dur : t.interrupted ? 'Thinking (interrupted)' : 'Thought for ' + dur) + (tk ? ' · ' + tk : '');
    d.appendChild(s);
    if (t.text && !t.hidden) { var b = el('div', 'lv-think-text'); b.textContent = t.text; d.appendChild(b); }
    if (opts && opts.live) d.open = true;
    return d;
  }
  function fmtTok(n) { n = Number(n) || 0; return n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k'; }
  function paint(node) {
    node.textContent = '';
    if (!live.on) { node.hidden = true; return; }
    node.hidden = false;
    live.thoughts.forEach(function (t) { node.appendChild(thoughtNode(t)); });
    if (live.thinkSince) node.appendChild(thoughtNode({ ms: Date.now() - live.thinkSince, chars: live.think.length, text: live.think.split(/\n/).slice(-4).join('\n') }, { live: true }));
    var acts = live.acts;
    var streaming = Boolean(live.text) && !acts.some(function (a) { return a.state === 'run'; });
    var meaningful = groups(acts).length;
    if (streaming && acts.length) {
      node.appendChild(moreToggle(acts.length, live.open, function () { live.open = !live.open; live.draw(); }));
      if (live.open) node.appendChild(timeline(acts));
    } else {
      var h = headline(acts);
      if (h) { var w = el('div', 'lv-work'); w.setAttribute('data-live', 'work'); w.appendChild(el('span', 'g')); var t = el('span', 't'); t.appendChild(el('b', '', h)); t.appendChild(el('span', 'lv-meta', ' · ' + liveFacts())); w.appendChild(t); node.appendChild(w); }
      if (meaningful > 1 || (meaningful === 1 && acts.length > 1)) node.appendChild(timeline(acts));
    }
    var showText = live.text && (live.baseCount < 0 || visibleCount() <= live.baseCount);
    if (showText) { var tx = el('div', 'lv-text'); tx.setAttribute('data-live', 'text'); tx.appendChild(document.createTextNode(live.text)); tx.appendChild(el('span', 'caret')); node.appendChild(tx); }
    var st = $stream();
    if (st && st.dataset.stick !== 'false') st.scrollTop = st.scrollHeight;
  }
  /** Called by the stream after it draws: the live block goes last, as the same node — never rebuilt. */
  function mount(box) {
    if (!live.node) { live.node = el('div', 'lv'); live.node.setAttribute('data-live-turn', '1'); }
    box.appendChild(live.node);
    paint(live.node);
  }
  /** The finished turn's activities, collapsed above the answer they led to. */
  function summaryFor(wrap) {
    var s = live.summary; if (!s || (!s.acts.length && !(s.thoughts || []).length)) return;
    var open = false; var box = el('div', 'lv-sum');
    var draw = function () { box.textContent = ''; (s.thoughts || []).forEach(function (t) { box.appendChild(thoughtNode(t)); }); if (!s.acts.length) return; box.appendChild(moreToggle(s.acts.length, open, function () { open = !open; draw(); })); if (open) box.appendChild(timeline(s.acts)); };
    draw();
    wrap.insertBefore(box, wrap.querySelector('.body'));
  }
  function active() { return live.on; }

  L.onBoot(function () {
    if (L.contract && L.contract.on) L.contract.on('turn.event', onEvent);
    var st = $stream();
    if (st) st.addEventListener('scroll', function () { st.dataset.stick = String(st.scrollTop + st.clientHeight >= st.scrollHeight - 40); }, { passive: true });
  });

  L.live = { body: body, decorate: decorate, mount: mount, summaryFor: summaryFor, active: active, reset: function () { live.reset(); }, copy: copy, kindOf: kindOf, _state: live };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js };
