'use strict';

/**
 * A PICTURE BELONGS IN LAIN'S OWN WINDOW.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS PINS SHUT, observed in the wild:
 *
 *     file:///C:/Users/.../lain-test-home-.../visual/view/view-1789468899258.html
 *
 * Looking at `shot.png` generated an HTML page with an `<img>` in it, wrote it
 * into LAIN's config directory, and handed it to the machine's default viewer —
 * which on Windows is a BROWSER. So "show me the screenshot" opened a browser
 * tab pointed at a generated file:// page, put browser-era architecture in the
 * middle of the NATIVE application, and left the page on disk forever.
 *
 * A PNG needs no markup to be looked at.
 *
 * ------------------------------------------------------------------------
 * WHAT IS PROVEN HERE, as opposed to asserted about:
 *
 *   no view-*.html is produced, on either branch, ever
 *   an image is offered to the window BY REFERENCE, and a PATH is refused
 *   a running task ADOPTS it, so the evidence outlives the temp directory
 *   the bytes come back byte-for-byte, once, and are not in the poll payload
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const viewer = require('../../src/imageviewer');
const view = require('../../src/imageview');

/** A real 2×2 PNG, so the dimensions come from a header rather than a guess. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000020000000208060000007f'
  + 'a87d630000000d49444154789c6360600000000400012734270a0000000049454e44ae426082', 'hex');

function withImage(name = 'shot.png') {
  const dir = tmpdir('imgview-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG);
  return file;
}

/** An app with nothing but what the shelf needs. */
function session() { return { session: { id: 's1', cwd: tmpdir('imgproj-') } }; }

