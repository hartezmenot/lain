'use strict';

/** WHAT A ROUTE REQUIRES OF ITS CLIENT, beyond the key — part of the provider adapter (provider.js), split out at the size guard. */
function routeHeaders(pc, opts = {}) {
  let host = '';
  try { host = new URL(String((pc && pc.baseUrl) || '')).hostname; } catch { return {}; }
  if (!/(^|\.)opencode\.ai$/i.test(host)) return {};
  const h = { 'user-agent': `lain/${require('../package.json').version}` };
  if (opts.sessionId) h['x-opencode-session'] = String(opts.sessionId);
  return h;
}

module.exports = { routeHeaders };
