'use strict';

/** READ RECEIPTS — WHAT SOURCE WAS OBSERVED, UNDER WHICH VERSION, FOR WHICH WORK. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_RECEIPTS = 200;
/** A kept output larger than this is not kept: re-running is cheaper than holding it. */
const MAX_KEPT_OUTPUT = 16_000;
const MAX_KEPT_TOTAL = 400_000;

const STATUS = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE', GONE: 'GONE' });

const SHELL_READS = new Set(['run_bash', 'run_powershell', 'run_cmd']);

function contentFingerprint(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return {
      fp: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16),
      stamp: { size: st.size, mtime: Math.floor(st.mtimeMs) },
    };
  } catch { return null; }
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** WHICH FILE AND RANGE A SHELL COMMAND READS, or null. */
function parseShellRead(command) {
  const cmd = String(command || '').trim();
  if (!cmd || /[;&`]|\$\(|>|<|\n/.test(cmd.replace(/'[^']*'|"[^"]*"/g, ''))) return null;
  const stages = cmd.split('|').map((s) => s.trim());
  const first = stages[0];
  const piped = stages.length > 1;
  let m;
  if ((m = /^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+)$/.exec(first))) {
    return { file: unquote(m[3]), from: Number(m[1]), to: Number(m[2]), piped };
  }
  if ((m = /^awk\s+'NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)[^']*'\s+(\S+)$/.exec(first))) {
    return { file: unquote(m[3]), from: Number(m[1]), to: Number(m[2]), piped: true };
  }
  if ((m = /^head\s+-n\s*(\d+)\s+(\S+)$/.exec(first)) || (m = /^head\s+-(\d+)\s+(\S+)$/.exec(first))) {
    return { file: unquote(m[2]), from: 1, to: Number(m[1]), piped };
  }
  if ((m = /^(?:cat|type)\s+(\S+)$/.exec(first))) return { file: unquote(m[1]), from: null, to: null, piped };
  if ((m = /^Get-Content\s+(?:-Path\s+)?(\S+)$/i.exec(first))) return { file: unquote(m[1]), from: null, to: null, piped };
  if ((m = /^tail\s+-n\s*(\d+)\s+(\S+)$/.exec(first))) return { file: unquote(m[2]), from: -Number(m[1]), to: null, piped: true };
  // A GREP AT ONE FILE IS A READ OF THAT FILE
  if ((m = /^(?:grep|egrep|fgrep|rg|ack|findstr)\s+(.*)$/i.exec(first))) {
    const rest = m[1].trim();
    const parts = rest.match(/'[^']*'|"[^"]*"|\S+/g) || [];
    const flags = parts.filter((a) => a.startsWith('-'));
    const operands = parts.filter((a) => !a.startsWith('-'));
    // RECURSIVE IS A SEARCH, NOT A READ — there is no one file behind it.
    const recursive = flags.some((f) => /^--recursive$|^-[A-Za-z]*[rR]/.test(f));
    // pattern, then exactly one path — anything else is a search, not a read.
    if (!recursive && operands.length === 2) {
      const target = unquote(operands[1]);
      const looksLikeAFile = !/[*?]/.test(target)
        && target !== '.' && target !== '..'
        && !/[/\\]$/.test(target)
        && !/^[.]{1,2}[/\\]?$/.test(target);
      if (looksLikeAFile) {
        return { file: target, from: null, to: null, piped, symbol: unquote(operands[0]) };
      }
    }
  }
  return null;
}

/** THE READ A CALL MAKES, normalised, or null when the call is not a source read. */
function parse(name, input, cwd) {
  const inp = input && typeof input === 'object' ? input : {};
  const root = String(inp.cwd || cwd || process.cwd());
  let file = null;
  let from = null;
  let to = null;
  let symbol = null;
  if (name === 'read_file' && inp.path) {
    file = inp.path;
    if (inp.offset != null || inp.limit != null) {
      from = Math.max(1, Number(inp.offset) || 1);
      to = inp.limit != null ? from + Math.max(0, Number(inp.limit) - 1) : null;
    }
  } else if (name === 'read_symbol' && inp.path && inp.name) {
    file = inp.path;
    symbol = String(inp.name) + (inp.container ? `@${inp.container}` : '');
  } else if (SHELL_READS.has(name)) {
    const r = parseShellRead(inp.command);
    if (!r) return null;
    ({ file, from, to } = r);
    if (r.symbol) symbol = r.symbol;
  } else {
    return null;
  }
  const abs = path.isAbsolute(String(file)) ? String(file) : path.resolve(root, String(file));
  const exact = `${name} ${JSON.stringify(inp).replace(/\s+/g, ' ')}`;
  return { route: name, abs, rel: path.relative(root, abs).replace(/\\/g, '/') || abs, from, to, symbol, exact };
}

function keyOf(abs) { return process.platform === 'win32' ? abs.toLowerCase() : abs; }

function storeOf(ledger) {
  if (!ledger.receipts) ledger.receipts = new Map();
  return ledger.receipts;
}

/** Every receipt the ledger holds for one file, newest last. */
function forPath(ledger, abs) { return (ledger && ledger.receipts && ledger.receipts.get(keyOf(abs))) || []; }

function all(ledger) {
  const out = [];
  if (ledger && ledger.receipts) for (const rows of ledger.receipts.values()) out.push(...rows);
  return out;
}

/** Bytes of kept output across the ledger — the bound is on the total, not one file. */
function keptTotal(ledger) { return all(ledger).reduce((n, r) => n + (r.output ? r.output.length : 0), 0); }

/** RECORD A READ THAT JUST HAPPENED. */
function record(ledger, read, { output = '', isError = false, taskId = '', planStep = null, toolCallId = '' } = {}) {
  if (!ledger || !read || isError) return null;
  const fpNow = contentFingerprint(read.abs);
  if (!fpNow) return null;
  const store = storeOf(ledger);
  const key = keyOf(read.abs);
  const rows = store.get(key) || [];
  let r = rows.find((x) => x.exact === read.exact && x.fp === fpNow.fp);
  const kept = String(output || '');
  if (!r) {
    ledger._receiptSeq = (ledger._receiptSeq || 0) + 1;
    r = {
      id: `R${ledger._receiptSeq}`,
      route: read.route, abs: read.abs, rel: read.rel,
      from: read.from, to: read.to, symbol: read.symbol, exact: read.exact,
      fp: fpNow.fp, stamp: fpNow.stamp,
      taskId: String(taskId || ''), planStep, toolCallId: String(toolCallId || ''),
      at: Date.now(), reads: 1, served: 0,
      output: null,
    };
    rows.push(r);
  } else {
    r.reads += 1;
    r.at = Date.now();
    r.toolCallId = String(toolCallId || r.toolCallId);
    r.taskId = String(taskId || r.taskId);
    r.planStep = planStep == null ? r.planStep : planStep;
  }
  r.output = kept.length <= MAX_KEPT_OUTPUT ? kept : null;
  store.set(key, rows);
  // BOUNDED, oldest first — by count, then by kept bytes.
  let rowsAll = all(ledger).sort((a, b) => a.at - b.at);
  while (rowsAll.length > MAX_RECEIPTS) { drop(ledger, rowsAll.shift()); }
  rowsAll = all(ledger).sort((a, b) => a.at - b.at);
  while (keptTotal(ledger) > MAX_KEPT_TOTAL && rowsAll.length) { const old = rowsAll.shift(); old.output = null; }
  return r;
}

function drop(ledger, r) {
  const rows = forPath(ledger, r.abs).filter((x) => x !== r);
  if (rows.length) ledger.receipts.set(keyOf(r.abs), rows); else ledger.receipts.delete(keyOf(r.abs));
}

/** IS THIS OBSERVATION STILL CURRENT? */
function status(r) {
  if (!r) return STATUS.GONE;
  let st;
  try { st = fs.statSync(r.abs); } catch { return STATUS.GONE; }
  if (st.size === r.stamp.size && Math.floor(st.mtimeMs) === r.stamp.mtime) return STATUS.FRESH;
  const now = contentFingerprint(r.abs);
  if (!now) return STATUS.GONE;
  return now.fp === r.fp ? STATUS.FRESH : STATUS.STALE;
}

/** The current receipt for exactly this call, or null. */
function current(ledger, read) {
  if (!ledger || !read) return null;
  const rows = forPath(ledger, read.abs).filter((x) => x.exact === read.exact);
  for (let i = rows.length - 1; i >= 0; i--) if (status(rows[i]) === STATUS.FRESH) return rows[i];
  return null;
}

/** A FRESH RECEIPT THAT ALREADY ANSWERS THIS QUESTION — whatever command asked. */
function covering(ledger, read) {
  if (!ledger || !read) return null;
  const rows = forPath(ledger, read.abs);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (status(r) !== STATUS.FRESH) continue;
    const unranged = r.from == null && r.to == null;
    if (unranged && !r.symbol) return r;
    if (r.symbol) {
      if (read.symbol === r.symbol && read.from == null && read.to == null) return r;
      continue;
    }
    if (read.symbol || (read.from == null && read.to == null)) continue;   // asking for more than was read
    const rTo = r.to == null ? Infinity : r.to;
    const nTo = read.to == null ? Infinity : read.to;
    if (read.from >= r.from && nTo <= rTo) return r;
  }
  return null;
}

/** LAIN wrote this file: every observation of it is retired. */
function invalidate(ledger, abs) {
  if (ledger && ledger.receipts) ledger.receipts.delete(keyOf(abs));
}

/** Persisted WITHOUT outputs — see the header. */
function toJSON(ledger) {
  return all(ledger).map(({ output, ...rest }) => rest);
}

function restore(ledger, rows) {
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.abs || !r.fp || !r.stamp) continue;
    const store = storeOf(ledger);
    const k = keyOf(r.abs);
    store.set(k, [...(store.get(k) || []), { ...r, output: null }]);
    const n = Number(String(r.id || '').slice(1));
    if (Number.isFinite(n)) ledger._receiptSeq = Math.max(ledger._receiptSeq || 0, n);
  }
  return ledger;
}

/** One line naming a receipt: `src/a.py:294-314 @A71F…` */
function label(r) {
  const where = r.symbol ? `${r.rel}::${r.symbol}`
    : r.from != null ? `${r.rel}:${r.from}${r.to != null ? `-${r.to}` : ''}` : r.rel;
  return `${where} @${r.fp.slice(0, 8)}`;
}

module.exports = {
  STATUS, parse, parseShellRead, record, status, current, covering, invalidate, forPath, all,
  toJSON, restore, label, contentFingerprint, MAX_RECEIPTS, MAX_KEPT_OUTPUT,
};
