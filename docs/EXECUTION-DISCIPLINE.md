# Execution discipline (internal)

**Noema owns execution discipline. The model owns judgment. Tools provide observations. Evidence controls claims.
The requested observable outcome controls completion.** Different models, same discipline — and they are not made to
think or speak alike. A weaker model gets less *discretion*, never a lower standard of evidence.

The discipline is state and code in Core (`src/discipline/`), not a longer prompt. The standing policy every model
receives is ~500 tokens (`constitution.js` `POLICY`); everything Noema can enforce mechanically is enforced, and
reaches the model only as a contextual message when it applies.

## The closed loop

```text
request ─▶ contract (outcome · explicit asks · acceptance criteria · facts · hypotheses · questions · blockers)
   ▲            │
   │            ▼
 revise ◀── observe (CheckLedger: every run_* and preview_* call, baseline vs latest, per generation)
   │            │
   │            ▼
   └──── act (mutation.js: every write — integrity analysis of test changes, scaffolding tracked)
                │
                ▼
     request_completion ─▶ arbiter (DONE · DONE_UNVERIFIED · PARTIAL · BLOCKED · NEEDS_DECISION)
```

All of it lives on the task's `Lifecycle` (`life.discipline`) and is persisted with the session, so it survives
compaction, a resume and a restart for an update. The generation is `life.mutationSeq`: a check is evidence about
the state it observed, and a later change makes it stale.

## Modules

| Module | Owns |
|---|---|
| `contract.js` | the request as state: `outcome`, `asks[]` (only what the person enumerated — never a guessed split), `criteria[]` (each with evidence `{check, expect}`), facts with freshness (STRUCTURAL / EXECUTION, 3 min or owner change), hypotheses, questions, blockers, scaffolding |
| `checks.js` | CheckState: K# (commands) and P# (Preview observations), baseline at first observation, latest per generation, realism (STATIC / UNIT / INTEGRATION / RUNTIME / PACKAGING), discrimination (NIL / LOW / MODERATE / HIGH), failure classification (CODE / ENVIRONMENT / TRANSIENT / UNKNOWN), contradictions. Green is not done; red is not automatically wrong |
| `integrity.js` | a write to a test: ASSERTION_REMOVED · ASSERTION_WEAKENED · SKIP_ADDED · XFAIL_ADDED · TIMEOUT_INFLATED · SNAPSHOT_UPDATED · FIXTURE_CHANGED · TEST_ONLY_BRANCH · MOCK_ADDED. Undisclosed, the task stays ACTIVE |
| `claims.js` | typed claims (CHANGED / VERIFIED(K#) / INFERRED / NOT_CHECKED) cross-checked against the ledger by domain (packaging, build, UI, tests); an unsupported VERIFIED is downgraded and said so |
| `arbiter.js` | the completion decision, `outcomeSatisfied()` |
| `retry.js` | no blind retries: the same failing `run_*` at the same generation is refused with its evidence; TRANSIENT failures may be retried twice |
| `profile.js` | per-model capability profiles (`<home>/models/profiles.json`): measured from invalid calls, patch failures, false completions; family priors until 30 calls → discretion STRONG / STANDARD / WEAK |
| `dialect.js` | the tool semantic layer: canonical ops rendered in each family's vocabulary (Claude `Read/Edit/Bash`, Codex `shell/rg/apply_patch`, GLM `bash/read/str_replace`, local strict canonical) and resolved back through the one canonical door |
| `digest.js` · `promptstate.js` | the continuity digest (outcome, asks, criteria, facts with STALE marks, checks baseline → latest, questions, blockers, test changes, scaffolding) and the live "Task state" prompt section; `OUTCOME SATISFIED` when it is |
| `constitution.js` | `POLICY`; `.noema/NOEMA.md` is the project constitution — CLAUDE.md-style and `<developer_instructions>` forms are rendered from it for Claude Code and Codex, never separate authorities |

## The arbiter

`lifecycle.complete()` delegates to `arbiter.evaluate()`. **`verifycontract.requirement()` is the single verification
authority**: from the changed files and the objective it decides the level (TARGETED / SUITE / PROJECT / RELEASE),
whether broad proof is needed (`needsSuite` → `finalsmoke` is then one executor of it, not a universal gate),
whether packaging must have run, and the minimum discrimination (LOW, or MODERATE for WEAK discretion).

Order of refusal: contradictions (a failing check at the current generation not explained as ENVIRONMENT /
TRANSIENT / UNRELATED) → a smoke still running → undisclosed test-integrity flags → live scaffolding → the
requirement (suite / packaging / discrimination) → open asks (>1 → PARTIAL) → criteria marked MET without current
evidence (DONE_UNVERIFIED). BLOCKED and NEEDS_DECISION are the model's to request, with a layer/reason or a question.

**OUTCOME SATISFIED** — every criterion MET with current evidence, no open ask, no contradiction: further source
mutations are refused at the tool door (`tools/index.js`), except scaffolding cleanup. This is what stops
over-execution ("Count is 2 — stop").

Quick Change scopes go through the same outcome / evidence / arbiter path; only the verification level differs.

## Tests

`tests/unit/discipline.test.js` (asks, CheckState, integrity fixtures, claim downgrade, arbiter states, proportional
verification, OUTCOME SATISFIED, retries, dialects, profiles, digest, constitution) and the updated `finalsmoke`,
`plancompletion`, `claims`, `noglue`, `planfindings` tests.
