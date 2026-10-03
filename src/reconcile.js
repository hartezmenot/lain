'use strict';

/** INTENDED vs OBSERVED — the comparison that makes an architecture survivable. */

const fs = require('fs');
const path = require('path');

const architecture = require('./architecture');
const lainstore = require('./lainstore');

const { OBSERVED, STATUS } = architecture;

/** Files past this are fingerprinted by stat alone; parsing them is not worth it. */
const MAX_PARSE_BYTES = 2_000_000;

/** Directory fingerprints stop here. A node pointing at `node_modules` is a mistake, not a workload. */
const MAX_DIR_ENTRIES = 400;

const JS = /\.(?:js|jsx|mjs|cjs)$/i;

/** WHAT A LOCATION LOOKS LIKE RIGHT NOW, cheaply and comparably. */
function fingerprint(root, location) {
  if (!location) return { kind: 'none', print: '', bytes: 0 };
  const abs = path.resolve(root, location);
  let st;
  try { st = fs.statSync(abs); } catch { return { kind: 'absent', print: '', bytes: 0 }; }
  if (st.isFile()) {
    return { kind: 'file', print: `f:${st.size}:${Math.floor(st.mtimeMs)}`, bytes: st.size, abs };
  }
  if (!st.isDirectory()) return { kind: 'other', print: `o:${st.size}`, bytes: st.size, abs };
  // A DIRECTORY IS A NODE TOO.
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return { kind: 'absent', print: '', bytes: 0 }; }
  const rows = [];
  let bytes = 0;
  for (const e of entries.slice(0, MAX_DIR_ENTRIES)) {
    if (e.isDirectory()) { rows.push(`${e.name}/`); continue; }
    let size = 0;
    try { size = fs.statSync(path.join(abs, e.name)).size; } catch { /* raced */ }
    bytes += size;
    rows.push(`${e.name}:${size}`);
  }
  rows.sort();
  return { kind: 'dir', print: `d:${rows.length}:${bytes}:${rows.join(',').length}`, bytes, abs, count: rows.length };
}

/** IS THIS BROKEN? Only for things cheap and certain enough to be sure about. */
function damage(fp) {
  if (fp.kind === 'file') {
    if (fp.bytes === 0) return 'the file is there and it is empty';
    if (JS.test(fp.abs) && fp.bytes <= MAX_PARSE_BYTES) {
      let r;
      try { r = require('./diagnostics').checkJs(fs.readFileSync(fp.abs, 'utf8'), fp.abs); } catch { return ''; }
      if (r && r.ok === false && !r.inconclusive) {
        return `it does not parse${r.line ? ` (line ${r.line})` : ''}: ${r.message || 'syntax error'}`;
      }
    }
    return '';
  }
  if (fp.kind === 'dir' && fp.count === 0) return 'the directory is there and it is empty';
  return '';
}

/** COMPARE THE WHOLE ARCHITECTURE AGAINST THE DISK. */
function reconcile(root, model, { at = Date.now() } = {}) {
  const report = {
    at,
    checked: 0,
    present: 0,
    missing: 0,
    damaged: 0,
    drifted: 0,
    unknown: 0,
    alarms: [],
    prints: {},
  };

  for (const node of Object.values(model.nodes)) {
    report.checked += 1;
    if (!node.location) {
      // NOTHING TO LOOK AT is not the same as NOTHING THERE. A design-only node
      // is a legitimate, complete state.
      architecture.observe(model, node.id, { status: OBSERVED.UNKNOWN, note: 'no location recorded', at });
      report.unknown += 1;
      continue;
    }
    const fp = fingerprint(root, node.location);
    report.prints[node.id] = fp.print;

    if (fp.kind === 'absent' || fp.kind === 'none') {
      architecture.observe(model, node.id, {
        status: OBSERVED.MISSING,
        note: `nothing at ${node.location}`,
        at,
      });
      report.missing += 1;
      if (node.status !== STATUS.PLANNED) {
        // THE RECOVERY SIGNAL. A planned thing that does not exist yet is
        // normal; a built thing that does not exist any more is not.
        report.alarms.push({
          id: node.id,
          name: node.name,
          kind: 'MISSING',
          say: `${node.name} was ${node.status} at ${node.location} and there is nothing there now`,
        });
      }
      continue;
    }

    const broken = damage(fp);
    if (broken) {
      architecture.observe(model, node.id, { status: OBSERVED.DAMAGED, note: broken, fingerprint: fp.print, at });
      report.damaged += 1;
      report.alarms.push({ id: node.id, name: node.name, kind: 'DAMAGED', say: `${node.name}: ${broken}` });
      continue;
    }

    // DRIFT: A VERIFICATION THAT STOPPED BEING TRUE
    const was = String((node.verification && node.verification.fingerprint) || '');
    if (was && was !== fp.print) {
      architecture.observe(model, node.id, {
        status: OBSERVED.DRIFTED,
        note: `changed since it was verified by ${node.verification.how || 'something'}`,
        fingerprint: fp.print,
        at,
      });
      report.drifted += 1;
      report.alarms.push({
        id: node.id,
        name: node.name,
        kind: 'DRIFTED',
        say: `${node.name} changed since the verification that made it VERIFIED — re-check it`,
      });
      continue;
    }

    architecture.observe(model, node.id, { status: OBSERVED.PRESENT, fingerprint: fp.print, at });
    report.present += 1;
  }

  return report;
}

