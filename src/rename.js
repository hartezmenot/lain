'use strict';

/** RENAME, ON TOKENS — the operation a regex cannot do safely. */

const fs = require('fs');
const { tokenize, T, supports } = require('./jsscan');
const { walk, globToRegExp } = require('./tools/search');
const diagnostics = require('./diagnostics');

/** Bounds, so a rename on a huge tree cannot run away. */
const MAX_FILES = 4000;
const MAX_SITES = 5000;

/** How each occurrence of the name was being used. One word each. */
const SITE = Object.freeze({
  IDENTIFIER: 'identifier',   // a plain reference or a declaration
  SHORTHAND: 'shorthand',     // `{ name }` — the key and the value at once
  MEMBER: 'member',           // `x.name`
  KEY: 'key',                 // `{ name: … }`
  TEXT: 'text',               // inside a string, template, comment or regex
});

function isPunct(t, v) { return t && t.type === T.PUNCT && t.value === v; }

/** Every place `name` appears in one source, classified. */
function sitesIn(source, name) {
  const { tokens, lineStarts } = tokenize(source, { comments: true });
  const { lineAt } = require('./jsscan');
  const out = [];
  const word = new RegExp(`(?:^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_$]|$)`);

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === T.STRING || t.type === T.TEMPLATE || t.type === T.COMMENT || t.type === T.REGEX) {
      // Not renamed, but the model is told. A string carrying the old name is
      // the classic residue of a half-done migration.
      if (word.test(t.value)) out.push({ kind: SITE.TEXT, start: t.start, end: t.end, line: lineAt(lineStarts, t.start) });
      continue;
    }
    if (t.type !== T.NAME || t.value !== name) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    let kind = SITE.IDENTIFIER;
    if (isPunct(prev, '.') || isPunct(prev, '?.')) kind = SITE.MEMBER;
    else if (isPunct(next, ':')) kind = SITE.KEY;
    else if ((isPunct(prev, '{') || isPunct(prev, ',')) && (isPunct(next, ',') || isPunct(next, '}'))) {
      // `{ name }` — the property and the variable are the same token, so
      // renaming it renames both. Real, and worth saying out loud.
      kind = SITE.SHORTHAND;
    }
    out.push({ kind, start: t.start, end: t.end, line: lineAt(lineStarts, t.start) });
  }
  return out;
}

/** Apply replacements from the END, so earlier offsets stay valid. */
function applySites(source, sites, to) {
  let out = source;
  for (let i = sites.length - 1; i >= 0; i--) {
    out = out.slice(0, sites[i].start) + to + out.slice(sites[i].end);
  }
  return out;
}

/** Rename `from` to `to` across a tree. */
async function rename(root, from, to, opts = {}) {
  const gen = renameBody(root, from, to, opts);
  let step = gen.next();
  while (!step.done) step = gen.next(await step.value);
  return step.value;
}

