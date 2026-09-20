# LAIN Harness Blueprint

**File:** `LAIN_HARNESS_BLUEPRINT.md`  
**Purpose:** Persistent architecture, product definition, implementation roadmap, and status ledger for LAIN Harness.  
**Updated:** 2026-09-15 (reconciled against disk — see §0a)  
**Authority:** This document is the project blueprint unless the user explicitly changes a decision.  
**Recommended repository location:** `docs/LAIN_HARNESS_BLUEPRINT.md`

---

# 0. How to Use This Blueprint

This file exists so the project direction survives model switches, compaction, new chats, and provider changes.

When continuing LAIN development:

1. Read this file before proposing architecture.
2. Preserve decisions marked **FROZEN** unless the user explicitly changes them.
3. Do not infer that a capability exists because a similar lower-level tool exists.
4. Update the **Implementation Status** section after real implementation work.
5. Distinguish design, partial implementation, implemented, fixture verified, real-local verified, and live-external verified.
6. Never mark a capability complete from a mock UI, static screenshot, or stub.
7. When the user asks to add, remove, or change the architecture, update this file rather than creating a competing blueprint.

The user explicitly allows this blueprint to be revised when they ask for additions, implementation changes, or architectural corrections.

---

# 0a. Current Disk Reality — reconciled 2026-09-14

Disk and tested behaviour are authoritative; where a later section disagrees with this one, this one
is the current truth and the later section is the design intent it came from.

## Cross-surface changes from the CLI stabilization pass (2026-09-18)

The CLI's own contract is `docs/CLI.md`. What changed for every surface:

| Area | Now |
|---|---|
| Pending decisions | ONE Core record per question (`src/decisions.js`), file-backed, signed; CLI, Harness and Telegram resolve the same record, first valid answer wins. There is no second approval state on any surface. |
| Telegram | Attention only: decisions (with buttons), BLOCKED, BACKGROUND_COMPLETE, TASK_COMPLETE, FAILED (`src/bot/attention.js`). |
| Progress WebApp | Read-only, Telegram-initData authenticated (`src/webapp.js`); routing LAN → last working → Tailscale → ZeroTier (`src/connectivity.js`). Not another Harness. |
| Browser | One router for Chrome / Frontend Workshop / isolated Browser Harness (`src/browserrouter.js`); `/browser` is the CLI door. The Harness keeps its richer visual browser. |
| Subagents, A/B, `/bg` | Bounded work orders + write leases shared by all surfaces (`src/subagents.js`, `src/abtest.js`, `src/bgdetach.js`, `src/leases.js`). |
| Model catalog | omniroute / tokenrouter pruned at every layer (`src/retired.js`); 9router supported; access variants fold into one model row. |
| IDE playground in the CLI | **Not built, by decision.** File tree / code view / selection actions belong to the Harness; the CLI keeps only transient views (Diff, source-at-line). |

## Drift found and corrected in this reconciliation

| Blueprint said | Disk says |
|---|---|
| §5 three top-level experiences: Chat/Coding, Cowork, Bot | The application shell has **two lanes**: `Chat / Coding` and `Cowork / Bot` (`src/harnessapp/page.js`). Cowork and Bot remain different *roles* inside one lane. |
| §4 the Harness is a page in the person's Chrome, reached over loopback HTTP | **REMOVED 2026-09-15.** Not demoted — deleted. `harnessapp/server.js`, `harnessapp/localauth.js` and `harnessapp/desktop.js` are gone with the loopback listener, the launch token, the signed session cookie and the login gate. LAIN Desktop (`native/host.cs`, `src/desktop.js`, `src/desktopwindow.js`) is the Harness, over a private named pipe (`src/harnessapp/ipc.js`). The source workspace and the UI↔source loop moved to `routes.dispatch` with the rest. |
| §4 `/app` opens the Harness | **`/app` IS REMOVED.** The application is LAUNCHED: `LAIN.exe`, a shortcut, or `lain --desktop` (`src/desktoprun.js`). A host started with no `--pipe` runs in launcher mode and starts Core itself (`native/host.cs` `Launcher`). A command that conjures the product from inside the other surface described a shape LAIN no longer has. |
| (undocumented) how a launched process finds Node | `src/noderesolve.js`: the running interpreter → a configured `nodePath`/`LAIN_NODE` → PATH → `%ProgramFiles%\nodejs\node.exe` → the 32-bit location → a failure that names every place it looked. Written into `launch.json` at build time, because a process started from Explorer does not inherit a developer's PATH. Everything spawns as `{exe, args}`; the path contains a space on every ordinary Windows install. |
| §24 four browser purposes | **THREE.** `HARNESSAPP` — the Chromium `--app` window the Harness used to live in — was removed with the browser Harness. VERIFY, WORKSHOP and WEBMODEL remain, and each is an instrument LAIN drives. |
| (undocumented) the four-picture judgment flow | **REMOVED 2026-09-15.** `visual.js`, `visualwindow.js` and `tools/visual.js` wrote an HTML page of four candidates and opened it in the machine's browser — the one thing the native Harness exists to stop doing. Ordinary attachments, Cowork image work, `/image` and Computer/Workshop screenshots are untouched; what it guarded (a capture existing is not a person having looked) is asserted in tests/unit/images.test.js. |
| (assumed) `omniroute` is a routing subsystem | It never was. It was a provider ROW plus one message cap; both are retired (`providers.js` RETIRED, `providerlimits.js`). The dated observations behind real defensive code — a mid-turn 413, a message-count refusal — are KEPT, because deleting the provenance of a fix leaves the fix looking arbitrary. |
| (undocumented) two custom categories in the provider picker | **ONE, named `Customs…`.** The picker showed an `Other…` escape AND a row literally named `custom` carried in from the user's V1 configuration. The row is retired and the escape took the name. Provider identities and stored credentials are untouched: the value behind the row is the internal sentinel `__other__`, never a stored label. |
| (undocumented) TypeScript type declarations | `interface`, `type` and `enum` are indexed as declarations (`codemodel.js`). They were invisible, so a TS project answered "where is StallPolicy defined?" with nothing and fell back to grep. Matched on SHAPE, not keyword — none of the three words is reserved in JavaScript — and measured at zero false positives across LAIN's own 754 files. |
| §19 coverage cannot collapse silently | Enforced. A project with enough source files that scanned successfully and declared NOTHING is `PARTIAL` with a stated reason, never `FRESH` (`projectindex.coverage`). That is the shape of the original defect: 47 files, every count green, zero declarations. |
| (undocumented) step-local durable findings | Implemented (`src/planfindings.js`, tool `plan_findings`). A step keeps SETTLED / LANDED / REMAINING / EVIDENCE as capped one-line entries, persisted with the plan, so they survive compaction, a rate-limit resume and `/resume`. `remaining` replaces rather than merges — it is a statement about what is LEFT. |
| (undocumented) bounded exact-idiom policy | Implemented in the prompt: once the decision is settled, the symbols are located and the index is fresh, PATCH. A further read needs a concrete unresolved question that can be named in one sentence; "pin the exact idiom", "one more look", "the last four anchors", "one decisive batch" are named as non-reasons. |
| (undocumented) the Terminal drawer has no real shell | `native/pty.cs` — a ConPTY bridge compiled by the `csc.exe` that is part of Windows and cached by source hash, driven by `src/pty.js`. The shell believes it has a CONSOLE: it reports its width and observes a resize. Core owns the process (the window only sends keystrokes and draws bytes), and `src/teardown.js` ends every shell with LAIN. Ctrl+C is the one gap and is documented rather than claimed. |
| (undocumented) `plan_findings` is model-written only | `planfindings.derive` reads what Core already knows: LANDED from the mutation receipts (transactions marked `KEEP`, this step, reverted ones excluded) and EVIDENCE from the read-receipt ledger. SETTLED and REMAINING stay the model's — nothing in a receipt can say what a decision was. Deriving MERGES; the model's own record survives. |
| (undocumented) the window polls, so state is late | Core wakes it (`harnessapp/ipc.js` `wake`) from `notePhase`, every turn event and every write route. Measured on the real window: **85 ms**, against up to 1500 ms. The wake carries no state — one read model — and is never debounced, because a timer to smooth wakes out would be the delay it removes. The poll remains the fallback. |
| §40 the Cowork EPERM is environmental | **IT WAS NOT.** EPERM on the directory itself is the Windows signature of a live process holding it as a working directory; LAIN's own teardown omitted `harness/processes.cleanupOwned()`, which both sibling cases in the same file call. Astra's runtime is untouched. The full integration tier is 202/0. |
| §22 / §34 "Computer MCP — NOT IMPLEMENTED" with no mention of desktop control | A desktop-control **seam** already exists: `src/computer.js` (LAIN-owned operation vocabulary windows/focus/screenshot/ocr/move/click/type/key/hold with aim + verify), `src/mcp.js` (external JSON-lines bridge, permission-gated per call via `src/permissions.js`), `src/keyboarddelivery.js`, `src/heldkeys.js`, `src/controlwindow.js`. No bridge ships and there is no UI Automation; Computer MCP V1 (§22) was still unimplemented at this point. |
| §35 #18 `/diff` persistent inspector NOT IMPLEMENTED | Implemented (`src/ui/diffinspector.js`, panel KIND.INSPECTOR), REAL TTY verified. |
| §35 #22 WorkOrder scopes declared and not enforced | Enforced (`src/workorderguard.js`) with stale-baseline refusal. |
| §35 #19 timer "disappeared" | One authoritative clock (`src/ui/workclock.js`); resets per new turn, pauses on limit waits (REAL TTY verified 2026-09-14). |
| §13 live LLM edit visualization / CLI animated diff window | The CLI's paced animation (prose scramble, card holds, diff/read performance window, timeline lag) was **removed** 2026-09-14: available output appears immediately. The Harness source workspace keeps focused mutation surfacing. |
| (undocumented) turn admission | `src/admissiontrace.js` (`LAIN_TRACE_ADMISSION`) traces Enter → queue → `App.handle` → gate → submit; an empty provider reply is a provider failure, never DONE. |
| (assumed) project intelligence is Rust-owned | **It is not, and never was.** `rust/lain-supervisor/src/projects.rs` holds identity, counts and a digest only — enough to answer "have I seen this tree, and has it moved" without walking anything — and has its own test that FAILS if per-file data (symbols, imports, mtimes) is ever added. The durable intelligence is `<project>/.lain/`, written by **`src/projectindex.js`** (`index.json`: per file size, mtime, language, declared symbols, import specifiers) and `src/lainstore.js` (`fingerprints/baseline.json`). The runtime is TOLD what a worker found; it never reads the project. |
| §4/§5 a running turn blocks the application | **CORRECTED 2026-09-15.** A running turn belongs to its SESSION. `src/sessionpool.js` holds one `App` per live conversation; `viewId` (what a surface shows) and `running(id)` (what a session is doing) are separate facts. Selecting, creating (either lane) and closing are never refused by execution. Same-session submission keeps the steer contract. |
| (assumed) the Desktop window exists because the CLI opened it | `lain --desktop` (`src/desktoprun.js`) starts Core headless with a window and no REPL. `src/corelock.js` — a lock file plus a three-verb control pipe (show/status/quit) — makes a second launch find the first instead of becoming a second LAIN. |
| (assumed) closing the Desktop window ends LAIN | X HIDES TO TRAY (`native/host.cs OnClosing`); gateways, background jobs and turns in flight carry on. `Quit LAIN` from the tray asks Core (`POST /api/desktop/quit`) and runs the one shutdown sequence, `src/teardown.js`. |
| (undocumented) ending LAIN | ONE sequence, three callers: `/exit`, the tray’s Quit, and the control pipe’s `quit`. It sweeps the gateway, agent jobs, shell children, **every live session**, harness services, the computer bridge, the window and the lock. |
| (undocumented) deleting a session | `src/sessionstore.forget` is the only code in LAIN that deletes a transcript, and it is deliberately NOT in `session.js`, which is on the compaction path and guarded against reaching `unlinkSync`. Closing a view keeps the conversation. |
| (undocumented) Harness API | `api/state`, `api/turn`, `api/interrupt`; `api/source/{connect,models,select}` (WebModel); `api/files/*` (source workspace, UI↔source mapping); `api/workshop/*` (open/attach/navigate/reload/viewport/pick/element/ax/capture/verify/close); `api/cowork/*` (bind/answer/attachment/artifact/background/cancel). **2026-09-16:** the authoritative list and shapes are `docs/HARNESS_UI_CONTRACT.md`. |
| §6 Chat and Coding are turn semantics picked by the classifier | **Two views of one session (2026-09-16).** Explicit `view` on a turn; per-message `thread`; the wire carries one thread; Chat is structurally read-only; per-view models (`src/sessionviews.js`, `src/modelinventory.js`). The classifier lane still applies to terminal turns. |
| (missing) plan acceptance | `src/planhandoff.js`: DRAFT/ACCEPTED/SUPERSEDED/COMPLETED, a structured handoff and a prefilled — never auto-sent — Coding instruction. |
| (rail) RUNNING · WAITING · DONE · STOPPED · IDLE inferred per surface | ONE projection, eight words (`src/sessionstatus.js`), pushed as `session.status` events over the pipe (`ipc.emit`). |
| "Source" button = the session cwd, which could be LAIN's install folder | **Project Files = the attached project** (`sessionviews.project`). LAIN's folder, the config home and a drive root are never a project; new sessions inherit only an attached project; files routes refuse with `projectRequired`. Pins are the only way a file enters context. |
| (frontend-only) which side panel is open | `session.views.panel` — NONE/PROJECT_FILES/CHANGES/PLAN/TERMINAL/WORKSHOP/VERIFICATION, open/close/toggle, width and file persisted. |
| Workshop dev server waited on a forced PORT over IPv4 | **Measured against toradb (Vite):** Vite ignores PORT and announces its URL; binds `::1`; a failed start leaked its process (three still listening hours later); an 8.3 cwd crashes Vite's watcher; a dead `/api` proxy target answers HTTP 500. Fixed in `workshop/devserver.js`; the dev server is a first-class record with STOPPED/STARTING/RUNNING/FAILED/RESTARTING and structured 500 evidence (`workshop/devstate.js`, `api/devserver/*`). Always the canonical project root. |
| Telegram setup needs the CLI / config file and env vars | **Harness flow (`src/botconnect.js`, `api/bot/*`):** token verified by the supervisor's `remote_gateway_attach` before storage → identity → `/start` recorded as a candidate by the gateway (`bot/store.candidate`) → local approval into `allowUsers`. Discord/WhatsApp are projected with their environment requirements (no token entry: no credential store exists for them). |
| (none) settings surface | `src/settings.js`: a schema of settings that have backends, validated updates, `restartRequired`. Start-at-login is a per-user Startup shortcut (`src/startup.js`). |

