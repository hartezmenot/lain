'use strict';

/**
 * REASONING SENT INLINE IN `content`, separated back out.
 *
 * Live, 2026-09-18: kr/claude-sonnet-4.5-agentic through 9router streams its
 * working-out as `<thinking>…</thinking>` INSIDE `delta.content` — there is no
 * `reasoning_content` field on that route. provider.js already keeps reasoning
 * as its own event so it never enters the transcript as speech; this was the
 * one spelling it did not recognise, and the screen drew "I need to report this
 * clearly to the user. </thinking>" as the answer.
 *
 * A streaming state machine, because tags arrive split across chunks
 * (`<thin` + `king>`): a tail that could still become a tag is held back until
 * the next chunk decides it. Nothing is dropped — every character leaves as
 * either `text` or `reasoning`.
 */

const OPEN = ['<thinking>', '<think>'];
const CLOSE = ['</thinking>', '</think>'];

class InlineThink {
  constructor() { this.buf = ''; this.inside = false; }

  /** @returns {Array<{type:'text'|'reasoning', chunk:string}>} */
  push(chunk) {
    this.buf += String(chunk || '');
    const out = [];
    for (;;) {
      const tags = this.inside ? CLOSE : OPEN;
      let at = -1;
      let tag = '';
      for (const t of tags) {
        const i = this.buf.indexOf(t);
        if (i >= 0 && (at < 0 || i < at)) { at = i; tag = t; }
      }
      if (at >= 0) {
        if (at > 0) out.push({ type: this.inside ? 'reasoning' : 'text', chunk: this.buf.slice(0, at) });
        this.buf = this.buf.slice(at + tag.length);
        if (this.inside && /^\s+/.test(this.buf)) this.buf = this.buf.replace(/^\s+/, '');
        this.inside = !this.inside;
        continue;
      }
      // Hold back a tail that could be the start of a tag.
      const keep = partialTail(this.buf, tags);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ type: this.inside ? 'reasoning' : 'text', chunk: emit });
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** End of stream: whatever is held is what it looked like. */
  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest ? [{ type: this.inside ? 'reasoning' : 'text', chunk: rest }] : [];
  }
}

function partialTail(s, tags) {
  let best = 0;
  for (const t of tags) {
    for (let n = Math.min(t.length - 1, s.length); n > best; n--) {
      if (s.endsWith(t.slice(0, n))) { best = n; break; }
    }
  }
  return best;
}

module.exports = { InlineThink };
