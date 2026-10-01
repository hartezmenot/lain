'use strict';

/**
 * CONTROLS OVER CANONICAL SESSION STATE — the same verbs from the Harness
 * composer, Telegram and any other remote surface. They change Core state and
 * return text; they are never sent to a model, and no surface keeps a copy.
 *
 *   /model [id]        the Coding Agent's provider › model (sessionintel)
 *   /account [auto|ask|pin <n>]   the provider's account policy and backing accounts (fabric)
 *   /effort [level]    one of the levels the lane's model declares (fabric/effortcaps.js)
 *   /fast /eco         execution profile, toggles (the active one again → Normal); /normal resets (queued while the Agent works)
 *   /mode [m]          AUTO · MANUAL · PLAN (execmode)
 *   /strategy [s]      Normal · Phased · Long Context Phasing (the warning is answered separately)
 *   /status            the session: project, lane, phase, model, profile, strategy
 *   /usage             provider windows and LAIN-observed usage in them
 *   /project           the attached project, or how to attach one
 *   /compact           the one context authority compacts (no model call)
 *   /target [n]        (Telegram) which session this chat drives
 *   /help
 *
 * ChatGPT Chat stays CHAT ONLY: sessionintel refuses it as the Coding Agent.
 */

const LIST = Object.freeze([
  ['/model', 'Coding Agent provider › model — /model <id>'], ['/account', 'account policy — /account auto · ask · pin <n>'],
  ['/effort', 'reasoning effort — a level the model offers'], ['/fast', 'Fast profile (toggle)'], ['/eco', 'Eco profile (toggle)'],
  ['/normal', 'Normal profile'], ['/mode', 'AUTO · MANUAL · PLAN'],
  ['/strategy', 'Normal · Phased · Long Context Phasing'], ['/status', 'this session'], ['/usage', 'provider windows and LAIN-observed usage'],
  ['/project', 'the project this session works on'], ['/focus', 'open the IDE on this task'], ['/compact', 'shrink the conversation (no model call)'], ['/help', 'these commands'],
]);

function parse(text) {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return m ? { name: `/${m[1].toLowerCase()}`, arg: (m[2] || '').trim() } : null;
}

function known(text) { const p = parse(text); return Boolean(p && (LIST.some(([n]) => n === p.name) || p.name === '/target')); }