/** Every `view-<digits>.html` anywhere under a directory. */
function strayPages(root) {
  const found = [];
  const walk = (p, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^view-\d+\.html$/.test(e.name)) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

module.exports = async function () {
  await test('VIEWER: an image is offered by REFERENCE, and read back byte for byte', () => {
    const app = session();
    const file = withImage();
    const r = viewer.offer(app, file, { provenance: 'computer screenshot' });
    assert.strictEqual(r.ok, true, r.why);
    assert.match(r.ref, /^img_[0-9a-f]{24}$/, 'a reference, not a path');

    const pub = viewer.publicRecord(viewer.find(app, r.ref));
    assert.strictEqual(pub.name, 'shot.png');
    assert.strictEqual(pub.width, 2, 'measured from the PNG header, not assumed');
    assert.strictEqual(pub.height, 2);
    assert.strictEqual(pub.mime, 'image/png');
    assert.strictEqual(pub.provenance, 'computer screenshot');
    assert.ok(viewer.bytes(app, r.ref).equals(PNG), 'the bytes are the file');
  });

  await test('VIEWER: a PATH is not a reference, and a forged one resolves to nothing', () => {
    // THE WHOLE SECURITY OF THE ROUTE. If a path were accepted, the renderer —
    // or anything that could reach it — would read any file on the machine.
    const app = session();
    const file = withImage();
    viewer.offer(app, file, {});
    assert.strictEqual(viewer.find(app, file), null, 'the path it was offered as does not resolve');
    assert.strictEqual(viewer.find(app, 'img_000000000000000000000000'), null);
    assert.strictEqual(viewer.bytes(app, 'img_000000000000000000000000'), null);
    // AND ONE SESSION'S SHELF IS NOT ANOTHER'S.
    const other = session();
    const mine = viewer.offer(app, file, {});
    assert.strictEqual(viewer.find(other, mine.ref), null);
  });

  await test('VIEWER: what is not an image, and what is not there, are refused by name', () => {
    const app = session();
    const dir = tmpdir('imgview-');
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(notes, 'hello');
    assert.match(viewer.offer(app, notes, {}).why, /not an image/);
    assert.match(viewer.offer(app, path.join(dir, 'nope.png'), {}).why, /no file at that path/);
  });

  await test('VIEWER: the same picture offered twice is ONE entry, not a duplicate artifact', () => {
    const app = session();
    const file = withImage();
    const a = viewer.offer(app, file, {});
    const b = viewer.offer(app, file, {});
    assert.strictEqual(b.ref, a.ref);
    assert.strictEqual(b.reused, true);
    assert.strictEqual(app._imageShelf.size, 1);
  });

  await test('VIEWER: the shelf is bounded — a viewer is not an archive', () => {
    const app = session();
    const refs = [];
    for (let i = 0; i < viewer.MAX_OFFERED + 6; i++) refs.push(viewer.offer(app, withImage(`s${i}.png`), {}).ref);
    assert.strictEqual(app._imageShelf.size, viewer.MAX_OFFERED);
    assert.ok(viewer.find(app, refs[refs.length - 1]), 'the newest is kept — it is the one wanted');
    assert.strictEqual(viewer.find(app, refs[0]), null, 'and the oldest fell off');
  });

  await test('ADOPTION: a running task takes the picture as its own evidence', () => {
    // WHY IT MATTERS: the capture lands in a TEMPORARY directory. That directory
    // is swept, and a verification that rested on the picture then rests on
    // nothing. Adoption is the copy into the project's own evidence area.
    const cwd = tmpdir('imgtask-');
    const app = { session: { id: 's1', cwd } };
    const link = require('../../src/harnesslink');
    const h = link.harnessFor(app);
    const task = h.begin({ title: 'capture evidence', objective: 'capture evidence', sessionId: 's1' });
    h.runtime.start(task.id, 'the person asked for something');

    const dir = tmpdir('imgshot-');
    const shot = path.join(dir, 'shot.png');
    fs.writeFileSync(shot, PNG);

    const r = viewer.offer(app, shot, { provenance: 'computer screenshot' });
    assert.strictEqual(r.ok, true, r.why);
    assert.ok(r.record.artifact, 'it was adopted');
    assert.strictEqual(r.record.artifact.taskId, task.id, 'by the task that was running');
    assert.notStrictEqual(r.record.file, r.record.origin, 'and the copy is what gets served');

    // THE TEMP ORIGINAL GOES, AND THE EVIDENCE DOES NOT.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(viewer.bytes(app, r.ref).equals(PNG), 'the picture still reads after the temp directory is swept');
    assert.strictEqual(viewer.publicRecord(viewer.find(app, r.ref)).adopted, true);

    // AND ASKING FOR IT BY ITS ARTIFACT PATH IS THE SAME PICTURE. That is the
    // path the model is told once the temp copy is gone; re-adopting it would
    // duplicate the evidence inside its own task and lose where it came from.
    const again = viewer.offer(app, r.record.file, {});
    assert.strictEqual(again.ref, r.ref, 'the artifact path resolves to the entry already on the shelf');
    assert.strictEqual(h.runtime.store.index(task.id).filter((a) => a.kind === 'screenshot').length, 1,
      'and no second artifact was written');
    assert.strictEqual(viewer.publicRecord(again.record).provenance, 'computer screenshot', 'with its provenance intact');
  });

  await test('ADOPTION: with no task there is nothing to adopt into, and that is not a failure', () => {
    // Inventing a task to hold a picture would be worse than not adopting it.
    const app = session();
    const r = viewer.offer(app, withImage(), {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.record.artifact, null);
    assert.strictEqual(viewer.publicRecord(r.record).adopted, false);
  });

  await test('NO HTML: opening an image generates no page, on either branch', async () => {
    // ---- THE REGRESSION, STATED AS THE OBSERVATION ----------------------
    const home = tmpdir('lain-test-home-');
    const before = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = home;
    try {
      const app = session();
      const file = withImage();
      const launched = [];
      const r = await view.open(app, file, { launch: (f) => launched.push(f) });

      assert.strictEqual(r.ok, true, r.why);
      assert.ok(!('page' in r), 'there is no page, because none is written');
      // WHAT THE VIEWER IS HANDED IS THE IMAGE, NOT A WRAPPER. This is the
      // difference between the machine opening an image viewer and a browser.
      assert.deepStrictEqual(launched, [file]);
      assert.ok(/\.png$/i.test(launched[0]), 'a .png, never a .html');

      assert.deepStrictEqual(strayPages(home), [], 'nothing under the config directory');
      assert.deepStrictEqual(strayPages(path.dirname(file)), [], 'nothing beside the image');
      assert.ok(!fs.existsSync(path.join(home, 'visual', 'view')),
        'the visual/view directory is not even created');
    } finally {
      if (before === undefined) delete process.env.LAIN_CONFIG_DIR;
      else process.env.LAIN_CONFIG_DIR = before;
    }
  });

  await test('NO HTML: the module has no page generator left to call', () => {
    // A dead generator is a generator something calls again next year.
    assert.strictEqual(typeof view.page, 'undefined');
    assert.strictEqual(typeof view.dir, 'undefined');
    // THE CODE, NOT THE PROSE. The file still EXPLAINS the page it used to
    // write — deleting the provenance of a fix leaves the fix looking
    // arbitrary — so the comments are stripped before this looks.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'imageview.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/view-\$\{/.test(src), 'nothing builds a view-<n>.html name');
    assert.ok(!/<img|<style|<meta/.test(src), 'and no markup is emitted anywhere in it');
    assert.ok(!/writeFileSync/.test(src), 'and it writes no file at all');
  });

  await test('VIEWER: the window is told WHAT is open, never the bytes', async () => {
    // A screenshot in the poll payload is a screenshot re-sent every poll, to a
    // window that already has it.
    const app = session();
    const r = viewer.offer(app, withImage(), { provenance: 'computer screenshot' });
    viewer.show(app, r.ref);
    const shown = viewer.current(app);
    assert.strictEqual(shown.ref, r.ref);
    assert.ok(!('data' in shown), 'the state carries no image data');
    assert.ok(!JSON.stringify(shown).includes('iVBOR'), 'not even a little of it');

    viewer.close(app);
    assert.strictEqual(viewer.current(app), null, 'and closing it says so');
  });

  await test('VIEWER: "there is a window" is not the same question as "it is showing THIS session"', () => {
    // A window connected to a SIBLING session will never draw this picture —
    // `viewing` is a field on one App. Claiming "opened in the LAIN window"
    // there would be a sentence about something nobody can see. Separating the
    // viewed session from the executing one is what sessionpool.js is for.
    //
    // With no window connected the answer is false whatever else is true, which
    // is the state a unit run is in — so what is pinned here is that it never
    // answers true without an app and a session to answer about.
    assert.strictEqual(viewer.windowed(null), false);
    assert.strictEqual(viewer.windowed({}), false);
    assert.strictEqual(viewer.windowed(session()), false, 'no window is connected in a unit run');
  });

  await test('VIEWER: it NEVER claims anybody looked', async () => {
    // Opening a window is not looking at one, and conflating the two is what the
    // whole evidence model forbids. See src/ui/images.js, which says NOT SEEN.
    const app = session();
    const r = await view.open(app, withImage(), { launch: () => {} });
    const said = JSON.stringify(r).toLowerCase();
    for (const claim of ['verified', 'confirmed', 'looks', 'seen', 'judged']) {
      assert.ok(!said.includes(claim), `the result claims "${claim}": ${said}`);
    }
  });
};
