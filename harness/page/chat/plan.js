'use strict';

/**
 * THE PLAN CARD — a plan made in Chat, reviewed, and sent to the Coding Agent.
 *
 *   Proposed Implementation Plan
 *   1 …  2 …  3 …
 *   [▶ Send to Coding Agent]  [Edit plan]  [Discuss]
 *
 * Driven by S.plans.prompt (planhandoff.js): a Chat reply becomes a DRAFT when
 * it calls itself a plan or answers one that asked for it. "Send to Coding
 * Agent" accepts the APPROVED text and starts it in the SAME session's Coding
 * Agent lane (POST /api/plan/send) — not a regenerated prompt, not a copy. With
 * no project folder, Core refuses with projectRequired and the card offers Use
 * open project / Choose project / Create project, then sends again.
 *
 * NO BACKTICKS ANYWHERE BELOW — one template literal.
 */

const CSS = `
.plancard{margin:0 0 24px;max-width:820px;background:var(--surface-base);border-radius:16px;padding:22px 24px}
.plancard .pc-head{display:flex;gap:16px;align-items:flex-start}
.plancard .pc-ic{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;background:var(--selection);color:var(--accent-primary);flex:none}
.plancard .pc-t{font:600 19px/1.3 var(--sans);margin:0}
.plancard .pc-s{color:var(--text-secondary);font-size:15px;margin-top:4px}
.plancard .pc-steps{margin:18px 0 0;padding:0;list-style:none}
.plancard .pc-steps li{display:flex;gap:16px;align-items:flex-start;padding:8px 0}
.plancard .pc-n{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--selection);color:var(--accent-primary);font-weight:700}
.plancard .pc-st{font-size:15.5px;line-height:1.45;padding-top:6px}
.plancard .pc-acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--separator)}
.plancard textarea{width:100%;background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:10px;padding:12px;font:15px/1.5 var(--sans);resize:vertical}
`;

function js() {
  return `
window.LAIN = window.LAIN || {};
LAIN.plan = (function () {
  'use strict';
  var api = null, notice = null, poll = null, render = null;
  var editingPlan = null;
  var appliedHandoff = null;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function fbtn(label, cls, icon) { var b = el('button', 'fbtn ' + (cls || '')); if (icon && LAIN.icon) b.appendChild(LAIN.icon(icon, 16)); b.appendChild(el('span', '', label)); return b; }

  async function send(planId, btn) {
    if (btn) btn.disabled = true;
    var r = await api('/api/plan/send', { id: planId });
    if (btn) btn.disabled = false;
    if (r && r.projectRequired) {
      LAIN.work.projectMenu(btn, { reason: 'A project is required.', then: function () { send(planId, null); } });
      return;
    }
    if (!r || !r.ok) { if (r && r.offer) { LAIN.chat.lane('agent'); poll(); return; } return notice((r && r.why) || 'could not send the plan', true); }
    LAIN.chat.lane('agent');
    poll();
  }

  function buildCard(S) {
    var plans = S.plans;
    if (!plans || !plans.prompt) return null;
    var prompt = plans.prompt;
    var doc = (plans.plans || []).filter(function (p) { return p.id === prompt.planId; })[0] || null;
    var card = el('div', 'plancard');
    var head = el('div', 'pc-head');
    var ic = el('div', 'pc-ic'); if (LAIN.icon) ic.appendChild(LAIN.icon('files', 24)); head.appendChild(ic);
    var ht = el('div', '');
    ht.appendChild(el('h3', 'pc-t', 'Proposed Implementation Plan'));
    ht.appendChild(el('div', 'pc-s', (doc && doc.title) || prompt.title || 'Review it, correct it, then send it to the Coding Agent.'));
    head.appendChild(ht);
    card.appendChild(head);

    if (editingPlan === prompt.planId) {
      var ta = document.createElement('textarea');
      ta.value = doc ? doc.text : '';
      ta.rows = Math.min(16, Math.max(5, ((doc && doc.text) || '').split('\\n').length + 1));
      ta.style.marginTop = '16px';
      card.appendChild(ta);
      var ea = el('div', 'pc-acts');
      var save = fbtn('Save plan', 'primary');
      save.onclick = async function () {
        var r = await api('/api/plan/edit', { id: prompt.planId, text: ta.value });
        if (!r.ok) return notice(r.why, true);
        editingPlan = null; LAIN.plan.dirty = true; poll();
      };
      var cancel = fbtn('Cancel', 'ghost');
      cancel.onclick = function () { editingPlan = null; LAIN.plan.dirty = true; render(); };
      ea.appendChild(save); ea.appendChild(cancel);
      card.appendChild(ea);
      return card;
    }
    if (doc) {
      var ol = el('ol', 'pc-steps');
      (doc.steps || []).forEach(function (s, i) {
        var li = el('li');
        li.appendChild(el('span', 'pc-n', String(i + 1)));
        li.appendChild(el('span', 'pc-st', s));
        ol.appendChild(li);
      });
      card.appendChild(ol);
    }
    var acts = el('div', 'pc-acts');
    var go = fbtn('Send to Coding Agent', 'primary', 'play');
    go.onclick = function () { send(prompt.planId, go); };
    var ed = fbtn('Edit plan', 'ghost', 'pencil');
    ed.onclick = function () { editingPlan = prompt.planId; LAIN.plan.dirty = true; render(); };
    var dc = fbtn('Discuss', 'ghost', 'chat');
    dc.onclick = function () { var a = $('ask'); if (a) { a.value = a.value || 'About the plan: '; a.focus(); } };
    var later = fbtn('Not yet', 'ghost');
    later.onclick = async function () { var r = await api('/api/plan/defer', { id: prompt.planId }); if (!r.ok) return notice(r.why, true); poll(); };
    acts.appendChild(go); acts.appendChild(ed); acts.appendChild(dc); acts.appendChild(later);
    card.appendChild(acts);
    return card;
  }

  /** THE CODING COMPOSER PREFILL — applied ONCE per handoffId (an IDE handoff). */
  function applyPrefill(S) {
    var prefill = S.composer && S.composer.coding && S.composer.coding.prefill;
    if (!prefill || prefill.handoffId === appliedHandoff) return;
    appliedHandoff = prefill.handoffId;
    var box = $('ask');
    box.value = prefill.text || '';
    box.style.height = 'auto';
    box.style.height = Math.min(180, box.scrollHeight) + 'px';
  }

  function boot(apiFn, noticeFn, pollFn, renderFn) { api = apiFn; notice = noticeFn; poll = pollFn; render = renderFn; }

  return { boot: boot, buildCard: buildCard, applyPrefill: applyPrefill, send: send, dirty: false };
})();
`;
}

module.exports = { js, CSS };
