# Narrow workers, evidence slices and the recruitment gate (2026-09-23)

**Rule:** the cheapest *reliable* owner wins. Order: deterministic software →
program logic → a narrow local worker → the flagship. A worker is recruited
only for one role, after an evaluation of that role, and only if it
measurably saves flagship work without hurting correctness.

Verification labels for every claim are in `docs/STATUS.md` (2026-09-23 section).

> **2026-09-24, latest (§L):** Violetto is **RETIRED** from the active architecture — every
> Violetto section below (G.2, G.4, H, K.4, K.5) is history. Laya is repositioned as the
> **Harness Context & Perception** engine; its source-file ranking is **OFF and rejected**.
> Geometry and the GUG are Core-owned.

## A. Architecture map: where each concern already lives

A worker layer has to plug into these owners, not duplicate them.

| Concern | Owner today |
|---|---|
| Orchestration (the turn loop, steps, tool calls) | `src/turn.js`, `src/toolstep.js` |
| Request routing / task class | `src/mode.js` (workflow mode, deterministic regex cascade), `src/taskclass.js` (grounding class + surface), `src/identify.js` (task identity) |
| Tool selection | the model, from `src/tools/index.js` schemas; the permission and scope door is `tools/index.execute` + `src/workorderguard.js` |
| Context assembly | `src/promptparts.js` (stable/volatile split), `src/prompt.js`, `src/contextfit.js` (fit + audit), `src/contextauthority.js` (compaction) |
| Project intelligence | AST/symbols `src/codemodel.js` + `src/structure.js`; functional grouping `src/architecture.js`; fingerprints `.lain/fingerprints` (`src/readreceipts.js`); dictionary `src/dictionary.js`; wiring `src/wiring.js`; findings `src/findings.js` |
| Evidence / read receipts | `src/evidence.js` (ledger of what content is on the wire), `src/readreceipts.js` (what was observed, under which version) |
| Handover | `src/handover.js` (built from observed state, not from narration) |
| Browser / Computer evidence | `src/browserrouter.js`, `src/tools/capability.js` (`request_browser` / `request_computer`), `src/tools/computermcp.js` (UIA tree, find, read) |
| Provider normalisation | `src/provider.js` (one funnel, two wire protocols) |
| Project state → model context | `promptparts` (goal, plan digest, handover, runtime facts), the framed `<lain-context>` tail |

**Where worker results can live without polluting the transcript:** as tool
*results* (the Evidence Slice is a `computer` result, so the model reads it
once and it compacts like any tool output), plus `session.workerLedger` for
metrics. Neither goes into the feed. Durable promotion stays with the owners
that already exist: a verified control identity becomes evidence through
receipts; a geometric invariant would become GUG only after integration.

## B. The worker design (`src/workers.js`)

LAIN coordinates. Workers never talk to each other or call themselves, and no
code path in `workers.js` reaches delegation, turns, plans, permissions,
profiles, modes or the goal (the unit test greps for these).

| Worker | Contract | Tier in place | Model |
|---|---|---|---|
| **JEV** | `decision_intent`: *what kind of bounded request is this?* CHAT / EXPLAIN / AUDIT / FIX / CHANGE, or ABSTAIN | deterministic: `mode.js` | **not recruited**: gate FAIL (below) |
| **LAYA** | `evidence_narrower`: *where exactly is the relevant thing?* relevance filtering, region selection, candidate ranking | **deterministic: `src/evidenceslice.js`, in production** | not recruited (no model tier needed yet) |
| **VIOLETTO** | `geometry_solver`: numeric consequences of a geometric change (ratios, alignment, constraints) | **not built** | not available: no Violetto model on this machine, and no GUG to feed it |

Every contract states: owns, forbidden, input, output, escalate_when.

**Decision cascade** (`workers.decide`):

```
deterministic ──certain──▶ result
     │ uncertain
     ▼
recruited model? ──no──▶ deterministic default
     │ yes
     ▼
ONE inference ──label──▶ result
     │ ABSTAIN / prose / error
     ▼
escalate: the deterministic default, marked escalated (the flagship decides later)
```

- One input, one inference, one result. There is no "ask again".
- Results are cached by (decision type, state fingerprint, candidate hash).
- The packet is a tiny projection, capped at 900 chars. It never contains
  conversation context or files.
- Negative equivalences are enforced by construction: a worker result is never
  a user message, a steer, a plan step, permission, verification or DONE.

## C. The Evidence Slice (Laya's deterministic tier, in production)

`computer {op:"ui_tree", focus:"network mode"}` returns:

```
EVIDENCE SLICE · ui_tree · focus "network mode dropdown" · deterministic (evidence_narrower)
target: Settings · region 1640,88 300×24
matched 1 of 423 node(s) (1 weaker matches omitted) · confidence 0.9
  Window  "Settings"
    Pane  "Network"                         ← path, not a match
▸     ComboBox  "Network mode"  #NetworkMode  300×24 at 1640,88  = "Auto"
raw: receipt ev_a969ac70f8 (423 nodes, 22330 chars) — computer {op:"expand", receipt:"ev_…"} …
```

The source priority is the spec's: native structure (UIA) first, then
programmatic bounds, then scoring on the model's own stated focus. No
screenshot, no OCR.

- **Raw evidence stays recoverable.** The whole tree is stored under the
  receipt (`<LAIN home>/evidence/<session>/`). `expand` pages it in 200-row
  pages, or re-slices it for another `query`.
- **False narrowing is measured.** An `expand` of a sliced receipt is charged
  as `reread` against that slice in the ledger, and "tokens avoided"
  subtracts it.
- **No match abstains.** Nothing is guessed.
- **A defect closed on the way:** a long `ui_tree` used to stop at 200 rows
  and silently drop the rest. It now keeps the whole tree under a receipt and
  says how many rows it held back.

Measured on a 423-node settings window: **22,330 → 640 chars (×34.9),
~5,400 flagship tokens avoided on one observation**, with zero re-reads for
that focus (unit fixture). It has not been measured on a live desktop session.

## D. The recruitment gate (`bench/workergate`)

`node bench/workergate/run.js <baseUrl> <model>` runs a labelled set of 60
real-phrased requests through the real cascade. The model is consulted only
where `mode.js` fell through to its default rule. PASS requires all four:

1. at least +15 points on the uncertain cases;
2. no more than 20% wrong when it answers (it must know when to abstain);
3. median latency ≤ 2 s;
4. no overall loss.

| Run | Deterministic | Cascade | Uncertain cases | Wrong when answering | Median | Gate |
|---|---|---|---|---|---|---|
| rules as found | 72% (80% when certain) | — | 50% (n=16) | — | — | — |
| + local Qwen3-VL-4B (llama-server :8080) | 72% | 80% | 50% → 81% | 21% | 321 ms | **FAIL** (criterion 2) |
| rules after the fixes below | 83% (91% when certain) | — | 57% (n=14) | — | — | — |
| + local Qwen3-VL-4B | 83% | 88% | 57% → 79% | 25% | 225 ms | **FAIL** (criterion 2) |

**What the evaluation actually bought** is a deterministic fix, which is the
cheaper owner. "thanks, that worked", "what did you change" and "show me the
plan" fell to IMPLEMENT, and a prose answer then drew the hidden wake-up and a
BLOCKED ending. Yes/no judgements ("is the retry logic correct?") were
EXPLAIN instead of AUDIT. Three narrow rules in `mode.js` fixed these (with
regressions).

**Caveat:** the set was used both to find these gaps and to score the fix, so
the post-fix 83% is optimistic. A held-out set is needed before quoting it as
accuracy.

**Jev itself** exists as `jev-1.13-free` / `jev-1.13` on OpenCode Zen (and via
9router `oczen/`). The free tier refuses non-OpenCode clients (`403
FreeTierError: OpenCode's free tier can only be used from within OpenCode`).
The paid model needs Zen balance (`402 Insufficient account funds`). It was
not evaluable on this machine. **Laya and Limite Violetto 1B** are not
installed and not listed by any configured route.

## E. Deliberately not implemented

- Wiring any model into `mode.js`: nothing passed the gate.
- A Laya model tier: the deterministic slice abstains honestly, and there is
  no evaluation yet showing a model re-ranker beats `expand` + a refined focus.
- GUG / Violetto: no model, and no geometric representation exists to feed
  one. Building GUG speculatively would create a second source of truth next
  to the Workshop's live DOM measurements. It belongs to the Harness
  frontend work, recruited by demonstrated need.
- Future specialists (AST narrowing, test-failure triage, log reduction,
  diff classification): each needs its own contract and gate run first.

