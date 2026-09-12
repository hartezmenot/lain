'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const artifacts = require('./artifacts');

const OPS = Object.freeze({
  spreadsheet: new Set(['trim_text', 'remove_blank_rows', 'deduplicate', 'normalize_dates', 'sort_rows', 'format_table', 'autofit', 'chart']),
  image: new Set(['resize', 'upscale', 'crop', 'rotate', 'sharpen', 'denoise', 'brightness', 'contrast', 'saturation', 'autocontrast', 'grayscale', 'flatten_background', 'remove_background']),
  document: new Set(['replace_text', 'append_text']),
});

function cleanOperations(kind, operations) {
  const allowed = OPS[kind];
  if (!allowed || !Array.isArray(operations) || !operations.length || operations.length > 12) return null;
  const out = [];
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object' || !allowed.has(raw.op)) return null;
    const row = { op: raw.op };
    for (const key of ['header_row', 'width', 'height', 'x', 'y', 'degrees', 'factor', 'radius']) {
      if (Number.isFinite(raw[key])) row[key] = raw[key];
    }
    for (const key of ['color', 'chart_type', 'title', 'anchor', 'find', 'replace', 'text']) {
      if (typeof raw[key] === 'string') row[key] = raw[key].slice(0, key === 'text' ? 10000 : 500);
    }
    if (Array.isArray(raw.columns)) row.columns = raw.columns.slice(0, 50).map((x) => String(x).slice(0, 120));
    if (typeof raw.expand === 'boolean') row.expand = raw.expand;
    if (typeof raw.descending === 'boolean') row.descending = raw.descending;
    out.push(row);
  }
  return out;
}

function cleanSheetsData(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) return null;
  let cells = 0;
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) return null;
    const rows = [];
    for (const source of raw.rows.slice(0, 5000)) {
      if (!Array.isArray(source)) return null;
      const row = source.slice(0, 200).map((cell) => {
        if (cell == null || typeof cell === 'number' || typeof cell === 'boolean') return cell;
        return String(cell).slice(0, 5000);
      });
      cells += row.length;
      if (cells > 100000) return null;
      rows.push(row);
    }
    out.push({ name: String(raw.name || `Sheet${out.length + 1}`).slice(0, 31), rows });
  }
  return out;
}

function outputName(kind, inputName, format, action = 'transform') {
  const source = artifacts.safeName(inputName || kind), stem = path.basename(source, path.extname(source)).slice(0, 70) || 'result';
  if (kind === 'spreadsheet') {
    const ext = path.extname(source).toLowerCase();
    return `${stem}-${action === 'create' ? 'created' : 'cleaned'}${['.xlsx', '.xlsm', '.csv'].includes(ext) ? ext : '.xlsx'}`;
  }
  if (kind === 'image') {
    const ext = String(format || 'png').toLowerCase().replace('jpeg', 'jpg');
    return ['png', 'jpg', 'webp', 'gif'].includes(ext) ? `${stem}-edited.${ext}` : null;
  }
  const ext = String(format || 'docx').toLowerCase();
  return ['docx', 'pdf'].includes(ext) ? `${stem}-${inputName ? 'edited' : 'created'}.${ext}` : null;
}

function requiredModule(payload) {
  if (payload.kind === 'spreadsheet' && (payload.action === 'create' || !/\.csv$/i.test(payload.input || ''))) return 'openpyxl';
  if (payload.kind === 'image') return 'PIL';
  if (payload.kind === 'document' && payload.action !== 'create' && /\.pdf$/i.test(payload.input || '')) return 'pypdf';
  return '';
}

async function capablePython(app, payload, signal) {
  const exec = require('../tools/exec'), first = exec.findPython(app.cfg || {});
  if (!first.ok) return first;
  const configured = (app.cfg?.python?.exe) || (app.cfg?.probe?.python) || process.env.LAIN_PYTHON;
  const candidates = [configured, first.exe, 'python3', 'python', 'py'].filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter(value => path.isAbsolute(value) ? fs.existsSync(value) : exec.onPath(value));
  const module = requiredModule(payload);
  if (!module) return { ok: true, exe: candidates[0] };
  for (const exe of candidates) {
    const probe = await exec.execute(exe, ['-c', `import ${module}`], {
      cwd: app.session.cwd, signal, timeoutMs: 10000,
    });
    if (probe.ok) return { ok: true, exe };
    if (probe.interrupted) return { ok: false, interrupted: true, why: 'the operation was cancelled' };
  }
  return { ok: false, why: `${module} is not installed in any configured Python runtime` };
}

async function invoke(app, payload, signal) {
  const py = await capablePython(app, payload, signal);
  if (!py.ok) return { ok: false, class: py.interrupted ? 'CANCELLED' : 'UNSUPPORTED', why: py.why };
  const run = await require('../tools/exec').execute(py.exe, [path.join(__dirname, 'worker.py')], {
    cwd: app.session.cwd, input: JSON.stringify(payload), signal: signal || app.abort?.signal, timeoutMs: 240000,
  });
  if (run.interrupted) return { ok: false, class: 'CANCELLED', why: 'the operation was cancelled' };
  if (!run.ok) return { ok: false, class: 'FAILED', why: 'the deterministic worker did not finish' };
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, class: 'FAILED', why: 'invalid worker result' };
  } catch { return { ok: false, class: 'FAILED', why: 'invalid worker result' }; }
}

