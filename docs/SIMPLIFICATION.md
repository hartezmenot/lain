# Is LAIN overcomplicated? — the audit (2026-10-01)

## The house, and what each language is for

| Language / runtime | Lines | Share | Responsibility | Removed, what breaks |
|---|---|---|---|---|
| Node.js (Core, CLI, Harness routes) `src/` | ~151k | ~83 % | everything that decides: turns, tools, evidence, accounts, sessions | — the product |
| Browser JS (Harness page) `lain-harness/page` | ~20k | ~11 % | the window's UI | the Harness |
| Rust `rust/lain-supervisor` | ~9.2k | ~5 % | a process that outlives LAIN: durable jobs, Telegram/remote gateway, provider-limit memory, Guardian lifecycle mirror, project digests | durable jobs and the phone gateway while LAIN is closed |
| C# `lain-harness/native/host.cs` + `native/pty.cs` + setup | ~1.9k + 2.3k (distribution) | ~1 % | WebView2 host window + tray; ConPTY helper; installer | the window, the terminal emulator, the installer |
| Python `workers/` | 169 | ~0 % | an optional local worker | that worker |

Rust carries **no** native-only capability today: no Job Objects, no PTY, one Win32 call (process liveness).

## A CLI coding turn — before

```
keypress → repl (TUI) → App.handle
   ├─ inputgate → guardian.offer ──────────────► [TCP] supervisor guardian_input           (awaited, per typed line)
   └─ App.submit
        ├─ turnauthority.begin → provider.resolve (decrypt EVERY key: sync PowerShell/DPAPI ~240 ms, first turn)
        │                      → guardian.turnBegin ───► [TCP] turn_begin
        ├─ dispatch / prompt   → migration manifests re-read · local model dirs re-scanned (every resolve)
        └─ runTurn
             ├─ guardian.turnBegin (again) ───────────► [TCP] turn_begin
             loop per step:
               ├─ onStatus phase ──────────────────────► [TCP] turn_phase   (+ endpoint.json read, 3 stats per call)
               ├─ guardian.requestBegin ═══════════════► [TCP] request_begin  (AWAITED, queued behind every phase note)
               ├─ provider HTTP  (74 tool schemas, ~77 KB)
               ├─ guardian.requestEnd ─────────────────► [TCP] request_end
               └─ shell tool → node guardian → node worker → shell      (2 Node boots ~105 ms)
                              → PowerShell (start-time identity)          (+1 process per command)
                              → taskkill tree, awaited                   (~160 ms before the result)
        └─ session.save · Harness wake per turn EVENT → window rebuilds /api/state (50–100 ms each, overlapping)
```

Measured over 10 turns in the real home: **175 supervisor connections**.

## After

```
keypress → repl → App.handle → inputgate (guardian.offer, unchanged: one local round trip per typed line)
   └─ App.submit → runTurn
        ├─ listings never decrypt; the request's own key is read async just before sending
        ├─ resolve: memoised per config signature; manifests/model dirs/telemetry re-read only when they change
        ├─ observations (begin · phase · request · usage · end) → queued per tick → ONE batched connection
        │   (a newer phase supersedes an unsent older one; nothing on the request path waits for Rust)
        ├─ provider HTTP  (NORMAL 63 schemas · FAST/ECO 39)
        └─ shell tool → pre-warmed guardian+worker (IPC only) → shell → result on end-of-output marker
                       → tree cleanup deferred; the next spawn waits for it
   └─ Harness: wakes coalesced (first at once, ≤1 trailing per 120 ms) · one state read in flight
```

Measured over 10 turns in the real home: **16 supervisor connections** (all 175 observations still delivered).

## Necessary · accidental · redundant complexity

**Necessary** (the house): Core's turn/evidence/verification model, account isolation, session continuity and crash
recovery, tool semantics, the Preview bridge, the TTY renderer, the native window, a process that outlives LAIN for
durable jobs and the phone gateway.

**Accidental** (layers created by earlier bugs, now removed or taken off the hot path):
- an awaited Rust admission gate duplicating Node's own circuit breaker;
- per-call supervisor discovery; one TCP connection per observation;
- a PowerShell per spawned child for PID-reuse protection that is only needed at reap time;
- decrypting every API key to list connections; re-parsing manifests, scans and session files on every read;
- a single-slot memo that every other caller evicted; a duplicate turn announcement;
- an activity box, a status strip and a header all stating the same state;
- 11 Preview tool schemas on every request of every CLI session.

**Redundant (remaining, recommended next)**: the Guardian's turn-state machine in Rust mirrors `inflight.js` +
`autocontinue.js`. Its only consumer that needs another process is the Telegram/remote gateway. Moving its state to a
Node-owned file (read by the gateway) would delete `guardian.rs` (1,751 lines) and its 20 ops, and let the supervisor
start only when durable jobs or the gateway are configured — one fewer process for most sessions.

## Supervisor decision: **REDUCE RUST**

Keep a tiny native process for what must outlive LAIN (durable background jobs, the Telegram/remote gateway,
provider-limit memory): it is 1.1 MB, zero dependencies, ~5–10 MB RSS, and its liveness checks are correct. Retiring it
outright would mean a second long-lived Node process (~40 MB) doing the same. Do **not** keep it as a second
orchestration system: it is now off the request path (done), and the Guardian mirror should move to Node (next).
One operational fix: in a checkout, "newest build wins" ran a **debug** build for the real home — run
`cargo build --release` after changing it, or set `LAIN_SUPERVISOR_BIN`.
