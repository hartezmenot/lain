'use strict';

/** WHY SOMETHING DID NOT HAPPEN — named, so "Smoke failed." can stop being the whole answer. */

/** The taxonomy. Add here, never inline a new string at a call site. */
const CODE = {
  VM_UNAVAILABLE: 'VM_UNAVAILABLE',
  VM_START_FAILED: 'VM_START_FAILED',
  VM_NOT_READY: 'VM_NOT_READY',
  GUEST_EXEC_FAILED: 'GUEST_EXEC_FAILED',
  CHROMIUM_FAILED: 'CHROMIUM_FAILED',
  APP_START_FAILED: 'APP_START_FAILED',
  BROWSER_VERIFICATION_FAILED: 'BROWSER_VERIFICATION_FAILED',
  ARTIFACT_TRANSFER_FAILED: 'ARTIFACT_TRANSFER_FAILED',
};

/** Everything except a real verification verdict is infrastructure. */
const VERDICT_CODES = new Set([CODE.BROWSER_VERIFICATION_FAILED]);

function isInfrastructure(code) {
  return Boolean(code) && !VERDICT_CODES.has(String(code));
}

/** What a person is told first, per code. Short, and never a stack trace. */
const SUMMARY = {
  [CODE.VM_UNAVAILABLE]: 'no VM environment is available',
  [CODE.VM_START_FAILED]: 'the VM would not start',
  [CODE.VM_NOT_READY]: 'the VM is running but not ready to take work',
  [CODE.GUEST_EXEC_FAILED]: 'a command inside the guest failed to run',
  [CODE.CHROMIUM_FAILED]: 'the Harness browser would not start',
  [CODE.APP_START_FAILED]: 'the application under test would not start',
  [CODE.BROWSER_VERIFICATION_FAILED]: 'the page did not pass its checks',
  [CODE.ARTIFACT_TRANSFER_FAILED]: 'evidence could not be brought back',
};

/** BUILD ONE. `why` overrides the stock summary when a call site knows something better; `detail` is unbounded here and bounded at the edges that… */
function fail(code, why = '', detail = '', extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(SUMMARY, code);
  return {
    ok: false,
    code: known ? code : 'UNKNOWN',
    // A caller that passes an unknown code has a bug; saying so beats
    // silently inventing a category that tests will then assert against.
    why: String(why || SUMMARY[code] || `unrecognised failure code: ${code}`),
    detail: String(detail || ''),
    infrastructure: isInfrastructure(known ? code : null),
    at: Date.now(),
    ...extra,
  };
}

/** ONE LINE FOR A STATUS SURFACE. */
function line(f) {
  if (!f || f.ok) return '';
  return `${f.code}: ${f.why}`;
}

module.exports = { CODE, SUMMARY, fail, line, isInfrastructure, VERDICT_CODES };
