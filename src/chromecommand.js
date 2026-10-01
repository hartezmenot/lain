'use strict';

/**
 * `/chrome` — connect, inspect and disconnect LAIN for Chrome.
 *
 * Its own file for the same reason computercommand.js is: commands.js is a
 * REGISTRY, and this is a subsystem's surface. The capability itself is
 * src/lainchrome.js; nothing here decides anything.
 */

async function run(app, args, { C }) {
  const bridge = require('./lainchrome').forApp(app);
  const w = (s) => app.render.write(s);
  const how = String(args[0] || 'status').toLowerCase();

  if (how === 'off' || how === 'disconnect' || how === 'stop') {
    await bridge.disconnect('you disconnected it');
    w('  ' + C.green('✓ DISCONNECTED') + C.dim(' — the extension\'s next request is refused until reconnected\n'));
    return;
  }

  if (how === 'status') {
    const s = bridge.status();
    w('\n' + C.bold('NOEMA FOR CHROME') + '\n');
    w('  ' + 'Bridge'.padEnd(16) + (s.connected ? C.green(`✓ listening on 127.0.0.1:${s.port}`) : C.dim('— not started')) + '\n');
    w('  ' + 'Extension'.padEnd(16) + (s.extensionSeen ? C.green('✓ registered') : C.dim('— has not registered yet')) + '\n');
    w('  ' + 'Authorized tabs'.padEnd(16) + (s.authorizedTabs.length ? C.green(String(s.authorizedTabs.length)) : C.dim('0')) + '\n');
    for (const t of s.authorizedTabs) w(C.dim(`    #${t.id} ${t.title || t.url}\n`));
    if (!s.connected) w(C.dim('\n  /browser connect starts the bridge.\n'));
    return;
  }

  if (how === 'connect') {
    const r = await bridge.connect();
    w('  ' + C.green('✓ BRIDGE LISTENING') + C.dim(`  127.0.0.1:${r.port}\n`));
    w('\n  Open the Noema for Chrome extension\'s popup and paste this token:\n\n');
    w('    ' + C.bold(r.token) + '\n\n');
    w(C.dim('  Then authorize the tab(s) you want reachable. Nothing is controllable until you do —\n'));
    w(C.dim('  the extension decides what is exposed, never this bridge.\n'));
    return;
  }

  w(C.dim(`  unknown: /browser ${how}. Try status, connect, or disconnect.\n`));
}

module.exports = { run };