## Current architecture, one screen

```text
lain CLI (bin/lain.js → src/repl.js → src/app.js)        LAIN Desktop (native/host.cs — WebView2, LAIN's window)
   a peer surface, never a launcher                         LAIN.exe / a shortcut / `lain --desktop`
        │  ONE App PER LIVE SESSION — src/sessionpool.js          │  X hides to tray; Quit → src/teardown.js
        │  one instance per account — src/corelock.js             │  private named pipe (harnessapp/ipc.js)
        │                                                        │  (the loopback HTTP Harness was REMOVED 2026-09-15)
        └──────────────┬──────────────────────────────────────────┘
                       ▼
   Turn authority: goal → task → plan → work order (src/authority.js)
   Turn loop: src/turn.js → toolstep.js → tools/index.js → mutation.js (transaction)
   Chat lane:  chatdispatch.js → modelsource/{runtime,chatgpt,gemini} (CHAT only; CODING always LAIN)
   Evidence:   evidence.js, readreceipts.js, verifycontract.js, checkpoint.js (one snapshot system)
   Runtime:    supervisor.js / guardian.js (Rust lain-supervisor), jobs/agentjob, availability breaker
   Harness:    harness/{processes,browser,cdp,artifacts,verify,observation}
   Browsers:   env/purpose.js — VERIFY · WORKSHOP · WEBMODEL (separate profiles; each an instrument)
   Workshop:   workshop/{devserver,viewport,inspect,profile}
   Desktop:    computer.js → mcp.js bridge (permission-gated) — Computer MCP V1 is §22
   Cowork/Bot: cowork/* and bot/* (Astra-owned backend; frontend consumes contracts)
```

### LAIN Desktop — the native application (2026-09-15, consolidated)

```text
   LAIN.exe / a shortcut    LAIN Desktop — the application. No terminal.
   lain                     the CLI. A peer surface, not a launcher.

   ┌──────────────────────────────────────────────────────────────────────┐
   │ LAIN Desktop  (native/host.cs, compiled by csc.exe, WebView2 render) │
   │   owns: the window · min/max/close-to-tray · DPI (per-monitor V2) ·  │
   │         window position and size across restarts · drag-and-drop ·   │
   │         external links · dark caption · the tray icon and its menu   │
   │   decides: NOTHING                                                   │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   │  renderer → host: one message shape
                                   │  { id, method, path, body }
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ private named pipe  (src/harnessapp/ipc.js)                          │
   │   random per-run name · a secret proven on the first message ·       │
   │   timing-safe · no TCP port · no cookie · no login                   │
   └───────────────────────────────┬──────────────────────────────────────┘
                                   ▼
        routes.dispatch(app, method, path, body)   ← ONE route table
                                   ▼
        LAIN Core — gate.js · trust.js · permissions.js still decide
```

**It is launched, not summoned.** `LAIN.exe` (a stable copy of the hashed build,
written by `desktop.installLauncher`) started with no `--pipe` runs in LAUNCHER
mode: it reads `launch.json` beside itself, starts Core with `lain --desktop`,
and exits — Core then opens the real window over its own private channel.
`lain --desktop` (`src/desktoprun.js`) is the same path from a terminal. **`/app`
is gone**: a command to conjure the product from inside the other surface
described a shape LAIN no longer has.

**Finding Node is part of launching.** A process started from Explorer inherits
the PATH Explorer had, which on many machines does not contain Node. So
`src/noderesolve.js` answers it in a fixed order — the running interpreter, a
configured `nodePath`/`LAIN_NODE`, PATH, `%ProgramFiles%\nodejs\node.exe`, the
32-bit location — and a failure names every place it looked. The answer is
written into `launch.json` at build time; the host re-probes only if that is
stale. Everything is spawned as `{exe, args}` with an argument array: the path
has a space in it on every ordinary Windows install, and a quoted command string
is a second escaping problem.

**No browser fallback, ever.** If the native start fails, the person gets a
native error naming the cause — a missing WebView2 runtime, a renderer profile
already in use by another window, or the specific HRESULT — and LAIN stays
failed. Silently opening an HTML Harness in Chrome would hide exactly the
regression that message exists to report.

**The browser Harness is REMOVED (2026-09-15), not merely demoted.**
`harnessapp/server.js`, `harnessapp/localauth.js` and `harnessapp/desktop.js`
are deleted with the loopback listener, the launch token, the signed session
cookie and the login gate. The window is the product; there is nothing left to
authenticate to. What the HTTP transport used to carry — the source workspace,
the UI↔source loop — goes through `routes.dispatch` like everything else.

**Browser roles are three, and each is an instrument.** VERIFY (throwaway),
WORKSHOP (project-bound preview) and WEBMODEL (persistent, authenticated —
ChatGPT.com / Gemini.google.com). `HARNESSAPP`, the Chromium `--app` window the
Harness used to live in, was removed with it: LAIN Desktop is native, so a
browser role for it would name something nothing can be launched into.

**Renderer assets are packaged, not served.** `desktop.writeAssets` writes the
one-document UI beside the host and WebView2 maps it to a virtual host name, so
a release needs no HTTP listener and no dev server to show its own interface.
`--dev` is the only path that enables devtools, the context menu or a remote
debugging port — gated twice (launcher and host) — and it uses a SEPARATE
renderer profile, because WebView2 refuses a second environment with different
options on one user-data folder and reports it as a missing runtime.

**Packaging.** `native/host.cs` and `native/vendor.js` ship in the npm
allowlist; the host is compiled on first use by the `csc.exe` that is part of
Windows and cached by the hash of its inputs (~190 ms). The WebView2 RUNTIME is
part of Windows; only its SDK is vendored, pinned, hashed and recorded in
`native/vendor/PROVENANCE.json`, and it is gitignored and never published.

**Windows first, portable interfaces.** The host is Windows-only today. Nothing
in Core knows that: the seam is a pipe carrying `{method, path, body}`, so a
later macOS or Linux host is a second host, not a second Core.

### Sessions, surfaces and lifecycle — corrected 2026-09-15

```text
                        LAIN SUPERVISOR
                              │
                          LAIN CORE
                              │
                 ┌────────────┴────────────┐
                 │                         │
              LAIN CLI               LAIN DESKTOP
                 │                         │
                 │                    system tray
                 │                         │
                 └────── sessions ─────────┘
                              │
              ┌───────────────┴────────────────┐
              │                                │
        Chat / Coding                     Cowork / Bot
```

