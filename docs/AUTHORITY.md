# LAIN — the authority matrix

One authority per transition. Not "everything in Rust": Node is a legitimate
adapter wherever it only executes what a runtime has admitted or what is purely
local state. This file is the contract; when code and this file disagree, one
of them is a bug.

| Domain | Authority | Node's role |
|---|---|---|
| Input admission / held input | Rust Guardian (`offer`/`deliver`) | asks, obeys, recovers (inputgate.js) |
| Turn lifecycle truth | Rust Guardian (`turn_begin/phase/end`, owner-pid liveness) | reports facts; word-maps the outcome, judges nothing |
| **Request admission** | **Rust Guardian (`request_begin/end`)** — wired since the request-admission pass | turn.js awaits begin BEFORE the wire; denial ⇒ zero provider calls; every retry its own request id |
| Provider transport execution | Node adapter (provider.js) | sends what the runtime admitted; classified failures only |
| Provider health / rate limits (durable) | Rust supervisor (providers.rs) | availability.js is a process-local cache, refreshed before failover decisions |
| Compaction | Node ContextAuthority | the deliberate Node-side authority; Guardian owns lifecycle, not context |
| Prompt construction / cache shape | Node (promptparts/promptcache) | stable prefix + volatile tail |
| Tool implementation / dispatch | Node (tools/) | primitives stay; capability intent composes them |
| Project intelligence | `<project>/.lain/` via lainstore (sole path authority) | adapters only; the model may record intent through the four doors, never silently |
| Structural index | `.lain/index.json`, never read without checking disk | projectindex.js refreshes; no stale accessor exists |
| Architecture intent vs observed | `.lain/architecture` (intent) + reconcile.js (the ONLY writer of `observed`) | two axes never collapsed |
| Runtime notes | `~/.lain-v2/concerns/<project>.json` (`/note`) | session-scoped observations; NOT project truth |
| Evidence-backed facts | `.lain/memory/facts.json` (scratch promote) | promotion refused without evidence |
| Scratch | `.lain/scratch/<session>` | opened per turn, settled only on completion |
| Undo / source safety | checkpoint/undo subsystem; ONE snapshot system | truncation guard, verified-text edits, atomic writes |
| Conversation | session transcript | compacted in place; nothing durable deleted |
| Background shell jobs | supervisor (jobs.rs) | survive CLI death |
| `/bg` agent jobs | Node process (forked session) | die with the process; scratch survives — see classification below |
| Remote capability validation | Rust capability catalog (closed) + `unsupported_numbers` | brain.rs interprets, never commands |
| LLM reasoning | the model | may propose; the runtime decides what is allowed to happen |

## STEER IS NOT ORDINARY USER INPUT

It is a **privileged session-scoped control channel**, deliberately outside
Guardian input admission:

- accepted only for an active session/turn (steerqueue.js);
- delivered only at safe step boundaries (turn.js, between steps);
- preserved in the turn record (`record.steerTexts`, with the step it landed);
- cannot create an independent turn (it never calls submit);
- does not bypass request admission — it changes what the next admitted
  request says, and that request is admitted like any other;
- does not invoke provider transport directly.

Routing it through ordinary admission would add a round trip to a correction
whose session already passed the gate. This is a boundary decision, not an
oversight; guard it here.

## `.lain` status vocabulary

Say all four or say nothing:

    MACHINERY  the code paths exist and are tested
    POPULATED  this repository has real records
    CONSUMED   something reads them on a real path
    ENFORCED   something refuses to work without them

As of the request-admission pass, for THIS repository: architecture/dictionary/
wiring/validation are **machinery, unpopulated** (index.json and scratch are
populated; facts when promoted); architecture is consumed by handover and
`/lain` only; nothing is enforced. "Implemented" alone is a banned word for
this layer — it is how machinery came to be reported as intelligence.

## Decisions that look like gaps but are not

- **No persisted call graph.** imports/dependents/locate already answer the
  questions a call graph would, refreshed against disk; wiring records the
  edges no import graph can express (WAKES/BLOCKS/SENDS). Persisting a derived
  view would add a second thing to age. Derived stays derived.
- **Model switch: Guardian records intent, Node executes.** Rust owns the
  durable boundary (requested_model, handover arming); the execution needs the
  session's provider state that lives in Node. Adapter, not competing
  authority.
- **Browser is CLI-process-owned CDP; `/bg` agent jobs
  are Node-process-owned.** Neither is a supervisor worker yet — both die with
  the CLI process (scratch and session files survive). Classified P3: moving
  them is future work, not an oversight, and must not be assumed safe.

## The boot-window rule

A runtime that is not running cannot be an authority — for input (offer
degrades to deliver) and for requests (`requestBegin` returns null ⇒ allow).
A **booting** runtime is equally not an authority *for requests*: the first
request of a turn fires microseconds after `turnBegin` armed `wake()`, and
admission that waits out the boot stalls the hottest path in LAIN. Lifecycle
tells still queue behind the boot and land when it completes; the request
boundary arms from the first request made with a runtime already up. This is
the fix for the parked-question regression and is guarded by the fourth test
in tests/integration/requestadmission.test.js.

