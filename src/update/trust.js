'use strict';

/** THE RELEASE KEYS LAIN TRUSTS — Ed25519 public keys, built in. */

const RELEASE_KEYS = Object.freeze([
  // lain-release-2 (2026-10-06): sealed (DPAPI, CurrentUser) in %USERPROFILE%\.lain-release on the release machine.
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAP4epmWJdgIMvnYOQlYulRZy4rAWVrnHKOUKpJEY6xT0=\n-----END PUBLIC KEY-----\n',
  // noema-release-1 (2026-09-30): its private half is no longer on the release machine; kept so a feed it signed still verifies.
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAunMnoeILuxvGS3FH2uL3K1sLSCUCIvzAn0BR+mDusIA=\n-----END PUBLIC KEY-----\n',
]);

function publicKeys() {
  const test = process.env.LAIN_UPDATE_TEST_KEY || process.env.NOEMA_UPDATE_TEST_KEY;
  const isolated = process.env.LAIN_ISOLATED === '1' || process.env.NOEMA_ISOLATED === '1';
  return test && isolated ? [...RELEASE_KEYS, test] : [...RELEASE_KEYS];
}

module.exports = { RELEASE_KEYS, publicKeys };
