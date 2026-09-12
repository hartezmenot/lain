'use strict';

function forSession(session) {
  if (!session?.cowork) return '';
  return `# Cowork lane
Complete the requested work and return the finished result or artifact. Prefer Cowork deterministic tools for files, spreadsheets, documents, PDFs and images; use reasoning to choose intent and parameters. Cowork inputs are opaque cwa_ references, never host paths. Keep input artifacts unchanged and create task-owned outputs. For email, create a reviewable draft before sending; sends, archives and deletes require per-action approval and must never be reported as complete without their tool result. When this request came from messaging, use cowork_deliver_artifact to return finished files to the originating conversation. Use existing file tools and permission gates for workspace changes. Keep public activity concise. Classify ordinary inability as AUTH_REQUIRED, PERMISSION_REQUIRED, UNSUPPORTED, RATE_LIMITED, FAILED, CANCELLED or INCONCLUSIVE; do not dump raw provider payloads.`;
}

module.exports = { forSession };
