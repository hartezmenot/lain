#!/usr/bin/env node
'use strict';

/**
 * `lain` — the deprecated name. LAIN is now Noema: this is the SAME program (same home, same Core, same sessions),
 * kept for one transition period. It says so once per home and then behaves exactly like `noema`.
 */
require('../src/boot').start({ via: 'lain' });
