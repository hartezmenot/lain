'use strict';

/** PROJECT MEMORY — what is TRUE about this project, not what was SAID about it. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { configDir } = require('./config');

/** Bounds: a store nobody prunes must not grow without limit. */
const MAX_CONCERNS = 200;
const MAX_TEXT = 400;

/** WHAT KIND OF DURABLE THING THIS IS. */
const KIND = Object.freeze({
  /** Something noticed that may matter and has not been settled. */
  NOTE: 'note',
  /** Settled deliberately. Do not reopen without a reason. */
  DECISION: 'decision',
  /** A convention that is true of this project. */
  FACT: 'fact',
  /** Something that cannot be done here, and why. */
  LIMITATION: 'limitation',
  /** Where the real version of something lives, after a migration. */
  SOURCE_OF_TRUTH: 'source-of-truth',
});

/** The order they are shown in: settled things first, open questions last. */
const KIND_ORDER = [KIND.DECISION, KIND.SOURCE_OF_TRUTH, KIND.FACT, KIND.LIMITATION, KIND.NOTE];

const STATE = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
});

/** Where this project's concerns live. Keyed by path, so projects stay apart. */
function fileFor(root) {
  const key = crypto.createHash('sha1').update(path.resolve(String(root || '.'))).digest('hex').slice(0, 16);
  return path.join(configDir(), 'concerns', `${key}.json`);
}

function load(root) {
  let raw;
  try { raw = fs.readFileSync(fileFor(root), 'utf8'); } catch { return { root: String(root), items: [] }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { root: String(root), items: [] }; }
  const items = Array.isArray(j && j.items) ? j.items : [];
  return { root: String(root), items: items.filter((i) => i && typeof i.text === 'string') };
}

function save(root, store) {
  const file = fileFor(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: String(root), items: store.items }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/** Write one down. This is the whole interaction, and it is one line on purpose: a concern that costs a workflow to record is a concern nobody records. */
function add(root, text, { kind = KIND.NOTE } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!t) return { ok: false, why: 'a concern needs some text' };
  const store = load(root);
  // The same thought twice is one thought. Compared case-insensitively so
  // re-noticing something does not quietly duplicate it.
  const already = store.items.find((i) => i.state === STATE.OPEN && i.text.toLowerCase() === t.toLowerCase());
  if (already) return { ok: true, duplicate: true, item: already };
  const item = {
    id: nextId(store),
    text: t,
    kind: Object.values(KIND).includes(kind) ? kind : KIND.NOTE,
    state: STATE.OPEN,
    at: new Date().toISOString(),
    note: null,
  };
  store.items.push(item);
  // Oldest RESOLVED entries fall off first — history is worth less than the
  // things still outstanding.
  while (store.items.length > MAX_CONCERNS) {
    const i = store.items.findIndex((x) => x.state === STATE.RESOLVED);
    store.items.splice(i >= 0 ? i : 0, 1);
  }
  const ok = save(root, store);
  return { ok, item, persisted: ok };
}

function nextId(store) {
  let max = 0;
  for (const i of store.items) {
    const n = Number(String(i.id || '').replace(/\D/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `C${String(max + 1).padStart(2, '0')}`;
}

/** Close one, WITH what was found. */
function resolve(root, id, note = '') {
  const store = load(root);
  const item = store.items.find((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (!item) return { ok: false, why: `no concern ${id}` };
  item.state = STATE.RESOLVED;
  item.note = String(note || '').trim().slice(0, MAX_TEXT) || null;
  item.resolvedAt = new Date().toISOString();
  return { ok: save(root, store), item };
}

/** Reclassify once somebody knows what it really is. */
function promote(root, id, kind) {
  const store = load(root);
  const item = store.items.find((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (!item) return { ok: false, why: `no concern ${id}` };
  if (!Object.values(KIND).includes(kind)) {
    return { ok: false, why: `unknown kind ${kind} — one of ${Object.values(KIND).join(', ')}` };
  }
  item.kind = kind;
  return { ok: save(root, store), item };
}

function drop(root, id) {
  const store = load(root);
  const at = store.items.findIndex((i) => String(i.id).toLowerCase() === String(id).toLowerCase());
  if (at < 0) return { ok: false, why: `no concern ${id}` };
  const [item] = store.items.splice(at, 1);
  return { ok: save(root, store), item };
}

/** The ones still outstanding, oldest first — the order they were noticed. */
function open(root) {
  return load(root).items.filter((i) => i.state === STATE.OPEN);
}

function all(root) { return load(root).items; }

/** The short form that rides in the system prompt. */
function digest(root, limit = 5) {
  const items = open(root);
  if (!items.length) return '';
  const rows = items.slice(0, limit).map((i) => `- ${i.id} ${i.text}`);
  const more = items.length > limit ? `\n- (${items.length - limit} more, see /concern)` : '';
  return `Open concerns — noticed earlier and not yet settled:\n${rows.join('\n')}${more}`;
}

/** The open entries grouped by kind, in reading order. Powers the MEMORY view. */
function grouped(root) {
  const items = open(root);
  const out = [];
  for (const k of KIND_ORDER) {
    const rows = items.filter((i) => i.kind === k);
    if (rows.length) out.push({ kind: k, items: rows });
  }
  return out;
}

module.exports = {
  grouped, KIND_ORDER, add, resolve, promote, drop, open, all, load, save, digest, fileFor, KIND, STATE, MAX_CONCERNS };