> **Superseded in part by §G (same day, later).** Laya and Violetto are now
> installed from the local model store and evaluated there. Jev is formally
> EXCLUDED.

## F. Rollout, when a model passes

1. Run the gate for that contract and keep `bench/workergate/out/<model>.json`.
2. Record the binding in `cfg.workers.<contract> = { model, connection, gate }`.
   `workers.binding` refuses a binding whose gate did not pass.
3. Call `workers.decide` from the owner (for intent: `identify.js`, only on the
   default branch).
4. Watch `/workers`: compression, abstain rate, re-reads, tokens avoided.

## G. Specialist lab: Laya, Violetto, Jev (2026-09-23)

Specialists are **optional capabilities**. Each one is installed or not, and
switched `auto`, `on` or `off`. Normal work never names one. Policy
(`src/workerruntime.js` `uses`) lets a specialist serve a use only when:

- it is installed from the local model store;
- it is not switched off; and
- its recorded gate for that use PASSED.

`on` forces it anyway, for experiments. `/workers` is the diagnostic surface:
`status`, `auto`, `off`, and `laya auto|on|off`. Jev cannot be switched on.

Specialists never call each other or themselves. Each request is bounded (one
request, a timeout, no retry), and an unusable worker answers `null`, never
throws. The locate shortlist is the tail section `# Likely relevant files`:

- it is a suggestion, never a fence;
- it is computed once per turn;
- its false narrowing is measured at turn close (`locateassist.settleRecord`).

Weights and runtimes live outside every repository (`docs/LAYOUT.md`).
`workers/manifest.json` holds identity, gate results and the verdict.

### G.1 Laya (convaiinnovations/laya 0.3.6, ModernBERT-large, 421M, CPU)

Adapter: `workers/laya/server.py`, a warm JSON-lines process with an
embedding cache. It runs offline. Costs measured on this machine:

- load: 40 s;
- first embedding of 451 files: 75 s;
- warm ranking: about 170 ms (cosine) or about 600 ms (choice head).

**File gate** (`bench/specialist-workers/locate/gate.js`): 451 LAIN source
files, 24 hand-labelled "where is X" queries. Half share words with the
target; half are paraphrases that share none, which is the case a semantic
model should win.

| Ranker | hit@1 | hit@5 | hit@8 | MRR | hit@8 on paraphrases |
|---|---|---|---|---|---|
| lexical (`locateassist.lexical`) | 0.458 | 0.667 | 0.708 | 0.560 | 0.500 |
| Laya, cosine only | 0 | 0.083 | 0.083 | 0.043 | 0 |
| Laya, shortlist + choice head | 0.083 | 0.083 | 0.083 | 0.083 | 0 |
| lexical ⊕ Laya (reciprocal rank) | 0.417 | 0.625 | 0.667 | 0.490 | 0.417 |

The choice head put p ≥ 0.5 on a wrong file in 13 of 24 queries: confident
false narrowing. Fusing Laya in makes the shortlist worse. **FAIL.**

**UI-control gate** (`ui-gate.js`): the 41 interactive controls of the
Harness page, 20 queries phrased by what a control does.

| Ranker | hit@1 | hit@5 | MRR |
|---|---|---|---|
| lexical | 0.35 | 0.35 | 0.35 |
| Laya, cosine | 0.10 | 0.25 | 0.18 |
| Laya, choice (11 of 20 confidently wrong) | 0.25 | 0.25 | 0.27 |
| lexical ⊕ Laya | 0.35 | 0.45 | 0.37 |

+2 of 20 at hit@5 and nothing at hit@1 is not evidence. **FAIL
(inconclusive).**

**Verdict: REJECT** for evidence narrowing. Laya stays installed, and `auto`
uses it nowhere. The A/B (§G.4) forces it on to measure what it does
end to end.

### G.2 Limite 1B Violetto (Q4_K_M GGUF, patched llama.cpp, CPU) — RETIRED 2026-09-24 (§L)

Built from `ggml-org/llama.cpp@58367713` + `limite.patch` with MSVC. The GGUF
SHA-256 was verified. Generation runs at about 32 tokens/s.

**Geometry eval** (`bench/specialist-workers/geometry/run.js`): six UI
changes, such as resizing and keeping a square centred with an inset, or
growing while staying centred. Each is scored against a minimal deterministic
Geometric UI Graph solver (`geometry/gug.js`, about 40 lines), with ±0.5 px
tolerance.

| | Correct | Median time | Tokens per answer |
|---|---|---|---|
| deterministic GUG | 6/6 | < 0.2 ms | 0 |
| Violetto | 3/6 | 228 s | 6,000 (every answer hit the length cap) |

The one transport error (case 3) was re-run alone and was still wrong.
**Verdict: REJECT.** The deterministic solver answers exactly, and GUG did not
earn a place in LAIN either. The fixture's geometry defects are CSS-box
arithmetic that the browser measures directly: the one real trap is that a
1 px border counts inside a 12 px inset. Not wired.

### G.3 Jev: EXCLUDED

Official Jev (TypeSafe `jev-1.13`) is hosted and proprietary, with no local
weights. On this machine:

- the free tier refuses non-OpenCode clients (`403 FreeTierError`);
- the paid route had no funds (`402`).

No substitute was presented as Jev. Laya's authors describe it as an open
reproduction of Jev, and it was evaluated here as Laya.

### G.4 End to end: CONTROL vs specialists (`bench/specialist-workers/ab.js`)

**The fixture** (`bench/specialist-workers/fixture`, "TeamDesk"): a Vite
frontend and a small Node API, 32 files including distractors. The defects:

- UI slop: emoji, a gradient hero, hype copy, off-token spacing, a shouty
  button;
- geometry: the send button and the avatar;
- stale settings cache;
- snake_case → camelCase mapping;
- retry-on-4xx and a save race;
- noisy logs that print passwords;
- a wrong login route that accepts any password.

**The checks** are hidden: `acceptance/unit.test.mjs` (7) and
`acceptance/browser.mjs` (17, in real Edge through playwright-core, which also
runs the final smoke). The suite was validated against a reference solution
(`reference/`, 24/24 with the smoke passing) and the untouched fixture (5/24,
smoke failing).

**The protocol:**

- every run gets a byte-verified fresh copy (`reset.js`) outside the repo;
- every run gets a fresh isolated LAIN home and the real binary (`lain -p`);
- the model is fixed for the whole A/B, with the same prompt for every arm;
- the code under test is frozen in a snapshot (`snapshot.js`);
- arms are interleaved;
- the runner stops at a hard request budget (`--budget`, default 250).

**Validity:** only runs that the model finished (`stopReason = end`) count.
Runs the provider cut short are kept under `invalid` and re-run, up to 3
attempts per slot.

**What happened (every run is recorded in `out/ab-*.json`):**

1. **`kr/claude-haiku-4.5`, about 75% invalid.**
   - A logging proxy showed 9router answering HTTP 200 with a 0-byte body. It
     does this deterministically for the same request, and replaying that
     request gives the same result.
   - It depends on content, not on size or message count: a shorter system
     prompt or first message made the same request pass.
   - LAIN reports it correctly ("the provider returned an empty response"):
     one retry, then it stops with the session intact.
   - Choosing only the surviving runs would bias the comparison, so the haiku
     data is not used for the verdict.
2. **`gemini/gemini-3.8-flash`**: 503 "high demand", so no valid run.
3. **`kr/claude-sonnet-4.5`** answered the request haiku emptied, so the A/B
   was re-run on it. It stopped after 4 valid runs, when the Kiro account hit
   `402 MONTHLY_REQUEST_COUNT`. **The benchmark spent about 510 Kiro requests
   and used up that month's quota.** The request budget above exists because
   of this.

**Valid runs, sonnet** (plus one control trial run with identical protocol,
`ab-…-sonnet-trial.json`):

| Arm | Runs | Requests | Input tokens | Tool calls | Explore before 1st edit | Acceptance | Smoke | Wall |
|---|---|---|---|---|---|---|---|---|
| CONTROL (trial) | 1 | 25 | 898,629 | 62 | 14 | 19/24 | ✓ | 224 s |
| CONTROL | 2 | 31 · 18 | 1,121,613 · 645,556 | 54 · 51 | 18 · 17 | 22 · 20 /24 | ✓ ✓ | 464 · 312 s |
| lexical shortlist | 1 | 25 | 912,386 | 61 | 15 | 21/24 | ✓ | 388 s |
| Laya forced on | 1 | 22 | 765,667 | 45 | 18 | 21/24 | ✓ | 354 s (32 s of it waiting for Laya to load) |

**Shortlist quality on the fixture:**

