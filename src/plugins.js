'use strict';

/** LAIN PLUGINS — packages written FOR LAIN, distinct from the three things they are easily confused with */

const fs = require('fs');
const path = require('path');

const MANIFEST = 'lain-plugin.json';
const PERMISSIONS = Object.freeze(['read', 'write', 'shell', 'network', 'computer']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}(\.[a-z0-9][a-z0-9-]{0,40})?$/;
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'download_file', 'request_browser']);

function bad(why, extra = {}) { return { ok: false, why: String(why), ...extra }; }
function root(configDir) { return path.join(configDir || require('./config').configDir(), 'plugins'); }
function stateFile(configDir) { return path.join(root(configDir), 'plugins.json'); }
function readState(configDir) { try { const s = JSON.parse(fs.readFileSync(stateFile(configDir), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
function writeState(state, configDir) {
  fs.mkdirSync(root(configDir), { recursive: true });
  fs.writeFileSync(`${stateFile(configDir)}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${stateFile(configDir)}.tmp`, stateFile(configDir));
}

/** Validate a manifest; the shape LAIN keeps, or why not. */
function validate(m) {
  if (!m || typeof m !== 'object') return bad(`${MANIFEST} is missing or not JSON`);
  const id = String(m.id || '');
  if (!ID_RE.test(id)) return bad('the plugin id must be lowercase letters, digits and dashes, optionally "publisher.name"');
  const perms = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
  const unknown = perms.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length) return bad(`unknown permission${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (known: ${PERMISSIONS.join(', ')})`);
  const commands = (Array.isArray(m.commands) ? m.commands : []).slice(0, 50).map((c) => ({
    id: String((c && c.id) || '').slice(0, 60), title: String((c && c.title) || (c && c.id) || '').slice(0, 120), prompt: String((c && c.prompt) || '').slice(0, 8000),
  })).filter((c) => /^[a-z0-9][a-z0-9-]*$/.test(c.id) && c.prompt);
  return {
    ok: true,
    manifest: {
      id, name: String(m.name || id).slice(0, 120), version: String(m.version || '0.0.0').slice(0, 40), description: String(m.description || '').slice(0, 500),
      permissions: [...new Set(['read', ...perms])],
      commands,
      skills: (Array.isArray(m.skills) ? m.skills : []).slice(0, 50).map((s) => ({ name: String((s && s.name) || '').slice(0, 120), path: String((s && s.path) || '') })).filter((s) => s.name),
      mcp: (Array.isArray(m.mcp) ? m.mcp : []).slice(0, 20).map((s) => ({ name: String((s && s.name) || '').slice(0, 80), command: String((s && s.command) || '').slice(0, 300), args: Array.isArray(s && s.args) ? s.args.map(String).slice(0, 30) : [] })).filter((s) => s.name),
      bot: { capabilities: (m.bot && Array.isArray(m.bot.capabilities) ? m.bot.capabilities : []).map(String).slice(0, 20) },
      hooks: (Array.isArray(m.hooks) ? m.hooks : []).slice(0, 20).map((h) => ({ event: String((h && h.event) || ''), command: String((h && h.command) || '').slice(0, 300) })),
    },
  };
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** Install from a local folder. Installed DISABLED — nothing is granted yet. */
function install(folder, { configDir = null } = {}) {
  const src = path.resolve(String(folder || ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return bad('choose a plugin folder');
  const v = validate(readManifest(src));
  if (!v.ok) return v;
  const m = v.manifest;
  const dest = path.join(root(configDir), m.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  const state = readState(configDir);
  const prev = state[m.id];
  // A NEW PERMISSION IS A NEW QUESTION: an update that asks for more is disabled again.
  const widened = prev && m.permissions.some((p) => !(prev.granted || []).includes(p));
  state[m.id] = { enabled: prev && !widened ? prev.enabled : false, granted: prev && !widened ? prev.granted : [], installedAt: Date.now(), from: src };
  writeState(state, configDir);
  return { ok: true, plugin: { ...m, ...state[m.id] }, needsGrant: !state[m.id].enabled };
}

function list({ configDir = null } = {}) {
  const state = readState(configDir);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root(configDir), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { dirs = []; }
  for (const d of dirs) {
    const v = validate(readManifest(path.join(root(configDir), d.name)));
    if (!v.ok) { out.push({ id: d.name, broken: v.why, enabled: false }); continue; }
    const st = state[v.manifest.id] || { enabled: false, granted: [] };
    out.push({ ...v.manifest, enabled: Boolean(st.enabled), granted: st.granted || [], notRun: { hooks: v.manifest.hooks.length > 0, mcp: v.manifest.mcp.length > 0, skills: v.manifest.skills.length > 0 } });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function get(id, opts) { return list(opts).find((p) => p.id === id) || null; }

/** Enable = grant exactly what the manifest lists (the person saw that list). */
function enable(id, { grant = [], configDir = null } = {}) {
  const p = get(id, { configDir });
  if (!p || p.broken) return bad(`${id} is not installed`);
  const asked = p.permissions;
  const given = [...new Set(['read', ...grant.map(String)])];
  const missing = asked.filter((x) => !given.includes(x));
  if (missing.length) return bad(`enabling ${p.name} needs: ${missing.join(', ')}`, { needs: asked });
  const state = readState(configDir);
  state[id] = { ...(state[id] || {}), enabled: true, granted: asked };
  writeState(state, configDir);
  return { ok: true, id, enabled: true, granted: asked };
}

function disable(id, { configDir = null } = {}) {
  const state = readState(configDir);
  if (!state[id]) return bad(`${id} is not installed`);
  state[id] = { ...state[id], enabled: false, granted: [] };
  writeState(state, configDir);
  return { ok: true, id, enabled: false };
}

function uninstall(id, { configDir = null } = {}) {
  if (!ID_RE.test(String(id || ''))) return bad('not a plugin id');
  const dir = path.join(root(configDir), id);
  if (!fs.existsSync(dir)) return bad(`${id} is not installed`);
  fs.rmSync(dir, { recursive: true, force: true });
  const state = readState(configDir);
  delete state[id];
  writeState(state, configDir);
  return { ok: true, id, removed: true };
}

/** The category a tool call needs from a grant. */
function categoryOf(name, tool) {
  if (NETWORK_TOOLS.has(name)) return 'network';
  if (name === 'request_computer') return 'computer';
  if (!tool || !tool.mutates) return 'read';
  let source = false;
  try { source = require('./mutation').isSourceMutation(name); } catch { source = false; }
  return source ? 'write' : 'shell';
}

/** The refusal for a tool outside the session's plugin grant, or null. */
function denies(session, name, tool) {
  const g = session && session._pluginGrant;
  if (!g) return null;
  const need = categoryOf(name, tool);
  if (g.permissions.includes(need)) return null;
  return `DENIED PLUGIN_PERMISSION: the plugin "${g.name}" was granted ${g.permissions.join(', ')}; ${name} needs "${need}". Do the part it allows and say what needs "${need}".`;
}

/** A command's prompt with the IDE context filled in. */
function render(prompt, ide = {}) {
  return String(prompt)
    .replace(/\{\{file\}\}/g, ide.file || 'the current file')
    .replace(/\{\{language\}\}/g, ide.language || '')
    .replace(/\{\{selection\}\}/g, ide.selection && ide.selection.text ? ide.selection.text : '(no selection)');
}

/** What running a command would do: the text, and the grant the turn carries. */
function prepare(id, commandId, { configDir = null, ide = null } = {}) {
  const p = get(id, { configDir });
  if (!p || p.broken) return bad(`${id} is not installed`);
  if (!p.enabled) return bad(`${p.name} is disabled — enable it (and grant what it asks for) first`);
  const c = p.commands.find((x) => x.id === commandId);
  if (!c) return bad(`${p.name} has no command "${commandId}"`);
  return { ok: true, text: render(c.prompt, ide || {}), grant: { plugin: p.id, name: p.name, permissions: p.granted }, title: c.title };
}

module.exports = { install, list, get, enable, disable, uninstall, prepare, denies, categoryOf, validate, render, PERMISSIONS, MANIFEST };
