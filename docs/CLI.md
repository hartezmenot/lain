# LAIN CLI — runtime and presentation contract (2026-09-18)

LAIN CLI is the quiet, project-aware execution surface: **LOCATE → UNDERSTAND →
ACT → VERIFY → STOP**. It is not an IDE and not a dashboard. Rich visual work
(code highlighting, project browser, visual frontend work, Bot management)
belongs to LAIN Harness; both are clients of the same Core.

Verification labels for every claim below are in `docs/STATUS.md`.

## 1. The screen

```
LAIN · toradb · glm-5                                  RUNNING · 04:18 · 3/7   12.4K
USER · fix retry ownership
────
Tracing scheduler → queue ownership.

┌ ACTIVITY ───────────────────────────────┐        (only while a turn works)
│ READING · src/scheduler · 3 files       │
└─────────────────────────────────────────┘
◐ Receiving                                                           00:04:18
 Ask LAIN…
```

and once the turn has finished:

```
CHANGE
│ ✓ scheduler.ts   +18 -7   [Diff]
VERIFY
│ ✓ npm test -- retry
RESULT
Retry scheduling now has one owner.
```

* **Header** (`src/ui/headerstate.js`): project · model, then the run state —
  `RUNNING · elapsed · step/total` from the live plan's durable steps, the
  execution mode (always shown when idle), `FOCUS`, the profile (`FAST`/`ECO`;
  NORMAL shows nothing), `AGENTS N` only while subagents run, and output tokens.
  No ETA is ever shown. `PLAN · discussing` replaces any step count while the
  plan is being discussed.
* **ACTIVITY box** (`src/ui/activitybox.js`): READING, LOCATING, THINKING,
  WRITING, EXECUTING, TESTING, VERIFYING, WAITING, BACKGROUND, BLOCKED — derived
  only from runtime facts (phase, tool, targets). It never reads model
  reasoning. Opens only while useful, closes the instant the turn ends, never
  enters the transcript. **Ctrl+O** expands/collapses it.
* **Finished turns** (`src/ui/turnsections.js`): a turn that changed or checked
  something is drawn CHANGE → VERIFY → RESULT; reads are not listed; a purely
  conversational turn is drawn as before.
* **Diff** (`src/ui/difftoggle.js`): `[Diff]` expands the file's real hunks
  under its row and scrolls to them. Clicking it again (`[× Diff]`) or **Esc**
  removes the rows and restores the exact prior scroll position and
  bottom-follow state. It is never "scroll up".
  - **The turn in flight has one too.** The latest live edit row of each file
    carries a `[Diff]` in place; the live account stays interleaved. It is
    keyed as the settled CHANGE row will be (turn index + path), so a Diff
    opened mid-turn is still open after DONE and stays reopenable afterwards.
    Several edits of one file update one Diff.
  - Its lifetime is the turn's. It does not follow the edit-reel animation or
    the counters card, which are transient. Before this, the only diff
    mid-turn was the animation, so the Diff "sometimes did not show".
  - While a Diff is open, the ACTIVITY box minimizes to one bare line.
* **HOW TO RUN / HOW TO TEST** (`src/runcheck.js`): a script the report names
  that `package.json` does not define gets a warning on that turn. The report
  itself is not rewritten.
* **References**: `src/foo.ts:84` anywhere on screen is clickable and opens a
  temporary source view at that line (the one panel; Esc closes it).
* **No fake delay**: nothing in the renderer holds the agent; there is no
  minimum tool-card lifetime (`ui/playback.js` `HOLD_MS = 0`); enter/settle
  transitions are presentation only.
* **Auto-compaction** is silent maintenance (`src/compacttip.js`). After a turn
  with high context use, one `TIP · /compact can reduce context usage.` is
  shown, and not again until usage has grown materially.
* **Provider warnings** belong to the selection and the process that observed
  them (`src/ui/projection.js`): a new model/route, a restart or a resume never
  shows an old red rate-limit warning. History keeps the event (dimmed as
  `earlier ·`).

## 2. Modes and preferences