| Shortlist | Files named that the run later used | Missed |
|---|---|---|
| lexical | 6 of 13 | `index.html`, `server/routes.js`, `server/store.js`, `src/styles.css`, and more |
| Laya | 5 of 14 | its top pick was `server/ratelimit.js`, an unrelated distractor |

**Reading:**

- CONTROL alone spans 18–31 requests and 646K–1.12M input tokens.
- The single lexical run and the single Laya run both fall inside that spread.
- Exploration before the first edit did not drop.
- Acceptance is 19–22 in every arm.
- **No saving is claimed.**

The recruitment rule was amended *after* reading this A/B, and says so in the
report: a benefit now needs n ≥ 3 valid runs per arm, with the arm's median
outside CONTROL's own range.

**Verdicts** (`out/WORKER_RECRUITMENT_REPORT-*.json`, from
`bench/specialist-workers/report.js`):

- **Laya: REJECT.** Both gates failed, the A/B is INCONCLUSIVE, and it
  narrows worse than lexical.
- **Violetto: REJECT.**
- **Jev: REJECT (EXCLUDED).**

**Consequence for LAIN:**

- The deterministic file shortlist is kept, but **opt-in**
  (`/workers locate on`, `cfg.workers.locate`, `LAIN_LOCATE=on`), because no
  saving was measured.
- **Default LAIN is CONTROL.**
- Laya stays installed. `auto` uses it nowhere, and it can be forced on for
  experiments.

**To finish the A/B:**

- run it on a route with quota, with `--reps 3` or more and `--budget` set
  deliberately;
- estimate the cost first: about 25–30 requests per run.

**Fixture change after the recorded runs:** `data/settings.json` was renamed
to `data/workspace.json` with identical content. LAIN's own
duplicate-source-of-truth check flagged the generic name against unrelated
test literals. Recorded runs used the old name.

## H. Second experiment: cleanup, caches, token pools, v2 A/B (2026-09-23, later)

### H.1 What changed for the experiment

**Violetto is wired, behind a switch.**
- A managed `llama-server` runtime (`workerruntime.js`: spawn, health wait,
  loopback calls).
- The `geometry_specialist` tool (`src/tools/geometry.js`) is offered only when
  Violetto is forced on. `auto` never offers it: its gate failed.

**A result cache in LAIN (`workerruntime.call` `cacheKey`).**
- It is keyed by the state fingerprint: the question plus the exact item
  listing for Laya, the problem text for Violetto.
- A hit costs zero inference. A changed state is a new key.

**Measurement, per worker, kept apart from the flagship.**
- Recorded: cold load, resident memory (the whole process tree), the first
  project embedding, warm inference times, tokens (Laya counted with its own
  tokenizer), cache hits and misses.
- Kept on the session (`session.workerStats`).

**Fixture v2.** Added defects: fake metrics and pills, a card inside a card,
oversized radii, 36 px control heights, symmetric composer margins, and a
375 px sideways scroll. **31 hidden checks.** The reference solution scores
31/31 with the smoke passing; the untouched fixture scores 5/31.

**A/B runner v2 (`ab.js`).**
- A per-arm budget (40) and a global budget (120).
- LAIN's own step cap holds each run under its arm budget.
- No retries. A route failure or rate limit stops the whole benchmark.
- A route-consistency check on every request.
- `--mock` checks the plumbing with zero quota.

### H.2 The three caches (`cache/run.js`, `out/cache-*.json`)

| | Laya | Violetto |
|---|---|---|
| **B · residency**: cold load to ready | 30 s (OS cache warm) · 77–81 s (cold disk) | 12.7 s |
| resident memory (process tree) | 1,984 MB | 1,431 MB |
| first inference | 2.75 s (embeds the 31-file project once, 680 tokens) | 221 s, 6,000 tokens (length cap) |
| warm inference | 151–233 ms (only the query is embedded) | 226–228 s, 6,000 tokens each |
| **C · result cache**: identical state | hit · **0 inferences** · 4.8 µs lookup | hit · **0 inferences** · 4.2 µs lookup |
| changed state (new file / new inset) | re-evaluated (1 inference) | re-evaluated (1 inference) |

**A · the flagship provider's prompt cache** is reported only where the
provider reports it. Through 9router, Kiro returned no cache-read or
cache-write figures on any request, so "cached input" is **not reported**,
which is different from zero.

Violetto's answers in this bench were unusable as final lines: every answer
ran into the 6,000-token cap mid-reasoning, and one misread "40 px wide" as
64.

### H.3 The A/B: `kr/claude-sonnet-4.5`, one run per arm, EXPLORATORY

**Setup:**
- effort unset for every arm;
- budget 40 per arm / 120 global;
- **49 requests spent**: 1 probe + 16 + 8 + 24;
- every run VALID (finished, one route).

| Arm | Flagship calls | Input | Output | Tool calls | Test runs · browser | Acceptance | Wall |
|---|---|---|---|---|---|---|---|
| CONTROL (production) | 16 | 571,659 | 3,575 | 46 | 2 · 1 | 27/31 ✓ smoke | 394 s |
| LAYA forced | 8 | 256,430 | 2,410 | 23 | **0 · 0** | 28/31 ✓ smoke | 270 s (85 s of it waiting for Laya to load) |
| VIOLETTO forced | 24 | 919,254 | 5,481 | 44 | 3 · 1 | 28/31 ✓ smoke | 566 s |
| LAYA + VIOLETTO | not run | | | | | | |

Per-call average input was 35.7K / 32.1K / 38.3K; peak context was
41.8K / 36.8K / 45.4K.

**Laya, as the worker:**
- 1 ranking over 31 files, 447 ms warm, 151 tokens in;
- cold load 77 s, plus 5.1 s for the first project embedding.

**Compression:**

| Stage | Chars |
|---|---|
| raw evidence | 2,227 |
| Laya input | 2,795 |
| slice | 118 |
| packet to the flagship | 290 |

**False narrowing:** the slice named 3 of the 10 files the run used. 7 reads
(10,402 chars) went to files it missed, including `index.html`,
`src/styles.css` and `server/store.js`.

**Decision quality:** the Laya run's lower cost is not attributable to Laya.
The flagship read the files it needed regardless of the slice, and it
**skipped verification entirely**: no test run, no dev server, no browser
check. CONTROL and VIOLETTO did all three. One run each cannot separate that
from ordinary model variance (earlier CONTROL runs on the v1 task spanned
18–31 calls).

**Violetto:**
- offered, and **never called**: the flagship solved the geometry itself.
- The arm paid only costs: a 11.6 s cold load, 1.43 GB resident, and the
  701-char tool schema on every request (about 4.2K input tokens over 24
  calls).
- Its higher flagship usage is within model variance, not a Violetto effect.

**LAYA + VIOLETTO: not run.** No Laya → Violetto handoff can happen when the
flagship does not use the geometry tool. The runner was stopped before the
arm's first flagship request, so it spent 0 requests.

### H.4 Verdicts (`out/WORKER_RECRUITMENT_REPORT-*.json`)

- **Laya: REJECT** for automatic use. Both gates failed, and the A/B is
  EXPLORATORY (n=1). It stays forcible for experiments.
- **Violetto: REJECT.** Wrong or unusable where it answers, slower than the
  flagship by orders of magnitude, and unused when offered. A deterministic
  solver does the job exactly.
- **Jev: EXCLUDED.**
- **Default LAIN = CONTROL.** Specialists are off for normal work, the
  shortlist is opt-in, and the geometry tool is not offered.

## I. Hot-idle worker host, Ollama Cloud route, A/B v3 (2026-09-23)

### I.1 The worker host (`src/workerhost.js`, `src/workerhostmain.js`)

Laya now lives in a **detached worker host** that LAIN owns, not inside the
LAIN process:

```
LAIN (CLI / Core) ──named pipe──▶ worker host ──stdin/stdout──▶ Laya (python, ModernBERT)
                                             └──loopback http──▶ Violetto (llama-server), only when forced on
```

- **One host per LAIN home.** The pipe name derives from the host directory
  (`LAIN_WORKERHOST_DIR`, else `<LAIN home>/workerhost`). A second host
  cannot listen on the pipe, so it exits.
- **No network port of its own.** Laya is ONNX-free: the only Laya
  implementation on this machine is the Python adapter, so the host speaks
  its JSON-lines protocol. llama.cpp is not involved for Laya.
- **States:** `UNLOADED → LOADING → HOT_IDLE ⇄ INFERENCING`, plus `FAILED`
  and `UNLOADING`. HOT_IDLE is memory held, with zero inference tokens.
