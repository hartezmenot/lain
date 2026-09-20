'use strict';

/**
 * Normalize a step's tool calls BEFORE they are persisted: an empty or
 * duplicate id leaves a tool_result nothing can be matched to, which every
 * provider rejects, and string arguments are parsed once here.
 */
function normalize(calls, step) {
  const seen = new Set();
  return (calls || []).filter(Boolean).map((c, i) => {
    let id = String(c.id || '');
    if (!id || seen.has(id)) id = `call_${step}_${i}`;
    seen.add(id);
    let input = c.input;
    let malformed = c.malformed || null;
    if (typeof input === 'string') ({ input, malformed } = require('./finish').parseArgs(input));
    if (!input || typeof input !== 'object') input = {};
    // MALFORMED arguments are carried, never silently run as {} (finish.js).
    return { id, name: String(c.name || ''), input, ...(malformed ? { malformed } : {}) };
  }).filter((c) => c.name);
}

module.exports = { normalize };
