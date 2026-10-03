'use strict';

/** `/resume` — PICK A SESSION, DO NOT RECITE ITS KEY. */

const { Session } = require('./session');
const sessionIndex = require('./sessionindex');

/** How many sessions the browser reads. A search reads deeper — see below. */
const BROWSE = 25;
const SEARCH = 60;

/** Actually adopt a session, and report what genuinely survived. */
function adopt(app, id, { C }) {
  const s = Session.resume(id);
  if (!s) { app.render.notice('error', `No session "${id}". Nothing was resumed.`); return null; }
  // IT MAY ALREADY BE OPEN IN THE WINDOW
  const hand = app.pool().handover(id);
  if (!hand.ok) { app.render.notice('warn', hand.why); return null; }
  try { app.session.save(); } catch { /* keep the outgoing session's state */ }
  app.adopt(s, { resumedFrom: id });
  // WHAT CAME BACK, checked rather than claimed.
  app.render.write('\n' + C.green('  RESUMING SESSION') + C.dim(`  ${require('path').basename(s.cwd || '')}\n`));
  const continuity = require('./continuity');
  continuity.writeRows(app, continuity.resumeSummary(s, app), { C });
  // THE OTHER VOICES CAME BACK TOO, and the screen is told so — they are part of the task's story and are now saved with it (see session.js).
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return s;
}

/** The text listing, for a pipe and for anyone who prefers reading. */
function writeList(app, list, { C }) {
  if (!list.length) { app.render.write(C.dim('  No saved sessions match.\n')); return; }
  app.render.write('\n');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const mark = s.id === app.session.id ? C.green('  ● ') : '    ';
    app.render.write(`${mark}${String(i + 1).padEnd(3)}${s.when.text.padEnd(18)}${s.project}\n`);
    app.render.write(C.dim(`        ${sessionIndex.headline(s)}\n`));
    const stats = sessionIndex.statsLine(s);
    if (stats) app.render.write(C.dim(`        ${stats}\n`));
  }
  app.render.write(C.dim('\n  /resume <n> to restore one, or /resume <words> to narrow it.\n'));
}

/** The command. */
async function runCommand(app, { args, rest } = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s };
  const query = String(rest || '').trim();

  // AN ID STILL RESOLVES, before anything else and without a search.
  if (query && Session.match(query)) return adopt(app, Session.match(query), { C: col });

  // THIS PROJECT'S SESSIONS, UNLESS ASKED OTHERWISE
  const wantAll = /^all\b/i.test(query);
  const scoped = wantAll ? query.replace(/^all\b\s*/i, '') : query;
  const deep = Boolean(scoped) && scoped !== 'recent';
  const all = sessionIndex.summaries({
    limit: deep ? SEARCH : BROWSE,
    exclude: app.session.id,
    cwd: app.cwd,
    scope: wantAll ? 'all' : 'project',
  });
  const list = sessionIndex.search(all, scoped);

  // A BARE NUMBER IS THE ROW YOU JUST LOOKED AT.
  if (/^\d+$/.test(query)) {
    const n = Number(query);
    const row = all[n - 1];
    if (!row) { app.render.write(col.yellow(`  There is no session ${n}.`) + col.dim(' /resume to see the list.\n')); return null; }
    return adopt(app, row.id, { C: col });
  }

  if (!list.length) {
    app.render.write(query
      ? col.yellow(`  No session matches "${query}".`) + col.dim(' /resume to see them all.\n')
      : col.dim('  No saved sessions yet.\n'));
    return null;
  }

  // OFF A TTY there is no browser to open, so the listing is the answer. It is
  // the same data, and it still names sessions by what they were.
  if (!app.ui || !app.ui.enabled) { writeList(app, list, { C: col }); return null; }

  // THE RESUME SHELF (ui/shelf.js): recent sessions as choices, one action.
  const { shelf } = require('./ui/shelf');
  const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  let cursor = 0;
  for (;;) {
    const picked = await app.ui.ask(shelf({
      title: query ? `Resume session · matching "${query}"` : 'Resume session',
      choices: list.map((s) => ({ label: `${clip(s.project, 18)} · ${clip(sessionIndex.headline(s), 56)}`, value: s.id, detail: s.when && s.when.text })),
      cursor,
      actions: [{ label: 'Continue', value: 'continue' }, { label: 'Details', value: 'details' }],
      footer: '↑↓ choose · ←→ action · Enter · Esc close',
    }));
    if (app.input) app.input.setLine('');
    if (!picked || !picked.choice) return null;
    if (picked.action === 'details') {
      // READ-ONLY: what the session was, then back to the same row of the list.
      cursor = Math.max(0, list.findIndex((s) => s.id === picked.choice));
      await app.ui.ask(require('./ui/pickers').sessionDetailsAdapter({ session: list[cursor] }));
      continue;
    }
    return adopt(app, picked.choice, { C: col });
  }
}

/** `/sessions` — the same descriptions, without ever resuming one. */
function listCommand(app, { rest } = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s };
  // SAME SCOPE AS /resume. A listing that shows sessions you cannot safely
  // resume from here would be an invitation to do exactly that.
  const q = String(rest || '').trim();
  const wantAll = /^all\b/i.test(q);
  const all = sessionIndex.summaries({
    limit: BROWSE,
    cwd: app.cwd,
    scope: wantAll ? 'all' : 'project',
  });
  const list = sessionIndex.search(all, wantAll ? q.replace(/^all\b\s*/i, '') : q);
  writeList(app, list, { C: col });
}

module.exports = { runCommand, listCommand, adopt, writeList, BROWSE, SEARCH };