| | |
|---|---|
| **AUTO** | inspect, edit and test within the ordinary permissions |
| **MANUAL** | inspect freely; every mutation/command pauses for a yes (once / this turn / deny) |
| **PLAN** | discuss and refine; any mutation or command is refused at the tool door |

**Shift+Tab** cycles AUTO → MANUAL → PLAN (`src/execmode.js`, enforced in
`tools/index.execute`). `/plan` enters PLAN; `/plan accept` leaves it and
execution begins, only then does step progress appear.

`/focus` is a session preference, never another runtime. It adds guidance on
the framed context tail and never skips required reads, verification or
permissions. Normal mode is already quiet: the model is told acting >
narrating is guidance, not a gag.

**Execution profile** (`src/profile.js`) — orthogonal to AUTO/MANUAL/PLAN and
to FOCUS, persisted with the session, shown in the header (NORMAL shows
nothing). The correctness bar is identical in all three.

| | command | what changes |
|---|---|---|
| **FAST** | `/fast` (`/fast off` → NORMAL) | independent leading reads run concurrently (up to 4), disjoint subagents allowed, context budget ×1.6 |
| **NORMAL** | `/normal` | default; main agent first, reads concurrency 2 |
| **ECO** | `/slow` (`/eco` alias) | token economy: serial (concurrency 1), no subagents/A-B unless you ask, context budget ×0.5, batch cheap lookups, fix all failures before one re-run |

Measured live (2026-09-19, `kr/claude-sonnet-4.5`, same task and fixture):
per-request input size was the same in all three (26–29k tokens), so cost is
driven by the number of round trips and by how much the model chose to fix,
not by the profile. FAST was observed issuing up to 4 calls per step, with the
reads prefetched concurrently. ECO showed **no measurable token saving** on
this small fixture: 346k tokens when it fixed three bugs one cycle at a time,
198k when it fixed only the one that was asked. FAST never forces
parallelism.

**Final smoke** (`src/finalsmoke.js`). For implementation work, the project's
smoke suite (else its primary suite) is the terminal plan step. A mutation
after it resets it. Completion needs it PASSED after the last change, or the
strip says NOT VERIFIED. A failing smoke reopens only the step whose files the
failure names, then that step's targeted test, then the smoke again. A smoke
sent to the background with `/bg` keeps its PID; the task stays NOT DONE until
it settles, and a failure continues the task automatically.

**Completion is four facts, not one**: RESPONSE_ENDED (the provider's finish
reason, `src/finish.js`) ≠ TURN_ENDED (`src/turn.js`) ≠ TASK_COMPLETE
(`lifecycle.complete`) ≠ TASK_VERIFIED (final smoke). A MAX_TOKENS cut is
resumed once, then CUT OFF. A safety finish is MODEL REFUSED. Malformed
tool-call JSON is reported and never run as `{}`. An empty 200 is retried once
and then fails. A stream that goes silent mid-reply (180 s) keeps its text and
is resumed up to twice, then ends as STREAM STALLED.

**Rate limits** (`src/errors.js`, `src/ratelimit.js`). A stated reset
(duration, clock time, epoch, weekday, up to 14 days) is honoured exactly:
- The route/model is unavailable until then, with zero premature requests.
- The strip says `RATE LIMITED · <model> · reset in 42m · 18:04` (or DAILY
  LIMIT / WEEKLY LIMIT with the day), and asks **Wait** or **Change model**.
- Waiting does not freeze LAIN: commands work while it waits.
- The state clears on recovery and leaves no durable note.

An unknown reset gets bounded backoff.

## 3. Reading less without understanding less

Before re-reading, LAIN reuses what it already holds: the evidence ledger and
read receipts serve an unchanged file — **only when that file's body is still
on the wire the model is sent** (`toolstep.bodyOnWire`). After `/clear`, after
compaction elided it, or when it was read in another view's thread, the read
runs for real. (This closed a live reread loop, 2026-09-18.)

**An elided read is not a successful read** (`src/readcoverage.js`). A whole
`read_file` whose previous whole read was elided (same size+mtime), or whose
file is over 0.35× the context budget, is narrowed before it runs: an outline
of declarations plus the first lines. The first time says so once —
`BLOCKAGE · … / ADAPTED · …` — and the work continues; blockage is not a stop.
The compaction stub for a body read says to re-read only a range or one
symbol, never the whole file again.

