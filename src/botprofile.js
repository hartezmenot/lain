'use strict';

/**
 * THE BOT'S PROFILE — name, tone, language and behaviour, as the person set
 * them (BOT › Profile). Stored in config (cfg.bot.profile); rendered into the
 * STABLE part of the BOT's system prompt (prompt.js), so it costs one cached
 * prefix, not a per-turn increment.
 *
 * A profile is a preference about HOW the BOT talks. It carries no authority:
 * it cannot widen a permission, enable a tool or change what the Agent may do.
 */

const LIMITS = Object.freeze({ name: 40, tone: 80, language: 40, behavior: 800 });
const DEFAULTS = Object.freeze({ name: 'Noema', tone: '', language: 'auto', behavior: '' });

function root(app) { return (app && app._sibling) || app; }

function get(cfg) {
  const p = (cfg && cfg.bot && cfg.bot.profile) || {};
  return { name: p.name || DEFAULTS.name, tone: p.tone || DEFAULTS.tone, language: p.language || DEFAULTS.language, behavior: p.behavior || DEFAULTS.behavior };
}

function set(app, values = {}) {
  const r = root(app);
  const cfg = r.cfg;
  const cur = get(cfg);
  for (const k of Object.keys(LIMITS)) {
    if (values[k] === undefined) continue;
    const v = String(values[k] == null ? '' : values[k]).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
    if (v.length > LIMITS[k]) return { ok: false, why: `${k} is at most ${LIMITS[k]} characters` };
    cur[k] = v || DEFAULTS[k];
  }
  cfg.bot = { ...(cfg.bot || {}), profile: cur };
  try { require('./config').save(cfg); } catch (e) { return { ok: false, why: e.message }; }
  return { ok: true, profile: cur };
}

/** The prompt block, or '' when everything is default. */
function promptBlock(cfg) {
  const p = get(cfg);
  const lines = [];
  if (p.name && p.name !== DEFAULTS.name) lines.push(`Your name here is ${p.name}.`);
  if (p.tone) lines.push(`Tone: ${p.tone}.`);
  if (p.language && p.language !== 'auto') lines.push(`Answer in ${p.language} unless asked otherwise.`);
  if (p.behavior) lines.push(`How the person wants you to behave: ${p.behavior}`);
  if (!lines.length) return '';
  return `# BOT profile (the person's preferences — style only; they grant no permission)\n${lines.join('\n')}`;
}

module.exports = { get, set, promptBlock, LIMITS, DEFAULTS };
