'use strict';

/**
 * THE PLAN CARD — split out of pagescript.js (the 700-line god-object guard).
 *
 * "Plan ready — Continue to Coding?" [Yes] [Edit plan] [Not yet], exactly as
 * docs/HARNESS_UI_CONTRACT.md section 5 specifies.
 *
 * Driven entirely by S.plans.prompt (planhandoff.js): a Chat reply becomes a
 * DRAFT when it calls itself a plan or answers one that asked for it, and the
 * prompt exists until Yes/Edit/Not yet answers it. Yes accepts and freezes
 * the plan and switches the view to Coding SERVER-SIDE — nothing here decides
 * that; the shell's render() picks up S.views.active === 'coding' on the next
 * poll like any other view change.
 *
 * NO BACKTICKS ANYWHERE BELOW, comments included — one template literal, same
 * rule as every other page*.js file.
 */

function js() {
  return `
window.LAIN = window.LAIN || {};
LAIN.plan = (function () {
  'use strict';
  var api = null, notice = null, poll = null, render = null;
  var editingPlan = null;       // a plan id currently showing its inline editor, or null
  var appliedHandoff = null;    // the last handoffId already dropped into the composer
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }

  function buildCard(S) {
    var plans = S.plans;
    if (!plans || !plans.prompt) return null;
    var prompt = plans.prompt;
    var doc = (plans.plans || []).filter(function (p) { return p.id === prompt.planId; })[0] || null;
    var card = el('div', 'plancard');
    card.appendChild(el('div', 'ph', 'Plan ready \\u2014 Continue to Coding?'));

    if (editingPlan === prompt.planId) {
      var box = el('div', '');
      box.style.padding = '10px 14px';
      var ta = document.createElement('textarea');
      ta.value = doc ? doc.text : '';
      ta.rows = Math.min(14, Math.max(4, ((doc && doc.text) || '').split('\\n').length));
      ta.style.width = '100%';
      ta.style.background = 'var(--bg)';
      ta.style.padding = '8px';
      ta.style.borderRadius = 'var(--radius)';
      box.appendChild(ta);
      card.appendChild(box);
      var editActions = el('div', 'actions');
      var save = el('button', 'btn go', 'Save');
      save.onclick = async function () {
        var r = await api('/api/plan/edit', { id: prompt.planId, text: ta.value });
        if (!r.ok) return notice(r.why, true);
        editingPlan = null;
        poll();
      };
      var cancel = el('button', 'btn', 'Cancel');
      cancel.onclick = function () { editingPlan = null; render(); };
      editActions.appendChild(save);
      editActions.appendChild(cancel);
      card.appendChild(editActions);
      return card;
    }

    if (doc) {
      var steps = el('div', 'steps');
      (doc.steps || []).forEach(function (s, i) {
        var row = el('div', 'step');
        row.appendChild(el('span', 'm', String(i + 1)));
        row.appendChild(el('span', 't', s));
        steps.appendChild(row);
      });
      card.appendChild(steps);
    }

    var actions = el('div', 'actions');
    var yes = el('button', 'btn go', 'Yes');
    yes.onclick = async function () {
      yes.disabled = true;
      var r = await api('/api/plan/accept', { id: prompt.planId });
      yes.disabled = false;
      if (!r.ok) return notice(r.why, true);
      poll();
    };
    var editBtn = el('button', 'btn', 'Edit plan');
    editBtn.onclick = function () { editingPlan = prompt.planId; render(); };
    var not = el('button', 'btn', 'Not yet');
    not.onclick = async function () {
      var r = await api('/api/plan/defer', { id: prompt.planId });
      if (!r.ok) return notice(r.why, true);
      poll();
    };
    actions.appendChild(yes);
    actions.appendChild(editBtn);
    actions.appendChild(not);
    card.appendChild(actions);
    return card;
  }

  /**
   * THE CODING COMPOSER PREFILL — applied ONCE per handoffId, never again, so
   * a person's own edits after "Yes" are never overwritten by the next poll.
   */
  function applyPrefill(S) {
    var prefill = S.composer && S.composer.coding && S.composer.coding.prefill;
    if (!prefill || prefill.handoffId === appliedHandoff) return;
    appliedHandoff = prefill.handoffId;
    var box = $('ask');
    box.value = prefill.text || '';
    box.style.height = 'auto';
    box.style.height = Math.min(180, box.scrollHeight) + 'px';
  }

  function boot(apiFn, noticeFn, pollFn, renderFn) {
    api = apiFn; notice = noticeFn; poll = pollFn; render = renderFn;
  }

  return { boot: boot, buildCard: buildCard, applyPrefill: applyPrefill };
})();
`;
}

module.exports = { js };
