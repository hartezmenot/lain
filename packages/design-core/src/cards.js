'use strict';

/**
 * CHANGE CARDS (D9) — a reviewable record of every Design edit that was kept: before/after screenshots, the code
 * diff, the measured proof, the snapshot it can be restored to, who made it (person or Agent), and for an Agent's edit
 * the frames of the virtual-cursor test it ran. Stored in .lain/design/artifacts/<id>/ (kept out of git through
 * .git/info/exclude). A card is a surface: nothing in it reaches the model unless the person comments on it, and
 * then the comment goes as their own prompt with the card's context.
 */

const fs = require('fs');
const path = require('path');

const MAX = 200;

class Cards {
  constructor(root) { this.dir = path.join(root, '.lain', 'design', 'artifacts'); }

  _write(id, name, data) { const d = path.join(this.dir, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), data); }

  /** Record a kept edit: { summary, diff, files, snapshot, proof, actor, screen, selector, node, before, after (PNG Buffers) } */
  add(c) {
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const card = { id, at: Date.now(), actor: c.actor || 'person', summary: c.summary || '', diff: c.diff || '', files: c.files || [], snapshot: c.snapshot || null, proof: c.proof || null, screen: c.screen || null, selector: c.selector || null, node: c.node || null, tier: c.tier || null, frames: 0, comments: [] };
    if (c.before) this._write(id, 'before.png', c.before);
    if (c.after) this._write(id, 'after.png', c.after);
    card.images = { before: Boolean(c.before), after: Boolean(c.after) };
    this._write(id, 'card.json', JSON.stringify(card, null, 2));
    this.prune();
    return card;
  }

  /** The frames of the Agent's virtual-cursor test, attached to its latest card. */
  addFrames(id, frames) {
    const card = this.get(id); if (!card) return null;
    frames.filter(Boolean).slice(0, 20).forEach((f, i) => this._write(id, `frame-${String(card.frames + i + 1).padStart(2, '0')}.png`, f));
    card.frames += Math.min(20, frames.filter(Boolean).length);
    this._write(id, 'card.json', JSON.stringify(card, null, 2));
    return card;
  }

  comment(id, text, by = 'person') {
    const card = this.get(id); if (!card) return null;
    card.comments.push({ at: Date.now(), by, text: String(text).slice(0, 2000) });
    this._write(id, 'card.json', JSON.stringify(card, null, 2));
    return card;
  }

  get(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, String(id).replace(/[^\w]/g, ''), 'card.json'), 'utf8')); } catch { return null; } }
  image(id, name) { const f = path.join(this.dir, String(id).replace(/[^\w]/g, ''), String(name).replace(/[^\w.-]/g, '')); try { return fs.readFileSync(f); } catch { return null; } }

  list(limit = 50) {
    let ids = []; try { ids = fs.readdirSync(this.dir).filter((d) => /^c\w+$/.test(d)); } catch { return []; }
    return ids.map((d) => this.get(d)).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  prune() { const all = this.list(MAX + 50); for (const c of all.slice(MAX)) { try { fs.rmSync(path.join(this.dir, c.id), { recursive: true, force: true }); } catch { /* keep */ } } }
}

module.exports = { Cards };
