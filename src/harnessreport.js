'use strict';

/** THE DOCTOR, RENDERED — one report, read by `lain --doctor` and by `/harness doctor` alike. */

/** Marks are ASCII-plus-one-symbol so they survive every terminal codepage. */
const MARK = Object.freeze({
  AVAILABLE: '✓',      // ✓
  UNAVAILABLE: '○',    // ○
  MISCONFIGURED: '✗',  // ✗
});

function markFor(row) {
  if (row.state === 'AVAILABLE') return MARK.AVAILABLE;
  // A CORE capability that is not available is broken, whatever its state says.
  if (row.kind === 'core') return MARK.MISCONFIGURED;
  return MARK[row.state] || MARK.UNAVAILABLE;
}

function render(rows, summary) {
  const lines = ['', 'LAIN Harness', ''];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push(group);
    }
    lines.push(`  ${markFor(r)} ${String(r.name).padEnd(20)}${r.why || ''}`);
  }
  lines.push('');
  if (summary) {
    lines.push(summary.ok ? '  Core is available.' : `  CORE PROBLEM: ${summary.why}`);
    if (summary.unavailable && summary.unavailable.length) {
      // SAID PLAINLY, because the alternative reading — that something is
      // wrong — is the one people reach for when they see a list.
      lines.push(`  Optional and not present: ${summary.unavailable.join(', ')}.`
        + ' These are not errors; the capabilities that need them report INCONCLUSIVE.');
    }
    if (summary.misconfigured && summary.misconfigured.length) {
      lines.push(`  Configured and not working: ${summary.misconfigured.join(', ')}.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { render, MARK, markFor };