- **Startup is asynchronous.** `locateassist.prewarm` asks the host to load,
  and returns at once. It runs no inference and no project embedding.
- **The FAST rule** (`workerruntime.call`). A worker that is LOADING gets
  `AVAILABLE_WITHIN_MS` (100 ms) and is otherwise **bypassed** for that
  decision. UNLOADED, FAILED or an unreachable host is bypassed at once, and a
  load is started for the next decision. A warm Laya ranking has a 2 s
  deadline (about 3× the slowest measured warm ranking). A request past it is
  dropped by the caller and finishes inside the worker. The old 90 s
  "wait for Laya" in `locateassist.take` is gone.
- **Lifecycle policy.** Leases are the pids of live LAIN clients. A grace
  window after the last client = max(2 min, 3 × the slowest measured load).
  Memory pressure (free < 1024 MB) unloads a HOT_IDLE worker and refuses new
  loads. Idle unload while clients are alive is off unless configured, because
  no measurement supports a TTL yet. A dead worker is FAILED, with at most 3
  restarts in 10 minutes, each triggered by a later request, never by the
  host itself.
- **Violetto is not prewarmed** in normal LAIN. It is off, and the host loads
  it only when a person forces it on.
- `/workers` shows the host: state, load time, resident MB, inferences,
  reloads and idle time. `/workers off` and `/workers laya off` unload the
  worker in the host. `LAIN_WORKERHOST=off` restores the in-process lifetime,
  with the same bypass rule.

### I.2 Hot-idle acceptance (`bench/specialist-workers/hotidle.js`, real model, real terminal, mock flagship)

`out/hotidle-2026-09-23T12-21-58.json`:

| Test | Result |
|---|---|
| §52 cold start | Prompt usable at **3.2 s**, the same as with Laya off (3.21 vs 3.21 s). Laya LOADING at 3.6 s, **HOT_IDLE at 30.7 s** (27.2 s load, OS file cache warm; 96 s on a cold disk in the first run) |
| §54 prompt while LOADING | Laya **bypassed in 102 ms** (the availability deadline). The lexical shortlist answered and the turn went on |
| §55 hot mid-session | The first ranking after the load must embed the project (34 items, about 4.4 s). It hit the 2 s deadline and was dropped, finishing inside the worker. The next turn was served by Laya in 739 ms. Nothing was rewound |
| §53 hot prompt, new LAIN process | The model was already hot: submit → Evidence Slice in **7 ms (Laya 5 ms)**, no reload |
| §44 result cache | Same question, same state: **hit, 0 inferences**. After an edit to `server/store.js`: re-evaluated, re-embedding only the one changed line |
| crash | LAIN hard-killed: the model **stays HOT_IDLE** (1 load, 1,999 MB resident) |
| §56 Laya process killed | FAILED. The next `lain -p` finished normally (3.2 s) with bypass `FAILED`; one bounded restart followed |
| §56 whole host killed | The next run finished normally (3.2 s) with bypass `UNAVAILABLE`; a new host started |

Resident memory of a hot Laya is 1,992–1,999 MB (process tree).

### I.3 Ollama Cloud through LainRouter (`bench/specialist-workers/ollama-route.js`)

- **Route:** LainRouter (`127.0.0.1:4570`) → `ollama-cloud · lain` →
  `https://ollama.com/v1`, model id `ollama-cloud/gpt-oss:120b`. On the
  direct API the model is `gpt-oss:120b`; `gpt-oss:120b-cloud` is the local
  Ollama app's name for the same model. Ollama is not installed on this
  machine, so no local bridge or new listener exists.
- **Accounts:** of the four stored keys, `main` returns 401. `lain`, `abd11`
  and `aswaja` answer. Only `lain` is enabled, so the route is pinned to one
  account.
- **Transport:** OpenAI-compatible (LAIN's existing chat sender, no Ollama
  code in LAIN). It reports `prompt_tokens`, `completion_tokens` and
  `prompt_tokens_details.cached_tokens`. Cached tokens are a **subset** of
  prompt tokens (72/48, 14,333/13,952), so uncached = prompt − cached. The
  native API's durations (`load_duration`, `eval_duration`) are **not
  available** on this transport; LAIN measures each request's wall time
  itself.
- `out/ollama-route-2026-09-23T12-10-39.json`, 21 requests:

| Check | Result |
|---|---|
| text | ✓ 84 in / 48 cached / 113 out |
| streaming | ✓ 14 text + 7 reasoning chunks. LAIN liveness went THINKING → STREAMING as data arrived |
| tools (real `lain -p`) | ✓ read_file → result → continuation → correct final answer, 4 requests, `end` |
| large tool arguments | ✓ an 8,279-byte `write_file` argument, file byte-exact (150/150 lines) |
| structured output | ✗ `response_format: json_schema` was **ignored** (markdown came back). LAIN does not use it |
| reasoning effort | ✗ LainRouter refuses `reasoning_effort` for this model (`UNSUPPORTED_REASONING_EFFORT`). Every arm runs the model default |
| subagent | ✓ **SUPPORTED:** a SCOUT child ran and returned its answer. The parent first spent 6 requests learning the delegate contract one missing field per refusal. **Fixed:** `subagents.validate` now names every missing field in one refusal |
| context | gpt-oss:120b is 131,072 tokens. LAIN budgets any chat route at 128,000 with a 4,096 output reservation, so it stays inside the window, and every arm gets the same budget |

- **Latency defect (LainRouter, not LAIN):** every request takes about
  **17 s**, including a request LainRouter itself rejects (15.3 s).
  - 9router's `ollama/gpt-oss:120b` answers in 0.86 s, and ollama.com
    answers `/v1/models` in 0.4 s.
  - Unknown-model and bad-key errors return in under 0.05 s, so the time is
    spent after model resolution, in LainRouter's eligibility/dispatch for
    the ollama-cloud family. All three working accounts show it.
  - Tokens are unaffected. Provider wall time in the A/B includes it.

### I.4 Telemetry changes

- `provider.js` marks each receipt `cacheReported`, and `reqtrace.end`
  records no cache figure when the provider sent none. "Not reported" is
  never 0.
- `reqtrace.sized` adds `messageChars`, `toolSchemaChars` and `tools` to
  each traced request (only under `LAIN_REQTRACE`). This is how an offered
  but uncalled tool's cost is measured: Violetto's schema adds **702 chars
  to every request** that offers it.

### I.5 LAIN defects the gpt-oss runs exposed (fixed before the counted pass)

The first two live passes were stopped and discarded: pass 1 after CONTROL
(38 requests), pass 2 during LAYA (23 requests). Both stopped to fix Core
defects that every arm shares. Fixing them mid-pass would have given the arms
different code.

1. **`grep` include scoping** (`tools/search.js` `inScope`).
   - `{path: "src", include: "src/**/*.js"}` matched nothing, because the
     glob was tested only relative to `path`.
   - The schema's own example is project-relative. CONTROL sent that shape 9
     times in one run and got NO FILES IN SCOPE every time.
   - The glob now matches if either reading of it matches.
2. **An empty closing reply ended a fix turn as a success**
   (`wakeup.decide`). gpt-oss sometimes ends a step with reasoning only: no
   text, no tool call ("Let's inspect src/styles.css."). The untouched
   project's tests had passed at step 5, and that early check excused the
   turn: `end`, nothing changed, nothing said. Now an empty reply on a change
   request gets the one wake-up, and a second one is `no-progress`.
3. **Delegate contract refusals** named one missing field at a time. Found in
   the route acceptance run (6 requests), fixed as described in §I.3.

gpt-oss also calls tools that do not exist (`search`, `print_tree`). LAIN's
error names the real tools. That is model behaviour and is left as is.

After the counted pass (§I.6) two more defects were found and fixed. They
apply to the next pass:

4. **read_file's line-number gutter copied into an edit**
   (`tools/gutter.js`, used by `apply_patch` and `edit_file`).
   - In pass 3, **27 of 27** LAYA-arm patches and 3 of 5 rejected
     LAYA+VIOLETTO patches carried `"    5\t…"`. The LAYA run changed
     nothing in 58 steps.
   - Now, if the text is not in the file, every non-empty line has the
     gutter, and the stripped text is in the file, the edit uses the stripped
     text and says so.
   - Tab-separated data that really contains `1\t…` is matched as written.
   - `edit_file` also no longer lets `$&`, `$'` or `$1` in the new text be
     read as `String.replace` patterns.
5. **A replayed step 0 ranked the shortlist twice** (`locateassist.take`).
   This was a regression from this work's own memo change: a transport retry
   re-runs step 0. The memo is now keyed by the turn (the count of user
   messages), so a retry reuses the slice and a new turn with the same words
   re-ranks. The A/B's leak check now flags only a cache hit on a run's FIRST
   ranking; a later hit is the run's own cache.

