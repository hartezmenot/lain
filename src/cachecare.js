'use strict';

/**
 * CLEAR CACHE & TEMPORARY FILES (Gate 3 §77–80, 2026-09-30) — Settings › Storage, `lain cache inspect|clear`
 * and `/cache`: one owner, three doors.
 *
 * ------------------------------------------------------------------------
 * WHAT IT MAY TAKE. Only what a KNOWN OWNER says is disposable, found by rule, re-found at the moment of
 * clearing (never from a stale list), and removed only from inside the category's own roots:
 *
 *   SAFE — "Clear safe cache"
 *     Browser caches            the cache folders (Cache, Code Cache, GPU/shader caches, crash reports) of the
 *                               browser profiles LAIN runs — the window, Preview, the browser tool, web models.
 *                               Never a profile's cookies, storage, history or sign-ins.
 *     Old LAIN builds           host and terminal executables superseded by a newer build (content-stamped;
 *                               rebuilt on demand). The newest is kept; one in use cannot be removed and is skipped.
 *     Temporary & test files    `lain-*` entries in the system temp folder untouched for a day — runs, test homes,
 *                               probes. Never `lain-workspaces` (tempworkspaces.js owns it), never this LAIN's home.
 *     Old screenshots           the browser tool's screenshots older than a week
 *     Old diagnostic traces     provider request traces (reqtrace.js) older than two weeks
 *     Finished workspaces       whatever tempworkspaces.js's own rules say may go — it decides, not this
 *
 *   ADVANCED — only when named
 *     Model catalogs            rebuilt on the next refresh (the picker may show fewer models until then)
 *     Unused Preview profiles   Preview browser profiles untouched for 30 days (site sign-ins in them go too)
 *     Old undo history          file snapshots of sessions untouched for 30 days — those changes can no
 *                               longer be undone
 *     Usage history             LAIN's usage receipts — the Usage charts start again
 *
 *   NEVER — not by any door: sessions, handovers, compaction summaries, plans, checkpoints of project trees,
 *   evidence, accounts, OAuth profiles, API secrets, credentials, settings, installed skills and extensions,
 *   web-model and browser sign-ins, the supervisor's records, project files. None of them is in any root below.
 *
 * NOTHING HERE READS A FILE'S CONTENTS, and nothing is reported beyond names, counts and sizes.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const DAY = 864e5;
/** Chromium / WebView2 folders that are caches and nothing else. */
const BROWSER_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache', 'BrowserMetrics', path.join('Crashpad', 'reports'), path.join('Service Worker', 'CacheStorage'), path.join('Service Worker', 'ScriptCache')];
const NEVER_LABELS = ['Sessions and conversations', 'Plans, handovers and task checkpoints', 'Evidence', 'Project snapshots (backups)', 'Accounts, OAuth profiles and API keys', 'Settings', 'Installed skills and extensions', 'Browser and web-model sign-ins', 'Project files'];

