# Specialist worker lab

This is separate from LAIN's runtime: nothing here is loaded by LAIN. The
findings and verdicts are in `docs/WORKERS.md` §G.

| Path | What |
|---|---|
| `locate/gate.js`, `locate/ui-gate.js` | Laya recruitment gates (files; UI controls), run against the lexical tier |
| `geometry/gug.js`, `geometry/run.js` | a minimal deterministic Geometric UI Graph, and the Violetto evaluation against it |
| `fixture/` | "TeamDesk": Vite frontend plus a Node API, with planted UI-slop, geometry and backend defects |
| `acceptance/` | the hidden checks: 7 unit and 24 browser (Edge via playwright-core, desktop and 375 px), including the final smoke. `score.js <dir>` |
| `reference/` | a known-good solution, used to prove the acceptance suite is satisfiable (31/31; the untouched fixture scores 5/31) |
| `reset.js` | a fresh, byte-verified working copy with its own git repo |
| `snapshot.js` | freezes the LAIN code under test for the length of an A/B |
| `ab.js` | v2: CONTROL (production) vs LAYA vs VIOLETTO (vs both, only after both single arms are valid), run with the real `lain -p`. It has per-arm and global request budgets, stops on any route failure or limit, and `--mock` checks the plumbing with zero quota |
| `cache/run.js` | the three caches kept apart: model residency (cold load, memory), warm inference, and the result cache (zero inference on the same state, re-evaluation on a changed one) |
| `report.js` | `WORKER_RECRUITMENT_REPORT-<id>.json`, written from measured files only |
| `out/` | recorded results (`out/runs/` is ignored) |

## Setup, once

    cd bench/specialist-workers/.deps/app     && npm install    # vite (copied into each working copy)
    cd bench/specialist-workers/.deps/harness && npm install    # playwright-core (the acceptance only)

Laya and Violetto run from the local model store (`docs/LAYOUT.md`).

## Before running an A/B: it spends somebody's quota

Each run is about 8–30 flagship requests. The v2 runner never retries: a run the
provider cuts short stops the benchmark. On 2026-09-23 an uncapped A/B used up a Kiro
account's monthly request quota. So:

1. Check the plumbing with zero quota: `node bench/specialist-workers/ab.js --mock`.
   Then run a single trial: `--arms control --reps 1 --model <m>`.
2. Set the budgets deliberately: `--arm-budget` (default 40) and `--budget`
   (default 120, global). The run stops at the first one reached, and on any
   route failure or rate limit. It never retries on another route.
3. Use the model and route that the person has agreed to spend.
