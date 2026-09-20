'use strict';

/**
 * "HOW TO RUN" IS CHECKED AGAINST THE MANIFEST, not taken on trust.
 *
 * The prompt already says "a package.json with no start script has no npm
 * start" (src/prompt.js), and a live ECO run on 2026-09-19 still closed with
 *
 *     ┌─ HOW TO RUN ────────────────────────────────────────┐
 *     │ npm start (if applicable) or integrate as library   │
 *
 * for a project whose package.json has no "start". The renderer draws what it
 * is given (ui/markdown.js — nothing inferred), so the check is here, against
 * the file: an npm/yarn/pnpm script the report names that the manifest does not
 * define is flagged on THAT turn, the same way a contradicted success claim is.
 * Nothing is rewritten; the person sees the report and the correction together.
 */

const fs = require('fs');
const path = require('path');

const HOWTO = /^\s*(?:[*_#>\-\s]*)(how\s+to\s+(?:run|test)|to\s+run|to\s+test)\s*[*_]*\s*[:—–-]\s*(.*)$/i;
const SCRIPT = /\b(npm|yarn|pnpm)\s+(?:run\s+)?([a-z][\w:.-]*)/gi;
/** Built-in npm commands that are not scripts (npm test/start need one; these do not). */
const BUILTIN = new Set(['install', 'i', 'ci', 'init', 'exec', 'x', 'link', 'pack', 'publish', 'version', 'outdated', 'update', 'audit', 'ls', 'why', 'add', 'dlx', 'create']);

function manifest(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd || '.', 'package.json'), 'utf8')); } catch { return null; }
}

/** The commands the report's How-to lines name (the line itself and a short block under it). */
function howtoCommands(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HOWTO.exec(lines[i]);
    if (!m) continue;
    // The line already says the command does not exist ("npm start (not defined in package.json)").
    if (/\bnot (?:defined|available|present|configured)\b|\bno (?:start|such)\b|\bdoes(?:n'?t| not) exist\b/i.test(m[2])) continue;
    const body = [m[2], ...lines.slice(i + 1, i + 4).filter((l) => /^\s*(?:`{3}|[$>]?\s*(?:npm|yarn|pnpm)\b)/.test(l))].join(' ');
    for (const s of body.matchAll(SCRIPT)) out.push({ tool: s[1].toLowerCase(), script: s[2] });
  }
  return out;
}

/** A warning when the report names a script the manifest does not define; else null. */
function check(text, cwd) {
  const cmds = howtoCommands(text);
  if (!cmds.length) return null;
  const pkg = manifest(cwd);
  if (!pkg) return null;
  const scripts = pkg.scripts || {};
  for (const c of cmds) {
    if (BUILTIN.has(c.script) || scripts[c.script]) continue;
    // npm's own default: `npm start` with a server.js runs it.
    if (c.script === 'start' && fs.existsSync(path.join(cwd, 'server.js'))) continue;
    return `The report says to run \`${c.tool} ${c.script === 'start' || c.script === 'test' ? c.script : `run ${c.script}`}\`, `
      + `but package.json defines no "${c.script}" script — that command would fail here. Scripts it does define: `
      + `${Object.keys(scripts).join(', ') || 'none'}.`;
  }
  return null;
}

module.exports = { check, howtoCommands };
