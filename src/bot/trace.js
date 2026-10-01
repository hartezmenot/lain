'use strict';

/**
 * WHERE A MESSAGE STOPPED — one receipt per stage of a messaging turn.
 *
 *   inbound → authorize → dispatch → model → outbound
 *
 * Every stage of one inbound message shares its receipt id (`m-` + the first
 * characters of the event key), so the channel view can say exactly which
 * stage a message reached and why it went no further. The adapter's own
 * failures (a poll that could not reach LAIN's runtime, a lost lease) land as
 * `adapter` rows with no message id.
 *
 * WHAT A RECEIPT CARRIES: platform, account, stage, outcome, a short reason,
 * sizes and ids. NEVER message text, never a token, never a model prompt. The
 * reason strings pass through redact.js on the way in.
 *
 * Persisted beside transport.json so a gateway running in another process
 * (`lain --bot`) is readable from the window too. Bounded; oldest first out.
 */

const fs = require('fs');
const path = require('path');

const STAGE = Object.freeze({ ADAPTER: 'adapter', INBOUND: 'inbound', AUTHORIZE: 'authorize', DISPATCH: 'dispatch', MODEL: 'model', OUTBOUND: 'outbound' });
const MAX = 200;

function file(dir) { return path.join(dir || path.join(require('../config').configDir(), 'bot'), 'trace.json'); }

function rid(eventKey) { return eventKey ? `m-${String(eventKey).slice(0, 10)}` : ''; }

let seq = 0;

class Trace {
  constructor(dir) {
    this.file = file(dir);
    this.rows = [];
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(d.rows)) this.rows = d.rows.slice(-MAX); } catch { /* first run */ }
    this.timer = null;
  }
  /** One stage of one message. `why` is a reason a person can act on, never content. */
  note(stage, { id = '', platform = '', accountId = '', ok = true, why = '', ...facts } = {}) {
    const row = { at: Date.now(), n: ++seq, rid: id, stage, platform, accountId, ok: Boolean(ok) };
    if (why) row.why = require('../redact').text(String(why)).slice(0, 200);
    for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== null && (typeof v !== 'string' || v.length <= 80)) row[k] = v;
    this.rows.push(row);
    if (this.rows.length > MAX) this.rows.splice(0, this.rows.length - MAX);
    this.flush();
    return row;
  }
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, rows: this.rows }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* a trace that cannot be written never stops a turn */ }
  }
}

/** Read what any gateway recorded. */
function read(dir) {
  try { const d = JSON.parse(fs.readFileSync(file(dir), 'utf8')); return Array.isArray(d.rows) ? d.rows : []; } catch { return []; }
}

/**
 * THE LAST OF EACH STAGE for one platform account, plus the last message's
 * path through the stages — "where did it stop" in one object.
 */
function summary(rows, platform, accountId = 'default') {
  const mine = rows.filter((r) => r.platform === platform && (!r.accountId || r.accountId === accountId));
  const last = {};
  for (const r of mine) last[r.stage] = r;
  const lastMsg = [...mine].reverse().find((r) => r.rid);
  const path_ = lastMsg ? mine.filter((r) => r.rid === lastMsg.rid).map((r) => ({ stage: r.stage, ok: r.ok, why: r.why || '', at: r.at })) : [];
  const stoppedAt = path_.length ? path_[path_.length - 1] : null;
  const lastError = [...mine].reverse().find((r) => !r.ok) || null;
  const lastAttach = [...mine].reverse().find((r) => r.stage === STAGE.ADAPTER && r.ok && /^attached/.test(r.why || '')) || null;
  // A ROUND TRIP: an authorized inbound whose reply Telegram acknowledged.
  const roundTrip = [...mine].reverse().find((r) => r.stage === STAGE.OUTBOUND && r.ok && r.rid) || null;
  return {
    lastInbound: last[STAGE.INBOUND] || null,
    lastAuthorize: last[STAGE.AUTHORIZE] || null,
    lastDispatch: last[STAGE.DISPATCH] || null,
    lastModel: last[STAGE.MODEL] || null,
    lastOutbound: last[STAGE.OUTBOUND] || null,
    lastAdapter: last[STAGE.ADAPTER] || null,
    lastAttach,
    lastError,
    lastRoundTrip: roundTrip,
    lastMessage: lastMsg ? { rid: lastMsg.rid, path: path_, stoppedAt: stoppedAt && !(stoppedAt.stage === STAGE.OUTBOUND && stoppedAt.ok) ? stoppedAt : null } : null,
  };
}

module.exports = { Trace, STAGE, rid, read, summary, file };
