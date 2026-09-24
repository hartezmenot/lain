import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamdesk-'));
process.env.SETTINGS_FILE = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.SETTINGS_FILE, JSON.stringify({ workspaceName: 'T', digest: 'daily' }));
process.env.LOG_LEVEL = 'error';
const { createApi } = await import('../server/app.js');

test('health answers', async () => {
  const srv = createApi().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/health`);
  assert.equal(res.status, 200);
  srv.close();
});
