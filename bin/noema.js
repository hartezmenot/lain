#!/usr/bin/env node
'use strict';

/**
 * `noema` — the compatibility name. The product is called LAIN again (2026-10-02): this is the SAME program (same
 * home, same Core, same sessions, same accounts), kept for a transition period. It says so once per home and then
 * behaves exactly like `lain`.
 */
require('../src/boot').start({ via: 'noema' });
