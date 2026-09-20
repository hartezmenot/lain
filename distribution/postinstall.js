'use strict';

/**
 * THE LAST STEP OF INSTALLING — build LAIN.exe, in the place it was installed.
 *
 * ------------------------------------------------------------------------
 * WHY THE INSTALLER DOES NOT SHIP LAIN.exe READY-MADE.
 *
 * The native host is compiled from `native/host.cs` by the `csc.exe` that is
 * part of Windows, and the launcher records WHICH NODE and WHICH ENTRYPOINT to
 * use — both of which are facts about the machine it was installed on, not
 * about the machine it was built on. A prebuilt launcher would carry the build
 * machine's paths into somebody else's install.
 *
 * So the product builds its own front door, using the same code path
 * `lain --desktop` uses. There is one way in, and the installer takes it too.
 *
 * Run as: node distribution/postinstall.js <install-dir>
 */

const path = require('path');

function main(argv) {
  const dir = String(argv[0] || path.join(__dirname, '..'));
  const desktop = require(path.join(dir, 'src', 'desktop'));

  const built = desktop.build();
  if (!built.ok) {
    process.stderr.write(`the native host did not build: ${built.why}\n`);
    return 1;
  }
  process.stdout.write(`native host built (${path.basename(built.exe)})\n`);

  // THE LAUNCHER LANDS BESIDE THE PROGRAM, not in LAIN's data directory: it is
  // part of the installation, and the uninstaller removes it with everything
  // else it put there.
  const installed = desktop.installLauncher(built, { at: path.join(dir, 'LAIN.exe') });
  if (!installed.ok) {
    process.stderr.write(`the launcher was not written: ${installed.why}\n`);
    return 1;
  }
  process.stdout.write(`LAIN.exe ready${installed.node ? ` (node: ${installed.node})` : ''}\n`);
  if (!installed.node) process.stderr.write(`no Node was recorded: ${installed.why}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