function home() { return require('./config').configDir(); }
/** The system temp folder — LAIN_CACHE_TMP overrides it (tests clear a sandbox, never the real one). */
function tmpRoot() { return process.env.LAIN_CACHE_TMP || os.tmpdir(); }
function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
/** Is `child` strictly inside `parent`? (Both resolved; never the parent itself.) */
function inside(child, parent) {
  const rel = path.relative(real(parent), real(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function statOf(p) { try { return fs.lstatSync(p); } catch { return null; } }
function ls(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function newestMtime(p) {
  const st = statOf(p);
  if (!st) return 0;
  let m = st.mtimeMs;
  if (st.isDirectory()) for (const e of ls(p).slice(0, 200)) { const s = statOf(path.join(p, e)); if (s && s.mtimeMs > m) m = s.mtimeMs; }
  return m;
}

/**
 * THE GUARDS, computed once per scan:
 *   whole     never removed, and nothing that CONTAINS them is: the user's home, this LAIN's home, the
 *             workspace root, the working directory, LAIN's own code
 *   interior  nothing INSIDE them is removed either: the durable parts of the LAIN home, the workspace root
 *             (tempworkspaces.js removes its own), LAIN's code, and the working directory when it is a project
 *             rather than an ancestor of the places cleaned
 */
function guards() {
  const h = home();
  const tempRoot = process.env.LAIN_TEMP_ROOT || path.join(os.tmpdir(), 'lain-workspaces');
  const code = path.join(__dirname, '..');
  let harness = null;
  try { const H = require('./harnesslocation').load(); harness = H && H.ok ? H.root : null; } catch { harness = null; }
  const cwd = process.cwd();
  const cwdIsProject = !(inside(h, cwd) || real(h) === real(cwd) || inside(tmpRoot(), cwd) || real(tmpRoot()) === real(cwd));
  const durable = ['sessions', 'evidence', 'backups', 'accounts', 'secrets', 'instances', 'runtimes', 'local', 'assistant', 'bot', 'decisions', 'concerns', 'provenance', 'attention', 'candidates', 'migrations', 'supervisor', 'control', 'harness', 'extensions', 'skills'].map((d) => path.join(h, d));
  const wsHere = path.join(tmpRoot(), 'lain-workspaces');
  const whole = [os.homedir(), h, tempRoot, wsHere, cwd, code, harness].filter(Boolean).map(real);
  const interior = [...durable, tempRoot, wsHere, code, harness, cwdIsProject ? cwd : null].filter(Boolean).map(real);
  return { whole, interior };
}
function safeTarget(target, roots, g = guards()) {
  if (!roots.some((r) => inside(target, r))) return false;
  const t = real(target);
  for (const W of g.whole) if (t === W || inside(W, t)) return false;
  for (const I of g.interior) if (t === I || inside(t, I)) return false;
  return true;
}

// ------------------------------------------------------------------ categories --

/** Cache folders inside one browser profile root (its top level, Default, Profile N). */
function cacheDirsIn(root) {
  const out = [];
  const bases = [root, ...ls(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)).map((d) => path.join(root, d))];
  for (const b of bases) for (const c of BROWSER_CACHES) { const p = path.join(b, c); const st = statOf(p); if (st && st.isDirectory()) out.push(p); }
  return out;
}
/** Every browser profile LAIN runs: the window's WebView2, the old window profile, Preview, the browser tool, web models. */
function profileRoots() {
  const h = home();
  const roots = [path.join(h, 'desktop', 'EBWebView'), path.join(h, 'harnessapp'), path.join(h, 'browser', 'profile')];
  for (const parent of ['workshop', path.join('browser', 'profiles'), 'webmodels']) for (const d of ls(path.join(h, parent))) roots.push(path.join(h, parent, d));
  return roots.filter((r) => { const st = statOf(r); return st && st.isDirectory(); });
}

const CATEGORIES = [
  {
    id: 'browser-cache', tier: 'safe', label: 'Browser caches',
    note: 'Cache folders of the browsers Noema runs (the window, Preview, the browser tool). Cookies, storage and sign-ins stay.',
    roots: () => profileRoots(),
    targets: () => profileRoots().flatMap(cacheDirsIn),
  },
  {
    id: 'old-builds', tier: 'safe', label: 'Old Noema builds',
    note: 'Window and terminal programs replaced by newer builds. The newest is kept; one in use is skipped.',
    roots: () => [path.join(home(), 'desktop'), path.join(home(), 'pty')],
    targets: () => {
      const out = [];
      for (const [dir, re] of [[path.join(home(), 'desktop'), /^(?:lain-desktop|noema-harness)-[0-9a-f]{12}\.exe$/], [path.join(home(), 'pty'), /^(?:lain|noema)-pty-[0-9a-f]{12}\.exe$/]]) {
        const rows = ls(dir).filter((f) => re.test(f)).map((f) => ({ p: path.join(dir, f), m: (statOf(path.join(dir, f)) || {}).mtimeMs || 0 })).sort((a, b) => b.m - a.m);
        for (const r of rows.slice(1)) out.push(r.p);
      }
      return out;
    },
  },
  {
    id: 'temp', tier: 'safe', label: 'Temporary & test files',
    note: 'Noema\'s own leftovers in the system temp folder, untouched for a day.',
    roots: () => [tmpRoot()],
    targets: ({ now }) => ls(tmpRoot())
      .filter((n) => /^lain-/i.test(n) && n.toLowerCase() !== 'lain-workspaces')
      .map((n) => path.join(tmpRoot(), n))
      .filter((p) => now - newestMtime(p) > DAY),
  },
  {
    id: 'screenshots', tier: 'safe', label: 'Old screenshots',
    note: 'Browser-tool screenshots older than a week.',
    roots: () => [path.join(home(), 'browser', 'screenshots')],
    targets: ({ now }) => { const d = path.join(home(), 'browser', 'screenshots'); return ls(d).map((f) => path.join(d, f)).filter((p) => now - newestMtime(p) > 7 * DAY); },
  },
  {
    id: 'traces', tier: 'safe', label: 'Old diagnostic traces',
    note: 'Provider request traces older than two weeks.',
    roots: () => [path.join(home(), 'reqtrace')],
    targets: ({ now }) => { const d = path.join(home(), 'reqtrace'); return ls(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)).filter((p) => now - newestMtime(p) > 14 * DAY); },
  },
  {
    id: 'workspaces', tier: 'safe', label: 'Finished workspaces',
    note: 'Temporary workspaces their own rules allow to go (failed ones are kept for a week).',
    // tempworkspaces.js removes them itself; here they are only counted.
    delegate: true,
    roots: () => [require('./tempworkspaces').tempRoot()],
    targets: () => {
      const tw = require('./tempworkspaces');
      return tw.all().filter((r) => r && r.dir && !['ACTIVE', 'DELETED'].includes(r.state) && !tw.RETAINED.has(r.state) && fs.existsSync(r.dir)).map((r) => r.dir);
    },
    sweep: (app) => { const tw = require('./tempworkspaces'); tw.reconcile(app); tw.sweep(app); },
  },
  {
    // STALE PIDs (Gate 4, spec §109): a crash leaves `instances/<pid>.json` and a `core.json` naming a process that is
    // gone. Their own modules decide — instances.js sweeps a record whose process is dead, corelock.js a lock whose
    // Core is — so a running LAIN's record is never touched. Found real: ~130 of them in a lived-in home.
    id: 'stale-records', tier: 'safe', label: 'Stale process records',
    note: 'Records left by Noema processes that are no longer running. A running Noema\'s record is never touched.',
    delegate: true,
    roots: () => [path.join(home(), 'instances'), home()],
    targets: () => {
      const inst = require('./instances');
      const d = inst.dir();
      const dead = ls(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => path.join(d, f)).filter((p) => {
        try { const r = JSON.parse(fs.readFileSync(p, 'utf8')); return !r || !r.pid || !inst.alive(r.pid); } catch { return true; }
      });
      const lock = require('./corelock').staleLock();
      return lock ? dead.concat(lock) : dead;
    },
    sweep: () => { require('./instances').list(); require('./corelock').sweepStale(); },
  },
  {
    id: 'catalogs', tier: 'advanced', label: 'Model catalogs',
    note: 'Rebuilt on the next refresh; until then the model picker may list fewer models.',
    roots: () => [path.join(home(), 'catalog')],
    targets: () => { const d = path.join(home(), 'catalog'); return ls(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)); },
  },
  {
    id: 'preview-profiles', tier: 'advanced', label: 'Unused Preview profiles',
    note: 'Preview browser profiles untouched for 30 days — sign-ins to those sites in Preview go with them.',
    roots: () => [path.join(home(), 'workshop')],
    targets: ({ now }) => { const d = path.join(home(), 'workshop'); return ls(d).map((f) => path.join(d, f)).filter((p) => now - newestMtime(p) > 30 * DAY); },
  },
  {
    id: 'undo-history', tier: 'advanced', label: 'Old undo history',
    note: 'File snapshots of sessions untouched for 30 days — changes made in those sessions can no longer be undone.',
    roots: () => [path.join(home(), 'checkpoints')],
    targets: ({ now, app }) => {
      const d = path.join(home(), 'checkpoints');
      const current = app && app.session ? String(app.session.id) : null;
      return ls(d).filter((f) => f !== current).map((f) => path.join(d, f)).filter((p) => now - newestMtime(p) > 30 * DAY);
    },
  },
  {
    id: 'usage-history', tier: 'advanced', label: 'Usage history',
    note: 'Noema\'s usage receipts and window readings — the Usage charts start again from now.',
    roots: () => [path.join(home(), 'usage')],
    targets: () => { const d = path.join(home(), 'usage'); return ls(d).filter((f) => /^receipts-.*\.jsonl$|^index-v\d+\.json$|^window-snapshots\.json$/.test(f)).map((f) => path.join(d, f)); },
  },
];
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
const SAFE = CATEGORIES.filter((c) => c.tier === 'safe').map((c) => c.id);

// ------------------------------------------------------------------ size --

/**
 * Bytes and files under `p`, without following links; bounded by `budget` (entries). CONCURRENT: directory
 * entries come typed from readdir, and files are sized in parallel batches — the walk is I/O latency, not CPU
 * (measured: 67 s sequential over ~8 GB of temp leftovers).
 */
const DU_PARALLEL = 48;
async function du(p, budget) {
  let bytes = 0; let files = 0;
  let st0;
  try { st0 = await fsp.lstat(p); } catch { return { bytes, files }; }
  if (st0.isSymbolicLink()) return { bytes, files };
  if (!st0.isDirectory()) return { bytes: st0.size, files: 1 };
  let dirs = [p];
  while (dirs.length) {
    if (budget.left <= 0) { budget.capped = true; break; }
    const batch = dirs.splice(0, DU_PARALLEL);
    const listed = await Promise.all(batch.map((d) => fsp.readdir(d, { withFileTypes: true }).then((es) => ({ d, es }), () => ({ d, es: [] }))));
    const fileRows = [];
    for (const { d, es } of listed) {
      for (const e of es) {
        budget.left -= 1;
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) dirs.push(full); else fileRows.push(full);
      }
    }
    for (let i = 0; i < fileRows.length; i += DU_PARALLEL) {
      const sizes = await Promise.all(fileRows.slice(i, i + DU_PARALLEL).map((f) => fsp.lstat(f).then((s) => s.size, () => 0)));
      for (const s of sizes) { bytes += s; files += 1; }
    }
  }
  return { bytes, files };
}

