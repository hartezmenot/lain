'use strict';

/**
 * AN npm-STYLE .cmd SHIM around a fixture script — the same shape the real
 * `claude.cmd` / `opencode.cmd` have, so the tests exercise
 * cliexec.resolveShim (no shell; the pid is the program's own).
 */

const fs = require('fs');
const path = require('path');

function shim(dir, name, fixture) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(fixture);
  fs.copyFileSync(fixture, path.join(dir, base));
  const cmd = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(cmd, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\${base}" %*\r\n`);
  return cmd;
}

module.exports = { shim, FIX: __dirname };