### I.6 A/B v3, pass 3 (`out/ab3-2026-09-23T12-51-17.json`): EXPLORATORY, 0 valid runs

- **Setup:**
  - `ollama-cloud/gpt-oss:120b` via LainRouter, one account, reasoning
    effort default;
  - 60 requests per arm (58 steps), global cap 181; **176 spent**;
  - prices: $0.15 / $0.014 / $0.60 per 1M (standard).
- **Every arm is INVALID:** each reached its step budget without finishing,
  and none checked the page in a browser. gpt-oss:120b did not complete the
  eight-problem fixture in 58 steps under any arm.

| | CONTROL | LAYA | LAYA + VIOLETTO |
|---|---|---|---|
| flagship requests | 58 | 59 (1 transport retry) | 58 |
| input tokens | 1,333,412 | 1,384,112 | 1,470,983 |
| cached input | 1,289,504 (96.7%) | 1,319,184 (95.3%) | 1,403,840 (95.4%) |
| uncached input | 43,908 | 64,928 | 67,143 |
| output tokens | 32,753 | 39,272 | 31,716 |
| average / peak input per request | 22,990 / 31,504 | 23,864 / 34,066 | 25,362 / 36,282 |
| cost (USD) | 0.04429 | 0.05177 | 0.04876 |
| provider wall time | 1,186 s | 999 s | 957 s |
| tool schema per request (chars) | 55,837 | 55,837 | 56,539 (+702 Violetto) |
| tool calls · test runs · browser checks | 58 · 3 · 0 | 58 · 1 · 0 | 58 · 2 · 0 |
| patches applied / rejected | 10 / 4 | **0 / 27** (27 with the gutter) | 5 / 5 (3 with the gutter) |
| acceptance · final smoke | 3/25* · ✗ | 5/31 · ✗ | 8/31 · ✓ |

\* `server/auth.js` was left with a syntax error, so the browser suite could
not load the page (25 checks instead of 31).

**Deltas vs CONTROL.** These are invalid runs, recorded as a delta, not a
saving:
- LAYA: input +3.8%, uncached +47.9%, output +19.9%, cost +16.9%.
- LAYA+VIOLETTO: input +10.3%, output −3.2%, cost +10.1%.

These are dominated by the patch-gutter defect (item 4) and by model
variance, not by the workers.

**Laya (local, separate pool):**
- cold load 29.7 s (measured before the task, not inside it);
- project index 31 items, 680 tokens, 2.8 s;
- 2,005 MB resident;
- one warm ranking per run: 499 ms (LAYA) and 487 ms (LAYA+VIOLETTO),
  151 tokens embedded (828 token-equivalents of input), no generated tokens;
- evidence 2,227 → slice 118 chars (packet 290, ×7.7).
- **False narrowing:**
  - the top pick was again the `server/ratelimit.js` distractor;
  - the slice named 3–4 of the 14 files the run used;
  - it missed `server/store.js`, `server/routes.js`, `index.html` and
    `src/styles.css`;
  - the flagship spent 15–18 reads (16–24K chars) on files the slice did not
    name.
- In LAYA+VIOLETTO, Laya was already hot (0.8 s preparation) after the
  embedding memo was cleared. The result cache was empty in every run.

**Violetto (local, separate pool):**
- **AVAILABLE, NOT INVOKED**: the flagship never called `geometry_specialist`;
- cold load 13.7 s, 1,431 MB resident;
- its cost to the flagship was the 702-char schema on all 58 requests, about
  10K input tokens.

**Provider prompt cache:** reported on every request. The cached share was
95–97% in every arm; the slice's extra tail did not break the stable prefix.

**Verdicts unchanged:** Laya REJECT for automatic use, Violetto REJECT,
Jev EXCLUDED. No saving is claimed: 0 valid runs in every arm.

### I.7 Pass 4 (interrupted) and pass 5 (`out/ab3-2026-09-23T14-51-40.json`): EXPLORATORY, 0 valid runs

- **Pass 4** stopped after CONTROL's 44th request.
  - LainRouter was replaced by another process at 14:50:10 UTC (external),
    and the run's retries were all spent in about 30 ms.
  - Cause: `runCli` (shared with the tests) forces 1 ms backoff, and the live
    runner inherited it. `ab.js` now passes `LAIN_BACKOFF_MS=''`, which gives
    LAIN's real schedule. In pass 5 it rode out a `fetch failed` and a
    `terminated`.
- **Pass 5:** same route, same caps, all fixes in. **178/181 requests.**

| | CONTROL | LAYA | LAYA + VIOLETTO |
|---|---|---|---|
| flagship requests (no usage · failed and retried) | 60 (1 · 2) | 58 | 59 (0 · 1) |
| input | 1,295,323 | 1,461,754 | 1,405,216 |
| cached input | 1,235,744 (95.4%) | 1,395,856 (95.5%) | 1,358,352 (96.7%) |
| uncached input | 59,579 | 65,898 | 46,864 |
| output | 25,901 | 46,760 | 40,901 |
| average / peak input per request | 22,725 / 34,952 | 25,203 / 34,989 | 24,228 / 30,985 |
| cost (USD) | 0.04178 | 0.05748 | 0.05059 |
| edits applied / rejected (gutter repaired) | 10 / 2 (0) | 9 / 7 (**4**) | 7 / 8 (0) |
| empty-reply wake-ups | **1** | 0 | 0 |
| test runs · browser checks | 3 · **0** | 2 · **0** | 3 · **0** |
| acceptance · final smoke | 9/31 · ✓ | 16/31 · ✓ | 14/31 · ✓ |
| provider wall time | 883 s | 305 s | 285 s |

- **Every run is INVALID:** it reached its step budget and never checked the
  page in a browser. Across all passes, gpt-oss:120b never reached browser
  verification within 58 steps.
- **Deltas vs CONTROL are recorded, not claimed.** Invalid runs, n = 1:
  - LAYA: input +12.8%, output +80.5%, cost +37.6%.
  - LAYA+VIOLETTO: input +8.5%, uncached −21.3%, output +57.9%, cost +21.1%.
  - LAYA+VIOLETTO vs LAYA: input −3.9%, cost −12.0%.
- **Wall time is not comparable across arms.** The LainRouter process that
  replaced the one I started (from 14:50 UTC) answered in about 5 s per
  request instead of 17 s, so the ~16 s overhead was that process's state,
  not a fixed cost.

**Laya (local, separate pool):**
- cold load **90.8 s** (cold disk, measured before the task);
- 1,985–2,024 MB resident;
- index 31 items / 680 tokens (5.2 s cold, 2.7 s hot);
- one warm ranking per run: 479 ms and 451 ms, 151 tokens embedded;
- slice ×7.7;
- **false narrowing:**
  - top pick `server/ratelimit.js` (a distractor) again;
  - 3 of 15 files the run used were in the slice;
  - 25–27 reads (20–29K chars) went to files it did not name.

**Violetto:** AVAILABLE, **NOT INVOKED** (0 calls). Cold load 11.7 s,
1,431 MB. It cost the flagship its 702-char schema on all 59 requests.

**Across passes 3 and 5**, LAYA's acceptance went 5 → 16 and CONTROL's
3 → 9. That range is the model and the fixes, not the worker: Laya's slice
was the same wrong slice both times, and the flagship read around it.

**Live spend for this whole task:** about 500 Ollama Cloud requests, about
$0.35 at the snapshotted prices. The breakdown:
- route acceptance 21;
- probes about 12;
- passes 42 + 23 + 176 + 45 + 178.

**Verdicts unchanged:** Laya REJECT for automatic use, Violetto REJECT, Jev
EXCLUDED. No saving is claimed: 0 valid runs per arm.


## J. Laya project readiness, persistent project index, GPT-6 Luna A/B (2026-09-24)

### J.1 Why Laya had produced 0 inferences

In the Toralink run (case C, 2026-09-24) Laya was HOT and still answered
nothing. Its adapter's only project memory was an in-process text→vector memo,
and a ranking request embedded every file it had not seen **inside the 2 s task
deadline**. The first ranking of a project was a cold index build (82 files),
it missed the deadline, and lexical fallback answered. The memo also died with
the host, so every new host paid the build again. **Model hot ≠ project ready.**

### J.2 Two readiness axes (`src/layaindex.js`, `src/workerhostmain.js`)