**Coverage, not "read".** The evidence ledger records the ranges actually
returned. The handover digest says `CONFIRMED READ (ranges…)` and
`NOT ESTABLISHED — …` for what was elided, so a model switch after a rate
limit carries what is known, not what was requested.

**Zero results are classified** (`tools/search.js zeroResult`):
`NO_FILES_IN_SCOPE` (nothing was searched — an rg "No files were searched"
is not an error and not "no match"), `PARTIAL_NO_MATCH` (files were skipped),
`SEARCHED_FILES_NO_MATCH`. An rg exit 1 is only "no match".

**One current intent** (`src/intent.js`). Equivalent steers and repeated
requests collapse into one `CURRENT INTENT` with their deltas kept as
constraints; a newer correction that flips polarity wins. On the wire,
repeated middle user messages fold to a framed pointer (first and last are
never touched). The handover carries state; working narration ("Let me…",
"Now I'll…") is not promoted into it.

## 4. Hidden wake-up

An execution turn (implementation, direct tool task, diagnostic) whose whole
reply is prose — no tool call, no change, no question, no stated blocker —
gets **one** continuation with a structural note on the framed
`<lain-context>` tail (`src/wakeup.js`). Never a user message, never in the
transcript, never a new turn, never touching the clock. A second idle reply
ends the turn as `no-progress`, drawn **BLOCKED**.

## 5. `/bg` — detach what blocks the foreground

`/bg` does not start another implementation agent (`src/bgdetach.js`):

* a running foreground **process** (tests, build, download, dev server) keeps
  its PID and becomes background job #N; the waiting tool call returns at once;
* with no process, a **thinking turn** is stopped and a bounded read-only
  branch continues with only the objective, the plan step, evidence refs and
  the project — never the conversation.

On completion: `BG COMPLETE · <what> · <result>` (test counts when the runner
stated them), the result is recorded on the original session/turn/plan step,
delivered to the model on its next request, and announced to Telegram. Jobs
expose id, session, task, plan step, kind, state (RUNNING / WAITING / DONE /
FAILED / CANCELLED), elapsed, result and ownership scope.

**Ownership** (`src/leases.js`): a job or subagent that owns files holds a
write lease; anything else writing them is refused (`DENIED LEASED`),
independent files are free.

## 6. Subagents — bounded, never copies of the main agent

`delegate` (`src/subagents.js`, `src/tools/delegate.js`). Every subagent has a
contract: **role, objective, readScope, writeScope, owned files, expected
output, verification, parent task, completion condition**. It runs in a fresh
session with only its brief, under a bounded work order enforced at the tool
door, with a write lease.

| Role | Writes | Commands |
|---|---|---|
| SCOUT | no | no |
| FOUNDATION | its scope | yes |
| IMPLEMENTER | its scope | yes |
| VERIFIER | no | yes |
| RESEARCHER | no | no |

* **parallel** only with disjoint write scopes; **pipeline** runs stages in
  order, each handed the earlier outputs (SCOUT → FOUNDATION → IMPLEMENTER →
  VERIFIER).
* The main agent is the integrator; a subagent cannot delegate.
* Model-neutral: a contract may name any catalog model (OpenRouter included);
  there is no provider-specific orchestration. Sakana Fugu: **absent**.
* Subagents request Browser/Computer only through the same permission system.
* **`/subagents auto|off|max N`**: AUTO (default) lets the model delegate
  when the work partitions; OFF refuses `delegate`/`ab_compare`. `max N` caps
  concurrent workers (1–8, default 3). ECO refuses delegation unless you ask
  for it.
* Visible without a dashboard:
  - `AGENTS N` appears in the header and activity only while workers run,
    counted from the job registry;
  - `AGENT COMPLETE · Role · …` / `AGENT FAILED` is a transient note.
* A worker whose turn did not end naturally counts as **FAILED**: a provider
  failure, a stall, a rate limit, a no-progress stop, or a stated blocker.
  Its changes are still reported.
