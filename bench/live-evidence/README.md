# Live evidence: can Laya narrow a live UI observation?

Built 2026-09-24 (findings in `docs/WORKERS.md` §K). It checks Laya's
`uia_evidence_assembler` role (DOM/UIA observations compiled into an evidence
slice) locally, **before** any cloud request.

| File | Role |
|---|---|
| `capture.js` | Runs Toralink from a temp copy with temp state on its own port, runs one real search, and captures the DOM (with the linked accessibility tree, bounds and state), network, console and runtime once. The real project is hashed before and after and must be byte-identical. Writes `snapshot.json`, `truth.json` (8 targets from fixed selectors) and a screenshot for people only. |
| `gate.js` | Keeps the snapshot as an observation receipt. It loads Laya and prepares the node embeddings (timed apart from the task). It then compiles the slice for the brief (query-only inference) and scores it against the truth, alongside Core-only and Laya-only baselines. Writes `gate.json` and `prompt.txt`. |
| `prompt.template.txt` | The read-only brief both Luna arms would receive; `{RECEIPT}` is filled in by the gate. |

```
node bench/live-evidence/capture.js                       # ~40 s; one real search
node bench/live-evidence/gate.js --snapshot bench/out/live-evidence/<stamp>
```

**The gate decides spend.** If the slice misses two or more of {search input,
submission, results, result/download action}, or the search endpoint, no Luna
A/B is run. On 2026-09-24 it failed with recall 1/8, so none was run.