| Axis | States |
|---|---|
| model (unchanged) | UNLOADED · LOADING · HOT_IDLE · INFERENCING · FAILED · UNLOADING |
| project index (new, per project, in the worker host) | ABSENT · BUILDING · READY · STALE_PARTIAL · FAILED |

**Ready for task** = model HOT_IDLE/INFERENCING **and** index READY (or a
STALE_PARTIAL whose refresh is not running) — `layaindex.readyForTask`.
`/workers status` prints both axes per project, the last build (reused /
embedded / removed, time) and the verdict.

- **Attach, not the task.** `locateassist.prewarm` (App start, `/workers laya on`)
  loads the model and asks the host to index the project
  (`workerruntime.indexProject`). The host builds after the model is hot, in
  batches of 16 with progress, and never restarts a build already running.
- **FAST never waits.** A ranking that finds the index BUILDING / REFRESHING, or
  the worker busy with another project, is BYPASSED at once
  (`INDEX_BUILDING`, …); the build carries on and the next task finds it ready.
- **A task's Laya inference is the query.** `rank_project`: the adapter embeds
  the query (new `embed` op), the host scores cosine over the prepared vectors of
  the candidates Core chose. Only candidates whose stored text equals the current
  text are scored; changed files are reported as stale, never ranked on an old
  vector, and a refresh runs after the answer.
- **Persistent, machine-local.** `<LAIN home>/workercache/laya/<project>/`
  (`index.json` + `vectors.f32`), atomic, vouched for by a hash. Never in the
  project: git never sees it and a read-only project stays byte-identical (the
  items come from `projectindex.fresh(root, { persist: false })`).
- **Keying.** Reuse only when the file's content sha1 **and** its embedded text
  are unchanged, and only under the same embedding identity (model + adapter
  schema `laya-embed-v1|max256|unit` + item schema `laya-items-v2`); anything
  else is re-embedded, a mismatched store is rejected whole. Deleted files leave
  the index. A rename re-embeds (the path is part of the embedded text).
- **Scope.** The project index's own walk, plus: no build output, lockfiles,
  minified bundles, source maps, benchmark `out/`, `.lain/`.

### J.3 Core's candidates first (`src/locateassist.js`)

The candidate universe is deterministic and Laya only re-ranks it:
negated clauses and "Do not:" lists are removed before ranking
(`wakeup.stripNegated`); query term frequency counts; the project's own name is
not a clue; tests / fixtures / docs / config are de-prioritised unless the
request is about them; the layer a request names (frontend → UI-kind files,
backend → files importing a server framework) is favoured; the best files'
real imports are added (one hop); 40 candidates, padded with unscored files
only Laya can promote. On the Toralink brief: truth files in the top 8
1/7 → 3/7, tests in the top 8 4 → 0, truth files among the 40 candidates 7/7.
The slice text says it narrows project evidence only; the request, its
constraints and the requested output are untouched.

### J.4 Measured with the real model (`bench/readonly-diagnostic/laya-index.js`, Toralink copy)

| | Result |
|---|---|
| first build | model load 28.2 s; index 11.4 s after it (99 considered, 82 indexed, 17 excluded; 3,352 Laya tokens; 6 batches; write 3 ms); cache 349 KB; resident 2,021 MB |
| reopen (new host) | model load 27.7 s; **restore 2 ms, 82 reused, 0 embedded**; ready 1 ms after the model |
| task inference | **290–297 ms**, 76 Laya tokens (query only), inside the 2 s deadline |
| one file edited | **1 embedded, 81 reused**, 276 ms |

### J.5 GPT-6 Luna route and the Responses API

`cx/gpt-6-luna` through 9router (Codex subscription) over **`/v1/responses`**:
LAIN gained a Responses adapter (`src/responsesapi.js`, connection
`protocol: 'responses'`) yielding the same events as Chat Completions;
`reasoning.effort` is a request field (`pc.reasoningEffort` ← `cfg.effort`).
Smoke (2 requests): streaming, a `read_file` call, the result continued, usage
with cached and cache-write figures, reasoning tokens. **The route serves effort
`max` whatever is requested** (asked `medium`, receipt `max`; 9router lists
`thinkingEffortSupported: false`), so both arms requested and ran `max`; the
served effort is recorded from the receipt (`usage.effortServed`).
Price snapshot (not in orchestration): developers.openai.com/api/docs/pricing,
gpt-6-luna Standard, short context — input $0.10, cached $0.01, cache writes
$0.125, output $0.50 per 1M tokens.

### J.6 CONTROL vs LAYA (`bench/readonly-diagnostic/compare.js`), n = 1 each

Same pasted Toralink read-only brief, same route/model/effort, fresh hashed
copies. Both runs: `stop=end`, report complete, trace 7/7, **zero project
mutations (`.lain` included)**. LAYA arm VALID: model HOT_IDLE + index READY
before the timed task (prep 11.8 s), 1 Laya call, **1 inference**, tier `laya`.

| GPT-6 Luna | CONTROL | LAYA | Δ |
|---|---|---|---|
| calls | 14 | 17 | +3 (+21%) |
| input | 580,657 | 708,790 | +22.1% |
| cached input | 446,464 | 578,048 | +29.5% |
| uncached input | 134,193 | 130,742 | −2.6% |
| cache writes | 0 | 0 | — |
| output (reasoning) | 33,694 (27,594) | 44,754 (38,717) | +32.8% |
| cost at snapshot | $0.0347 | $0.0412 | +$0.0065 (+18.7%) |
| wall | 11.1 min | 16.3 min | +47% |
| tool calls / read_file / search | 87 / 34 / 44 | 113 / 42 / 66 | +26 / +8 / +22 |
| unique files inspected | 14 | 15 | +1 |

Laya (local, never priced): 297 ms, 76 tokens in, 395 chars out, result cache
0 hit / 1 miss; candidates 40 → slice 8 (compression 24.6×). **False
narrowing:** 4 of the 15 files Luna needed were in the slice; it missed
`App.tsx`, `api.ts`, `server/index.ts`, `sources.ts`; 36 of 42 reads (≈14k
tokens, chars/4 estimate) were outside it; 4 slice files were never used.
Laya's own cosines spanned 0.944–0.957 over its top 8 — no discrimination, the
same weakness its file_locate gate recorded. Quality: both reports correct and
source-backed (CONTROL followed the download into the engine, LAYA noted the
Vite proxy hop) — neutral.

**Verdict.** Infrastructure PASS. Observed Laya effect on this task: WORSE
(n = 1, an observation, not a measured saving or loss). Laya remains REJECT for
automatic use; nothing is promoted.

### J.7 Cost of the diagnostic

GPT-6 Luna requests, all via `cx` (Codex subscription): 1 route probe; two
smoke runs — the first (~2 requests) unrecorded because the proxy did not yet
capture `/responses`, the second 2; one CONTROL run lost to the harness's own
30-minute wrapper after 40 requests (no report — INVALID, kept as
`luna-control-invalid`); then CONTROL 14 + LAYA 17. About **76** in all. The
harness now takes `--timeout-min` and has no outer wrapper.


## K. Capabilities do not volunteer; Laya as a live-evidence compiler (2026-09-24, latest)

### K.1 The defect

Capabilities were taking part because they existed. `migration_plan` was
offered on every request, and Core read any change verb plus "to X" as a
migration, so "move the button to the right", "switch the theme to dark" and
"change this button into a lever" all put the migration workflow in front of an
ordinary edit. Laya ranked files whenever the shortlist was on, the flagship saw
Violetto as a tool (`geometry_specialist`), and the slice named its worker
("locate assist · Laya + lexical").

### K.2 Core assigns (`src/dispatch.js`)

Once per input (`identify.js`), Core classifies the request deterministically
(MIGRATION · UI_GEOMETRY · UI_EVIDENCE · TRACE · QUESTION · GENERAL) and names
the owners allowed to take part, cheapest first. The assignment is stored on the
session and appended to `dispatchLedger`. Tools, the prompt and the specialist
hooks read it. None of them decides for itself that it is relevant.
Specialists return their result to Core (`dispatch.job`). No worker module
requires another worker or the migration planner, and a unit test enforces this.

### K.3 migration_plan describes a real state transition

`dispatch.migrationTransition` is eligible only when Core can name the current
representation, owner or contract, the target one, and the boundary between
them:

| Trigger | Example |
|---|---|
| A technology or persistence representation on either side | JSON → SQLite, React → Vue, webpack → vite |
| A versioned contract | "the IPC message schema from v1 to v2" |
| A unit of ownership moving between owners | "the auth module from core to server" |
| A representation replaced by a new system | "local UI geometry tokens with a centralized design-token system" |
| A merge or split of established units | "merge these three agents", "split the repository" |
| The user naming the migration outright | "migrate the tests to the new runner" |

