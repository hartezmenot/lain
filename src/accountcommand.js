'use strict';

/**
 * `/account` — THE PROVIDER'S BACKING ACCOUNTS AND ITS ACCOUNT POLICY (Phase 8.3).
 * The same Core the window uses — the intelligence fabric (fabric/index.js,
 * fabric/store.js) and sessionintel — so a change here is on the window, the
 * tray and Telegram at once. There is no CLI-only account system.
 *
 *   /account                 the current lane's provider: its policy and its
 *                            backing accounts, numbered, with reported quota
 *   /account all             every provider family
 *   /account <provider> …    the same verbs for another provider ("/account codex pin 2")
 *   /account automatic       Automatic fallback — the next eligible account on a limit
 *   /account ask             Ask before switching
 *   /account pin <n|name>    Use one account only — never switched without asking
 *   /account reorder 2,1,3   the fallback priority
 *   /account rename <n> <alias>   a display name; the identity is never changed
 *   /account use <name>      a specific backing account for this lane
 *   /account add | manage    open the Model Dashboard (sign-ins happen there — never here)
 *   /account refresh [name]  ask the runtimes again for their reported windows
 */

/** The lane the terminal's next turn runs on — the session's current view. */
function laneOf(app) { try { return require('./sessionviews').current(app.session) === 'chat' ? 'chat' : 'coding'; } catch { return 'coding'; } }

/** An account by id, exact name, or the start of a name. */
function pickAccount(app, word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  const all = require('./accountcatalog').list(app).accounts;
  return all.find((a) => a.id.toLowerCase() === w) || all.find((a) => a.name.toLowerCase() === w)
    || all.find((a) => a.name.toLowerCase().startsWith(w)) || all.find((a) => `${a.familyLabel} ${a.name}`.toLowerCase().includes(w)) || null;
}


function pickInstance(app, word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  const rows = require('./accountinstances').list(app);
  return rows.find((r) => r.id.toLowerCase() === w) || rows.find((r) => String(r.display_name).toLowerCase() === w)
    || rows.find((r) => String(r.display_name).toLowerCase().startsWith(w)) || null;
}

function limitsLine(v) {
  if (!v.limits || !(v.limits.windows || []).length) return v.limits_error ? `limits: ${v.limits_error}` : 'limits: not reported';
  return v.limits.windows.map((w) => `${w.label} ${w.expired ? 'reset (awaiting refresh)' : `${w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent)}% remaining`}`).join(' · ');
}

