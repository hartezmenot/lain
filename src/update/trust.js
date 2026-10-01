'use strict';

/**
 * THE RELEASE KEYS NOEMA TRUSTS — Ed25519 public keys, built in. A release manifest is believed only when its
 * signature verifies against one of these (manifest.js). The private half never ships: it is held, DPAPI-protected,
 * by whoever builds releases (distribution/release.js reads it; docs/INSTALL-UPDATE.md says where).
 *
 * `NOEMA_UPDATE_TEST_KEY` (a PEM) adds a key for the updater's own tests and nothing else — it is read only when
 * NOEMA_ISOLATED/LAIN_ISOLATED is set, so a normal install cannot be pointed at a different signer.
 */

const RELEASE_KEYS = Object.freeze([
  // noema-release-1 (2026-09-30)
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAunMnoeILuxvGS3FH2uL3K1sLSCUCIvzAn0BR+mDusIA=\n-----END PUBLIC KEY-----\n',
]);

function publicKeys() {
  const test = process.env.NOEMA_UPDATE_TEST_KEY;
  const isolated = process.env.NOEMA_ISOLATED === '1' || process.env.LAIN_ISOLATED === '1';
  return test && isolated ? [...RELEASE_KEYS, test] : [...RELEASE_KEYS];
}

module.exports = { RELEASE_KEYS, publicKeys };