These are never eligible:
- a value target: `8px`, `right`, `dark`, `rem`, a port number;
- a purpose clause: "to read the JSON";
- a UI property change;
- multi-file, complex or merely planned work.

Checked against 12 valid and 23 invalid requests, including all the steer's
examples.

- `mode.js` uses the same test, now placed before REFACTOR, which is safe because
  the test is strict. "Extract the parser into its own file" still reaches
  REFACTOR.
- **Not flagship vocabulary by default.** `migration_plan`, `migration_verify`
  and `migration_activate` are offered only for an eligible input, or while a
  migration contract is in flight. A call when they are not offered is told why.
  The always-on prompt no longer advertises them; the MIGRATE guidance still
  teaches them.
- **Telemetry.** For each input the ledger records:
  - eligibility, the trigger that fired, and the transition with its compatibility flag;
  - whether the tools were offered and `migration_plan` was invoked;
  - whether its output was used: a later verify, activate or source edit (settled at turn close).

  `/workers` shows the totals.

### K.4 Recruitment per role, not per model (`workers/manifest.json` `roles`, `workerruntime.roleMode`)

| Mode | Meaning |
|---|---|
| OFF | never dispatched |
| SHADOW | dispatched and RECORDED, never consumed, and it never loads a cold model |
| AUTO | consumed where the input's assignment names the role AND that role's gate passed (otherwise it runs as SHADOW) |
| FORCE | consumed, as an experiment the person switched on |

| Worker / role | Mode | Why |
|---|---|---|
| Laya / source_file_ranker | OFF (REJECT) | both file gates failed; A/B WORSE |
| Laya / uia_evidence_assembler | SHADOW | live gate FAILED (K.6) |
| Laya / gug_context_compiler | SHADOW | not evaluated; Core has no live GUG source yet |
| Violetto / numeric_geometry_solver | SHADOW (experimental) | effectively OFF: the worker switch is off |
| Violetto / constraint_solver | OFF | not evaluated |
| Violetto / arbitrary_ui_generation | OFF (REJECT) | outside the contract |

- **Overrides.** `LAIN_ROLE_<ROLE>` or `cfg.workers.roles.<role>` sets one role.
  `/workers laya on` still forces every role of that worker.
- **Residency.** `wantsResident` loads a model only for a consuming role, or
  for a SHADOW role the person set explicitly (warm ≠ participate).
- **Where it shows.** `/workers` prints each role and its mode.

### K.5 Laya and Violetto are invisible to the flagship (Violetto since RETIRED, §L)

- **Violetto.** `geometry_specialist` is gone. `src/violettojob.js` is a Core
  job, and `geometryjob.js` owns geometry: `parse` builds a GEOMETRY_JOB; the
  solver (the bench GUG solver, promoted) is exact.
- **The direct path.** An explicit numeric change ("10% smaller") with exactly
  one stylesheet binding is solved by arithmetic. Core writes it through the
  ordinary gated `edit_file` and verifies it by reading the file back. The turn
  ends with no model request, no Violetto, no Laya and no `migration_plan`.
  - It only runs in AUTO execution, in the Coding view, with no read-only
    declaration.
  - With two bindings, no number, or a square binding asked to change one side,
    the flagship receives a "Geometry facts (Core)" block instead.
- **Violetto telemetry.** Every job records target, constraints, input,
  solution and `deterministicSufficient`.
- **Laya's file shortlist** says "Likely relevant files (N ranked)". The ledger
  row records which tier produced it.
- **Computer `ui_tree`.** Its deterministic slice's ledger row was labelled
  `worker: 'LAYA'`; it now says `deterministic`.

### K.6 Laya as a live-evidence compiler: the local gate FAILED

**The role.**
- **Receipts** (`src/observationstore.js`). A captured observation (DOM with
  linked accessibility role and name, bounds, state, network with `/api`
  response summaries, console, runtime) is kept once under a receipt in the LAIN
  home. `observe {receipt, goal: page | element (ref / query / selector) |
  requests | errors | system}` reads it. Every read is recorded, so reads
  outside a slice count as narrowing debt.
- **Laya's job** (`src/layaevidence.js`). Embedding every node is preparation,
  done once per observation. At task time Laya embeds the query only, fuses it
  with Core's deterministic score and returns an EVIDENCE_SLICE that keeps every
  ref.
  - It narrows observations only; the request, its read-only status, the output
    it asks for and its acceptance criteria are untouched.
  - SHADOW records and attaches nothing; FORCE attaches the slice as ordinary
    evidence; an unprepared observation is bypassed without waiting.

**Capture** (`bench/live-evidence/capture.js`, once):
- Setup: a temp copy of Toralink's webapp, a temp state dir and its own port.
  Your running instance and its state were never touched.
- One real search for "big buck bunny" returned 13 results with 9/9 sources
  answering.
- The capture holds 151 DOM nodes, with the accessibility tree linked by
  backend node id.
- Hashes of the whole project, `node_modules` and `.lain` included, were
  **byte-identical before and after**.

**Ground truth.** Fixed selectors, taken from `src/App.tsx` before any model ran:

| Target | Element |
|---|---|
| T1 search input | `input.search-input` |
| T2 search submission | the `form` (it submits on Enter; there is no button) |
| T3 source control | `select.sort-select` |
| T4 status surface | `.search-hint` |
| T5 results container | `div.results` |
| T6 result item | `div.result` |
| T7 download action | `button.dl-btn` "Get" |
| T8 search endpoint | `GET /api/search` |

**Local gate** (`bench/live-evidence/gate.js`):

| Slice (16 nodes) | Recall | Missed |
|---|---|---|
| **shipped: Core fused with Laya** | **1/8** (3/8 counting refs on path lines) | search input, submission, source, status, download |
| Laya alone | 1/8 | all but the endpoint |
| Core alone | 3/8 | submission, source, results, item, download |
| diagnostic, declared in advance: Core splits the 8 items, top 2 each — Laya | 5/8 (14 nodes, 9 irrelevant) | submission, source, download |
| same diagnostic — Core alone | 5/8 (8 nodes, 4 irrelevant) | submission, source, download |

Laya's top 16 were almost entirely result titles (the literal "big buck bunny"
in the request), a FitGirl source chip and the "Toradb library" tab. Its cosines
spanned only 0.892–0.946, the same weak separation as on files. Compression was
×3.2 (10,152 raw chars).

Preparation was measured apart from the task:
- cold load 31.6 s (125 s on the first try, with the disk cold);
- node embedding 8.7 s;
- about 2.0 GB resident.

The task inference took 371 ms (295 ms warm).

**Verdict: LOCAL GATE FAILED.** The slice misses the search input, the
submission and the download action. As the protocol requires, **no GPT-6 Luna
CONTROL/LAYA request was spent.** The role stays SHADOW
(`gates.live_evidence.pass = false`). The per-item diagnostic shows that a
better-shaped job does not help: Laya equals Core at a larger size.

### K.7 The route

LainRouter's catalog lists `openai-codex/gpt-6-luna`: native `openai-responses`,
accepting Responses or Chat, efforts low…max, default medium.

The one acceptance turn (`lr-luna-smoke`, cap 6) never reached it. LainRouter
went down during the session: `127.0.0.1:4570` refused connections and nothing
listened there. The proxy recorded 6 × "fetch failed" plus one request refused
by the cap. **Zero Luna requests were served.**

Per the protocol there was no fallback to 9router, GPT-OSS, Claude or another
Luna route, and the router was not started or modified from here. The served
model, protocol, tool calling, usage and effort on LainRouter therefore remain
**unverified**.


## L. Violetto retired; Laya as Harness Context & Perception; the Core-owned GUG; warm uncached input (2026-09-24, latest)

### L.1 Cleanup

| Removed / retired | Where |
|---|---|
| `src/violettojob.js` (the Core→Violetto job) | deleted |
| Violetto's manifest entry, roles and `geometry_solver` contract | moved to `workers/manifest.json` `retired` (identity + gate kept as history); `workers.js` contract replaced |
| Violetto prewarm, dispatch owners (`violetto:numeric_geometry_solver`), telemetry row | gone; a geometry job now records a `CORE / geometry_solver / DETERMINISTIC` row |
| Violetto path in `bench/specialist-workers/cache/run.js` | removed (its recorded output stays) |
| `laya:gug_context_compiler`, `uia_evidence_assembler` | replaced by the roles below (renamed, no alias) |
| `/workers laya on` reviving the file ranker | a **rejected** role (`rejected: true`) is never raised by a worker switch; only `LAIN_ROLE_SOURCE_FILE_RANKER=FORCE` reaches it (the historical benches set it) |