function scan(cat, app, now) {
  let list = [];
  try { list = cat.targets({ now, app }) || []; } catch { list = []; }
  const roots = cat.roots();
  const g = guards();
  // THE WORKSPACE ROOT is a guard for everyone else; its owner's own listing is taken as the owner gives it.
  if (cat.delegate) return [...new Set(list)];
  return [...new Set(list)].filter((t) => safeTarget(t, roots, g));
}

/** WHAT EACH CATEGORY HOLDS NOW — sizes and counts only. `onProgress` hears each category as it is measured. */
async function inspect(app, { maxEntries = 400000, onProgress = null } = {}) {
  const now = Date.now();
  const budget = { left: maxEntries, capped: false };
  const out = [];
  for (const c of CATEGORIES) {
    const targets = scan(c, app, now);
    let bytes = 0; let files = 0;
    for (const t of targets) { const s = await du(t, budget); bytes += s.bytes; files += s.files; }
    out.push({ id: c.id, tier: c.tier, label: c.label, note: c.note, items: targets.length, files, bytes });
    if (onProgress) { try { onProgress(out.slice()); } catch { /* the measuring goes on */ } }
  }
  return { at: now, categories: out, approximate: budget.capped, never: NEVER_LABELS, safe: SAFE };
}

/**
 * CLEAR the named categories (default: the safe ones). An advanced one is taken only when named; `confirmAdvanced`
 * is the person's explicit yes for those. Returns what was freed, and what was left and why.
 */
