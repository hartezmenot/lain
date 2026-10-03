'use strict';

/** `/mcp computer` — connect Computer MCP, and authorize it for this session. */

async function run(app, args, { C }) {
  const computer = require('./computermcp').forApp(app);
  const w = (s) => app.render.write(s);
  const how = String(args[0] || '').toLowerCase();

  if (how === 'off' || how === 'disconnect' || how === 'stop') {
    const r = computer.disconnect('you disconnected it');
    w('  ' + C.green('✓ DISCONNECTED') + C.dim(r.wasAuthorized ? ' — the authorization is gone with it\n' : '\n'));
    return;
  }

  if (how === 'status') {
    const s = computer.status();
    w('\n' + C.bold('COMPUTER MCP') + '\n');
    w('  ' + 'Connected'.padEnd(16) + (s.connected ? C.green('✓ yes') : C.dim('— no')) + '\n');
    w('  ' + 'Authorized'.padEnd(16) + (s.authorized ? C.green('✓ this session') : C.dim('— no')) + '\n');
    if (s.why) w('  ' + 'Why'.padEnd(16) + C.dim(s.why) + '\n');
    if (s.capabilities.length) w('  ' + 'Operations'.padEnd(16) + C.dim(String(s.capabilities.length)) + '\n');
    if (!s.available) w('  ' + 'Platform'.padEnd(16) + C.dim(`${s.platform} — Computer MCP V1 is Windows UI Automation`) + '\n');
    for (const step of s.steps.slice(-6)) w(C.dim(`    ${step.verdict ? `${step.verdict} · ` : ''}${step.text}\n`));
    return;
  }

  w(C.dim('  building and starting the desktop bridge…\n'));
  const r = await computer.connect();
  if (!r.ok) { w('  ' + C.red('✕ ' + (r.why || 'it did not start')) + '\n'); return; }
  if (!r.authorized) {
    w('  ' + C.yellow('⚠ NOT AUTHORIZED') + C.dim(` — ${r.why || 'the computer was not authorized'}\n`));
    return;
  }
  // COMPUTER CONTROL ON (computercontrol.js) — `/mcp computer` is the older door to the same switch.
  try { await require('./computercontrol').enable(app, { tier: 'INTERACT', by: 'cli', ask: false }); } catch { /* reported by /computer status */ }
  w('  ' + C.green('✓ COMPUTER MCP')
    + C.dim(`  ${r.reused ? 'already authorized' : 'authorized for this session'} · ${(r.capabilities || []).length} operations\n`));
  w(C.dim('    It sees windows and their controls, and can press and type into them.\n'));
  w(C.dim('    /mcp computer off ends it. Changing session ends it. Closing LAIN ends it.\n'));
}

module.exports = { run };
