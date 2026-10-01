#!/usr/bin/env node
'use strict';

/**
 * NOEMA — the CLI. `node bin/noema.js` in a checkout; `noema` once installed (the launcher runs this file with the
 * bundled runtime). Everything that must happen before any module reads state — the NOEMA_* environment names, the
 * one-time move of LAIN's home — is src/boot.js.
 *
 * EXIT HYGIENE: `process.exit()` right after a real fetch trips a libuv assertion on Node 24 / Windows
 * (`!(handle->flags & UV_HANDLE_CLOSING)`), so boot sets `process.exitCode` and lets the loop drain, with an unref'd
 * fallback timer as the safety net.
 */
require('../src/boot').start({ via: 'noema' });
