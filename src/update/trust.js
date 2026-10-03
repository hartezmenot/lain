'use strict';

/** THE RELEASE KEYS NOEMA TRUSTS — Ed25519 public keys, built in. */

const RELEASE_KEYS = Object.freeze([
  // noema-release-1 (2026-09-30)
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAunMnoeILuxvGS3FH2uL3K1sLSCUCIvzAn0BR+mDusIA=\n-----END PUBLIC KEY-----\n',
]);

function publicKeys() {
  const test = process.env.LAIN_UPDATE_TEST_KEY || process.env.NOEMA_UPDATE_TEST_KEY;
  const isolated = process.env.LAIN_ISOLATED === '1' || process.env.NOEMA_ISOLATED === '1';
  return test && isolated ? [...RELEASE_KEYS, test] : [...RELEASE_KEYS];
}

module.exports = { RELEASE_KEYS, publicKeys };
