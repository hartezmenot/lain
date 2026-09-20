'use strict';

/**
 * AGENTS.md — BEHAVIOURAL INSTRUCTION, NEVER AUTHORITY.
 *
 * Two files, read if present, in this order:
 *
 *     ~/.lain/AGENTS.md              the person's standing policies, every project
 *     <project>/.lain/AGENTS.md      this project's conventions
 *
 * The project file is stated second so a project convention reads after — and
 * therefore refines — a global one.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR: worker discipline, no unrelated refactors, test workers stay
 * read-only, return evidence, ask for scope rather than take it, the
 * repository's own conventions.
 *
 * WHAT IT IS NOT: a guard. Nothing in the runtime consults these words before a
 * write. Scope is enforced by workorderguard.js, staleness by the mutation
 * transaction, verification by verifycontract.js — so a model that ignores an
 * AGENTS.md line can still not write outside a bounded order. The prompt says
 * so, beside the text, so no reader mistakes one for the other.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 16_000;

function homeFile() {
  return path.join(process.env.LAIN_AGENTS_HOME || os.homedir(), '.lain', 'AGENTS.md');
}

function projectFile(root) { return path.join(String(root || process.cwd()), '.lain', 'AGENTS.md'); }

function readCapped(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const truncated = Buffer.byteLength(text) > MAX_BYTES;
  if (truncated) text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8');
  return { file, text: text.trim(), truncated, mtime: Math.floor(st.mtimeMs) };
}

/** Both layers, as found. */
function load(root) {
  return { global: readCapped(homeFile()), project: readCapped(projectFile(root)) };
}

/** The prompt section, or '' when neither file exists or both are empty. */
function forPrompt(root) {
  const { global, project } = load(root);
  const parts = [];
  if (global && global.text) parts.push(`## Global (~/.lain/AGENTS.md)\n${global.text}${global.truncated ? '\n[truncated]' : ''}`);
  if (project && project.text) parts.push(`## This project (.lain/AGENTS.md)\n${project.text}${project.truncated ? '\n[truncated]' : ''}`);
  if (!parts.length) return '';
  return '# Behavioural instructions (AGENTS.md)\n'
    + 'Follow these as working policy. They are instructions, not permissions: write scope, staleness and '
    + 'verification are enforced by LAIN at runtime whatever this text says.\n\n'
    + parts.join('\n\n');
}

module.exports = { load, forPrompt, homeFile, projectFile, MAX_BYTES };