/** RUN one control. Returns { ok, text, navigate? }. */
async function run(app, text, { surface = 'harness' } = {}) {
  const p = parse(text);
  if (!p) return { ok: false, text: 'not a command' };
  const s = app.session;
  const intel = require('./sessionintel');
  const profile = require('./profile');
  const rs = require('./runstrategy');
  const save = () => { try { s.save(); } catch { /* in memory */ } };
  // THE SAME FACTS THE TERMINAL'S /status AND THE WINDOW READ — account first (sessionfacts.js).
  const status = () => {
    const sf = require('./sessionfacts');
    return sf.rows(sf.facts(app)).map(([k, v]) => `${k.replace(/^\w/, (c) => c.toUpperCase())}: ${v}`).join('\n');
  };
  switch (p.name) {
    case '/help': return { ok: true, text: LIST.map(([n, d]) => `${n} — ${d}`).join('\n') };
    case '/status': return { ok: true, text: status() };
    // PHASE 8.3: provider family › model › effort, and the family's account policy — the fabric every surface shares.
    case '/model': {
      const l0 = intel.lane(app, s, 'coding');
      if (!p.arg) return { ok: true, text: `Coding Agent: ${l0.familyLabel || 'no provider'} › ${l0.modelLabel || 'no model'}${l0.effortLabel ? ` · ${l0.effortLabel}` : ''}` };
      const r = await intel.set(app, s, { lane: 'coding', field: 'model', value: p.arg, scope: 'session' });
      save();
      if (!r.ok) return { ok: false, text: r.why };
      const l = intel.lane(app, s, 'coding');
      return { ok: true, text: `Coding Agent: ${l.familyLabel} › ${l.modelLabel}${l.effortLabel ? ` · ${l.effortLabel}` : ''}` };
    }
    case '/account': {
      const l0 = intel.lane(app, s, 'coding');
      const F = require('./fabric/index');
      const fam = F.family(app, l0.family);
      const word = String(p.arg || '').trim().toLowerCase();
      if (!word) {
        if (!fam) return { ok: true, text: 'No provider chosen for the Coding Agent.' };
        return { ok: true, text: [`${fam.label} · ${fam.policyLabel}`, ...fam.accounts.map((a, i) => `${i + 1}. ${a.name}${a.id === l0.account ? ' (current)' : ''}${a.limited ? ' — limited' : ''}${require('./fabric/tray').windowsText(a.quota) ? ` — ${require('./fabric/tray').windowsText(a.quota)}` : ''}`), '/account auto · ask · pin <n>'].join('\n') };
      }
      if (!fam) return { ok: false, text: 'Choose a provider first.' };
      const st = require('./fabric/store');
      if (word === 'auto' || word === 'automatic') { st.setPolicy(fam.id, 'auto'); return { ok: true, text: `${fam.label}: Automatic fallback` }; }
      if (word === 'ask') { st.setPolicy(fam.id, 'ask'); return { ok: true, text: `${fam.label}: Ask before switching` }; }
      const pinWord = word.replace(/^pin\s+/, '');
      const n = Number(pinWord);
      const b = Number.isInteger(n) && n >= 1 && n <= fam.accounts.length ? fam.accounts[n - 1] : fam.accounts.find((a) => a.name.toLowerCase().startsWith(pinWord));
      if (!b) return { ok: false, text: 'No such account — /account lists them.' };
      st.setPolicy(fam.id, 'pinned', b.id);
      if (l0.account !== b.id) intel.switchBacking(app, s, 'coding', b.id);
      save(); return { ok: true, text: `${fam.label}: Use one account only — ${b.name}` };
    }
    case '/effort': {
      const lane = intel.currentLane(s);
      const l0 = intel.lane(app, s, lane);
      if (!p.arg) return { ok: true, text: `Effort: ${l0.effortLabel || 'not configurable'}${l0.effortLabels && l0.effortLabels.length ? ` (${l0.modelLabel} offers ${l0.effortLabels.join(', ')})` : ''}` };
      const r = await intel.choose(app, s, { lane, effort: p.arg.toLowerCase() });
      save(); return r.ok ? { ok: true, text: `Effort: ${r.lane.effortLabel || 'default'}` } : { ok: false, text: r.why };
    }
    case '/fast': case '/eco': case '/normal': {
      const target = p.name.slice(1).toUpperCase();
      const want = profile.toggle(profile.of(s, app.cfg), target, p.arg);
      const r = rs.queueProfile(app, want);
      save(); return r.ok ? { ok: true, text: r.queued ? `${want} queued — it applies at the Agent's next checkpoint` : `Profile: ${profile.of(s, app.cfg)}` } : { ok: false, text: r.why };
    }
    case '/mode': {
      const em = require('./execmode');
      if (!p.arg) return { ok: true, text: `Mode: ${em.of(s)} (auto, manual, plan)` };
      const m = em.set(s, p.arg);
      save(); return { ok: m === p.arg.toUpperCase(), text: `Mode: ${m}` };
    }
    case '/strategy': {
      if (!p.arg) return { ok: true, text: `Strategy: ${rs.LABEL[rs.get(s).kind]}` };
      const r = rs.request(app, p.arg);
      save();
      if (!r.ok) return { ok: false, text: r.why };
      if (r.needsConfirm) return { ok: true, text: `${r.offer.text}\n${r.offer.estimate.text}`, offer: r.offer };
      return { ok: true, text: `Strategy: ${rs.LABEL[rs.get(s).kind]}` };
    }
    case '/usage': {
      const ws = require('./resetwindows').windows(app).filter((w) => w.category !== 'CREDITS');
      if (!ws.length) return { ok: true, text: 'No provider has reported a usage window yet.' };
      const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
      return { ok: true, text: ws.map((w) => `${w.sourceLabel} · ${w.label}: ${w.usedPercent != null ? `${Math.round(100 - w.usedPercent)}% remaining (provider)` : 'provider % not reported'}${w.observed ? ` · Noema observed ${k(w.observed.input)} in / ${k(w.observed.output)} out / ${w.observed.requests} requests` : ''}`).join('\n') };
    }
    case '/project': {
      const proj = require('./sessionviews').project(s);
      return { ok: true, text: proj.attached ? `Project: ${proj.name} — ${proj.root}` : 'Unassigned. Coding requires a project folder — add one in Chat (Add project).' };
    }
    case '/focus': return { ok: true, text: 'Opening the IDE on this task.', navigate: { tab: 'ide' } };
    case '/compact': {
      if (app.abort && !app.abort.signal.aborted) return { ok: false, text: 'a turn is running — compact after it' };
      const pc = require('./provider').resolve(app.cfg);
      const d = s.contextAuthority.compact(pc, app.cfg, { reason: 'manual-compaction' });
      save();
      const r = d.result;
      return { ok: true, text: r && r.compacted ? `Compacted: ${r.beforeMessages} → ${r.afterMessages} messages (no model call).` : 'Nothing to compact.' };
    }
    case '/target': {
      if (surface !== 'telegram') return { ok: false, text: '/target chooses the session a messaging chat drives' };
      return { ok: true, target: p.arg || null, text: null };
    }
    default: return { ok: false, text: `${p.name} is not a Noema control here — /help lists them` };
  }
}

module.exports = { LIST, parse, known, run };