**Sessions are Core-owned.** `src/sessionpool.js` holds one `App` per LIVE
conversation — which is what `App` always was ("two Apps in one process cannot
see each other's session"), finally used. The CLI's session is the *primary*;
every other open conversation is a *sibling*: same turn loop, same tools, same
gates, rendering to a sink instead of a terminal.

**A sibling shares process facts and nothing about the conversation.** Shared:
the config object, `availability` (a rate-limited route is shut for everybody),
`connectionEvidence`. Not shared: the session, checkpoints, plan, task, goal,
`abort`, jobs, events, project caches.

**View selection is not execution state.** `pool.viewId` is what a surface is
looking at; `pool.running(id)` is what a session is doing. They were one
variable, and that was the defect: `app.abort` answered both "is this process
busy" and "is this session busy", so opening or creating a conversation while
any other was working was refused with *"a turn is running — stop it or let it
finish first"*.

**Running turns are session-scoped.** Cross-session navigation is now
unconditional — select, create (either lane), close, return — and nothing about
what is executing is consulted. `POST /api/session/select` refuses only for a
session that does not exist. The two lanes share no lock: creating a Cowork
session never waits on engineering work.

**Same-session submission keeps the active-turn contract.** A sentence typed
into a session that is already working is a STEER (`WAIT` by default, `NOW` on
request) — the terminal's long-standing contract, now used by the window too
instead of a 409.

**Per-project write safety is unchanged.** Two sessions touching one project are
governed by the existing task / work-order / mutation authority. There is no
Desktop-specific lock: navigation is not mutation authority.

**The rail shows what each live session is doing** — superseded 2026-09-16 by
ONE projection of eight words, `IDLE · RUNNING · WAITING · QUEUED · NEEDS_INPUT ·
VERIFYING · DONE · FAILED` (`src/sessionstatus.js`; `sessionpool.statusOf` now
delegates to it), pushed to the window as `session.status` events. FAILED's
summary says whether the *turn* did not finish or the *verification* failed. A
session that is live but not yet written to disk appears in its own rail (it did
not, which made "New" look like it did nothing).

**Desktop can launch without CLI; CLI can launch without Desktop.**
`lain --desktop` (`src/desktoprun.js`) starts Core headless with a window and no
REPL. `src/corelock.js` is the single-instance mechanism: a lock file plus a
control pipe named by a hash of the config directory. A second launch asks the
first and is shown its window — one gateway, one supervisor, one writer.

**The control pipe carries three verbs and no data** — `show`, `status`, `quit`.
It reads no conversation, starts no turn, grants nothing and names no session,
which is the *only* reason it is acceptable unauthenticated: a process running as
this user can already read `~/.lain` and everything in it. The authenticated
per-run desktop channel (`harnessapp/ipc.js`) is unchanged.

**One session store.** `/resume` and the Desktop rail both read
`src/sessionindex.js` — same ids, same histories, same project roots. There is no
Desktop session database and nothing mirrors another frontend.

**X hides to tray; Quit is separate.** A user close is cancelled and the window
hidden (`native/host.cs OnClosing`), so gateways stay connected and background
work carries on. `Quit LAIN` from the tray asks Core (`POST /api/desktop/quit`),
which runs the one shutdown sequence — `src/teardown.js`, three callers
(`/exit`, the tray, the control pipe's `quit`), so none of them can forget an
entry. Core→host messages carry a `host` verb (`show`/`hide`/`notify:`) and never
reach the renderer.

**Notifications are endings, never tool calls.** `src/notify.js` speaks only for
a verdict the verification reached, a turn that did not finish, or work waiting
on the person; the host drops any toast while the window is in front.

**Closing a view is not deleting a conversation.** `pool.release` keeps the
transcript and lets a running turn carry on; deletion is its own verb in its own
file (`src/sessionstore.js`), which exists because `session.js` is on the
compaction path and is guarded against ever being able to delete anything.

**Opening an old session re-attaches its project.** `sessionpool.reattachProject`
checks the directory still exists (reported to the window, so a missing project
is stated rather than discovered through failing reads) and runs the same
`projectsync.open` reconcile the `understand` tool does.

**The terminal is a contextual Harness surface.** A project becoming active
spawns no console window; the Terminal drawer is collapsed by default and shows
the processes Core already owns (`src/harnessapp/terminalroutes.js`). It takes no
command — that would be a second execution path bypassing the tool gate — and
offers Stop, the direction that is always safe. `Open CLI` is an explicit
secondary action that opens a real terminal on the same session, after handing
the session over so there is never a second writer.


### Project intelligence — the durable chain, and who owns each link

```text
   open a project
        ▼
   freshness.ensureBaseline ──► bootstrap.baseline ──► lainstore  <project>/.lain/fingerprints/baseline.json
        │                                                          content fingerprints when LAIN first arrived
        ▼
   projectsync.open ──► projectindex.refresh ──► jsscan.tokenize ──► codemodel.scan
        │                    │                    ONE list of scannable
        │                    │                    extensions: jsscan.SUPPORTED
        │                    ▼
        │              <project>/.lain/index.json   per file: size · mtime · lang ·
        │              (tmp + atomic rename)        declared symbols · import specifiers
        │                                           `unscanned` when admitted but not parsed
        ▼
   supervisor `project_synced` (Rust)  ──► ~/.lain-v2/supervisor/projects/
        counts + digest ONLY — "have I seen this tree, has it moved". No per-file data,
        enforced by a test in rust/lain-supervisor/src/projects.rs.

   READ PATH   every query goes through projectindex.fresh(): stat the tree, re-scan only
               what moved. Never answers from a file it has not just checked against disk.
   ANSWERS     definitionsOf (where is X) · importersOf (who imports this) · outlineOf
               (what does this file declare) · orientation (what is this project)
   COVERAGE    projectindex.coverage(root) → FRESH · PARTIAL · STALE · UNKNOWN, with a
               reason for every unscanned file. One line of it in `/status`.
```

**The failure this chain had.** `jsscan.SUPPORTED` and a private copy of the
list in `projectindex.js` disagreed about TypeScript, so a `.ts` file was
admitted, refused by the scanner, and stored with no symbols — silently. A whole
TypeScript project indexed to 47 files and ZERO declarations, every structural
question answered "unknown", and every turn fell back to grep and whole-file
reads. See docs/STATUS.md, "the reread loop". Rust was **not** involved.

## Maintenance rule for this section

Every pass that lands a subsystem updates this table and §34 in the same change. A capability is
listed here by the file that implements it, so a reader can check the claim in one step.

---

# 1. Product Definition — FROZEN

LAIN Harness is a **model-agnostic AI development and work operating environment**.

It is not a prettier terminal, ChatGPT clone, Claude clone, giant dashboard, single coding agent, frontend-only IDE, bot UI, or second runtime beside LAIN Core.

LAIN Harness is the **desktop workbench** that exposes structured coding, browser, desktop, creative, productivity, verification, and execution capabilities to any supported LLM.

The model is replaceable. The Harness owns the capabilities.

```text
                    LAIN INSTALLER
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
       LAIN Harness.exe            lain
       Desktop Workbench            CLI
              │                     │
              └──────────┬──────────┘
                         ▼
                    LAIN Core
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   Capabilities       Execution        Evidence
        │                │                │
   Browser/Android    Processes        Verification
   Blender/Desktop   Files/Terminal    Artifacts
   Office/Image      VM/Host           Screenshots
```

---

# 2. Product Boundary — FROZEN

## 2.1 LAIN CLI

`lain` remains a standalone expert surface optimized for terminal users, fast coding, automation, deterministic execution, remote shells, direct project work, and advanced commands.

It must remain usable without LAIN Harness.

## 2.2 LAIN Harness

LAIN Harness is a separate desktop application optimized for:

- project/session navigation,
- source editing,
- visual frontend work,
- browser verification,
- Android development,
- 2D/3D creative work,
- desktop application work,
- Cowork,
- Bot supervision,
- artifacts,
- model selection,
- rich previews.

Harness is **not finally delivered by printing a localhost URL and password inside the CLI**.

The existing `/app` HTTP surface is a prototype.

## 2.3 Installer

The final LAIN installer bundles both:

```text
LAIN Harness
lain CLI
```

The user may launch either independently.

---

# 3. Harness ↔ CLI Relationship — FROZEN

LAIN Harness and LAIN CLI share LAIN Core/Harness authority.

They must not parse each other's rendered UI to discover state.

```text
                    LAIN Core / Harness State
                         /             \
                        /               \
                 LAIN CLI          Harness Desktop
```

When Harness opens a project it may start a `lain` session in that project, attach to an existing LAIN session, run LAIN in background, or expose an optional integrated PTY/terminal.

Structured state must travel through IPC/Core contracts.

ANSI terminal output is for humans, not for application state synchronization.

---

# 4. `/app` Prototype — CURRENT DECISION

Current `/app` is useful as a prototype but is not the final Harness architecture.

Current prototype problems include:

- manual loopback password flow,
- password paste/Enter failure,
- errors not clearly printed,
- URL/password output inside an interactive CLI area that is difficult to select/copy,
- Harness visually behaving like a child of CLI.

Short-term prototype direction:

- `/app` may launch/open the prototype externally,
- no unnecessary manually-entered password for a loopback-only temporary prototype,
- clear connection/error state.

Final direction:

```text
/app
  ↓
launch/focus LAIN Harness desktop
  ↓
open/attach current project/session
```

The native desktop app should use local IPC/auth appropriate to a desktop application rather than a user-pasted loopback password.

---

# 5. Primary Harness Experiences — FROZEN (hierarchy finalized 2026-09-16)

```text
LAIN
│
├── Chat / Coding
│    └── engineering session
│         ├── Chat      discuss · research · plan        (its own model/source)
│         └── Coding    implement · test · verify        (its own model)
│
└── Cowork / Bot
     ├── Cowork         productivity work (sessions)
     └── Bot            messaging connections (Telegram · Discord · WhatsApp)
```

Two lanes. Each lane has two internal VIEWS; a view is not a session and not a
top-level mode. Cowork and Bot are **different roles** even when they use
overlapping capabilities.

The frontend contract for all of it is `docs/HARNESS_UI_CONTRACT.md`.

---

# 6. Chat / Coding

## 6.1 One Engineering Session, Two Views — as implemented 2026-09-16

```text
EngineeringSession                                   src/sessionviews.js
├── project (attached, or none)                      views.project
├── shared durable context: goal · accepted plan · evidence · pins · project intelligence
├── Chat thread    — model/source A, never mutates   messages tagged thread:'chat'
└── Coding thread  — model B, normal authority       messages tagged/untagged 'coding'
```

- **Two threads, one file.** Every message carries `thread`; a turn's wire is
  its own thread only (`contextfit.buildWire` → `sessionviews.wireMessages`).
  Untagged history — everything before views, every terminal turn — is Coding.
  A terminal-only session reaches the wire byte-for-byte as before.
- **Chat cannot write.** `tools/index.execute` refuses a mutating tool in a
  Chat-view turn (`CHAT_VIEW_READ_ONLY`); LAIN-runtime Chat runs in EXPLAIN mode;
  website sources answer Chat turns only. A Chat model proposing a patch gains
  no authority to apply it.
- **Coding** needs an attached project and runs under the usual mutation
  authority, work orders, trust, permissions and verification.
- **Independent model selection.** Chat: `session.chatSource` +
  `sourceSelections` (a runtime pick is recorded on the session only). Coding:
  `session.views.coding`. Both are overlaid per turn on a copy of the shared
  process config (`sessionviews.turnCfg`); neither writes it.
- **One writer per session.** A Chat send while Coding runs is refused with
  `busy`, not steered into implementation.

## 6.1a Chat → Coding handoff (`src/planhandoff.js`)

```text
Chat reply with ≥2 steps that is (or answers a request for) a plan
   → DRAFT → "Plan ready — Continue to Coding?"  [Yes] [Edit plan] [Not yet]
Yes → ACCEPTED (frozen, digest; older ACCEPTED → SUPERSEDED)
    → structured handoff built from durable state
    → Coding view focused, instruction PREFILLED in the Coding composer
    → the person edits and presses Enter → Coding turn (handoff SUBMITTED)
    → lifecycle DONE → COMPLETED
```

Accepting executes nothing. The handoff carries goal, accepted plan, the
person's own requirements and constraints, project root, pins and files named in
the plan, project-intelligence refs (index freshness, symbol locations),
evidence refs, existing changes and verification state — never the Chat
transcript or reasoning. The full accepted plan rides in the Coding system
context; the composer carries a bounded instruction referencing it by id.

## 6.1b Session status — one authority (`src/sessionstatus.js`)

`IDLE · RUNNING · WAITING · QUEUED · NEEDS_INPUT · VERIFYING · DONE · FAILED`,
each read from its owner (turn controller, Harness port question, turn phase,
lifecycle, Harness task, last turn). `touch` runs on every turn phase, turn end
and question, and emits `session.status` to the window when a word changes —
so the rail updates for sessions nobody is viewing. The clock is the existing
execution clock (terminal work clock, or the turn-start stamp).

## 6.2 Model Sources

Engineering Chat supports:

- LAIN runtime/local/provider models,
- ChatGPT.com,
- Gemini.google.com.

ChatGPT.com and Gemini.google.com are browser-backed, user-authenticated model sources with dynamically discovered account model lists.

Website models are **model sources**, not machine execution authorities.

If a ChatGPT/Gemini turn becomes a coding request, LAIN Core owns filesystem, tools, execution, and verification.

---

# 7. Cowork — FROZEN ROLE

Cowork means:

> **Do work for me.**

Cowork is the general productivity executor.

Examples:

- clean spreadsheets,
- edit documents,
- organize files,
- image editing,
- create/export artifacts,
- research,
- reminders,
- calendar,
- notes,
- contacts,
- email drafting/reply/send with permission,
- office workflows,
- conversion and cleanup work.

Cowork should feel like:

```text
input/object
   ↓
understand task
   ↓
deterministic tools
   ↓
finished artifact/action
```

not a chatbot explaining what the user should do.

---

# 8. Bot — FROZEN ROLE

Bot is **not the same thing as Cowork**.

Bot means:

> **Supervise LAIN, other AI applications, sessions, and remote work.**

Examples:

- check whether Claude is still working,
- check whether ChatGPT is still working,
- inspect LAIN background tasks,
- inspect project processes,
- report whether a build is still active,
- notify when a task completes,
- steer/stop/resume LAIN sessions,
- supervise Cowork jobs,
- remotely inspect applications,
- use Computer MCP when structured state is insufficient.

Bot may also perform useful tasks through shared capabilities.

Example:

- receive a photo from Telegram,
- edit it through LAIN's native photo/image tools,
- return the edited artifact.

Bot can therefore use image/photo tools, Computer MCP, browser tools, session/process inspection, messaging transport, artifacts, and LAIN tools.

The user's current local LLM/runtime under `E:\AI` may serve Bot/Cowork during development, but final capability contracts remain model-agnostic.

---

# 9. Messaging Transport

Messaging platforms are transports into LAIN, not separate brains.

Current targets:

- Telegram,
- Discord,
- WhatsApp.

```text
Telegram / Discord / WhatsApp
            ↓
    normalized message event
            ↓
        LAIN Bot
            ↓
   LAIN Core / capabilities
            ↓
 normalized outbound action
            ↓
 originating platform
```

Messaging admission does not grant machine permissions.

---

# 10. Model-Agnostic Capability Registry — CRITICAL / FROZEN

No important capability should belong to one model.

Wrong:

```text
if model == astra:
    expose_blender()
```

Correct:

```text
Capability Registry
│
├── source
├── filesystem
├── browser
├── frontend
├── backend
├── android
├── desktop
├── computer
├── image
├── spreadsheet
├── documents
├── email
├── blender
├── 2d-assets
├── 3d-assets
├── testing
├── database
└── ...
```

Any supported LLM may use available capabilities.

If Astra discovers a good Blender workflow, convert it into a deterministic Harness capability so Opus, GPT, GLM, Claude, Kimi, and local models can use it too.

Target philosophy:

```text
80% deterministic tools/workers
20% LLM reasoning
```

---

# 11. Core Engineering Workspace

An engineering session should progressively expose:

- Conversation,
- Source,
- Changes,
- Terminal,
- Verification,
- Artifacts,
- Workshop.

Do not permanently show every panel.

```text
Engineering Session
│
├── Conversation
├── Source
├── Changes
├── Terminal
├── Verify
├── Artifacts
└── Workshop
```

---

# 12. Source Workspace — REQUIRED

The Harness needs a real code/source surface.

Minimum capabilities:

- project tree / quick open,
- HTML/CSS/JS/TS/JSX/TSX/JSON/Markdown/Python/Rust and other text source,
- syntax highlighting,
- line numbers,
- find,
- edit,
- save,
- small tab set,
- unsaved marker,
- disk-change detection,
- diff/change marker,
- source selection,
- open changed file,
- ask LAIN about selected code,
- fix selected code.

The editor is presentation.

Canonical filesystem/write/trust authority remains in LAIN Core/Harness.

---

# 13. Live LLM Code Editing Visualization — REQUIRED

When LAIN modifies source inside Harness, the user should see the real operation.

Example:

```diff
- opacity: 0.2
+ opacity: 0.5
```

Harness should visually show:

- changed line,
- removed value,
- inserted value,
- current patch location,
- file being modified.

This must be based on real patch/write events.

Do not fake model token typing.

---

# 14. Bidirectional Source ↔ UI Mapping — CRITICAL

This is one of the defining LAIN Harness features.

## 14.1 UI → Source

User says:

> Fix the Save button.

If multiple candidates exist, Harness visually highlights candidates:

```text
[1] Settings Save
[2] Account Save
[3] Editor Save
```

LAIN asks:

> Which button?

User clicks the intended button.

Harness then:

1. identifies rendered object,
2. resolves DOM/AX/component identity,
3. opens the relevant source file,
4. highlights the controlling code,
5. scopes the next LAIN turn to that object/code.

## 14.2 Source → UI

User clicks/selects code.

When mapping is evidence-backed, Harness highlights the rendered UX/UI object controlled by that code.

## 14.3 Identity Graph

```text
SOURCE SYMBOL
      ↕
COMPONENT
      ↕
DOM NODE
      ↕
ACCESSIBILITY NODE
      ↕
VISIBLE REGION
      ↕
EVENT HANDLER
      ↕
NETWORK REQUEST
      ↕
BACKEND ROUTE
```

Relationships must be evidence-backed.

Do not invent source mapping when confidence is insufficient.

---

# 15. Web Frontend Workshop

The Web Workshop is the first rich workshop.

Capabilities:

- start/adopt dev server,
- Harness-owned Chromium,
- Preview,
- DOM inspection,
- AX inspection,
- element picker,
- click/type/navigation,
- console,
- network,
- screenshots,
- before/after,
- viewport presets,
- visual evidence,
- horizontal-overflow checks,
- source association when reliable,
- selected element → Ask LAIN,
- selected element → Fix this.

```text
source
  ↓
change
  ↓
live preview
  ↓
observe
  ↓
verify
  ↓
artifact/evidence
```

---

# 16. Backend Workshop / Backend Observation

LAIN Harness should not treat backend work as shell-only.

Target capabilities:

- process/service health,
- logs,
- API calls,
- HTTP tracing,
- route discovery,
- database/schema inspection,
- source graph,
- AST/FGM,
- build/test,
- dependency/runtime state,
- network activity,
- error correlation,
- frontend request ↔ backend route tracing.

Desired diagnosis:

```text
visible button problem
      ↓
click handler works
      ↓
POST /api/checkout
      ↓
500 response
      ↓
paymentService.js
```

---

# 17. Android Workshop — TARGET

Target capabilities:

- Android SDK,
- Gradle,
- ADB,
- emulator management,
- install/uninstall APK,
- device profiles,
- logcat,
- screenshots,
- input/touch,
- accessibility/layout inspection,
- activity lifecycle,
- permissions,
- Compose/XML relationships where practical,
- network inspection,
- build/test,
- responsive/device-specific verification.

---

# 18. Desktop / Native Application Workshop — TARGET

Target capabilities:

- run native application,
- inspect windows,
- inspect native controls,
- operate dialogs,
- screenshots,
- process state,
- app logs where available,
- package/install testing,
- Computer MCP integration,
- clean VM smoke.

---

# 19. Blender / 3D Workshop — TARGET

Blender should become a structured Harness capability rather than a model-specific trick.

Target structured capabilities:

- scene inspection,
- objects,
- meshes,
- transforms,
- materials,
- textures,
- armatures,
- rigging,
- animation,
- cameras,
- lights,
- modifiers,
- geometry,
- render,
- import/export,
- Blender Python scripting.

Prefer Blender structured APIs/Python before Computer MCP mouse clicking.

---

# 20. 2D / Game Asset Workshop — TARGET

Target capabilities:

- image/canvas operations,
- layers,
- sprite sheets,
- frame animation,
- palettes,
- vector assets where supported,
- background removal,
- inpainting,
- upscaling,
- resizing,
- export,
- asset preview,
- game-character 2D creation/editing.

---

# 21. Native Photo/Image Editor — REQUIRED

LAIN Harness needs a native image editing capability.

Bot and Cowork must both be able to use it.

Target operations:

- open/import image,
- crop,
- rotate,
- resize,
- background removal,
- background replacement,
- inpaint/remove object,
- simple retouch,
- sharpen,
- denoise,
- upscale,
- face enhancement where available,
- compositing/layers where appropriate,
- generate/edit image,
- export artifact.

Remote example:

```text
Telegram
  + photo
  + "remove the background and make it white"
        ↓
Bot
        ↓
shared Image capability
        ↓
edited artifact
        ↓
Telegram
```

Do not implement separate Telegram image logic.

---

# 21b. INPUT BOUNDARIES — MEASURED, 2026-09-16

Where mouse and keyboard come from, per surface. **No Chrome extension appears
here, and one was considered and found unnecessary.**

```text
LAIN Desktop
│
├── Harness renderer          normal WebView2/native input
│      the window's own events, over the private pipe to Core
│
├── Frontend Workshop         CDP / browser input
│      the preview is a browser page; Browser Harness drives it
│
└── Computer                  Computer MCP / Windows UI Automation
       anything that left the browser boundary: other applications,
       native dialogs, the desktop
```

**Why not an extension.** The question was whether sending mouse and keyboard
into LAIN's *own* native window needed one. It does not, and an extension would
have added a permission surface, an install and update artifact, Chrome-specific
lifecycle, another bridge, profile coupling and version skew — for a window
LAIN already owns.

**Measured on the RELEASE window** (`dev: false`, so the real setting of
`AreDefaultContextMenusEnabled` and `AreBrowserAcceleratorKeysEnabled`), driven
with real Windows input through Computer MCP, with no extension installed:

| Interaction | Result |
|---|---|
| click, double click, wheel scroll | work |
| typing, arrows, Home/End, Tab, Enter, Esc | work |
| Ctrl+A, Ctrl+C, Ctrl+V | **work** — `AreBrowserAcceleratorKeysEnabled=false` disables *browser* accelerators (Ctrl+F, Ctrl+P, Ctrl+R, F12), not editing ones |
| mouse targeting at 1.5× and 2× DPI | works |
| focus restoration, text selection | work |
| the page as a UI Automation tree | 47 nodes, addressable |
| keystrokes into the project shell | work (ConPTY, src/pty.js) |
| **right-click context menu** | **was the one real gap** |

`AreDefaultContextMenusEnabled = false` is correct — WebView2's own menu offers
Reload, View source, Save as and Inspect, none of which belong in a native
application — but removing it removed Copy and Paste with it, so right-clicking
did nothing at all. The fix is LAIN's own menu (`src/harnessapp/pagemenu.js`)
with Copy · Cut · Paste · Select all and nothing browser-shaped in it.

**Core owns the clipboard, not the page.** `execCommand('paste')` is blocked in
Chromium and `navigator.clipboard` needs a permission prompt this window should
never show; both would also be a second clipboard authority beside `src/copy.js`,
which is the one place text is sanitised on the way out. The menu goes through
`/api/clipboard/{read,write}`.

---

# 22. Computer MCP — HORIZONTAL INFRASTRUCTURE

Computer MCP belongs to LAIN Core/Harness, not to one lane.

```text
                    Computer MCP
                    /     |      \
                   /      |       \
              Coding    Cowork     Bot
```

V1 target:

- displays,
- windows,
- foreground app,
- UI Automation/accessibility tree,
- screenshots,
- pointer,
- click/double/right-click,
- drag,
- scroll,
- type,
- key/hotkey,
- focus window,
- find control,
- click control,
- type into control,
- wait for control/window,
- clipboard with explicit need.

Observation preference:

```text
1. native structured control/UI information
2. semantic control bounds
3. screenshot/vision
4. OCR fallback
```

V1 explicitly excludes memory scanning/writing, DLL injection, pointer/address discovery, Cheat Engine-style flows, and trainer functionality.

---

# 23. Bot + Computer MCP

Bot may use Computer MCP to supervise external AI applications.

Example:

> Is Claude still working?

Preferred evidence order:

1. structured LAIN/process/session state if available,
2. app-native state if exposed,
3. Computer MCP observes Claude UI.

Same for ChatGPT.

Bot should not infer "working" from PID existence alone.

---

# 24. Harness-Owned Browser Architecture — FROZEN

Normal LAIN testing must not use the user's personal browser/profile.

Three browser purposes:

## Verification Browser

- clean/throwaway,
- Harness-owned Chromium,
- smoke/e2e,
- no personal cookies.

## Workshop Browser

- Harness-owned Chromium,
- project-bound,
- interactive preview,
- may persist during a development session.

## WebModel Browser

- ChatGPT.com/Gemini.google.com,
- persistent authenticated profile,
- explicitly user-authenticated.

Profiles and lifecycle remain separate.

## LAIN for Chrome — added 2026-09-18, a FOURTH and distinct purpose

Not a Harness-owned Chromium at all — the person's OWN, real, already-signed-in
Chrome, through a companion extension they install and connect. It never
substitutes for the three purposes above: the Verification Browser stays
clean and throwaway, the Workshop Browser stays project-bound, and WebModel
keeps its own isolated authenticated profiles.

- `src/lainchrome.js` — a local, token-authenticated, origin-pinned HTTP
  long-poll bridge (no WebSocket dependency: LAIN has zero npm runtime
  dependencies, so the protocol is plain `http`). Binds `127.0.0.1` only.
- `src/tools/chrometab.js` (`chrome_tab`) — offered to the model only while
  the bridge is connected AND the extension has registered, exactly like
  `computer` follows Computer MCP's transport. Never offered for ordinary
  coding work.
- Which tabs are reachable is the EXTENSION's decision, made by the person
  clicking "Authorize this tab" in its popup — the bridge only ever sees tab
  ids the extension already chose to expose.
- Page content returned by any observation is UNTRUSTED WEBPAGE DATA, stated
  as such in the tool's own schema and in every result string, never
  authority — a page's own text asking the model to do something is content,
  not an instruction, exactly like a file's contents would be.
- Semantic targeting only: every action names an element by a stable `ref`
  from `find`, never a raw coordinate — `chrome_tab` has no x/y parameters.
- Settings → Connections exposes functional state only (`DISCONNECTED` /
  `WAITING_FOR_EXTENSION` / `CONNECTED`, authorized tab count) via
  `src/harnessapp/chromeroutes.js` — no visual redesign.
- `extension/` holds the MV3 manifest, background service worker, content
  script and popup. **NOT REAL-CHROME VERIFIED** — built and unit-tested at
  the protocol layer (`tests/unit/lainchrome.test.js`); the extension has not
  been loaded into an actual Chrome instance and driven end to end in this
  pass. See docs/STATUS.md.

---

# 24a. Runtime Context Authority, Task Classification & Verification Evidence — added 2026-09-18

Closes a P0: generated runtime context could reach the model as an
undifferentiated `role:'user'` message, indistinguishable from — and in one
observed case, more authoritative than — what the person actually typed.

**Authority order**, highest first: ACTUAL USER (the live message, an
explicit `/steer`) → DURABLE TASK STATE (Goal, accepted Plan, Plan Step) →
CONTEXT (handoff, compacted summary, project intelligence, read receipts,
prior model output) → EVIDENCE (tool results, verification) → RECOVERY
(retry/continuation metadata). Generated CONTEXT/EVIDENCE/RECOVERY state must
never be serialized as if it were a newer user instruction.

**Structural marking, not prose convention.** `src/contextprovenance.js`
wraps every generated volatile block in `<lain-context>...</lain-context>`
(taught explicitly in the stable system prompt) before `contextfit.buildWire`
puts it on the wire — the model has a structural signal, not a hopeful
prefix like "Previous context:".

**Task classification** (`src/taskclass.js`) — PROJECT_IMPLEMENTATION /
PROJECT_DIAGNOSTIC / LIVE_EXTERNAL_DIAGNOSTIC / DIRECT_TOOL_TASK /
CONVERSATIONAL — decides grounding strategy (`GROUNDING_FOR`), never disables
it: a live diagnostic ("diagnose Calculator using Computer MCP") is graded
`LIVE_DESKTOP`/project-source-not-required and must never be told "no
implementation target was specified".

**Explicit cancellation** (`task.js` `CANCEL_RE`) supersedes the active task
and clears its plan (`identify.js`) rather than folding a "cancel this,
do that instead" instruction in as a correction to the very task it cancels.

**Clarification budget** (`clarify.js`) is restated in every turn's context
while exhausted (`Clarifications.directive()`, wired into both the ordinary
and handover prompt-building paths in `prompt.js`) — a model that stops
calling `ask_user` and writes its next question in prose gets the same wall.

**Verification evidence kinds** (`src/evidencekind.js`) — COMMAND_EXECUTED,
COMMAND_EXIT_STATUS, SEARCH_MATCH_FOUND, SEARCH_NO_MATCH, INCONCLUSIVE — a
different axis from `verifycontract.js`'s EVIDENCE ladder (that grades
environment realism; this grades what one observation actually proves). A
compound command joined by cmd.exe's unconditional `&` (never `&&`) whose
tail is a bare `echo`/print is detected and marked INCONCLUSIVE regardless of
its truthful exit code — the exit code belongs to the trailing segment, not
to whatever ran before it. Wired into `lifecycle.js` (`observeTool`,
`complete`, `contradiction`) and every narrative surface that reads
`lastCommand` (`handover.js`, `prompt.js`, `briefing.js`, `continuity.js`,
`progress.js`, `survey.js`, `dash.js`).

**Runtime provenance diagnostics** (`src/provenance.js`, `/provenance`) —
session, current turn's task class and grounding, goal, plan, context
sources present/absent, tool exposure vs. what actually executed. Never the
model's own reasoning; LAIN-owned runtime state only.

Evidence: `tests/unit/contextprovenance.test.js`, `taskcancel.test.js`,
`taskclass.test.js`, `clarifybudget.test.js`, `evidencekind.test.js`,
`directread.test.js`, `provenance.test.js`. See docs/STATUS.md.

---

# 25. Execution Environments

Tasks may run in:

```text
HOST
VM:<registered-id>
```

Environment-sensitive operations must agree on the same environment.

Use HOST for coding, fast tests, and normal Workshop development.

Use VM for clean installation smoke, isolated app verification, destructive/experimental testing, future native desktop testing, and future Computer MCP guest targets.

---

# 26. VMware

VMware is one environment provider.

Target operations:

- status,
- list registered Harness VMs,
- start,
- stop,
- snapshot,
- restore,
- exec,
- copy in/out,
- health.

Only explicitly Harness-owned/registered VMs may be controlled automatically.

Never assume authority over arbitrary user VMs.

---

# 27. Verification Philosophy — FROZEN

LAIN must not self-declare success.

```text
DO WORK
  ↓
OBSERVE RESULT
  ↓
VERIFY
  ↓
PASS / FAIL / INCONCLUSIVE
```

A sent click is not success.
A changed file is not proof the frontend is correct.
A launched VM is not proof the guest is ready.
A browser tab opening is not proof the workflow works.

---

# 28. Harness Application UX Principles — FROZEN

LAIN Harness should feel like a modern workbench, not a dashboard.

Use:

- whitespace,
- hierarchy,
- contextual tools,
- progressive disclosure,
- live artifacts,
- source ↔ preview relationships.

Avoid:

- permanent giant grids,
- raw event streams,
- exposing every internal capability as a top-level tab,
- fifteen toolbars,
- model reasoning dump,
- fake activity.

---

# 29. Session Model

## Engineering Session

Contains workspace/project, Chat/Coding history, model source/model, goal, plan, current work, artifacts, verification, source state, and Workshop state.

## Cowork Session

Contains general work/artifact/action context.

## Bot Session

Contains supervision/remote-operator context.

Remote transport identity remains explicit.

---

# 30. Goal / Plan / Step / Steer

```text
GOAL
= what the user wants to achieve

PLAN
= current strategy

PLAN_STEP
= active execution steps

STEER
= user correction during active work
```

## 30.1 As implemented (2026-09-14)

**GOAL** (`src/goal.js`) — `session.goal` is the ONE active goal every consumer reads (prompt,
`authority.project()`, background forks). Other goals wait in `session.pausedGoals`
(≤12, persisted). States: `ACTIVE`, `PAUSED` only — no completion state, because nothing observes
completion. `create` pauses the previous active goal; `activate` swaps; `edit` keeps identity;
`remove` of the active goal leaves none active (nothing is auto-promoted). Only `/goal` and its
composer write goals (unit guard).

**PLAN** (`src/plan.js`, `src/plancompose.js`) — session-owned. Replace (`Edit`) rewrites only the
remaining steps; `Add` appends; `New` moves the current plan unmutated into `session.planHistory`
(≤5, persisted); `Delete` removes the plan and the outstanding "plan finished but not verified" claim.

**PLAN_STEP** — steps carry `origin: llm | user | steer`; an ordinary prompt cannot add one; a new
task clears the plan (`identify.js`); a finished plan retires only through evidence-gated paths
(`completion.js` accepting, or a new request after a finished plan).

**STEER** — typed during work: WAIT (delivered as the next turn, `from: 'steer'`) or NOW (second
Enter, injected at the next step boundary, recorded in `steerTexts`).

## 30.2 CLI command interaction — the Context Action Shelf

`src/ui/shelf.js` is ONE panel frame (`KIND.SHELF`, `MODE.COMPACT`) used by every command with
follow-up actions: title, context lines, optional choices, one row of actions; ←/→ actions, ↑/↓
choices, Enter, unique first letter, click; a `confirm` action asks in place with Cancel as default;
Esc closes; nothing is written to the transcript.

| Command | No state | With state |
|---|---|---|
| `/goal` | `GOAL › _` composer | Continue · Edit · New · Delete (choices when >1 goal) |
| `/plan` | `PLAN › _` composer | Continue · Edit · Add · New · Delete (steps as context) |
| `/resume` | — | recent sessions as choices · Continue · Details |
| `/copy` | copies the one available target | only targets with content: Open question · Summary · Last answer · Context · Diff |
| `/model` | — | source first (LAIN · ChatGPT.com · Gemini.google.com); LAIN → catalog browser; website → this account's discovered models → Use |

`/models` is a hidden alias. The composer label (`GOAL ›`, `PLAN ›`, `PLAN +›`) leads the input line
whether or not it has text. Pipes and `-p` keep the text fallbacks (interactivity is `input.isTTY`).

## 30.3 CLI reading rhythm

A user turn is ONE gray anchor row, `USER · <real prompt preview…>` (`USER DECISION` / `USER REQUEST`
for a one-word answer or a paste), mapped to the exact submitted text: click restores it to the input
line, Alt+↑/↓ jump between anchors, `/copy context` exports it. A half rule separates the ask from the
result; a full rule opens the next exchange. The full multi-paragraph prompt is no longer re-drawn in
the feed (superseding the 2026-09 structured-prompt feed rendering); it stays on the turn record.

---

# 31. CLI Copy Semantics — REQUIRED TWEAK

## `/copy`

Copy a concise useful task summary.

Include user request, result, changes, verification, remaining work, and how to run where relevant.

Exclude spinner, activity, token telemetry, timer, READY, command menu, transient warnings, hidden reasoning, recovery glue, and decorative UI.

## `/copy context`

Copy diagnostic context from the initiating user input through the current point using canonical session/turn records.

Do not scrape rendered terminal pixels.

Potential future:

```text
/copy context all
```

for full-session export.

---

# 32. CLI Manual Text Selection — REQUIRED TWEAK

The interactive renderer must not make useful terminal text effectively impossible to select/copy.

The user should be able to copy URLs, commands, paths, errors, final summaries, and prototype connection information.

---

# 32a. CLI Mouse / Transcript Navigation Contract — REQUIRED

Default behavior should prioritize native terminal selection while preserving reliable transcript navigation.

```text
Default
  drag           → native terminal text selection
  PgUp/PgDn      → LAIN transcript navigation
  Home/End       → transcript navigation where appropriate
  wheel          → LAIN transcript scrolling only if the host can provide it without stealing selection

/mouse on
  → explicit full LAIN mouse interaction mode
  → wheel/clicks owned by LAIN
  → native drag selection may be unavailable

/mouse off
  → terminal owns mouse completely
```

Do not simply re-enable global DEC mouse capture to fix the wheel; that would regress the selection bug already fixed.

---

# 32b. Diagnostic Context Projection — REQUIRED CORRECTION

`/copy context` must serialize semantic public turn content.

Wrong:

```text
USER (mid-turn)
[object Object]
```

Correct behavior:

- render the actual submitted/steer text when a structured record contains public user content,
- omit internal-only records that have no public textual representation,
- never stringify arbitrary objects as diagnostic conversation text.

---

# 33. Native Artifact Principle

Whenever possible, return the real object:

- edited image,
- workbook,
- document,
- code patch,
- build,
- screenshot,
- report.

Do not replace artifacts with a paragraph describing what the user should do.

---

# 33a. Account Manager / Add Account — FROZEN DIRECTION

The old `/oauth` concept should evolve into **Add Account**.

OAuth is an implementation mechanism; the user concept is an account connection.

```text
ACCOUNT
= who/how LAIN is authenticated

PROVIDER
= where inference or service capability comes from

MODEL
= the concrete model selected

ROUTE
= how LAIN chooses/uses a provider/model path
```

Harness should expose this contextually from model selection/settings rather than as a permanent giant dashboard:

```text
Model
  current model

  Add account
  Manage accounts
```

Supported account connection classes may include:

- OAuth / device-flow provider account,
- authenticated web session (for example ChatGPT.com or Gemini.google.com),
- router/aggregator account,
- direct API/provider credential where supported,
- local model/runtime endpoint.

Account secrets must never become ordinary model context, transcript, `/copy`, `/copy context`, Bot messages, artifacts, or normal logs. Use the existing secret/credential authority or OS-backed secure storage rather than inventing a second secret system.

The capability must remain model-agnostic. A connected account expands LAIN's model/service inventory; it does not belong to Astra, Opus, GPT, GLM, or any other specific model.

CLI direction:

```text
/account
/account add
/account status
/account disconnect
```

`/oauth` may remain only as a compatibility alias during migration if required.

---

# 33b. Context Builder + Context Cost Observatory — REQUIRED

Direct accounts alone do not solve excessive input context. LAIN must distinguish router/provider overhead from LAIN's own context composition.

Target architecture:

```text
                LAIN Context Builder
                        │
                normalized packet
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   direct account   router/aggregator   local/web source
```

Provider adapters should not independently decide to replay project/session context.

The Context Cost Observatory should be inspectable on demand, not permanently shown:

```text
Current request
System                 ...
Project context        ...
Conversation           ...
Tool contracts         ...
Evidence/handover      ...
User input             ...
──────────────────────────
Sent                    ...
Output                  ...
```

Requirements:

- expose authoritative usage when available,
- explicitly mark estimates/unknown values,
- do not invent token usage for website-backed sources,
- make it possible to compare the **same normalized LAIN packet** across direct provider vs router paths,
- identify repeated/redundant context and rediscovery costs,
- keep raw secrets and private auth metadata out of the observable context packet.

This subsystem is intended to diagnose the "huge input / small output" problem with evidence instead of blaming a router or model without measurement.

---

# 34. Current Implementation Status

Status legend:

- **DESIGN** — architecture decided only.
- **PARTIAL** — some implementation exists but product contract is incomplete.
- **IMPLEMENTED** — code exists.
- **FIXTURE VERIFIED** — deterministic test verified.
- **REAL LOCAL VERIFIED** — driven against a real local application/runtime.
- **LIVE EXTERNAL VERIFIED** — tested against a real external account/service.
- **NOT IMPLEMENTED** — absent.
- **PAUSED** — work exists but owner/session is currently unavailable or incomplete.

| Capability | Status | Notes |
|---|---|---|
| Standalone LAIN CLI | **REAL LOCAL VERIFIED** | Stable expert surface. |
| CLI simplified one-surface UX | **REAL LOCAL VERIFIED** | Recent finishing work landed. |
| CLI authoritative execution timer | **REAL LOCAL VERIFIED** | Duplicate/dead timer fixed. |
| CLI primary token cleanup | **IMPLEMENTED** | Detailed metrics behind `/token`. |
| CLI geometry rails | **REAL LOCAL VERIFIED** | Shared horizontal frame fixed. |
| CLI hard-glue removal | **IMPLEMENTED / VERIFIED** | Retry/resume/reasoning glue removed from durable feed. |
| `/model` single advertised command | **REAL LOCAL VERIFIED** | `/models` hidden compatibility alias, and it is genuinely typable: the command palette used to swallow Enter for any line it could not offer, so the alias ran through a pipe and did nothing in the TUI. |
| `/plan` / `/goal` bare-command fallback | **REAL LOCAL VERIFIED** | Interactivity is decided from `input.isTTY`, not from whether a screen is drawn. A piped run reads the plan/goal out; a real terminal still gets the editor. Six smoke failures across four files had this one cause. |
| Live strip accounting | **IMPLEMENTED** | The `↑ ⚡ ↓ +…` session cluster is `/token`; the header's OUTPUT figure is the one authoritative token signal on the primary surface. |
| `/goal` | **IMPLEMENTED** | Editable durable goal. |
| `/plan` editor UX | **IMPLEMENTED** | Replace/Add/Cancel. |
| `plan_step` lifecycle | **IMPLEMENTED** | Evidence-gated completion preserved. |
| `/copy` summary semantics | **REAL LOCAL VERIFIED** | Copies task summary from turn records; excludes live UI/activity noise. |
| `/copy context` | **IMPLEMENTED / REAL LOCAL VERIFIED** | Chronological, from the initiating user turn, built from `session.turns`. `steerTexts` holds `{step,text}` RECORDS, not strings — a projection that stringified them emitted `[object Object]`. `publicText` extracts the sentence or OMITS the entry; it never stringifies. |
| Native terminal selection cleanup | **IMPLEMENTED / REAL LOCAL VERIFIED** | Capture defaults OFF and `/mouse` persists. The WHEEL is unavailable in that mode by construction (it arrives as SGR buttons 64/65, which need mouse reporting), so the scroll hints now name the keys — `↑ more · PgUp` — and `/mouse` states the trade. No hybrid wheel + native drag selection exists under VT input. |
| Engineering Chat/Coding shared session | **IMPLEMENTED** | Backend/session semantics landed. |
| Runtime/local model source | **IMPLEMENTED** | Existing LAIN source. |
| ChatGPT.com model source | **FIXTURE VERIFIED** | Not real-account verified. |
| Gemini.google.com model source | **FIXTURE VERIFIED** | Not real-account verified. |
| Dynamic web-model discovery | **FIXTURE VERIFIED** | Live site selectors not certified. |
| Persistent WebModel browser profile | **IMPLEMENTED** | Separate from verification profile. |
| `/app` Harness HTTP prototype | **REAL LOCAL VERIFIED** | Temporary loopback prototype opens in Harness-owned Chromium app-window mode. Still CLI-process-owned, not the final desktop boundary. |
| Harness local auth — no password | **REAL APP VERIFIED** | The retired startup password and `/api/login` are gone (410). The window LAIN opens trades a single-use launch token for a signed HttpOnly SameSite=Strict session (per-user key in the config home) that survives reloads, new windows and LAIN restarts. Host (rebinding) and Origin/`Sec-Fetch-Site` (forgery) are checked on every request; a hand-opened window with no session gets a reconnect screen, never a password box. Proved against the real Chromium 153 app window polling the real server. Provider/account/remote auth and the `/dash` password are untouched. |
| Unified mutation transaction | **IMPLEMENTED / FIXTURE VERIFIED** | `src/mutation.js`: every LAIN-controlled source write — edit, patch, write, move, delete, symbol edits, rename, migration activation, worker proposals — runs AUTHORITY → BASELINE → STALE → CHECKPOINT → APPLY → STRUCTURAL → REFRESH → VERIFY → KEEP/REVERT → RECEIPT. REVERT reverses only its own hunk when a file changed concurrently, and says REVERT_CONFLICT rather than guessing. Main executor KEEPS a non-parsing intermediate state (refactors pass through it); bounded workers and failed verifications REVERT. |
| WorkOrder scope + stale enforcement | **IMPLEMENTED / FIXTURE VERIFIED** | `src/workorderguard.js`: a BOUNDED order denies writes outside `writeScope` (file, glob, or `file::symbol` checked by line span), reads outside `readScope`, and shell commands; baselines measured at issue refuse a changed target as STALE_WORK_ORDER without overwriting or aborting the task. Expansion is requested by the worker and granted only by user or LAIN. The main executor and `/bg` forks are unbounded. |
| Proposal → LAIN commit | **IMPLEMENTED / FIXTURE VERIFIED** | `src/proposal.js`: `stage` runs a worker's edits against a copy; `commit` applies through the transaction, verifies, settles (VERIFIED only with LAIN receipts; REJECTED stays open). `/bg` completion settles its order from transaction receipts and verification runs, never from prose. No parallel workers exist. |
| Verify Contract | **IMPLEMENTED / FIXTURE VERIFIED** | `src/verifycontract.js`: TARGETED/IMPACT/SUBSYSTEM/PROJECT/RELEASE selected from change impact; escalation stops at the first failing tier; failures classified CAUSED_BY_CURRENT_TASK / RELEVANT_PREEXISTING / UNRELATED_PREEXISTING / CONCURRENT_FOREIGN / ENVIRONMENTAL / UNKNOWN_CAUSALITY; TASK PASSED ≠ PROJECT CLEAN ≠ RELEASE READY; evidence states CLAIMED … LIVE_VERIFIED. `run_tests` records runs; `.lain/validation` keeps them with proof. |
| Project freshness | **IMPLEMENTED / FIXTURE VERIFIED** | `src/freshness.js`: FRESH/STALE/PARTIAL/UNKNOWN derived from disk for index, symbols, imports, fingerprints, architecture, concepts, wiring, memory and validation; semantic records carry `proof` fingerprints. Reported by `understand`. |
| External dirty tracking | **IMPLEMENTED / REAL LOCAL VERIFIED** | Recursive `fs.watch` from project open marks paths dirty; the next index query re-measures only those. Windows 8.3 short-name paths are resolved first (they abort libuv's watcher otherwise). Falls back to the stat walk. |
| Foreign-project bootstrap | **IMPLEMENTED / FIXTURE VERIFIED** | `src/bootstrap.js`: enumerate → languages → parse → symbols → imports/dependents → topology → baseline fingerprints, no model; the baseline is taken before the first LAIN write. |
| `.lain` schema / migration | **IMPLEMENTED / FIXTURE VERIFIED** | `src/lainschema.js`: `schema-version.json`, backup, deterministic migration, validation, restore on failure, explicit rollback. v2 adds `proof`; older records are marked `pre-schema-2` (UNKNOWN), never back-filled from today's disk. |
| AGENTS.md | **IMPLEMENTED / FIXTURE VERIFIED** | `~/.lain/AGENTS.md` then `<project>/.lain/AGENTS.md`, in the cached prompt prefix, labelled as instructions not permissions; a bounded order stays bounded whatever it says. |
| Compaction safeguards | **IMPLEMENTED / FIXTURE VERIFIED** | Route-independent read receipts (read_file, read_symbol, `sed -n`/`cat`/`head`/`tail`/`awk NR`/`Get-Content`) survive compaction; an unchanged read is served from its receipt instead of re-run; the same read three times under an identical goal/task/step/fingerprint/mutation/validation state is NON_PROGRESS and steers to the pending action in a tool result. NEEDS_AUTH clears when a provider answers; once-per-turn opening facts ride only step 0. |
| `continue` visibility | **IMPLEMENTED / REAL TTY VERIFIED** | Text a person typed (including `continue` resubmitted through a recovery, and an idle steer) is `typed` and drawn once as the user in the CLI feed, the dashboard/Harness projection and `/copy`; LAIN's own synthetic resumes stay captioned. |
| Ctrl+PgDn jump to latest | **REAL TTY VERIFIED** | `ESC[6;5~` / `ESC[6^`; one global meaning — the conversation to its newest row, following again — with any inspector left untouched. |
| `/diff` persistent inspector | **IMPLEMENTED / REAL TTY VERIFIED** | Panel KIND.INSPECTOR: not replaceable by output/advisories, not a wait, closed only by the user. Overview dot blue/green/red by file state; detail lines green/red/neutral with line numbers; ←/→ files, Enter, Esc back then close; live counters from the one snapshot system. |
| Header output tokens at three figures | **REAL TTY VERIFIED** | The header used `String(n)` and showed `12400`; it now uses `tok` — `12.4K`, and the carry to `1.0M` — observed in a real pseudo-console. |
| Real-terminal verification tier | **IMPLEMENTED** | `tests/tty/`: ConPTY (pywinpty) + VT emulator (pyte), resize 160/80/60/120/160/232 during streaming with CJK, panels and `/diff`; skips when `LAIN_TTY_PYTHON` is not set. |
| Native LAIN Harness desktop app | **NOT IMPLEMENTED** | Final product boundary. |
| Bundled Harness + CLI installer | **PARTIAL** | CLI packaging exists; desktop bundle not complete. |
| Harness project/session binding | **DESIGN / PARTIAL** | Prototype has session projection; final desktop IPC not done. |
| Structured Harness↔CLI IPC | **NOT IMPLEMENTED** | Required final architecture. |
| Harness Source Workspace | **REAL LOCAL VERIFIED** | Tree, quick open, tabs, line numbers, find, save, content-hash stale-write protection, and single-pass syntax highlighting verified. |
| Live LLM edit visualization | **IMPLEMENTED / REAL LOCAL VERIFIED** | Real patch/write events can surface focused source mutations; continue hardening editor visualization as desktop IPC lands. |
| Web Frontend Workshop core | **REAL LOCAL VERIFIED** | Dev server, preview, element inspect, AX, console/network, viewport, evidence. |
| UI → source mapping | **REAL LOCAL VERIFIED / PARTIAL COVERAGE** | Evidence-backed correlation returns EXACT/LIKELY/MULTIPLE/UNKNOWN and closes a real Harness self-dogfood round trip; generated/ambiguous names are refused honestly. |
| Source → UI highlighting | **PARTIAL** | Selector derivation exists, but corresponding rendered element is not yet visually highlighted in Preview. |
| Harness-owned Chromium runtime | **REAL LOCAL VERIFIED** | Personal Chrome attach path removed. |
| Clean verification Chromium profile | **REAL LOCAL VERIFIED** | Profile cleanup defects fixed. |
| Workshop Chromium profile | **IMPLEMENTED / VERIFIED** | Project-bound browser path exists. |
| HOST/VM environment abstraction | **IMPLEMENTED / FIXTURE VERIFIED** | Host path active. |
| VMware provider | **IMPLEMENTED CONTRACT / NOT REAL VERIFIED** | VMware unavailable on measured machine. |
| Guest runner/bridge | **IMPLEMENTED CONTRACT** | Not real-VM certified. |
| Computer MCP | **IMPLEMENTED / REAL-DESKTOP VERIFIED (V1)** | Compiled Windows UI Automation bridge (`src/computermcp/bridge.cs`), session authorization through one question, structural observation, verified actions and bounded batches. Calculator driven semantically and verified structurally on the real desktop; displays/windows/cursor/screenshot real; disconnect proven to revoke. Notepad + native Save As is implemented and **SKIPS** when a Notepad is already open (it would merge into somebody's unsaved work). Browser → native file picker is implemented and **SKIPS** on Chrome 153 under CDP, which raises no chooser for a scripted click. NOT IMPLEMENTED BY DESIGN: memory scanning, pointer/address work, memory writes, injection. |
| Backend full trace workshop | **PARTIAL** | Logs/network/process capabilities exist, full UI→API→backend mapping not done. |
| Android Workshop | **NOT IMPLEMENTED** | Target capability. |
| Native/Desktop Workshop | **NOT IMPLEMENTED** | Target capability. |
| Blender/3D Workshop | **NOT IMPLEMENTED** | Target capability. |
| 2D/Game Asset Workshop | **NOT IMPLEMENTED** | Target capability. |
| Native Harness photo editor | **NOT IMPLEMENTED** | Required shared capability. |
| Cowork backend | **PARTIAL / ACTIVE** | Shared session/task/activity/approval/job/artifact projection, Harness routes and messaging delivery are implemented and integration verified; account-backed work remains. |
| Bot gateway architecture | **PARTIAL / PAUSED** | Telegram/Discord/WhatsApp architecture substantially landed; live hardening/certification incomplete. |
| Telegram gateway | **IMPLEMENTED / FIXTURE VERIFIED** | Live certification pending. |
| Discord gateway | **IMPLEMENTED / FIXTURE VERIFIED** | Live certification pending. |
| WhatsApp Cloud adapter | **IMPLEMENTED / FIXTURE VERIFIED** | Public webhook/live certification pending. |
| Bot supervisor role | **DESIGN / PARTIAL** | Full external-app supervision not complete. |
| Bot → Computer MCP | **NOT IMPLEMENTED** | Requires Computer MCP. |
| Bot native photo editing | **NOT IMPLEMENTED IN HARNESS** | Must use shared Image capability; local `E:\AI` stack may be used during transition. |
| Cowork spreadsheets | **IMPLEMENTED / INTEGRATION VERIFIED** | CSV/XLSX/XLSM inspection and bounded create/transform tools use the shared artifact authority; legacy XLS conversion remains external. |
| Cowork images/documents | **IMPLEMENTED / INTEGRATION VERIFIED** | Deterministic retouch and DOCX/PDF work produces shared owned artifacts; background removal has real local proof, while configured generation/inpainting has fixture proof and reports provider availability separately. |
| Cowork email | **IMPLEMENTED / INTEGRATION VERIFIED** | Shared draft/search/read/send/archive/delete tools use a configured service process; external mutations require existing interaction approval and keep durable receipts. Live provider proof remains. |
| Add Account / Account Manager | **DESIGN** | Replaces old `/oauth` as a user-facing account abstraction; OAuth/device flow is only one authentication mechanism. |
| Context Cost Observatory | **DESIGN** | Required to explain per-turn input composition and distinguish LAIN context cost from router/provider overhead. |
| Provider-independent Context Builder | **DESIGN / PARTIAL CONCEPT** | One normalized LAIN context packet should feed direct providers, routers, web-model sources, and local models rather than provider-specific context stuffing. |
| Central retry/backoff policy | **IMPLEMENTED / VERIFIED** | Standard recoverable provider schedule is 10/15/30/45/60/90/120/180/300/300s with `MAX(local, trusted Retry-After)` and bounded attempts. |
| B.AI provider | **IMPLEMENTED / FIXTURE VERIFIED** | `https://api.b.ai/v1` in the ONE table; wire URL proved by recording the sender's actual fetch: `https://api.b.ai/v1/chat/completions`. No live account call has been made. |
| Z.AI provider | **IMPLEMENTED / FIXTURE VERIFIED** | Already correct and NOT modified. Wire URL proved as `https://api.z.ai/api/paas/v4/chat/completions`. |
| `/api` add / re-key custom provider | **IMPLEMENTED / FIXTURE VERIFIED** | Naming a route that exists re-keys it under the SAME id; naming a provider with no route adds it preselected; a connection id is never stored as a credential. |
| Structured user-prompt rendering | **IMPLEMENTED / REAL LOCAL VERIFIED** | User messages go through ui/markdown.js, the same renderer model answers use. `=====` separators are recognised as sections. Verified through the real binary at 80/120/160 columns. |
| Artifact authority | **IMPLEMENTED** | Existing Harness capability. |
| Verification authority | **IMPLEMENTED** | Existing PASS/FAIL/INCONCLUSIVE contract. |
| Process/service authority | **IMPLEMENTED** | Existing Harness capability. |
| Browser/CDP core | **IMPLEMENTED** | Used by Workshop/verification/web models through separated lifecycles. |

---

# 35. Immediate Known Product Issues

1. Harness remains CLI-process-owned; closing the owning CLI still closes the current app-window prototype. A genuine desktop process + structured process-boundary IPC is the next architectural blocker.
2. Source → UI selector derivation exists, but the corresponding rendered element is not yet highlighted in Preview.
3. **RESOLVED (FIXTURE VERIFIED).** `/copy context` rendered structured mid-turn user records as `[object Object]`. `turn.js` pushes `{ step, text }` records into `steerTexts`; the projection assumed strings. `copysummary.js` now extracts the public sentence and OMITS an entry that has none — heading included — rather than stringifying it. Hostile shapes (functions, Symbols, Maps, Dates) return empty and never throw. `/copy` itself is unchanged byte for byte.
4. Native terminal selection now works with mouse capture off, but the internal transcript mouse wheel then does not receive scroll events; `/mouse on` restores LAIN mouse interaction at the cost of native selection. Hybrid/default navigation needs a deliberate solution; PgUp/PgDn must remain usable.
5. Provider abort/refusal and continuation runs can still surface excess durable narration/glue in some paths; transient alert semantics must remain authoritative.
6. **PARTIALLY ADDRESSED (UNIT VERIFIED).** Continuation/handover could cause model-driven rediscovery and repeated reads despite evidence/handover infrastructure. Two of the contributing causes are now fixed and covered: (a) a task had no EXECUTOR STATE, so a rate-limited model was indistinguishable from a failed task — `src/task.js` now separates `STATE` (the task) from `EXECUTOR` (the model carrying it), and a provider limit no longer implies the work stopped being wanted; (b) the handover packet said only that "a different model" had been here, which reads as somebody else's property — it now states outright that previous work is **provenance, not ownership** and that the task is unchanged. **STILL OPEN:** the repeated-read / duplicate-resume loop itself (blueprint §35a "Continuation efficiency") is NOT fixed; no duplicate-resume breaker exists and the step-repetition failure has not been reproduced under instrumentation.
7. Shell dialect leakage remains observable: models can still attempt bash idioms such as `tail` in PowerShell contexts instead of using shell-neutral deterministic tools. **Measured this pass and the specific reported symptom did not reproduce**: through the shell LAIN resolves (pwsh 7) every failure shape already exits non-zero, and `| tail -30` SUCCEEDS here because `tail` exists in Git's `usr/bin`. A speculative `$LASTEXITCODE` epilogue was written, measured to change nothing, and removed rather than shipped.
8. **RESOLVED (REAL-DESKTOP VERIFIED), with two named gaps.** Computer MCP V1 exists: `/mcp computer` asks once, grants for the session, and revokes on disconnect or session change; observation is structural (UI Automation) before pixels; every action carries a verdict and an unverifiable one is INCONCLUSIVE, never PASSED. Three real defects were found by running it against this machine and are fixed: (a) window titles were matched by SUBSTRING, so a wait for the `Open` dialog resolved to a browser window called "Welcome back - OpenAI - Helium" and the next step typed a path into that window's address bar — matching is now exact-first then WHOLE-WORD, ambiguity is refused, and a `pid` narrows the search (`MatchTitle`, and the same rule in `src/computer.js`); (b) window enumeration excluded OWNED windows, which is exactly what every modal dialog is, so native dialogs were invisible to `window.list` and every `wait.window` — it now enumerates top-level windows and reports `owner`/`dialog`; (c) the MCP transport imposed a flat 15s deadline under `wait.*` operations that carry their own timeout, so any wait longer than that failed as "no answer within 15s" — the deadline now follows the wait the caller asked for, bounded (`mcp.callDeadline`). **STILL OPEN:** the Notepad Save As flow and the browser file-picker flow are implemented but have not been observed end to end on this machine (a Notepad with unsaved work is open; Chrome 153 under CDP raises no native chooser).
9. VMware clean proof cannot be REAL LOCAL VERIFIED until a Harness-owned VMware environment is actually available.
10. WebModel ChatGPT/Gemini remain fixture-verified rather than live-account certified.
11. Cowork file/artifact/background work plus configured email/calendar/contact/reminder/note workflows are integration verified; Add Account UI and live provider/platform certification remain.
12. Shared native photo/image editor has not yet been promoted into a first-class Harness capability usable by Chat/Coding, Cowork, and Bot.
13. Android, Blender/3D, 2D/game-asset, and richer native-desktop workshops are future work.
14. Add Account / account management and context-cost observability are designed but not implemented.
15. **RESOLVED (UNIT VERIFIED).** Terminal display width was measured with `String.length`. A provider
    error containing CJK (`鉴权服务请求失败`) occupies two cells per glyph and was measured at half its
    true width, so every row carrying it was padded past the right-hand rail. Reported as "text escapes
    the content rails on resize"; the cause was the ruler, not the rails. `ui/text.js` now measures
    East Asian Wide/Fullwidth at two cells, combining marks and format characters at zero, advances by
    code point (so a surrogate pair can never be split), and `ui/doc.js` drops its divergent copy of the
    hard-slice. Box rules, arrows and ticks are deliberately still one cell.
16. **RESOLVED (UNIT VERIFIED).** Command panels closed themselves without user interaction. `/lain`
    and `/jobs` declared no `flashMs` and inherited a 1,500ms self-destruct intended for receipts. The
    default in `src/commands.js` is now STAY, and the fourteen genuine receipts opt in — a per-command
    patch would have left the next inspector with the same defect.
17. **RESOLVED (UNIT VERIFIED).** The header token figure combined input, cache reads, output and the
    open request, and its compact formatter printed `1000K` (four significant figures in a three-figure
    unit) for values between 999,500 and 999,999. The row now states OUTPUT only; `/token` keeps the
    rest with its provenance.
18. **RESOLVED (REAL TTY VERIFIED — see §0a).** Originally: `/diff` as a persistent bottom inspector (overview, file detail, live counters, tab navigation) is
    **NOT IMPLEMENTED**. `/changes` and `ui/diffreel.js` exist and are the place to build it.
19. **NOT REPRODUCED (LIVE EVIDENCE AGAINST).** The authoritative work timer (`ui/workclock.js`) was
    reported as having "disappeared". The `quietsurface` smoke case spawns the real binary through a
    PTY, runs a turn, and asserts `HH:MM:SS` both mid-turn and on the settled row — and it passes. That
    is real-TTY evidence the timer is drawn. If it is still missing in practice the report needs a
    width, a terminal and a sequence, because the tested path is green.
20. **RESOLVED (UNIT VERIFIED).** `/goal` was not reaching background work. `jobrunner.forkSession`
    named the session fields it wanted (`task`, `mode`) and `goal` was not among them, so every
    background job — `/bg`, a Bot `/bg`, a Harness-app job — ran without the user's standing direction
    and nothing reported it. A hand-maintained field list cannot be made correct, so the fork is now
    built from the canonical projection (`src/authority.js`). Two further defects were fixed on the way:
    `{ ...task }` produced a plain object with no `Task` methods, and `Task.from()` ADOPTED the live
    arrays `toJSON()` returns, so a fork and its parent shared one `steers` array — a worker's
    instruction appeared in the foreground task's own record as if the user had said it.
21. **RESOLVED (UNIT VERIFIED).** `plan.objective` was a third objective-shaped authority: `plan_write`
    took the MODEL's objective in preference to the task's, and its schema invited one ("optional
    one-line restatement of the goal"). The field remains for serialization compatibility but is now
    derived from the task, and a model-supplied label that shares no content with the task or the goal
    is dropped and reported. The steps still land — refusing real work over a display string would lose
    it.
22. **RESOLVED (FIXTURE VERIFIED — src/workorderguard.js, see §0a).** Originally: `readScope` / `writeScope` / `dependencyScope` on a WorkOrder are **DECLARED AND NOT ENFORCED**.
    Nothing refuses a worker that writes outside its lane; a prompt asking it to stay there is an
    instruction, not an authority. Runtime enforcement is a later pass.
23. A WorkOrder is **NOT PERSISTED**. `Session.toJSON` is an allowlist that omits it and the job
    registry is in-memory, so an order lives as long as its job — consistent with `/bg` today, and a
    blocker for resuming a worker across a crash. The serialization exists so that is wiring rather
    than redesign.
24. `forkSession` still copies the parent's entire `messages` array. A worker should receive a bounded
    projection rather than the whole parent session; changing this changes what `/bg` can do and needs
    its own verification.

# 35a. Architecture Corrections Discovered

- **Desktop boundary:** Chromium `--app=` is useful prototype presentation, but does not make Harness a genuine independent desktop process. Final Harness must communicate with LAIN runtime through structured IPC and remain alive independently of an originating CLI terminal.
- **Mouse ownership:** native text selection and LAIN transcript wheel navigation compete under terminal mouse-reporting modes. `/mouse on` is an explicit full-interaction mode, not the default fix. The product must preserve native selection by default and provide reliable keyboard transcript navigation even if true hybrid wheel capture is unavailable in the host terminal.
- **Diagnostic context projection:** `/copy context` is correctly record-based, but record serialization must project public semantic content rather than blindly stringifying structured payloads.
- **Continuation efficiency:** durable handover/evidence should allow a resumed model to continue from verified/unverified state rather than reacquiring the same files and facts after every interruption.
- **Account abstraction:** `/oauth` is too implementation-specific. The product concept is now **Add Account**, separating account/authentication, provider, model inventory, and routing.
- **Executor state is not task state:** a provider rate limit is a fact about a provider, not about
  whether the work is still wanted. A task carries its own lifecycle and, separately, the state of the
  model currently carrying it. A model switch continues the same task with the same id, objective,
  steers and evidence.
- **Provenance is not ownership:** the record of who changed a file answers "where did this come from",
  never "who may change it next". There is deliberately no field in a task record in which a claim of
  ownership over a file or subsystem could be written down. The user's current task decides scope.
- **A failed test is evidence, not authorisation:** a broad run surfaces every broken thing in the
  repository, including another task's unfinished work. Such failures are recorded on the task
  (`foreignFailures`) so they can be reported without being adopted, and so TASK COMPLETE and PROJECT
  CLEAN remain two separate claims.
- **Display width is a measurement, not an assumption:** one function owns how many terminal cells a
  string occupies, and every painted region inherits it. Where a width is genuinely ambiguous the error
  is biased to OVERCOUNT — an overcount wraps early and costs whitespace, an undercount draws past the
  rail.
- **A panel closes when the reader says so:** output that confirms an action may clear itself; output
  that is state to READ waits to be dismissed. The default must be the second, because getting it wrong
  that way costs one keystroke while the other way silently takes away the answer.
- **One authority chain, projected once:** `goal → task → plan → work order`. Every consumer that
  needs to know what work is FOR asks `authority.project()` rather than picking session fields. It is a
  PROJECTION and never a store — it can be deleted and rebuilt from the session, which is the test of
  whether it has stayed one. Four independent field-picking consumers were four answers to one
  question, and that is how a background job came to lose the goal.
- **A rung may narrow the one above it, never replace it:** the goal is the durable outcome, the task is
  the bounded unit of work, the plan is one revisable strategy, the work order is one executor's exact
  assignment. A plan objective that shares no content with the task or the goal is a contradiction and
  is reported rather than stored.
- **Goal supersession is reported, never applied:** only `/goal` writes the goal. A classifier that
  acted on its own verdict would be the turn quietly rewriting the direction. The default is
  CONTINUES_GOAL, because almost everything a person types during a project is another task under the
  same direction; only a cancellation with no named successor is worth a question.
- **One background seam:** `app.startBackground` → `jobrunner.forkSession` is the single entry point
  shared by `/bg`, the Bot runtime and the Harness app. One work-order authority with different
  executor backends — never three orchestrations to reconcile afterwards.
- **A claim is not a completion:** a WorkOrder's `claim()` records what a worker said; `verified()`
  refuses without at least one LAIN-gathered receipt. CLAIMED and VERIFIED are two states, and the
  refusal is what stops `verified()` becoming a setter reachable from a claim in one line.
- **Cowork is adopted, not redesigned:** its ownership boundary (harness task `sessionId` + `workspace`,
  checked against the real path) is untouched. The authority chain is projected onto the Cowork surface
  as orientation and is never an authorisation input.
- **Context-cost truth:** router/provider comparisons are meaningless unless LAIN can report the actual normalized context packet it sent. Context accounting must be first-class and provider-independent.

---

# 36. Recommended Implementation Order

## Phase A — Desktop Foundation

1. Native Harness desktop shell.
2. Bundle Harness + CLI.
3. Project opening.
4. Session binding.
5. Structured IPC/Core bridge.
6. Background LAIN execution.
7. Optional integrated PTY.
8. Retire manual-password `/app` UX.

## Phase B — Source + Web Workshop Integration

1. Source Workspace.
2. File tree/quick open.
3. Editor/diff.
4. Live LLM patch visualization.
5. UI candidate highlighting.
6. UI → source opening.
7. Source → UI highlighting.
8. Selection → Ask LAIN/Fix.
9. Dogfood: use LAIN Harness to improve LAIN Harness.

## Phase C — Computer MCP

V1 landed 2026-09-14. State per item, and the evidence tier behind each:

1. Windows UI Automation — **DONE (REAL-DESKTOP VERIFIED).** `src/computermcp/bridge.cs`, compiled once per source hash (~200 ms) and cached.
2. Displays/windows — **DONE (REAL-DESKTOP VERIFIED).** Including OWNED windows, so native dialogs are visible; each row carries `pid`, `handle`, `owner`, `dialog`.
3. Structured control discovery — **DONE (REAL-DESKTOP VERIFIED).** `uia.tree` / `uia.find` / `uia.getValue`; a cloaked store app is raised and polled rather than reported empty.
4. Mouse/keyboard fallback — **DONE.** Used only when a control cannot be reached semantically; `act` reports which method delivered.
5. Observation → action → observation → verification — **DONE (REAL-DESKTOP VERIFIED).** `act` observes the start state, performs, observes the result, and returns a VERDICT; with nothing to check the verdict is INCONCLUSIVE. `batch` stops on FAILED, and on INCONCLUSIVE unless the caller allows it.
6. Host target — **DONE.**
7. VM target contract — **NOT DONE.** Unchanged by this pass.
8. Harness UI projection — **DONE (IMPLEMENTED).** `state.computer` projects target, steps and verdicts; the Computer card offers exactly [View computer] and [Stop] (`/api/computer/view`, `/api/computer/stop`). Not yet exercised through the real page.
9. Bot/Cowork reuse — **NOT DONE.** The capability is Core-owned and reachable, but no Bot or Cowork flow uses it yet.

**Out of scope in V1, deliberately:** process-memory scanning, address/pointer work, memory writes, injection, trainer behaviour. `tests/unit/desktop.test.js` fails if an operation crossing that line is ever added to the seam.

## Phase D — Backend Depth

1. Route/API tracing.
2. Logs/process correlation.
3. DB/schema tools.
4. UI event → network → backend route graph.
5. Backend evidence UI.

## Phase E — Android

1. Android SDK/ADB.
2. Emulator.
3. Build/install.
4. Layout/accessibility.
5. Device presets.
6. UI ↔ source where practical.
7. Verification.

## Phase F — Creative Tools

1. Shared native Image capability/editor.
2. 2D asset/sprite workflow.
3. Blender/3D adapter.
4. Structured Blender operations.
5. Game-character workflow.
6. Artifact export.

## Phase G — Cowork + Bot Completion

1. Cowork file workflows.
2. Spreadsheet.
3. Documents.
4. Email.
5. Image/photo.
6. Reminders/calendar.
7. Bot supervision.
8. External AI app observation.
9. Telegram/Discord/WhatsApp live certification.
10. Remote artifacts/approvals/background notifications.

## Phase H — Release

1. Clean install.
2. Installer bundle.
3. Harness-owned Chromium package.
4. VM certification.
5. Windows desktop smoke.
6. Project migration/resume.
7. Security review.
8. Performance.
9. Documentation.

---

# 37. Dogfood Acceptance Goal

The strongest LAIN Harness proof is:

> Use LAIN Harness to improve LAIN Harness.

```text
Launch LAIN Harness desktop
        ↓
Open lain-v2
        ↓
Engineering session attaches/starts LAIN
        ↓
Open Harness frontend source
        ↓
User selects a UI element in live Harness
        ↓
Harness asks which candidate if ambiguous
        ↓
User clicks target
        ↓
Source editor opens exact related code
        ↓
relevant code is highlighted
        ↓
LAIN applies a real patch
        ↓
editor highlights the actual mutation
        ↓
Workshop reloads
        ↓
UI object updates
        ↓
desktop/mobile verification
        ↓
console/network checks
        ↓
before/after artifacts
        ↓
evidence-backed completion
```

---

# 38. Example: Ambiguous Button Repair

User:

> Fix that button.

Harness detects multiple candidate controls.

```text
Which button?

[1] Save — Settings
[2] Save — Editor toolbar
[3] Save — Account
```

Candidates are highlighted in Preview.

User clicks `[2]`.

Harness resolves:

```text
visible button
→ AX node
→ DOM node
→ component
→ source
```

Source opens:

```tsx
<Button opacity={0.2}>Save</Button>
                 ^^^
```

LAIN changes:

```tsx
<Button opacity={0.5}>Save</Button>
```

Harness displays the real patch:

```diff
- opacity={0.2}
+ opacity={0.5}
```

The changed range is highlighted.

Preview updates.

LAIN verifies the selected button, not the other Save buttons.

---

# 39. Example: Bot Supervises Claude

User on Telegram:

> Check if Claude is still working.

Bot:

1. checks LAIN-owned/native process/session state if authoritative,
2. if insufficient, invokes Computer MCP,
3. observes Claude application,
4. identifies current visible state,
5. replies with evidence-based status.

Bot should not infer "working" from PID existence alone.

---

# 40. Example: Bot Edits a Photo

Telegram:

```text
[photo]
remove the background and clean the lighting
```

Flow:

```text
Telegram adapter
→ Bot
→ shared Image capability
→ background removal
→ lighting adjustment
→ artifact
→ Telegram attachment
```

The image editor belongs to Harness capability infrastructure, not Telegram code.

---

# 41. Capability Discovery Principle

The Harness should expose task-relevant capabilities, not every tool at once.

Examples:

Node backend project:

```text
Source
Terminal
Backend
Tests
Database
Browser if needed
```

Android project:

```text
Source
Android
Emulator
ADB
Logcat
Verify
```

Blender character task:

```text
Source/assets
Blender
Image
3D
Render
Artifacts
```

Excel Cowork task:

```text
Spreadsheet
Files
Artifacts
```

---

# 42. Security / Trust Principles

1. One canonical machine trust/permission authority.
2. Messaging authorization is separate from machine permission.
3. WebModel output is untrusted external content.
4. Browser profiles remain isolated by purpose.
5. Computer MCP requires explicit session authorization.
6. Do not scrape/store credentials in model context.
7. Do not expose arbitrary host/guest paths as artifacts.
8. Do not let frontend UI become a second filesystem authority.
9. Do not let VM isolation imply unlimited network/host permission.
10. Do not create separate permission engines per workshop.
11. LOCAL DESKTOP AUTH ≠ REMOTE AUTHORIZATION ≠ PROVIDER AUTHENTICATION. The local Harness has no password: a signed per-user session plus Host/Origin checks (`src/harnessapp/localauth.js`). Remote surfaces (Telegram/Discord/WhatsApp allowlists, remote approvals, the network-reachable `/dash`) and provider/account credentials keep their own, separate controls.
12. AGENTS.md is behaviour; runtime is authority. Scope, staleness and verification are never delegated to prompt compliance.

---

# 43. Architecture Anti-Patterns — FORBIDDEN

Do not build:

- another LAIN Core inside Harness,
- another task runtime,
- another verification engine,
- another event bus,
- another process manager,
- separate model-specific tool ecosystems,
- a second Cowork brain for Telegram,
- a second Computer controller for Bot,
- screenshot-only desktop automation when structured UI exists,
- a permanent giant dashboard,
- an IDE clone where every tool is always visible,
- fake success from UI shells,
- fake activity states from timers,
- automatic source mappings without evidence,
- a frontend that parses ANSI CLI output to infer Core state.

---

# 44. Definition of Done for a Capability

A capability may be called **IMPLEMENTED** when code exists and its real contract is wired.

A capability may be called **FIXTURE VERIFIED** when deterministic fixtures exercise the actual orchestration path.

A capability may be called **REAL LOCAL VERIFIED** only when driven against a real local app/runtime.

A capability may be called **LIVE EXTERNAL VERIFIED** only when tested against the real external service/account.

---

# 45. Blueprint Maintenance Rules

When an implementation report is received:

1. locate the capability in **Current Implementation Status**,
2. update status,
3. add evidence/known limitation,
4. update architecture only if implementation revealed a genuine design correction,
5. do not delete future requirements simply because current implementation is incomplete.

When the user says:

> add this to the blueprint

update the relevant architecture section.

When the user says:

> this changed

mark the previous decision superseded and update the frozen rule.

When the user says:

> implement this

the implementation prompt should reference this blueprint and preserve unrelated sections.

---

# 46. Current North Star

LAIN Harness should become:

> **A model-agnostic desktop workbench where the user, the LLM, source code, the running application, backend state, creative tools, desktop applications, and verification evidence are connected into one observable execution environment.**

The defining experience is not:

> "Chat with an AI that tells me what code to change."

It is:

> "Show LAIN the thing I want changed, let LAIN identify the exact object and source, watch the real change happen, run the result, inspect the outcome, and verify that the intended thing actually changed."

And outside coding:

> "Give LAIN something to do, or ask Bot to supervise what is happening, using the same shared capabilities regardless of which LLM is currently selected."
