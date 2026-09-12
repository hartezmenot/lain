'use strict';

const artifacts = require('./artifacts');
const contract = require('./contract');
const services = require('./services');

const MAX_BODY = 40_000;
const MAX_ATTACHMENT_BYTES = artifacts.MAX_BODY;

function text(value, max = 1000) { return contract.safeText(value, max); }
function bodyText(value) { return String(value == null ? '' : value).replace(/\0/g, '').slice(0, MAX_BODY); }
function addresses(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map(v => String(v).trim()).filter(v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))].slice(0, 50);
}
function draftInput(input = {}) {
  const draft = { version: 1, kind: 'email-draft', to: addresses(input.to), cc: addresses(input.cc), bcc: addresses(input.bcc),
    subject: text(input.subject, 500), body: bodyText(input.body), replyTo: text(input.reply_to || input.replyTo, 200),
    attachmentRefs: [...new Set((input.attachment_refs || []).map(String))].slice(0, 8) };
  if (!draft.to.length) return { ok: false, class: contract.FAILURE.FAILED, why: 'at least one valid recipient is required' };
  if (!draft.subject && !draft.body) return { ok: false, class: contract.FAILURE.FAILED, why: 'the draft needs a subject or body' };
  return { ok: true, draft };
}
function loadDraft(app, ref) {
  const rec = artifacts.find(app, ref), bytes = artifacts.bytes(app, ref);
  if (!rec || !bytes || !rec.name.endsWith('.email-draft.json')) return { ok: false, class: contract.FAILURE.PERMISSION_REQUIRED, why: 'that email draft is not owned by this Cowork session' };
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    const cleaned = draftInput({ ...parsed, attachment_refs: parsed.attachmentRefs });
    return cleaned.ok && parsed.kind === 'email-draft' ? cleaned : { ok: false, class: contract.FAILURE.FAILED, why: 'the owned email draft is invalid' };
  } catch { return { ok: false, class: contract.FAILURE.FAILED, why: 'the owned email draft is invalid' }; }
}
function materializeAttachments(app, refs) {
  const out = []; let total = 0;
  for (const ref of refs) {
    const rec = artifacts.find(app, ref), bytes = artifacts.bytes(app, ref);
    if (!rec || !bytes) return { ok: false, class: contract.FAILURE.PERMISSION_REQUIRED, why: `attachment ${text(ref, 60)} is not owned by this Cowork session` };
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) return { ok: false, class: contract.FAILURE.UNSUPPORTED, why: 'email attachments exceed the 2 MiB connector limit' };
    out.push({ name: rec.name, mime: rec.mime, data: bytes.toString('base64') });
  }
  return { ok: true, attachments: out };
}
function previewDraft(input, ctx) {
  if (!services.configured(ctx.app, 'email')) return { ok: false, class: contract.FAILURE.AUTH_REQUIRED, why: 'no Cowork email service is configured' };
  const loaded = loadDraft(ctx.app, input.draft_ref);
  if (!loaded.ok) return loaded;
  const d = loaded.draft;
  return { what: `Send email to ${d.to.join(', ')}`, reason: 'This will send through the connected email account.',
    details: [`Subject: ${d.subject || '(no subject)'}`, '', d.body.slice(0, 1200), d.attachmentRefs.length ? `\nAttachments: ${d.attachmentRefs.length}` : ''].join('\n') };
}
function previewMessage(action) { return (input, ctx) => services.configured(ctx.app, 'email')
  ? { what: `${action} email ${text(input.message_id, 120)}`, reason: `This will ${action.toLowerCase()} a message in the connected email account.` }
  : { ok: false, class: contract.FAILURE.AUTH_REQUIRED, why: 'no Cowork email service is configured' }; }
function rendered(result) { return result.ok ? { output: result.output, ...(result.artifact ? { artifact: result.artifact } : {}), meta: { classification: 'DONE' } }
  : { output: `${result.class}: ${result.why}`, isError: true, meta: { classification: result.class } }; }

function normalizeMessages(data) {
  return (Array.isArray(data?.messages) ? data.messages : []).slice(0, 50).map(row => ({ id: text(row?.id, 200), from: text(row?.from, 300),
    to: addresses(row?.to), subject: text(row?.subject, 500), snippet: text(row?.snippet, 1200), date: text(row?.date, 100) })).filter(row => row.id);
}