Kept, generic: the worker host and lifecycle, HOT_IDLE, OFF/SHADOW/AUTO/FORCE,
bounded job/result contracts, crash containment, per-worker stats, the
llama-server runtime (no entry uses it now), the result cache, the Laya
project index (reachable only by the forced ranker).

`/workers` now prints, per worker: runtime installed / loaded / switch; per
role: mode, invoked, background, critical-path; the Laya background queue;
RETIRED workers. Installed ≠ loaded ≠ participating.

### L.2 Laya's roles (`src/layacontext.js`, manifest `roles`)

| Role | Mode | Trigger (Core's) |
|---|---|---|
| harness_context_compiler | SHADOW (candidate AUTO) | selection / surface / edit / input |
| selection_resolver | SHADOW (candidate AUTO) | input, when dispatch names it (a deictic reference without an explicit selection) |
| cross_surface_correlator | SHADOW | selection / input |
| session_semantic_enrichment | SHADOW (background) | edit / surface |
| ui_evidence_narrower | SHADOW | a UI-evidence input over a receipt (`layaevidence.js`) |
| source_file_ranker | **OFF, rejected** | none |

- **The flow.** Core facts (Harness state, GUG, locate) → a bounded job → a
  hypothesis (refs) → **Core validates** every ref at the current generation
  (a GUG node that exists at that GUG generation, a file that exists, the
  selection that is still the selection) → only AUTO/FORCE results enter the
  packet. SHADOW results are recorded and never consumed.
- **Never on the critical path.** `enqueue` returns at once; jobs run in a
  background queue, coalesced per role; SHADOW runs only on a resident model
  (never loads one); a result that finishes after the context moved on is
  LATE: counted, discarded, never appended.
- **Cannot volunteer, self-dispatch or call another worker.** Jobs are pure
  functions of `(facts, embed)`; an enqueue from inside a job is refused and
  counted; a unit test reads the job bodies.
- **Measured in SHADOW:** dispatched, skipped, validated, invalid (false
  correlation), late, referent recall against Core's explicit selection,
  raw candidate chars vs slice chars (compression), consumed.

### L.3 The Harness context (`src/harnesscontext.js`)

Core-owned state per session: surface, active file/tab, text selection
(range + head), visual selection (GUG node + generation), DOM/UIA selection,
dirty buffers, navigation, a recent-actions ledger (situational, not history),
runtime refs, a context generation (bumped only when the canonical state
changes), the project generation (per root, advanced by a manual save, Core's
own edit or a model mutation) and its PROJECT_DELTA.

Fed by: `POST /api/ide/context` (beside idecontext / journey), `POST /api/files/save`,
Workshop `picked` / `pick-at` (→ GUG node), turn close (model mutations),
Core's direct edits.

**The packet** (`packet`) is canonical and bounded (2,400 chars): surface,
the resolved selection (a selected identifier resolved by `locate.sweep`,
memoised per project generation), a GUG slice for a visual selection,
PROJECT_DELTA, recent user actions, and a Laya line only after Core validated
it. **It is not re-sent:** a new packet is recorded once at the turn's start
(`anchorPacket`) and spliced into history just before that turn's user message
(`contextfit.buildWire` → `spliceContext`), so every later request finds it
in the cached prefix. It is never saved or shown in the feed.

### L.4 The GUG (`src/gug.js`)

- **Nodes:** stable semantic id (`composer.submit`: own token under the
  nearest named ancestor), surface, role, tag, name, selector, rect, parent /
  children, limits (only what the page reported, else null), computed geometry
  style, binding, provenance.
- **Edges (measured, intent UNKNOWN):** PARENT_OF, CENTERED_IN (x/y),
  ANCHORED_TO (insets), ALIGNED_WITH (edge), ABOVE / BELOW / LEFT_OF /
  RIGHT_OF, GAP_TO (px), SAME_WIDTH_AS / SAME_HEIGHT_AS, OVERLAPS,
  BINDS_TO_SOURCE, CONTROLLED_BY_TOKEN.
- **Sources:** the Workshop DOM (`workshop/inspect.js measure`, one bounded
  evaluate), UIA (`fromUia`, no source binding possible), stylesheet rules and
  custom properties (`bind`: EXACT · MULTIPLE · UNKNOWN).
- **Reverse mapping:** a source edit marks the nodes that file (or a token in
  it) sizes as STALE; the next measurement is a new generation, and `impact`
  reports per-node moves/resizes and relations gained / lost / gap changes
  (`POST /api/workshop/gug`).
- **Example slice** (the unit test's fixture, 733 chars, generated — not hand-written):

```
GUG_SLICE · generation 1 · workshop · http://localhost:5173/
target: composer.submit <button> "Send"
geometry: x 912 y 614 w 40 h 40
parent: composer (x 300 y 600 w 660 h 68)
relations: width == height · centerY == composer.centerY · insets in composer: top 14 right 8 bottom 14 left 612 · centerY aligned with composer.composer-input · gap before 22px (x) from composer.composer-input
nearby: composer.composer-input input w 580 h 48
limits: UNKNOWN (none reported by the page)
implementation: app.css:2 .submit { width: var(--submit-size); height: var(--submit-size) } · token --submit-size: 40px (app.css:1)
provenance: DOM · computed-style · source-css
uncertainty: relations are MEASURED, not declared — design intent is UNKNOWN
```

### L.5 Deterministic selection jobs (`src/selectionjob.js`)

Through the existing geometry door (`geometryjob.routes/run`), decided on the
input's own tick, only where Core may write without asking:

- **"rename this to ButtonFix"** with an identifier selected → a synchronous
  dry run (`rename.scan`); clean (no string/comment/member sites, no clash, not
  truncated) → the gated `rename_symbol` tool, verified by a second scan.
  Otherwise the flagship gets the turn with the packet.
- **"move this down 6px"** on a Workshop node with an EXACT binding → the one
  px declaration that moves it (`top` for a positioned box, else `margin-top`)
  → `edit_file`, verified by reading it back.
- **"make this 10% smaller"** on a Workshop node → width/height arithmetic.

No model, no Laya, no migration_plan on these paths.

### L.6 Warm uncached input (`src/cachebudget.js`, `src/cacheledger.js`, `src/toolbudget.js`)

- **Metric:** `uncached / total` per request, normalised per protocol
  (anthropic input excludes cache; chat/responses include it). Unreported
  cache figures are null, never zero. Absolute cached / uncached and total
  prompt size are kept with every row.
- **Budgeter:** serialises the exact wire (tools in order, then messages),
  compares with the lineage's previous request: expected cached = shared
  prefix. WARM ≤ 5 % SEND · ≤ 8 % PRESSURE · > 8 % reduce the optional tail
  owners (git status, IDE snapshot, locate shortlist, evidence slice, pinned
  files) to their floors with a recovery note, re-plan, else send with an
  EXCEPTION naming the owners. COLD / EPOCH_RESET are labelled, never warm
  failures.
- **Epochs:** advance only on a changed tool surface (with the names), a
  changed system prompt (with the heading), a history rewrite, or a model /
  route change.
- **Cache breaker fixed:** `intent.foldRepeats` rewrote an already-sent
  repeated request on the next request (an epoch reset per repeat); it now
  never folds a message this lineage already transmitted.
- **Tool output:** bounded as it enters (24,000 chars default; explicit
  `read_file` ranges kept up to 80,000; errors never cut; shell keeps head +
  tail); the raw output is kept under a `tr_…` receipt in LAIN's home.
- **Where it shows:** `/token` → "Uncached input": warm / cold / resets /
  unreported, median, p90, worst normal, exceptions.

### L.7 Measurements

- **GPT-6 Luna: NOT MEASURED.** The configured route (`cx/gpt-6-luna` via
  9router :20128) was not running; LainRouter :4570 answered the one probe
  request with `429 FAILED_RATE_LIMIT "The usage limit has been reached"`
  (provider `chaox-gpt`). Per the protocol no other model or route was used.
  Live spend: 1 request.
- **Structural estimate** (`bench/cache-warm/run.js --mode mock`, the real wire
  assembly and budgeter, scripted model with real tool calls, byte-prefix —
  NOT a provider receipt): 10 requests, 1 COLD, 0 epoch resets, 9 WARM:
  median 2.99 %, worst 5.30 % (the two requests where a new Harness packet
  entered history), none over 8 %; mean prompt 67,950 chars, of which tool
  schemas 45,020 and system 16,535. The deterministic GUG edit took 0 requests.
  The fixture's tool results are small; tool-heavy turns will be higher.
