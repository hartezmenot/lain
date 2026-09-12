'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try { request = JSON.parse(input); } catch { process.stdout.write(JSON.stringify({ ok: false, class: 'FAILED', why: 'invalid request' })); return; }
  if (!process.env.FIXTURE_EMAIL_TOKEN || input.includes(process.env.FIXTURE_EMAIL_TOKEN)) {
    process.stdout.write(JSON.stringify({ ok: false, class: 'AUTH_REQUIRED', why: 'credential isolation failed' })); return;
  }
  const op = request.operation;
  if (op === 'search') process.stdout.write(JSON.stringify({ ok: true, data: { messages: [{ id: 'm-1', from: 'sender@example.com', to: ['owner@example.com'], subject: 'Quarterly update', snippet: 'Ready for review', date: '2026-09-12T08:00:00Z' }] } }));
  else if (op === 'read') process.stdout.write(JSON.stringify({ ok: true, data: { message: { id: request.input.messageId, from: 'sender@example.com', to: ['owner@example.com'], subject: 'Quarterly update', body: 'Full fixture message.' } } }));
  else if (op === 'send') process.stdout.write(JSON.stringify({ ok: true, data: { messageId: 'sent-42', sentAt: '2026-09-12T09:00:00Z' } }));
  else if (op === 'archive' || op === 'delete') process.stdout.write(JSON.stringify({ ok: true, data: { messageId: request.input.messageId } }));
  else process.stdout.write(JSON.stringify({ ok: false, class: 'UNSUPPORTED', why: 'unsupported fixture operation' }));
});
