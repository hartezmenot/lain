'use strict';

/**
 * NAMED STATES OF A SCREEN (D9) — "Capture state": the virtual actions that bring a screen into a state (a dropdown
 * open, a modal shown) recorded as steps, kept under a name, replayed on demand (headless or on the canvas). Steps,
 * not pixels: a state replays against the current code. Stored in .lain/design/states.json (never credentials).
 */

const fs = require('fs');
const path = require('path');

const ACTIONS = new Set(['click', 'tap', 'hover', 'longpress', 'type', 'press', 'scroll', 'drag', 'swipe', 'wait']);

class States {
  constructor(root) { this.file = path.join(root, '.lain', 'design', 'states.json'); }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  save(all) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(all, null, 2)); }
  list(screen) { const all = this.read(); return screen ? (all[screen] || []) : all; }
  capture(screen, name, steps) {
    const clean = (Array.isArray(steps) ? steps : []).slice(0, 30).filter((s) => s && ACTIONS.has(s.action)).map((s) => {
      const o = { action: s.action };
      for (const k of ['target', 'text', 'key', 'dx', 'dy', 'ms', 'to']) if (s[k] != null) o[k] = s[k];
      if (o.action === 'type' && /pass|secret|token/i.test(JSON.stringify(o.target || ''))) o.text = '';   // never a credential
      return o;
    });
    if (!clean.length) return { ok: false, why: 'no recorded steps — use Live, act on the screen, then capture' };
    const nm = String(name || '').trim().slice(0, 60) || `State ${(this.list(screen).length || 0) + 1}`;
    const all = this.read();
    all[screen] = (all[screen] || []).filter((x) => x.name !== nm).concat([{ name: nm, steps: clean, at: Date.now() }]);
    this.save(all);
    return { ok: true, state: { name: nm, steps: clean } };
  }
  get(screen, name) { return (this.list(screen) || []).find((x) => x.name === name) || null; }
  remove(screen, name) { const all = this.read(); all[screen] = (all[screen] || []).filter((x) => x.name !== name); this.save(all); return { ok: true }; }
}

module.exports = { States };