/** THE DRY RUN, SYNCHRONOUS: the same walk and classification as `rename`, writing nothing. */
function scan(root, from, to, { include = '', members = false } = {}) {
  const gen = renameBody(root, from, to, { include, members, dryRun: true });
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/** The walk itself. `yield` stands for the one await (the post-write parse check). */
function* renameBody(root, from, to, { include = '', members = false, dryRun = false } = {}) {
  const includeRe = include ? globToRegExp(include) : null;
  const changed = [];
  const textOnly = [];
  const memberOnly = [];
  const shorthand = [];
  let scanned = 0;
  let sites = 0;
  let skippedUnsupported = 0;

  const CHANGE = new Set(members
    ? [SITE.IDENTIFIER, SITE.SHORTHAND, SITE.MEMBER, SITE.KEY]
    : [SITE.IDENTIFIER, SITE.SHORTHAND]);

  for (const f of walk(root)) {
    if (includeRe && !includeRe.test(f.rel)) continue;
    if (scanned >= MAX_FILES || sites >= MAX_SITES) break;
    if (!supports(f.abs)) {
      // A file this scanner does not claim is never edited by guesswork.
      let raw;
      try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const w = new RegExp(`(?:^|[^A-Za-z0-9_$])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_$]|$)`);
      if (w.test(raw)) { textOnly.push(`${f.rel} (not JavaScript — not renamed)`); skippedUnsupported += 1; }
      continue;
    }
    let source;
    try { source = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (!source.includes(from)) continue;      // cheap reject before tokenising
    scanned += 1;

    const all = sitesIn(source, from);
    if (!all.length) continue;
    const toChange = all.filter((s) => CHANGE.has(s.kind));
    for (const s of all) {
      if (s.kind === SITE.TEXT) textOnly.push(`${f.rel}:${s.line}`);
      else if (s.kind === SITE.MEMBER && !members) memberOnly.push(`${f.rel}:${s.line}`);
      else if (s.kind === SITE.SHORTHAND) shorthand.push(`${f.rel}:${s.line}`);
    }
    if (!toChange.length) continue;
    sites += toChange.length;
    if (dryRun) { changed.push({ rel: f.rel, abs: f.abs, count: toChange.length, rolledBack: false }); continue; }

    const next = applySites(source, toChange, to);
    fs.writeFileSync(f.abs, next, 'utf8');
    // AND DID IT SURVIVE?
    let ok = true;
    try {
      const check = yield diagnostics.checkFile(f.abs);
      ok = !(check && check.ok === false);
    } catch { ok = true; }
    if (!ok) { fs.writeFileSync(f.abs, source, 'utf8'); }
    changed.push({ rel: f.rel, abs: f.abs, count: toChange.length, rolledBack: !ok });
  }

  return {
    from, to, changed, scanned, sites, dryRun,
    textOnly: [...new Set(textOnly)],
    memberOnly: [...new Set(memberOnly)],
    shorthand: [...new Set(shorthand)],
    skippedUnsupported,
    truncated: scanned >= MAX_FILES || sites >= MAX_SITES,
  };
}

/** The report a model reads. Facts, in the order they change what happens next. */
function describe(r) {
  const lines = [];
  const applied = r.changed.filter((c) => !c.rolledBack);
  const broken = r.changed.filter((c) => c.rolledBack);
  const total = applied.reduce((n, c) => n + c.count, 0);

  lines.push(r.dryRun
    ? `${r.from} → ${r.to}: ${total} identifier(s) in ${applied.length} file(s) WOULD change. Nothing was written.`
    : `${r.from} → ${r.to}: ${total} identifier(s) renamed in ${applied.length} file(s).`);
  for (const c of applied.slice(0, 30)) lines.push(`  ${c.rel} (${c.count})`);
  if (applied.length > 30) lines.push(`  [${applied.length - 30} more]`);

  if (broken.length) {
    lines.push('', 'ROLLED BACK — these no longer parsed after the rename and were restored:');
    for (const c of broken) lines.push(`  ${c.rel}`);
  }
  if (r.shorthand.length) {
    lines.push('', `${r.shorthand.length} shorthand propert${r.shorthand.length === 1 ? 'y was' : 'ies were'} renamed `
      + '— `{ name }` is the key AND the value, so the property name changed too:');
    lines.push('  ' + r.shorthand.slice(0, 12).join(', '));
  }
  if (r.memberOnly.length) {
    lines.push('', `${r.memberOnly.length} member access(es) were NOT renamed — \`x.${r.from}\` may be a different `
      + `${r.from} on a different object, and nothing here can tell. Pass include_members to rewrite them:`);
    lines.push('  ' + r.memberOnly.slice(0, 12).join(', ')
      + (r.memberOnly.length > 12 ? ` [+${r.memberOnly.length - 12}]` : ''));
  }
  if (r.textOnly.length) {
    lines.push('', `${r.textOnly.length} occurrence(s) remain inside strings, comments or non-JavaScript files. `
      + 'These were NOT renamed. A string holding the old name is often a real reference — a tool name, a config '
      + 'key, a route — and is what makes a migration look finished when it is not:');
    lines.push('  ' + r.textOnly.slice(0, 12).join(', ')
      + (r.textOnly.length > 12 ? ` [+${r.textOnly.length - 12}]` : ''));
  }
  if (r.truncated) lines.push('', '[bounded: the tree is very large and the sweep stopped early — narrow with include]');
  if (!r.changed.length && !r.textOnly.length) {
    lines.push(`Nothing named ${r.from} was found in ${r.scanned} JavaScript file(s).`);
  }
  return lines.join('\n');
}

module.exports = { rename, scan, describe, sitesIn, applySites, SITE, MAX_FILES, MAX_SITES };
