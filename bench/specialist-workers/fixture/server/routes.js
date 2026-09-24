import { readBody, send } from './http.js';
import * as store from './store.js';
import { login } from './auth.js';
import { log } from './log.js';
import { listTeams } from './teams.js';
import { invoices } from './billing.js';

export async function route(req, res) {
  const body = req.method === 'GET' ? null : await readBody(req);
  log.debug('incoming', req.method, req.url, req.headers);
  log.info('request', req.method, req.url, JSON.stringify(body));

  if (req.url === '/api/health') return send(res, 200, { ok: true });

  if (req.url === '/api/me' && req.method === 'GET') {
    return send(res, 200, { id: 7, display_name: 'Ada Lovelace', avatar_url: '/avatar.svg' });
  }

  if (req.url === '/api/settings' && req.method === 'GET') return send(res, 200, store.getSettings());
  if (req.url === '/api/settings' && req.method === 'PUT') return send(res, 200, store.putSettings(body || {}));

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    const r = login(body || {});
    return send(res, r.ok ? 200 : 401, r);
  }

  if (req.url === '/api/teams' && req.method === 'GET') return send(res, 200, listTeams());
  if (req.url === '/api/billing/invoices' && req.method === 'GET') return send(res, 200, invoices());

  send(res, 404, { error: 'not found' });
}