* The report names completed / failed / **not run** stages, with a HANDOFF
  line for the main agent.

## 7. A/B candidates

`ab_compare` (`src/abtest.js`): two candidates in detached git worktrees
seeded from the exact working state (no ref, branch or stash created), one
verification command for both, deterministic selection (pass > fail, then a
materially smaller change, then materially faster), integration of the winner,
verification on the canonical tree (reverted if it fails), then every worktree
removed. The person is asked only when the evidence does not decide. One small
record survives on the session: `Selected B — …`.

## 8. Browser and Computer

`/browser` is the front door (`/chrome` is a hidden alias). `src/browserrouter.js`
chooses the backend: the person's **Chrome** (LAIN for Chrome extension), the
**Frontend Workshop** dev server, or an **isolated** Browser Harness. Evidence
is one shape: title, URL, semantic DOM, console, network errors, viewport.

The model may ask for stronger evidence with `request_browser` /
`request_computer` `{ reason, target, scope }` (`src/tools/capability.js`):
admission → permission (**Allow once / Allow session / Deny**, one Core
decision) → the real observation → evidence back to the same turn. A session
grant is not asked again. A denial or an unavailable backend is a real result,
never a silent no-op.

## 9. Permissions that are their own class

`NETWORK_READ` (web_fetch) · `DOWNLOAD_FILE` (`download_file`: source,
filename, size, destination; once / site for the session / deny) ·
`WRITE_PROJECT_FILE` (the trust gate) · `EXECUTE_FILE` (running something that
was downloaded is asked separately — a download never implies execution).

## 10. One pending decision, many surfaces — Telegram and the WebApp

Every question — ask_user, a MANUAL step, a capability, a download, an
external action — is one Core record (`src/decisions.js`): id, session, type,
expiry, nonce, HMAC signature, stored in the LAIN home. The CLI panel, the
Harness and Telegram resolve the same record; the first valid answer wins
(atomic answer file); the others update immediately. Telegram buttons carry
id + signature; a forged or late press changes nothing.

The bot bridge (`src/bot/attention.js`) sends: decisions (with buttons),
BLOCKED, BACKGROUND_COMPLETE, TASK_COMPLETE, FAILED. Routine tool events are
never sent.

The progress **WebApp** (`src/webapp.js`, started by the bot service when
`bot.webapp.enabled`) is read-only: PC status, sessions, jobs, step, needs
input. `POST /auth` accepts only verified Telegram `initData` from an allowed
user and returns a short-lived signed token; `/progress` requires it; there is
no control endpoint. The page resolves its route with `src/connectivity.js`:
parallel short probes, LAN when it answers, else the last working route, else
Tailscale, else ZeroTier, else `OFFLINE · Bot chat only`. Telegram requires
HTTPS for a WebApp: in practice Tailscale's HTTPS (`tailscale serve`) or a
reverse proxy.
- **Endpoint selection is authenticated.** The button URL carries a
  per-install ping key (`k`). `/ping?n=<nonce>` answers `HMAC(k, nonce)`, and
  the page verifies that before sending `initData` anywhere. A server that
  merely answers `{lain:true}` is refused.
- Set `bot.webapp.pageUrl` (the HTTPS address serving the page) and the bot
  status prints the **WebApp button URL**.

## 11. Models

`/model` opens **models** directly ("Search models…"); `free:` `paid:`
`local:` `external:` filter. The website sources (ChatGPT.com,
Gemini.google.com) appear only under `external:` (and `/source`). Access
variants (`-tiered`, `:free`, `:paid`, a single vendor prefix) are routes of
one model, not rows. Removed routers (omniroute, tokenrouter) are pruned from
config, discovery, caches and resolution (`src/retired.js`); a stale selection
reads `Unavailable · provider removed` and is never rerouted. **9router is
supported.**

## 12. Test tiers

`workflow` (implementation, bug fix, hidden wake-up, `/bg` in a real
pseudo-console) → `cli` → `harness` (Harness / native desktop only) →
`global` (cross-surface). `node tests/run.js smoke` runs all four in order.
