'use strict';

/** A ROUTER INSTALLED ON THIS PC — the migration source that holds real sign-ins. */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The provider names each router uses → LAIN's family (null: an API provider, carried as an API source). */
const FAMILY_OF = Object.freeze({
  codex: 'codex', 'openai-codex': 'codex', cx: 'codex',
  claude: 'claude', 'claude-code': 'claude', cc: 'claude',
  agy: 'antigravity', antigravity: 'antigravity', 'gemini-cli': 'antigravity', ag: 'antigravity',
  github: 'copilot', 'github-copilot': 'copilot', gh: 'copilot',
  kiro: 'kiro', kr: 'kiro', cursor: 'cursor', cu: 'cursor', qwen: 'qwen', qd: 'qwen',
  'opencode-go': 'opencode', ocg: 'opencode',
  zai: 'zai', glm: 'zai', 'zai-coding': 'zai', 'zai-general': 'zai',
});
const LABEL = Object.freeze({ '9router': '9Router', omniroute: 'OmniRoute' });
const TABLE = Object.freeze({ '9router': 'providerConnections', omniroute: 'provider_connections' });

function defaultPaths() {
  // A TEST RUN NEVER OPENS A REAL ROUTER'S DATABASE (tests/harness/isolation.js): only fixture paths it passes.
  if (process.env.LAIN_ISOLATED === '1') return { '9router': null, omniroute: null };
  return {
    '9router': path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '9router', 'db', 'data.sqlite'),
    omniroute: path.join(os.homedir(), '.omniroute', 'storage.sqlite'),
  };
}

const obj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } } return {}; };
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const expiryMs = (v) => { if (v == null || v === '') return null; const n = Number(v); if (Number.isFinite(n)) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
const emailOf = (v) => { const s = str(v).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };

/** THE CREDENTIAL IN ITS PROVIDER'S OWN FORMAT, or a shape portable.assess refuses with a reason. */
function credentialOf(family, c) {
  if (!c.accessToken && !c.refreshToken) return null;
  if (family === 'codex') {
    if (c.accessToken && c.accessToken.split('.').length !== 3) return { encrypted: true };
    return { format: 'codex-auth-json', data: { OPENAI_API_KEY: null, tokens: { id_token: c.idToken || null, access_token: c.accessToken, refresh_token: c.refreshToken || null, account_id: c.accountId || null }, last_refresh: new Date().toISOString() } };
  }
  if (family === 'claude') {
    if (c.accessToken && !/^sk-ant-/i.test(c.accessToken)) return { encrypted: true };
    const scopes = c.scopes ? c.scopes.split(/[\s,]+/).filter(Boolean) : ['user:inference', 'user:profile'];
    return { format: 'claude-credentials', clientId: 'claude-code', data: { claudeAiOauth: { accessToken: c.accessToken, refreshToken: c.refreshToken || null, expiresAt: c.expiresAt || null, scopes } } };
  }
  return { format: 'provider-oauth', provider: family };
}

/** One source's rows → discovered accounts (credentials stay inside these objects, in Core memory). */
function readSource(source, file) {
  if (!file || !fs.existsSync(file)) return [];
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return []; }
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`SELECT * FROM ${TABLE[source]}`).all();
    return rows.map((row) => {
      const data = source === '9router' ? obj(row.data) : row;
      const specific = obj(data.providerSpecificData != null ? data.providerSpecificData : data.provider_specific_data);
      const provider = str(row.provider).toLowerCase();
      const family = FAMILY_OF[provider] || null;
      const api = /^(api.?key|apikey)$/i.test(str(row.authType != null ? row.authType : row.auth_type));
      const c = {
        accessToken: str(data.accessToken != null ? data.accessToken : data.access_token),
        refreshToken: str(data.refreshToken != null ? data.refreshToken : data.refresh_token),
        idToken: str(data.idToken != null ? data.idToken : data.id_token),
        apiKey: str(data.apiKey != null ? data.apiKey : data.api_key),
        expiresAt: expiryMs(data.expiresAt != null ? data.expiresAt : data.expires_at != null ? data.expires_at : data.token_expires_at),
        scopes: str(data.scope != null ? data.scope : data.scopes),
        accountId: str(specific.chatgptAccountId || specific.accountUUID || specific.userId || ''),
        baseUrl: str(specific.baseUrl || specific.base_url || data.baseUrl || data.base_url),
      };
      const email = emailOf(row.email) || emailOf(row.name) || emailOf(specific.githubEmail);
      const src = { kind: 'router', id: source, label: LABEL[source] };
      const key = `router:${source}:${str(row.id)}`;
      if (api) {
        return { key, source: src, family: family || provider || 'api', kind: 'api', identity: email || null, label: str(row.name) || null,
          transferable: Boolean(c.apiKey), api: { provider: family === 'zai' ? 'zai' : provider, baseUrl: c.baseUrl, protocol: '', key: c.apiKey || null } };
      }
      return { key, source: src, family: family || provider || 'unknown', kind: 'oauth', identity: email || null, label: str(row.name) || null,
        transferable: false, credential: family ? credentialOf(family, c) : null, profileDir: null };
    });
  } catch { return []; } finally { try { if (db) db.close(); } catch { /* closed */ } }
}

/** Every router installation on this PC that holds accounts. `paths` is for tests (fixture databases). */
function fromRouters(paths = defaultPaths()) {
  const out = [];
  for (const source of Object.keys(TABLE)) out.push(...readSource(source, paths[source]));
  return out;
}

/** Which routers are installed here (existence only — for the window's "Import from…" line). */
function installed(paths = defaultPaths()) { return Object.keys(TABLE).filter((s) => paths[s] && fs.existsSync(paths[s])).map((s) => ({ source: s, label: LABEL[s] })); }

module.exports = { fromRouters, installed, readSource, credentialOf, defaultPaths, FAMILY_OF, LABEL };
