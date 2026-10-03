'use strict';

/** EVERY ACCOUNT'S CURRENT WINDOWS — ONE PROJECTION, FROM THE FABRIC (2026-10-02). */

const NAMED_MINS = Object.freeze({ five_hour: 300, '5-hour': 300, seven_day: 10080, '7-day': 10080, weekly: 10080, monthly: 43200 });

function slug(label) { return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

function rows(app, now = Date.now()) {
  let fams = [];
  try { fams = require('./index').families(app); } catch { fams = []; }
  const out = [];
  for (const f of fams) {
    for (const a of f.accounts) {
      const windows = (a.quota || []).map((w) => ({
        id: w.id || slug(w.label), label: w.label, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent,
        resetsAt: w.resetsAt || null, expired: Boolean(w.resetsAt && now >= w.resetsAt), credits: w.credits == null ? null : w.credits,
        mins: w.windowMins || NAMED_MINS[w.id] || NAMED_MINS[String(w.label || '').toLowerCase()] || null,
      }));
      out.push({
        id: a.id, family: f.id, familyLabel: f.label, brand: f.brand, name: a.name, kind: a.kind || f.kind, instanceId: a.instanceId || null,
        base: a.base || null, ownership: a.ownership || null, enabled: a.enabled !== false, identity: a.identity || null,
        windows, quotaAt: a.quotaAt || null, quotaSource: a.quotaSource || null, quotaNote: windows.length ? null : (a.quotaNote || 'Not reported'),
      });
    }
  }
  return out;
}

/** Does a usage receipt belong to this account? (usage.js keys a receipt by instance, base connection or runtime.) */
function matcher(row) {
  const keys = [row.id, row.instanceId, row.base].filter(Boolean).map(String);
  const defaultClaude = row.family === 'claude' && !row.instanceId;
  return (r) => {
    const acc = String((r && r.account) || '');
    if (keys.some((k) => acc === k || acc.startsWith(`${k}:`))) return true;
    return defaultClaude && (r.runtime === 'claude-code' || r.via === 'Runtime · Claude Code') && !acc;
  };
}

module.exports = { rows, matcher, NAMED_MINS };