## One authority for every shared truth (the Harness consolidation, 2026-09-25)

The CLI and the Harness are two surfaces over the same Core. "Both call the same
server" is not enough: every truth both surfaces rely on has exactly one owner
in Core, and the Harness contributes surface facts and preferences, never a
second decision. Guarded by `tests/unit/oneauthority.test.js`.

| Shared truth | The one owner | What was consolidated into it |
|---|---|---|
| A project mutation and its consequences | `mutation.transact` / `mutation.change` — actor `USER` / `MODEL` / `CORE` / `TOOL`, origin | editor save, IDE create/move/delete/save-as/replace, git checkout, LSP rename, extension edits (previously direct fs writes); geometry/selection jobs and turnclose no longer record consequences themselves |
| Consequences of a change | `mutation.consequences`: editledger provenance, the project generation, GUG stale-marking, the `project.delta` event | five call sites that each did part of it |
| The project generation | `projectgen.js` — one number per project, persisted beside its provenance and shared by every process on the project; advanced only through `harnesscontext.noteSourceEdit`, whose callers are `mutation.consequences` and an observed EXTERNAL change (`source.freshness`, the transaction's baseline observe) | scattered `noteSourceEdit` calls; then (Phase 4) the per-process in-memory counter |
| What a request means, who executes it | `mode.classify` (+ `intent`) → `dispatch.route` → `identify` (consumes the routed verdict via `dispatch.takeRouted`, never re-classifies) | the Harness's own word regexes in `botroute.decide` |
| A model request | `modelrequest.js` envelope: trace identity, session, task, transport (`api` / `website`), admission, usage receipt | provider.js's own trace; website sends outside any record (chatdispatch, modelsource/check) |
| "This" — the selection | `harnesscontext.selection(app, session)`: resolved once per (referent, project generation), consumed by the context packet, the focus packet and transfers by id | three resolvers (idecontext, focuspacket, harnesscontext) |
| UI → source | `gug.sourceBinding`: GUG node + style owner + component evidence (`uisource` is evidence inside it) | two route-level mappings |
| Work changing hands | `planhandoff` transfers: kinds plan / proposal / delegation / surface, states PROPOSED → PREFILLED / ACCEPTED / DECLINED → SUBMITTED → DONE, persisted in `session.transfers` | `_delegation`, `_agentProposal`, the plan handoff and the /focus entry, each a private record |
| The session journey | `journey.js` (formerly the misnamed `spine.js`): surface, the path events, the Agent's task pointer | — it owns only what no one above owns |

Presentation stays in the window: open tabs, caret, editor groups and the Focus
workspace are the window's own storage, not Core state.

## Phase 4 — the professional tooling keeps the rule (2026-09-25)

| Shared truth | The one owner | Notes |
|---|---|---|
| Language facts about "this" (definition, references, implementations, type, symbols, diagnostics, rename support) | `langfacts.js` — asks the language server about the canonical Selection, in parallel, once per (Selection, generation); falls back to the project index only where no server covers the language, and says which | the focus packet and Laya consume it; the IDE's own Find References route is the only other asker |
| A deterministic result, by name | `evidencerefs.js` — `evidence:eN`, stamped with the project generation, the files it read and the words whose appearance would change it; `exact` / `carried` / `stale`; persisted with the session | also the focus-artifact cache (`focus:<Selection id>:<kind>`) and the Selection's carry-forward rule |
| What the Agent is handed | `focuspacket.js` — research in parallel (language server, GUG neighbourhood, git), rendered from the owners above, kept as an artifact | a consumer: no scanner, parser or resolver of its own |
| A semantic rename | `semanticrename.js` via `rename_symbol` — prepareRename → the server's WorkspaceEdit → every edit checked to replace exactly the identifier → written inside the tool's transaction | falls back to rename.js's JavaScript token rename only when no server can rename |
| What a turn is shown | `toolfunnel.js` — exposure only; `tools/index.js` `execute` still reads the whole active set and counts a call to a hidden tool as a miss | see the prompt audit's F3: a changing tool set costs the prompt cache |
| A debug session | `dap/manager.js` — Debug Adapter Protocol over stdio; adapters are owned processes; the paused state is served by the `debug.context` door on request and never injected (the packet carries one line saying where) | |
| Leaked test supervisors (before the registry) | `legacyprocs.js` — evidence and a classification only; a stop is an explicit act on selected ids, each re-verified | future cleanup is the runtime registry's alone |
| Which VS Code APIs an extension can use | `exthost/surface.js` — the declared surface and a static scan of the extension's entry | compatibility is FULL / PARTIAL / UNSUPPORTED with the missing APIs named |
| The plan a turn follows | `plan.js` — Core seeds a live plan from the deterministic steps it already did (`seedFromCore`); the model ticks the rest | a projection, never a gate |

Laya (layacontext.js) now consumes the canonical Selection by id (`sel:S…`),
the Selection's own language-server evidence (`evidence:eN`), the GUG
neighbourhood, provenance, the language servers' diagnostics, LAIN-owned
runtime processes (from the registry) and the terminal tail; it reads none of
the raw fields the Selection is resolved from. Core still validates every
hypothesis it returns.
