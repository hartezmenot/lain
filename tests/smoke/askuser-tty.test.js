'use strict';

/**
 * THE QUESTION IS SHOWN IN FULL (Part B) — `ask_user` in a real terminal (ConPTY / pty) at 80×24, 120×30 and 200×50:
 * one line, ten lines, a very long question, an unbroken URL, wide characters, ANSI and markdown, with 2, 4 and 8
 * long options, and a resize while it is open. The screen is read across PgUp/PgDn; the whole question must be on it,
 * every option reachable, and a question taller than the panel must say there is more.
 */

const assert = require('assert');
const { test } = require('../helpers');
const tty = require('../tty/realtty');

const LONG = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}w${i}`).join(' ');
const Q = [
  { id: 'Q1', text: 'Q1 Which database should the new ledger service use in production? END1' },
  { id: 'Q2', text: Array.from({ length: 10 }, (_, i) => `Q2 line ${i + 1} of a ten-line question about the migration plan${i === 9 ? ' END2' : ''}`).join('\n') },
  { id: 'Q3', text: `Q3 ${LONG(220, 'long')} END3` },
  { id: 'Q4', text: 'Q4 Is this the right endpoint https://example.com/api/v2/accounts/settlements/reconciliation/batches/2026-10-06/items?cursor=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 or another one END4' },
  { id: 'Q5', text: 'Q5 选择哪个数据库用于新的账本服务？请比较迁移成本和运维风险。🚀✨ データベースの移行計画を確認してください END5' },
  { id: 'Q6', text: 'Q6 \u001b[31mred warning\u001b[0m with **bold**, `inline code` and _emphasis_ in the question END6' },
];
const OPT = (n, id) => Array.from({ length: n }, (_, i) => `${id} option ${i + 1}: a deliberately long label that explains the trade-off of choice ${i + 1} OEND${i + 1}`);
const COUNTS = [2, 4, 8];
const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const squash = (s) => plain(s).replace(/\s+/g, '');

function script(qs) {
  return [
    ...qs.map((q) => ({ text: '', tool_calls: [{ name: 'ask_user', input: { question: q.text, options: q.options } }] })),
    { text: 'ALL ASKED' },
  ];
}
/** Steps for one question: wait for it, read it, page up and down through it, walk the options, answer it. */
function look(q, n) {
  const s = [{ until: `${q.id}|END${q.id.slice(1)}`, timeout: 30000 }, { snap: `${q.id}-0`, settle: 500 }];
  for (let i = 1; i <= n; i++) s.push({ key: 'pageup' }, { snap: `${q.id}-u${i}`, settle: 200 });
  for (let i = 1; i <= 2 * n; i++) s.push({ key: 'pagedown' }, { snap: `${q.id}-d${i}`, settle: 200 });
  const k = q.options.length + 1;            // the options and "Other…": every one must be reachable with ↓
  for (let i = 1; i <= k; i++) s.push({ key: 'down' }, { snap: `${q.id}-o${i}`, settle: 150 });
  for (let i = 1; i <= k; i++) s.push({ key: 'up' });
  s.push({ wait: 300 }, { key: 'enter' }, { wait: 600 });   // the first option answers it (Esc opens a long option's details; "Other…" asks for text)
  return s;
}
/** Everything the screen showed for one question, across its pages. */
function seen(run, id) { return run.snaps.filter((s) => s.name.startsWith(`${id}-`)).map((s) => s.text.join('\n')).join('\n'); }

module.exports = async function () {
  const probe = tty.available();
  if (!probe.ok) { await test(`ASK TTY: not run — ${probe.why}`, () => assert.ok(true)); return; }

  for (const [cols, rows] of [[80, 24], [120, 30], [200, 50]]) {
    const qs = Q.map((q, i) => ({ ...q, options: OPT(COUNTS[i % 3], q.id) }));
    const run = await tty.runTty({ cols, rows, script: script(qs), timeoutMs: 300000, steps: [{ until: 'Ask LAIN', timeout: 30000 }, { send: 'ask me\r' }, ...qs.flatMap((q) => look(q, rows < 30 ? 8 : 4))] });
    for (const q of qs) {
      await test(`ASK TTY ${cols}×${rows} ${q.id} (${q.options.length} options): the whole question and every option are on screen`, () => {
        const all = seen(run, q.id);
        assert.ok(all, `the question was never shown (timeouts: ${run.timeouts.join(' | ')})`);
        // On one screen, or — a question taller than the panel — word by word across the pages PgUp/PgDn showed.
        const onScreen = new Set(plain(all).split(/\s+/));
        const whole = squash(all).includes(squash(q.text)) || plain(q.text).split(/\s+/).filter(Boolean).every((w) => onScreen.has(w));
        assert.ok(whole, `the question is cut:\n--- expected ---\n${plain(q.text)}\n--- first screen ---\n${(run.snaps.find((s) => s.name === `${q.id}-0`) || { text: [] }).text.join('\n')}`);
        // A LONG OPTION is a row (its first words) with the rest behind Esc — reachable, by design (two levels).
        for (const o of q.options) assert.ok(squash(all).includes(squash(o.slice(0, 40))), `an option is not reachable: ${o}`);
      });
    }
    await test(`ASK TTY ${cols}×${rows}: a question taller than the panel says there is more, and is never cut silently`, () => {
      const first = (run.snaps.find((s) => s.name === 'Q3-0') || { text: [] }).text.join('\n');
      const whole = squash(first).includes(squash(Q[2].text));
      assert.ok(whole || /more above|more below|▲|▼/i.test(first), `Q3 is partly hidden with no marker:\n${first}`);
      // The panel's rows only: the transcript's one-line echo of the call and the live activity row are summaries.
      const panel = first.split('\n').slice(first.split('\n').findIndex((l) => /needs your input/i.test(l)));
      assert.ok(!/…/.test(panel.filter((l) => /longw/.test(l)).join('\n')), `a question line in the panel is cut with an ellipsis:\n${panel.join('\n')}`);
    });
  }

  // A RESIZE WHILE THE QUESTION IS OPEN: smaller, then larger — the question comes back in full.
  const q = { ...Q[1], options: OPT(4, 'Q2') };
  const rz = await tty.runTty({ cols: 80, rows: 24, script: script([q]), timeoutMs: 120000, steps: [
    { until: 'Ask LAIN', timeout: 30000 }, { send: 'ask me\r' }, { until: 'Q2|END2', timeout: 30000 }, { snap: 'small', settle: 400 },
    { resize: [60, 18] }, { snap: 'smaller', settle: 600 },
    { resize: [200, 50] }, { snap: 'large', settle: 800 },
    { key: 'escape' }, { wait: 500 },
  ] });
  await test('ASK TTY RESIZE: after the window grows, the question and its options are shown in full again', () => {
    const large = rz.byName.large ? rz.byName.large.text.join('\n') : '';
    assert.ok(squash(large).includes(squash(q.text)), `cut after enlarging:\n${large}`);
    for (const o of q.options) assert.ok(squash(large).includes(squash(o.slice(0, 40))), `option not shown after enlarging: ${o}`);
  });
};
