'use strict';

/** WHICH MECHANISM RAN IT — one stamp, one vocabulary. */

/** The four mechanisms LAIN can run something with. Nothing else is a KIND. */
const KIND = Object.freeze({
  SHELL: 'shell',
  PROCESS: 'process',
  PYTHON: 'python',
  JOB: 'background job',
});

/** `[via shell: powershell]` — the detail is optional and free-form. */
function via(kind, detail = '') {
  return `[via ${kind}${detail ? `: ${detail}` : ''}]`;
}

module.exports = { via, KIND };
