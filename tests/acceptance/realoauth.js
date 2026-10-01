// REAL OAUTH (packaging pass §Q): two EXISTING signed-in Codex (ChatGPT) accounts — no sign-in is started.
// A: identity, quota, model list, one small request (provider, account, model, effort, tokens, quota delta).
// B: isolation — its files and identity are unchanged by everything done with A.
// Prints no token, no cookie, no key; identities are masked.
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.chdir(ROOT);
const config = require(ROOT + '/src/config');
config.save = () => {};                       // nothing chosen here is persisted
const ai = require(ROOT + '/src/accountinstances');
const A = process.argv[2] || 'codex-edf98b';
const B = process.argv[3] || 'codex-d9308e';
const mask = (s) => { s = String(s || ''); const m = /^(.)(.*)(@.*)$/.exec(s); return m ? `${m[1]}***${m[3]}` : (s ? `${s.slice(0, 2)}***` : '-'); };

function fingerprint(dir) {
  const out = {};
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(sessions|log|logs|cache|tmp)$/i.test(e.name)) walk(p); continue; } try { const b = fs.readFileSync(p); out[path.relative(dir, p)] = crypto.createHash('sha256').update(b).digest('hex').slice(0, 16); } catch { /* locked */ } } };
  walk(dir);
  return out;
}
const rec = (id) => (ai.records() || []).find((r) => r.id === id) || null;
const view = (r) => r ? { id: r.id, name: r.display_name || r.name || '-', signedIn: r.signedIn, email: mask(r.identity && (r.identity.email || r.identity.providerAccountId)), plan: (r.identity && r.identity.planType) || '-', models: (r.models || []).map((m) => m.id) } : null;
function quotaLine(q) {
  if (!q) return 'no quota answer';
  const w = q.windows || q.limits || q.rateLimits || q.quota || q;
  try { return JSON.stringify(w).replace(/"[^"]*@[^"]*"/g, '"<email>"').slice(0, 400); } catch { return String(w); }
}

(async () => {
  const cfg = config.load();
  const app = { cfg, session: null };
  const recB0 = rec(B);
  const homeB = recB0 && ((recB0.config && (recB0.config.shadow_home || recB0.config.codex_home)) || recB0.shadow_home);
  const bDir = homeB || path.join(config.configDir(), 'accounts', 'codex', B);
  const fpB0 = fingerprint(bDir);
  process.stdout.write(`B (${B}) before: ${JSON.stringify(view(recB0))} · ${Object.keys(fpB0).length} files fingerprinted in ${bDir}\n`);

  // A — identity and models, read from the account itself (no model tokens).
  const r1 = await ai.refresh(app, A);
  process.stdout.write(`A refresh: ${r1.ok ? 'ok' : `FAILED ${r1.why}`}\n`);
  const recA = rec(A);
  process.stdout.write(`A: ${JSON.stringify(view(recA))}\n`);
  const q0 = await ai.refreshQuota(app, A);
  process.stdout.write(`A quota before: ${quotaLine(q0)}\n`);

  // ONE small request through A.
  const models = (recA && recA.models) || [];
  const pick = models.find((m) => /mini|spark|small/i.test(m.id)) || models[0];
  if (!pick) { process.stdout.write('A has no models to request with\n'); return; }
  const prov = require(ROOT + '/src/provider');
  const pc = prov.resolve({ ...cfg, model: pick.id, connection: `runtime:codex:${A}` });
  process.stdout.write(`request: provider ${pc.provider || '-'} · connection runtime:codex:${A} · model ${pick.id} · effort ${pick.defaultEffort || 'default'} · protocol ${pc.protocol}\n`);
  let text = ''; let usage = null; const t0 = Date.now();
  for await (const ev of prov.chat(pc, [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }], { trace: { reason: 'oauth-acceptance' }, role: 'machinery', app: { cfg: pc.adapter ? cfg : cfg } })) {
    if (ev.type === 'text') text += ev.chunk;
    if (ev.type === 'usage') usage = ev;
    if (ev.type === 'error') process.stdout.write(`  error: ${require(ROOT + '/src/redact').text(String(ev.message || ev.error || '')).slice(0, 200)}\n`);
  }
  process.stdout.write(`answer: "${text.trim().slice(0, 60)}" in ${Date.now() - t0} ms · tokens in ${usage ? usage.inputTokens : '?'} out ${usage ? usage.outputTokens : '?'} cacheRead ${usage ? usage.cacheReadTokens || 0 : '?'}\n`);
  const q1 = await ai.refreshQuota(app, A);
  process.stdout.write(`A quota after:  ${quotaLine(q1)}\n`);

  // B — nothing changed.
  const fpB1 = fingerprint(bDir);
  const changed = Object.keys({ ...fpB0, ...fpB1 }).filter((k) => fpB0[k] !== fpB1[k]);
  const recB1 = rec(B);
  process.stdout.write(`B after: ${JSON.stringify(view(recB1))}\n`);
  process.stdout.write(`B isolation: ${changed.length ? `CHANGED files: ${changed.join(', ')}` : 'no file of B changed'} · identity ${JSON.stringify(view(recB0)) === JSON.stringify(view(recB1)) ? 'unchanged' : 'CHANGED'}\n`);
  try { await ai.stopAll(); } catch { /* none */ }
  setTimeout(() => process.exit(0), 1000).unref();
})().catch((e) => { process.stderr.write(`ERR ${require(ROOT + '/src/redact').text(String(e && e.stack || e)).slice(0, 800)}\n`); process.exit(1); });
