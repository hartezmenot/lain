'use strict';

/** WHAT A HARNESS BROWSER IS *FOR* — the three purposes, named once. */

const path = require('path');

/** The three, and each says why it is not one of the others. */
const PURPOSE = {
  VERIFY: 'verify',
  WORKSHOP: 'workshop',
  WEBMODEL: 'webmodel',
};

const ALL = [PURPOSE.VERIFY, PURPOSE.WORKSHOP, PURPOSE.WEBMODEL];

/** HOW EACH PURPOSE BEHAVES. */
const TRAITS = {
  [PURPOSE.VERIFY]: {
    lifetime: 'task', headless: true, extensions: false, disposable: true,
    why: 'a verdict must not depend on state a previous run left behind',
  },
  [PURPOSE.WORKSHOP]: {
    lifetime: 'project', headless: false, extensions: false, disposable: false,
    why: 'a preview you cannot keep is not a workshop',
  },
  [PURPOSE.WEBMODEL]: {
    lifetime: 'session', headless: false, extensions: true, disposable: false,
    why: 'it holds a person login and must outlive every task',
  },
};

function traits(purpose) {
  const t = TRAITS[String(purpose || '').toLowerCase()];
  if (!t) throw new Error(`unknown browser purpose: ${purpose}`);
  return t;
}

function isPurpose(p) { return Object.prototype.hasOwnProperty.call(TRAITS, String(p || '').toLowerCase()); }

/** THE ASSERTION THAT TWO PURPOSES HAVE NOT MERGED ON DISK. */
function separate(aPath, bPath, aName = 'a', bName = 'b') {
  const a = path.resolve(String(aPath || ''));
  const b = path.resolve(String(bPath || ''));
  if (!a || !b) return { ok: true, why: '' };
  if (a === b) return { ok: false, why: `${aName} and ${bName} are the same profile directory: ${a}` };
  if (a.startsWith(b + path.sep)) return { ok: false, why: `${aName} (${a}) lives inside ${bName} (${b})` };
  if (b.startsWith(a + path.sep)) return { ok: false, why: `${bName} (${b}) lives inside ${aName} (${a})` };
  return { ok: true, why: '' };
}

module.exports = { PURPOSE, ALL, TRAITS, traits, isPurpose, separate };
