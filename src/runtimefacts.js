'use strict';

/** WHAT THE SUPERVISOR KNOWS, MIRRORED ONTO THE APP FOR SYNCHRONOUS READERS. */

/** WORK THAT WAS RUNNING WHEN THIS PROCESS DID NOT EXIST. */
function jobs(app) {
  // NO SUPERVISED JOBS (S7): background jobs end with the process, so none can have run while LAIN was away.
  if (app) app._supervisedJobs = [];
}

/** WHICH ROUTES ARE SHUT. */
function providers(app, opts = {}) {
  return require('./providerhealth').refresh(app, opts);
}

/** BOTH, for a caller that is about to describe the world. */
function refresh(app, { timeoutMs = 2000 } = {}) {
  return Promise.race([
    Promise.all([
      Promise.resolve(jobs(app)).catch(() => {}),
      Promise.resolve(providers(app)).catch(() => {}),
    ]),
    new Promise((r) => setTimeout(r, Math.max(0, timeoutMs))),
  ]);
}

module.exports = { jobs, providers, refresh };
