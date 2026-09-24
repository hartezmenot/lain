# Read-only diagnostic — who owns a bad turn?

Built for the Toralink read-only failure (2026-09-24; findings in
`docs/STATUS.md`). It separates a **model** fault from a **router**, **adapter**
or **LAIN** fault using wire evidence, not inference.

| File | Role |
|---|---|
| `proxy.js` | Reverse proxy in front of LainRouter. Keeps every request body and the router's raw response bytes; reconstructs the raw tool calls. Headers (and so the key) are never written. A hard per-run `cap`. `canned` mode answers locally: the exact assembled request at zero quota. |
| `runner.js` | `App.once` with the input delivered as a **paste** (`lain -p` is typed and never takes the paste path). |
| `case.js` | One isolation case (A workers off · B workers registered, zero inference · C Laya hot · D alternate model) on a hashed copy of the project; the fixture diff proves any write, `.lain/` included. |
| `analyze.js` | Per call: RAW → NORMALIZED → EXECUTED, wake-up notes, final text, worker ledger. |

```
node bench/readonly-diagnostic/case.js --case A --tag A-1 --mode canned --cap 4     # request only, 0 quota
node bench/readonly-diagnostic/case.js --case A --tag A-2 --cap 30                  # one live run
node bench/readonly-diagnostic/analyze.js A-2
```

Outputs go to `bench/out/readonly-diagnostic/<tag>/` (gitignored). Put the
prompt at `bench/out/readonly-diagnostic/prompt.txt` or pass `--prompt`.

**Quota.** Each live case is one run, capped by the proxy. The 2026-09-24
diagnostic spent 88 live requests over six runs; ask before running more.
