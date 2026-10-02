'use strict';

/**
 * THE CONVERSATION'S LOOK — one grammar for every place the conversation block
 * (core/client.js #convo: stream, cards, composer) is mounted (2026-09-30):
 *
 *   WIDE     Chat (.chat-main) and the full Coding Chat (.coding-center): a
 *            centred reading column (--chat-col). Each turn has a who-line — a
 *            small mark, the name, the time — and its text on a flat plane
 *            beneath it, the way the product's cards sit on the canvas. The
 *            composer is a little wider than the column (--composer-w).
 *   NARROW   the IDE's Coding Agent sidecar (.bp-convo): IDE-scale type, no
 *            bubbles — a small caps heading per turn, a hairline between turns.
 *
 * Type (final sizes, × the Typography setting): conversation 14.5 · sidecar
 * 13 · the who-line and captions 11.5–13.
 */

const CSS = `
.convo{display:flex;flex-direction:column;min-height:0;min-width:0}
.convo-head{display:none}
.stream{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 20px 8px;scroll-behavior:smooth}
.stream-empty{padding:12vh 4px 0;text-align:center;animation:lain-fade var(--t-page) var(--ease)}
.stream-empty .se-ic{display:grid;place-items:center;color:var(--accent-primary);margin-bottom:16px}
.stream-empty .se-ic svg{width:34px;height:34px}
.se-title{font:600 22px/1.3 var(--display);color:var(--text-primary);letter-spacing:-.01em}
.se-sub{font-size:var(--fs-body);color:var(--text-secondary);max-width:520px;margin:8px auto 0;line-height:1.55}
.msg{margin:0 0 22px;min-width:0;animation:lain-fade var(--t-panel) var(--ease)}
.msg .who{display:flex;align-items:center;gap:10px;font-size:var(--fs-body);font-weight:600;color:var(--text-primary);margin-bottom:8px}
.msg .who .av{flex:none;width:26px;height:26px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--text-primary);position:relative}
.msg .who .av::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--text-primary)}
.msg.user .who .av{background:var(--info);box-shadow:none}
.msg.user .who .av::after{background:#fff}
.msg.agent .who .av{box-shadow:inset 0 0 0 2px var(--accent-primary)}
.msg.agent .who .av::after{background:var(--accent-primary)}
.msg .who .at{font-weight:400;margin-left:auto;color:var(--text-muted);font-size:var(--fs-small);font-variant-numeric:tabular-nums}
.msg .who .prov{color:var(--accent-primary);font-weight:500;font-size:var(--fs-small)}
.msg .body{font-size:var(--fs-chat);line-height:1.62;color:var(--text-primary);overflow-wrap:anywhere}
.prose{white-space:pre-wrap;overflow-wrap:anywhere}
.msg .facts{margin-top:10px;padding-top:8px;border-top:1px solid var(--separator);font:12px/1.55 var(--mono);color:var(--text-muted);overflow-wrap:anywhere}
.msg.agent .who{color:var(--accent-primary)}
.msg.user.handoff .who{color:var(--accent-primary)}
pre.code{margin:8px 0;padding:10px 12px;background:var(--canvas);border-radius:var(--radius-sm);overflow-x:auto;font:12.5px/1.55 var(--mono);color:var(--text-primary);white-space:pre}
.plancard{margin:0 0 20px;background:var(--surface-base);border-radius:var(--radius-lg);overflow:hidden;box-shadow:inset 0 0 0 1px var(--separator)}
.plancard .ph{padding:10px 14px;font-size:var(--fs-small);font-weight:600;color:var(--accent-primary);border-bottom:1px solid var(--separator)}
.plancard .steps{padding:6px}
.plancard .step{display:flex;gap:9px;align-items:flex-start;padding:5px 10px;font-size:var(--fs-body)}
.plancard .step .m{flex:none;width:14px;color:var(--text-muted);font-family:var(--mono);font-size:12px}
.plancard .actions{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--separator);flex-wrap:wrap}
.act{display:flex;align-items:center;gap:9px;padding:4px 20px;font-size:var(--fs-small);color:var(--text-secondary)}
.act .clock{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--text-muted)}
#notice.note{margin:0 20px 6px;border-radius:var(--radius-md);background:var(--warning-weak)}
#notice.note.bad{background:var(--danger-weak)}
.card{margin:0 20px 8px;padding:12px 14px;border-radius:var(--radius-md);background:var(--surface-base);font-size:var(--fs-body)}
.card p{margin:0 0 8px}
.card .choices{display:flex;gap:8px;flex-wrap:wrap}
#askCard{min-width:0;box-sizing:border-box;overflow-wrap:anywhere}
#askCard p{white-space:pre-wrap;overflow-wrap:anywhere}
#askCard .plandoc{display:block;width:100%;box-sizing:border-box;min-height:220px;max-height:50vh;margin:0 0 10px;padding:10px 12px;resize:vertical;border:0;border-radius:var(--radius-sm);background:var(--canvas);color:var(--text-primary);font:12.5px/1.55 var(--mono)}

/* ---- WIDE: Chat and the full Coding Chat — a centred reading column, each turn on a plane ------------------- */
.chat-main .convo,.coding-center .convo{flex:1}
.chat-main .stream,.coding-center .stream{padding:16px 32px 8px}
.chat-main .stream > *,.coding-center .stream > *,.chat-main .card,.coding-center .card,.chat-main #notice,.coding-center #notice{width:100%;max-width:var(--chat-col);margin-left:auto;margin-right:auto;box-sizing:border-box}
.chat-main .composer,.coding-center .composer{width:100%;max-width:calc(var(--composer-w) + 40px);margin-left:auto;margin-right:auto;box-sizing:border-box}
.chat-main .msg .body,.coding-center .msg .body{margin-left:36px;padding:12px 16px;border-radius:var(--radius-lg);background:var(--surface-base);box-shadow:inset 0 0 0 1px var(--separator)}
.chat-main .msg.user .body,.coding-center .msg.user .body{background:var(--surface-raised)}
.chat-main .msg.user.handoff .body,.coding-center .msg.user.handoff .body{background:var(--plane-violet);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-primary) 28%,transparent);font-size:var(--fs-body)}
.chat-main .card,.coding-center .card{margin-top:10px}
.chat-main .act,.coding-center .act{max-width:var(--chat-col);margin:0 auto;width:100%;box-sizing:border-box;padding:4px 32px}
/* AN EMPTY LANE: the greeting and the input sit together in the middle. */
.chat-main .convo.is-empty,.coding-center .convo.is-empty{justify-content:center}
.chat-main .convo.is-empty .stream,.coding-center .convo.is-empty .stream{flex:0 0 auto;overflow:visible;padding-bottom:0}
.chat-main .convo.is-empty .stream-empty,.coding-center .convo.is-empty .stream-empty{padding:0 4px 26px}

/* ---- NARROW: the sidecar — IDE-scale type, a caps heading per turn, hairlines between turns ------------------- */
.bp-convo{flex:1;min-height:0;display:flex;flex-direction:column}
.bp-convo .convo{flex:1}
.bp-convo .stream{padding:4px 14px 6px}
.bp-convo .stream > *{min-width:0;max-width:100%}
.bp-convo .stream pre{white-space:pre-wrap}
.bp-convo .msg{margin:0;padding:11px 0 12px;border-top:1px solid var(--separator);animation:none}
.bp-convo .msg:first-child{border-top:0}
.bp-convo .msg .who{gap:8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px;color:var(--text-secondary)}
.bp-convo .msg .who .av{display:none}
.bp-convo .msg .who .at{font-size:11px;letter-spacing:0}
.bp-convo .msg .body{font-size:var(--fs-sidecar);line-height:1.55}
.bp-convo .msg.user .who{color:var(--text-primary)}
.bp-convo .msg.agent .who{color:var(--accent-primary)}
.bp-convo pre.code{font-size:12px}
.bp-convo .stream-empty{padding:8vh 6px 0}
.bp-convo .stream-empty .se-ic svg{width:26px;height:26px}
.bp-convo .se-title{font-size:15px}
.bp-convo .se-sub{font-size:12.5px}
.bp-convo .card{margin:0 12px 8px;font-size:var(--fs-sidecar)}
.bp-convo #askCard{flex:none;max-height:34vh;overflow:auto}
.bp-convo #notice.note{margin:0 12px 6px}
.bp-convo .act{padding:4px 14px}

@media (max-width: 760px){.chat-main .stream,.coding-center .stream{padding:14px 16px 8px}.chat-main .msg .body,.coding-center .msg .body{margin-left:0}}
`;

module.exports = { CSS };
