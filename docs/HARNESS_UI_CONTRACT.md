# LAIN Harness — UI contract

**Authoritative for the Desktop frontend.** Everything here exists in Core
today and is covered by tests. Nothing speculative is listed. If a control needs
something not on this page, it is a missing contract — say so; do not infer it
in the page.

Transport: every call is `api(path, body)` from the renderer → native host →
private pipe → `routes.dispatch` (`src/harnessapp/routes.js`). `body === undefined`
is a GET. Every POST body may carry `session: <id>` to act on a live session
other than the one being viewed. Every response is `{ok: true, ...}` or
`{ok: false, why, ...structured flags}`.

Client helper: `LAIN.contract` (`src/harnessapp/pagecontract.js`) wraps every
action below and delivers Core events. Use it or call `api` directly.

---

## 1. Reading state — `GET /api/state`

Cheap and polled; it never launches, connects or refreshes anything. Fields
that already existed (`sessions`, `conversation`, `changes`, `sources`,
`workshop`, `execution`, `harness`, `plan`, `cowork`, `ask`, `computer`,
`viewing`) are unchanged except where noted.

| Field | Shape | Owner |
|---|---|---|
| `header` | `{sessionId, title, project:{attached,name,path,missing}\|null, status:SessionStatus, canStop, actions:['close','delete','openCli']}` | `stateviews.header` |
| `views` | `{active:'chat'\|'coding', available:['chat','coding'], running:'chat'\|'coding'\|null}` — `null` for Cowork sessions | `sessionviews` |
| `conversation[]` | adds `thread: 'chat'\|'coding'`. Chat view renders `chat`; Coding view renders `coding` | `sessionviews.threadOf` |
| `plans` | `{plans:[PlanDoc], draft, accepted, ready, prompt:{planId,title,actions:['accept','edit','defer']}\|null, handoff:Handoff\|null}` | `planhandoff` |
| `composer` | `{chat:{placeholder,canSend}, coding:{placeholder,canSend,prefill:{handoffId,planId,text}\|null}}` | `stateviews` |
| `workspace` | `{openPanel, width, file, project:{attached,root,name,missing}, pins:[Pin], panels:[{id,label,available,badge,needsProject?}]}` | `sessionviews` |
| `models` | `{chat:{source,modelId,scope,label}, coding:{source:'lain',modelId,connectionId,scope,label}}` | `modelinventory.selections` |
| `sessions.engineering[] / .cowork[]` | adds `state: SessionStatus\|null` (live sessions); `status` is still the word | `sessionstatus` |
| `workshop.devServer` | `DevServer\|null` | `workshop/devstate` |
| `diagnostics.environment` | host / browser build / running instruments. **Diagnostics only — not primary UX.** (`environment` remains for compatibility.) | `state.environment` |

---

## 2. Session status — one authority

`SessionStatus = {state, startedAt, elapsed, activeTurnId, taskId, summary, needsUserAction, view}`

| `state` | Means (read from) |
|---|---|
| `IDLE` | no turns yet |
| `RUNNING` | a turn is live (`app.abort`); `summary` says what it is doing; also background tasks |
| `WAITING` | live, provider backoff / rate-limit retry |
| `QUEUED` | admitted by `handle`, turn not begun |
| `NEEDS_INPUT` | a question is open (`needsUserAction: true`, answer with `POST /api/ask/answer`), or lifecycle NEEDS_USER/NEEDS_AUTH |
| `VERIFYING` | live, Harness task VERIFYING or a verification tool running |
| `DONE` | last turn finished (`summary`: `''`, `stopped`, `verified`, `finished — not verified yet`) |
| `FAILED` | last turn did not finish, lifecycle FAILED, or Harness task FAILED — `summary` says which |

- **Timer:** render `elapsed` (ms at read time) or `now - startedAt`. Both come from
  the execution clock (terminal work clock, or the turn-start stamp). Do not start
  a clock on your own events.
