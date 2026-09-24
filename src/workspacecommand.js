'use strict';

/**
 * `/workspaces` — what temporary workspaces exist and why each is still there
 * (tempworkspaces.js). Diagnostic, never shown during normal work.
 *
 *   /workspaces              every workspace not yet deleted, its state, and
 *                            the conditions still missing for its cleanup
 *   /workspaces clean <id>   the PERSON removes a RETAINED one (failed,
 *                            blocked, conflicted, orphaned) or a rejected one
 *                            — receipt first, path guard still applies
 *   /workspaces reconcile    classify everything now (what startup does)
 *
 * No tool reaches any of this: a model cannot name a directory to delete.
 */

function run(app, args, { C }) {
  const tw = require('./tempworkspaces');
  const w = (s) => app.render.write(s);
  const a = String(args[0] || '').toLowerCase();
  if (a === 'clean') {
    const r = tw.purge(String(args[1] || ''), app);
    w(r.ok ? C.dim(`  removed ${args[1]} · receipt kept\n`) : C.dim(`  not removed: ${r.why.join('; ')}\n`));
    return;
  }
  if (a === 'reconcile') {
    const r = tw.reconcile(app);
    for (const [k, v] of Object.entries(r)) if (v.length) w(C.dim(`  ${k.padEnd(12)} ${v.length} · ${v.slice(0, 4).join(', ')}\n`));
    return;
  }
  const live = tw.all().filter((r) => r.state !== tw.STATE.DELETED);
  w('\n' + C.bold('Temporary workspaces') + C.dim(`  ${tw.tempRoot()}\n`));
  if (!live.length) { w(C.dim('  none — every workspace has been resolved and removed\n')); return; }
  for (const r of live) {
    const retained = tw.RETAINED.has(r.state);
    w(`  ${r.id.padEnd(16)} ${r.state.padEnd(18)} ${(r.label || r.kind).padEnd(12)} ${retained ? 'TEMP RETAINED · failure evidence' : ''}\n`);
    if (!retained) w(C.dim(`                   waiting for: ${tw.eligibility(r, app).why.join('; ') || 'nothing — cleaned at the next sweep'}\n`));
    else w(C.dim(`                   ${r.dir}\n`));
  }
}

module.exports = { run };
