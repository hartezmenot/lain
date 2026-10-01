# Model sources — the intelligence fabric (Phase 8.3, lifecycle and authentication from 8.4)

> **8.4 changes to read first.** A *backing account* is always a **CONNECTED** account. Imported router pools and
> migrated placeholders are **metadata under "Finish setup"** (`IMPORTED_PENDING_AUTH`): never routed, never counted,
> never a fallback target. Connecting an account is an **AuthSession** (`src/authsession.js`) scoped to one new
> AccountInstance in its own private profile (Claude `CLAUDE_CONFIG_DIR`, Antigravity `GEMINI_HOME`, Codex overlay
> home) — it never changes an existing account and never touches a running request. Discover, Connect and Import are
> three different acts. See `docs/HARNESS-PHASE8.md` § Phase 8.4.
>
> **8.4.1 changes to read next.** MODEL › Accounts lists only connected accounts, one plane per provider; *Finish setup*
> and *Discovered on this PC* are their own surfaces, *Import accounts* is an item of the toolbar's ⋯. Every account
> can be **detached** on its own (LAIN forgets it; nothing is signed out) — Sign out and Remove-profile are separate,
> confirmed, LAIN-owned-only acts, and an account a request is working through refuses all three ("In use by Coding
> Agent"). **Gemini OAuth is Antigravity** (one Google provider; the Gemini API stays an API source), and an Antigravity
> account advertises Chat/Assistant only after a real message through it succeeded. **Quota is always stated as what
> remains** ("74% remaining"; the tray says "N% left"); red is 5 % remaining or less, never 100 % remaining.

One Core-owned registry of everything LAIN can use to think. The Harness, the
CLI, Telegram and `lain --serve` are projections of it; none keeps a second
copy. Code: `src/fabric/` (store, index, policy, effortcaps, fallback, tray,
migrate, dashlaunch), `src/sessionintel.js` (the lanes), `src/accountcatalog.js`
(the raw accounts and their catalog routes).

```
LAIN Core — the intelligence fabric
│
├─ Provider families      Codex · Claude Pro · OpenCode · Z.ai · Local · one per API source
├─ Backing accounts       per family: alias, masked identity, reported quota, priority
├─ API sources            keys in the Windows secret store
├─ Runtime sources        Claude Code, Codex homes, OpenCode, ZCode
├─ Local sources          llama.cpp, Ollama, GGUF folders
├─ Logical models         per family, with per-account catalog ids
├─ Effort capabilities    per model (and per backing account)
├─ Quota windows          only what a provider reported
├─ Account policies       Automatic fallback · Use one account only · Ask before switching
└─ Defaults               Chat · Assistant · Coding · Research · Vision · Auxiliary
        ↑
  Harness   CLI   Telegram   lain --serve
```

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Provider family** | Who serves a model, as a person names it: *Codex*, *Claude Pro*, *OpenCode*, *Local*, *DeepSeek API*. Appears once, however many accounts stand behind it. |
| **Backing account** | One authenticated account of a family (a Codex home signed in with ChatGPT, Claude Code's sign-in, an imported router pool while its migration is pending). Capacity, not identity: it is never part of a model's name. |
| **Account policy** | How a family's backing accounts are used: *Automatic fallback*, *Use one account only*, *Ask before switching*. |
| **Logical model** | The model itself (`gpt-6-sol`), independent of which account or router namespace reaches it (`cx/gpt-6-sol` is the same logical model). |
| **Effort** | How much the model reasons. Each model declares its levels (`minimal · low · medium · high · xhigh · max`, or none). |
| **Execution profile** | How LAIN orchestrates the task: *Normal · Fast · Eco*. Independent of effort. |
| **OAuth / Runtime / API / Local** | How a source is authenticated: a provider's own sign-in; a runtime program's own sign-in; an API key LAIN holds; this machine. |

## 2. The lane — what a session runs on

`sessionintel.lane(app, session, 'chat' | 'coding')` returns, for every surface:

```
family, familyLabel         Codex
model, modelLabel           gpt-6-sol · GPT 6 Sol
effort, effortLabel         xhigh · XHigh        (only a level the model declares)
efforts[]                   the model's levels   (the effort picker, exactly)
policy, policyLabel         auto · Automatic fallback
account, backing            the backing account serving it NOW (diagnostic)
route                       the exact catalog route of that account
pending                     an account question waiting on the session
```

Stored per session: `session.intel.lanes[lane] = { family, effort }` and the
backing account where Phase 8.2 kept "the account" (`accountSelections.chat`,
`views.coding.connection`). The route is always resolved from backing account +
that account's catalog id for the logical model. Layers: session → project →
global (the fabric's role defaults, `fabric.json`).

## 3. Account policy and fallback

`fabric/policy.js` decides from the **eligibility index** — family → logical
model → the accounts that serve it and the effort levels each offers — and the
limits providers reported. It never probes a model.

| Policy | On a limit |
|---|---|
| Automatic fallback | the next healthy account (priority order) serving the **same model at the same effort**; the same task continues (`fabric/fallback.js` → `submitclose.js` resubmits with `sameTask`). Recorded as a `fallback` event: tray, account detail, every status. |
| Use one account only | never switched: the question *Switch account · Wait · Choose another model* waits on the session (`session.intel.pending`). |
| Ask before switching | the next account is proposed; **no request goes through it** until *Switch* (`POST /api/intel/decide`, the CLI's panel, Telegram). |
| No compatible account | asked — LAIN never lowers the effort or changes the model on its own. |

## 4. Effort

`fabric/effortcaps.js`. Levels come from, in order: the person's override
(`fabric.json efforts`), the provider's own report (Codex `model/list`
`supportedReasoningEfforts`, a route whose ids fuse the level such as
`gpt-5.5-high`), or a documented transport (Claude Code `--effort`, the
Anthropic API's `output_config.effort` — Opus: low…max, Sonnet: low/medium/high,
Haiku: none). A model with none has no effort control. A level becomes wire
syntax in one place: Codex `-c model_reasoning_effort="xhigh"`, Claude Code
`--effort xhigh`, an API route's fused upstream id or request field.

## 5. The Model Dashboard

Harness MODEL; opened from the CLI by `/model manage`, `/account add`,
`/api add`; from the tray (*Models & Accounts*) and Home search. Tabs: Accounts ·
Models · API · Local · Defaults (`page/pagedash.js`). From a terminal
(`fabric/dashlaunch.js`): this LAIN's window navigates; else the LAIN already
running is asked over its control pipe (`dashboard:<section>` — a section name
from a fixed list, nothing else); else this LAIN opens its own window at MODEL.
No credential ever travels in a URL or an argument; the terminal learns only the
safe completion event (`source-added`: id, name, capabilities).

## 6. Import accounts (migration)

`fabric/migrate.js`. Sources: a router LAIN is connected to (its provider
prefixes, from LAIN's own model listing) and a router export file the person
picks. An **API key the person owns** is verified against the **provider's own
endpoint** and kept in the secret store — the router is not in the path
afterwards. An **OAuth sign-in a router holds is never copied** (its tokens were
issued to the router's client): it becomes a placeholder under its family —
"Account discovered. Sign in again to finish migration." — resolved when LAIN's
own sign-in for the same identity appears. A family with no LAIN sign-in yet
(Antigravity) says so. A likely duplicate is asked about: *Keep existing ·
Replace · Add separately*. Provenance is kept in the migration history only.

## 7. Quota and the tray

Only windows a provider reported are shown (5-hour, weekly, monthly, credits), each as what REMAINS (providers report what is
used; a provider that reports what remains is kept as it said) —
from runtime telemetry, a response's limit headers, Codex's rate-limit read.
LAIN's observed tokens (Usage) are a different fact and never become a quota
percentage. The tray (`fabric/tray.js` → `native/host.cs`) is pushed only when
its summary changes: after a receipt, an account change, a fallback, a manual
refresh, and once at the next known reset. No polling.

## 8. `lain --serve`

Logical routes `lain/<family>/<model>`; the family's policy chooses the backing
account; `reasoning_effort` must be a level the model declares. No route names
an account or an identity. `server.pinnable: true` lets a client append
`@<account alias>`.

## 9. Not providers

- **Website chat services** (ChatGPT.com, Gemini.google.com) are not model
  providers. Retired in 8.1; in 8.3 their adapters, sign-in and check tooling
  and the web chat transport were removed. A session saved on one resumes on
  LAIN with its conversation intact. If a website assistant is ever used, it is
  a Skill/MCP/browser capability for Chat only — never the Coding Agent, a
  worker, a fallback or a `lain --serve` model.
- **Routers** (9Router, OmniRoute) are migration inputs, not dependencies. A
  router pool imported in 8.2 serves as a backing account of its family,
  marked *migration pending*, until its accounts are signed in with LAIN.
- **Freebuff** is removed from the product (8.3).
