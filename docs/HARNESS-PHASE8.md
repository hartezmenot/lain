# Phase 8 / 8.1 / 8.2 / 8.3 / 8.4 / 8.4.1 — LAIN Harness: Palette Workbench

Audit of the Phase 8 specification (§0–100) against the source as it stood
before the phase, and what was done. Current source is authoritative; nothing
below is claimed from an older report.

Classification before the phase: **TRUE** (already met), **PARTIAL**, **FALSE**
(absent), **OBSOLETE** (present but contradicting Phase 8, replaced).

## Phase 8.4.1 — Accounts as a clean manager, one Google provider, a readable Coding Agent (2026-09-29)

**This section supersedes 8.4's description of MODEL › Accounts and of the Coding Agent sidecar.** Core sessions,
handover, compaction and the fabric's routing are unchanged; the account lifecycle, quota vocabulary and the
sidecar's layout changed.

### Account UX

- **The main screen is the connected accounts, nothing else.** One flat plane per provider (`--panel` on the page,
  1 px `--line`, 12 px between planes — no gradient, glow or thick border; still clear at 80–200 % zoom). Header:
  `[mark] Name · N connected … Automatic ▾  + Add account  ⋯`; a chevron collapses a provider to one line (its
  tightest window, alerts stay visible; remembered per viewer). A row is the friendly name, the masked identity and
  plan, a status (`Ready · Active · Limited until · In use by Coding Agent · Not verified`), its windows and a single
  ⋯. Internal ids, priority, profile path and migration source appear only in Details.
- **Toolbar:** `Refresh · Connect account · ⋯` (Discovered accounts · Finish setup (n) · Import accounts). Import is
  no longer a standing button. A quiet line above the list — "1 account needs setup" / "3 accounts discovered on this
  PC" — opens the corresponding surface.
- **Finish setup** and **Discovered on this PC** are their own surfaces (MODEL sections `setup`, `discovered`).
  Entries are classified CONNECTED / DISCOVERED / IMPORTED_PENDING_AUTH / OBSOLETE. "Review N old setup entries"
  lists duplicates and entries whose identity is already connected; nothing is deleted without the person's word.
  A router pool is not "old" just because its provider is connected.
- **Every connected account has a ⋯** with only what applies: Details · Rename… · Use only this account · Move priority
  earlier/later · Refresh quota · Run a test message (Antigravity, until verified) · Detach from LAIN · Sign out (LAIN-owned
  only). The provider ⋯: Manage accounts · Refresh all · Change account policy · Detach all from LAIN (confirms, names
  the accounts) · Sign out all LAIN-owned accounts (typed confirmation).
- **Active-task safety:** an account a request is working through says "In use by Coding Agent/Chat", offers View task /
  Stop task… and disables Detach and Sign out (`accountwork.js` → `viewLive` → `a.inUse`). Nothing is ever stopped for the
  person; a refusal names who is using it. "Detach all" skips busy accounts and reports them.

### Account actions (`src/fabric/detach.js`)

| Act | Effect | Who |
|---|---|---|
| **Detach** | LAIN forgets the account. Nothing signed out, nothing deleted (the profile stays). | any account: a LAIN-owned instance, the person's own default profile (`runtime:*` — flagged `cfg.runtimes.<rt>.disconnected`), a Finish-setup entry |
| **Sign out** | the provider's own sign-out, in that one account's directory | LAIN-owned only; needs `confirm` |
| **Remove LAIN-owned profile** | sign out and delete the directory LAIN made | LAIN-owned only; needs `confirm` |
| **Detach all** | every account of ONE provider (+ its pending entries); busy ones skipped | never touches another provider or anything external |
| **Sign out all LAIN-owned** | sign out + remove profile for LAIN-owned accounts only | the person's own profiles are not touched at all |

A detached own profile reappears under "Discovered on this PC"; "Use in LAIN" brings it back as `external_native`
(never LAIN-owned). Routes: `POST /api/intel/detach`, `/api/intel/detach-all`.

### Google provider consolidation

Antigravity is the single Google OAuth coding provider. Gemini OAuth records (`gemini` accounts/placeholders/router
prefixes) are read as Antigravity (`FAMILY_ALIAS`); Gemini remains a model family and its API keys stay under API.
Old config and history are kept; a placeholder whose identity matches a connected Antigravity account is flagged old.
**Chat and Assistant are advertised for an Antigravity account only after a real execution** — a request through it or
the "Run a test message" action (`drivers/antigravity.verify`, `POST /api/intel/verify`, `verified_at`). A sign-in
alone shows "Not verified". **Coding is not advertised at all**: no tool-using Antigravity run has been verified.
OpenCode uses the same section grammar with its real lifecycle (one runtime account; Detach only).

### Coding Agent sidecar