async function clear(app, { ids = null, confirmAdvanced = false } = {}) {
  const want = (Array.isArray(ids) && ids.length ? ids : SAFE).filter((id) => BY_ID.has(id));
  const advanced = want.filter((id) => BY_ID.get(id).tier === 'advanced');
  if (advanced.length && !confirmAdvanced) return { ok: false, needsConfirm: true, why: `${advanced.map((id) => BY_ID.get(id).label).join(', ')} ${advanced.length === 1 ? 'is' : 'are'} not disposable cache — confirm to clear`, advanced };
  const now = Date.now();
  const budget = { left: 2e6, capped: false };
  const report = { ok: true, at: now, freed: 0, removed: 0, skipped: 0, categories: [] };
  for (const id of want) {
    const c = BY_ID.get(id);
    const row = { id, label: c.label, freed: 0, removed: 0, skipped: 0, reasons: {} };
    if (c.delegate) {
      // THE OWNER DECIDES: the module that owns these (tempworkspaces.js, instances.js, corelock.js) removes what its
      // own rules allow; here they are counted before and after.
      const before = scan(c, app, now);
      let sizes = 0;
      for (const t of before) sizes += (await du(t, budget)).bytes;
      try { c.sweep(app); } catch { /* nothing eligible */ }
      const gone = before.filter((t) => !fs.existsSync(t));
      row.removed = gone.length; row.skipped = before.length - gone.length;
      row.freed = before.length ? Math.round(sizes * (gone.length / before.length)) : 0;
      if (row.skipped) row.reasons['kept by the owner\'s rules'] = row.skipped;
    } else {
      for (const t of scan(c, app, now)) {
        const size = (await du(t, budget)).bytes;
        try {
          await fsp.rm(t, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        } catch (e) {
          const why = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') ? 'in use' : 'could not be removed';
          row.reasons[why] = (row.reasons[why] || 0) + 1;
        }
        if (fs.existsSync(t)) {
          const left = (await du(t, budget)).bytes;
          row.freed += Math.max(0, size - left); row.skipped += 1;
          if (!Object.keys(row.reasons).length) row.reasons['in use'] = 1;
        } else { row.freed += size; row.removed += 1; }
      }
    }
    report.freed += row.freed; report.removed += row.removed; report.skipped += row.skipped;
    report.categories.push(row);
  }
  return report;
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** THE TERMINAL'S VIEW: a table of categories, sizes and what stays. */
function render(r) {
  const lines = ['Noema cache and temporary files', ''];
  for (const tier of ['safe', 'advanced']) {
    lines.push(tier === 'safe' ? 'Safe to clear (`noema cache clear`)' : 'Advanced — only when named (`noema cache clear <id> --yes`)');
    for (const c of r.categories.filter((x) => x.tier === tier)) {
      lines.push(`  ${c.label.padEnd(26)} ${fmtBytes(c.bytes).padStart(9)}   ${String(c.items).padStart(5)} item${c.items === 1 ? ' ' : 's'}   ${c.id}`);
    }
    lines.push('');
  }
  lines.push(`Never cleared: ${r.never.join(' · ')}.`);
  if (r.approximate) lines.push('(Sizes are approximate: the count stopped at its limit.)');
  return `${lines.join('\n')}\n`;
}

/** `lain cache inspect | clear [ids…] [--yes]` — the CLI door (src/cli.js). Returns an exit code. */
async function cli(args, { out = process.stdout, app = null } = {}) {
  const [verb = 'help', ...rest] = args;
  const w = (s) => out.write(s);
  if (verb === 'inspect') { w(render(await inspect(app))); return 0; }
  if (verb === 'clear') {
    const ids = rest.filter((a) => !a.startsWith('-'));
    const unknown = ids.filter((id) => !BY_ID.has(id));
    if (unknown.length) { w(`noema: unknown cache category ${unknown.join(', ')} — \`noema cache inspect\` lists them\n`); return 2; }
    const r = await clear(app, { ids: ids.length ? ids : null, confirmAdvanced: rest.includes('--yes') });
    if (!r.ok) { w(`noema: ${r.why}. Add --yes to clear ${r.advanced.join(', ')}.\n`); return 3; }
    for (const c of r.categories) {
      const reasons = Object.entries(c.reasons).map(([k, v]) => `${v} ${k}`).join(', ');
      w(`  ${c.label.padEnd(26)} ${fmtBytes(c.freed).padStart(9)} freed   ${c.removed} removed${c.skipped ? `, ${c.skipped} left (${reasons})` : ''}\n`);
    }
    w(`Freed ${fmtBytes(r.freed)}. Sessions, accounts, settings and project files were not touched.\n`);
    return 0;
  }
  w('noema cache inspect           show what Noema keeps that can be cleared, and its size\n'
    + 'noema cache clear             clear the safe categories\n'
    + 'noema cache clear <id…> --yes clear named categories, including advanced ones\n');
  return verb === 'help' ? 0 : 2;
}

module.exports = { inspect, clear, cli, render, fmtBytes, CATEGORIES, SAFE, NEVER_LABELS, BROWSER_CACHES, safeTarget, inside };
