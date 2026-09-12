'use strict';

const fs = require('fs');
const path = require('path');
const redact = require('../redact');

const FAILURE = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED', PERMISSION_REQUIRED: 'PERMISSION_REQUIRED', UNSUPPORTED: 'UNSUPPORTED',
  RATE_LIMITED: 'RATE_LIMITED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', INCONCLUSIVE: 'INCONCLUSIVE',
});

function observed(app, id, fallback) { return app?._coworkCapabilities?.[id] || fallback; }

function localBackgroundProvider(cfg = {}) {
  const custom = cfg?.cowork?.image?.backgroundRemoval || {};
  const candidates = [];
  if (custom.program && custom.script) candidates.push({ program: custom.program, script: custom.script, provider: 'configured' });
  if (process.platform === 'win32') candidates.push({
    program: 'E:\\AI\\tools\\vision-venv\\Scripts\\python.exe',
    script: 'E:\\AI\\tools\\birefnet_run.py', provider: 'local-birefnet',
  });
  return candidates.find((row) => path.isAbsolute(row.program) && path.isAbsolute(row.script)
    && fs.existsSync(row.program) && fs.statSync(row.program).isFile()
    && fs.existsSync(row.script) && fs.statSync(row.script).isFile()) || null;
}

function capabilities(app) {
  const py = require('../tools/exec').findPython(app?.cfg || {}), background = localBackgroundProvider(app?.cfg || {});
  let desktop = false;
  try { desktop = require('../mcp').configured(app?.cfg || {}); } catch { desktop = false; }
  return {
    files: { state: 'AVAILABLE', operations: ['attach', 'list', 'retrieve', 'organize-with-existing-file-tools'] },
    artifacts: { state: 'AVAILABLE', persisted: true, maxBytes: require('../harness/artifacts').MAX_BODY },
    background: { state: 'AVAILABLE', settleEvent: true, maxSecondaryJobs: 2 },
    approvals: { state: 'AVAILABLE', authority: 'existing' },
    spreadsheet: observed(app, 'spreadsheet', py.ok ? { state: 'CONFIGURED' } : { state: 'UNSUPPORTED', why: py.why }),
    image: observed(app, 'image', py.ok ? { state: 'CONFIGURED' } : { state: 'UNSUPPORTED', why: py.why }),
    imageBackgroundRemoval: observed(app, 'imageBackgroundRemoval', background
      ? { state: 'CONFIGURED', provider: background.provider }
      : { state: 'UNCONFIGURED', why: 'no rembg or BiRefNet provider is configured' }),
    document: observed(app, 'document', py.ok ? { state: 'CONFIGURED' } : { state: 'UNSUPPORTED', why: py.why }),
    pdf: observed(app, 'pdf', py.ok ? { state: 'CONFIGURED' } : { state: 'UNSUPPORTED', why: py.why }),
    research: { state: 'AVAILABLE', authority: 'existing-web-fetch' },
    desktop: { state: desktop ? 'CONFIGURED' : 'UNCONFIGURED' },
    email: { state: 'UNCONFIGURED', why: 'no Cowork email account authority is connected' },
    calendar: { state: 'UNCONFIGURED', why: 'no Cowork calendar account authority is connected' },
    contacts: { state: 'UNCONFIGURED', why: 'no Cowork contacts account authority is connected' },
    reminders: { state: 'UNCONFIGURED', why: 'no Cowork reminder service is connected' },
    notes: { state: 'UNCONFIGURED', why: 'no Cowork personal notes service is connected' },
  };
}

function note(app, id, value) {
  if (!app || !id || !value) return;
  app._coworkCapabilities ||= {};
  app._coworkCapabilities[id] = { state: value.state,
    ...(value.why ? { why: safeText(value.why, 160) } : {}), ...(value.operations ? { operations: value.operations } : {}) };
}

function safeText(value, max = 240) { return redact.text(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max); }

module.exports = { FAILURE, capabilities, note, safeText, localBackgroundProvider };
