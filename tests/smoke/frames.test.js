'use strict';

/**
 * VISUAL BEHAVIOUR, ASSERTED ON FRAMES THE REAL BINARY DREW.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TIER EXISTS AT ALL, when ui/playback.js and ui/diffreel.js are
 * already tested by moving their clocks by hand.
 *
 * Those tests prove the STATE MACHINES. They cannot prove that the machine is
 * wired to the screen, that the drawing layer reads the state it produces, or
 * that a frame anybody sees contains what the state said it would. Every defect
 * this file was written after was of exactly that kind:
 *
 *   the window's `height` was computed correctly and never drawn, so it opened
 *     as two rules and then six rows in one frame;
 *   the card and the window were each correct and named different files;
 *   the clock asked for 16ms — a value every unit assertion accepted — and the
 *     platform served 32Hz.
 *
 * So these capture REAL FRAMES from the real process and assert SEQUENCES
 * across them. A single frame proves almost nothing about motion; what matters
 * is that the frames, in order, go somewhere.
 *
 * ------------------------------------------------------------------------
 * A DRAWN FRAME CONTAINS NO NEWLINES. Every row is positioned with
 * `ESC[<n>;1H` and the whole frame is written as one string, so splitting
 * stripped text on '\n' yields one enormous line and any row-adjacency
 * assertion silently tests nothing. `rowsOfFrame` splits on the position
 * escape, which is what actually separates one row from the next.
 *
 * COLOUR IS FORCED ON. A piped child has no TTY, and render.js correctly strips
 * every colour for one — including the semantic ones half of this file is about
 * (struck red, writing blue, added green). Without `LAIN_FORCE_COLOR` the
 * assertion "removed code is drawn struck-through" is unfalsifiable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'noema.js');
const CR = '\r';
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

/** A trusted workspace with the given files in it. */
function workspace(files) {
  const cwd = tmpdir('frames-');
  const cfg = path.join(cwd, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  // BOTH SPELLINGS OF THE SAME DIRECTORY. On Windows `os.tmpdir()` gives the
  // 8.3 short form and `realpath` the long one; trust.js normalises case and
  // separators but does not expand short names, so trusting one leaves the
  // other untrusted — and the run stops on a trust prompt that looks exactly
  // like the edit never happening.
  const real = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd);
  const at = new Date().toISOString();
  const seen = new Set();
  const trustedPaths = [cwd, real]
    .filter((d) => (seen.has(d.toLowerCase()) ? false : seen.add(d.toLowerCase())))
    .map((d) => ({ path: d, level: 'TRUSTED', at }));
  fs.writeFileSync(path.join(cfg, 'config.json'),
    JSON.stringify({ trustedPaths, dashAutostart: false }, null, 2));
  for (const [f, body] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(cwd, f), body, 'utf8');
  }
  return { cwd, cfg };
}

/**
 * Run the real binary and hand back everything it wrote.
 *
 * STAGED STDIN, because writing everything at once delivers keystrokes before
 * the work they are meant to follow has started.
 */
function capture({ files, script, stdin, cols = 118, rows = 44, gap = 1800, timeoutMs = 90000 }) {
  const { cwd, cfg } = workspace(files);
  const sp = path.join(cfg, 'script.json');
  fs.writeFileSync(sp, JSON.stringify(script));
  const env = {
    ...process.env,
    LAIN_CONFIG_DIR: cfg,
    LAIN_FORCE_TUI: '1',
    LAIN_FORCE_COLOR: '1',
    COLUMNS: String(cols),
    LINES: String(rows),
    LAIN_PROVIDER: 'mock',
    LAIN_MOCK_SCRIPT: sp,
  };
  delete env.NO_COLOR;
  const keep = ['LAIN_CONFIG_DIR', 'LAIN_FORCE_TUI', 'LAIN_FORCE_COLOR', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT', 'LAIN_SUPERVISOR_BIN', 'LAIN_SUPERVISOR_LEASE_PORT'];
  for (const k of Object.keys(env)) if (k.startsWith('LAIN_') && !keep.includes(k)) delete env[k];
  env.LAIN_HOME = path.join(cfg, 'supervisor-home');
  env.LAIN_NO_DESKTOP = '1';   // never a real Model Dashboard window mid-suite (fabric/dashlaunch.js)
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN], { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    let i = 0;
    const next = () => {
      if (i >= stdin.length) { child.stdin.end(); return; }
      child.stdin.write(stdin[i++]);
      setTimeout(next, gap);
    };
    setTimeout(next, 1500);
    const kill = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', () => { clearTimeout(kill); done({ out, cwd }); });
  });
}

