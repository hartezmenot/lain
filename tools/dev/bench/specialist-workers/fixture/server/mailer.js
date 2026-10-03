// Digest emails: builds the weekly/daily digest body (sending is stubbed).

export function digestBody(settings, notes) {
  const lines = notes.slice(0, 10).map((n) => `- ${n.author}: ${n.text}`);
  return `${settings.workspaceName} — ${settings.digest} digest\n\n${lines.join('\n')}`;
}

export async function send(to, subject, body) {
  return { queued: true, to, subject, bytes: Buffer.byteLength(body) };
}
