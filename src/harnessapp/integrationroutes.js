'use strict';

/**
 * MCP & SKILLS ROUTES (Phase 8.1) — integrations.js, drawn by the MCP & SKILLS surface.
 *
 *   /api/integrations/state            servers, skills, the catalog, this project's recommendations
 *   /api/integrations/mcp/add          { name, transport, command | url, env, headers, secretEnv, secretHeaders }
 *   /api/integrations/mcp/connect      { id } — starts it and lists its tools / resources / prompts
 *   /api/integrations/mcp/disconnect   { id }
 *   /api/integrations/mcp/enable       { id, enabled }
 *   /api/integrations/mcp/remove       { id } — and the secrets LAIN kept for it
 *   /api/integrations/skill/validate   { path }
 *   /api/integrations/skill/add        { path } | { repo } — added DISABLED, after validation
 *   /api/integrations/skill/enable     { id, enabled }
 *   /api/integrations/skill/remove     { id, deleteFiles }
 */

const ig = require('../integrations');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
const pass = (r) => (r.ok ? ok(r) : bad(r.why, 409, r));

const ROUTES = {
  'POST /api/integrations/state': async (app) => ok(ig.state(app)),
  'POST /api/integrations/mcp/add': async (app, body = {}) => pass(ig.addMcp(app, body)),
  'POST /api/integrations/mcp/connect': async (app, body = {}) => pass(await ig.connect(app, String(body.id || ''))),
  'POST /api/integrations/mcp/disconnect': async (app, body = {}) => pass(ig.disconnect(app, String(body.id || ''))),
  'POST /api/integrations/mcp/enable': async (app, body = {}) => pass(ig.setEnabled(app, String(body.id || ''), body.enabled !== false)),
  'POST /api/integrations/mcp/remove': async (app, body = {}) => pass(ig.removeMcp(app, String(body.id || ''))),
  'POST /api/integrations/skill/add': async (app, body = {}) => pass(ig.addSkill(app, body)),
  // AN EXECUTABLE SKILL (scripts or dependencies) is enabled only with a confirm, after its files were shown (skillshub.js).
  'POST /api/integrations/skill/enable': async (app, body = {}) => pass(body.enabled === false ? ig.setSkill(app, String(body.id || ''), false) : require('../skillshub').enable(app, String(body.id || ''), { confirm: body.confirm === true })),
  // THE SKILLS HUB (Phase 8.3): sources, the index, inspect, install, update — never a runtime, never an auto-run.
  'POST /api/skills/hub': async (app) => ok(require('../skillshub').state(app)),
  'POST /api/skills/search': async (app, body = {}) => ok(require('../skillshub').search(app, { query: body.query || '', tag: body.tag || null, source: body.source || null, limit: Math.max(1, Math.min(500, Number(body.limit) || 200)) })),
  'POST /api/skills/source/add': async (app, body = {}) => pass(require('../skillshub').addSource(body)),
  'POST /api/skills/source/remove': async (app, body = {}) => pass(require('../skillshub').removeSource(String(body.id || ''))),
  'POST /api/skills/source/refresh': async (app, body = {}) => {
    // IN THE BACKGROUND: Discover keeps drawing the index it has; the page re-reads when this lands.
    const hub = require('../skillshub');
    const job = hub.refresh({ id: body.id ? String(body.id) : null });
    if (body.wait === true) return ok(await job);
    job.catch(() => {});
    return ok({ started: true });
  },
  'POST /api/skills/inspect': async (app, body = {}) => pass(require('../skillshub').inspect(String(body.key || ''))),
  'POST /api/skills/install': async (app, body = {}) => pass(require('../skillshub').install(app, String(body.key || ''), { enable: body.enable !== false })),
  'POST /api/skills/update': async (app, body = {}) => pass(require('../skillshub').update(app, String(body.id || ''), { action: String(body.action || 'check') })),
  'POST /api/integrations/skill/remove': async (app, body = {}) => pass(ig.removeSkill(app, String(body.id || ''), { deleteFiles: body.deleteFiles === true })),
};

module.exports = { ROUTES };
