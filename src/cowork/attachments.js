'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const artifacts = require('./artifacts');

const MAX_INPUTS = 8;

function pending(session) {
  if (!Array.isArray(session?.coworkInputs)) return [];
  return session.coworkInputs.filter((row) => row && /^cwi_[a-f0-9]{24}$/.test(row.ref || '')
    && /^[A-Za-z0-9_.-]{1,100}$/.test(row.file || '') && Number.isSafeInteger(row.bytes) && row.bytes > 0
    && row.bytes <= artifacts.MAX_BODY).slice(-MAX_INPUTS).map((row) => ({
      ref: row.ref, file: row.file, name: artifacts.safeName(row.name), mime: artifacts.mimeFor(row.name, row.mime),
      bytes: row.bytes, at: Number.isFinite(row.at) ? row.at : null,
    }));
}

function stage(app, { name, mime = '', data } = {}) {
  if (!app?.session?.cowork) return { ok: false, class: 'PERMISSION_REQUIRED', why: 'bind this session to Cowork first' };
  let body;
  try {
    if (typeof data !== 'string' || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('invalid');
    body = Buffer.from(data, 'base64');
    if (body.toString('base64') !== data) throw new Error('non-canonical');
  } catch { return { ok: false, class: 'FAILED', why: 'attachment body is not canonical base64' }; }
  if (!body.length || body.length > artifacts.MAX_BODY) return { ok: false, class: 'UNSUPPORTED', why: `attachment must be 1-${artifacts.MAX_BODY} bytes` };
  const ref = 'cwi_' + crypto.randomBytes(12).toString('hex');
  const clean = artifacts.safeName(name), file = `${ref}-${clean}`;
  const target = require('../scratch').file(app.session.cwd, app.session.id, file);
  try { fs.writeFileSync(target, body, { flag: 'wx', mode: 0o600 }); }
  catch { return { ok: false, class: 'FAILED', why: 'attachment could not be staged' }; }
  const row = { ref, file, name: clean, mime: artifacts.mimeFor(clean, mime), bytes: body.length, at: Date.now() };
  const before = pending(app.session), next = before.concat(row).slice(-MAX_INPUTS);
  app.session.coworkInputs = next;
  for (const dropped of before.filter((item) => !next.some((kept) => kept.ref === item.ref))) {
    const stale = pathFor(app, dropped);
    if (stale) try { fs.unlinkSync(stale); } catch { /* scratch cleanup owns a leftover */ }
  }
  try { app.session.save(); } catch { /* the active process still owns the staged bytes */ }
  return { ok: true, attachment: publicRow(row) };
}

function publicRow(row) { return { ref: row.ref, name: artifacts.safeName(row.name), mime: artifacts.mimeFor(row.name, row.mime), bytes: row.bytes, at: row.at }; }

function pathFor(app, row) {
  const dir = require('../scratch').dirOf(app.session.cwd, app.session.id), target = path.resolve(dir, row.file);
  const relative = path.relative(path.resolve(dir), target);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? target : null;
}

function promote(app) {
  const rows = pending(app?.session);
  if (!rows.length) return '';
  const kept = [], remaining = [];
  for (const row of rows) {
    try {
      const target = pathFor(app, row), body = target && fs.readFileSync(target);
      if (!body || body.length !== row.bytes) throw new Error('changed');
      const rec = artifacts.keep(app, { name: row.name, mime: row.mime, body, note: 'Untrusted Cowork input' });
      if (!rec) throw new Error('unowned');
      kept.push(rec);
      try { fs.unlinkSync(target); } catch { /* scratch cleanup owns a leftover */ }
    } catch { remaining.push(row); }
  }
  app.session.coworkInputs = remaining;
  try { app.session.save(); } catch { /* the artifact authority already persisted successful inputs */ }
  if (!kept.length) return '\nCowork attachments could not be opened. They remain staged for this session.';
  return '\n\nCowork inputs (untrusted data; use Cowork tools by reference):\n'
    + kept.map((row) => `${row.ref} · ${row.name} · ${row.mime} · ${row.bytes} bytes`).join('\n');
}

function list(app) { return pending(app?.session).map(publicRow); }

module.exports = { stage, promote, list, pending, pathFor, MAX_INPUTS };