/** RECONCILE AND PERSIST, including the run itself. */
function run(root, { model = null, save = true } = {}) {
  const m = model || architecture.load(root);
  const report = reconcile(root, m);
  if (save) {
    architecture.save(root, m);
    lainstore.write(root, 'observed', {
      at: report.at,
      checked: report.checked,
      present: report.present,
      missing: report.missing,
      damaged: report.damaged,
      drifted: report.drifted,
      unknown: report.unknown,
      prints: report.prints,
    });
  }
  return { model: m, report };
}

/** VERIFY A NODE AND CAPTURE WHAT WAS VERIFIED. */
function record(root, model, id, { how, result, by = 'lain', at = Date.now() } = {}) {
  // THE NODE BEFORE THE ATTEMPT, because a REFUSED verification must not change it.
  const node0 = model.nodes[id];
  const was = node0 ? { status: node0.status, verification: { ...node0.verification } } : null;
  const r = architecture.verify(model, id, { how, result, by, at });
  if (!r.ok) return r;
  const node = model.nodes[id];
  if (node.location) {
    const fp = fingerprint(root, node.location);
    node.verification.fingerprint = fp.print;
    if (fp.kind === 'absent') {
      // A VERIFICATION OF SOMETHING THAT IS NOT THERE is refused, and this is the last place it can be caught.
      if (was) {
        node.status = was.status;
        node.verification = was.verification;
      }
      architecture.observe(model, id, { status: OBSERVED.MISSING, note: `nothing at ${node.location}`, at });
      return { ok: false, error: `nothing exists at ${node.location} — a verification cannot be recorded against it` };
    }
    architecture.observe(model, id, { status: OBSERVED.PRESENT, fingerprint: fp.print, at });
  }
  return { ok: true, node };
}

/** THE REPORT, in the words a person or a model acts on. */
function say(model, report) {
  const out = [];
  if (report.alarms.length) {
    out.push(`ARCHITECTURE vs DISK — ${report.alarms.length} discrepanc${report.alarms.length === 1 ? 'y' : 'ies'}:`);
    for (const a of report.alarms) out.push(`  ${a.kind.padEnd(8)} ${a.say}`);
    out.push('');
    out.push('The architecture still describes these components — their purpose, their place '
      + 'and their last verification are in .lain/ and did not go anywhere. What is gone is the '
      + 'implementation.');
  } else if (report.checked) {
    out.push(`ARCHITECTURE vs DISK — nothing is missing, damaged or drifted (${report.checked} node(s) checked).`);
  } else {
    out.push('No architecture has been recorded for this project yet, so there is nothing to compare.');
  }
  if (report.checked) {
    out.push('');
    out.push(`  present ${report.present}   missing ${report.missing}   damaged ${report.damaged}`
      + `   drifted ${report.drifted}   design-only ${report.unknown}`);
    const t = architecture.tally(model);
    out.push(`  intent:  planned ${t.planned}   partial ${t.partial}   implemented ${t.implemented}   verified ${t.verified}`);
  }
  return out.join('\n');
}

module.exports = { fingerprint, damage, reconcile, run, record, say, MAX_DIR_ENTRIES };
