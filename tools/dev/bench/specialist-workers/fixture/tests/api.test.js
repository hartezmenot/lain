import test from 'node:test';
import assert from 'node:assert/strict';
import { request, getSettings } from '../src/api.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('request returns the JSON body of a 200', async () => {
  const body = await request('/x', {}, { fetchImpl: async () => ok({ a: 1 }) });
  assert.deepEqual(body, { a: 1 });
});

test('getSettings reads /api/settings', async () => {
  let seen = '';
  await getSettings({ fetchImpl: async (p) => { seen = p; return ok({}); } });
  assert.equal(seen, '/api/settings');
});
