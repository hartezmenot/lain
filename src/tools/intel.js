'use strict';

/** PROJECT INTELLIGENCE — the questions a model should not have to read its way to. */

const path = require('path');

const tools = {};

/** ONE CALL FOR THE WHOLE QUESTION. */
tools.locate = {
  mutates: false,
  schema: {
    name: 'locate',
    description:
      'START HERE for "where is X" and "what would break if I change X". One call returns, together: '
      + 'where a name is DECLARED, its DEFINITION, how many times it is REFERENCED and in which files, '
      + 'and which files IMPORT the file it lives in. Give it an identifier, or a project-relative path '
      + 'to ask what a FILE defines and what depends on it. '
      + 'Prefer this over chaining symbols -> read_symbol -> dependents: it answers all of them in one pass '
      + 'over the files on disk, and there is no index to go stale. '
      + 'LEXICAL, not a parser: it cannot tell two things with the same name apart, cannot follow an alias '
      + 'or a re-export, and counts a mention in a comment as a use. Confirm anything you are about to rewrite.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'an identifier, e.g. "saveSettings", or a path, e.g. "src/web/settings.js"' },
        include: { type: 'string', description: 'glob limiting which files are searched, e.g. "src/**/*.ts"' },
      },
      required: ['what'],
    },
  },
  async run(input, ctx) {
    const what = String(input.what == null ? '' : input.what).trim();
    if (!what) return { output: 'locate needs a name or a path', isError: true };
    const root = path.resolve(ctx.cwd || process.cwd());
    const r = require('../locate').locate(root, what, { include: input.include || null });
    return { output: r.text, isError: !r.ok, meta: r.meta };
  },
};

/** WHAT IS THIS PROJECT? */
tools.understand = {
  mutates: false,
  schema: {
    name: 'understand',
    description:
      'What this project IS: how many files, which modules carry the most code, and what changed '
      + 'since the last session. Read this BEFORE listing directories or opening files to orient '
      + 'yourself - it is served from a persistent index and costs one stat pass over the tree, '
      + 'where reading your way in costs several requests. '
      + 'Follow it with `locate <name|path>` for anything specific. '
      + 'It is a summary, not the whole index, and it describes STRUCTURE, not behaviour.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(input, ctx) {
    const root = path.resolve(ctx.cwd || process.cwd());
    const pi = require('../projectindex');
    // THE WORKER READS, THE RUNTIME REMEMBERS
    let sync;
    try { sync = await require('../projectsync').open(root); } catch (e) {
      return { output: `the project index could not be built: ${(e && e.message) || e}`, isError: true };
    }
    const r = sync.refresh;
    const changed = r.changed + r.added;
    const note = [];
    if (!r.persisted) {
      // SAID, NOT SWALLOWED. A project that cannot be written to still works;
      // it simply pays the scan every time, and the reader should know why.
      note.push('', 'The index could not be written to .lain/ - this directory may be read-only. '
        + 'Everything still works; it is rebuilt each session instead of reused.');
    }
    if (r.truncated) {
      note.push('', 'The refresh ran out of its time budget, so some files are described by an '
        + 'older entry. Ask again to continue indexing.');
    }
    const NL = String.fromCharCode(10);
    // WHAT THE PROJECT ITSELF HAS RECORDED
    const lain = [];
    try {
      const lainstore = require('../lainstore');
      const architecture = require('../architecture');
      const dictionary = require('../dictionary');
      const wiring = require('../wiring');
      const scratch = require('../scratch');
      if (lainstore.has(root, 'architecture') || lainstore.has(root, 'concepts')) {
        const t = architecture.tally(architecture.load(root));
        const terms = Object.keys(dictionary.load(root).terms).length;
        const edges = wiring.load(root).edges.length;
        const facts = scratch.facts(root).length;
        lain.push(`${NL}Project records (.lain): ${t.nodes} architecture node(s)`
          + `${t.missing || t.damaged || t.drifted ? `, ${t.missing + t.damaged + t.drifted} MISSING/DAMAGED/DRIFTED — architecture show lists them` : ''}`
          + `, ${terms} concept(s), ${edges} wiring edge(s), ${facts} verified fact(s).`
          + (facts ? ' The facts are load-bearing: do not re-derive what they state.' : ''));
      }
    } catch { /* orientation never fails for want of the durable layer */ }
    // FRESHNESS, derived from the disk now — what is written in .lain/ against
    // what the files say. See freshness.js.
    let fresh = '';
    try {
      const f = require('../freshness');
      fresh = `${NL}${NL}${f.describe(f.report(root))}`;
    } catch { /* orientation never fails for want of it */ }
    return {
      output: pi.orientation(r.index)
        + `${NL}${NL}${require('../projectsync').say(sync.verdict, r)} (${r.ms}ms${r.targeted ? ', targeted refresh of changed paths' : ''})`
        + note.join(NL)
        + lain.join('')
        + fresh,
      meta: {
        indexed: r.scanned, reused: r.reused, rescanned: changed, ms: r.ms,
        // THE RUNTIME'S WORD, carried so a caller can tell "I have never seen
        // this project" from "it has not moved since you left".
        verdict: sync.verdict,
      },
    };
  },
};

module.exports = { tools };
