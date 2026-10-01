# Noema performance — what Noema adds, measured (2026-10-01)

The question this file answers: **is Noema making the model more capable, or making the model wait for Noema?**
Every number below is Noema's own overhead, measured with a zero-latency fake model so the model contributes ~0 ms,
unless a row says "real provider".

## How to reproduce

| Command | What it measures | Quota |
|---|---|---|
| `node bench/latency/run.js [--n 12] [--only inproc\|cli\|direct] [--profile fast\|eco]` | sandbox home: direct HTTP floor, cold `noema -p`, warm in-process turns (`ok`, one `read_file`, one shell) | none |
| `node bench/latency/realhome.js [--n 10]` | the person's REAL config/accounts/supervisor, model pointed (in memory) at the fake | none |
| `node bench/latency/real.js [--connection lain:zai]` | direct provider call vs Noema NORMAL/FAST/ECO, real model | ~20 requests |
| `node --cpu-prof … && node bench/latency/profsum.js <file>` | where the CPU went, per file and function | none |
| `LAIN_TTY_PYTHON=… node bench/cliux/run.js` | what the CLI shows, frame by frame, in a real ConPTY | none |
| `node tests/run.js harness perf83` | real WebView2 window: startup, MODEL, picker, search, idle CPU | none |

## Results

### Noema-added latency per turn (fake model, same sandbox supervisor binary, p50)

| | before | after |
|---|---|---|
| "reply OK" — total | 81.9 ms | 36.9 ms |
| submit → request leaves | 65.6 ms | 20.9 ms |
| one `read_file` turn — total | 112.9 ms | 58.8 ms |
| one shell (`echo hi`) — tool step | 343 ms | ~23 ms command + cleanup deferred (≤165 ms, hidden behind the next model request) |
| the person's REAL home — "reply OK" total | 173 ms (pre-request 128 ms) | 55 ms (pre-request 27 ms) |
| REAL home — first turn of a session | 773 ms | 425 ms |
| cold `noema -p "reply OK"` (sandbox) | 538 ms | 381–389 ms |
| bare HTTP request (the floor) | 3 ms in-process · 82 ms fresh `node` | — |

What it was (CPU profiles, `bench/latency/profsum.js`):

1. **The supervisor client on the turn path.** `requestBegin` was awaited before every model request, queued behind
   one TCP connection per phase note, each re-reading `endpoint.json` and stat'ing three binary paths
   (`supervisor.endpoint` 13 % of sampled time). → admission decided in-process (it already was: availability), notes
   batched per tick over one connection, discovery cached (`src/supervisor.js`, `src/guardian.js`).
2. **A PowerShell per spawned child** (`runtimeregistry.register` → `startTimesAsync`) and **two Node boots per shell
   command** (guardian + worker containment) plus tree cleanup awaited before the result. → spawn-clock identities,
   a pre-warmed guardian, in-band end-of-output markers and deferred cleanup (`src/harness/process*.js`,
   `src/tools/shell.js`). Containment verified unchanged (a backgrounded grandchild is still killed).
3. **Per-turn re-reads in a real home**: every key decrypted (synchronous DPAPI/PowerShell, ~240 ms) to *list*
   connections; migration manifests and local-model scans re-parsed; a single-slot memo evicted on every call.
   → presence-only listings, async key read just before the request, mtime memos, per-caller memo.
4. **Duplicate turn announcement** (App and turn loop both), now deduplicated.
5. Rejected on evidence: Node's on-disk compile cache made cold start *slower* on this machine (547 vs 389 ms).

### Request size (what the provider must prefill)

| profile | before | after | tool schemas |
|---|---|---|---|
| NORMAL | 77.6 KB (~19.4k tok) | 68.0 KB (~17k tok) | 74 → 63 (Preview tools only once a Preview is attached) |
| FAST | 77.6 KB | 39.1 KB (~9.8k tok) | 39 (core set) |
| ECO | 77.6 KB | 29.7 KB (~7.4k tok) | 39 (core set, compact) |

Real provider (Z.ai GLM-5.3-Flash, n=2): direct "reply OK" 2.6 s / 17 input tokens; Noema NORMAL 6.2 s / 15.8k,
FAST 6.6 s / 8.9k, ECO 6.3 s / 7.0k. One-tool task: NORMAL 10.2 s / 31.7k, FAST 12.8 s / 17.8k, ECO 10.7 s / 14.2k.
On this route wall time is dominated by the model; the profiles cut input 44–56 %. FAST's latency gain has to come
from fewer turns on real tasks (minimal exploration, targeted verification), which n=2 micro-tasks cannot show.

### Harness

| | before | after |
|---|---|---|
| `/api/state` build (real home) | 773 ms first, 50–100 ms each | 384 ms first, 22–27 ms each |
| state reads while a turn streams | one per turn EVENT (every chunk), overlapping | one in flight + one trailing; Core wakes coalesced to ≤ 1 per 120 ms after the first |
| fallback poll while visible | 1.5 s | 4 s (Core wakes the window on every change) |
| real window (perf83): MODEL / picker / search / Skills | 101 / 153 / 1.3 / 69 ms (Phase 8.3) | 35–44 / 163–166 / 0.8–0.9 / 27–33 ms |
| idle Core CPU (window open) | 2.3 % | 2.55–2.74 % |
| window startup | 0.82 s (Phase 8.3) | 1.8 s warm (3.8 s on a run that rebuilt the host) — **not improved; open** |

`/api/state` cost was half session summaries (every poll re-parsed the newest session files, MBs each), a decrypt
to compute "has a key" and a blocking Python spawn for the debugger badge.