async function search(app, input, signal) {
  const r = await services.invoke(app, 'email', 'search', { query: text(input.query, 1000), limit: Math.max(1, Math.min(Number(input.limit) || 20, 50)) }, { signal });
  if (!r.ok) return r;
  const messages = normalizeMessages(r.data);
  return { ok: true, output: messages.length ? JSON.stringify({ messages }) : 'No matching email.' };
}
async function read(app, input, signal) {
  const r = await services.invoke(app, 'email', 'read', { messageId: text(input.message_id, 200) }, { signal });
  if (!r.ok) return r;
  const row = r.data?.message || r.data || {};
  return { ok: true, output: JSON.stringify({ message: { id: text(row.id, 200), from: text(row.from, 300), to: addresses(row.to), cc: addresses(row.cc),
    subject: text(row.subject, 500), date: text(row.date, 100), body: text(row.body, MAX_BODY), attachments: (Array.isArray(row.attachments) ? row.attachments : []).slice(0, 20).map(a => ({ name: text(a?.name, 200), mime: text(a?.mime, 100), bytes: Number(a?.bytes) || 0 })) } }) };
}
function createDraft(app, input) {
  const made = draftInput(input); if (!made.ok) return made;
  for (const ref of made.draft.attachmentRefs) if (!artifacts.find(app, ref)) return { ok: false, class: contract.FAILURE.PERMISSION_REQUIRED, why: `attachment ${text(ref, 60)} is not owned by this Cowork session` };
  const stem = text(input.name || made.draft.subject || 'email', 80).replace(/[^A-Za-z0-9._-]/g, '_') || 'email';
  const artifact = artifacts.keep(app, { name: `${stem}.email-draft.json`, mime: 'application/json', body: Buffer.from(JSON.stringify(made.draft, null, 2)), note: 'Cowork email draft' });
  return artifact ? { ok: true, artifact, output: `Email draft ready\nArtifact ${artifact.ref} · ${artifact.name}` } : { ok: false, class: contract.FAILURE.FAILED, why: 'the draft could not be stored as a task artifact' };
}
async function send(app, input, signal) {
  const loaded = loadDraft(app, input.draft_ref); if (!loaded.ok) return loaded;
  const material = materializeAttachments(app, loaded.draft.attachmentRefs); if (!material.ok) return material;
  const d = loaded.draft;
  const r = await services.invoke(app, 'email', 'send', { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, ...(d.replyTo ? { replyTo: d.replyTo } : {}), attachments: material.attachments }, { signal });
  if (!r.ok) return r;
  const receipt = { version: 1, kind: 'email-send-receipt', messageId: text(r.data?.messageId || r.data?.id, 200), sentAt: text(r.data?.sentAt, 100) || new Date().toISOString(), to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, replyTo: d.replyTo };
  const artifact = artifacts.keep(app, { name: 'email-send-receipt.json', mime: 'application/json', body: Buffer.from(JSON.stringify(receipt, null, 2)), note: 'External email send receipt' });
  return artifact ? { ok: true, artifact, output: `Email sent to ${d.to.join(', ')}\nReceipt ${artifact.ref} · ${artifact.name}` }
    : { ok: false, class: contract.FAILURE.INCONCLUSIVE, why: 'the provider reported success but the local receipt could not be stored' };
}
async function mutate(app, action, input, signal) {
  const r = await services.invoke(app, 'email', action, { messageId: text(input.message_id, 200) }, { signal });
  if (!r.ok) return r;
  const past = action === 'archive' ? 'archived' : 'deleted';
  const receipt = artifacts.keep(app, { name: `email-${action}-receipt.json`, mime: 'application/json', body: Buffer.from(JSON.stringify({
    version: 1, kind: `email-${action}-receipt`, messageId: text(input.message_id, 200), completedAt: text(r.data?.completedAt, 100) || new Date().toISOString(),
  }, null, 2)), note: `External email ${action} receipt` });
  return receipt ? { ok: true, artifact: receipt, output: `Email ${past}.\nReceipt ${receipt.ref} · ${receipt.name}` }
    : { ok: false, class: contract.FAILURE.INCONCLUSIVE, why: `the provider reported the email ${past} but the local receipt could not be stored` };
}

module.exports = { addresses, draftInput, loadDraft, materializeAttachments, previewDraft, previewMessage, rendered, normalizeMessages, search, read, createDraft, send, mutate };
