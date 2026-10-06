'use strict';

/**
 * edit_file ON A CRLF FILE (2026-10-06) — a Windows checkout (core.autocrlf) has CRLF files and a model sends LF text.
 * The edit is matched in the file's own line ending and written in it: no false "not found", no mixed endings.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const tool = require('../../src/tools/fs').tools.edit_file;

  await test('EDIT_FILE CRLF: LF `old` text matches a CRLF file; the result stays CRLF throughout', async () => {
    const d = tmpdir('lain-crlf-');
    fs.writeFileSync(path.join(d, 'app.js'), "function go() {\r\n    location.href = 'profile.html';\r\n    done();\r\n}\r\n");
    const r = await tool.run({ path: 'app.js', old: "    location.href = 'profile.html';\n    done();\n", new: '    open();\n    done();\n' }, { cwd: d });
    assert.ok(!r.isError, r.output);
    const s = fs.readFileSync(path.join(d, 'app.js'), 'utf8');
    assert.strictEqual(s, 'function go() {\r\n    open();\r\n    done();\r\n}\r\n');
    assert.ok(!/(^|[^\r])\n/.test(s), 'no bare LF');
  });

  await test('EDIT_FILE CRLF: an LF file and an exact CRLF `old` behave exactly as before; a real miss still says not found', async () => {
    const d = tmpdir('lain-crlf-');
    fs.writeFileSync(path.join(d, 'a.txt'), 'x\ny\n');
    assert.ok(!(await tool.run({ path: 'a.txt', old: 'x\ny', new: 'z' }, { cwd: d })).isError);
    assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'z\n');
    fs.writeFileSync(path.join(d, 'b.txt'), 'p\r\nq\r\n');
    assert.ok(!(await tool.run({ path: 'b.txt', old: 'p\r\nq', new: 'r\r\ns' }, { cwd: d })).isError);
    assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'r\r\ns\r\n');
    const miss = await tool.run({ path: 'b.txt', old: 'nope\nnever', new: '' }, { cwd: d });
    assert.ok(miss.isError && /not found/.test(miss.output));
  });
};
