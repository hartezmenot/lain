'use strict';

/**
 * PRODUCT FEEDBACK — a report the person writes, with only the attachments
 * they tick, previewed exactly as it will be kept.
 *
 *   types        Bug · UX problem · Model/provider problem · Performance ·
 *                Feature request · Other
 *   attachments  (each an explicit checkbox; off unless ticked)
 *                version            LAIN Core and Harness versions, OS
 *                surface            which surface was open
 *                errors             recent errors — anonymized (home and project
 *                                   paths replaced, secrets redacted)
 *                runtime            runtime status (state words only — no
 *                                   identities, emails or account ids)
 *                screenshot         a picture of the window, only when ticked
 *                logs               recent request outcomes: model, status,
 *                                   error class, duration — never content
 *   never        API keys, OAuth tokens, provider credentials, project source,
 *                private prompts, conversations. Every string passes redact.js,
 *                and a final scan refuses a payload that still looks like a secret.
 *
 * WHERE IT GOES: saved locally (<configDir>/feedback/<id>.json) — there is no
 * LAIN feedback server. The person may then, explicitly, file it as a GitHub
 * issue on a repository they configured (cfg.feedback.repo) through github.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TYPES = Object.freeze({ bug: 'Bug', ux: 'UX problem', model: 'Model/provider problem', performance: 'Performance', feature: 'Feature request', other: 'Other' });
const ATTACH = Object.freeze(['version', 'surface', 'errors', 'runtime', 'screenshot', 'logs']);
const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{16,}|\b\d{8,12}:[A-Za-z0-9_-]{30,}\b)/;

function dir() { return path.join(require('./config').configDir(), 'feedback'); }

/** Paths and secrets out; the shape of an error stays. */
function anonymize(text, app) {
  let t = require('./redact').text(String(text == null ? '' : text));
  const home = os.homedir();
  const proj = app && app.session && app.session.cwd;
  if (proj && proj.length > 3) t = t.split(proj).join('<project>');
  if (home) t = t.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  return t;
}

function versions() {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch { return null; } };
  let harness = null;
  try { const h = require('./harnesslocation').load(); if (h.ok) harness = read(path.join(h.root, 'package.json')); } catch { harness = null; }
  return { core: read(path.join(__dirname, '..', 'package.json')), harness, os: `${os.platform()} ${os.release()}`, node: process.version };
}

function recentErrors(app, clientErrors = []) {
  const out = [];
  for (const t of ((app.session && app.session.turns) || []).slice(-20)) {
    if (t.providerFailure) out.push({ at: t.endedAt || null, kind: t.providerFailure.kind || 'provider', message: t.providerFailure.message || '' });
    for (const e of t.errors || []) out.push({ at: t.endedAt || null, kind: e.kind || 'error', message: e.message || '' });
  }
  for (const e of (Array.isArray(clientErrors) ? clientErrors : []).slice(-10)) out.push({ at: e.at || null, kind: 'window', message: e.message || String(e) });
  return out.slice(-12).map((e) => ({ ...e, message: anonymize(e.message, app).slice(0, 400) }));
}

async function runtimeStatus(app) {
  try {
    const reps = await require('./runtimeadapters').reports(app);
    return reps.map((r) => ({ runtime: r.label, state: r.state, version: r.discovery && r.discovery.version ? r.discovery.version : null }));
  } catch { return []; }
}

function recentRequests() {
  try {
    const rows = require('./usage').read({ from: Date.now() - 24 * 3600e3 }).slice(-30);
    return rows.map((r) => ({ at: r.at, model: r.model, via: r.via, ok: r.ok, ms: r.ms, tokens: r.input != null ? (r.input || 0) + (r.output || 0) : null }));
  } catch { return []; }
}

/**
 * BUILD the report exactly as it would be kept. Nothing leaves the machine here.
 * { type, title, description, include: {version,…}, surface, clientErrors, screenshot (data URL) }
 */
async function build(app, body = {}) {
  const type = TYPES[body.type] ? body.type : null;
  if (!type) return { ok: false, why: `type is one of ${Object.keys(TYPES).join(', ')}` };
  const title = anonymize(String(body.title || '').trim(), app).slice(0, 160);
  if (!title) return { ok: false, why: 'give the report a title' };
  const inc = body.include || {};
  const report = { id: `fb_${crypto.randomBytes(5).toString('hex')}`, type, typeLabel: TYPES[type], title, description: anonymize(String(body.description || ''), app).slice(0, 8000), createdAt: new Date().toISOString(), attachments: {} };
  if (inc.version) report.attachments.version = versions();
  if (inc.surface) report.attachments.surface = String(body.surface || 'unknown').slice(0, 40);
  if (inc.errors) report.attachments.errors = recentErrors(app, body.clientErrors);
  if (inc.runtime) report.attachments.runtime = await runtimeStatus(app);
  if (inc.logs) report.attachments.logs = recentRequests();
  if (inc.screenshot) {
    const s = String(body.screenshot || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return { ok: false, why: 'the screenshot was ticked but no picture was captured' };
    if (s.length > 12 * 1024 * 1024) return { ok: false, why: 'the screenshot is too large' };
    report.attachments.screenshot = { png: s.length, note: 'kept beside the report as screenshot.png' };
    report._screenshot = s;
  }
  // THE LAST GUARD: a payload that still looks like it carries a secret is refused, not shipped.
  const probe = JSON.stringify({ ...report, _screenshot: undefined });
  if (SECRETISH.test(probe)) return { ok: false, why: 'the report still contains something that looks like a credential — remove it from the text' };
  const preview = { ...report }; delete preview._screenshot;
  return { ok: true, report, preview, never: ['API keys', 'OAuth tokens', 'provider credentials', 'project source', 'private prompts', 'conversations'] };
}

/** SAVE locally. Optional, explicit: file it as a GitHub issue on the configured repository. */
async function submit(app, body = {}) {
  const b = await build(app, body);
  if (!b.ok) return b;
  const r = b.report;
  const folder = path.join(dir(), r.id);
  fs.mkdirSync(folder, { recursive: true });
  const shot = r._screenshot; delete r._screenshot;
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(r, null, 2));
  if (shot) fs.writeFileSync(path.join(folder, 'screenshot.png'), Buffer.from(shot.split(',')[1], 'base64'));
  let issue = null;
  const repo = ((((app && app._sibling) || app).cfg || {}).feedback || {}).repo || null;
  if (body.fileIssue === true) {
    if (!repo) return { ok: true, saved: folder, report: r, issue: null, why: 'no feedback repository is configured (Settings › Feedback)' };
    try {
      const text = `${r.description}\n\n---\n\`\`\`json\n${JSON.stringify(r.attachments, null, 2).slice(0, 50000)}\n\`\`\`\n_Filed from Noema (${r.typeLabel})._`;
      const i = await require('./github').api(app, `repos/${repo}/issues`, { method: 'POST', body: { title: `[${r.typeLabel}] ${r.title}`, body: text, labels: [] } });
      issue = { number: i.number, url: i.html_url };
    } catch (e) { return { ok: true, saved: folder, report: r, issue: null, why: `saved locally; the GitHub issue failed: ${e.message}` }; }
  }
  return { ok: true, saved: folder, report: r, issue };
}

module.exports = { TYPES, ATTACH, build, submit, anonymize, SECRETISH };
