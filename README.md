# LAIN

LAIN is a persistent AI workspace for building software. It keeps one
conversation, one plan and one piece of work continuous across a desktop
application, a terminal and your messaging apps: you discuss and plan in
**Chat**, a **Coding Agent** implements in your project, and every change,
check and decision is recorded as evidence.

The model decides what to do; LAIN owns everything around it — sessions, plans,
tools, verification, handover between models, compaction, usage accounting and
the project state — so work survives a closed terminal, a quota reset or a
model change.

> **Status: alpha.** Capabilities are documented only once they exist and are
> verified. [`docs/STATUS.md`](docs/STATUS.md) records the verification tier for
> each; [`docs/HARNESS-PHASE8.md`](docs/HARNESS-PHASE8.md) is the current
> product audit.

---

## The pieces

| | What it is |
|---|---|
| **LAIN Core** | The one owner of state: sessions, tasks, plans, evidence, provider and runtime routing, usage, permissions. Everything else is a surface over Core. |
| **Harness** (Start → LAIN, or `lain --desktop`) | The desktop application: Home, IDE, Chat, Design, Model, Usage, MCP & Skills, Settings. |
| **CLI** (`lain`) | The same Core in a terminal. A task started here can be continued in the Harness and back. |
| **Messaging** | Telegram (and other channels) as another surface of the same sessions — [`docs/BOT.md`](docs/BOT.md). |
| **LAIN Server** (`lain --serve`) | LAIN's connected models, served to other applications on this computer. |

### Chat and the Coding Agent

A session has two lanes over one canonical state:

- **Chat** — discuss, research and plan. No project needed. It supervises the
  Agent without racing it: while the Agent works, a new idea is kept as a
  *pending* steer and offered at the next checkpoint; an urgent one can be sent
  at a safe boundary.
- **Coding Agent** — implements in a **project directory** (required; choose a
  folder, create one, or clone from GitHub). Broad requests are offered *Plan in
  Chat first* or *Implement directly*; a plan you approve is sent to the Agent
  in the same session.

Execution profiles are **Normal**, **Fast** and **Eco** (`/fast`, `/eco`; typing
the active one again returns to Normal). Run strategies are Normal, Phased and
Long Context Phasing, which continues phase by phase and stops only for a
problem, a decision or a limit.

**Closing the CLI never ends a task.** If the Agent was working in a terminal
that closes, the Harness shows *Paused · CLI closed* and **▶ Continue** resumes
the same session, plan and phase — no transcript replay, no new session. The
same button resumes after a provider limit resets (it re-checks now, not on a
stale timer).

### IDE

The IDE is optional; the Agent works the same without it — and everything a
developer expects works without the Agent: the **Explorer** (open editors, new
file/folder, rename, delete, refresh), tabs (preview tabs, dirty state, close
others / to the right / all), breadcrumbs, **split** editors, search, the bottom
panel (**Problems · Output · Terminal · Debug Console**, Ctrl+J), Source Control
with diffs and commits, Run and Debug (the project's scripts and launch
configurations; the debugger says which adapters this machine has), and the
command palette (Ctrl+Shift+P). The Coding Agent is a resizable, hideable
sidecar (it keeps running while hidden) with an *Editor | Coding Chat* switch.

The **Preview** opens straight from the editor toolbar, the palette or
Ctrl+Shift+V. It is the live page, not a picture: click, type, scroll and
navigate it. **Pick element** is an explicit mode — hover outlines, a click
selects, Escape leaves, nothing is dragged or copied — and **Say something to
change…** sends the Agent a narrow change for the source that owns the selection
(or, with nothing selected, for the page on screen). **Detach Preview** opens it
in its own window with all of the same.

### Model — one intelligence fabric

Every surface — the Harness, the CLI, Telegram and `lain --serve` — reads and
writes **one** Core-owned registry. What you connect, rename, reorder or remove
on one surface is on the others at once.

**What you choose, everywhere, in this order:**

| | Example | What it is |
|---|---|---|
| **Provider** (provider family) | Codex · Claude Pro · OpenCode · Local · DeepSeek API | who serves the model — each appears **once** |
| **Model** (logical model) | GPT-6 Sol · Opus 5.5 | the model itself — never "Codex Account 3 › GPT-6 Sol" |
| **Effort** | High · XHigh | how much the model reasons — **only the levels that model declares**; a model with none has no effort control |
| **Execution** | Normal · Fast · Eco | how LAIN orchestrates the task — one dropdown; `/normal` `/fast` `/eco` |

