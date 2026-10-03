'use strict';

/**
 * IMPORT, EXTENSIONS AND PLUGINS — each claim LAIN makes about them, tested
 * against real files in a run-owned folder (never the person's VS Code).
 *
 *   import       reads VS Code's files, writes only LAIN's editor profile,
 *                and reports every setting/key it could not apply
 *   zip          a .vsix entry that would land outside its folder is refused
 *   extensions   install from a .vsix and a folder, snippets used, code never
 *                run, enable/disable/uninstall
 *   plugins      installed disabled; enabling needs the listed grant; a tool
 *                outside the grant is refused by the tool gate
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const vscodeimport = require('../../src/vscodeimport');
const editorprofile = require('../../src/editorprofile');
const zipread = require('../../src/zipread');
const extensions = require('../../src/extensions');
const plugins = require('../../src/plugins');

/** A minimal zip writer: deflated entries, one central directory. */
function makeZip(file, entries) {
  const locals = [];
  const cens = [];
  let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(n.length, 26);
    locals.push(loc, n, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    cens.push(cen, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

const SNIPPETS_PKG = JSON.stringify({
  name: 'tiny-snippets', publisher: 'acme', version: '1.2.3', displayName: 'Tiny Snippets',
  contributes: { snippets: [{ language: 'javascriptreact', path: './snippets/js.json' }], themes: [{ label: 'x', path: './t.json' }] },
});
const SNIPPETS = JSON.stringify({ Log: { prefix: 'clg', body: ['console.log($1);'], description: 'log' } });

module.exports = async function () {
  const home = isolation.tmp('xt-home-');
  const cfg = isolation.tmp('xt-cfg-');
  const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), USERPROFILE: home };
  const user = path.join(env.APPDATA, 'Code', 'User');
  fs.mkdirSync(path.join(user, 'snippets'), { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), [
    '// mine',
    '{',
    '  "editor.fontSize": 15,',
    '  "editor.tabSize": 4, // four',
    '  "editor.minimap.enabled": false,',
    '  "editor.wordWrap": "sometimes",',
    '  "workbench.colorTheme": "Monokai",',
    '  "files.exclude": { "**/*.pyc": true },',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(user, 'keybindings.json'), JSON.stringify([
    { key: 'ctrl+shift+k', command: 'editor.action.deleteLines' },
    { key: 'f12', command: 'editor.action.revealDefinition' },
    { key: 'ctrl+k ctrl+c', command: 'editor.action.addCommentLine' },
    { key: 'ctrl+alt+t', command: 'workbench.action.terminal.new' },
    { key: 'ctrl+d', command: '-editor.action.addSelectionToNextFindMatch' },
  ]));
  fs.writeFileSync(path.join(user, 'snippets', 'python.json'), JSON.stringify({ Main: { prefix: 'ifmain', body: ['if __name__ == "__main__":', '    $0'] } }));
  fs.writeFileSync(path.join(user, 'snippets', 'mine.code-snippets'), JSON.stringify({ Todo: { prefix: 'todo', body: 'TODO: $1', scope: 'javascript,typescriptreact' }, Any: { prefix: 'hr', body: '----' } }));
  const extDir = path.join(home, '.vscode', 'extensions', 'acme.withcode-1.0.0');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: 'withcode', publisher: 'acme', version: '1.0.0', main: './out/extension.js' }));

  await test('IMPORT: only what LAIN applies is imported, and the rest says why', () => {
    const before = fs.readFileSync(path.join(user, 'settings.json'), 'utf8');
    const p = vscodeimport.preview('vscode', env);
    assert.ok(p.ok, p.why);
    assert.deepStrictEqual(p.settings.applied.map((s) => s.key).sort(), ['editor.fontSize', 'editor.minimap.enabled', 'editor.tabSize']);
    const why = Object.fromEntries(p.settings.unsupported.map((s) => [s.key, s.why]));
    assert.ok(/not one LAIN accepts/.test(why['editor.wordWrap']), 'a value Monaco does not take is reported, not applied');
    assert.ok(/palette/.test(why['workbench.colorTheme']));
    assert.strictEqual(p.settings.theme, 'Monokai');
    assert.deepStrictEqual(p.keybindings.applied.map((k) => k.command), ['editor.action.deleteLines', 'lain.goToDefinition', 'editor.action.addCommentLine'], 'a two-part chord is imported');
    assert.ok(p.keybindings.applied.some((k) => k.key === 'ctrl+k ctrl+c'));
    const kwhy = p.keybindings.unsupported.map((k) => k.why).join(' | ');
    assert.ok(/not an editor command/.test(kwhy) && /removes a default/.test(kwhy), kwhy);
    assert.ok(!require('../../src/editorprofile').keybinding({ key: 'ctrl+k ctrl+c ctrl+d', command: 'editor.action.deleteLines' }).ok, 'longer than VS Code allows is refused');
    assert.strictEqual(p.snippets.count, 4, 'python + two scoped + one global');
    assert.ok(p.extensions.every((x) => x.usable === false), 'no extension is claimed to work');
    assert.ok(/extension host/.test(p.extensions[0].why));
    const r = vscodeimport.apply('vscode', {}, { env, configDir: cfg });
    assert.ok(r.ok, r.why);
    const prof = editorprofile.read(cfg);
    assert.strictEqual(prof.settings.fontSize, 15);
    assert.strictEqual(prof.settings['minimap.enabled'], false);
    assert.ok(prof.snippets.python && prof.snippets.javascript && prof.snippets.typescript && prof.snippets['*']);
    assert.strictEqual(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'), before, 'VS Code\'s own file is untouched');
  });

  await test('ZIP: a .vsix entry that escapes its folder is refused before anything is written', () => {
    const bad = path.join(isolation.tmp('xt-zip-'), 'evil.vsix');
    makeZip(bad, [['extension/package.json', '{}'], ['extension/../../escape.txt', 'x']]);
    const dest = isolation.tmp('xt-dest-');
    assert.throws(() => zipread.extract(bad, dest, { prefix: 'extension/' }), /outside the install folder/);
    assert.deepStrictEqual(fs.readdirSync(dest), [], 'nothing was extracted');
    assert.strictEqual(zipread.safe('C:/Windows/x'), null);
    assert.strictEqual(zipread.safe('a/b/../c'), 'a/c');
  });

  await test('EXTENSIONS: a .vsix installs, its snippets are offered, its code is never run', async () => {
    const vsix = path.join(isolation.tmp('xt-vsix-'), 'tiny.vsix');
    makeZip(vsix, [['extension.vsixmanifest', '<x/>'], ['extension/package.json', SNIPPETS_PKG], ['extension/snippets/js.json', SNIPPETS]]);
    const r = await extensions.install({ vsix }, { configDir: cfg });
    assert.ok(r.ok, r.why);
    assert.strictEqual(r.extension.id, 'acme.tiny-snippets');
    assert.deepStrictEqual(r.extension.uses, ['snippets for javascript']);
    assert.ok(r.extension.notUsed.includes('contributes.themes'));
    const sn = extensions.snippets({ configDir: cfg });
    assert.strictEqual(sn.javascript[0].prefix[0], 'clg');
    assert.ok(extensions.setEnabled('acme.tiny-snippets', false, { configDir: cfg }).ok);
    assert.deepStrictEqual(extensions.snippets({ configDir: cfg }), {}, 'a disabled extension offers nothing');
    assert.ok(extensions.uninstall('acme.tiny-snippets', { configDir: cfg }).ok);
    assert.strictEqual(extensions.list({ configDir: cfg }).length, 0);
    assert.ok(!(await extensions.install({ url: 'http://example.com/x.vsix' }, { configDir: cfg })).ok, 'plain http is refused');
  });

  await test('EXTENSIONS: an extension with code is kept as data; its code is listed as not run', async () => {
    const r = await extensions.install({ folder: extDir }, { configDir: cfg });
    assert.ok(r.ok, r.why);
    assert.strictEqual(r.extension.code, true);
    assert.ok(/does not run/.test(r.extension.notUsed[0]));
    assert.ok(!/require\(/.test(fs.readFileSync(require.resolve('../../src/extensions'), 'utf8').replace(/require\('[^']+'\)/g, '')), 'extensions.js requires nothing dynamic');
  });

  await test('PLUGINS: installed disabled; enabled only with the listed grant; the tool gate enforces it', () => {
    const src = isolation.tmp('xt-plugin-');
    fs.writeFileSync(path.join(src, 'lain-plugin.json'), JSON.stringify({
      id: 'acme.review', name: 'Review', version: '1.0.0', permissions: ['write'],
      commands: [{ id: 'review', title: 'Review file', prompt: 'Review {{file}}: {{selection}}' }],
      hooks: [{ event: 'afterSave', command: 'echo hi' }],
    }));
    assert.ok(!plugins.validate({ id: 'x', permissions: ['root'] }).ok, 'an unknown permission is refused');
    const i = plugins.install(src, { configDir: cfg });
    assert.ok(i.ok && i.needsGrant, JSON.stringify(i));
    assert.ok(!plugins.prepare('acme.review', 'review', { configDir: cfg }).ok, 'a disabled plugin cannot run');
    assert.ok(!plugins.enable('acme.review', { grant: [], configDir: cfg }).ok, 'enabling needs the listed permissions');
    assert.ok(plugins.enable('acme.review', { grant: ['write'], configDir: cfg }).ok);
    const p = plugins.prepare('acme.review', 'review', { configDir: cfg, ide: { file: 'a.js', selection: { text: 'foo()' } } });
    assert.ok(p.ok);
    assert.strictEqual(p.text, 'Review a.js: foo()');
    const session = { _pluginGrant: p.grant };
    assert.strictEqual(plugins.denies(session, 'read_file', { mutates: false }), null, 'reading is always allowed');
    assert.strictEqual(plugins.denies(session, 'edit_file', { mutates: true }), null, 'write was granted');
    assert.ok(/PLUGIN_PERMISSION/.test(plugins.denies(session, 'run_bash', { mutates: true })), 'shell was not');
    assert.ok(/PLUGIN_PERMISSION/.test(plugins.denies(session, 'web_fetch', { mutates: false })), 'nor network');
    assert.strictEqual(plugins.denies({}, 'run_bash', { mutates: true }), null, 'no grant, no plugin rule');
    assert.ok(plugins.list({ configDir: cfg })[0].notRun.hooks, 'hooks are declared, and said not to run');
    assert.ok(plugins.uninstall('acme.review', { configDir: cfg }).ok);
  });

};