async function run(app, options = {}) {
  const { kind, inputRef, action = 'inspect', operations = [], sheets = [], format = '', quality, signal } = options;
  if (!app?.session?.cowork) return { ok: false, class: 'PERMISSION_REQUIRED', why: 'this tool is available only in a Cowork session' };
  if (!OPS[kind]) return { ok: false, class: 'UNSUPPORTED', why: 'unknown Cowork file capability' };
  const creating = action === 'create';
  const rec = creating ? null : artifacts.find(app, inputRef);
  if (!creating && !rec) return { ok: false, class: 'PERMISSION_REQUIRED', why: 'that artifact is not owned by this Cowork session' };
  const extension = rec ? path.extname(rec.name).toLowerCase() : '';
  const allowed = kind === 'spreadsheet' ? ['.xlsx', '.xlsm', '.csv', '.xls']
    : kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']
      : ['.txt', '.md', '.csv', '.docx', '.pdf'];
  if (!creating && !allowed.includes(extension)) return { ok: false, class: 'UNSUPPORTED', why: `the input is not a supported ${kind} file` };
  const clean = action === 'transform' ? cleanOperations(kind, operations) : [];
  if (action === 'transform' && !clean) return { ok: false, class: 'FAILED', why: `choose 1-12 supported ${kind} operations` };
  const sheetsData = kind === 'spreadsheet' && creating ? cleanSheetsData(options.sheetsData) : null;
  if (kind === 'spreadsheet' && creating && !sheetsData) return { ok: false, class: 'FAILED', why: 'workbook creation needs 1-20 bounded sheets' };
  const paragraphs = kind === 'document' && creating && Array.isArray(options.paragraphs)
    ? options.paragraphs.slice(0, 500).map((value) => String(value).slice(0, 10000)) : null;
  if (kind === 'document' && creating && !paragraphs) return { ok: false, class: 'FAILED', why: 'document creation needs paragraphs' };
  const scratch = require('../scratch'), nonce = crypto.randomBytes(8).toString('hex');
  const input = rec ? scratch.file(app.session.cwd, app.session.id, `cowork-${nonce}-input${extension}`) : '';
  const name = outputName(kind, rec?.name || options.name || kind, format, action);
  if (action !== 'inspect' && !name) return { ok: false, class: 'UNSUPPORTED', why: 'unsupported output format' };
  const output = action === 'inspect' ? '' : scratch.file(app.session.cwd, app.session.id, `cowork-${nonce}-${name}`);
  try {
    if (rec) {
      const body = artifacts.bytes(app, inputRef);
      if (!body || body.length > artifacts.MAX_BODY) return { ok: false, class: 'FAILED', why: 'owned input bytes are unavailable' };
      fs.writeFileSync(input, body, { flag: 'wx', mode: 0o600 });
    }
    const background = kind === 'image' && clean?.some((row) => row.op === 'remove_background')
      ? require('./contract').localBackgroundProvider(app.cfg || {}) : null;
    const result = await invoke(app, {
      kind, action, input, output, operations: clean, sheets: Array.isArray(sheets) ? sheets.slice(0, 50).map(value => String(value).slice(0, 120)) : [],
      sheets_data: sheetsData, paragraphs, title: String(options.title || '').slice(0, 300), format, quality,
      ...(background ? { background_runner: { program: background.program, script: background.script } } : {}),
    }, signal);
    const capability = kind === 'image' && clean?.some((row) => row.op === 'remove_background') ? 'imageBackgroundRemoval' : kind;
    require('./contract').note(app, capability, result.ok ? { state: 'AVAILABLE' }
      : { state: result.class === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'CONFIGURED', why: result.why });
    if (!result.ok || action === 'inspect') return result;
    const made = fs.readFileSync(output);
    if (!made.length || made.length > artifacts.MAX_BODY) return { ok: false, class: 'UNSUPPORTED', why: 'finished artifact exceeds the 2 MiB artifact limit' };
    const kept = artifacts.keep(app, { name, mime: artifacts.mimeFor(name), body: made, note: `Cowork output: ${kind}` });
    return kept ? { ...result, artifact: kept } : { ok: false, class: 'FAILED', why: 'the finished file could not be registered as a task artifact' };
  } catch { return { ok: false, class: 'FAILED', why: 'the owned file could not be processed' }; }
  finally {
    for (const target of [input, output]) if (target) try { fs.unlinkSync(target); } catch { /* scratch lifecycle owns leftovers */ }
  }
}

module.exports = { run, invoke, capablePython, requiredModule, cleanOperations, cleanSheetsData, outputName, OPS };
