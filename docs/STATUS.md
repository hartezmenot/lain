# LAIN v2 — verification status

Labels are used exactly as defined; nothing is upgraded because the code looks
correct. A green run of unit/integration/smoke never implies LIVE PROVIDER.

```
UNIT-VERIFIED · INTEGRATION-VERIFIED · LIVE-VERIFIED · LIVE PROVIDER VERIFIED
SIMULATED · TEST-ONLY · PARTIAL · MISSING · NOT VERIFIED
```

Tiers: `unit` → UNIT-VERIFIED · `integration` → INTEGRATION-VERIFIED ·
`smoke` (spawns the real binary) → LIVE-VERIFIED · `live` (contacts a real
provider, self-skipping) → LIVE PROVIDER VERIFIED.

## Stabilization, specialist workers, subagent isolation, CLI closure (2026-09-23)

Worker architecture, contracts, the recruitment gate and its measurements are
in `docs/WORKERS.md`. The runtime contract is updated in `docs/CLI.md`.

| Defect / request | Owner / fix | Regression | Evidence |
|---|---|---|---|
| `/goal <text>` and the `/goal` capture only STORED the goal; a pasted task needed `/goal continue` | `goalcommand.execute`, `composemode.take` → `{run}` → `App.handle` as the person's own message. `/goal show` / `continue` / `clear`. A goal set mid-turn is queued behind the turn. | `goalexecute` ×7, `interactivefallback`, `goalplan`, `turnadmission` | UNIT + INTEGRATION + REAL TTY (`closure-cli` G1) |
| `/fast` / `/eco` were one-way (`/fast off` only); `/eco` was a hidden alias | `profile.toggle`: bare = toggle its own profile; `on`/`off` explicit; `/normal` resets; FOCUS and AUTO/MANUAL/PLAN untouched | `execprofile` TOGGLE ×2 | UNIT + REAL TTY (P: all 7 transitions in the header) |
| Silent periods: every open request said THINKING, and a 10 KB tool call streaming was indistinguishable from a dead socket (argument deltas were parsed and discarded) | `src/streamprogress.js`: one record per request, filled by `provider.js` (bytes, data frames, tool-argument bytes, hidden `thinking_delta`) and `turn.js` (text, reasoning). WAITING / THINKING / STREAMING / PREPARING TOOL · `edit_file · 9.6 KB` / STALLED (45 s without data, 120 s before the first frame; keepalives are not progress). Activity rectangle with the request clock and the model's own visible words. The strip shows the same word. RATE LIMITED is its own state. | `streamprogress` ×8 (real SSE bodies through both protocol parsers) | UNIT + REAL TTY (L1 STREAMING + commentary, L2 PREPARING TOOL · write_file · 5.0 KB, no STALLED) |
| Force-close returned the person to the previous completed prompt: the session was written only when a turn ended | `src/inflight.js`: durable before every side effect, throttled for reads; STARTED → COMPLETED/FAILED ledger. On load of a dead owner's session: FILE writes classified LANDED / NOT_APPLIED by the target's hash, COMMAND UNKNOWN and never re-run, READ NOT_COMPLETED; missing tool results written (no 400); turn kept as `crashed`; `RECOVERED · cut off at step N · type continue to resume`. A live owner's session is left alone. | `inflight` ×6, `forceclose` (integration) | UNIT + INTEGRATION (real binary, TerminateProcess mid-command) + REAL TTY (G2/G3: `/goal` paste → hard kill → `--resume` → goal, CHANGE row and recovery back) |
| In-process background jobs were orphaned with no record when LAIN died | `inflight.noteJob/jobEnded/recoverJobs`: ORPHANED (pid alive) / LOST, in the handover: "do not start it again" | `inflight` JOBS | UNIT |
| Subagents (FOUNDATION/IMPLEMENTER) wrote the canonical project directly | `src/candidates.js`: isolated git worktree (or a snapshot outside git), candidate harvest, destructive-patch protection (out-of-scope, undeclared deletion, rename from outside, binary, size), main-agent-only `integrate_candidate` through the normal write door, anchored on the base bytes, CONFLICT when the canonical moved; pipeline pauses for integration; no workspace outlives the call | `candidates` ×8, `subagents` | UNIT (real git) + **LIVE PROVIDER** (below) |
| Found live: every isolated child's write was refused as a STALE work order | work-order baseline measured in the child's workspace, not the canonical tree (the checkout differs in line endings) | `candidates` "baselined IN ITS WORKSPACE" | UNIT + LIVE PROVIDER re-run |
| Found by the same test: LAIN's own `.lain/` bookkeeping inside a workspace made every candidate REJECTED | excluded from harvest | same | UNIT |
| Found live: integration flipped LF files to the checkout's CRLF | the canonical file's line endings win | same | UNIT |
| Found live: `kr/claude-haiku-4.5` could not be selected without an effort; its `-thinking`/`-agentic` siblings folded the plain upstream away (`upstreamId: null`) | `catalog.js`: a family keeps its plain id; no effort → the plain model | `catalog` plain-id | UNIT + LIVE PROVIDER (used for the run below) |
| OpenCode Go refused every request (400 MissingSessionID) | `src/routeheaders.js`: `user-agent: lain/<ver>` + stable per-session `x-opencode-session` for opencode.ai hosts, in the adapter | — | LIVE (the error moved to the account's own 403 "active Go subscription required") |
| ECO spent the same tokens as NORMAL: measured ±0.5%, ~15.4k tokens of tool schemas on every request | `src/schemacompact.js`: ECO sends every tool (same names, same parameters) with compact prose that keeps every rule sentence | `schemacompact` ×3 | UNIT + measured (below) |
| FAST did not auto-background long work | `bgdetach.armAuto`: in FAST, a final smoke / full suite / build still running after 20 s is detached exactly like `/bg` (same PID, rejoins, task stays open); targeted runs never | `fastautobg` ×3 (real child process) | UNIT |
| Computer `ui_tree` sent up to 20,000 chars and silently dropped rows past 200 | `src/evidenceslice.js`: `focus` → Evidence Slice (matches, path, region, confidence, receipt); raw tree stored and `expand`-able; re-reads counted as false narrowing; a long unfocused tree says what it held back | `evidenceslice` ×5 | UNIT |
| "thanks, that worked" / "what did you change" / "show me the plan" were IMPLEMENT (a prose answer drew the wake-up and BLOCKED); yes/no judgements were EXPLAIN | three narrow rules in `mode.js` (found by the gate evaluation) | `mode` workergate | UNIT |

**Measured, not assumed**
- **ECO tokens**: same scripted fixture, the turn's own wire audits, 5 requests.
  FAST 129,282 · NORMAL 128,723 · **ECO 109,566 (−14.9%)**. Before the change
  ECO was 129,673. This is deterministic. **NOT VERIFIED** with a live model:
  whether compact descriptions change what the model does.
- **Evidence slice**: 423-node window, 22,330 → 640 chars (×34.9), about
  5,400 flagship tokens avoided on one observation (unit fixture; not measured
  on a live desktop).
- **Recruitment gate (Jev role, intent tie-break)**: the local Qwen3-VL-4B
  (llama-server) lifts the rule-default cases 57% → 79% at 225 ms but is wrong
  25% of the time when it answers → **FAIL**, not recruited. Jev itself was not
  evaluable: its free tier is OpenCode-client-only (403) and Zen had no funds
  (402). Laya and Violetto are not installed anywhere reachable.

**LIVE PROVIDER VERIFIED** (`kr/claude-haiku-4.5` via 9router, the real
binary with `-p`, an isolated config home, and a git fixture):
- the model delegated two IMPLEMENTERs in PARALLEL;
- each worked in its own worktree → two ACCEPTABLE candidates, and nothing
  was written to the project;
- the main agent called `integrate_candidate` twice, then wired `formatSum`
  to `add()` itself (`edit_file` / `apply_patch`);
- `npm test` → `2 passing`;
- `git worktree list` shows only the main tree; no branch; no stash;
- 10 requests, 264k input tokens.

The first attempt failed on the two defects above (stale baseline, then
`.lain/`), both fixed and re-run.

**Provider matrix** (2026-09-23, LAIN's own `provider.chat`; streaming · native
tools · parallel tools · tool-result continuation · large args · structured):

| Route | Result | Exact limitation |
|---|---|---|
| 9router `kr/claude-haiku-4.5` | stream ✓ · 1 tool call ✓ · continuation ✓ ("42") · parallel ✓ (2 calls, distinct ids) · 6.6 KB args ✓ · `response_format` ignored | Args are **buffered by the route** (4 frames after ~10 s), so LAIN shows WAITING rather than PREPARING TOOL; after 30 s it says the route may be holding a tool call |
| 9router `cx/gpt-5.x` (GPT via Codex) | ✗ | `cx/gpt-5.4(-mini)`: "not supported when using Codex with a ChatGPT account"; `cx/gpt-5.5` / `5.6-luna`: usage limit (reset ≈2 min), then after the reset **"invalidated oauth token"** (401). Upstream auth; re-authenticate Codex in 9router |
| 9router `cl/~z-ai/glm-latest` (**the current selection**) | ✗ | Cline 401: "re-authenticate your Cline account" |
| 9router `oczen/jev-1.13-free`, Zen `jev-1.13-free` | ✗ | 403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode" |
| OpenCode Zen `gpt-5-nano` | ✗ | 402 insufficient account funds |
| OpenCode Go `gpt-5.6-luna`, `glm-5.3-flash` | ✗ → ✗ | 400 MissingSessionID. **LAIN adapter fix** → 403 "active OpenCode Go subscription required" |
| z.ai `glm-4.5-air` | ✗ | 429 weekly limit, reset 2026-09-27 16:30 |
| OpenAI direct `lain:openai` | not probed | catalog state AUTH_REQUIRED (invalid key) |

LAIN classifies all of these correctly: AUTH / RATE_LIMITED with the stated
reset / MODEL_UNAVAILABLE / QUOTA, with no retry storm. **None of the GPT
failures is LAIN's subagent system.** On this machine, today, no GPT route
can carry any request at all. The subagent path needs only native tools and
continuation, which is Tier 1 on the one working route. A Tier 2 mediated
protocol was not needed and was not built.

**TOTALS** (final code, this machine, `LAIN_TTY_PYTHON` set, each tier in one invocation):

| Tier | Result |
|---|---|
| unit | 3219 / 3219 |
| workflow | 7 / 7 |
| integration | 214 / 214 (with the new real hard-kill test) |
| global | 95 / 95 |
| harness | 37 / 37 (shared Core changed: turn, provider, session) |
| distribution | 48 / 48 |
| cli (REAL ConPTY) | **496 / 496** (2247 s), including `closure-cli` 7/7 |

The previous full CLI run on the same code was 494/496:
- `closure-cli` P raced a repaint and was fixed to wait for the command's
  receipt;
- `ask` "chosen answer" is the known fixed-400 ms stdin staging race (3/3
  when run alone, and green in both other full runs).

A mid-pass run caught one real regression, fixed before the final runs: the
model's sentence flickered out of view for the length of a tool call.
Narration now enters the feed at the call's start.

**NOT VERIFIED**
- ECO's compact descriptions with a live model: the saving is measured on
  the wire; the behavioural effect is not.
- Live desktop Evidence Slices: unit fixture only.
- GPT as a subagent: no GPT route can carry a request on this machine today
  (see the matrix). A Jev / Laya / Violetto model was not recruited.
- FAST auto-background in a real terminal: unit only, with a real child
  process.

**Operational note:** 9router was not running at the start of this pass. It
was started for the matrix and the live run, then stopped again. The user's
config was only read.

## Final stabilization closure + steer (2026-09-19)

Same method as the self-diagnosis pass below:
- the real binary in a real ConPTY;
- live `kr/claude-sonnet-4.5` / `kr/claude-haiku-4.5` through 9router behind a
  logging proxy that can inject faults (including a long-reset 429);
- isolated config homes.

The user's `config.json` was only changed by the user's own model selection;
all connections were preserved.

| Defect (observed) | Owner / fix | Regression | Evidence |
|---|---|---|---|
| Diff "sometimes does not show": mid-turn the only diff was the transient reel animation. Edits were plain rows with no `[Diff]` until the turn settled. | The latest live edit row per file carries `[Diff]` in place (`turnsections.pushLiveChange`), keyed as the settled CHANGE row. The live account stays interleaved: a first version moved edits into a live CHANGE block, and `screen-context` caught the broken order. Live rows carry path + per-call size (`turnevents`, `turn.js` `size`). | `difflifetime` J/K/L/M | UNIT + REAL CLI (opened mid-turn, activity 1 line, still open after DONE) |
| `NETWORK — stream inactive for 60s` + `PROVIDER REFUSED — the provider stopped answering` + `/compact` tip (user report; session `20260919-163929-pwqs`: 40 actions, then silence while the router buffered a ~12KB tool call) | `provider.js` mid-stream bound 60s → 180s. `finish.resumable`: a stall after text keeps the text and resumes (≤2). One `STREAM STALLED` row. No "refused" note for network. No `/compact` tip after a non-context failure. | `streamstall` ×3, `falsedone` C (its server now actually delivers the partial text first — before, it cut the socket before flushing, so C never exercised a mid-reply failure) | UNIT (real SSE server) |
| Known 42m reset: the row quoted the provider body, and `MODEL INTERRUPTED — rate-limited` stayed under every later turn | `ui/failure.js`: `RATE LIMITED · <model> · reset in 42m · 18:04` (DAILY/WEEKLY LIMIT with day). `rate-limited` is not durable news. `ratelimit.human` says days. | `knownreset` UX | UNIT + REAL CLI |
| "No bug to fix; `npm test` passes" ended BLOCKED `no-progress`, with a raw `MODEL INTERRUPTED — no-progress` note | `wakeup.isPassingCheck` counts a passing shell test command. `TASK PENDING` wording. | `wakeupbg` | UNIT (live ECO session) |
| `HOW TO RUN · npm start (if applicable)` for a package with no start script (recurs despite the prompt rule) | `src/runcheck.js` checks the report against `package.json` and warns on that turn. | `runcheck` ×3 | UNIT + REAL CLI (fired live) |
| Folded narration read "…`amount - pct` Changed to…" | `condense.fold`: kept sentences end as sentences; headings are not kept. | `condense` FOLD | UNIT |
| Rate-limit model switch, `continue` shelf and smoke-failed continuation drawn as a second USER message | `phrasing.SELF_ASKED` captions. `finalsmoke` uses `smoke-failed`. The caption test now walks every `from`, not four. | `noglue` | UNIT |
| A subagent whose turn ended `provider`/stalled/`no-progress`/blocker was reported DONE. A pipeline failing at stage 2 of 3 said "1/2 completed", with no mention of the stage that never ran. | `subagents.runOne` requires a natural end. `report` shows completed/failed/**not run** + HANDOFF. | `subagents` HANDOFF | UNIT |
| `/bg` receipt "pid … keeps running" stayed open after the job finished | `commands.receipt()` — this run's output closes itself | `bgps` | UNIT |
| WebApp: any server answering `/ping {lain:true}` received the signed `initData` (replayable 24h) | `webapp.js`: button URL carries a ping key; `/ping?n=` → HMAC; the page verifies (WebCrypto) before `/auth`. The launch URL was built nowhere — now in bot status (`bot.webapp.pageUrl`). | `capabilities_request` WEBAPP | UNIT (the page's own probe code vs a real impostor server) |
| A live `replace_symbol` edit left no row and no `[Diff]` until DONE, across a 90s smoke. The five symbol edit tools have no change verb, so `durable()` said no. | `ui/durable.js` counts the canonical edit set (`turnsections.EDIT`) | `difflifetime` K (symbol edit) | UNIT + REAL CLI (`[Diff]` on `replace symbol · src/pricing.js` mid-turn, opened, still `[× Diff]` after DONE) |
| `replace_symbol` duplicated the JSDoc: the model's replacement carried the comment `read_file` had shown it, and the range started at `function` | `semantic.js` `leadingCommentStart`: a replacement that brings a comment replaces the one directly above. Without one, the existing comment is kept. | `semantic` REPLACE_SYMBOL doc comment | UNIT (seen live; the re-run's replacement had no comment) |
| ECO spent more tokens than FAST for the same outcome (fix → suite → fix → suite) | ECO guidance: fix all failures, then one run | — | LIVE (measured, n=1 per profile) |

REAL CLI VERIFIED in this pass (live model, real ConPTY):
- profiles `/fast` `/normal` `/slow` and FOCUS on/off/combined, header clean after every transition;
- the Diff lifecycle;
- a known 42m reset:
  - one request, zero premature retries;
  - a second prompt during the wait sent nothing;
  - commands work while waiting;
  - Change model → retried now → row cleared;
- parallel subagents (`AGENTS 2 · IMPLEMENTER · IMPLEMENTER`, only while they ran);
- pipeline SCOUT → IMPLEMENTER → VERIFIER (`AGENTS 1` per stage);
- `/bg` of the final smoke: same PID, DONE only after it settled.

FAST was observed issuing up to 4 calls per step, with reads prefetched
concurrently (0 ms awaits). With no hint, FAST did **not** delegate a small
two-component task, and was not forced to.

REAL DESKTOP VERIFIED — Computer MCP capability matrix:
- `computermcp-real` 8/8 covers WINDOW_DISCOVERY, SCREENSHOT, SEMANTIC_CLICK,
  TYPE and POSTCONDITION_VERIFICATION: a Calculator batch verdict PASSED, and
  a file on disk after a native Save As.
- A direct probe of LAIN's fixture window covers FOCUS (the foreground
  handle), UI_TREE (`inputBox` and `saveButton` present), TYPE +
  TEXT_READBACK (a UIA value, not OCR), and KEYBOARD (ctrl+a, delete →
  empty).

NOT VERIFIED:
- **Real Telegram network**: no bot is configured on this machine. The bot
  suites pass on fixtures, and the WebApp auth is unit-verified against real
  HTTP servers.
- **Final-smoke fail→reopen in a real terminal**: whether the plan's steps own
  the failing file is up to the model, so it can't be forced. It is
  unit/workflow verified (`finalsmoke`).
- **ECO token saving**: not demonstrated on a small fixture.

FINAL TIERS on the final code (each in one invocation, `LAIN_TTY_PYTHON` set, nothing reported unsupported):

| Tier | Result |
|---|---|
| unit | 3141 / 3141 |
| workflow | 7 / 7 |
| cli (real ConPTY) | **486 / 486** (2224 s) |
| harness | 37 / 37 |
| global | 95 / 95 |
| integration | 213 / 213 |
| distribution | 48 / 48 |

TEST RACES FIXED (the invariant is unchanged; each race was measured under 100% CPU from other workloads):
- `realtty` K took its streaming snapshot at a fixed 1.2 s. It now waits
  until the turn is visibly streaming, and the resizes still land mid-stream.
- `harness-lifecycle` OWNERSHIP job-lease checked the leaf port the instant
  every PID was dead. The port was seen answering 52 ms later, then closed.
  It now allows 2 s for "released"; a leaked listener stays open indefinitely.
- Under the same load, the OWNERSHIP tests with 8 s supervisor start windows
  also fail intermittently. They pass in isolation and when load drops.
- `distribution` once saw `Compress-Archive` report success without writing
  the file. A direct build and a re-run are 48/48.

LIMITATIONS:
- DONE can stand over a suite with failures that were already there, when the
  model scoped the fix and says so. LAIN keeps no baseline of failures that
  existed before the change.
- The model picker lists sub-routes of one router as separate rows
  (`Claude Haiku 4.5 (gh)`/`(kr)`, `Claude 4.5 Haiku (cu)`).

## Self-diagnosis pass — LAIN driven live through a real model (2026-09-18/19)

LAIN was used as a person uses it: the real binary in a real ConPTY (pywinpty
+ pyte, driven step by step), a live model through 9router
(`lain:localhost`; `kr/claude-sonnet-4.5`, `kr/claude-haiku-4.5`), every wire
request and SSE response captured by a logging proxy in front of the router,
isolated config homes per run (the user's `~/.lain-v2/config.json` was
snapshotted and never written). Each defect below was observed live, traced
to its owner, fixed, given a regression named for the invariant, and — where
marked LIVE PROVIDER VERIFIED — re-run live on the fixed binary.

| Defect (observed live) | Owner / root cause | Regression | Evidence |
|---|---|---|---|
| First read of 4 different functions in one batch steered "NON_PROGRESS … observation 3" | `readreceipts.covering`: a symbol/one-file-grep receipt (no range) passed as a whole-file read | `nonprogress-semantic` distinct-symbols | UNIT (fails without fix) |
| Router-wrapped upstream refusals (`503` + `[codex/…] [429] … reset after 1m 59s`, `[401]` revoked token, `[402]`, `[403]`, `[410]`) shown as `Network 503`, retried at 5s×10 | `errors.classify` read only the outer status; stated reset ignored | `errors` wrapped-429/401/402/403/410 | UNIT + LIVE PROVIDER (401 → NOT AUTHENTICATED, no retry) |
| One model's refusal shut EVERY model on the router (`kr/…` showed UNAVAILABLE after `cx/…` failed) | `availability` keyed by connection only; `failover` read a namespaced id nothing recorded | `availabilityscope` | UNIT + REAL CLI |
| `/model` route view: Enter did nothing (cursor on an info row, no marker) | `ui/panel.push` skipped the land-on-choosable rule | `panelpush` | UNIT + REAL TTY |
| Report said "How to run: npm start" for a project with no start script | `prompt.js` example was a concrete, copyable command | `promptexample` | UNIT |
| "N unfinished turn(s)…" startup line redrawn under every turn | `repl.js` wrote it after `ui.enable()` into the trailing transcript | `transcriptrule` | UNIT + REAL TTY |
| `[Diff]` drew two edits 8 lines apart as −8 +8; count beside the file said +8 | `panes.unified`/`countChanges` prefix/suffix span | `copy-diff` two-hunks | UNIT |
| PLAN refusing `run_tests` closed the turn "NOT VERIFIED · npm test failed", ✗ under VERIFY | refused call recorded as a command verdict (`lifecycle.observeTool`, `turnsections`) | `execmodes` refused-check | UNIT |
| `/bg` → model `job_wait #2` → `no job "2"` → re-ran the 90 s smoke (2:12 total) | job tools read `app._jobs`; `/bg` registers in `app.jobs` | `bgjobids` | UNIT + LIVE PROVIDER (1:42, one run, result rejoined, same PID) |
| Follow-up turn told the working tree held one scratch file while 2 sources were modified | `gitsnapshot.prefetch` left the previous turn's snapshot in place while the new one measured | `gitsnapshot` withdraw-on-prefetch | UNIT |
| "Do not change test/run.js" answered correctly, then woken; model asked "What feature should I add?" | `wakeup` ACTION_RE matched negated verbs | `wakeupbg` negated-constraint | UNIT |
| `/model` mid-turn: header said haiku, 7 more requests went to sonnet | `runTurn` resolved the provider once | `turnswitch` | UNIT + LIVE PROVIDER (switch at the next step, same wire history) |
| "Use the browser to open <url> and tell me what it shows" → 21 tool calls hunting the project for the server | `taskclass` fell to PROJECT_DIAGNOSTIC + TROUBLESHOOT framing | `taskclass` observe | UNIT + LIVE PROVIDER + REAL BROWSER (1 call, 16 s) |
| Model's inline `<thinking>…</thinking>` drawn as the answer | chat parser read `delta.content` whole | `inlinethink` (tags split across chunks) | UNIT |
| Ctrl+C mid-request drawn "PROVIDER REFUSED — not answering: aborted", counted against the route | abort flowed into the provider-failure path | `turnswitch` abort | UNIT |
| Plain question ("Which function…? One line.") framed as an implementation request | `mode.js` had no question rule → IMPLEMENT default | `mode` plain-question | UNIT |
| Shell `rg`/`grep` exit 1: `[CLASSIFICATION: APPLICATION_ERROR]` above `[no match]` | `execution.classify` ignored the shell's no-match verdict | `exec` through-the-tool | UNIT |
| Picker listed 16 `tokenrouter/…` ids (live FreeBuff endpoint) that selection refuses | catalog did not apply the retired rule; first fix overreached (19 folded ids) — corrected to the canonical id | `retired` catalog | UNIT + audit on a config copy |
| Same finding restated at 3 steps + RESULT | `turnsections.pushTurn` drew every step narration | `restatementfeed` | UNIT |
| A turn's "last check was still failing" warning drawn under the NEXT turn's ✓ DONE | `render.notice` into the trailing transcript | `conversation` contradiction-in-its-turn | UNIT |
| **Fake DONE**: "Find and fix these bugs" → 5 reads → "Found both bugs:" → finish `stop` → ✓ DONE, nothing changed | `wakeup.decide` excused any turn with tool calls; router's `stop` was legitimate | `wakeupbg` reading-is-not-fixing | UNIT + LIVE PROVIDER (re-run: fixed, 8/8, DONE only after verification) |

**Verified live, no change needed:** Diff open/close by second click, × and
Esc restoring the exact prior screen (also when scrolled); AUTO/MANUAL/PLAN on
Shift+Tab, PLAN refusing mutation with no countdown, `/plan accept` executing
with durable 1/4…4/4; Turn B immediately after DONE; one BLOCKAGE/ADAPTED for
a 650 KB file then targeted reads; `request_browser` → permission → isolated
browser → evidence (REAL BROWSER); `request_computer` → permission → real
bridge observation (REAL DESKTOP, observe-only); injected 429 → RATE LIMITED
countdown → recovery, no red state; restart + `--resume` with no stale warning;
`/continue` after Ctrl+C carrying the tool history (no restart); `/focus` +
`/fast` in the header and on the wire; built-in `grep` keeping
match / no-match / NO FILES IN SCOPE / error apart; real-git A/B (A passes, B
fails → A integrated, canonical re-verified, no worktree/branch/tmp residue);
config load→save on a copy of the user's config (all 6 connections
byte-identical). 9router is `lain:localhost`, an ordinary native custom
endpoint — consistent, not retired, nothing prunes it.

**False suspects:** the sticky `USER ·` row showing the newest turn while
reading an older one is the documented jump-back anchor; the steer queue
delivering after the turn is the documented WAIT mode (Enter twice = NOW);
a frozen screen during a 2-hour idle was the diagnostic PTY reader, not LAIN
(the session record showed the turn completed correctly).

The fake-DONE rule counts as the change: a project mutation, a produced
Cowork artifact, a passing `run_tests`/`validate`, or a question the person
answered in the turn. Three scripted fixtures modelled "fix it" as a listing
plus "Done." and were updated to make a real change (`turnadmission`,
`screen-context`, `wakeupbg`).

**Totals** (final code, this machine, `LAIN_TTY_PYTHON` set): unit 3093/3093 ·
integration 213/213 · workflow 7/7 · harness 37/37 · cli (REAL TTY) 485/486 in
the full run, the one failure being the `screen-context` fixture above, 6/6
after it was corrected · global 95/95 · distribution 48/48.

**Not verified:** Telegram WebApp from a real client, Tailscale/ZeroTier
routes, subagents with a live model (unit only), Computer MCP actions beyond
observation.

## CLI stabilization pass (2026-09-18)

The runtime contract is `docs/CLI.md`; this section is the evidence. No item
below is LIVE PROVIDER VERIFIED — every turn in these tests is the mock
provider. "REAL TTY" is ConPTY + pyte, read cell by cell
(`LAIN_TTY_PYTHON`); "REAL DESKTOP" is the compiled UIA bridge on this
machine; "REAL BROWSER" is an isolated Chromium.

| Area | What changed | Evidence |
|---|---|---|
| Screen | Header `LAIN · project · model` + right-side run state; transient ACTIVITY box (safe summaries, Ctrl+O); finished turn drawn CHANGE → VERIFY → RESULT; `file:line` opens a temporary view | REAL TTY (`stabilization-cli` A/B, `screen-context`, `workspace`) |
| Diff | `[Diff]` expands the real hunk; `[× Diff]`, a second click and Esc close it and restore scroll; the file name on the same row opens the file (column-aware) | REAL TTY (`stabilization-cli` B) |
| Modes | AUTO/MANUAL/PLAN on Shift+Tab (`execmode.js`); PLAN refuses mutations and shows no countdown; `/plan accept` executes | REAL TTY (A) + unit `execmodes` |
| `/focus`, `/fast` | Session preferences, shown in the header, persisted | REAL TTY (C, H) |
| Wake-up | One hidden, framed wake-up for an execution turn that answered in prose only; a second → `no-progress` / BLOCKED | unit `wakeupbg`, integration `turnadmission` |
| `/bg` | Detaches the running process (same PID) or a read-only reasoning branch; results rejoin with a BG COMPLETE notice | REAL TTY workflow `bg` + unit |
| Leases / subagents | SCOUT/FOUNDATION/IMPLEMENTER/VERIFIER/RESEARCHER with validated scopes; parallel only for disjoint write scopes | REAL TTY (D) + unit `subagents` |
| A/B | Isolated detached worktrees off a ref-less base commit; objective selection; cleanup | unit with real git |
| Browser | `/browser` canonical, `/chrome` hidden alias; router chrome/workshop/isolated; `request_browser` asks, then executes | REAL BROWSER (C) |
| Computer | `request_computer`; bridge accepts a Win32 `Button` misreported as `Pane` (build 26200) | REAL DESKTOP `computermcp-real` 8/8 |
| Decisions / Telegram | One file-backed decision, first valid answer wins, HMAC-signed remote answers; attention events | integration `bot-attention` (real Rust poller, fixture Telegram API) |
| WebApp | Progress-only, Telegram initData verified, short-lived token; LAN → Tailscale → ZeroTier | unit only — NOT VERIFIED against a real Telegram client |
| DOWNLOAD | Own permission class, separate from EXECUTE_FILE | unit `capabilities_request` |
| Compaction UI | Ticker removed; one quiet tip at high fill (`compacttip.js`) | unit |
| Rate limit | A limit from an earlier process is history, not a live gate; not red on resume | REAL TTY (E) + unit `livedefects` |
| Models | Catalog family folding (access tiers join one row); `/model` lists models, sources under `external:` | REAL TTY (F) + unit |
| Retired bridges | omniroute / tokenrouter pruned; **9router supported** (see side effect below) | unit `retired` |
| Steer hygiene | Equivalent steers collapse to one CURRENT INTENT (a correction wins); repeated wire messages fold; handover carries state, not narration | unit `intentcoverage`, `handover`, `workingcontext`, `reentry` |
| Read coverage | Elided whole read is narrowed next time (outline + head), blockage reported once and work continues; confirmed ranges in the digest; zero-file search ≠ no match | unit `intentcoverage`, `contextcost` |
| Control window | `bin/lain-control.js` exits when its directory or its LAIN is gone (orphans of test homes were found running) | unit `controlwindow` (real viewer process) |
| Workshop | Poll race in `toggle()` hid the panel while the preview drew into it; a viewport reload now waits for the NEW document to load (it waited a fixed 400ms, and under load a 900px page "fit" a 390px phone — a false PASS) | REAL BROWSER `workshop-real`, alone and under the full harness tier |

**Audits.** Sakana Fugu: ABSENT (zero references). OpenRouter: a model
source only; subagents are model-generic through the work-order `model`
field — unit-level only, no live run.

**Side effect, stated.** The first version of `retired.js` pruned the
user's real config on load-then-save: the omniroute entry (9router on
:20128) and two tokenrouter entries were removed. 9router was then made a
supported bridge again, and the user re-added it as `lain:localhost` →
:20128 (live, 617 models cached). The tokenrouter entries were not restored.

**Totals** (this tree, this machine, `LAIN_TTY_PYTHON` set, no self-skips):

| Tier | Result |
|---|---|
| unit | 3065 / 3065 |
| integration | 213 / 213 |
| workflow | 7 / 7 |
| cli (REAL TTY) | 486 / 486 — 485 in the full run; `stabilization-cli` 18/18 on rerun after its click was aimed at `[Diff]` rather than the file name |
| harness | 37 / 37 |
| global | 95 / 95 |
| distribution | 48 / 48 |

**Not verified.** LIVE PROVIDER (no real model call in any of the above);
the Telegram WebApp from a real Telegram client; Tailscale/ZeroTier routes
on a real tailnet; the router investigation itself, which runs in the user's
LAIN session.

## Real-terminal repair: composer ghosts, Diff as transcript, `/model` source state (2026-09-20)

**Composer corruption after paste + delete** — reproduced in a real
pseudo-console (tests/tty, pywinpty + pyte). Every stale cell sat LEFT of the
content frame. Causes and owners:
1. `src/pastebuffer.js` normalised only `\r\n`; Windows Terminal separates
   pasted lines with a lone `\r`, which the composer wrote verbatim — the cursor
   returned to column 1 mid-row. Fixed at the owner (`lf`, also used by
   `Input.insertText`); with `\n` the same paste had drawn cleanly.
2. Ctrl+Backspace (how the person deletes) removed ONE WORD of a collapsed
   `<pasted text>` block, the buffer no longer matched the payload, and the whole
   raw 3 KB paste unfolded into the composer (`[268/268]` in the screenshot). The
   word-deleting keys (Ctrl+Backspace, Ctrl+W, Alt+Backspace, Ctrl+Delete) now
   take a collapsed paste as one word (`lineedit.deletePaste`), one undo step.
   PLAIN Backspace/Delete still trim the payload a character at a time — the
   `pasteflow` contract that the buffer holds the text, not a marker.
3. CJK measured in code units: the grey fill overran the right edge and
   autowrapped into the next row's gutter (`viewport.unitsIn`, cell-measured
   fill and caret in `inputbox.js`).
And the property that kept all three on screen: frame rows erased only to their
right. Every frame row now erases its whole line after positioning, and no C0
control byte reaches the terminal as a control (`src/ui/frameout.js`).
Evidence: UNIT `composerrepaint.test.js` (13); REAL_TTY_VERIFIED
`realtty.test.js` C (CR paste + one Ctrl+Backspace, CJK paste + delete — no
ground or text in the gutter, placeholder back). Remaining observation: holding
Backspace through ~900 characters of an UNFOLDED paste takes ~2–3 s to drain
(one full redraw per keystroke); nothing is left behind.

**Diff as transcript** (`ui/turnsections.js`, `ui/difftoggle.js`). A change
row carries its real hunks without a click — live, through VERIFY, after DONE —
bounded at 16 lines with `… N more lines [Show all]`; the row control collapses
and reopens. Only the three most recently edited files show their diff unasked
— a thirty-file turn still folds to `✓ edited ×N`, and each older row's control
opens it. A receding (finished-run) change row goes faint except its counts. The newest edit's diff opens as grey space and its rows arrive over
~0.6 s as a pure function of time since it landed (renderer only; a
non-enumerable `landedAt`, never saved); edits no longer open the separate,
self-closing reel window (reads keep theirs). `+N` green, `-N` red — the row
painter's count pattern had required the counts to END the row, so after
`[Diff]` was appended it never matched. The activity box is a grey rectangle
while THINKING and one line whenever an action or a diff is primary. Evidence:
UNIT `difftranscript.test.js` (11), `difflifetime.test.js`,
`clipresentation.test.js`; REAL_TTY observed: THINKING rectangle, minimized
`EXECUTING · …` line, diff present mid-turn, during a 3.5 s test run, and after
DONE in CHANGE.

**`/model` warnings.** `lain:custom` is TokenFaucet
(`https://freetokenfaucet.com/v1`) with a key the service rejects (401
"Invalid TokenFaucet API key.") — a real, stale credential; the connection and
the key are untouched, the source is now AUTH_REQUIRED. `lain:api.b.ai` had
its base URL entered as the full endpoint (`…/v1/chat/completions`): discovery
asked `…/chat/completions/models` (405 "Use POST") and chat would have posted to
`…/chat/completions/chat/completions`. A trailing endpoint segment is now read
as the API root (`connections.apiRoot`; config not rewritten) — this source now
WORKS. Discovery failures are STATE (`src/catalogstate.js`): 401/403
AUTH_REQUIRED, 404/405/501 CATALOG_UNAVAILABLE, 429 RATE_LIMITED, else
UNREACHABLE; persisted per base-URL+credential fingerprint, so a known-bad
source is not re-asked each launch (a new key or URL is asked at once; `/model
refresh` always asks and shows the raw response). One line on a change —
`MODEL SOURCE · lain:custom · auth required` — and the picker title names
broken sources. Evidence: UNIT `catalogstate.test.js` (8, against a real local
HTTP server counting requests); REAL_TTY observed: two `/model` opens, two
catalog requests total, one concise line, no JSON.

**Recorded, not changed (§34):** ECO did not reduce per-request context — every
provider request still carried ~26–29k tokens. Future optimization; no context
code was touched by this pass.

## P0 — a correction repeated verbatim on every step read back as a re-entry loop (2026-09-18)

**Symptom, as reported.** One focused correction — "Fix two router bugs:
1. cross-provider rate-limit bleed 2. slow refresh-all. Do not touch LAIN."
— produced repeated mid-task restatement several steps into useful,
progressing work: "The steer is...", "Back on the two router bugs...",
between ordinary reads, as though the model kept being re-handed the
assignment from scratch.

**Root cause, proven by trace, not inferred.** `jobrunner.js`'s
`turnOptions()` computes two tails once, before a turn's first step:
`live` (`opened:false`, step 0) and `liveContinuing` (`opened:true`, every
step after). `turn.js` selects between them by `step > 0` alone. Both are
built by `prompt.workingContext()`, which had an `opened` gate on exactly
TWO of its seven sections (a cut-off previous turn, a blocked state) — the
STEERS section (`task.steers[]`, rendered as "The user has since said
(these override the original request): ...") had none, so it rode
byte-identical on `liveContinuing` for every single continuation step of a
turn, however many there were. The block was authority-correct (framed by
contextprovenance.js, never impersonating the user) and small (already
capped) — and still amplified into compulsive re-acknowledgment, because an
announcement resent unchanged at the tail of context on every step reads as
news every time. A genuinely live, mid-turn correction is unaffected — it
travels through `app.js`'s separate, consume-once `steer()` callback, never
through this recap.

**Ruled out, with evidence, not assumption:** `plan_step` (never touched;
the defect is upstream of anything step-shaped), a hidden wakeup (grepped:
none exists in this codebase yet), compaction (has its own, separate,
already-tested carry-forward of what the user said verbatim — this recap is
redundant insurance for cross-TURN continuity, not compaction safety), and
CLI-side replay (the reproduction captures the actual wire `messages` array
handed to the provider, below any rendering layer — the repeated content
was real input, not a redraw).

**Fix.** `workingContext()` now returns `''` entirely when `opened` is
true — one gate, at the top of the function, rather than per-section —
matching the two sections that already had this right.

**Evidence.** `tests/unit/reentrytrace.test.js` drives the real `runTurn`
loop through `mockprovider.js` (the same double the LIVE CLI VERIFIED gate
uses) across four scripted steps with a real `task.steers` entry, and
inspects the actual wire content sent at each step: the correction appears
in exactly one of four calls, and — confirmed by temporarily reverting the
fix and re-running the same test — it appeared in 4 of 4 before this fix.
`tests/unit/workingcontext.test.js` updated: the test that asserted the OLD
behavior as intentional ("rides on every request of the turn") now asserts
the corrected one, with the old assertion's reasoning recorded rather than
deleted.

## Runtime authority, diagnostic routing, verification evidence, and LAIN for Chrome (2026-09-18)

A single pass closing a P0: generated runtime context (mode guidance, handoff
text) was being sent as a bare `role:'user'` wire message, which the provider
layer could leave unmerged with the real request — the model then read LAIN's
OWN prose ("Answer the user. This does not need the project inspected...") as
a newer, more authoritative instruction than what the person actually typed.
Alongside it: a stale task/plan surviving an explicit cancellation, a
diagnostic task being forced through project-implementation grounding, an
unenforced clarification budget, and a stale-handoff verification line
(`where lua ... & echo DONE — passed`) that read a masked exit code as proof
of an unrelated check.

| Area | Implementation | Evidence |
|---|---|---|
| Generated context never impersonates the user | `src/contextprovenance.js` (`<lain-context>` framing + teaching text) wired through `contextfit.buildWire` | UNIT `contextprovenance.test.js`, `tokenarchitecture.test.js` |
| Stale task/plan cannot survive an explicit cancellation | `task.js` `CANCEL_RE`/`stripCancelClause`; `identify.js` supersedes + clears the plan | UNIT `taskcancel.test.js` (incl. a save/resume round trip proving A cannot reappear) |
| Task-class routing (project implementation / project diagnostic / live external diagnostic / direct tool / conversational) | `src/taskclass.js`; `prompt.js` `CLASS_GUIDANCE`; `src/provenance.js` `statusLine` | UNIT `taskclass.test.js` |
| Clarification budget restated everywhere a turn can start, not just the one refusing tool result | `clarify.js` `Clarifications.directive()`, wired into `prompt.js` on both the ordinary and handover paths | UNIT `clarifybudget.test.js` |
| Verification evidence kinds — a masked compound command is never promoted to a pass | `src/evidencekind.js` (COMMAND_EXECUTED / COMMAND_EXIT_STATUS / SEARCH_MATCH_FOUND / SEARCH_NO_MATCH / INCONCLUSIVE); wired into `lifecycle.js` `observeTool`/`complete`/`contradiction`, `handover.js`, `prompt.js`, `briefing.js`, `continuity.js`, `progress.js`, `survey.js`, `dash.js` | UNIT `evidencekind.test.js` (reproduces the exact `where lua ... & echo DONE` regression end to end through `Lifecycle`) |
| An explicit read request is never satisfied by project intelligence alone; a write always invalidates the evidence ledger before the verify read | pre-existing `evidence.js` design confirmed correct; regression added | UNIT `directread.test.js` |
| Runtime provenance, for inspection (never the model's chain of thought) | `src/provenance.js`, `/provenance` (`provenancecommand.js`) | UNIT `provenance.test.js` |
| Computer MCP batch: `"there is no action \"\""` | root cause: `tools/computermcp.js`'s `batch` case passed model-shaped steps (`op`) straight to `ComputerMCP.batch()`, which reads `spec.action` — only the single-action path translated `op`→`action`. Now batch does the same translation and rejects malformed/empty/nested-batch steps before any of them reach the bridge | UNIT `computermcpbatch.test.js` (incl. a drift guard that `PERFORM_ACTIONS` matches `_perform`'s real switch labels) |
| Computer MCP foreground-verification race ("MCP reports a mismatch but input still lands correctly") | reviewed — `act()`/`observe()` already separate INPUT_DELIVERED from a polled FOREGROUND_POSTCONDITION_VERIFIED check; no code path was found that conflates them | **NOT VERIFIED** — reproducing the reported race needs a live Windows desktop and the compiled bridge; not reproducible from this shell |
| Windows Terminal capability classification | reviewed — no code hardcodes a blanket per-application verdict; every observation/action already reports its own PASSED/FAILED/INCONCLUSIVE independently | **NOT VERIFIED** against a real Windows Terminal window — no live desktop in this session |
| LAIN for Chrome — a companion extension for the user's REAL Chrome, never the native Harness UI, Frontend Workshop or WebModel's browsing profile | `src/lainchrome.js` (local, token-authenticated, origin-pinned HTTP long-poll bridge — no `ws` dependency, LAIN has zero npm runtime deps), `src/tools/chrometab.js` (`chrome_tab`, transport-gated like `computer`), `src/chromecommand.js` (`/chrome`), `extension/` (MV3 manifest, background service worker, content script, popup), Settings → Connections → `connections.chrome` (`src/harnessapp/chromeroutes.js`) | UNIT `lainchrome.test.js` (token/origin enforcement, fail-closed disconnect, request/poll/result round trip, transport gating, untrusted-content labelling, semantic-targeting-only schema) — **NOT REAL-CHROME VERIFIED**: the extension has not been loaded into an actual Chrome instance in this session |

Full gate totals for this pass: `unit` 2984/2984, `integration` 212/212,
`smoke` 565/566 (all re-run clean against the tree this section describes).
No REAL-DESKTOP Computer MCP acceptance and no REAL-CHROME extension
acceptance were performed — both need a live, human-observable desktop
session this shell does not have.

The one smoke failure — `smoke/workshop-real.test.js` ("select on the
preview, ask, patch, hot reload, three viewports, before/after"), timing out
waiting for a Frontend Workshop preview screenshot to load — is unrelated to
this pass (Frontend Workshop hot-reload/screenshot capture; no file this
section touches is on its require path) and reproduces in isolation on this
tree independent of anything here. Left unfixed as out of scope; flagged
rather than silently left out of the total. **Fixed 2026-09-18** (CLI
stabilization pass, below): a poll race in `pageworkshop.js toggle()`, not
screenshot capture, and a fixed-pause viewport reload in `workshop/viewport.js`.

## LAIN Desktop — a real WebView2 singleton-race dialog, diagnosed live (2026-09-18)

Reported mid-pass: "LAIN Desktop could not open a second window with
different settings... 0x8007139F" — the exact `ERROR_INVALID_STATE` path in
`native/host.cs` (see below), triggered live rather than in a test.

At the time of the report, no `LAIN.exe` or LAIN-owned WebView2 process was
running on the machine (checked directly), so the report was of a transient
state, not a stuck one. The design that should prevent it (`src/corelock.js`
— a second `lain --desktop` launch probes a deterministic named pipe rather
than trusting a lock file, and asks the running instance to show its own
window) is structurally sound. The gap: `src/desktoprun.js` announced that
lock (bound the pipe, wrote `core.json`) only AFTER `await app.prepare()`,
leaving the lock's absence — and therefore the window for a second
near-simultaneous launch to also decide it is first — open for however long
`prepare()` took. Fixed by announcing before `prepare()` runs; this narrows
the race rather than closing it outright (two launches close enough together
can still both reach `announce()` before either binds), which is stated
plainly rather than claimed as a full fix. Regression:
`tests/unit/coresurfaces.test.js` pins `new App() -> lock.announce() ->
app.prepare()` at the source level.

Five `lain-supervisor.exe` processes were also found running and initially
misattributed to LAIN Desktop lifecycle leakage; on inspection their
`--home` arguments pointed at this session's own test-fixture temp
directories (`AppData\Local\Temp\frames-*`, `trail-*`) — they belonged to
this session's own background `integration`/`smoke` runs, not to any
uncleaned LAIN Desktop launch. Noted here so the correction is on the
record, not just in conversation.

## Harness functional contracts (2026-09-16)

The frontend contract is `docs/HARNESS_UI_CONTRACT.md` (authoritative for the
visual layer). The client is `LAIN.contract` (`src/harnessapp/pagecontract.js`).

| Area | Implementation | Evidence |
|---|---|---|
| Session status — 8 words, one authority | `src/sessionstatus.js`; `sessionpool.statusOf` delegates | UNIT `sessionviews.test.js` · INTEGRATION `chatcoding.test.js` BACKGROUND · REAL-DESKTOP `harness-contract-real.test.js` |
| Live background status to the rail | `session.status` over the pipe (`ipc.emit`) from every phase, turn start/end, question | INTEGRATION (event for a session not viewed) · REAL-DESKTOP (received in the renderer) |
| Chat / Coding views, two threads, one project | `src/sessionviews.js`; `contextfit.buildWire` carries one thread | UNIT · INTEGRATION (Coding request carries no Chat message, measured at the provider) |
| Chat is non-mutating | `tools/index.execute` → `CHAT_VIEW_READ_ONLY`; EXPLAIN mode | UNIT · INTEGRATION (a real Chat turn's `write_file` refused, file absent) |
| Independent Chat / Coding models | `sessionviews.turnCfg`, `src/modelinventory.js` | UNIT · INTEGRATION (two different models recorded at the provider) |
| Model search | `POST /api/models/search` (modelsearch ranking; never opens a browser) | UNIT |
| Plan states + Chat → Coding handoff | `src/planhandoff.js`, `api/plan/*` | UNIT · INTEGRATION · REAL-DESKTOP (accept → persisted → prefilled → submitted) |
| Project Files = attached project; pins | `sessionviews.project/pin`, `api/project/*`, `api/files/*` guards | UNIT · REAL-DESKTOP (tree root = project) |
| Workspace panel state | `session.views.panel`, `POST /api/workspace/panel` | UNIT (persisted across resume) · REAL-DESKTOP (open → close) |
| Dev server first-class, project-root cwd | `workshop/devserver.js`, `workshop/devstate.js`, `api/devserver/*` | INTEGRATION `devserver.test.js` (real processes: cwd, IPv6 announce, no leak, 500) · REAL-DESKTOP |
| HTTP 500 diagnosis | structured `preview` evidence, no restart | measured on toradb's Vite (below) + INTEGRATION + REAL-DESKTOP |
| Telegram connection from the window | `src/botconnect.js`, `api/bot/*`, `bot/store.candidate` | INTEGRATION `bot-harness.test.js` (real Rust supervisor, fixture Telegram API) · UNIT `botconnect.test.js` |
| Discord / WhatsApp exposure | projected with environment requirements | UNIT (surface) — setup remains environment variables |
| Settings schema | `src/settings.js`, `api/settings*`; notify honours preferences | UNIT · REAL-DESKTOP (schema + update) |

### The Workshop 500 — reproduced, not assumed (toradb, Vite 6.4.3, Node 24)

Measured by driving `devserver.ensure` through the real ProcessManager in
`C:\Users\Hartezmenot\Documents\toradb` (`npm run dev` = `concurrently` of an
Express API on `PORT=4100` and Vite with `server.port: 5180` and an `/api` proxy):

1. **LAIN forced `PORT=5300`; Vite ignores PORT.** It printed
   `Local: http://localhost:5183/` (5180–5182 were taken) while LAIN waited on
   :5300 and reported "did not open :5300".
2. **Vite bound `::1` only.** `127.0.0.1:5180` refused; `localhost:5180` answered
   200. Every IPv4 probe of a healthy server failed.
3. **The failed start leaked.** Three Vite servers from earlier attempts
   (started 12:41, 13:42, 13:46) were still listening; the later two had no API
   because `:4100` was held by the first (`EADDRINUSE` in the log). **Left
   running on this machine — PIDs 22708 (:5180), 26996 (:5181), 15172 (:5182),
   23764 (:4100); not killed by this pass.**
4. **The 500 itself:** Vite answers **HTTP 500** for `/api/*` when its proxy
   target is not listening (`[vite] http proxy error … ECONNREFUSED`) —
   reproduced with the same Vite against a dead target. npm was not at fault.
5. **Found on the way:** a cwd given as an 8.3 short path (`HARTEZ~1`) makes
   Vite's watcher abort (`Assertion failed … win\fs-event.c`).

All five are fixed or surfaced: declared ports from the Vite config, announced
URLs from LAIN-started processes, both loopbacks probed, a failed start stops
its process, the canonical long path is the cwd, and a 500 comes back as
structured evidence with the server's recent output.

### Gates (2026-09-16, this machine)

| Tier | Result |
|---|---|
| unit | 2905 passed, 0 failed |
| integration | 212 passed, 0 failed |
| distribution | 48 passed, 0 failed (after moving start-at-login out of `distribution/` — the installer boundary guard caught it) |
| smoke | 565 passed, **1 failed**: `harnessapp-real` "420x700 @2x bleeds 6px past the window" — layout CSS in `page.js`, which the visual redesign is rewriting in parallel; no DOM was added by this pass |

### Limits, stated

- **The visual layer is being rebuilt in parallel.** The real-desktop smoke
  drives the contract from inside the real renderer over the real pipe and
  asserts DOM landmarks only (the shell and both lanes).
- **One writer per session.** Chat cannot be used while Coding is running in
  the same session (refused with `busy`), and vice versa.
- **Telegram candidates carry an ID, not a username** — the supervisor's
  normalized event has no username field; adding one is a Rust change.
- **Discord / WhatsApp have no token entry** — their secrets are environment
  variables and there is no credential store to put one in.
- **"Start at login" needs `LAIN.exe` installed**; until then it is reported
  unsupported with the reason.

## Where LAIN stands (2026-09-15)

**Two surfaces, one Core.** LAIN CLI and LAIN Desktop are peer clients of the
same session authority. Neither summons the other: the Desktop is launched
(`LAIN.exe`, a shortcut, or `lain --desktop`), the CLI is run, and whichever
starts first is the one the other finds (`src/corelock.js`).

### Implemented and verified in this pass

| Area | State |
|---|---|
| Native Desktop as the only Harness | REAL-DESKTOP VERIFIED — `tests/smoke/desktop-real.test.js`, 12 cases |
| Launched without a CLI (double-click) | REAL-DESKTOP VERIFIED — the launcher case drives `LAIN.exe` for real |
| Node resolution on Windows | UNIT-VERIFIED — `tests/unit/noderesolve.test.js`, 8 cases incl. `C:\Program Files\nodejs\node.exe` |
| Session pool: navigation ≠ execution | UNIT + REAL-DESKTOP VERIFIED — `sessionlifecycle`, `coresurfaces`, `desktop-real` |
| Tray lifecycle: X hides, Quit ends | REAL-DESKTOP VERIFIED — the real X pressed through UI Automation |
| Browser Harness removed | REMOVED — `server.js`, `localauth.js`, `harnessapp/desktop.js` deleted; guard in `tests/unit/harnessapp.test.js` |
| Four-picture judgment flow removed | REMOVED — `visual.js`, `visualwindow.js`, `tools/visual.js` deleted |
| OmniRoute / the duplicate `custom` row | REMOVED — one `Customs…` category; provider identities untouched |
| TypeScript `interface` / `type` / `enum` indexed | UNIT-VERIFIED — zero false positives across LAIN's own 754 files |
| Coverage cannot collapse silently (§19) | UNIT-VERIFIED — scanned-but-nothing-declared is PARTIAL, never FRESH |
| Step-local durable findings (§22) | IMPLEMENTED + UNIT-VERIFIED — `src/planfindings.js`, tool `plan_findings` |
| Bounded exact-idiom policy (§23) | IMPLEMENTED — stated in the prompt, asserted in `planfindings.test.js` |
| Non-progress survives a resume (§20/§21) | UNIT-VERIFIED — the Step-740 replay, and read receipts across a session boundary |
| Guardrails tested from both sides (§25) | UNIT-VERIFIED — `tests/unit/guardscope.test.js` |
| Ctrl+C on a turn with no record | FIXED — pre-existing null dereference, see below |
| Interactive project terminal (real ConPTY) | REAL-DESKTOP VERIFIED — `tests/smoke/terminal-real.test.js` |
| Plan findings derived from Core, not only the model | UNIT-VERIFIED — LANDED from mutation receipts |
| No application-added delay | UNIT-VERIFIED + measured: Core→window 85 ms, was up to 1500 ms |
| Cowork EPERM | FIXED — it was LAIN's test teardown, not Astra's runtime |

### A latent defect on the Ctrl+C path, found while consolidating

`submitclose.after` — the close of a submission — asked the turn record four
questions. A turn cancelled with Ctrl+C never yields `done`, so it arrives with
`record === null`, and the first question threw.

**Pre-existing, and it is worth being exact about that:** `app.js` read
`record.text` and `record.stopReason` unguarded in the same order before this
code was extracted (the same lines are in `git HEAD`). Moving it did not create
the bug; it made it visible, because the extracted function could be called
directly with a null record.

It is fixed where it now lives: a cancelled turn closes quietly. **The steer
queue is still drained** — a sentence typed while the turn was working is the
user's own text, and cancelling the work it was aimed at does not forfeit it.
Pinned by `tests/unit/planfindings.test.js`, "an interrupted turn has no record".

### Known environmental failures

| Failure | Assessment |
|---|---|
| ~~`integration/cowork-remote.test.js` EPERM~~ | **RESOLVED 2026-09-15.** It was not environmental: LAIN's own teardown omitted `harness/processes.cleanupOwned()`. The full tier is now 202/0. |
| ~~`computermcp-real` — "a native Open picker"~~ | **FIXED 2026-09-18.** On Windows build 26200 the Open dialog's IDOK button reports UIA ControlType.Pane with no patterns; the bridge now accepts class `Button` + type `Pane` for a `Button` request. |
| `computermcp-real` — "a browser file picker" self-skips | The installed browser raises no native picker for a scripted click. The test says so and proves the boundary in the direction that still holds. |

### Known limitations, stated rather than implied

- **Windows only.** The native host is Windows; macOS and Linux have no host.
  Nothing in Core knows that — the seam is a pipe carrying `{method, path, body}`.
- **`LAIN.exe` shows no console; a shortcut to `lain.cmd` would.** Measured:
  the launcher is a `winexe` and starts Core with `CreateNoWindow`, and no
  process in the launched tree has a visible window. A shortcut pointed at
  npm's generated `lain.cmd` instead is a console program and would show one —
  which is why the launcher exists and is what a shortcut should point at.
- **Ctrl+C in the Terminal drawer does not interrupt a running command.** The
  shell, the console, resize, input, output and clean exit all work. The control
  event IS raised successfully — `AttachConsole` and `GenerateConsoleCtrlEvent`
  both return true — and PowerShell does not act on it. Four process
  arrangements measured; see "Ctrl+C in the terminal drawer — the boundary,
  measured (2026-09-16)" below for the table. A PLATFORM BOUNDARY, not a bug
  LAIN can fix from here. The drawer offers **End shell**, and pressing Ctrl+C
  says so.
- **The drawer is not a terminal emulator**, and since 2026-09-16 it is no
  longer a stripper either. Carriage return OVERWRITES, backspace deletes,
  erase-in-line and erase-in-display clear, and SGR colour is drawn. No cursor
  addressing, no scroll regions, no alternate screen — and a sequence it does
  not implement leaves no trace rather than printing as mojibake.
- **`plan_findings` is PART model-written and part derived.** SETTLED and
  REMAINING are the model's judgments and nothing infers them. LANDED is
  derived by Core from its own mutation receipts (`planfindings.derive`), so a
  step that patched three files carries that fact whether or not the model
  wrote it down — and a REVERTED change is never reported as landed. EVIDENCE
  comes from read receipts. Wired onto the prompt path 2026-09-16; before that
  the derivation existed and never reached the model.

---

## The Terminal drawer is a real pseudoconsole (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED** (`tests/smoke/terminal-real.test.js`).

`native/pty.cs` — a ConPTY bridge compiled on demand by the `csc.exe` that is
part of Windows, cached by the hash of its own source, exactly as the Computer
MCP bridge is. **LAIN still has zero runtime dependencies.** Core owns the
shell; the window sends keystrokes and draws bytes.

**What makes it a terminal and not a command runner**, and it is what the test
asserts: the shell believes it has a CONSOLE. It reports its width (100), and
after the panel is resized it reports the new one (64). A program that detects
a pipe turns off colour, progress and prompts — so "it printed something" was
never the property worth checking.

**Three defects found getting there**, each measured rather than reasoned about:

1. **The pseudoconsole attribute was being ignored.** `CreatePseudoConsole`
   returned S_OK, the attribute list was well-formed, `UpdateProcThreadAttribute`
   and `CreateProcessW` both succeeded with `GetLastError` 0 — and the shell's
   banner came back on the BRIDGE's own stdout while the pty emitted only its
   handshake. Reproduced in a minimal standalone program built the same way, so
   it was the platform contract rather than the wiring. The child is now handed
   the pseudoconsole's own ends as its std handles (`STARTF_USESTDHANDLES`) with
   inheritable pipes; the attribute stays, because it is what gives the shell a
   console at all.
2. **Then the shell and ConPTY raced for every keystroke** — a prompt appeared
   and no command ever ran, because both were reading the same pipe end. The
   shell now has a stdin of its own.
3. **Ctrl+C is the one gap, and it is the platform's.** The console control
   event is raised successfully and PowerShell ignores it; giving the shell
   `CONIN$` so it is genuinely interactive did not change that, nor did aiming
   `CTRL_BREAK` at its own process group. Measured four ways on 2026-09-16 —
   the table is in "Ctrl+C in the terminal drawer — the boundary, measured"
   below. The drawer offers an explicit **End shell**, the button admits its
   limit, and the terminal is otherwise complete.

**It is not a second execution path around the tool gate.** A person types into
a shell in a project they already opened — the authority they have in any
terminal on their own machine. No tool writes to it; `run_bash`, which the model
uses, still goes through `gate.js`, `trust.js` and the mutation transaction.
Ending LAIN ends every shell (`src/teardown.js`), asserted in the same suite.

**It is not a terminal emulator**, and says so rather than pretending: control
sequences are stripped to what a block of text can show. A wrong emulator would
draw a build log that is subtly not what the build said.

## Plan findings are no longer the model's alone (2026-09-15)

Evidence tier: **UNIT-VERIFIED** (`tests/unit/planfindings.test.js`).

The limitation was that `plan_findings` was model-written, so a model that
forgot to call it lost the record — including the part nobody should have to be
told: what actually changed on disk.

`planfindings.derive` now reads what Core already knows:

| Field | Owner |
|---|---|
| `LANDED` | **derived** from the mutation receipts — transactions marked `KEEP`, for this step |
| `EVIDENCE` | **derived** from the read-receipt ledger, as pointers |
| `SETTLED` | the model's. Nothing in a receipt can say *"tracked stall means cancel"* |
| `REMAINING` | the model's, for the same reason |

A reverted transaction is not reported as landed — silence is better than telling
the model work exists that does not. Another step's work is not this step's. And
deriving MERGES: what the model wrote survives.

## Nothing waits on purpose (2026-09-15)

Evidence tier: **UNIT-VERIFIED** (`tests/unit/nodelay.test.js`) and measured on
the real window.

The CLI's paced timeline was already off (`instant: true`). The delay that
remained was in the native Harness and was not a sleep: **the window polled
`/api/state` every 1500 ms**, so an answer that existed at T appeared at up to
T + 1.5 s and the application looked slower than the work it was reporting.

Core now says "look now" the moment authoritative state moves — from
`notePhase` (before every provider call and every tool), from every turn event,
and from every write route. **Measured on the real window: 85 ms**, against up
to 1500 ms before.

The wake carries NO STATE: the window still reads `/api/state`, so there is one
read model and nothing to drift. It is not debounced or batched — a timer added
to smooth wakes out would be the delay this removes. The poll stays as the
fallback it always should have been.

## The Cowork EPERM was ours, and it is fixed (2026-09-15)

Evidence tier: **INTEGRATION-VERIFIED** — the full tier now runs **202 passed,
0 failed**.

It was labelled environmental for two passes. It was not.

EPERM on the DIRECTORY itself (rather than on a file inside it) is the Windows
signature of a live process holding it as a working directory. The owner was an
omission in LAIN's own test teardown: the failing case called
`supervisor.cleanupOwned()` and **not** `harness/processes.cleanupOwned()`,
which **both** of its sibling cases in the same file do — so a harness-owned
child rooted in the temp directory could still be alive when the removal ran. A
fixed 200 ms sleep stood in for it, which is why it only ever failed under load.

**Astra's Cowork runtime is untouched.** What changed is that this teardown now
ends what LAIN started, the way its neighbours already did, and waits on the
directory actually going rather than on a clock.

## Session lifecycle — a running turn stopped freezing the application (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED** (`tests/smoke/desktop-real.test.js`, 11
cases — including the real X being pressed on a real window through UI
Automation), plus UNIT-VERIFIED (`tests/unit/sessionlifecycle.test.js` 11 cases,
`tests/unit/coresurfaces.test.js` 6 cases).

**The regression, found by using it.** With a turn running in one session,
switching to another session, creating one, or adding a Cowork/Bot session was
refused:

    a turn is running — stop it or let it finish first

**The cause, precisely.** `src/harnessapp/sessionroutes.js` asked
`app.abort && !app.abort.signal.aborted`. That is a fact about the PROCESS, and
it was being used to answer a question about a SESSION. One variable was doing
two jobs — "is LAIN busy" and "is this conversation busy" — so *looking at*
session B was governed by *work in* session A. The Cowork lane shared the same
check, which is what proved the guard was global rather than lane-specific.

**The fix is an ownership change, not a suppressed warning.**
`src/sessionpool.js` holds one `App` per LIVE conversation — which is exactly
what `App` always claimed to be ("two Apps in one process cannot see each other's
session"), a property designed for and never used. A surface then holds a VIEW
(`pool.viewId`); execution belongs to a session (`pool.running(id)`).

| Concern | Where it now lives |
|---|---|
| which session a surface shows | `pool.viewId`, moved by `POST /api/session/select` |
| whether a session is executing | `pool.running(id)` — its own `App`'s `abort` |
| a second turn in the SAME session | the steer contract, as in the terminal |
| two sessions writing one project | the existing task / work-order / mutation authority |

A sibling `App` shares what is true of the PROCESS (the config object,
`availability`, connection evidence) and nothing that belongs to a conversation
(session, checkpoints, `abort`, jobs, events, project caches). It has no
terminal: it renders to a sink and its UI is never enabled, so it cannot fight
the CLI for the screen.

**`POST /api/turn` into a working session is now a STEER**, not a 409 — the
contract the terminal has always had (`WAIT` by default, `NOW` on request),
rather than a second one for the window.

**Two defects the real window found, which reading would not have.**

1. `desktopwindow.open` on a HIDDEN window reported `already: true` and did
   nothing. Once X hides to the tray, "the host is running" stopped implying
   "the window is on screen" — so every way of asking for LAIN back succeeded
   and left it hidden. Raising a window belongs to the process that owns it, so
   Core now asks: `ipc.toHost('show')` → `native/host.cs FromCore`.
2. A live session that had never been written to disk was missing from its own
   rail, because the rail is built from the sessions directory. Creating a
   session looked like it did nothing until the first turn landed.

**Three more found by reading the diff, not by a failure** — recorded because
finding them late is the interesting part:

1. `teardown.shutdown` is reached through a ROUTE, and a route acts on the
   session the window is VIEWING — which may be a sibling. The gateway, shell
   jobs, harness services and computer bridge all hang off the PRIMARY `App`, so
   a Quit through a sibling would have swept almost nothing and reported success.
   It now resolves to the primary and sweeps every live session.
2. `pool.open` keyed the view on the id it was ASKED for, but `Session.resume`
   accepts a short token (`ayze`) and returns the full session. The view would
   have pointed at a name nothing was registered under, `live()` would miss, and
   the window would silently fall back to the terminal's session — showing a
   different conversation than the one clicked.
3. Killing the host left its tray icon in the notification area until somebody
   hovered over it: a ghost LAIN for something that no longer exists. Core now
   asks the host to exit first (a bounded 1.5s grace) so `OnClosing` runs and
   disposes the icon, then kills the tree regardless. "Closed" still means the
   process is gone.

## LAIN Desktop is launchable on its own (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED** (the §32 drive below, step A: a window
opened with no CLI involved, and a second launch finding the first).

`lain --desktop` (`src/desktoprun.js`) starts Core headless — same `App`, same
turn loop, same gates, no REPL and no stdin — announces itself, opens the window
and stays resident. No terminal has to remain open to keep LAIN alive.

**One LAIN per account.** `src/corelock.js` is a lock file plus a control pipe
named by a hash of the config directory. A second launch (or `lain` in a
terminal, which announces the same way) is DISCOVERED and asked to show its
window. Two LAINs would be two gateways polling one Telegram token, two
supervisors and two writers on one session directory.

**Why that pipe may be unauthenticated, stated plainly.** It carries three verbs
and no data — `show`, `status`, `quit`. It reads no conversation, starts no turn,
grants no permission, reveals no credential and names no session. A process
running as this user can already read `~/.lain`, every transcript in it and every
credential beside them, so those three verbs give it nothing it did not have.
The moment a verb would carry more, it belongs on the authenticated per-run
desktop channel instead — which is unchanged. Pinned by
`tests/unit/coresurfaces.test.js`, which fails if a fourth verb appears or if the
file ever reaches a route, a session or a credential.

**Known rough edge, not claimed as solved.** A Windows shortcut points at `lain --desktop`, and npm’s generated `lain.cmd` is a console program — so a plain shortcut flashes and keeps a console window. Nothing about LAIN needs it (Core is resident; the window is its own process), but hiding it needs a shortcut with a hidden window style or a `wscript` wrapper, and LAIN does not install one yet. A second `lain-desktop` executable was tried and reverted: §16 of the blueprint forbids a second CLI name, and the distribution guard caught it.

**One session store.** `/resume` and the Desktop rail both read
`src/sessionindex.js`. Same ids, same histories, same project roots; no Desktop
session database, and no frontend mirroring another frontend.

## X hides to the tray; Quit is a different gesture (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED** — the close was delivered to the real
window through UI Automation, the window left the desktop, the host process did
not, the pipe stayed connected and a turn in flight was not cancelled.

**Why it matters.** LAIN keeps doing things with no window open: a gateway holds
a connection, Cowork jobs run, a coding turn started ten minutes ago is still
working. If the window owned that lifetime, tidying your desktop would silently
disconnect your bot and cancel work in flight, with nothing on screen to say so.

    X            hide to tray; Core, bots and turns carry on
    Open LAIN    the same window back, where it was
    Quit LAIN    an explicit, confirmed end

**Quit asks Core rather than exiting the host.** `POST /api/desktop/quit` →
`src/teardown.js`, because the gateway, the agent jobs, the shell children, the
browsers and the dev servers all belong to Core and only its own sequence stops
all of them. `src/teardown.js` has three callers — `/exit`, the tray, and the
control pipe's `quit` — and is one sequence so none of them can forget an entry.
It now also sweeps **every live session**, not only the foreground one.

**Notifications are endings, never tool calls** (`src/notify.js`): a verdict the
verification reached, a turn that did not finish, or work waiting on the person.
The host drops any toast while the window is in front.

## The terminal moved inside the Harness (2026-09-15)

`src/harnessapp/terminalroutes.js`. A project becoming active spawns no console
window; the Terminal drawer is collapsed by default and shows the processes Core
already owns — background commands and harness services, read from `src/jobs.js`
and the ProcessManager, which is what `/ps` reads.

**It takes no command, and that is a decision.** A box that ran whatever was
typed into it would be a second execution path that does not pass through
`gate.js`, `trust.js`, `permissions.js` or the mutation transaction. Stopping is
offered, because ending something is the direction that is always safe.

**`Open CLI` is the explicit way to a real shell** — a terminal running
`lain --resume <this session>` in this project, outside the application. Core
hands the session over first (`pool.handover`) and refuses while a turn is
running in it, so there is never a second writer on one transcript. The Desktop
conversation IS the LAIN interface; embedding the CLI as the project terminal
would be a window containing a terminal containing LAIN showing the same
conversation.

**NOT BUILT, by decision:** a true interactive PTY inside the panel. The real-TTY
tier (ConPTY + pyte) is test infrastructure and is not wired into the product.

## A socket outlived its channel and disconnected the next one (2026-09-15)

Evidence tier: **UNIT-VERIFIED** (`tests/unit/desktopboundary.test.js`, "a
restarted channel is not confused by the sockets of the old one") and
**REAL-DESKTOP VERIFIED** (the `desktop-real` case that caught it).

**Found by the FULL smoke tier, and only by it.** `DESKTOP: Core restarting is
survivable` failed once with `0 !== 1` and passed in isolation every time.

**The cause.** Every socket handler in `src/harnessapp/ipc.js` read the
module-level `state` — whichever channel is current *when the event fires* —
rather than the channel the connection was accepted on:

    1. the old host is connected            channel A, clients 1
    2. stop() closes the server and drops `state`; the socket stays up,
       because closing a server does not close the connections it accepted
    3. start() installs channel B, clients 0
    4. the new host connects                channel B, clients 1
    5. the OLD socket finally closes        channel B, clients 0   ← wrong

Step 5 decremented a count belonging to a channel that socket had never spoken
to. The application then reads as DISCONNECTED with its window sitting there
connected — and which of 4/5 lands first is pure timing, which is why isolation
never showed it.

**Fixed three ways**, each narrowing a different edge:

- the connection captures its own channel (`const chan = state`) and the greet,
  the client count and the close handler all use it — a socket proves itself
  against the channel that accepted it, or against nothing;
- a request arriving on a channel that has been stopped is refused (409) and the
  socket dropped, rather than reaching routes through a dead channel;
- `stop()` destroys the sockets it accepted. Closing a server does not, and
  without it the host sits half-open against a channel nobody is reading,
  unable to tell "Core is restarting" from "Core is ignoring me" — its reconnect
  loop never starts.

**Proved non-vacuous**: with the pre-fix behaviour restored the probe reports
`B clients after OLD socket closed: 0`; with the fix, `1`.

**And the test that guards it had to be fixed twice**, which is worth recording
because both mistakes were mine and both were the kind that make a suite lie:

- the first version slept 400ms and then asserted. That says "it did not break
  within 400ms" — a weaker claim, and one that gets weaker under exactly the
  load that found the defect. It failed once in a full unit tier and could not
  be reproduced in 3 full runs or 11 isolated ones;
- the replacement waited on the old socket's `close` — which `stop()` has
  usually already delivered, so the wait never resolved and the tier HUNG. A
  hanging test is worse than a failing one: nothing is reported at all.

It now asserts it owns the channel it is measuring, waits only if the socket is
still open, and runs in 0.1s. Verified non-vacuous: with the pre-fix behaviour
restored it fails with the same `0 !== 1` the tier reported.


## A test that could lie about the boundary it protects (2026-09-15)

`tests/smoke/computermcp-real.test.js` — "a browser file picker is handled at
the OS boundary". Found by running the WHOLE smoke tier: it failed once, under
load, and passed alone every time.

**What it did.** When the browser raises no native picker for a scripted click
(which is legitimate and browser-dependent), the test falls back to proving the
boundary in the direction that still matters: the page did NOT receive a file by
itself. It asserted:

    assert.match((await el('#out')).text || '', /nothing chosen/,
      'no file arrived without one being chosen');

**Why that is wrong.** `|| ''` turns *"the page could not be read"* into the
empty string, which does not match, which reports **"no file arrived without one
being chosen"** — an alarming sentence about the exact property the test exists
to protect, produced by a browser that was merely slow under a full-tier run.

A test that converts its own failure to read into an accusation about the
product is worse than no test: the next person to see that line would go looking
for a security defect that is not there.

**Fixed** by checking the read before believing it. A page that cannot be read
proves nothing in either direction and now says so, rather than answering a
question it did not get to ask.

## The §32 acceptance drive — run end to end on this machine (2026-09-15)

A scripted drive against a real LAIN Desktop, not a reading. Every line below is
its output.

| Step | Result |
|---|---|
| A. launch directly, no CLI first | window open, private pipe connected, lock claimed |
| A'. re-run while the user's own `lain` CLI was running | it was DISCOVERED (pid, surface `cli`) and left alone — no second LAIN started, its lock never taken. Unplanned, and the strongest evidence for §28 there is: a real CLI session, not a fixture |
| C. long-running turn in session A | running |
| D. while A runs: switch to B, create C, create Bot session D | all accepted — no global-running-turn warning |
| E. return to A | still running; the rail says `RUNNING`; all four sessions listed |
| F. close with X | window left the desktop; tray process alive; Core connected; A's turn not cancelled |
| G. a Bot turn while hidden | accepted and answered |
| H. restore | host shown, window back on the desktop, same sessions |
| I. project terminal | answers inside the Harness; no console window spawned |
| J. close the panel | session untouched |
| K. Open CLI | opened on session B, which was handed over; refuses a session it does not hold |
| L. after the CLI closes | Desktop open, Core connected |
| M. Quit | shutdown clean, no host left behind, channel down, lock released, **0 `lain-desktop-*` processes on the machine** — and on the re-run, the pre-existing LAIN still holding its lock, untouched |


## LAIN Desktop — the Harness stops being a page in Chrome (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED** (`tests/smoke/desktop-real.test.js`, 11
cases — a real compiled host, a real window on this machine, the real WebView2
renderer, the real private pipe, and a real turn sent from the window).

**What changed.** `/app` used to mint a launch token, start a loopback HTTP
listener and open the person's Chromium at a localhost URL. The browser was the
application: its window, its lifecycle, its address bar, its idea of whether
LAIN was still open. Now `/app` opens a native window LAIN owns
(`native/host.cs` → `src/desktop.js` → `src/desktopwindow.js`) which reaches
Core over a **private named pipe** (`src/harnessapp/ipc.js`).

**One route table.** Every desktop request goes through
`routes.dispatch(app, method, path, body)` — the same call `server.js` makes,
against the same `App`. There is no desktop copy of a session, a turn loop, a
permission, a trust decision or a model route. Pinned by
`tests/unit/desktopboundary.test.js`, which fails if the host grows a route
table, a class named after a Core authority, or a debugging port outside dev.

**Authentication is the launch relationship, not a password.** LAIN spawns the
host and hands it the pipe name and a 32-byte secret on the command line; the
first message must prove it, compared in constant time. A client that does not
is refused — verified in the suite by connecting with a wrong secret. Being
local is still not being authorised: `gate.js`, `trust.js` and `permissions.js`
decide exactly as they do for a browser client.

**The browser surface is kept.** `/app browser` still starts the loopback HTTP
server with its launch token and signed session, for remote access, the API,
the gateways and the test tiers. What changed is the default, not the capability.

**Browser roles are untouched.** VERIFY, WEBMODEL and WORKSHOP keep their own
profiles and lifetimes. LAIN Desktop is not a fourth browser role.

| Requirement | State |
|---|---|
| native window, no external Chrome for the Harness | REAL-DESKTOP VERIFIED — the window belongs to our own host process, and no browser window is opened under it |
| no password, no login page, no localhost URL as the product | REAL-DESKTOP VERIFIED — no password field, nothing posts a login, the browser gate is disabled in the host |
| private IPC, not an authenticated port | REAL-DESKTOP VERIFIED — a named pipe; a wrong secret is refused |
| both lanes, sessions, Computer card, Workshop | REAL-DESKTOP VERIFIED (screenshot) + REAL-UI VERIFIED for behaviour |
| a turn from the window, and the next prompt after DONE | REAL-DESKTOP VERIFIED — driven through the real renderer, answered by the real turn loop, landing in this process's session |
| close is close; no orphaned host | REAL-DESKTOP VERIFIED — `close()` is awaitable and waits for the process to exit (it previously reported success while the window was still up) |
| Core restart survivable | REAL-DESKTOP VERIFIED — the window and its process survive Core going away; a reopened window attaches to the new Core |
| window position/size/maximised across restarts, off-screen correction | IMPLEMENTED — restored defensively against a detached monitor; not separately measured |
| drag-and-drop → artifact | IMPLEMENTED / UNIT VERIFIED — `POST /api/desktop/drop` stages through `cowork/attachments`; only the base name is ever reported, never the absolute path |
| packaged assets, no dev server in release | IMPLEMENTED — the UI is written beside the host and mapped to a virtual host name; `--dev` is the only path to devtools or a debugging port, gated twice |
| packaging | IMPLEMENTED / INSTALL VERIFIED — `native/host.cs` and `native/vendor.js` ship; `native/vendor/` is gitignored and never published |

**NOT VERIFIED.** macOS and Linux hosts do not exist — Windows only, by
decision. Native notifications and OS file pickers are not wired yet; the
capability list in the blueprint states them as host responsibilities, and the
window does not claim them today.

**The one dependency.** The WebView2 RUNTIME is part of Windows (measured here:
152.0.4191.66). Its SDK is not, and copies inside Visual Studio are not LAIN's
to ship — so `native/vendor.js` fetches the published package once, pinned by
version, records its SHA-256 in `native/vendor/PROVENANCE.json`, and caches it.
The host itself is compiled by the `csc.exe` that is part of Windows, in ~190 ms,
cached by the hash of its inputs. LAIN gained no build system and still has no
npm runtime dependencies.

## z.ai — the endpoint is configuration, and the test now says so (2026-09-15)

The operator repointed z.ai at its CODING endpoint in `src/providers.js`
(`https://api.z.ai/api/coding/paas/v4`). `tests/unit/apiendpoints.test.js`
asserted the old URL as a frozen string and went red over a deliberate
configuration change — a false alarm, and a false alarm in a provider test is
how a real one gets ignored.

**Both readings were true.** That endpoint is the intended default AND the
provider supports a configured `baseUrl` per connection, so the test now pins
the RELATIONSHIP rather than a value: the wire URL is exactly the row's
`baseUrl` plus the path its protocol defines (`chat` → `/chat/completions`,
`anthropic` → `/messages`), asserted across EVERY provider rather than the two
that happened to be pinned. Three further cases cover what the frozen string was
really protecting: b.ai and z.ai reach their own hosts, a configured `baseUrl`
overrides the row verbatim without mutating the table, and the picker offers the
same endpoint the sender will use.

Not vacuous: with a hard-coded URL injected into the sender, three of the four
cases fail. The endpoint was not reverted, no other provider moved, no fallback
changed, and no credential was touched.

**IMPLEMENTED / TESTED LOCALLY — NOT LIVE VERIFIED BY THIS PASS.** No request
was made to a z.ai account; unit tests say nothing about account or API validity.

## P0 — the reread loop: where project intelligence actually goes (2026-09-14)

Audited on the hypothesis that the **Rust**-owned project-intelligence layer was
failing to persist or restore. Measured against real code and a real project.

### Was Rust causal? **NOT CAUSAL.**

`rust/lain-supervisor` has never owned project intelligence. `projects.rs`
stores identity, counts and a digest for one question — "have I seen this tree
before, and has it moved?" — and its own test (`projects.rs`, the
`"symbols\":["`/`"imports"`/`"files\":["`/`"mtime"` leak check) FAILS if per-file
data is ever added. Grepping the whole crate for `fingerprint`, `ast`, `symbol`
and `fgm` finds counts and comments, and no computation of any of them. The
durable intelligence is `<project>/.lain/`, written by `src/projectindex.js`.

### What WAS causal: **CONFIRMED**, and it was a two-line disagreement.

`src/jsscan.js` claimed `js|cjs|mjs`. `src/projectindex.js` kept its own list
including `ts|tsx`. So a `.ts` file was admitted, marked `lang: 'js'`, handed to
a scanner that answered "not JavaScript", and stored **with no symbols and no
imports** — no error, no warning, no degraded state, because `scanOne` returned
the identity-only entry on `!model.supported`.

Measured on `C:/Users/Hartezmenot/Documents/toradb` (a TypeScript/React project):

| | before | after |
|---|---|---|
| files on disk (excl. node_modules) | 114 | 114 |
| admitted to the index | 47 | 47 |
| **declarations** | **0** | **1351** |
| **imports** | **0** | **216** |
| `definitionsOf('addMovie')` | NOTHING KNOWN | `src/api.ts:252` |
| `importersOf('src/api.ts')` | NOTHING KNOWN | `src/App.tsx` |
| `.lain/index.json` | **did not exist** | 85 KB, written in 121 ms |

With an index that knows nothing, `locate`, `definitionsOf`, `importersOf` and
`outlineOf` answer "unknown" forever, so every question about the project falls
back to grep and whole-file reads — the same regions, every turn, across every
resume. **That is the loop**, and it needed no memory defect to explain it.

A second gap in the same place: a TypeScript RETURN TYPE hid the function.
Both declaration branches in `codemodel.js` required the body `{` to follow the
parameter `)`, so `export function addMovie(m: Row): Promise<void> {` produced
no symbol at all — and in typed code that is most exported functions.
`bodyAfter()` now steps over the annotation (and refuses `;`, `=`, a closing
bracket, or a `{` inside an unclosed generic, so an interface member and a call
are still not declarations).

### Everything else in the chain was already correct — once symbols existed

Measured, not assumed: after one edit only the edited file is re-scanned
(`changed: 1`, the rest reused); after a process restart the durable file loads
with symbols intact and a refresh re-parses nothing; a missing, empty,
truncated, non-JSON, wrong-shape or old-version index rebuilds from scratch
rather than being half-trusted; an interrupted write leaves no `.tmp`; and six
different spellings of one root (backslash, forward slash, either drive case,
trailing separator, a `..` segment — under an `8.3` `HARTEZ~1` path throughout)
all produce ONE entry with the same normalized relative key. No path-identity
defect was found.

### Two more contributors to the same loop, both fixed

- **`grep` exit 1 was reported as an error.** POSIX defines it as NO MATCH.
  `tools/shell.js` set `isError: code !== 0`, so a clean "nothing there" reached
  the model as a broken command — and the answer to a broken command is to ask
  the same question another way. Search-like tools (grep/egrep/fgrep/rg/ack/
  findstr, judged on the LAST command of a pipeline) now return `noMatch` with
  `[no match]` in the output; exit ≥ 2 is still an error, and exit 1 from
  anything else still is too.
- **Non-progress was keyed on the exact command text.** `progress.js` counted
  repeats under `read_file {"path":"api.ts"}` — so `sed -n '120,180p' api.ts`
  and `grep -n addMovie api.ts` each started the count at zero, and `grep` was
  not recognised as a read at all. The count is now keyed on the FILE, and
  whether the evidence is already in hand is the ledger's answer
  (`readreceipts.covering`), so one question asked five ways is one question —
  while a window of a large file not yet read stays ordinary discovery, and
  anything after a write or a check legitimately starts again.

### Coverage is now measurable

`projectindex.coverage(root)` reports discovered / readable-as-code / scanned /
declarations / imports / not-scanned with FRESH · PARTIAL · STALE · UNKNOWN, and
a REASON for every unscanned file — `scanOne` records `unscanned` rather than
silently storing an empty entry, which is the precise thing that hid this for as
long as it did. One line of it appears in `/status`; it reads the index already
on disk and never starts a scan.

Regression suites: `tests/unit/projectintelligence.test.js` (6 cases, verified
to FAIL against the pre-repair scanner) and
`tests/unit/nonprogress-semantic.test.js` (4 cases).

**NOT DONE in this pass:** §13's step-local durable findings record (SETTLED /
LANDED / REMAINING per plan step) and §15's bounded "exact idiom" prompt policy.
Neither was needed to explain the observed loop, and both change what the model
is told rather than what LAIN knows.

## Computer MCP V1 — three defects the real desktop found (2026-09-14)

Evidence tier: **REAL-DESKTOP VERIFIED** (`tests/smoke/computermcp-real.test.js`
— a compiled UI Automation bridge, the real Windows shell, real applications).
None of these three were visible to any fixture; each was found by pointing the
thing at this machine and watching what it did.

| Defect | Observed | File | Fix |
|---|---|---|---|
| A window title was matched by SUBSTRING | waiting for the file dialog `Open` resolved to a browser window titled "Welcome back - OpenAI - Helium", because "open" is inside "openai" — and the next step typed a file path into that window's address bar | src/computermcp/bridge.cs, src/computer.js | exact title first, then WHOLE-WORD (bounded by a non-alphanumeric on both sides); several matches are REFUSED with the candidates listed; a `pid` alongside a title narrows instead of being ignored |
| Window enumeration excluded OWNED windows | every modal dialog IS an owned window, so native dialogs were invisible to `window.list` and to every `wait.window`; a flow waiting for one timed out while it sat on screen | src/computermcp/bridge.cs | enumerate top-level (no parent) visible titled windows; report `owner` and `dialog` rather than excluding for them — **this fix did not work; see 2026-09-15 below, where "no parent" turned out to mean the same thing as "no owner"** |
| The transport imposed a flat 15 s under operations that carry their own timeout | a 20 s `wait.window` for a dialog that HAD opened returned "no answer within 15 s" — a transport failure wearing the costume of a screen that never changed | src/mcp.js | `callDeadline(params)`: the wait the caller asked for plus grace, never below the ordinary deadline, never unbounded (120 s cap) |

Proven on the real desktop: the bridge builds in ~200 ms and caches by source
hash; displays, windows, cursor and screenshot are real; Calculator is driven
semantically (`num7Button`, `plusButton`, `equalButton` — no coordinates) and
the answer is read back out of `CalculatorResults`, with the bare `+` correctly
INCONCLUSIVE; `/mcp computer` asks once, authorizes for the session, and
disconnect revokes — control after it is refused, including a raw `mouse.move`.

**NOT VERIFIED, and why.** Two flows were implemented and SKIPPED themselves
here. Both skips are gone as of 2026-09-15 — see the next section, which is also
where the reason they were skipping turned out to matter.

## A Windows installer, and what running it found (2026-09-16)

`node distribution/build.js` → **`dist\LAIN-Setup.exe`, one file, 2.2 MB**,
compiled by the `csc.exe` that is part of Windows with the product as an
embedded archive. No WiX, no NSIS, no Inno: the toolchain stays `node` plus the
compiler Windows already has, which is what every other native piece here uses.

The full policy — Node, WebView2, PATH, Start Menu, user data, upgrade,
uninstall, and the exact commands to start each entrypoint — is in
**`docs/INSTALL.md`**.

**The clean-room audit came first, and it is why the payload is what it is.**
The package allowlist was copied to an empty directory and the product run there
with every file access traced: it reached back into the checkout for NOTHING.
One real gap — the WebView2 SDK was fetched-on-demand and not shipped, so an
installed copy could not build `LAIN.exe` without network. It is now an
installer payload extra (`payload.INSTALLER_EXTRAS`), deliberately NOT added to
the npm allowlist, because publishing Microsoft's DLLs in LAIN's npm package is
a different act from shipping them in LAIN's own installer — and a guard in
`install.test.js` already enforced that distinction.

**Four defects, all found by running the artifact rather than reasoning about
it:**

| Defect | Cause |
|---|---|
| the install hung with no output at all | it called `bin/lain-control.js quit` — which is the Computer MCP STOP WINDOW, takes a directory rather than a verb, and waited forever for a state file. Compounded by `ReadToEnd()` blocking before the 30 s timeout could apply. Now `distribution/shutdown.js`, which uses corelock's one control path and always exits |
| the upgrade failed | `ZipFile.ExtractToDirectory` refuses to replace an existing file, and `package.json` is loose in the install root: *"The file 'package.json' already exists."* Now extracted entry by entry, with each destination checked to be inside the install directory |
| uninstalling deleted the installer itself | self-deletion removed whatever exe was running — including `dist\LAIN-Setup.exe`, freshly built. Now scoped to the copy inside the install directory |
| `lain` ran somebody else's LAIN | adding a directory to PATH does not make it win: an npm-installed copy in `%APPDATA%\npm` answered first, on an older Node. The installer now names it and leaves it alone — it is the person's |

**Proven against the artifact, not the checkout:** installed to
`D:\My Applications\LAIN` (another drive, spaces in the path) and
`C:\LAIN Test Install`; `LAIN.exe` started Core and opened a window with no
terminal and no browser; CLI and Desktop saw the same Core; the terminal drawer
ran a command; the Computer MCP bridge built from the install; **Goal Continue
resumed at step 2 after a restart without clearing the plan**; upgrade replaced
binaries and kept sessions; uninstall restored PATH **byte-identical** and kept
the work. Pinned by `tests/distribution/installer.test.js` (6 cases).

**What could NOT be tested, stated rather than worked around:** the "no Node, so
refuse" path is unreachable on a machine with Node in Program Files, because
**Windows will not let a process override `%ProgramFiles%`** — measured, a child
given `ProgramFiles=C:\NoSuchPlace` and an empty PATH still reports
`C:\Program Files`. The test asserts the refusal is compiled in rather than
pretending to exercise it.

## Harness input: no extension needed, one real gap (2026-09-16)

The question was whether a Chrome extension was needed to send mouse and
keyboard into LAIN's own native window. **It is not**, and the audit that
settled it is in the blueprint at §21b, measured rather than reasoned.

**The first audit was not admissible, and that is worth recording.** It drove
the renderer through CDP, which requires `dev: true` — and dev mode flips
`AreDefaultContextMenusEnabled` and `AreBrowserAcceleratorKeysEnabled`. So it
measured a surface the shipped product does not have. Re-run against the
RELEASE window with real Windows input through Computer MCP: click, double
click, wheel, typing, arrows, Home/End, Tab, Enter, Ctrl+A/C/V, DPI targeting at
1.5× and 2×, focus restoration and shell keystrokes all work, and the page is a
47-node UI Automation tree.

**The one gap: no context menu.** `AreDefaultContextMenusEnabled = false` is
right — WebView2's own menu offers Reload, View source, Save as and Inspect —
but it took Copy and Paste with it, so right-clicking did nothing at all. Fixed
with LAIN's own menu (`src/harnessapp/pagemenu.js`): Copy · Cut · Paste · Select
all, nothing browser-shaped, and **Core owns the clipboard** through
`/api/clipboard/{read,write}` so `src/copy.js` stays the single sanitiser.

Ctrl+C/Ctrl+V were *assumed* broken by reading the setting's name and *measured*
working: that flag disables browser accelerators, not editing ones.

## The temp visual HTML, and who was really making it (2026-09-16)

Observed:
`file:///C:/Users/.../lain-test-home-.../visual/view/view-1789468899258.html`
showing a `shot.png`.

The producer was **`src/imageview.js`**, not the deleted four-picture flow. It
generated an HTML page with an `<img>` in it, wrote it into LAIN's config
directory, and handed that file to the machine's default viewer — which on
Windows is a BROWSER. So "show me the screenshot" opened a browser tab pointed
at a generated `file://` page, put browser-era architecture in the middle of the
native application, and left the page on disk forever. Reproduced exactly before
anything was changed.

**Now:** image produced → adopted as a task ARTIFACT → offered to the window BY
REFERENCE → drawn by the native viewer. `page()` and `dir()` are gone; a PNG
needs no markup.

| Piece | What it does |
|---|---|
| `src/imageviewer.js` | the shelf. `img_<hex>` references only — a PATH is refused, a forged ref resolves to nothing, one session's shelf is not another's. Bounded at 24 |
| adoption | where a task is running the picture is copied into that task's artifact area, so the temp original can be swept and the evidence survives (proven) |
| `src/harnessapp/imageroutes.js` | `read` (base64, once, by reference) · `external` (the SECONDARY action) · `close` |
| `src/harnessapp/pageimage.js` | fit · zoom · pan · 1:1 with true dimensions · provenance · Open externally |
| state | `viewing` says WHICH image is open and carries no bytes — a screenshot in the poll payload is a screenshot re-sent every poll |

Ordinary image attachments, Cowork image operations, Workshop and verification
screenshots are untouched. Only the HTML indirection was removed.

Regression: `tests/unit/imageviewer.test.js` (10 cases) proves no `view-*.html`
is produced on either branch, that the module has no page generator left to
call, and that a path is not a reference. `imageview.open` also grew an
injectable launcher so the suite stops opening a real viewer window on the
developer's desktop on every run.

## Continue means continue (2026-09-16)

`/goal` → **Continue** ran `goal.activate` and nothing else: the goal became
active and LAIN waited for the person to type the word "continue" at it. `/plan`
→ **Continue** was worse — it matched no branch at all, so the button did
exactly what Escape did. A test even pinned that as the contract ("PLAN SHELF:
Continue changes nothing"); it was an accurate description of a defect.

**Three NAMED actions** (`src/continueactions.js`), never one generic
`continue()` whose meaning depends on the menu that called it:

| Action | Meaning |
|---|---|
| `GOAL_CONTINUE` | resume work toward the goal. STARTS A TURN |
| `PLAN_CONTINUE` | resume executing the plan. STARTS A TURN |
| `SESSION_RESUME` | open a conversation. STARTS NOTHING, on purpose |

It does **not** send the word "continue" to the model — that is a sentence with
no referent, and the model would re-read the project to work out what it was
doing, which is the same-state loop the findings record exists to stop. It
resolves durable state instead: the goal's words, the first step that is
genuinely unfinished (never step 1 again), and an explicit instruction not to
re-derive what the record already states.

- **QUEUED, not refused.** Continue while a turn runs reports QUEUED and the
  work really runs when that turn ends (`submitclose.js`) — a Ctrl+C drops it,
  because starting fresh work out of a cancellation is the opposite of stopping.
- **A completed goal is not silently re-run.** Completion is set only by a
  PERSON, which keeps `goal.js`'s rule that "a state no code sets is a promise,
  not a fact" — a person saying so IS an observation. Reopening keeps the
  evidence in `reopenedFrom`.

**Found by pressing Continue in a real terminal, missed by every unit case:**
Continue WIPED THE PLAN IT CONTINUED. `/goal` and `/plan` are commands, not
turns, so a plan can exist with no task object; `identify.js` honoured `sameTask`
only when a task already existed, so the continuation was classified as a NEW
task — and a new task sets `plan = null`. The turn ran, and the next `/plan`
opened an empty composer. The unit tests missed it because their fake `submit`
never reached `identify`. Fixed at identify (a plan the machinery says it is
continuing is kept; typed input still cannot assert that), pinned against the
real classifier and proven to fail without the fix, and covered end to end by a
real-TTY case that presses Continue on both shelves with Enter and types
nothing else.

**Also:** the screenshot tool now tells the model the ARTIFACT path once a
capture is adopted and deletes the `%TEMP%\lain-computer-*.png` original, rather
than leaving one per screenshot for the life of the machine — which in turn
needed the viewer to recognise a picture by either path, or `/image` on the
artifact path re-adopted a duplicate and dropped its provenance.

**Left alone, deliberately:** `~/.lain-v2/visual/view/` on this machine still
holds 4 wrapper pages (712 bytes, all written within 40 ms on 2026-08-21 — an old
test run that escaped config isolation, not use), and `~/.lain-v2/visual/`
holds 5 `round-*.html` files from the removed judgment flow (up to 2.9 MB, with
embedded images). Nothing writes to either any more. They are in a person's
home directory and the rounds may be evidence, so they were reported rather
than deleted.

**A latent defect found on the way:** `promptparts.js` called `plan.digest()`
with no session, so `planfindings.derive` never ran on the prompt path. The
derived-LANDED list — what Core's own mutation receipts say actually landed,
independent of whether the model remembered to write it down — was built in the
previous pass and never reached the model. One argument.

## Ctrl+C in the terminal drawer — the boundary, measured (2026-09-16)

Carried as NOT VERIFIED since the drawer was built. Now measured, and the
answer is a platform boundary rather than a bug LAIN can fix.

The drawer raises a real console control event on the shell's own console:
`FreeConsole` → `AttachConsole(shell pid)` → `GenerateConsoleCtrlEvent`. **Both
calls succeed.** PowerShell does not act on it. Four process arrangements were
tried against `Start-Sleep -Seconds 20`, on Windows 11 26200:

| Arrangement | Result |
|---|---|
| the shell gets a stdin PIPE of its own (what ships) | the sleep ran to completion |
| no `STARTF_USESTDHANDLES`, the pseudoconsole attribute alone | the shell inherited **the bridge's own stdin** and started parsing LAIN's protocol JSON as PowerShell — the attribute gives the child a console for OUTPUT but not for input |
| stdin left NULL so the shell opens `CONIN$` itself | typing, prompts, reflow and width all worked — the sleep still ran to completion |
| the above plus `CREATE_NEW_PROCESS_GROUP`, `CTRL_BREAK` aimed at the shell's own group | no change |

So the shipped arrangement stays the one that is known to work for typing,
colour, reflow and width. Two things changed:

- **The bridge no longer fails silently.** Every failure in `Interrupt()` was
  swallowed, so an interrupt that did nothing was indistinguishable from one
  that worked — which is how this survived a whole pass with a Ctrl+C button on
  the panel. It now reports the Win32 error.
- **The button says what it is.** Pressing Ctrl+C in the drawer now answers
  "Interrupt sent. If the command keeps running, End shell stops it." A control
  that silently does nothing is worse than one that admits its limit.

`End shell` remains the action that always stops the work.

## The terminal panel moved to the terminal module (2026-09-16)

`pagescript.js` reached **697 of the 700 lines** the god-object guard allows —
the next edit anywhere in it would have failed the build. The 92-line panel
renderer moved to `pageterminal.js`, which is where it belonged: it reads that
module's state, calls its `open`/`send`/`draw`, and changes when the terminal
changes. `pagescript.js` 697 → 583, `pageterminal.js` 253 → 381.

Not a rename: `renderTerminal(body)` became `LAIN.terminal.renderPanel(body)`,
and `poll` joined the dependencies `boot` already took. The guard asked for a
seam that was already there.

Verified by driving the drawer as a person does — click the tab, Open shell,
shut the panel, prove the shell kept running, reopen and prove the panel caught
up by byte offset — plus the real-UI suites (17/0).

## The drawer was stripping the meaning out of its own output (2026-09-16)

The panel removed every control sequence and turned CARRIAGE RETURN into a
NEWLINE. Every progress bar, download meter and spinner on Windows redraws one
line by returning to its start — so a line that ends at `100%` was drawn as
fifty lines ending `2%`, `5%`, `9%`…

That is precisely the failure the "it is not a terminal emulator" rule exists to
prevent: **a build log that is subtly not what the build said**. Stripping was
not the conservative choice here, it was the lie.

Now implemented, and nothing more: carriage return overwrites, backspace
deletes, erase-in-line and erase-in-display clear, and SGR colour is drawn as
styled runs (a failing test's red is information, and a pseudoconsole exists to
carry it). Colour cannot misrepresent text — it only styles it. Cursor
addressing, scroll regions and the alternate screen remain absent by choice, and
an unimplemented sequence leaves NO trace.

Pinned by `tests/smoke/terminal-render.test.js` against a real PowerShell
writing a real meter with real carriage returns, and proven non-vacuous — with
the old behaviour it fails with
`["downloading   2%","downloading  57%","downloading 100%"]` where one line is
expected. It also asserts that what is drawn is nodes, never markup from the
shell.

## Gates (2026-09-16)

| Tier | Result | Skips |
|---|---|---|
| unit | **2882 / 0** | — |
| integration | **202 / 0** | — |
| smoke | **599 / 0** | **none** |
| distribution | **48 / 0** | — |
| live | **8 / 0** | **none** |

The live tier went from 4 passing with one skip to **8 passing with none**: a
provider bridge became reachable at `127.0.0.1:20128` (913 models advertised),
so `provider.test.js` really ran — a real completion, real tool calls, and a
connection left REQUEST_READY with a clean exit. Note that this tier now SPENDS
TOKENS against whatever that bridge routes to; it skips itself, and says so,
when nothing is listening.

`adversarial` is deliberately not in the default run and was NOT run: it drives
a REAL model and costs tokens. A green run here claims nothing about it.

## Gates, at the end of the previous pass (2026-09-15)

| Tier | Result | Skips |
|---|---|---|
| unit | **2855 / 0** | — |
| integration | **202 / 0** | — |
| smoke | **597 / 0** | **none** |
| distribution | **42 / 0** | — |
| live | **4 / 0** | `provider.test.js` — no local bridge at `127.0.0.1:20128`; it reads no credential from config, so it cannot be made to pass by spending somebody's quota |

Smoke was 561 / 1 with three skips before this pass. The three were all the
real-TTY tier wanting `LAIN_TTY_PYTHON`; set to the pyte/pywinpty environment on
this machine they resolve to **36 passing real-TTY cases**, so they were
environmental rather than a gap. The one failure is written up under "One more
full-tier-only failure" below.

`adversarial` is deliberately not in the default run and was NOT run: it drives a
REAL model and costs tokens. A green run here therefore claims nothing about
adversarial verification.

**The acceptance sequence, A→N**, against the launcher a person double-clicks:
LAIN.exe built and installed (recording `C:\Program Files\nodejs\node.exe`);
Core up from the launcher alone with a window, no terminal and no browser;
sessions in the rail; the project opened; the structural question answered from
the index (`src/scheduler.ts:4`, and the TYPE too) with a warm second look
reparsing nothing; a step's findings surviving a resume and reaching the model;
switching and creating sessions while a turn runs, with that turn still running;
a real pseudoconsole in the drawer that reports a console width of 100 rather
than a pipe; Open CLI on another session, closed without disturbing Core; Quit
ending Core and its window; **0** `lain-desktop` processes left anywhere.

## Daily use: a LAIN window that is not full screen (2026-09-15)

Evidence tier: **REAL-UI VERIFIED** (`tests/smoke/harnessapp-real.test.js` — the
real window, driven through its own DOM). Found by measuring the application at
the widths a person actually uses it at, rather than at the one it is developed
at.

**Startup and responsiveness, measured:** window open and attached **1141 ms**,
content visible **1 ms** after that; seven sessions created in 39 ms and shown
in the rail 295 ms later; selecting a session answers in **0 ms** and the rail
marks it 171 ms later; no page errors during the drive.

**The defect: below ~820 px the composer was off the window.** At 520 px the
grid was 813 px wide and the Send button sat **293 px past the right edge** — a
LAIN you could read and could not type into. At 420 px, 393 px. Two causes, both
a track refusing to be narrower than its contents:

| Cause | Fix |
|---|---|
| `grid-template-columns: 250px 1fr` — a `1fr` track will not shrink below the MIN-CONTENT width of what is in it, and the conversation column holds code, long paths and provider JSON | `minmax(0,1fr)` on every flexible column. The four-column rule already had it; the base case never did |
| the composer's pill row (`.tools`) could not wrap, so it set a min-content floor for the whole window — and Send, being last, was what got pushed off | `flex-wrap: wrap` |

And below 820 px the session rail now becomes a panel over the conversation
rather than 250 px of the 520 that are left, reached by a header button that
exists only at that width. **It is not hidden**: a narrow window that dropped the
session list would be one you cannot leave the session you are in, which is the
defect the session pool exists to prevent.

Pinned by a regression that asserts the property rather than the appearance —
at 1920, 1280, 1024 @1.5×, 820, 520 and 420 @2×: nothing bleeds past the window,
the box you type in is reachable, and Send is reachable. Proven non-vacuous
(fails with "520x700 @1x bleeds 21px past the window" against the old CSS).

### One more full-tier-only failure, and why the product was left alone

`CLIP → PS: non-ASCII survives the trip` failed once in a full smoke tier,
reporting the PREVIOUS clipboard contents verbatim. `clip.exe` exits 0 when it
has ASKED for the clipboard, so a read straight after can still see what was
there before — which is not evidence about encoding at all, it is a failure to
observe.

Measured before changing anything: **0 stale reads in 80 write/read round
trips**, idle and under a concurrent unit tier, and one read costs **~210 ms**.
That is too rare and too expensive to make every `/copy` verify itself, so the
race is tolerated in the product and waited out in the test — and only "we still
see the OLD contents" is retried. Anything else that is not the sample is a real
answer (the arrow came back as three console-codepage letters) and fails at once.

## Installing: the desktop had no way in (2026-09-15)

`lain` on PATH was the whole install story. `LAIN.exe` was written into LAIN's
own directory, where nothing points at it — so the native Harness could only be
started by typing a path into a terminal, which is the thing it exists to make
optional.

`distribution/shortcut.js` writes a per-user Start Menu entry through
`WScript.Shell` (a `.lnk` is a COM shell object; no dependency is added), wired
into `install.js` §6 and removed by `uninstall.js`. **It can never fail an
install**: a machine with no C# compiler or a locked-down Start Menu is a machine
where LAIN works completely from the CLI, so the reason is reported and the
install carries on — the same rule as "no browser is downloaded".

Tested against a redirected `%APPDATA%`, which is how Windows itself resolves the
per-user Start Menu, so nothing in this repository can put an entry into the
Start Menu of the person running the tests.

## Computer MCP — four more defects, found by removing the two skips (2026-09-15)

Evidence tier: **REAL-DESKTOP VERIFIED**. The two skipped cases were replaced
with an application the suite OWNS — `tests/fixtures/winapp.cs`, built by the
same `csc.exe` the bridge is, started and closed by the test, aimed at by PID
and window handle. It gives a titled window, a named UI Automation tree, a text
box that reads back, and REAL shell `Save As` / `Open` dialogs. Nothing about it
is simulated; the only thing it removes is the chance of typing into somebody's
unsaved document.

Driving it found four defects, in a row, each hidden behind the one before it.

| Defect | Observed | Fix |
|---|---|---|
| Owned windows were STILL excluded | the 2026-09-14 fix replaced "no owner" with `GetParent(h) == 0` — and `GetParent` RETURNS THE OWNER for an owned top-level window. Raw enumeration with a real Save As open: `h=18812950 vis=True parent=27660050 owner=27660050 class=#32770 title=Save As`. So every modal dialog on the machine was still invisible, and the browser-picker case's "no picker appeared" could not be believed | `GetAncestor(h, GA_PARENT) == GetDesktopWindow()`, which is what "top-level" actually means |
| `ValuePattern.SetValue` can never return | on the shell `Save As` file-name edit it does not return — polled for over 100 s afterwards, every UI Automation question about that dialog still blocked. The application's UI thread is gone for the rest of its life | in a native dialog (`#32770`) the bridge TYPES instead, which is what a person does and is safe there because the dialog is modal and in front — and it verifies the window is in front before sending a keystroke. Elsewhere `ValuePattern` is still preferred, but BOUNDED |
| One wedged call took the whole session's computer | the bridge loop is serial, so after the above every later request answered "no answer within 15 s" — for the life of the process | each request runs on its own background STA thread with a cap; a request that does not return is abandoned and NAMED, and the next one is served |
| `Pick` resolved an ambiguous control by POSITION | `controlType: 'Edit'` matches **41** controls in the shell Save As — every cell of the file list is an Edit — and the file name box is near the end. So "type the path into the Edit of the Save dialog" typed it into a grid cell **and reported success**, because setting a value on the wrong control succeeds | refused with the candidates listed, exactly as an ambiguous *window* has been refused since 2026-09-14; an explicit `index` still chooses |

A fifth, found on the way out: `uia.invoke` read the element row AFTER invoking
it, so pressing a dialog's own **Save** or **Open** button — the most ordinary
desktop action there is — threw "the target element corresponds to UI that is no
longer available" and reported **FAILED** for a click that had just written the
file to disk. The row is now read first.

**Proven end to end, with no skips:** type into an application, raise its native
`Save As`, name the file, press Save, and the FILE ON DISK holds what was typed;
raise its native `Open`, choose a file, and the APPLICATION reports
`chosen: quarterly-report.txt (44 bytes)` — read out of its UI Automation tree,
not off a screenshot.

**The browser half, stated exactly.** Chrome 153 over CDP still raises no native
picker for a scripted click: the click reaches the input and is trusted
(`isTrusted === true`), no `Page.fileChooserOpened` is emitted, no dialog window
is created — with the CDP session attached and after detaching it and clicking
with a real OS mouse. RE-MEASURED after the owned-window fix above, because
before it a picker that DID appear would have looked exactly like this. That
case no longer skips: it asserts what it can prove (no file reaches the page
unchosen; the OS dialog is not part of the document; a wait for `Open` must not
match an `OpenAI`-titled window) and reports the platform boundary as an
observation. The OS picker itself is proven independently, against the same
shell dialog a browser would raise.

## Order-dependent failures found by running the WHOLE tier (2026-09-14)

Four failures that no single-file run could produce. Three were mine and are
fixed; two remain open and are named here rather than left to be rediscovered.

**Fixed.**

- `computermcp-real` left a whole `Harness` alive in the runner process — the
  browser was closed, the ProcessManager, guardian and exit hooks were not —
  and `environment-browser`, running later, then found its own disposable
  Chromium profile still on disk. The test now calls `instrument.shutdown()`.
- `computermcp-real` aimed Calculator by `{ pid }`. Calculator is a store app,
  so its process is `ApplicationFrameHost`, shared with every other store app:
  the bridge REFUSED the target as ambiguous ("pid N matches 2 windows:
  Calculator, Settings"). The refusal is the safety property working; the test
  now aims by window HANDLE, and `openApp` prefers a title match over the first
  row of a shared pid and reports when a process owns several windows.
- A static server inside `computermcp-real` resolved `"/?p=1"` to the DIRECTORY
  and threw `EISDIR` out of a request handler, ending the entire run. It now
  strips the query string and refuses to be the thing that kills the process.

- `tests/harness/appdriver.js` had the same leak, so every real-UI test shared
  it; `close()` now shuts the instrument down too.
- `smoke/mcq.test.js` fed an interactive panel with a fixed **700 ms** step
  delay. Under the full tier that is not long enough for the panel to be open
  when the next key arrives: three cases failed, while all seventeen passed
  alone. Raised to 1500 ms, then to 2500 ms after one case still raced.
  THE SAME CLASS as the `ask` fix below: a test racing the screen.

  **The underlying fragility is NOT fixed.** `runCli`'s `stdinSteps` is a fixed
  timer chain (`tests/helpers.js`), so every interactive smoke test is betting
  a constant against machine load. The real fix is for a step to WAIT for the
  screen it is answering — a `waitFor` on the accumulated output — rather than
  for a longer guess. That is a change to shared harness plumbing under 500+
  smoke cases and was deliberately not made at the end of this pass.

- `smoke/environment-browser.test.js` asserted that a disposable Chromium
  profile was gone the instant `stop()` returned. `stop()` already retries the
  removal and REPORTS the outcome (`cleaned`, `why`), so a real leak was never
  silent — what it cannot control is how long Windows holds the handles of nine
  just-killed Chromium processes, and under the full tier (dozens of browsers in
  one run) the removal outran its budget. The test now polls for up to 20 s and
  quotes what `stop()` said on failure, so a profile that genuinely survives
  still fails the guard while a merely busy machine does not.

**Open, and not mine to fix blind** (both in the process-ownership area, both
pass in isolation and fail only under the full tier):

- `integration/cowork-remote.test.js` — `EPERM` removing its temp directory in
  teardown. Adding the retry the file's other two cases already use did NOT
  help, which rules out a lagging handle: on Windows this shape means a live
  process still holds the directory (a cwd or a watcher). Passes alone and
  alongside its neighbours; something earlier in the tier leaves it held.
- `integration/harness-lifecycle.test.js` — "a dead test lease also stops a
  running supervisor job and its descendants" failed once under a subset run
  and passed on the next identical run. Genuinely flaky under load.

## The transcript stopped reprinting what you pasted (2026-09-14) — REAL_TTY_VERIFIED

An intentional contract change, recorded because three tests asserted the old
behaviour and a reader will otherwise think they were "fixed to pass".

A user message is now ONE gray anchor row — `USER · <the real opening words>…`
— above a turn divider. It used to redraw the whole message, so a pasted
thirty-line log sat between every question and LAIN's answer, which is what
made the CLI unreadable at length. Nothing is lost: the anchor carries the
exact prompt, Alt+Up walks the anchors, a click restores it, and the session
and the model still hold every byte — all of that is asserted.

Updated to the new contract: `smoke/anchornav.test.js`,
`smoke/pasteflow.test.js`. Both now also assert the NEGATIVE (the wall is not
reprinted), so a silent regression back to the old drawing fails.

## `ask` raced a closed stdin (2026-09-14) — LIVE-VERIFIED

`smoke/ask.test.js` wrote its whole script as ONE string, which closes stdin
immediately, then relied on the question reaching the panel before the close
was noticed. LAIN deliberately refuses to open a question nobody can answer
(`ui/index.js`: "END OF INPUT IS A STATE, NOT AN EVENT"), so that race decided
whether the panel rendered — and it started losing the moment an `await` was
added ahead of `submit`. The product behaviour is correct and unchanged; the
race was the test's. It now feeds steps, so stdin is still open when the
question arrives and the panel is actually exercised.

## A declaration list binds all of its names (2026-09-14) — UNIT-VERIFIED

`const runtime = f(), sheet = g();` registered only `runtime`. Every later name
in a declaration list read as a reference to something undeclared, and the typo
channel — doing its job on bad input — offered the nearest binding: **`sheet`
reported as a typo for `sent`**, in working committed code. One false positive
makes that channel worthless, so the parse is the thing that had to be right.
`src/codemodel.js` now walks the whole declaration (`declaratorsAfter`), which
`statementEnd` deliberately does not, since it marks ONE declarator. Covered by
`tests/unit/codemodel.test.js` (`MODEL: a declaration list binds all of its
names`), including the negative: an object literal's keys are still not
bindings.

## A prompt after DONE is a new turn — the "Enter does nothing" release blocker (2026-09-14)

Reported: after DONE, typing a new prompt and pressing Enter did nothing, DONE
stayed, only a restart helped. Traced with an admission trace
(`LAIN_TRACE_ADMISSION=<file>`, src/admissiontrace.js) through repl → queue →
`App.handle` → gate → `submit`: **input admission was never blocked** — every
line reached `submit:begin` with a new turn. What failed was what the turn did
and what the screen drew. Measured in the real session (glm-5.3-free): a turn
with 53,079 input tokens, 0 output, no text, no calls, settled DONE in 1.7 s.

| Defect | File | Fix |
|---|---|---|
| An empty provider reply settled as a successful turn | src/turn.js | retried once, then a `provider` failure — never DONE |
| That empty failure fed the connection circuit breaker (threshold 2, 60 s) — later prompts were skipped with 0 requests until restart | src/turn.js | an empty body is not reachability evidence |
| Two user messages with nothing between them drew as ONE block — the new prompt looked like a continuation line | src/ui/feed.js | each message marks its head; a new head starts a new block |
| `/goal` / `/plan` composer hint written to the transcript stayed under every later turn | src/composemode.js, goalcommand.js, plan.js | hint is a story note owned by the composer; dropped on Esc/Enter |
| Any same-task follow-up resumed the previous turn's clock | src/ui/alert.js | CONTINUE only for a paused clock, a live limit wait, a BLOCKED failure, or `continue` after an interrupt |
| Presentation pacing: prose scramble reveal ≤1.5 s, tool cards held ≥560 ms, timeline up to 12 s behind the work | src/ui/index.js, playback.js, timeline.js | activity surface instant on every terminal; the call in flight keeps a live card, with the call before it settled one row up |
| Found by removing the pacing: the feed cache dropped `fileAt`, so clicking a file row on any settled screen opened nothing (the animation's redraws had kept the cache out of the way) | src/ui/feedcache.js | the copy carries `fileAt` |
| Clicking a file opened the read-performance window, which no longer exists | src/ui/mouse.js | opens the file in the OUTPUT panel (own case, blank lines kept, Esc closes) |

Proof: tests/smoke/sequentialturns.test.js (REAL_TTY_VERIFIED, ConPTY) FAILS
against the pre-repair turn.js/feed.js (times out on SECOND_REPLY, merged
block) and passes after; its second case is the acceptance sequence (three
prompts, /goal, prompt, /model, prompt, 429 wait that recovers, prompt, Ctrl+C,
prompt — one process). tests/integration/turnadmission.test.js drives
`App.handle` after DONE, provider failure, refusal, rate-limit recovery,
coding, interrupt, /verify FAILED, /goal, /bg settlement, and Chat/Coding
across LAIN, ChatGPT.com, local model and Gemini (web sources FIXTURE VERIFIED,
not live). tests/unit/turnboundary.test.js locks each rule. Tests that
REQUIRED the removed animation (frames.test.js: progressive diff window,
travelling strike, climbing counters, converging prose; timeline.test.js:
diff window opens then goes away) now assert its absence on the same frames.

Suite (2026-09-14): unit 2808 passed / 2 failed · integration 201 / 1
(cowork-remote EPERM on temp cleanup; 3/3 on rerun) · smoke 575 / 8, of which
the real-terminal tier (ConPTY, LAIN_TTY_PYTHON set) is 35/35 including both
SEQUENTIAL TURNS cases.

Pre-existing, NOT caused and NOT fixed here — identical failures on a clean
HEAD worktree (9311201): smoke live-ui (PLAN "DONE"), ratelimit ×2 (expects the
old durable retry wording), refusal (413 message-count), research, screen-context,
steermode (waiting steer), trust (question on screen); unit apiendpoints (z.ai —
the user's uncommitted src/providers.js) and codemodel TYPO (committed
tests/integration/cowork-remote.test.js:137).

Remaining timers, all justified (none delays output or DONE): provider
backoff/retry sleeps, the rate-limit countdown, web-page polling (pageops),
request/connect timeouts, ESC-sequence disambiguation (input.js), Ctrl+C exit
confirm window, transient-note/receipt-panel lifetimes, the terminal-title
success reset, same-tick background-completion batching, the 250 ms redraw tick.


One architectural objective: make `/goal → task → plan → work order` the
canonical chain for foreground coding, `/bg`, and the existing Cowork/Bot
background work. Cowork predates the authority model and was **adopted into it,
not redesigned** — nothing in `c6477ce` or `9311201` was rewritten.

### The defect, found by audit rather than by a crash

Every consumer that needed to know *what is this work FOR* reached into the
session and picked its own fields, and the lists disagreed:

| Consumer | What it read |
|---|---|
| `jobrunner.forkSession` | `task`, `mode` — **and not `goal`** |
| `appprompt.js` | goal and plan, separately |
| `tools/plan.js` | `input.objective` **or** `session.task.objective` |
| `handover.js` | task and steers |

None was wrong alone. Together they were four answers to one question, so **every
background job ran without the user's standing direction** — `/bg`, a Bot `/bg`,
and a Harness-app job alike — and nothing reported it. The worker had a task and
produced work; the only symptom was work that served the sentence and not the
project.

Meanwhile `plan_write` took the *model's* objective in preference to the task's,
so this could coexist with nothing noticing:

```
GOAL   stabilise provider continuation
TASK   repair handover
PLAN   redesign frontend        <- nothing compared them
```

### `src/authority.js` — a projection, not a store

`project(session, options)` returns the whole chain: goal, task, plan, work
order, executor, scope revision, relation, verification, contradictions,
freshness. Every field is read through the module that owns it. **Nothing here
holds state** — the module can be deleted and rebuilt from the session, which is
the test of whether it has stayed a projection. A fifth store would have been the
disease, not the cure.

| Capability | Tier | Label |
|---|---|---|
| One call answers the question at every rung | unit | **UNIT-VERIFIED** |
| It re-reads its sources rather than remembering them | unit | **UNIT-VERIFIED** |
| A null session projects nulls rather than throwing | unit | **UNIT-VERIFIED** |
| A steer raises the scope revision | unit | **UNIT-VERIFIED** |
| The plan rung carries no objective at all | unit | **UNIT-VERIFIED** |

### One background seam, so Cowork inherits the fix

There is exactly one background entry point — `app.startBackground` →
`jobrunner.forkSession` — shared by `/bg`, `src/bot/runtime.js` and
`harnessapp/routes.js`. Fixing it once served all three, which is why no Cowork
orchestration had to be touched.

`forkSession` now inherits the chain **by name of what it is** rather than from a
hand-maintained field list, because the next rung added would not have been added
there either.

Two bugs fixed on the way, both beyond the original audit:

- `s.task = { ...app.session.task }` produced a plain object with **no `Task`
  methods**, so a forked session's task could not be asked whether it was live
  and could not record a provider block.
- `Task.toJSON()` returns the **live arrays** and `Task.from()` adopted them
  directly, so two Tasks shared one `steers` array. A worker told *"keep the old
  format working"* wrote that sentence into the foreground task's own record,
  where a user who never said it would read it as their own correction. Fixed in
  the deserialiser, not at the call site that noticed.

| Capability | Tier | Label |
|---|---|---|
| 14.A a `/bg` fork inherits the goal, with the SAME goal identity | unit | **UNIT-VERIFIED** |
| The fork gets a real `Task`, and shares none of the parent's arrays | unit | **UNIT-VERIFIED** |
| The fork does NOT inherit the parent's plan or lifecycle | unit | **UNIT-VERIFIED** |
| A background job is issued exactly one work order, hung from the chain by id | unit | **UNIT-VERIFIED** |
| A worker is told its assignment; the foreground is not | unit | **UNIT-VERIFIED** |
| The standing goal appears exactly once in a built prompt | unit | **UNIT-VERIFIED** |

### `plan.objective` is no longer an authority

Option A of the three offered. The field stays — session files carry it and
`describe()` prints it — but `plan_write` now checks the model's version instead
of preferring it. A label sharing no content words with the task **or** the goal
is dropped and reported; the plan still lands, because the steps are the useful
part and refusing real work over a display string would lose it.

The schema description changed too: it used to read *"optional one-line
restatement of the goal"*, which invited exactly the third objective-shaped field
this removes.

| Capability | Tier | Label |
|---|---|---|
| 14.B a contradicting plan objective is detected and reported | unit | **UNIT-VERIFIED** |
| The steps survive; only the label is dropped | unit | **UNIT-VERIFIED** |
| A legitimate restatement of the task or goal is NOT flagged | unit | **UNIT-VERIFIED** |
| The plan rung is absent from the canonical projection | unit | **UNIT-VERIFIED** |

Detection uses `task.objectiveOverlap` — *"are these two sentences about the same
work"* already had one answer in this tree and must not acquire a second.

### Goal supersession: reported, never applied

`goal.js` already held the invariant that **only `/goal` writes the goal**, so the
overwrite risk the brief warns about did not exist. What was missing was the
ability to say how a new request *stands* to the standing direction.
`goal.relate()` classifies it and writes nothing.

The default is `CONTINUES_GOAL` and has to be: *"also fix the timer"*, *"check
that test too"*, *"implement the next step"* are all ordinary tasks, and a
classifier that treated them as new directions would ask for confirmation
constantly. Supersession is recognised only from language that says so outright.
`instead` requires a scope word, because *"use a map instead"* changes an
implementation and no direction at all.

Only a cancellation with **no named successor** is `ambiguous` — *"the new goal is
X"* says what to do next; *"stop working on X"* does not, and LAIN must not invent
the successor. That is the one case worth a question.

| Capability | Tier | Label |
|---|---|---|
| Four ordinary requests stay `CONTINUES_GOAL` and prompt nobody | unit | **UNIT-VERIFIED** |
| Four explicit changes of direction are recognised and flagged | unit | **UNIT-VERIFIED** |
| Only an unsuccessored cancellation is AMBIGUOUS | unit | **UNIT-VERIFIED** |
| Classifying never writes the goal — the one door still holds | unit | **UNIT-VERIFIED** |
| A goal has a stable id, recovered for records written before ids | unit | **UNIT-VERIFIED** |

### WorkOrder — one contract, before there are many backends

Built now precisely because `/bg` already had its own way of orienting a worker
and an OpenRouter or Codex path would each have invented another. Three
orchestrations with three notions of *what is this worker for* cannot be
reconciled afterwards.

`reassign()` changes the executor and the epoch and **nothing else** — not the
id, the goal id, the task id, the scope, the baseline or the evidence. A model
name is not part of a work order's identity.

`claim()` and `verified()` are two methods and `CLAIMED` and `VERIFIED` are two
states. `verified()` **refuses** without at least one LAIN-gathered receipt, and
the refusal is the feature: without it, `verified()` is a setter reachable from a
worker's claim in one line.

| Capability | Tier | Label |
|---|---|---|
| 14.C an executor switch changes the epoch and nothing else | unit | **UNIT-VERIFIED** |
| The projection's epoch is derived from the handover log | unit | **UNIT-VERIFIED** |
| A worker's claim does not make an order verified | unit | **UNIT-VERIFIED** |
| Only LAIN-gathered receipts reach VERIFIED | unit | **UNIT-VERIFIED** |
| A work order round-trips with its ladder intact | unit | **UNIT-VERIFIED** |
| A work order is **persisted** to disk | — | **NOT IMPLEMENTED** |

The last row is a stated limitation, not an oversight: `Session.toJSON` is an
allowlist that omits `workOrder` and the job registry is in-memory, so an order
lives as long as its job — which matches what `/bg` already does. The
serialisation exists so making it durable is wiring rather than redesign.

### Cowork adopted, not redesigned

Cowork's ownership boundary is a harness task whose `sessionId` and `workspace`
match the session's, checked against the real path. **It was not touched.** The
integration is a read-only `authority` field on `cowork/runtime.js project()`,
bounded through `contract.safeText` like everything else crossing that boundary —
orientation, never authorisation. A goal id cannot widen what a conversation can
reach, and a test asserts `cowork/artifacts.js` consults no chain field at all.

| Capability | Tier | Label |
|---|---|---|
| A bound Cowork session projects the chain it is serving | unit | **UNIT-VERIFIED** |
| An unbound session projects no authority, like every other field | unit | **UNIT-VERIFIED** |
| 14.D a Cowork background job carries the goal and gets a work order | unit | **UNIT-VERIFIED** |
| Artifact ownership consults no authority-chain field | unit | **UNIT-VERIFIED** |
| 14.E artifact paths, ownership, isolation, approvals, delivery | integration | **INTEGRATION-VERIFIED** |

14.E was re-run in full and is unchanged: `cowork-files 6`, `cowork-remote 3`,
`cowork-email 1`, `cowork-personal 1`, `bot-telegram 4`, `bot-telegram-media 3`,
`bot-runtime 1`, `bot-service 2`, `bot-whatsapp 1`, `bot-release 5` — all passing.

### A try/catch that hid a real bug

`appprompt.js` wraps the briefing so a failure cannot take a turn down. That is
correct, and it meant a `ReferenceError` in `brief()` produced a **silently
missing prompt section** rather than a crash. Caught by testing `brief()`
directly, and there is now a test whose stated purpose is that nothing swallows
the call.

The same wiring first printed the standing goal directly under a `# Goal` heading
that had just printed it. `brief({ omit })` exists for that: a system prompt does
not grow because somebody adds a paragraph, it grows because two places each
correctly state one fact.

### NOT IMPLEMENTED in this pass

- **Compaction / the step-12 resume loop.** Still not reproduced, still not
  instrumented, still not fixed. Nothing is claimed about its cause, and it
  remains a hard blocker on subagent readiness.
- **Verify Contract escalation** (TARGETED → IMPACT → SUBSYSTEM → PROJECT →
  RELEASE). `authority.verifyContract()` is the seam and reports
  `level: UNSPECIFIED` — deliberately not defaulted to TARGETED, which would
  assert a level nothing selected.
- **Worker scope enforcement.** `readScope`/`writeScope`/`dependencyScope` are
  DECLARED and NOT ENFORCED. Nothing refuses a worker that writes outside its
  lane. The code says so in the place somebody would look.
- **Work-order-level stale-baseline rejection.** Per-file staleness is enforced at
  mutation time by `evidence.js`; rejecting a whole proposal is not built.
- **Unified mutation transaction**, proposal→commit boundary, work graph,
  parallelism, OpenRouter. Deliberately untouched.
- **Message inheritance.** `forkSession` still copies the parent's whole
  `messages` array. The brief asks that a worker not receive the entire parent
  session; changing this changes what `/bg` can do and needs its own
  verification, so it was left and is flagged rather than quietly altered.

### Suite

| Tier | Result | Note |
|---|---|---|
| unit | **2731 passed / 2 failed** | from 2696 last pass — +35 assertions |
| integration | **194 passed / 1 failed** | |
| smoke | **527 passed / 10 failed** | 37 min, spawns the real binary |

**No new failure was introduced by this pass or the previous one.** All thirteen
failures were confirmed pre-existing by stashing the work and re-running each
test on a clean tree — including the four that had not been checked before:

| Tier | Test | Cause |
|---|---|---|
| unit | `apiendpoints` | the uncommitted `src/providers.js` z.ai base-URL change — in-flight work that is not this pass's |
| unit | `codemodel` | typo checker flags `sheet` in `tests/integration/cowork-remote.test.js:137` |
| integration | `cowork-remote` | Windows `EPERM` on temp cleanup, full-tier only |
| smoke | `screen-context` | "the feed never drew" |
| smoke | `scrollback` | the view does not start at the bottom |
| smoke | `steermode` | a waiting steer does not reach the model |
| smoke | `trust` | the trust question does not appear |
| smoke | `ratelimit` (×2) | absolute-time reporting, and an unbounded retry |
| smoke | `environment-browser` | a Harness browser does not launch owned |
| smoke | `live-ui` | a finished plan prints DONE in the progress block |
| smoke | `refusal` | a tool that succeeded is marked failed |
| smoke | `research` | the page answer does not reach the model |

The two `RATE LIMIT` cases matter most for honesty: they sit in
`ratelimit.handle()`, which the **previous** pass added code to. Confirmed
identical on a clean tree, so that work did not cause them.

None were repaired. A failing test is evidence, not authorisation to fix whatever
failed — and ten of these are in areas neither pass had any causal connection to.

`quietsurface` passing (6/6) includes *"the work clock is on the row, in
HH:MM:SS, for the whole task"*, driven through a real PTY. That is the first
real-TTY evidence for the timer claim made in the previous pass, which had been
reported there as NOT VERIFIED.

---

---

## Earlier passes

Passes completed before 2026-09-14 are in [docs/STATUS-ARCHIVE.md](STATUS-ARCHIVE.md).
They are kept because a fix is often only intelligible from the defect that
produced it — but several describe code that has since been removed, and none
of it is a statement about the system as it stands.