- **Stop:** `header.canStop` → `POST /api/interrupt` (with `session` for another session).
- The frontend never derives a status from conversation text.

---

## 3. Events (Core → renderer)

Delivered through `window.chrome.webview` messages; `LAIN.contract.on(type, fn)`.

| Message | Meaning |
|---|---|
| `{wake: 1}` | something moved — read `/api/state` now |
| `{event: {type:'session.status', session, status: SessionStatus}}` | a session's status word/summary changed — **including sessions nobody is viewing**. Update that rail row immediately. |

Emitted from every turn phase, turn end, question opened/answered, and view-turn end.

---

## 4. Chat / Coding

One engineering session, two views, **two threads**, one project. The Coding
wire never carries Chat messages; what crosses is durable state (goal, accepted
plan, pins, evidence).

| Action | Request | Result |
|---|---|---|
| switch view | `POST /api/view/select {view}` | `{view}` — navigation only |
| send | `POST /api/turn {view:'chat'\|'coding', text, now?}` | `{accepted, view}` · same-view running → `{steered, when}` · other view running → 409 `{busy:'chat'\|'coding'}` · Coding without project → 409 `{projectRequired:true}` · missing folder → 409 `{projectMissing:true}` |
| stop | `POST /api/interrupt` | `{interrupted}` |

- **Chat is non-mutating, structurally:** mutating tools are refused
  (`DENIED CHAT_VIEW_READ_ONLY`), LAIN-runtime Chat runs in EXPLAIN mode, website
  sources (ChatGPT.com / Gemini) answer Chat turns only.
- **Coding** runs on LAIN's runtime with the usual trust / permissions / work
  orders / verification.
- `POST /api/turn` without `view` keeps the old (terminal-compatible) behaviour.

### Models per view

| Action | Request | Result |
|---|---|---|
| search | `POST /api/models/search {lane:'chat'\|'coding', query, limit?}` | `{lane, query, selected, total, rows:[ModelRow]}` |
| select | `POST /api/models/select {lane, source, model, connectionId?}` | `{lane, selected}` · `model:''` on coding = back to default |

`ModelRow = {source, provider, modelId, displayName, connectionId, routes, capabilities:{chat,coding,tools,efforts}, availability, authState, locality:'local'\|'external', selected, discover?, why?}`

- Coding lane: LAIN runtime catalog only. Chat lane: runtime catalog + website
  accounts. A website never discovered yields one row with
  `availability:'UNDISCOVERED'` and `discover:{route:'POST /api/source/models', body}`;
  search never opens a browser. Sign-in: `POST /api/source/connect {source}`.
- Selections are **per session, per view**. Changing Chat never changes Coding
  or the process default. `POST /api/source/select` is the same Chat selection.

---

## 5. Plan → Coding handoff

`PlanDoc = {id, state:'DRAFT'|'ACCEPTED'|'SUPERSEDED'|'COMPLETED', title, text, steps[], createdAt, updatedAt, acceptedAt, supersededAt, completedAt, digest, origin:{source,model,editedFrom}}`

- A Chat reply becomes a `DRAFT` when it has ≥2 step lines **and** calls itself a
  plan or answers a message that asked for one (deterministic). `plans.prompt`
  is then set: render **"Plan ready — Continue to Coding?" [Yes] [Edit plan] [Not yet]**.

