'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ArtifactStore, MAX_BODY } = require('../harness/artifacts');

function safeName(name) {
  return path.basename(String(name || 'artifact')).replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'artifact';
}

function mimeFor(name, fallback = '') {
  return ({
    '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })[path.extname(String(name)).toLowerCase()] || String(fallback || 'application/octet-stream').slice(0, 100);
}

function refFor(sessionId, rec) {
  return 'cwa_' + crypto.createHash('sha256').update(JSON.stringify([sessionId, rec.taskId, rec.id])).digest('hex').slice(0, 28);
}

function taskRecords(app) {
  const session = app && app.session;
  if (!session || !session.id || !session.cwd) return [];
  const store = new ArtifactStore(session.cwd);
  const current = require('../harnesslink').existing(app)?.runtime.latest();
  // A process can die while a task is RUNNING after it has already produced a useful file.
  const tasks = store.listTasks();
  if (current) tasks.unshift(current);
  const seen = new Set();
  return tasks.filter((task) => {
    if (!task || task.sessionId !== session.id || seen.has(task.id) || typeof task.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id)) return false;
    if (path.resolve(task.workspace || '') !== path.resolve(session.cwd)) return false;
    try {
      const root = fs.realpathSync(require('../lainstore').tasksRoot(session.cwd));
      const relative = path.relative(root, fs.realpathSync(store.dirFor(task.id)));
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
    } catch { return false; }
    seen.add(task.id);
    return true;
  }).map((task) => ({ task, store }));
}

function records(app) {
  const out = [];
  for (const { task, store } of taskRecords(app)) {
    for (const rec of store.index(task.id)) out.push({ ...rec, taskState: task.state, ref: refFor(app.session.id, rec) });
  }
  return out.sort((a, b) => b.at - a.at);
}

function publicRecord(rec) {
  return { ref: rec.ref, name: safeName(rec.name), mime: mimeFor(rec.name), bytes: rec.bytes, kind: rec.kind,
    taskState: rec.taskState, at: rec.at };
}

function list(app, { limit = 40 } = {}) { return records(app).slice(0, Math.max(0, Math.min(100, limit))).map(publicRecord); }

function find(app, ref) {
  const matches = records(app).filter((rec) => rec.ref === String(ref || ''));
  return matches.length === 1 ? matches[0] : null;
}

function bytes(app, ref) {
  const rec = find(app, ref);
  if (!rec) return null;
  return new ArtifactStore(app.session.cwd).bytes(rec.taskId, rec.id);
}

function keep(app, { name, mime = '', body, note = 'Cowork output' } = {}) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BODY) return null;
  const h = require('../harnesslink').existing(app), activeTaskId = h?.runtime.activeId;
  if (!activeTaskId) return null;
  const rec = h.runtime.keep(activeTaskId, { kind: 'report', name: safeName(name), body, note: String(note).slice(0, 200) });
  if (!rec) return null;
  return publicRecord({ ...rec, taskState: h.runtime.get(activeTaskId)?.state || 'RUNNING', ref: refFor(app.session.id, rec), mime });
}

module.exports = { safeName, mimeFor, refFor, taskRecords, records, publicRecord, list, find, bytes, keep, MAX_BODY };