Conversation type is body size (15 px, 1.6 line height); `YOU` / `CODING AGENT` headers carry the time; one thin rule
between turns; no bubbles, no glow. A **task strip** of its own (TASK · state · Phase n/N · title · summary ·
[▶ Continue] · [Open full Coding Chat] · Steps) sits between the header and the conversation, separated by a rule; it
tightens (never shrinks type) on short windows. The composer is larger, grows as typed (to 260 px), has `+  @  /` and a
labelled Send / Start / Continue / Stop. The route is one line — `Provider · Model · Effort` (each its own chooser) —
with Execution `Normal ▾` (Normal · Fast · Eco). With nothing selected it reads **"Select provider"** and no model
(sidecar, top bar, status bar, Chat's cells). The panel defaults to 28 % of the window (340–460 px) and is never wider than
the editor beside it; the old stored 320 px is ignored (only a drag is remembered).

Found by looking at the screenshots at 125 % and 150 % zoom, and fixed: hiding a pane (`display:none`) shifted the other
IDE panes one grid column left — with the Explorer hidden the editor vanished, at ≤900 px (150 % zoom of a 1280 px window)
the whole IDE was blank (fixed: explicit `grid-column`s); the floating LAIN Assistant sat on the composer in the narrow
Agent view (hidden there); class collisions (`.side`, `.route`) restyled the composer.

### Quota semantics

Every source reports what is USED. Core now carries `usedPercent`, `remainingPercent` and `reported` per window
(`fabric/index.js normWindow`; a provider that natively reports remaining is kept as such). Every surface says
"N% remaining" — bars are what remains, red at ≤5 %, amber at ≤20 % (`L.kit.quotaTone`); 100 % remaining is never red,
100 % used is. Converted: MODEL rows/sheets, Usage (a past window still says "used by its end"), Home, header bar,
model rows, API rows, tray text ("N% left") and the tray icon (draws remaining), CLI `/account limits`, Telegram `/usage`.

### Verification (2026-09-29, isolated profile, fakes only)

| Tier | Result |
|---|---|
| unit | **3540 passed, 0 failed** |
| integration | **222 passed, 0 failed** |
| workflow | **4 passed, 0 failed** |
| cli | **436 passed, 0 failed** |
| harness (real window) | **49 passed, 0 failed** |

New: `unit/phase841` (§35 primary list, §36 detach each, §37 detach all, detach → discover → use round trip, in-use
refusal, §38 one Google provider, §40 quota semantics), `unit/antigravity` (verified by execution),
`smoke/codingagent841-real` (sidecar at 1280×720 and 1600×900, zoom 125/150 %, real keystrokes, no-provider state).
Rewritten for the new markup: `accounts84-real` (planes, toolbar ⋯, Finish setup surface, every menu, a running task
marks its account "In use", Bravo detached through the real window), `modelaccept-real`, `responsive84-real` (plane
gap and unclipped quota text at every zoom), `chataccept-real` (no Model cell without a provider). Tray tests now expect
"N% left". Screenshots were reviewed by eye: Accounts at 1440×900, 1280×720, 80 %, 150 % and 200 %; the sidecar at
1280×720 (100/125/150 %) and 1600×900, and with nothing selected.

### Not done, or not verified — said plainly

- **Antigravity against Google's real ACP server is still UNVERIFIED** (fake only), so the verification gate has only
  been exercised against the fake; Coding is deliberately not advertised.
- Old-entry cleanup covers duplicates and already-connected identities; anything subtler stays under Finish setup.
- The tray icon change is C# (`native/host.cs`): it builds, but the icon itself was not looked at.
- At 150 % zoom on a 720 px window (480 CSS px tall) the conversation area is small; the strip, composer and route stay
  readable at full size rather than shrinking.

---

## Phase 8.4 — the Harness UX rewrite, and the account-isolation hotfix (2026-09-30)

**This section is the current truth for the Harness's look and for how accounts are connected.**
Core, sessions, handover, compaction, project state, IDE and Preview are unchanged; the fabric
(8.3) gained a lifecycle and an authentication boundary.

### The P0 hotfix — connecting an account must never touch another

*What happened:* Claude had one authenticated account and a Claude process working through it.
"Add account" ran `claude auth login` with no configuration directory, so it signed in against the
**default profile** — replaced the connected account and cut the running task off. (The launcher was
added in 8.4's first pass; it is deleted.)

*The invariant now:* adding or authenticating another account **never** mutates an existing account's
profile and **never** touches a provider process that is working. Implemented as:

| Piece | What it does | Where |
|---|---|---|
| **AuthSession** | one sign-in, scoped to ONE new AccountInstance it creates: allocate a NEW EMPTY LAIN-owned profile → run the provider's login there as its own child → wait for that process → read identity from the same profile → only then CONNECTED. Cancel/failure removes only what it made. | `src/authsession.js` |
| **Claude** | `CLAUDE_CONFIG_DIR=<config>/accounts/claude/<id>` for login, status and every run; refuses to point a LAIN-owned account at the default profile; no `HOME` substitution, no profile copying, no global logout. Per-account telemetry (`claude-code--<id>`). | `drivers/claudeaccount.js`, `drivers/claudecode.js` |
| **Codex** | audited: overlay homes with a private `auth.json` (never linked), own app-server per account; now an AuthSession too. | `drivers/codex*.js` |
| **Antigravity** | one private profile per Google account: `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, a captured browser URL, ambient Google credentials scrubbed; speaks ACP to Google's `agy_acp_server`, installed only on explicit confirmation, SHA-256-pinned. Same boundary T3 keeps; no dependency on T3. | `drivers/antigravity.js`, `drivers/acp.js` |
| **Z.ai / ZCode** | LAIN never acts as ZCode's desktop host. Connect launches the official app and detects a plan-status record newer than the session. ZCode holds one Z.ai sign-in. | `authsession.js` (`startZai`) |
| **Work in flight** | `accountwork.js` observes requests per account. Detach / Sign out refuse while one is running through the account. | `src/accountwork.js` |
| **Explicit switch mid-run** | deferred to the turn boundary (`pendingChoice`), never applied under a running request. | `sessionintel.js`, `submitclose.js` |
| **Three different acts** | Detach (LAIN forgets) · Sign out (provider's own, that directory only, LAIN-owned only) · Remove LAIN-owned profile. An external profile only detaches. | `sourcesroutes.js` |

*Proof:* `tests/unit/authisolation.test.js` (fake `claude` that keeps its sign-in in its config directory
and records every invocation's directory — a login against the wrong directory or any logout cannot pass
unseen) and `tests/smoke/accounts84-real.test.js` (the same scenario through the real window with real
input: account A holds a running request, "+ Add account" is clicked, B connects; A's process is alive, its
credentials are the same bytes, B has its own directory, no logout ran, A's request finishes as A).

### Lifecycle — Connect, Discover and Import are three different things

`CONNECTED · DISCOVERED · IMPORTED_PENDING_AUTH · DISCONNECTED · ERROR` (`fabric/index.js`). **Only CONNECTED
accounts are capacity**: routed, counted, chosen for fallback, reporting quota. Imported router pools and
placeholders are metadata under **Finish setup** — never routable, never "Ready" (this replaced 8.3's
"Imported pool" backing account). *Discover* is an existence-only look at native provider homes
(`fabric/discover.js`, "Use in LAIN"); *Connect* is a NEW account through the provider's own login; *Import*
is a wizard (Find → Choose → Finish) whose statuses are Ready to adopt · Needs sign-in · Already connected ·
Unsupported; a native profile is adopted with its identity checked afterwards, never merged on a guess.

### The design system (Palette Workbench)

Slate is the default palette (LAIN Cyan remains a choice). One grammar, `page/pageui.js` (`L.kit`, `u-`
prefixed — nothing restyles a global class): a heading with actions, text tabs with an underline, sections
of rows separated by hairlines, a quota bar per REAL provider window (5-hour, Weekly, Monthly, Credits — never
an empty label), inline selects (`Automatic ▾`), one side sheet (full page under 900 px), empty states, settings
rows. Scales: spacing 4·8·12·16·24·32·48; type 30/20/15/14/13 (nothing under 13 px); icons 16/20/28.
Provider marks are LAIN-drawn neutral glyphs — official logos are not bundled (no redistribution licence).

| Surface | What changed |
|---|---|
| **MODEL › Accounts** | one section per provider: mark, name, "3 connected · 1 setup pending", policy select, "+ Add account", ⋯; rows carry name, masked identity, status and quota; "Discovered on this PC"; "Finish setup"; provider details (accounts + priority, quota, models, authentication); account details (only actions that apply) |
| **Models · API · Local · Defaults** | logical catalog by provider (effort levels per model); Connected APIs / Custom endpoints; Ollama / llama.cpp / directories; six roles as rows |
| **Home · Usage · MCP & Skills · Settings · Chat sidebar** | the same section/row language; no tiles, no filled cards; Usage grouped provider → account → windows; Settings appearance as rows |
| **IDE** | not redesigned — only the palette applies |

### Verification (2026-09-30, isolated profile, fakes only)

| Tier | Result |
|---|---|
| unit | **3532 passed, 0 failed** |
| integration | **222 passed, 0 failed** |
| workflow | **4 passed, 0 failed** |
| cli | **436 passed, 0 failed** |
| harness (real window) | **48 passed, 0 failed** |

New: `authisolation` (9), `antigravity` (5), `zaiconnect` (3), `accounts84-real`, `responsive84-real` (three window
sizes, zoom 80–200 %, no overflow, no text under 12.5 px, quota stacks under the account below 1000 px).
Rewritten for the new markup: `modelaccept-real`, `perf83-real`, `workbench-real`. Real bugs the real-input tests
found: menus closed under a page redraw (fixed: pages defer redraws while a menu is open); `L.ui` was shadowed by
the design-system namespace (now `L.kit`).

Performance (real window, 1,181 models, 8 Codex accounts): window shown in 0.8 s, MODEL drawn in 79 ms, the
composer's model picker in 153 ms, search 1.3 ms, Skills 69 ms; idle Core 1.2 %, host 0 %, 0 tray pushes. The
Accounts page draws from cached state; quota and discovery arrive asynchronously; nothing polls.

### Not done, or not verified — said plainly

- **Antigravity against Google's real ACP server is UNVERIFIED.** Only a fake ACP server is tested; the real
  binary (~468 MB) is not on this machine, and the plain `agy` CLI ignores `GEMINI_HOME`, so it cannot be isolated.
  Quota is not reported by that server; none is shown.
- **Z.ai:** ZCode holds a single sign-in, so there is one Z.ai account, detected — not many.
- **Other providers (Cursor, GitHub Copilot, …)** have no Connect flow yet; API keys stay under MODEL › API.
- Discovery finds native Codex homes; a signed-in Claude profile is already the default `runtime:claude-code` account.
- Screenshots were reviewed by eye at 960×640, 1280×720, 1600×900 and 200 % zoom for the Accounts page; the other
  surfaces were checked at 1440×900.

---

## Phase 8.3 — the unified intelligence fabric (2026-09-29)

One Core-owned registry of providers, accounts, models, effort and policy that
the Harness, the CLI, Telegram and `lain --serve` all project
([`docs/MODEL-SOURCES.md`](MODEL-SOURCES.md) is the reference). **This section
is the current truth for models, accounts and effort; where 8.2 below says
"account first", 8.3 replaced it with "provider first".**

### Audit — the source against the 8.3 specification, before any edit

| Area | Before | Now |
|---|---|---|
| One registry for Harness and CLI | PARTIAL — one catalog, but an API added in one process was invisible to another until restart | one fabric: `fabric.json` + `accounts.json` re-read by every process; `config.json` changes by another process merged three-way (`config.mergeExternal`, `fabric/sync.js`) |
| Provider family appears once; accounts behind it | FALSE — every backing account (a Codex home, a router pool) was a top-level "account" and a picker group | `fabric/index.js`: families, each backing account with alias, masked identity, reported quota, priority |
| Account policy (automatic / one account / ask) | FALSE — `accountinstances.js` said "NO ROTATION" | `fabric/policy.js` + `fabric/fallback.js`, wired into the turn close (`submitclose.js`) |
| Fallback never changes model or effort | TRUE for provider failover (`failover.js`), no account fallback existed | the eligibility index (family → logical model → accounts × effort levels); no compatible account → a question |
| Model-specific effort | FALSE — one generic list (`auto, low, medium, high, xhigh`) everywhere; `codex exec` and Claude Code never received an effort | `fabric/effortcaps.js`: per model, per account; translated to `-c model_reasoning_effort=` (Codex) and `--effort` (Claude Code); stamped on receipts |
| Execution: one dropdown | PARTIAL — a permanent Normal/Fast/Eco button row in the composer and the sidecar; toggles already correct | one Execution dropdown (`⚡ Fast ▾`) |
| Model Dashboard shared by CLI | FALSE — `/api` asked for the key in the terminal; `/account add` opened an old card form | `/model manage`, `/account add`, `/api add` open the dashboard (`fabric/dashlaunch.js`); the terminal never takes a key |
| Tabs Accounts · Models · API · Local · Defaults | PARTIAL — present, account-first, 9Router-branded (Adopt, "Available from 9Router") | `page/pagedash.js` |
| Old Add Account (Codex account · API key · Website session) | OBSOLETE | removed |
| Website-session providers | OBSOLETE — retired in 8.1 but adapters, sign-in, check tooling and the web chat transport remained | removed |
| 9Router / OmniRoute | OBSOLETE as sources ("Source: 9Router", Adopt) | migration inputs (`fabric/migrate.js`); an imported pool is a backing account marked *migration pending* |
| Freebuff | OBSOLETE — discovery, MODEL row, launcher, Usage card, assistant watch, docs | removed |
| Skills: discover/index/import/update protection | PARTIAL — add a folder or clone a repo, validate, enable | the Skills Hub (`src/skillshub.js`) |
| Tray quota | FALSE — a 63-character tooltip the page set | `fabric/tray.js` → host: 127-char tooltip, compact left-click panel, a quota bar on the icon, pushed only on change |
| `lain --serve` logical routes | PARTIAL — `lain/<model>`, first route wins | `lain/<family>/<model>`, policy underneath, effort checked |
| Picker/search against an index | PARTIAL — the catalog was memoised, but account views re-derived per popover | the fabric index, built once per generation |

### What changed

| Area | What | Where | Verified by |
|---|---|---|---|
| **Families** | Codex, Claude (Pro/Max from the plan), OpenCode, Z.ai, Local, one per API source; a router pool imported in 8.2 is a backing account of its family ("Imported pool", *migration pending*), an unimported one only a migration candidate; logical model ids drop a router's namespace (`cx/gpt-6-sol` → `gpt-6-sol`), each account keeps its own catalog id | `fabric/index.js` | `phase83` FAMILY, `accountfirst` |
| **Lanes** | family › model › effort (per lane) › policy › backing account; stored in `session.intel`; the backing account where 8.2 kept "the account", so routing is unchanged; a stored effort the model does not take is reset to its default and said so | `sessionintel.js`, `modelsource/sessionstate.js` | `sessionintel`, `phase83` EFFORT |
| **Policy** | Automatic fallback: the next healthy account in priority order serving the same model at the same effort; the same task resubmitted (`sameTask`); a `fallback` event. Use one account only: never switched — *Switch account · Wait · Choose another model*. Ask before switching: proposed, nothing sent through it until *Switch*. No compatible account: asked, never downgraded | `fabric/policy.js`, `fabric/fallback.js`, `submitclose.js`, `/api/intel/decide` | `phase83` AUTO / PINNED / ASK / INCOMPATIBLE — real turns through fake router pools |
| **Receipts** | `family`, `logicalModel`, `effort` beside the backing `account` and `route` | `modelrequest.js`, `usage.js`, `runtimedispatch.js` | `phase83` AUTO |
| **Effort** | per model: the provider's report (Codex `model/list`, fused route ids), else a documented transport (Claude Code `--effort`, Anthropic `output_config.effort`: Opus low…max, Sonnet low/medium/high, Haiku none), overridable; translated in one place | `fabric/effortcaps.js`, `drivers/codexexec.js`, `drivers/claudecode.js` | `phase83` EFFORT |
| **Status parity** | `/status` (CLI and Telegram) and the window: provider · model · effort · execution · account (with route) · the other lane · phase — 13 rows | `sessionfacts.js`, `diagnose.js`, `remotecontrols.js`, `ui/projection.js` | `surfaceparity`, `phase83` PARITY (before and after a fallback), `statuspanel` |
| **CLI** | `/account` (policy, numbered accounts, pin · automatic · ask · reorder · rename · add); `/model manage`; `/effort` offers only the model's levels; `/api` never takes a key — a pasted one is redacted and taken out of history; the flows that asked for keys are deleted | `accountcommand.js`, `routecommands.js`, `modelcommand.js`, `apicommand.js` | `phase83` CLI, `apiflow` |
| **Model Dashboard** | Accounts (families; detail sheet: policy, ↑↓ priority, Rename, Refresh, Detach, placeholders; Connect account; Import accounts) · Models (index search with Provider/OAuth/Runtime/API/Local/Coding/Chat/Effort/Available filters) · API · Local · Defaults (Chat, Assistant, Coding, Research, Vision, Auxiliary). Opened from the CLI in this LAIN's window, the running LAIN's (control-pipe verb `dashboard:<section>`), or a window of its own; only a section name is handed over; the terminal is told the safe completion event | `page/pagedash.js`, `pagemodel.js`, `fabric/dashlaunch.js`, `corelock.js`, `harnessapp/ipc.js` | **`modelaccept-real`** (rewritten, real input), `phase83` CLI |
| **Composer** | Provider · Model · Effort (only where the model declares levels) · one Execution dropdown; the pending account question above it | `pagecomposer.js`, `pageintel.js`, `pagework.js` | `modelaccept-real`, `chataccept-real` |
| **Migration** | sources: routers LAIN is connected to (their prefixes, from LAIN's own listing) and a router export file; an API key the person owns moves after the provider accepts it; OAuth never copied → a placeholder until LAIN's own sign-in (Antigravity: no LAIN sign-in, said so); duplicates asked (Keep · Replace · Add separately); no router name in the normal UI | `fabric/migrate.js`, `/api/migrate/*` | `phase83b` MIGRATION, `modelaccept-real` Import |
| **Skills Hub** | sources: Git (skills.sh-style), folder (Hermes / Agent Skills), catalog URL; suggested: Anthropic Skills, Hermes Agent skills (fetched only when added); an on-disk index searched at once, refreshed in the background; inspect (source, author, version, license, files, dependencies, capabilities) → install into LAIN's store → validate → a skill with scripts or dependencies disabled until a confirmed enable; hashes per file — updates never overwrite a local change (View diff · Update and overwrite · Keep local · Duplicate); Hermes is never started | `skillshub.js`, `integrationroutes.js`, `pagemcp.js` | `phase83b` SKILLS ×2, `phase81` SKILLS |
| **Tray** | only reported windows; hover 127 chars; left click = compact panel (quota lines, Open LAIN, Models & Accounts, Usage, Active Tasks, Pause/Continue task, Exit); an icon bar for the active account's fullest window; pushed on change — receipt, account change, fallback, refresh, window connect — plus one timer at the next known reset; none at idle | `fabric/tray.js`, `native/host.cs` | `phase83b` TRAY, `modelaccept-real` (real pipe → real host) |
| **Serve** | `lain/<family>/<model>`; `reasoning_effort` checked; `@<alias>` only with `server.pinnable` | `serve.js` | `phase83` SERVE, `phase81` |
| **Removed** | Freebuff (driver, discovery, adapters, MODEL/Home/Usage/launcher, assistant watch); website adapters (ChatGPT/Gemini), their sign-in and check tooling, the web chat transport and its `webmodel.*` events; the old Add Account cards; the terminal key-entry flows | many | `phase83` FREEBUFF, `runtimeadapters`, `engineering-session`, `events` |

### Performance (§80) — measured

**Index** (1,240 models; Codex with 8 backing accounts; one 1,100-model API source; `node`, isolated profile):

| | |
|---|---|
| first catalog + accounts + fabric build | 58–61 ms (fabric index itself 11–12 ms) |
| warm index read | 0.04 ms (p50) — the same object, not rebuilt |
| search, per keystroke | 0.2–0.8 ms |
| model picker (a family's models) | 0.24 ms |
| a lane (family › model › effort › backing › route), warm | 0.48 ms p50, 0.81 ms p95 |
| the whole window state (`/api/state`) | 6.3 ms p50 |
| warm picker/search disk reads | none (asserted in `phase83b`) |

**CLI** (forced TUI, mock model, same profile, 3 runs): time to first prompt
**231–234 ms**; CPU to the prompt 234–296 ms; working set 101–103 MB at the
prompt, 86 MB idle; idle CPU 0.15–0.77 % over 10 s with **no process started**
— a CPU profile of that window shows no LAIN code running, only ~11 ms of GC.

**Harness** (real window, same profile, `perf83-real`): window shown in
1.55–1.68 s; MODEL (Accounts) drawn in **79–84 ms**; the composer's model picker
with its rows in **167–186 ms**; Skills Discover in **63–67 ms**; idle for 8 s
with the tray bound: **0 tray pushes**, host 0–0.6 %, Core 2.5 % in the test
(which also carries the renderer's `/api/state` polls and the test's own CDP
attachment); the fabric's share of that idle work is 14.6 ms of 207 ms profiled.

Found and fixed on the way (the first `perf83-real` run had MODEL at 229 ms,
the picker at 295 ms, Skills at 252 ms and idle Core at 6.6 %):
1. **Every lane read JSON-stringified every connection's declared model list** to
   validate a memo (`appcatalog.connections`) — a shallow signature now (settings
   plus list size; discovery writes invalidate).
2. **The account list stat'ed four files per read** and a poll resolves several
   lanes — mtimes looked at no more than every 250 ms; writers invalidate
   (`accountcatalog.touched`).
3. **Every `/api/state` walked PATH for Python** (the Cowork capabilities,
   pre-existing) — through the remembered lookup (`pathlookup.js`).
4. **The fabric index kept a limit after it ended** — rebuilt at the earliest
   reported end (`validUntil`), which is also what lets the tray update at a reset.

### Not done — and why

- **Antigravity** has no sign-in LAIN can drive without borrowing another
  program's client: discovered accounts wait as placeholders marked *no supported
  sign-in*.
- **Research, Vision and Auxiliary** role defaults are stored, shown and
  resolvable (`fabric/roles.js`); Chat, Coding and the Assistant's scheduled tasks
  consume theirs — no Core path runs a separate research/vision/auxiliary model yet.
- **Z.ai quota**: ZCode reports token usage (`usage/stats`), not quota windows —
  shown as *Not reported*; nothing is estimated.
- **Claude Code effort levels** are declared per model family (Claude Code
  accepts the flag but does not list levels per model); overridable.
- **The suggested skill sources** (Anthropic Skills, Hermes Agent skills) and a
  live OmniRoute were not contacted: tests use local repositories, catalogs and
  fixture routers. An OmniRoute connection is recognised by its declared
  provider; there is no OmniRoute-specific export reader.
- **The tray icon** carries a bar, not digits (unreadable at 16 px).
- `modelsource/webbrowser.js` / `webprofile.js` (browser-profile helpers used by
  the environment tooling) were kept; the website *providers* are gone.

### Verification (2026-09-29, isolated profile, fakes only)

Every tier, run in sequence after the last edit (`node tests/run.js <tier>`):

| Tier | Result |
|---|---|
| unit | **3515 passed, 0 failed** (221 s) |
| integration | **222 passed, 0 failed** (214 s) |
| workflow | **4 passed, 0 failed** (13 s) |
| cli (the real binary over a pipe) | **436 passed, 0 failed** (1611 s) |
| harness (real window, real input, real host) | **46 passed, 0 failed** (191 s) |

New for 8.3: `unit/phase83.test.js` (15), `unit/phase83b.test.js` (5),
`smoke/perf83-real.test.js`, and rewrites of `smoke/modelaccept-real`,
`smoke/apiflow-fixture` (the real binary: `/api`, `/api add` and a pasted key —
no key prompt, the key never stored, drawn or sent; a key added in the dashboard
in one process is read by the binary in another, its models and never its key)
and `unit/apiflow`. Smoke tests that encoded the removed terminal key entry or
the old wording were updated to the 8.3 behaviour (`catalog`, `cli`,
`commands-audit`, `frames` — whose selection test now drives the command
palette, the same `ui/panel.js` menu).

Final `perf83-real` run: window 0.82 s, MODEL 101 ms, picker 153 ms, search
0.9 ms, Skills 100 ms over 1,242 models; idle Core 2.3 %, host 0.6 %, 0 tray
pushes; Core working set 118 MB.

Spawned test binaries run with `LAIN_NO_DESKTOP=1` (tests/helpers.js), so a
command that opens the Model Dashboard reports that it did not rather than a
window appearing mid-suite. Nothing touched a real account, quota or home: the
suite runs under `tests/harness/isolation.js` with fake runtimes and fixture
routers only.

---

## Phase 8.2 — workbench recovery (2026-09-28)

8.1 was green; its screenshots were not. This pass started from the screenshots
and the source (§0), not from the tests, and closes with **real-window acceptance
tests driven by real mouse and keyboard input** (CDP `Input.*`, never a DOM
`.click()`). Those tests found nine defects the earlier, scripted checks had
passed. **This section is the current truth; where 8.1 or the Phase 8 matrix
below disagree, this section wins.**

### Audit — the screenshots against the source, before any edit

| Screenshot | Cause in the source | 8.2 |
|---|---|---|
| The IDE opened in Source Control with an empty side bar | `pageide.js` declared `var pane` twice in one scope: at boot `drawPane()` threw, so the IDE's keyboard shortcuts and show-handlers never registered and the only thing inviting a click was the "99+" SCM badge | fixed; the IDE opens on the **Explorer** |
| "A diff viewer, not an IDE" | no Explorer actions, Open Editors, breadcrumbs, tab menu or preview tabs; no Output or Debug Console; the bottom panel hidden by default; split and Preview undiscoverable | a real IDE — see *IDE* below |
| Chat: no way out | 8.1's contextual navigation left Chat with only a small switcher | the compact **app panel** on every surface but the IDE (expanded on Home; Compact/Expanded is a setting) |
| The session drawer hidden from the first visit | auto-hide from the start; no first-run state, hint or shortcut | first visit shows it (with what lives there); opening a conversation folds it with a **one-time hint**; a labelled *Conversations* button, the left edge and **Ctrl+B** |
| A one-line composer in an empty canvas | width = the column; one line | 720–960 px, centred on the conversation, grows 1–6 lines; the Coding Chat and sidecar inputs sized for writing |
| The model as the identity ("gpt-6-sol n/a") | Chat recorded a **model only**; the first connection that served it answered | **account first** everywhere — see *Accounts* |
| Codex accounts "runtime only" | no route from LAIN to a native Codex account | `runtime:codex:<instance>` through `codex exec` |
| Preview: a picture | the Workshop drew a screenshot `<img>`; dragging it dragged the page | a live, **interactive** screencast; Pick is an explicit mode |

**9Router, verified against the installed 0.5.91 (corrects 8.1):** `GET /v1/models`
needs the API key LAIN holds for it (8.1 described it as public). Per-account
listing (`/api/providers`) needs 9Router's dashboard session or a private CLI
token derived from 9Router's own secret — **not used**: that would be
impersonating 9Router's CLI. A chat request cannot be pinned to one account
inside 9Router (it chooses and falls back itself), so a 9Router account is shown
as a **pool** with that said plainly. LAIN reads 9Router's providers from its own
discovery cache.

### What changed

| Area | What | Where | Verified by |
|---|---|---|---|
| **Accounts** | ACCOUNT → MODEL → EFFORT → EXECUTION. An account is a route: a 9Router pool (`<conn>:<prefix>`; access tiers fold; Antigravity's Gemini and Claude pools are one sign-in), an API key, a runtime (`runtime:claude-code`, `runtime:codex:<instance>`), a local server. A lane is `{account, model}`; a model the account does not offer is **refused before inference**; changing the account keeps the model when the new account offers it, else takes that account's default, else asks — never another account's route | `accountcatalog.js`, `sessionintel.js`, `provider.js`, `sessionviews.js` | `accountfirst`, `sessionintel` |
| | **Receipts name the requested and the actual account, and the route** — they must match | `modelrequest.js`, `usage.js` | `accountfirst` ROUTE; one real request (below) |
| | **Native Codex accounts are routes**: each signed-in home lists its models through Codex's own `model/list` (hidden presets stay hidden); Chat/BOT run `codex exec --json --ephemeral --ignore-user-config --sandbox read-only --cd <empty folder>` with `CODEX_HOME` = that account's home — the answer comes *as that account*; the same email twice stays two accounts; the Coding Agent never runs there (codex exec returns no tool calls to LAIN) | `drivers/codexexec.js`, `drivers/codex.js`, `accountinstances.js`, `runtimeconnections.js` | `codexroute` (fake Codex) |
| | A **runtime-only** person (no API key configured) was silently routed to the environment-key fallback: fixed | `provider.js` | `codexroute` |
| **MODEL** | Accounts (landing) · Models (by account; filter to one) · API (apart) · Local · Defaults (global → project → session, each naming its account); onboarding *Connect with Claude* · *Sign in with ChatGPT* · *Sign in with Google (9Router)*; **Available from 9Router → Adopt**; no 1,000-model dumps | `pageacctview.js`, `pagemodel.js`, `intelroutes.js` | `modelaccept-real` |
| **Chat** | app panel; first-run drawer + hint; composer Account · Model · Effort · Normal/Fast/Eco; the Coding Agent gated on a folder (Choose / Create / Clone), then enabled | `pagechat.js`, `pagecomposer.js`, `pageshell.js` | `chataccept-real` |
| **IDE** | Explorer (Open Editors; new file/folder, rename, delete, refresh, collapse); tabs (close / others / all / to the right, dirty dot, preview tab); breadcrumbs; split right/down; bottom panel **Problems · Output · Terminal · Debug Console** (Ctrl+J, Ctrl+\`); Problems → the line; Run and Debug (package scripts, launch configs; the debugger says which adapters this machine has and why one is missing); palette (Ctrl+Shift+P); status bar account › model | `pageide.js`, `pagesource.js`, `pageidepanes.js`, `pagedebug.js`, `pageeditor.js` | **`ideaccept-real`** (15 steps) |
| **Preview** | launch from the editor toolbar, the palette (*LAIN: Open Preview*), Ctrl+Shift+V or the activity bar — no Agent needed; when unavailable, disabled with the reason and *Configure Preview…*; a live CDP screencast, interactive by default (click, type, scroll, navigate); **Pick** hovers with an outline drawn by LAIN (the page's DOM is only read), a click selects and returns to Interact, Escape cancels; no native drag or text selection; the page is addressed in CSS pixels through its visual viewport; a large multi-line input with a *Selected* chip; Detach Preview keeps all of it | `pageworkshop.js`, `workshop/stream.js`, `previewroutes.js` | **`previewaccept-real`** (15 steps), `preview-real`, `workshop-real` |
| | **The dev server is proven to be this project's**: the listener's PID must be in the tree LAIN started (8.1 accepted anything answering the port) | `workshop/portowner.js`, `devserver.js` | `phase81` |
| **Parity** | one projection of the session's facts — session, project, task, account › model per lane, effort, execution, strategy, mode, phase, plan — for the terminal's `/status`, Telegram's `/status` and the window. The terminal's `/status` had resolved the **process default**, not the session: after the window chose an account it named a route the next turn would not take | `sessionfacts.js`, `diagnose.js`, `remotecontrols.js`, `harnessapp/state.js` | **`surfaceparity`** |

### Found by the real-window acceptance tests, and fixed

1. A **double-click opened a file twice** (the click's preview open had not landed when the double-click's arrived); typing then went to the wrong buffer and Ctrl+S saved nothing → one open per path in flight.
2. **Refresh re-read only the top folder**: a file made outside LAIN never appeared in an open folder → every expanded folder is re-read; the Explorer and Source Control refresh when the window regains focus.
3. **LAIN's own `.lain/` files appeared in the person's Source Control** → a `.lain/` LAIN creates carries a `.gitignore` of `*` (the pytest/venv convention); an existing `.lain/` is untouched.
4. **Picking an element sent the keyboard into its stylesheet** (the owner opened with focus) → the owner opens beside the Preview; the keyboard stays in *Say something to change…*.
5. **Removing an API key asked "Sign out of this account…?"** — twice → one confirmation, in the right words.
6. **Adopt sent only the provider**: with two 9Router connections, adoption landed on the wrong one and created a connection to the default address → the account id names its 9Router; one rule decides what a 9Router connection is. And **an isolated test could read the person's live 9Router** through that default address → never under isolation.
7. **A key added a moment ago listed nothing for a second** (writing the discovery cache did not invalidate the memoised catalog) → invalidated on write; a refresh asked for during an in-flight read is not dropped.
8. **Codex's answer used a text field no consumer reads** (`text`, not `chunk`) → fixed; the fixture reproduced it only once the test read the field everyone reads.
9. **A passing harness run never exited**: every window API call left its 30–120 s deadline timer armed (hundreds while the Preview streams), and a test's terminal outlived its Core → `deadline.js`; the test driver ends its Core's terminals.

And by the terminal's own smoke tiers (`cli`, `global`), run for this phase against the real binary:

10. **`/effort` described a route nothing used**: it read the process default after `/model` had chosen for the session, and wrote a process-wide effort the window and Telegram do not read → the session's lane, through the same Core action (`sessionintel`).
11. **The account-first `/status` outgrew its panel** (22 rows; rows that wrapped pushed the last off screen) → 13 one-line rows: session, project, task, Coding Agent (account › model), Chat (account › model), effort, execution, phase (with strategy, mode and plan), route (with the key's state), context (with turns and tokens), messages, index (with the window's state), config.
12. **Under the mock model the header asked to "choose an account"** — the mock answers every turn → it names the mock.
13. **Setting up a key and picking a model did not survive a restart** (the choice is per session now) → the model chosen while adding a key (`/api`) on a LAIN with no default becomes its default — `/model` elsewhere still chooses for the session only; the picker shows each model's exact id beside its name.
14. **`/source` and the troubleshoot report still suggested the retired website sources** ("/source chatgpt …") → they point at `/account` and `/model`; the two smoke tests that still expected ChatGPT.com now pin the retirement.

### Performance (§76–78) — measured on the real profile

A **copy** of the real profile (every account, 9Router's 1,076 models from the
cache, the encrypted keys) and a **copy** of a real project made into a git
repository with **171 uncommitted changes**; terminal UI forced; mock model; a
spawn trace and a CPU profile per run. (8.1 measured a project copy without
`.git`, so git never ran; the column "8.2, before" is this scenario.)

| | 8.1 (no git) | 8.2, before | **8.2, after** |
|---|---|---|---|
| time to first prompt | 0.86 s | 1.59 s | **0.34 s** |
| processes the prompt **waited for** (blocking launches) | — | 3 | **0** |
| one simple task — wall / CPU | 0.45–0.50 s / 0.36–0.47 s | 2.0–2.1 s / 2.2–2.3 s | **0.51–0.56 s / 0.45–0.66 s** |
| processes started by that task | — | 20 | **4** (the git reads themselves) |
| idle CPU, 30 s, after start and after a task | 0–0.4 % | 0.05 % | **0 %** — no redraws, no process started |
| working set, idle / after a task | 84 / 110–117 MB | 88 / 127 MB | 87–88 / 127–128 MB |

What it was:
1. **The header rebuilt every runtime connection on every redraw** — naming the next turn's model (account-first, this phase) asked for the runtime list, which read telemetry files and walked PATH for `claude` and `opencode` (~150 stats each): 2.4 s of a task's 2.9 s of CPU → the list is memoised per app for ≤ 1 s and dropped by the catalog's generation or a config change; every writer of its inputs invalidates it; PATH lookups are remembered (`pathlookup.js`).
2. **Four read-only git questions at every task's start went through the Agent's command runner** — a guardian process, a worker process and an identity query around each → `execFile`, same 20 s bound, and `GIT_OPTIONAL_LOCKS=0` so LAIN's look at the tree never takes the index lock under the person's own git.
3. **Startup waited on three process launches**: the assistant scheduler's identity (PowerShell) → asked without blocking; the key decryption (PowerShell/DPAPI) forced by the dashboard naming the model → keys are read in the background from launch, a listing never waits for one (a request does), and the dashboard announces after; `llama-server --version` → remembered per binary (path, size, time).
4. **§77 Source Control**: `git status` is event-driven (pane, focus, stage, commit), never on a timer, and a refresh asked for while one runs is folded into one more; diffs are fetched when a file is opened; the Explorer's letters come from the same status.
5. **§78 index**: incremental by size + mtime — a stat walk, never a full parse; nothing scans while idle.

### Real acceptance (§80)

One request through the person's own 9Router Codex pool (their coding default),
on a copy of the profile: the receipt named requested = actual account
(`lain:localhost:cx`) and the route, model `cx/gpt-6-sol`. LAIN sent 151 bytes
(the model id and one message — checked against a local capture of the same
request); the ~4.5k input tokens billed were 9Router's Codex instructions added
downstream; 5 output tokens.

### Not done — and why

- **One account inside a 9Router pool cannot be pinned** (9Router's chat path chooses and falls back itself); LAIN says so on the account. Per-account 9Router listing would need 9Router's dashboard session or its private CLI token.
- **A native Codex account serves Chat and BOT, not the Coding Agent** (`codex exec` works with its own tools and hands LAIN no tool calls).
- **Antigravity** is reached through 9Router (no official runtime sign-in LAIN could drive without borrowing its client).
- **Debugging**: this machine has neither debugpy nor a stdio Node adapter (js-debug speaks DAP over TCP); Run works, and the debugger says exactly that.

### Verification (2026-09-28, isolated profile, fakes only)

unit **3602 / 0** · integration **222 / 0** · workflow **4 / 0** · harness (real windows) **45 / 0** ·
and, for this phase, the terminal's own smoke tiers through the real binary — full runs: cli **435 / 2** ·
global **93 / 2**. The four were fixed and their files re-run: the two `/status` wording landmarks
(`compare`, `doctor`: 14 / 0) and the two tests still expecting the retired website sources
(`relay-dash-mcp`: 13 / 0).

The harness tier includes the four acceptance suites, each driven by real input
(`tests/harness/realinput.js`): `ideaccept-real` (the 15 IDE steps, and no turn
ran), `previewaccept-real` (the 15 Preview steps, the page's own side read too:
in Pick mode it received no mouse button, no drag, no selection),
`chataccept-real` (first visit → a folder attached → the Coding Agent) and
`modelaccept-real` (tabs → adopt → choose → filter → API apart → remove the key
→ detach, with every request the fake 9Router saw being a read). New unit suites:
`accountfirst`, `codexroute`, `surfaceparity`, `deadline`, `lainignore`.

After all four tiers no process with a test home was left running, and the
harness runner exits by itself. (The profiler's own supervisor was stopped by
its pid; nothing was stopped by name.)

---

## Phase 8.1 — correction, completion and performance pass (2026-09-28)

Phase 8's tests were green, but the screenshots of the running product showed a
different product from the one designed. This pass audited the screenshots and
the source against the 8.1 specification and fixed what they showed. **This
section is the current truth; where the Phase 8 matrix below disagrees, this
section wins.**

### What Phase 8 claimed vs. what the screenshots showed

| Claim (Phase 8 report) | Screenshot / source | 8.1 |
|---|---|---|
| Six-surface flat rail | the same big rail on **every** surface; LAIN/File/Edit/View/Help on every surface | **REGRESSION → fixed**: Contextual navigation (rail on Home only; compact LAIN switcher elsewhere); Persistent sidebar is a setting; File/Edit/View/Help in the IDE only (`pageshell.js`, `appearance.nav`) |
| IDE Agent sidecar ~320 px, resizable | the task card's plan steps drew **over** the conversation (P0) | **REGRESSION → fixed**: a global `.st{width:6px}` rule collided with the step rows and the card could shrink under its content; the card now keeps its own height, scrolls, and summarises (current step; steps on demand); question cards wrap; the input always stays on screen; *Show Coding Agent* when hidden (`pageide.js`) |
| Normal / Fast / Eco / Slow | Slow still offered | **FALSE → removed**: profiles are Normal · Fast · Eco; a saved or queued SLOW reads and re-saves as ECO; `/slow` is gone from Core, CLI, Telegram and the UI (`profile.js`, `workbench.js`, `session.js`) |
| Chat run panel | a heavy right-hand dashboard | **PARTIAL → fixed**: ~300 px, summary-first (where it stands, the one next action), details on demand, hideable (`pagework.js`) |
| Chat waiting state | a bare "CHECKPOINT COMPLETE" on an empty canvas | **FALSE → fixed**: one sparse supervisory card — status, latest checkpoint, pending ideas, a problem, ▶ Continue |
| MODEL rewrite | a dense database list, a narrow inspector | **PARTIAL → fixed**: model cards + a wide detail sheet; Sources with precise removal; 9Router adoption (`pagefabric.js`, `pagesources.js`) |
| Usage by window | correct but slow to open | **FALSE (performance) → fixed**, measured below |
| Website ChatGPT/Gemini sources | listed as providers | **retired** (`modelsource/registry.js`): not declared, not constructed, refused if selected; a session saved on one resumes on LAIN with its conversation untouched |

### What was added

| § | What | Where | Verified by |
|---|---|---|---|
| 1, 70 | "LAIN", not "LAIN V2", in user-facing text; README rewritten for the current Core/Harness/CLI; the old CLI detail moved to `docs/CLI-REFERENCE.md`. `~/.lain-v2` is **kept** as the storage path (a persistence contract; documented, not renamed) | `README.md`, `src/ui/launch.js`, `src/health.js` | `production.test.js` |
| 2–6, 71–72 | Contextual / Persistent navigation; IDE-only menubar; no second tab row | `pageshell.js`, `pageprefs.js` | `workbench-real`, `harnessapp-real` |
| 15–18, 73 | IDE sidecar fixed; hide/show; Editor ⇄ Coding Chat; assistant messenger | `pageide.js` | screenshots at 960×640 · 1280×720@150% · 1920×1032; `journey-real` |
| 19–21, 74 | **Say something to change…** (element → its owning source via the canonical Selection binding; nothing selected → the page on screen); **Detach Preview** (a second native window on the same Core: `Satellite` in `host.cs`) | `previewroutes.js`, `pageworkshop.js`, `host.cs` | `phase81` PREVIEW SAY; **`preview-real`** (real window, real dev server, detached window) |
| 26, 76 | Precise removal per source: *Remove API credential* · *Remove source* · *Detach from LAIN* · *Sign out* · *Detach reference* — only those that apply, each explained; removal never revokes the account | `sourcesroutes.js` | `phase81` SOURCES |
| 27, 75 | Website ChatGPT/Gemini retired | `modelsource/*`, `fabricroutes.js` | `engineering-session`, `chatonly`, `planhandoff`, `harnessapp` |
| 28–33, 75 | **9Router adoption**: 9Router's *public* model list (`GET /v1/models`, no key, no inference) grouped by provider prefix (`ag` Antigravity, `cx` Codex, `agcc` Claude …); your existing `lain:localhost` connection to it is recognised; adopting creates no second sign-in; 9Router's dashboard API and data folder are never touched | `ninerouter.js` | `phase81` 9ROUTER (fake 9Router; asserts only public endpoints are called) |
| 31 | Antigravity: through 9Router when it holds it; the Antigravity app detected otherwise (no tokens taken) | `sourcesroutes.js` | — |
| 34–38, 68, 78 | **MCP & Skills** surface; a real MCP client (stdio + Streamable HTTP); tools reach the model (read-only runs, others ask — EXTERNAL effect); secrets in DPAPI; skills validated, added disabled, announced by name/path; project recommendations; nothing auto-installs | `mcpclient.js`, `integrations.js`, `pagemcp.js` | `phase81` MCP, SKILLS (fixture MCP server) |
| 40–44, 77 | **`lain --serve`**: OpenAI-compatible (models, chat completions, streaming) and Anthropic-compatible (messages); loopback by default, remote only when allowed; a LAIN access token; `lain/<model>` aliases through the catalog; every request through `provider.chat` → `modelrequest` (origin *LAIN Server*); upstream keys never leave; stops with LAIN | `serve.js`, `serveroutes.js`, `cli.js`, `pagerouter.js` | `phase81` LAIN SERVER |
| 45–47, 84 | **Bots & Channels**: Connect (the bot stays where it is) vs Migrate (only when declared); status from the bot's own report — a live PID alone is "running", never "working"; per-capability permissions | `connectedbots.js`, `pagerouter.js` | `phase81` BOTS |
| 48 | Feedback is a button and a dialog only | `pagesettings.js` | — |
| 49–51, 79 | **GitHub Sync**: fetch → fast-forward when behind, merge when diverged, a conflict left for you with *Abort merge*; git itself refuses to overwrite local changes; never a reset. Status words: Up to date · N behind · N ahead · Local changes · Conflict · Offline | `github.js`, `pagegithub.js` | `phase81` GITHUB SYNC (local bare repos) |
| 60–63, 82 | **CLI close → Paused · CLI closed → ▶ Continue**: the CLI claims the writer with its pid and releases it on exit (unfinished work = a pause); a CLI killed without releasing is reaped by pid; Continue takes the writer, reloads the session from disk and continues the same session and plan; a live CLI is never taken over | `surfacehandoff.js`, `inputgate.js`, `repl.js`, `workbenchroutes.js` | `clicontinuity` |
| 13–14 | Chat composer: Model · Effort · Normal/Fast/Eco (Strategy moved into the run details) | `pagecomposer.js` | screenshot |

### Performance — measured, not assumed

Measured on this machine against a **copy** of the real profile (sessions,
usage, instances, encrypted secrets) and a copy of a real project; nothing was
sent to a provider (the task runs on the mock model).

**LAIN CLI** (`profcli` / `proftask`, forced TUI, 3 runs each):

| | before | after |
|---|---|---|
| time to first prompt | 3.35–3.45 s | **0.86–0.87 s** |
| PowerShell processes started at launch | **12** | **2** |
| CLI CPU during startup | 0.31–0.67 s | 0.38–0.42 s |
| one simple task (read + answer): wall | 1.66–1.77 s | **0.45–0.50 s** |
| one simple task: CPU | 1.72 s | **0.36–0.47 s** |
| working set, idle / after a task | 83–84 MB / 126–133 MB | 84 MB / 110–117 MB |
| idle CPU | 0–0.2 % | 0–0.4 % (noise) |

The heavy subsystems, found with a CPU profile and a spawn trace:
1. every stored API key was decrypted with its own PowerShell (DPAPI) — ten
   ~250 ms spawns per launch → **one batched call** (`secretstore.getMany`, `credentials.prefetch`);
2. the terminal UI rebuilt the whole connection list on **every redraw and
   status change** (walking PATH, asking `llama-server --version`, listing every
   runtime's models) → memoised per configuration generation, ≤ 1 s (`appcatalog.connections`, invalidated when a credential changes);
3. the assistant scheduler read two process start times in two PowerShell calls
   → one call, none when the previous holder is plainly gone; this process's own
   start time is asked once;
4. PATH lookups, `modeldirs.json`, `agentverify.json` and `credentials.json`
   were re-read dozens of times per listing → memoised on mtime + size.

**Usage** (Core routes, same copy):

| route | before (cold / warm) | after (cold / warm) |
|---|---|---|
| `/api/usage/limits` | 531 / 121 ms, 180 file reads — plus ≈ 2.6 s of per-key decryption on the first listing of a process | **404 / 18 ms**, 25 reads warm (the 404 ms includes the one batched decryption) |
| `/api/usage/windows` | 40 / 35 ms | **7 / 2 ms** |
| `/api/usage` | 11 / 5 ms | 20 / 4 ms (the cold call includes the one-time index build) |

**The usage index** (`usageindex.js`): each receipts file is parsed once per
process and then only its appended bytes; hourly aggregates by provider ·
account · model · project · session · role · origin are persisted
(`usage/index-v1.json`) and continued by the next process from each file's
recorded offset; reset windows are cached on the index generation. The Usage page
draws from this at once and re-reads provider limits in the background, marking
only the affected cards *Updating provider limits…*.

A latent bug found on the way: `reqtrace.reset()` restarted request ids, and
receipts are de-duplicated by id, so a later request could silently merge into an
earlier receipt. Ids no longer repeat.

A second one, found by the real-window contract test on this machine: when another
application already served `0.0.0.0:5300`, the Workshop still chose 5300 for the
project's dev server (Windows lets a bind to 127.0.0.1 succeed beside a wildcard
listener), saw the *other* app answer, and reported it RUNNING as this project's
preview. `devserver.pickPort` now also asks 127.0.0.1 whether anything answers
(`phase81` DEV SERVER PORT fails without the fix).

### Dependencies installed

None. Everything above uses Node's standard library (MCP client, HTTP server) and
tools already present. **GitHub CLI was not installed**: GitHub works through
`gh` when present, or a fine-grained token otherwise, and the tests use a fake
`gh`; installing it was not required.

### Verification (2026-09-28, isolated profile, fakes only)

unit 3582 / 0 · integration 222 / 0 · workflow 4 / 0 · harness (real windows) 41 / 0

No test process outlives its run: after all four tiers no `lain-supervisor`,
dev server, desktop window or MCP server with a test home was left running.

New suites: `unit/phase81.test.js` (server, 9Router, sources, MCP, skills,
preview scope, GitHub sync, bots, usage index), `unit/clicontinuity.test.js`,
`smoke/preview-real.test.js`; the real-window suites were updated for
contextual navigation, seven surfaces and the retired sources.
`workbench-real` asserts no horizontal overflow on all seven surfaces at
960×640, 1280×720, 1600×900, 1280×720@150 % and interface scales 80 % and 200 %.

---

## Phase 8 audit matrix (historical — see 8.1 above where it differs)

| Area (spec §) | Before | Now | Where |
|---|---|---|---|
| Navigation HOME · IDE · CHAT · MODEL · USAGE · SETTINGS; BOT/SESSION not top-level | PARTIAL (8 tabs) | Six tabs on a flat left rail; BOT opens as a Settings sub-surface, SESSION inside Chat | `pageshell.js` |
| Palette Workbench visual language (no gradient/glow/glass; large type; flat blocks) | FALSE | Token system per mode × palette, flat blocks, large display type; remaining glow removed | `pagetheme.js`, all `CSS8` overlays |
| Chat / Coding Agent lanes on one canonical session | PARTIAL (threads existed, no lanes) | Two lanes over `session.thread`; one session | `pagechat.js`, `pagescript.js` |
| Coding Agent requires a project (disabled + hover reason; Choose / Create / Use IDE project) | PARTIAL | Lane disabled with reason; project menu; attach/move/remove/create on the same session | `pagework.js`, `viewroutes.js`, `workspaceroutes.js` |
| Chat auto-routing to the Agent | OBSOLETE | Chat never routes to the Agent unless asked (`agent: true`) | `viewroutes.js` |
| Plan in Chat first / Implement directly for broad requests | FALSE | `PLAN_FIRST` offer, no model call | `supervision.js` (`isBroad`, `planFirstOffer`) |
| Plan card: Send to Coding Agent / Edit / Discuss | PARTIAL (accept only) | Card + `/api/plan/send` (needs a project; seeds phases) | `pageplan.js`, `workbenchroutes.js` |
| Smart supervision (no racing; pending steers; urgent steer with cost warning) | FALSE | `chatWhileRunning`: status / pending steer / `URGENT_STEER` offer | `supervision.js` |
| Structured findings; plan deltas (approved vs discovered) | FALSE | `report_finding` tool → findings; CONSEQUENCE deltas auto-added, others PROPOSED | `tools/plan.js`, `supervision.js` |
| Phase completion card (Continue / Review / Discuss / Pause) | FALSE | Checkpoint builds landed/found/failed/remaining; cards in the run panel | `supervision.checkpoint`, `pagework.js` |
| Chat gets compact state, not the transcript | FALSE | `supervision.chatContext` in the chat live tail | `promptparts.js` |
| Auto-hide chat sidebar (Projects / Chats / Coding, pinnable) | FALSE | Edge-hover overlay, pin | `pagechat.js` |
| Palette composer (Model · Effort · Execution [· Strategy]) | PARTIAL | Cells, menus, slash suggestions | `pagecomposer.js` |
| Execution profiles | OBSOLETE (Slow aliased Eco) | 8.1: Normal · Fast · Eco — Slow removed, migrated to Eco | `profile.js` |
| `/fast` `/eco` `/slow` toggles; mode change mid-run queued | PARTIAL | Toggle; queued to the next checkpoint | `modecommands.js`, `runstrategy.queueProfile` |
| Slash commands invoke Core, never the model | PARTIAL | `/api/controls/run` first; suggestions on "/" | `remotecontrols.js`, `pagescript.js` |
| Long Context Phasing; honest estimate; review policy | FALSE | Strategies Normal/Phased/Long; estimate only from observed phases + provider window, else "High usage expected." | `runstrategy.js` |
| Mid-journey Fast offer | FALSE | `FAST_OFFER` at checkpoints | `supervision.checkpoint` |
| QUOTA_PAUSED with ▶ Continue = re-check now | FALSE (waited on stale timer) | `quotapause.recheck/resume`; continuation state kept | `quotapause.js` |
| Usage per provider reset window (5-hour/weekly/monthly/credits), LAIN-observed per window, current vs previous, breakdown shares of observed usage | FALSE | `resetwindows.windows`; USAGE › Windows (default) with cards, observed stacked bar, breakdown | `resetwindows.js`, `pageusage.js` |
| MODEL: Models / Sources / Local / Defaults; passive selection | PARTIAL | Four tabs; model list rows; selection sends nothing (unit-tested) | `pagemodel.js`, `pagefabric.js` |
| IDE optional; Agent sidecar 280–360 px resizable/hideable; Editor ⇄ Coding Chat; floating assistant; project-mismatch dialog | PARTIAL (BOT/AGENT subtabs) → OBSOLETE subtabs | Sidecar with drag width, centre switch, floating LAIN Assistant, mismatch dialog | `pageide.js`, `pageassist.js` |
| Global zoom Ctrl +/−/0, 80–200, persisted, whole window | FALSE | Host `ZoomFactor` (CSS zoom fallback), captured before any surface | `host.cs`, `pagetheme.js` |
| Typography / Icon scale | FALSE | `--ts`/`--tsn`, `--ic` | `page.js`, `pageicons.js` |
| Palettes LAIN Dark/Light, Slate, Violet, Coral, Mono, Custom (5 tokens) + Reset; dark/light independent | FALSE | Settings › Appearance; custom derived client-side; reset palette / all | `appearance.js`, `pageprefs.js` |
| Theme presets (LAIN / VS Code / Cursor / JetBrains / imported) | FALSE | Editor + terminal colours follow palette and preset; extension colour themes read as data | `pagekeymap.js`, `exttheme.js` |
| Keymap presets (LAIN / VS Code / Cursor / JetBrains / Custom), independent of theme | FALSE | One command table, per-preset chords, recorded custom overrides, conflicts shown; menus show the chords in force | `pagekeymap.js`, `pageprefs.js` |
| AGENTS.md global + project: view/edit/save/reset with diff + confirm; effective view; no silent overwrite | PARTIAL (read-only) | Settings › Agent Instructions; save re-checks disk; reset shows the diff and keeps a backup | `agentsmd.js`, `pageprefs.js` |
| GitHub: secure auth, discovery, clone → project, Coding disabled until cloned, explicit actions, no silent push/merge, never edit remote in place | FALSE | gh CLI sign-in or fine-grained token (classic refused) in DPAPI; picker; clone; confirmed actions only | `github.js`, `pagegithub.js` |
| Feedback: types, explicit attachments, never secrets/source/prompts/conversations, review before submit | FALSE | Settings › Feedback and Help › Send Feedback; Review required; screenshot via host capture | `feedback.js`, `pagefeedback.js` |
| Continue in CLI (writer handoff, no replay; hand back) | FALSE | Writer lease in the session file; `/handback`; Harness holds sentences while the CLI writes | `surfacehandoff.js`, `inputgate.js` |
| Harness / CLI / IDE / Telegram on canonical state; Telegram /target /model /account /effort /fast /eco /slow /mode /status /usage | FALSE | `remotecontrols` shared by Harness and Telegram; `/target` in the gateway | `remotecontrols.js`, `bot/*` |
| Session rename | FALSE | `/api/session/rename`, title persisted | `sessionroutes.js`, `session.js` |
| Settings organisation (Appearance, Assistant, Models, Agent Instructions, Keymap, Extensions, Plugins/Skills/MCP, GitHub/Accounts, Channels, Security, Advanced, Feedback) | PARTIAL | Grouped nav: Workspace · Assistant · Agent · Tools · Accounts · Advanced · System | `pagesettings.js` |
| Home (greeting, current focus, quick actions, recent projects, system status) | PARTIAL | Rebuilt on canonical state; no invented figures | `pagehome.js` |

## Preserved (not redesigned)

Handover, compaction, continuation, landed/remaining/failed, evidence,
project/task state, plans, AST, GUG, Selection, Laya, modelrequest,
provider/runtime ownership, retries, cache and session continuity are
unchanged. (8.1: the ChatGPT/Gemini website sources are retired.) OpenCode runs via
its bridge; ZCode stays telemetry-only; Freebuff was Detected + Launch +
legitimate telemetry only (historical — Freebuff was removed in 8.3). Nothing spoofs a provider app, borrows OAuth
client IDs or extracts tokens.

## Tests added

* `tests/unit/workbench.test.js` — project binding, plan-first, supervision,
  checkpoints, Long Context Phasing, estimate honesty, queued profiles, quota
  re-check, send-to-agent, findings, persistence.
* `tests/unit/phase8core.test.js` — AGENTS.md, GitHub (fake `gh` over local
  bare repos), feedback privacy, CLI handoff, controls, appearance, reset
  windows, passive selection, imported themes.
* `tests/smoke/workbench-real.test.js` (harness tier, real window) — six
  rooms; Ctrl +/0 zoom persisted by Core; palette card + Light independent;
  JetBrains keymap (Ctrl+Shift+A → palette; Shift+F6 listed); Agent
  Instructions write/save and a cancelled Reset that writes nothing; Feedback
  Submit gated on Review with every attachment unticked; USAGE opens on
  windows; no bleed at 960×640, 1280×720, 1600×900, 1280×720@150%, scale 80
  and 200.
* Updated for the six-room shell: `desktop-real`, `harness-contract-real`,
  `harnessapp-real` (conversation list via the new Conversations button),
  `journey-real` (Agent sidecar + floating Assistant replace the BOT/AGENT
  sub-tabs), `unit/journey` (architecture), `unit/desktopboundary` (host verbs
  `capture`, `zoom`), `unit/exthost` + `unit/extpackages` (a colour theme is
  now usable; the unsupported example is a views-only extension).

## Results (2026-09-27, isolated profile, fakes only)

unit 3577 / 0 · integration 223 / 0 · workflow 4 / 0 · harness 40 / 0