Effort and execution are independent: *Opus 5.5 · XHigh · Fast* and *Opus 5.5 ·
XHigh · Eco* are both valid. A level a model does not declare is never sent.

**What LAIN manages underneath — backing accounts and account policy.** A
provider family can have several signed-in accounts (eight Codex sign-ins, two
Claude accounts). They are *capacity* behind the provider, shown on demand
(Model › Accounts › the provider): alias ("Personal", "Work" — the identity is
kept and shown masked), reported quota, fallback priority. Each provider has an
**account policy**:

- **Automatic fallback** — the first healthy account in priority order; on a
  limit, LAIN moves to the next account that serves the **same model at the same
  effort** and carries on the same task — session, task, model, effort,
  execution, plan and phase unchanged. The tray and the account detail say
  "Codex switched to Work — Personal rate limited".
- **Use one account only** — never switched without asking: *Switch account ·
  Wait · Choose another model*.
- **Ask before switching** — the next account is proposed; nothing is sent
  through it until you say *Switch*.

If no other account serves the model at that effort, LAIN asks. It never
changes the model or lowers the effort on its own. Every request's receipt
records the provider family, the logical model, the effort and the backing
account used.

**Kinds of source** (Model Dashboard tabs):

- **Accounts** — OAuth / subscription and runtime sign-ins, each through the
  provider's own supported flow: Claude (Claude Code's sign-in), Codex (Sign in
  with ChatGPT, in a Codex home LAIN keeps per account), Z.ai (ZCode's own
  sign-in), OpenCode (its own runtime — its free models run only inside it).
  **Import accounts** moves accounts from a router you used before: an API key
  you own moves after its provider accepts it; an OAuth sign-in the router held
  is never copied — it waits under its provider until you sign in with LAIN.
  After that, nothing depends on the router.
- **Models** — the logical models of every provider, searched in LAIN's index
  (built once; pickers and search never re-fetch a catalog).
- **API** — API sources only (OpenAI, Anthropic, Z.ai, DeepSeek, any
  OpenAI- or Anthropic-compatible endpoint). **A key is entered only here**:
  never in the terminal, never in a conversation. `/api add`, `/account add` and
  `/model manage` open this dashboard from the CLI — in the running LAIN's
  window, or a window of its own — and the terminal hears back only "API added:
  DeepSeek API (lain:deepseek) · 12 models".
- **Local** — llama.cpp, Ollama and GGUF folders; no account fiction.
- **Defaults** — Chat · Assistant · Coding · Research · Vision · Auxiliary:
  provider, model, effort, execution and account policy (a backing account only
  when you pin one).

Removing something from LAIN never revokes the account itself. LAIN never
impersonates a provider's app, borrows its OAuth client, copies its credentials
or scrapes browser cookies; where an entitlement belongs to another
application's runtime, LAIN drives that runtime. Website chat services are not
model providers in LAIN.

**The tray** shows each provider's accounts and only the quota windows the
provider reported (5-hour, weekly, monthly, credits — never estimated from token
counts); a click opens a compact panel: Open LAIN · Models & Accounts · Usage ·
Active Tasks · Pause/Continue task · Exit. Core pushes it only when something
changes — no polling.

### Usage

Per provider reset window (5-hour, weekly, monthly, credits): the provider's own
used/remaining percentage, and beside it what LAIN observed inside that window —
input, output, reasoning, cache read/write, requests — current versus previous,
broken down by project, session, model or account. Usage is **indexed**:
receipts are parsed once and then only their new lines, so opening Usage never
re-reads history.

### MCP & Skills

Extend LAIN to other applications — Godot, Unreal, Blender, OBS, browsers,
databases, your own tools — through **MCP servers** (local programs over stdio,
or HTTP) and **Skills** (folders with `SKILL.md`, the open Agent Skills format).
Tabs: Installed · Discover · MCP · Skills · Custom.