| Button | Request | Result |
|---|---|---|
| Yes | `POST /api/plan/accept {id}` | `{plan, handoff, view:'coding', composer:{view:'coding', text}}` — plan frozen, previous ACCEPTED → SUPERSEDED, view set to coding. **Nothing executes.** |
| Edit plan | `POST /api/plan/edit {id, text}` | DRAFT edited in place; editing an ACCEPTED plan creates a new DRAFT |
| Not yet | `POST /api/plan/defer {id}` | stays DRAFT, `prompt` becomes null |
| mark any text as the plan | `POST /api/plan/draft {text, title?}` | new DRAFT |
| complete | `POST /api/plan/complete {id}` | ACCEPTED → COMPLETED (also automatic when a submitted handoff's lifecycle reaches DONE) |
| discard prefill | `POST /api/handoff/discard` | handoff DISCARDED, plan stays ACCEPTED |

After Yes: switch to Coding, put `composer.coding.prefill.text` in the composer
(**once per `handoffId`** — don't overwrite the person's edits on later polls),
let the person edit, send with `POST /api/turn {view:'coding', text}`. The
handoff becomes `SUBMITTED`.

`Handoff = {id, planId, state:'PREFILLED'|'SUBMITTED'|'DISCARDED', createdAt, submittedAt, prompt, brief}` where
`brief = {goalId, goal, acceptedPlanId, acceptedPlanDigest, acceptedPlanTitle, acceptedPlanText, steps, userRequirements[], constraints[], projectRoot, relevantFiles[], pins[], projectIntelligenceRefs:{index,freshness,declarations,symbols[{name,at[]}]}|null, evidenceRefs[], existingChanges[], verificationState|null, chatSource}`.
No Chat transcript and no private reasoning is in it.

---

## 6. Project Files

Project Files is the **attached project**, never LAIN's own folder.

| Action | Request | Result |
|---|---|---|
| state | `POST /api/project/state` | `{project:{attached, root, name, missing, attachedAt, sync, intelligence:{freshness,files,declarations,refreshedAt}, pins, openFile}}` |
| add / open project | `POST /api/project/attach {path}` | `{project}` · refused: not absolute, not a folder, LAIN's own folder, drive root, a session already working on another root (409) |
| recent projects | `POST /api/project/recent` | `{recent:[{root,name,lastUsed}], defaultProjectRoot}` |
| tree | `POST /api/files/tree {path}` | `{path, root, entries:[{name,path,dir,text,size,changed}]}` · no project → 409 `{projectRequired:true}` |
| open | `POST /api/files/open {path}` | `{path, body, language, hash, mtimeMs, size, lines, changed, pinned}` — also records the open file as panel state |
| search | `POST /api/files/find {q}` | existing shape |
| diff | `POST /api/files/diff {path}` | `{path, changed, kind, added, removed, lines[]}` |
| pin | `POST /api/files/pin {path, from?, to?}` | `{pins}` (max 12) |
| unpin | `POST /api/files/unpin {path}` | `{removed, pins}` |
| save / freshness | existing `POST /api/files/save`, `/api/files/freshness` | unchanged |

- **Browsing ≠ context.** Opening a file puts nothing in a prompt. A **pin** puts a
  bounded, current excerpt into the Coding context ("Pinned by the user").
- New sessions: `POST /api/session/new {lane, project?, inherit?}` — `project`
  attaches explicitly; otherwise an engineering session inherits the viewed
  session's project **only if that one is attached**; else it starts with no
  project (`header.project.attached === false`). Reopened sessions are
  re-validated (`project.missing`) and reconciled.

---

## 7. Workspace panels (Coding)

`workspace.openPanel ∈ NONE | PROJECT_FILES | CHANGES | PLAN | TERMINAL | WORKSHOP | VERIFICATION` — one at a time, Core-held, persisted with the session.

`POST /api/workspace/panel {action:'open'|'close'|'toggle'|'set', panel?, width?, file?}` → `{panel:{open,width,file}}`

- Render from `workspace.openPanel`; never from button highlight.
- Close: an explicit ✕ → `close`; the Project Files button → `toggle`; `Esc` →
  `close` when focus is not in an editor with unsaved changes.
- `width` (240–2400) and `file` survive close/reopen. Closing a panel has no other effect.
- `panels[].available` says which to offer; `needsProject` means show Add project inside it.

---

## 8. Workshop / dev server

`DevServer = {projectRoot, cwd, packageManager, script, command, declaredPort, declaredBy, detectable, why, pid, processId, port, url, status:'STOPPED'|'STARTING'|'RUNNING'|'FAILED'|'RESTARTING', startedAt, stoppedAt, adopted, lastError:{at,why,log}|null, preview:Preview|null, log}`

| Action | Request | Result |
|---|---|---|
| status | `POST /api/devserver/status` | `{devServer}` (`projectRequired` when none) |
| start | `POST /api/devserver/start {timeoutMs?, probe?}` | `{devServer, preview}` · failure → `ok:false, why, devServer` (FAILED with `lastError.log`) |
| stop / restart | `POST /api/devserver/stop` · `/restart` | `{devServer}` (an adopted server is not restarted) |
| probe | `POST /api/devserver/probe {path?}` | `{preview, devServer}` |

`Preview = {at, ok, httpStatus, error, url, request:{method,url,headers}, response:{status,contentType,bodyExcerpt}|null, server:{status,pid,port,processId,adopted}, logs}`

- **HTTP 500 is evidence, not an error state:** show `httpStatus`, `url`, the
  request, server `status`, and `logs` (populated for 5xx / connection errors).
  Nothing auto-restarts.
- The dev server always runs in the project root (canonical long path) with the
  project's own package manager (lockfile / `packageManager`).
- `POST /api/workshop/open` now uses the same record and returns `preview` and `devServer`.
- Diagnosed 2026-09-16: a Vite dev server whose `/api` proxy target is down answers
  **HTTP 500** (`http proxy error … ECONNREFUSED` in `logs`).

---

## 9. Cowork / Bot

The `Cowork / Bot` lane has two views — **Cowork** (sessions, as before) and
**Bot** (connections). Which one is showing is UI state.

`POST /api/bot/connections {check?}` → `{service:{running, owner:'core'|'external'|null, state}, platforms:[Connection]}`

`Connection = {platform, supported, setup:'harness'|'environment', state:'NOT_CONNECTED'|'CONNECTING'|'CONNECTED'|'AUTH_REQUIRED'|'FAILED', summary, configured, enabled, running, service, identity:{username,name,botId}|null, allowedUsers[], allowedCount, pairedChats?, candidates?[{senderId,chatId,firstAt,lastAt,count}], authenticated?, restartRequired?, checks?[{name,value}], requires?, docs?}`

### Telegram (setup `harness`)

1. **Connect** — `POST /api/bot/telegram/connect {token}` → `{telegram, started}`.
   Token verified by LAIN's runtime before storage; a bad token stores nothing.
   Clear the token field immediately; the token is never returned.
2. Show `identity.username` / `identity.name`.
3. Tell the person: **send `/start` to @username**.
4. Refresh connections (or `POST /api/bot/telegram/candidates`) → `candidates[]`.
5. **Approve** — `POST /api/bot/telegram/approve {senderId}` (only a recorded candidate) → `{allowedUsers}`.
6. Connected: `state:'CONNECTED'`, `allowedCount`.

Manage: `POST /api/bot/telegram/check` (re-validate → `AUTH_REQUIRED` if rejected),
`/revoke {senderId}`, `/disconnect` (removes credential and approvals),
`POST /api/bot/service {action:'start'|'stop'|'restart'}`.

### Discord / WhatsApp (setup `environment`)

Astra's adapters read secrets from environment variables. Show `state`,
`summary`, `checks`, `requires.env` / `requires.config` and link `docs/BOT.md`.
There is no token entry for these in the window.

Creating a Cowork session (`POST /api/session/new {lane:'cowork'}`) is never
blocked by engineering work.

---

## 10. Settings

`GET /api/settings` (or `POST`) → `{sections:[{id, label, fields:[Field]}]}`

`Field = {key, label, type:'boolean'|'integer'|'model'|'directory'|'file'|'text'|'list'|'info'|'link', value, editable, supported, restartRequired, why?, min?, max?, lane?, search?, actions?}`

`POST /api/settings/update {key, value}` → `{ok, key, field, restartRequired}` or 400 `{ok:false, key, why}`
`POST /api/settings/action {key, action, arg}` → e.g. `privacy.trustedDirectories` / `forget` / `{path}`

| Section | Keys |
|---|---|
| GENERAL | `general.startAtLogin` (per-user Startup shortcut; unsupported until LAIN.exe exists), `general.closeToTray` (fixed), `general.background` (fixed), `general.maxSteps` |
| MODELS | `models.defaultChat` `{source, modelId}` (applied to new sessions), `models.defaultCoding` `{modelId}`, `models.sources` (read-only), `models.customs` (info: `/api` in the terminal) |
| PATHS | `paths.defaultProjectRoot`, `paths.nodePath` (restart required), `paths.detectedNode`, `paths.configDir`, `paths.sessionsDir` (read-only) |
| CONNECTIONS | `connections.messaging` (link → Bot view), `connections.webModels` (sign-in states + connect route), `connections.chrome` (LAIN for Chrome: `{state: DISCONNECTED\|WAITING_FOR_EXTENSION\|CONNECTED, authorizedTabCount}`, connect/disconnect routes — added 2026-09-18) |
| NOTIFICATIONS | `notifications.completion`, `notifications.errors`, `notifications.needsInput` |
| PRIVACY | `privacy.trustedDirectories` (list, action `forget`) |

Not offered because no backend exists: theme/accent, update checks.

### LAIN for Chrome — added 2026-09-18

`POST /api/chrome/status` → `{chrome:{connected, port, extensionSeen, authorizedTabs:[{id,url,title}]}}`
`POST /api/chrome/connect` → `{token, port}` — show the token for the person to paste into the extension's popup; never store or re-display it elsewhere.
`POST /api/chrome/disconnect` → `{chrome}` — fails closed: the extension's next request is refused, not silently ignored.

Which tabs are authorized is decided in the EXTENSION's own popup, never from
this window — there is no "authorize a tab" action here by design.

---

## 11. Naming in primary UI

- "Project Files", not "Source". "Chat model" / "Coding model", not provider ids.
- Use the `LAIN` wordmark (text). No logo.
- `host: Chromium …` and other `diagnostics.environment` data belong in diagnostics only.

## 12. Workspace shell (contract 2, 2026-09-24)

The window is one workspace with seven primary tabs — HOME, IDE, CHAT, BOT,
MODEL, SESSION, SETTINGS. Entering IDE or CHAT on an engineering session calls
`POST /api/view/select` (`coding` / `chat`); the tabs are UI state, the view is Core's.

| Read / action | Route | Owner |
|---|---|---|
| Per-role usage, last route used (polled) | `state.usage` | `usagewindows.js` (provider rate-limit headers), `availability.js` |
| Providers, routes, usage, roles, orchestration mode | `POST /api/accounts`, `POST /api/accounts/refresh {force}` | `harnessapp/accounts.js` |
| MCP servers (built-in Computer + `cfg.mcp.servers`) | `POST /api/mcp/servers` | `mcp.js`, `computermcp.js` |
| Skills | `POST /api/skills` → `{supported:false}` in this build | — |
| Open a folder as the IDE's project | `POST /api/project/open {path}` | attach in place, else `session/new {project}` |
| New Project | `POST /api/project/create {parent, name}` | creates the folder, then open |
| Project understanding | `state.workspace.project.sync {running, state, files, code, scanned, symbols}` | `sessionpool.reattachProject` → `projectsync` / `projectindex` |
| BOT-requested navigation | `state.navigate {seq, surface, section}` | `tools/lainself.js` (`lain_workspace` action `open`) |
| Session time | `state.sessions.*[].at` | `sessionindex.js` |

- A usage percentage exists only when a provider stated one; otherwise `reading: null` and the window shows `n/a`.
- CHAT → IDE is the plan handoff of §5 (`/api/plan/draft` when no draft exists, then `/api/plan/accept`).
- The BOT answers questions about LAIN with `lain_workspace` (`describe`: models, quota, providers, mcp, bot, where) from the same `accounts.js` projection.