function register({ define }) {
  define('/account', {
    surface: true,
    args: '[<provider>|all|automatic|ask|pin <n|name>|reorder <n,n,…>|rename <n|name> <alias>|use <name>|add|manage|refresh [name]]',
    desc: 'The provider\'s backing accounts and how LAIN uses them (policy) — sign-ins happen in the Model Dashboard',
    async run(app, { rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const words = String(rest).trim().split(/\s+/).filter(Boolean);
      const verb = (words[0] || 'list').toLowerCase();
      const more = words.slice(1);
      const ai = require('./accountinstances');
      const F = require('./fabric/index');
      const store = require('./fabric/store');
      const si = require('./sessionintel');
      const lane = si.lane(app, app.session, laneOf(app));
      // THE FAMILY A VERB IS ABOUT: the lane's, or one named first ("/account codex pin 2").
      const famNamed = (word) => { const x = String(word || '').toLowerCase(); return x ? F.families(app).find((f) => f.id === x || f.label.toLowerCase() === x || f.label.toLowerCase().startsWith(x)) || null : null; };
      let fam = F.family(app, lane.family);
      let args = more;
      const named = famNamed(verb);
      if (named && !['all', 'list', 'add', 'manage', 'use', 'refresh'].includes(verb)) { fam = named; const v2 = (more[0] || 'list').toLowerCase(); return runFor(v2, more.slice(1)); }
      return runFor(verb, args);

      // eslint-disable-next-line no-shadow -- the verb, once its family is known
      async function runFor(v, a) {
        if (v === 'list' || v === 'all') return list(v === 'all');
        if (v === 'add' || v === 'manage') {
          // SIGN-INS AND KEYS ARE ENTERED IN THE MODEL DASHBOARD — never here, never in a conversation.
          const dl = require('./fabric/dashlaunch');
          const since = Date.now();
          const r = await dl.open(app, 'accounts');
          w(`  ${dl.said(r, 'Accounts')}${r.ok ? ' Sign in there.' : ''}\n`);
          w('  Keys and sign-ins are entered in the dashboard — never in the terminal, never in a conversation.\n');
          if (r.ok) dl.watch(since, (e) => { const t = dl.describe(e); if (app.ui && app.ui.enabled) app.ui.noteActor('note', t); else w(`  ${t}\n`); });
          return undefined;
        }
        if (v === 'use') {
          // A SPECIFIC BACKING ACCOUNT for this lane (the family follows it). Under "Use one account only" it is the pin.
          const acct = pickAccount(app, a.join(' '));
          if (!acct) { w('  No such account. /account lists them.\n'); return undefined; }
          const r = await si.choose(app, app.session, { lane: laneOf(app), account: acct.id });
          if (!r.ok) { w(`  ${r.why}\n`); return undefined; }
          save(app);
          w(`  ${r.lane.lane === 'chat' ? 'Chat' : 'Coding'}: ${r.lane.familyLabel || r.lane.accountLabel}${r.lane.modelLabel ? ` › ${r.lane.modelLabel}` : ''} — on ${r.lane.accountLabel}.\n`);
          if (r.needsModel) w('  Choose a model: /model\n');
          return undefined;
        }
        if (v === 'refresh') {
          const inst = a.length ? pickInstance(app, a.join(' ')) : null;
          if (a.length && !inst) { w('  No such account. /account lists them.\n'); return undefined; }
          if (inst) { const r = await ai.refresh(app, inst.id); w(r.ok ? `  ${inst.display_name}: ${r.instance.authentication_state} · ${limitsLine(r.instance)}\n` : `  ${r.why}\n`); }
          else { const r = await require('./harnessapp/fabricintelroutes').ROUTES['POST /api/intel/refresh'](app, { family: fam ? fam.id : null }); w(`  Refreshed: ${(r.body.refreshed || []).join(', ') || 'nothing to ask'}\n`); }
          return undefined;
        }
        if (!fam) { w('  Choose a provider first (/model), or name one: /account codex …\n'); return undefined; }
        if (v === 'automatic' || v === 'auto') return policy('auto');
        if (v === 'ask') return policy('ask');
        if (v === 'pin' || v === 'one' || v === 'pinned') {
          const b = pickBacking(fam, a.join(' ')) || (lane.family === fam.id ? fam.accounts.find((x) => x.id === lane.account) : null) || fam.accounts[0];
          if (!b) { w(`  ${fam.label} has no account to pin.\n`); return undefined; }
          return policy('pinned', b.id);
        }
        if (v === 'reorder') {
          const idx = a.join(',').split(/[,\s]+/).filter(Boolean).map((n) => Number(n) - 1);
          if (!idx.length || idx.some((n) => !Number.isInteger(n) || n < 0 || n >= fam.accounts.length)) { w(`  /account reorder <n,n,…> — numbers from /account (1-${fam.accounts.length})\n`); return undefined; }
          const order = [...new Set(idx.map((n) => fam.accounts[n].id))];
          for (const x of fam.accounts) if (!order.includes(x.id)) order.push(x.id);
          store.setOrder(fam.id, order);
          w(`  ${fam.label} fallback order: ${order.map((id) => fam.accounts.find((x) => x.id === id).name).join(' → ')}\n`);
          return undefined;
        }
        if (v === 'rename') {
          const b = pickBacking(fam, a[0]);
          if (!b || a.length < 2) { w('  /account rename <n|name> <alias>\n'); return undefined; }
          store.setAlias(b.id, a.slice(1).join(' '));
          w(`  ${b.providerName} is now shown as "${a.slice(1).join(' ')}" (its identity is unchanged).\n`);
          return undefined;
        }
        w(`  ${USAGE}\n`);
        return undefined;
      }

      function policy(p, pinned) {
        const r = store.setPolicy(fam.id, p, pinned);
        if (!r.ok) { w(`  ${r.why}\n`); return undefined; }
        if (p === 'pinned') { for (const L of ['chat', 'coding']) { const l = si.lane(app, app.session, L); if (l.family === fam.id && l.account !== pinned) si.switchBacking(app, app.session, L, pinned); } save(app); }
        try { require('./fabric/tray').changed(app); } catch { /* presentation only */ }
        const name = pinned ? (fam.accounts.find((x) => x.id === pinned) || {}).name : '';
        w(`  ${fam.label}: ${store.POLICY_LABEL[p]}${name ? ` — ${name}` : ''}\n`);
        return undefined;
      }

      function list(all) {
        const fams = all ? F.families(app).filter((f) => f.accounts.length || f.setup.length) : (fam ? [fam] : F.families(app).filter((f) => f.kind !== 'api' && (f.accounts.length || f.setup.length)));
        if (!fams.length) { w('  No accounts yet. /account add opens the Model Dashboard.\n'); return undefined; }
        for (const f of fams) {
          w(`\n  ${f.label}\n`);
          w(`  Policy: ${f.policyLabel}${f.pinned ? ` — ${(f.accounts.find((x) => x.id === f.pinned) || {}).name || f.pinned}` : ''}\n`);
          if (f.accounts.length) w('  Backing accounts:\n');
          f.accounts.forEach((b, i) => {
            const mark = lane.family === f.id && lane.account === b.id ? '◀' : ' ';
            const who = b.identity && b.identity.email && b.name !== b.identity.email ? `  ${b.identity.email}` : '';
            const q = require('./fabric/tray').windowsText(b.quota);
            w(`   ${mark} ${String(i + 1).padStart(2)}. ${b.name.padEnd(22)} ${b.limited ? 'Limited' : b.stateLabel}${q ? `  ·  ${q}` : ''}${who}\n`);
            if (!b.usable && b.why) w(`        ${b.why}\n`);
          });
          if (f.setup.length) w('  Finish setup (not used until signed in):\n');
          for (const p of f.setup) w(`     •  ${p.name.padEnd(22)} ${p.state === 'UNSUPPORTED' ? 'no LAIN sign-in for this provider yet' : p.lifecycle === 'IMPORTED_PENDING_AUTH' ? 'imported — sign in to finish' : p.lifecycle === 'DISCONNECTED' ? 'signed out — sign in again' : 'needs attention'}\n`);
        }
        w(`\n  ${USAGE}\n`);
        return undefined;
      }
    },
  });
}

const USAGE = '/account automatic · ask · pin <n> · reorder <n,n,…> · rename <n> <alias> · add (opens the Model Dashboard)';

function save(app) { try { app.session.save(); } catch { /* saved with the next turn */ } if (app.ui && app.ui.enabled) app.ui.refresh(); }

/** A backing account of a family by its number in /account, its alias, or the start of its name. */
function pickBacking(fam, word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  const n = Number(w);
  if (Number.isInteger(n) && n >= 1 && n <= fam.accounts.length) return fam.accounts[n - 1];
  return fam.accounts.find((a) => a.id.toLowerCase() === w) || fam.accounts.find((a) => a.name.toLowerCase() === w)
    || fam.accounts.find((a) => a.name.toLowerCase().startsWith(w)) || fam.accounts.find((a) => (a.identity && a.identity.email || '').toLowerCase().startsWith(w)) || null;
}

/**
 * `/usage [today|7d|30d|all] [by <dim>]` — consumption from the receipts;
 * `/usage limits` — every account's provider windows, one row per window.
 * The same owners the USAGE tab reads (usage.js, usageroutes.limits).
 */
function registerUsage({ define }) {
  define('/usage', {
    surface: true,
    args: '[today|7d|30d|all] [by model|account|project|session|provider|role|day] | limits',
    desc: 'What was used, and each account’s provider limits',
    run(app, { rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const words = String(rest).trim().split(/\s+/).filter(Boolean);
      if (words[0] === 'limits') {
        const { accounts } = require('./harnessapp/usageroutes').limits(app);
        if (!accounts.length) { w('  No accounts. /account add\n'); return; }
        for (const a of accounts) {
          w(`  ${a.name}  ·  ${a.provider || a.driver}${a.identity && a.identity.planType ? ` (${a.identity.planType})` : ''}\n`);
          if (!a.windows.length) { w(`      ${a.notReported}\n`); continue; }
          for (const x of a.windows) {
            const left = x.resetsAt ? x.resetsAt - Date.now() : null;
            w(`      ${x.label.padEnd(8)} ${x.expired || (left != null && left <= 0) ? 'reset expected — not confirmed until refreshed' : `${x.usedPercent == null ? '?' : Math.round(100 - x.usedPercent)}% remaining`}${left > 0 ? `  · resets in ${Math.ceil(left / 60000)}m` : ''}\n`);
          }
        }
        w('  Each window is the provider’s own figure; windows are never combined.\n');
        return;
      }
      const usage = require('./usage');
      const RANGES = { today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, '7d': () => Date.now() - 7 * 864e5, '30d': () => Date.now() - 30 * 864e5, all: () => 0 };
      const range = RANGES[words[0]] ? words[0] : '7d';
      const byAt = words.indexOf('by');
      const by = byAt >= 0 && usage.DIMS.includes(words[byAt + 1]) ? words[byAt + 1] : 'model';
      const rows = usage.read({ from: RANGES[range]() });
      const t = usage.sum(rows, app.cfg);
      w(`  ${range}: ${t.requests} request(s) · in ${t.input.toLocaleString()} · out ${t.output.toLocaleString()} · cache read ${t.cacheRead.toLocaleString()}${t.reported.tokens < t.requests ? ` · ${t.requests - t.reported.tokens} without a usage report` : ''}\n`);
      for (const g of usage.aggregate(rows, by, app.cfg).slice(0, 12)) {
        w(`    ${String(g.key).slice(0, 40).padEnd(40)} ${String(g.requests).padStart(5)} req  in ${g.input.toLocaleString()}  out ${g.output.toLocaleString()}${g.cost.actualRows ? `  $${g.cost.actualUsd} (provider)` : g.cost.estimatedRows ? `  ~$${g.cost.estimatedUsd} (Estimated)` : ''}\n`);
      }
    },
  });
}

/**
 * `/channel [status|test|restart|disconnect]` — botconnect.js, the one channel owner.
 * `/extensions [list|found]` — extensions.js / extpackages.js.
 * No state of their own; the window's Bot and Extensions views read the same.
 */
function registerChannels({ define }) {
  define('/channel', {
    surface: true,
    args: '[status|test|restart|disconnect]',
    desc: 'Messaging channels — where a message stopped, send a test, restart, disconnect',
    async run(app, { rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      const bc = require('./botconnect');
      const verb = String(rest).trim().split(/\s+/)[0] || 'status';
      if (verb === 'test') { const r = await bc.sendTest(app, {}); w(r.ok ? `  Test delivered · receipt ${r.receipt}\n` : `  ${r.why}\n`); return; }
      if (verb === 'restart') { await bc.stopService(app); const r = await bc.startService(app); w(r.ok ? '  Messaging restarted.\n' : `  ${r.why}\n`); return; }
      if (verb === 'disconnect') {
        const r = await bc.disconnectTelegram(app);
        w(r.ok ? `  Telegram disconnected: polling stopped, LAIN's credential removed, approvals cleared.\n  ${r.notRevoked}\n` : `  ${r.why}\n`);
        return;
      }
      const t = await bc.telegram(app);
      const d = t.diagnostics || {};
      w(`  Telegram: ${t.status} — ${t.summary}\n`);
      if (d.identity) w(`    bot @${d.identity.username || d.identity.name || '?'}\n`);
      const rc = (k, r) => { if (r) w(`    ${k.padEnd(16)} ${new Date(r.at).toLocaleTimeString()} ${r.ok ? 'ok' : `✗ ${r.why || ''}`} ${r.rid || ''}\n`); };
      rc('last inbound', d.lastInbound); rc('last authorize', d.lastAuthorize); rc('last dispatch', d.lastDispatch);
      rc('last model', d.lastModel); rc('last outbound', d.lastOutbound);
      if (d.lastMessage && d.lastMessage.stoppedAt) w(`    last message stopped at ${d.lastMessage.stoppedAt.stage}: ${d.lastMessage.stoppedAt.why || ''}\n`);
    },
  });
  define('/extensions', {
    surface: true,
    args: '[list|found]',
    desc: 'Extensions in LAIN, and the ones VS Code / Cursor have',
    run(app, { rest = '' } = {}) {
      const w = (s) => app.render.write(s);
      if (String(rest).trim() === 'found') {
        const rows = require('./extpackages').discover();
        if (!rows.length) { w('  No VS Code or Cursor extensions found.\n'); return; }
        for (const f of rows) w(`  ${f.productLabel.padEnd(8)} ${f.id} ${f.version} — ${f.compatibility.level}${f.reused ? ` (in LAIN ${f.reused.version})` : ''}\n`);
        w('  Use one from Settings › Extensions › On this machine. Their folders are never changed.\n');
        return;
      }
      const rows = require('./extensions').list({ project: app.session && app.session.cwd });
      if (!rows.length) { w('  No extensions installed. /extensions found lists VS Code / Cursor ones.\n'); return; }
      for (const e of rows) w(`  ${e.id} ${e.version} · ${e.scope}${e.enabled ? '' : ' · disabled'} · from ${(e.source && e.source.kind) || '?'}\n`);
    },
  });
}

module.exports = { register, registerUsage, registerChannels, pickInstance, limitsLine };
