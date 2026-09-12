'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const child = require('child_process');
const { test, tmpdir } = require('../helpers');
const binding = require('../../src/cowork/sessionstate');
const artifacts = require('../../src/cowork/artifacts');
const worker = require('../../src/cowork/worker');

function appAt(cwd) {
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, isTTY: false }, interactive: false, cwd });
  binding.bind(app.session, 'harness', binding.sourceBinding('harness', [app.session.id, cwd]));
  const harness = require('../../src/harnesslink').harnessFor(app);
  const task = harness.begin({ title: 'Cowork file integration', objective: 'process real owned bytes', sessionId: app.session.id });
  harness.runtime.start(task.id);
  return app;
}

module.exports = async function () {
  await test('COWORK FILES: CSV cleanup produces a new artifact and preserves the input', async () => {
    const app = appAt(tmpdir('cowork-files-'));
    const input = artifacts.keep(app, { name: 'people.csv', body: Buffer.from('name,date\n Alice ,2026-01-01\n\n Alice ,2026-01-01\nBob,2026-02-03\n') });
    const result = await worker.run(app, { kind: 'spreadsheet', inputRef: input.ref, action: 'transform', operations: [
      { op: 'trim_text' }, { op: 'remove_blank_rows' }, { op: 'deduplicate' },
    ] });
    assert.strictEqual(result.ok, true, result.why); assert.match(result.artifact.ref, /^cwa_/);
    assert.match(artifacts.bytes(app, input.ref).toString(), /^name,date\n Alice/);
    assert.strictEqual(artifacts.bytes(app, result.artifact.ref).toString('utf8').replace(/^\uFEFF/, ''), 'name,date\r\nAlice,2026-01-01\r\nBob,2026-02-03\r\n');
  });

  await test('COWORK FILES: XLSX creation and cleanup preserve formulas, first duplicate, formatting and chart', async () => {
    const app = appAt(tmpdir('cowork-files-'));
    const created = await worker.run(app, { kind: 'spreadsheet', action: 'create', name: 'sales.xlsx', sheetsData: [{ name: 'Data', rows: [
      ['Name', 'Score', 'Double'], [' Alice ', 10, '=B2*2'], [' Alice ', 20, '=B3*2'], ['Bob', 5, '=B4*2'],
    ] }] });
    if (!created.ok) { assert.strictEqual(created.class, 'UNSUPPORTED'); return; }
    const cleaned = await worker.run(app, { kind: 'spreadsheet', inputRef: created.artifact.ref, action: 'transform', operations: [
      { op: 'trim_text' }, { op: 'deduplicate', columns: ['Name'] }, { op: 'format_table' }, { op: 'chart', columns: ['Score', 'Name'], chart_type: 'bar' },
    ] });
    assert.strictEqual(cleaned.ok, true, cleaned.why);
    const py = await worker.capablePython(app, { kind: 'spreadsheet', action: 'create' });
    const file = path.join(app.session.cwd, 'checked.xlsx'); fs.writeFileSync(file, artifacts.bytes(app, cleaned.artifact.ref));
    const facts = child.execFileSync(py.exe, ['-c', "import json,openpyxl,sys;s=openpyxl.load_workbook(sys.argv[1],data_only=False).active;print(json.dumps(dict(rows=s.max_row,first=s['B2'].value,formula=s['C2'].value,last=s['A3'].value,charts=len(s._charts),frozen=str(s.freeze_panes))))", file], { encoding: 'utf8', windowsHide: true });
    assert.deepStrictEqual(JSON.parse(facts), { rows: 3, first: 10, formula: '=B2*2', last: 'Bob', charts: 1, frozen: 'A2' });
  });

  await test('COWORK FILES: image inspection and resize return measured verified artifacts', async () => {
    const app = appAt(tmpdir('cowork-files-'));
    const input = artifacts.keep(app, { name: 'pixel.png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    const result = await worker.run(app, { kind: 'image', inputRef: input.ref, action: 'transform', operations: [{ op: 'resize', width: 4, height: 3 }], format: 'png' });
    if (!result.ok) { assert.strictEqual(result.class, 'UNSUPPORTED'); return; }
    assert.strictEqual(result.facts.width, 4); assert.strictEqual(result.facts.height, 3); assert.ok(artifacts.bytes(app, result.artifact.ref).length);
  });

  await test('COWORK FILES: DOCX creation is readable and PDF creation is a valid owned result', async () => {
    const app = appAt(tmpdir('cowork-files-'));
    const docx = await worker.run(app, { kind: 'document', action: 'create', name: 'brief', title: 'Quarterly brief', paragraphs: ['Revenue increased.', 'Next review Friday.'], format: 'docx' });
    assert.strictEqual(docx.ok, true, docx.why);
    const inspected = await worker.run(app, { kind: 'document', inputRef: docx.artifact.ref, action: 'inspect' });
    assert.strictEqual(inspected.ok, true, inspected.why); assert.match(inspected.facts.text, /Quarterly brief/); assert.match(inspected.facts.text, /Revenue increased/);
    const pdf = await worker.run(app, { kind: 'document', action: 'create', name: 'brief', title: 'Quarterly brief', paragraphs: ['Revenue increased.'], format: 'pdf' });
    assert.strictEqual(pdf.ok, true, pdf.why); assert.strictEqual(artifacts.bytes(app, pdf.artifact.ref).subarray(0, 5).toString(), '%PDF-');
    const pdfFacts = await worker.run(app, { kind: 'document', inputRef: pdf.artifact.ref, action: 'inspect' });
    if (pdfFacts.ok) { assert.strictEqual(pdfFacts.facts.pages, 1); assert.match(pdfFacts.facts.text, /Revenue increased/); }
    else assert.strictEqual(pdfFacts.class, 'UNSUPPORTED');

    const edited = await worker.run(app, { kind: 'document', inputRef: docx.artifact.ref, action: 'transform', format: 'pdf', operations: [
      { op: 'replace_text', find: 'Revenue increased.', replace: 'Revenue increased by 12%.' },
      { op: 'append_text', text: 'Approved for circulation.' },
    ] });
    assert.strictEqual(edited.ok, true, edited.why);
    const editedFacts = await worker.run(app, { kind: 'document', inputRef: edited.artifact.ref, action: 'inspect' });
    if (editedFacts.ok) { assert.match(editedFacts.facts.text, /12%/); assert.match(editedFacts.facts.text, /Approved for circulation/); }
    else assert.strictEqual(editedFacts.class, 'UNSUPPORTED');
  });
};
