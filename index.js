'use strict';

/**
 * LAIN HARNESS — the visual frontend, and nothing else (2026-09-23).
 *
 * WHAT THIS PACKAGE OWNS: presentation. The interface document (`page/`), and
 * the native WebView2 shell that shows it (`native/host.cs`, compiled on the
 * user's machine with the vendored SDK, `native/vendor.js`).
 *
 * WHAT IT DOES NOT OWN: anything with authority. Session, task, Goal,
 * permissions, tools, Browser/Computer, project intelligence, workers,
 * subagents, evidence, verification, crash recovery, providers and Bot state
 * all live in LAIN Core (the `lain` repository beside this one). The page reads
 * Core's local API (`/api/*`, served by Core's `src/harnessapp/routes.js`) and
 * the host speaks Core's named pipe (`src/harnessapp/ipc.js`). Neither side
 * keeps a copy of the other.
 *
 * THE CONTRACT Core loads (src/harnesslocation.js):
 *   CONTRACT    integer; bumped when this shape changes
 *   html()      the whole interface as one document
 *   assetDirs() directories served beside it ({url, dir}) — the editor's code
 *   ensureVendor() fetch that code once (Monaco, pinned and verified)
 *   hostSource  absolute path of the native host's C# source
 *   vendor()    the WebView2 SDK vendoring module
 */

const path = require('path');

// 2 (2026-09-24): the workspace shell — Home, IDE, Chat, Bot, Model, Session,
// Settings — reads Core's accounts, usage, MCP, skills and project-open routes
// (src/harnessapp/workspaceroutes.js) and the lain_workspace navigation field.
const CONTRACT = 2;

module.exports = {
  CONTRACT,
  html: (...args) => require('./page/page').html(...args),
  // Directories served beside index.html ({url, dir}), e.g. vendor/monaco.
  assetDirs: () => require('./webvendor').assetDirs(),
  // Fetch vendored web code (Monaco) once; resolves {ok, why?}. Never required.
  ensureVendor: () => require('./webvendor').ensureAll(),
  hostSource: path.join(__dirname, 'native', 'host.cs'),
  vendor: () => require('./native/vendor'),
};