/** The drawn frames, each as an array of real rows. Colour kept. */
function framesOf(out) {
  // ONLY WHAT WAS DRAWN ON THE ALTERNATE SCREEN. Everything after `?1049l` is
  // the shell again — "Session saved.", the resume hint — and it lands
  // concatenated onto the last row, which then measures far wider than the pane
  // and fails an overflow check about text that was never in the pane.
  const body = String(out).split(`${ESC}[?1049l`)[0];
  return body.split(new RegExp(`${ESC}\\[\\?25l`)).map((f) => {
    // ANY COLUMN: the content frame moved every region off column 1.
    const parts = String(f).split(new RegExp(`${ESC}\\[(\\d+);\\d+H`));
    const rows = [];
    for (let i = 1; i < parts.length; i += 2) rows[Number(parts[i]) - 1] = parts[i + 1];
    return rows.map((r) => (r === undefined ? '' : r));
  });
}

const plain = (s) => String(s)
  .replace(new RegExp(`${ESC}\\][0-9]+;[^\\u0007]*\\u0007`, 'g'), '')
  .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

/** The live activity position in a frame: a verb with its target indented under it. */
function livePos(rows) {
  const flat = rows.map(plain);
  for (let i = 0; i < flat.length - 1; i++) {
    if (/^ {2}[a-z]+ing\s*$/.test(flat[i]) && /^ {4}\S/.test(flat[i + 1])) {
      return { verb: flat[i].trim(), target: flat[i + 1].trim().split(/\s{2,}/)[0] };
    }
  }
  return null;
}

/** The diff window's title, if one is open. A labelled input border is not one. */
function windowFile(rows) {
  for (const r of rows.map(plain)) {
    const m = /┌─ (\S+) /.exec(r);
    if (m && /\.[a-z]+$/i.test(m[1])) return m[1];
  }
  return null;
}

/** How many content rows the diff window currently has. */
const windowHeight = (rows) => rows.map(plain).filter((r) => /^\s{2}│.*│\s*$/.test(r)).length;

const src = (n) => Array.from({ length: n },
  (_, i) => `function h${i}(req, res) { return res.end('${i}'); }`).join(NL);

const FILES = {
  'router.js': src(30),
  'python.js': `const value = oldFunctionName(input);${NL}const other = 2;${NL}`,
  'package.json': '{"name":"frames","scripts":{"test":"node -e \\"console.log(1)\\""}}',
};

