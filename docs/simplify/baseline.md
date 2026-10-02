# S0 baseline — before the Simplify pass

Branch `lain-simple` at `noema-cleanup` fee0dc8. Route **GLM 5.3 via `lain:zai`**, one run per task, `lain -p` on a fresh
copy of the to-do fixture (`tools/dev/simplebench.js`, results in `bench-s0.json`, full transcripts in
`bench-s0-task<N>.log`). Default execution profile (NORMAL → GLM effort `high`).

| # | Task | Correct | Honest report | Model requests | In | Out | Cached | Cache % | Wall |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| 1 | rename a UI label | yes | model yes; LAIN appended "Not verified by LAIN … Treat it as NOT_CHECKED" over a correct change | 7 | 54,018 | 3,125 | 42,368 | 78 | 94.0 s |
| 2 | make a button 10% smaller | yes (font-size 14.4px) | yes, but **scope creep**: also added a test and fixed the unrelated `countDone` bug (3 files) | 11 | 101,347 | 12,218 | 88,576 | 87 | 269.8 s |
| 3 | fix a known small bug | yes (4 passed) | model yes; LAIN downgraded 4 VERIFIED claims to NOT_CHECKED although the model ran the suite | 6 | 53,779 | 2,969 | 48,576 | 90 | 109.4 s |
| 4 | answer a question (read-only) | yes, no files changed | yes | 3 | 21,095 | 1,161 | 12,992 | 62 | 57.1 s |
| 5 | several files and steps | yes (5 passed) | yes | 5 | 46,311 | 4,959 | 41,536 | 90 | 122.8 s |
| | **total** | 5/5 | 3/5 clean | **32** | **276,550** | **24,432** | **234,048** | **85** | **653.1 s** |

## Request shape

| Task | System prompt (chars) | Tools | Tool schema (chars) | Tool set changed mid-session |
|---|---:|---:|---:|---|
| 1 | 3,374 | 32 | 22,346 | no |
| 2, 3, 5 | 3,374 | 33 | 25,611 | no |
| 4 | 3,374 | 25 | 21,846 | no |

The system prompt is small; the per-request cost is the tool schema (22–26 KB) and the context LAIN adds to the
messages (task state, guidance, the contract). Mock `lain -p` one-edit turn (`loadtrace-before.json`): 406 modules
(105,623 lines) loaded; 13 tools / 11.4 KB schema for a DIRECT-classified request.

## What the transcripts show (the judges at work)

- **Task 2:** the model read LAIN's injected context — "Finish the whole path", "verification must discriminate",
  "Give the new behaviour its OWN test" — added a test for a CSS value, found the suite red on an unrelated bug, and
  fixed that bug too. 270 s and 101 k input tokens for one property.
- **Tasks 1 and 3:** `request_completion` downgraded every VERIFIED claim to NOT_CHECKED because the evidence was not
  "a check LAIN observed", then printed "Not verified by LAIN … Treat it as NOT_CHECKED" — over changes that were
  correct and tested.
- **Every task:** the model spends reasoning on the ceremony itself (`task_contract`, `request_completion`, claim
  types, "should I record a contract") instead of the task.

## Reachability

`reachability-before.md`: 673 modules / 154,870 lines in `src/`; 668 reachable from `bin/lain.js` and 662 from
`src/turn.js` through literal requires (lazy requires connect almost everything), 5 unreachable. The runtime trace is
the useful number: **406 modules load for one CLI turn**.