The **Skills Hub** (Discover) finds compatible skills in sources you add — a Git
repository (skills.sh-style), a folder of Hermes / Agent Skills skills, a catalog
URL — and searches them in LAIN's own index at once (sources refresh in the
background). *Inspect* shows the source, author, version, license, files,
dependencies and requested capabilities; *Install* copies the skill into LAIN's
own skill store and validates it. LAIN never starts another agent runtime (such
as Hermes) to run a skill, and never runs a downloaded script on its own: a skill
with scripts or dependencies is installed disabled and enabled only after you
confirm. Updates never overwrite a local change silently — *View diff · Update
and overwrite · Keep local · Duplicate*.

Nothing installs itself: a project's recommendations and well-known
integrations are suggested with the exact command, and you add them. A tool its
server does not mark read-only asks before it runs; secrets you give a server are
kept in the Windows secret store, never in a prompt.

### GitHub projects

Clone a repository into a real local working tree and work there. **Sync**
fetches and brings remote commits in safely: a fast-forward when you are only
behind, a merge when you have diverged, and a conflict is left for you (with
*Abort merge*) — never a reset, never a discarded change. Push, pull requests
and issues are explicit actions; nothing is pushed or merged because the Agent
edited files.

### Bots & Channels

Your everyday assistant is Chat. **Settings › Bots & Channels** connects
*external* bots to the LAIN house: LAIN reads their own reported status (a live
process alone is never shown as "working") and lends them only the capabilities
you allow. *Connect* keeps a bot as it is; *Migrate* imports its setup into a
LAIN bot profile only when the bot declares a migration.

### LAIN Server

```bash
lain --serve                 # http://127.0.0.1:20790/v1
```

OpenAI-compatible (`GET /v1/models`, `POST /v1/chat/completions`, streaming) and
Anthropic-compatible (`POST /v1/messages`). Clients use a **LAIN access token**
(Settings › Router Server); your provider keys and sign-ins never leave LAIN.
Models are exposed as **logical routes** — `lain/codex/gpt-6-sol`,
`lain/claude/opus` — and the provider's account policy chooses the backing account
underneath, exactly as for a session; no route names an account, and an OpenAI
`reasoning_effort` is honoured only when the model declares that level. (The older
`lain/<model>` aliases still resolve; `server.pinnable` lets an advanced client
append `@<account alias>`.) It listens on this computer only unless you explicitly
allow remote access.

---

## Install

**Windows:** run `LAIN-Setup-<version>.exe` — one installer for the CLI and the
Harness (with Design), per user, no administrator. Then Start → **LAIN** opens the
Harness, and `lain` works in any terminal. Details: [`docs/INSTALL.md`](docs/INSTALL.md).

```bash
lain --doctor        # what works on this machine, and why anything does not
lain                 # the CLI, in any project
lain --desktop       # the Harness (or Start → LAIN)
```

| | Where |
|---|---|
| The program | `%LOCALAPPDATA%\Programs\LAIN` — updated by LAIN's updater ([`docs/UPDATER.md`](docs/UPDATER.md)) |
| Your data | `~/.lain` — settings, accounts, credentials (Windows DPAPI), skills, sessions, logs. The one home. |
| Development | one repository (this one): Core, CLI, Harness (`harness/`), Design (`packages/design-core/`), installer — [`docs/RUN-FROM-CHECKOUT.md`](docs/RUN-FROM-CHECKOUT.md) |

Everything optional — Chromium for previews, git, GitHub CLI, runtimes — is
reported honestly by `lain --doctor`.

## Documentation

| | |
|---|---|
| [`docs/CLI-REFERENCE.md`](docs/CLI-REFERENCE.md) | the terminal interface, commands, keys, providers and catalog |
| [`docs/HARNESS.md`](docs/HARNESS.md) | the evidence harness: verification, artifacts, environments |
| [`docs/HARNESS-PHASE8.md`](docs/HARNESS-PHASE8.md) | the Palette Workbench (Phase 8 → 8.3) — what exists, verified |
| [`docs/MODEL-SOURCES.md`](docs/MODEL-SOURCES.md) | the intelligence fabric: provider families, backing accounts, policy, effort, execution |
| [`docs/BOT.md`](docs/BOT.md) · [`docs/COWORK.md`](docs/COWORK.md) | messaging and file work |
| [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) | installing and updating |

## Tests

```bash
node tests/run.js unit          # also: integration · workflow · harness (real window)
```

Tests run in an isolated profile against fakes only — no real account, no real
quota, no real home directory.

## Credits

LAIN is developed by its author with AI assistance; every capability is checked
against the running system before it is described here.