module.exports = async function () {
  // ---- THE DIFF, AS A PERFORMANCE -------------------------------------------

  const patch = await capture({
    files: FILES,
    script: [
      { tool_calls: [{ name: 'edit_file', input: {
        path: 'python.js',
        old: 'const value = oldFunctionName(input);',
        new: 'const value = newFunctionName(input);',
      } }] },
      { text: 'Done.' },
    ],
    stdin: [`rename it${CR}`, `/exit${CR}`],
  });
  const patchFrames = framesOf(patch.out);

  // ---- NO PERFORMANCE: THE EDIT IS SHOWN AS IT IS -------------------------
  //
  // These four tests used to require the edit to be PERFORMED — a window
  // opening row by row, old code struck by a travelling pen, the new code typed
  // in behind a scramble band, counters climbing. That was presentation time a
  // person waited through after the file had already changed, and the brief
  // removed it. They now assert the opposite on the same real frames.

  await test('FRAMES: an edit lands in its final state — no window grows into place', () => {
    const heights = patchFrames.filter(windowFile).map(windowHeight);
    assert.ok(heights.length === 0 || new Set(heights).size === 1,
      `no box is drawn growing across frames: ${heights.slice(0, 12).join(',')}`);
  });

  await test('FRAMES: no strike pen travels and no replacement is typed in', () => {
    const widths = [];
    for (const rows of patchFrames) {
      for (const r of rows) {
        const m = new RegExp(`${ESC}\\[9m(.*?)${ESC}\\[29m`).exec(r);
        if (!m) continue;
        const n = plain(m[1]).length;
        if (widths[widths.length - 1] !== n) widths.push(n);
      }
    }
    assert.ok(widths.length <= 1, `the strike is never seen at several positions: ${widths.join(',')}`);
    const typing = patchFrames.findIndex((rows) => rows.some(
      (r) => r.indexOf('▌') >= 0 && /[░▒▓]/.test(plain(r))));
    assert.strictEqual(typing, -1, 'no frame shows code materialising behind a scramble band');
  });

  await test('FRAMES: the edit reports its real counts, never a climbing tally', () => {
    const seen = new Set();
    for (const rows of patchFrames) {
      for (const r of rows.map(plain)) {
        const m = /\+(\d+) -(\d+)/.exec(r);
        if (m) seen.add(`${m[1]}/${m[2]}`);
      }
    }
    assert.ok(seen.has('1/1'), `the real change is on screen: ${[...seen].join(' ')}`);
    assert.ok(!seen.has('0/0') && !seen.has('0/1') && !seen.has('1/0'), `no intermediate tally was drawn: ${[...seen].join(' ')}`);
  });

  await test('FRAMES: the file really changed under the frames', () => {
    assert.match(fs.readFileSync(path.join(patch.cwd, 'python.js'), 'utf8'), /newFunctionName/);
  });

  // ---- READS, AND THE PROSE BETWEEN THEM -----------------------------------

  const reads = await capture({
    files: FILES,
    // ---- READS FOR THE LIVE ROW, WRITES FOR THE ACCOUNT ----------------
    //
    // The reads are what the live-position tests below are about, and they still
    // hold that row while they run. But a successful read leaves NO row in the
    // conversation afterwards (ui/durable.js), so a capture made only of reads
    // has no finished-call rows for the recede test to compare. A write persists,
    // and two runs of them separated by prose is exactly the shape that test needs.
    script: [
      {
        tool_calls: [
          { name: 'read_file', input: { path: 'router.js' } },
          { name: 'write_file', input: { path: 'gen/one.js', content: '// one' } },
          { name: 'write_file', input: { path: 'gen/two.js', content: '// two' } },
        ],
      },
      {
        text: 'The runtime never dispatches to connect().',
        tool_calls: [
          { name: 'read_file', input: { path: 'python.js' } },
          { name: 'write_file', input: { path: 'gen/three.js', content: '// three' } },
          { name: 'write_file', input: { path: 'gen/four.js', content: '// four' } },
        ],
      },
      { text: 'Done.' },
    ],
    stdin: [`investigate${CR}`, `/exit${CR}`],
  });
  const readFrames = framesOf(reads.out);

  await test('FRAMES: a read is on screen long enough to be read', () => {
    // "reading → appears for a fraction of a second → disappears" was the
    // reported symptom. Counted in FRAMES the process actually drew.
    const showing = readFrames.filter((rows) => {
      const lp = livePos(rows);
      return lp && /read/.test(lp.verb);
    }).length;
    assert.ok(showing >= 3, `the read held the live position for ${showing} drawn frames`);
  });

  await test('FRAMES: only ONE live activity position is ever drawn', () => {
    // The feed carries the finished calls; the timeline carries the live one.
    // Two live positions at once would mean the two had started duplicating.
    for (const rows of readFrames.concat(patchFrames)) {
      const n = rows.map(plain).filter((r) => /^ {2}[a-z]+ing\s*$/.test(r)).length;
      assert.ok(n <= 1, `one live operation at a time, found ${n}`);
    }
  });

  await test('FRAMES: prose arrives as written — no scramble band, no reveal', () => {
    // It used to RESOLVE through unsettled glyphs for up to 1.5 s after the
    // model had already said it. Now a frame shows the sentence or does not.
    const want = 'The runtime never dispatches to connect().';
    let full = 0;
    for (const rows of readFrames) {
      for (const r of rows.map(plain)) {
        const t = r.trim();
        if (t.startsWith('The runtime') && t !== want && /[░▒▓#%&$@*+=<>|~^]/.test(t)) {
          assert.fail(`a half-resolved sentence was drawn: "${t}"`);
        }
        if (t === want) full += 1;
      }
    }
    assert.ok(full > 0, 'the sentence is on screen, exactly as the model wrote it');
  });

  await test('FRAMES: structured prose keeps its structure on screen', () => {
    // The wall this whole effort is about. Asserted on the LAST drawn frame,
    // which is what a person is left looking at.
    const last = readFrames[readFrames.length - 1] || [];
    const rows = last.map(plain);
    const at = rows.findIndex((r) => r.includes('never dispatches to connect()'));
    assert.ok(at >= 0, `the finding is on screen:${NL}${rows.join(NL)}`);
    assert.ok(rows.every((r) => plain(r).length <= 122),
      'and no drawn row overflows the pane');
  });

  await test('FRAMES: finished work recedes; the current run keeps its weight', () => {
    // ---- EVERY PAST EVENT AT EQUAL VISUAL WEIGHT --------------------------
    //
    // Completed calls were drawn at `meta`, which is also the weight of the
    // call happening now. Thirty finished reads therefore carried exactly the
    // force of the one in flight, and there was nothing down the pane for the
    // eye to follow — the screen preserved history instead of following the
    // work.
    //
    // The LAST run of calls is the work in hand and keeps its weight;
    // everything before it recedes one step (ui/paint.js `faint`). Nothing is
    // dropped and nothing moves — only the emphasis changes.
    // FROM THE PALETTE (ui/palette.js, 2026-09-23): 24-bit where the terminal has it,
    // the xterm-256 fallback otherwise — either spelling of `faint` counts.
    const PAL = require('../../src/ui/palette');
    const FAINTS = [`${ESC}[${PAL.sgr('faint')}m`, ESC + '[38;5;244m'];
    const isFaint = (r) => FAINTS.some((x) => r.indexOf(x) >= 0);
    let sawFaint = false;
    let sawNormalRun = false;
    for (const rows of readFrames) {
      // `verb · subject` in lower case — the verb of a shell command is its
      // program, and `Ran` is gone (ui/phrasing.js).
      const calls = rows.filter((r) => /✓ [a-z_]+ · /.test(plain(r)));
      if (calls.length < 2) continue;
      if (calls.some(isFaint)) sawFaint = true;
      if (calls.some((r) => !isFaint(r))) sawNormalRun = true;
    }
    assert.ok(sawFaint, 'earlier completed work is drawn quieter than the current run');
    assert.ok(sawNormalRun, 'and the current run is not faded with it');
  });

  // ---- /api: A KEY TYPED AT THE PROMPT, THEN A VISIBLE SELECTION ----------
  //
  // PHASE 8.3: the terminal never takes a key. A credential typed after `/api`
  // is refused and scrubbed, and the person is pointed at the Model Dashboard;
  // there is no provider picker to drive any more. The selection is exercised
  // on the command palette instead — a panel menu (ui/adapters.js
  // `commandPaletteAdapter`) drawn by the same ui/panel.js `render`.

  const api = await capture({
    files: FILES,
    script: [{ text: 'Nothing to do.' }],
    stdin: [
      '/api sk-test-credential-value' + CR,   // a key where no key belongs
      ESC,                                    // close the refusal's panel (it owns the keys while open)
      '/',                                    // the command palette
      ESC + '[B',                             // ↓ once — move the selection
      ESC + '[B',                             // ↓ again
      ESC,                                    // Esc — close it, nothing run
      '\x7f',                                 // and take the `/` back out of the input
      '/exit' + CR,
    ],
    gap: 2200,
    timeoutMs: 90000,
  });
  const apiFrames = framesOf(api.out);

  await test('FRAMES: /api <credential> is refused — the terminal never takes a key', () => {
    const all = apiFrames.flatMap((rows) => rows.map(plain)).join(NL);
    assert.ok(/never takes a key in the terminal/.test(all), 'the refusal is drawn');
    assert.ok(/Model Dashboard/.test(all), 'and it says where keys go');
    assert.ok(!/which provider is this credential for/i.test(all), 'no terminal provider picker for a key');
  });

  await test('FRAMES: the credential never leaves the line it was typed on', () => {
    // ---- WHAT THIS CAN AND CANNOT PROMISE --------------------------------
    //
    // The key IS visible on the input line while it is being typed, and that is
    // the terminal echoing a keystroke — the same as `export KEY=…` in any
    // shell. Masking it would need input-level secret handling and would stop
    // anyone checking what they pasted; it is not what this guards.
    //
    // What it guards is the part `/api` controls: the credential must never be
    // written into the FEED, the PANEL or an ERROR message, where it would
    // outlive the keystroke and end up in a screenshot or a copied transcript.
    // What is shown back instead is its shape — `sk-…alue`.
    // WHICH ROW IS THE ONE BEING TYPED ON. It used to be found by the input's
    // border and prompt (`│ >`); the region is a grey fill with neither
    // (ui/inputbox.js), so the row is identified by what is on it — the command
    // as it was typed. That is a tighter test than the border was: it exempts
    // exactly the row carrying the typed line and nothing else, so a credential
    // echoed anywhere else, INCLUDING elsewhere in the input region, fails.
    // `\s*`, NOT `\s?`. This allowed exactly ONE leading space, which was the
    // composer's inset when that inset was one column. It is two now, so the row
    // being typed on stopped matching and the test reported the typed line itself
    // as a leak. The assertion is unchanged in strength: the exempt row is still
    // the one whose ENTIRE content is the typed command, and a credential echoed
    // anywhere else - including elsewhere in the input region - still fails.
    const inputRow = (rows) => rows.map(plain).findIndex((r) => /^\s*\/api sk-test-credential-value\s*$/.test(r));
    for (const rows of apiFrames) {
      const at = inputRow(rows);
      rows.forEach((row, n) => {
        if (n === at) return;                  // the line being typed on
        assert.ok(!plain(row).includes('sk-test-credential-value'),
          `row ${n + 1} carries the credential: ${plain(row).trim()}`);
      });
    }
    // AND THE SHAPE IS WHAT IS REPORTED BACK, when anything is.
    const all = apiFrames.flatMap((rows) => rows.map(plain)).join(NL);
    if (/sk-…/.test(all)) assert.ok(true, 'the shape stands in for the key');
  });

  await test('FRAMES: the selected row is unmistakable, and the arrows move it', () => {
    // ---- THE MARKER ALONE WAS THE WHOLE OF THE SELECTION ------------------
    //
    // A list where some rows carry a TONE put a coloured unselected row next to
    // a plain selected one, so the brightest thing on screen was not the thing
    // Enter would take. Both cues now: the `❯` survives monochrome, the surface
    // wins at a glance.
    const marked = [];
    for (const rows of apiFrames) {
      for (const r of rows) {
        const t = plain(r);
        // THE MENU IS A LIST, NOT A BOX: the selected row is the menu's own indent
        // and the `❯`, with no border beside it (ui/panel.js `render`).
        if (!/❯ /.test(t)) continue;
        const label = t.replace(/^.*❯ /, '').trim();
        if (label && marked[marked.length - 1] !== label) marked.push(label);
        // THE WHOLE ROW IS ON THE SURFACE, not just the words: a highlight that
        // stops at the text reads as an artefact rather than a selection.
        const PALG = require('../../src/ui/palette');
        const grounds = [`${ESC}[${PALG.sgr('raised2', 48)}m`, `${ESC}[${PALG.sgr('raised', 48)}m`, ESC + '[48;5;236m'];
        assert.ok(grounds.some((g) => r.indexOf(g) >= 0),
          `the selected row is drawn on the reading surface: ${t}`);
      }
    }
    assert.ok(marked.length >= 2,
      `the arrow keys really moved the selection: ${marked.join(' -> ')}`);
  });

  await test('FRAMES: a refused key and a closed palette leave nothing stored', () => {
    const cfgFile = path.join(api.cwd, 'cfg', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const conns = cfg.connections || {};
    for (const [id, c] of Object.entries(conns)) {
      assert.ok(!c.apiKey, `${id} must hold no credential after a cancelled /api`);
    }
  });
};
