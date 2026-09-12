'use strict';
const crypto = require('crypto');
const SOURCES = new Set(['harness', 'telegram', 'discord', 'whatsapp']);
function from(value) {
  if (!value || value.version !== 1 || value.lane !== 'cowork' || !SOURCES.has(value.source)
    || !/^[a-f0-9]{64}$/.test(value.binding || '')) return null;
  return { version: 1, lane: 'cowork', source: value.source, binding: value.binding };
}
function bind(session, source, binding) {
  const next = from({ version: 1, lane: 'cowork', source, binding });
  if (!next) throw new Error('invalid Cowork source binding');
  if (session.cowork && (session.cowork.source !== source || session.cowork.binding !== binding)) throw new Error('Cowork session belongs to a different source');
  session.cowork = next;
  return next;
}
function sourceBinding(source, identity) {
  return crypto.createHash('sha256').update(JSON.stringify([String(source), String(identity)])).digest('hex');
}
module.exports = { from, bind, sourceBinding, SOURCES };
