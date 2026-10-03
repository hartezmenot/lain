'use strict';

/** ADAPTERS FOR THE SESSION PICKERS. */

const { KIND, MODE, pad, clip } = require('./panel');


/** `/resume` — SESSIONS DESCRIBED BY WHAT THEY WERE. */
function sessionListAdapter({ sessions = [], title = 'RESUME SESSION', current = null }) {
  const idx = require('../sessionindex');
  const items = [];
  let group = null;
  sessions.forEach((s, i) => {
    if (s.when.group !== group) {
      group = s.when.group;
      if (i) items.push({ label: '', selectable: false });
    }
    items.push({
      label: `${current && s.id === current ? '● ' : '  '}${pad(String(i + 1), 3)}${pad(s.when.text, 18)}${clip(s.project, 28)}`,
      value: s.id,
      session: s,
    });
    items.push({ label: `        ${clip(idx.headline(s), 66)}`, selectable: false });
    const stats = idx.statsLine(s);
    if (stats) items.push({ label: `        ${clip(stats, 66)}`, selectable: false });
  });
  if (!items.length) items.push({ label: 'no saved sessions match', selectable: false });

  return {
    title: `${title}   ${sessions.length}`,
    kind: KIND.FILE_PICKER,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter resume · D details · Esc cancel',
    /** A single typed letter, routed by the panel. Enter resumes; D looks first. */
    shortcuts: {
      d(item) {
        if (!item || !item.session) return undefined;
        return { push: sessionDetailsAdapter({ session: item.session }) };
      },
    },
    onSelect(item) {
      if (!item.session) return undefined;
      return { close: item.session.id };
    },
  };
}

/** ONE SESSION, BEFORE COMMITTING TO IT. */
function sessionDetailsAdapter({ session: s }) {
  const row = (k, v) => ({ label: `  ${pad(k, 16)}${clip(String(v), 56)}`, selectable: false });
  const para = (head, text) => {
    const out = [{ label: '', selectable: false }, { label: `  ${head}`, selectable: false }];
    if (!text) { out.push({ label: '    (none recorded)', selectable: false }); return out; }
    const words = String(text).replace(/\s+/g, ' ').trim();
    for (let i = 0; i < words.length && i < 306; i += 68) {
      out.push({ label: `    ${words.slice(i, i + 68)}`, selectable: false });
    }
    return out;
  };

  return {
    title: `SESSION DETAILS   ${s.project}`,
    kind: KIND.FILE_PICKER,
    mode: MODE.EXPANDED,
    items: [
      row('project', s.project),
      row('path', s.cwd || '(unknown)'),
      // BOTH TIMES IN THE SAME CLOCK.
      row('started', s.startedAt ? require('../sessionindex').when(Date.parse(s.startedAt)).text : '(unknown)'),
      row('last activity', s.when.text),
      row('status', s.state || 'no lifecycle recorded'),
      ...para('ORIGINAL TASK', s.objective),
      ...para('LAST LAIN MESSAGE', s.lastLain),
      ...para('LAST EXTERNAL REVIEW', s.lastExternal),
      { label: '', selectable: false },
      row('turns', s.turns),
      row('files changed', s.filesChanged),
      row('corrections', s.steers),
      row('plan', s.planTotal ? `${s.planDone}/${s.planTotal} steps done` : 'no plan in this session'),
      row('last check', s.lastCommand
        ? `${s.lastCommand.command} — ${s.lastCommand.ok ? 'passed' : 'FAILED'}`
        : 'nothing was run, so nothing is verified'),
      { label: '', selectable: false },
      { label: '  resume this session', value: s.id, resume: true },
    ],
    footer: 'Enter resume · ← back · Esc close',
    onSelect(item) { return item.resume ? { close: item.value } : undefined; },
  };
}

module.exports = { sessionListAdapter, sessionDetailsAdapter };
