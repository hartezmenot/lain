# Narrow workers, evidence slices and the recruitment gate (2026-09-23)

**Rule:** the cheapest *reliable* owner wins. Order: deterministic software →
program logic → a narrow local worker → the flagship. A worker is recruited
only for one role, after an evaluation of that role, and only if it
measurably saves flagship work without hurting correctness.

Verification labels for every claim are in `docs/STATUS.md` (2026-09-23 section).

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

## F. Rollout, when a model passes

1. Run the gate for that contract and keep `bench/workergate/out/<model>.json`.
2. Record the binding in `cfg.workers.<contract> = { model, connection, gate }`.
   `workers.binding` refuses a binding whose gate did not pass.
3. Call `workers.decide` from the owner (for intent: `identify.js`, only on the
   default branch).
4. Watch `/workers`: compression, abstain rate, re-reads, tokens avoided.
