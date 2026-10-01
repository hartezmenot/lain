# Reference study — 9Router, OmniRoute, LainRouter (`E:\AI\router`)

*Gate 2, §66 — 2026-09-30. What LAIN learned from three local routers, what it
built instead, and what it deliberately does not do.*

## Ground rules

- **Read-only reference.** `E:\AI\router` (LainRouter) and the two routers it
  studied were read as source; none of them is started, linked, or called by
  LAIN. There is **no runtime dependency**: LAIN runs with no router installed.
- **No source copied.** Every mechanism below is an independent
  implementation in LAIN's own modules. Where an idea came from a reference, the
  table says so.
- **Router data is a migration source only.** `fabric/routerimport.js` opens a
  router's SQLite store read-only, in memory, when the person opens *Import
  accounts*; after migration LAIN never reads it again. Tests use fixtures only
  (`tests/fixtures/…`); the one real-store action taken during this study was
  printing account *shapes* (provider, auth type, which credential fields are
  present — booleans) from OmniRoute and 9Router, never a value.

## Licences

| Project | Version / commit | Licence | Use in LAIN |
| --- | --- | --- | --- |
| 9Router | v0.5.86, `39e36d3d0c849e0e01dfeacddf111edf892448fc` | MIT | Store layout read by the importer (`%APPDATA%\9router\db\data.sqlite`, table `providerConnections`). No code. |
| OmniRoute | 3.8.51, `5483abb4b3e3502c340ffd46b6dfde6a400ae5b5` | MIT | Store layout read by the importer (`~\.omniroute\storage.sqlite`, table `provider_connections`). No code. |
| LainRouter (`E:\AI\router`) | working tree, 2026-09-30 | MIT (its own `ATTRIBUTION.md` credits 9Router UI primitives, OmniRoute studied only) | Ideas listed below. No code. |

All three are MIT; had anything been copied, the notice would travel with it.
Nothing was, so no third-party notice is added to LAIN for them.

## What was studied, and what LAIN does

| Topic | In the references | In LAIN (independent) | From the reference |
| --- | --- | --- | --- |
| **OAuth account storage** | LainRouter seals secrets with AES-256-GCM, key in `data/.router.keys` hardened by `icacls`/`chmod 600` (`src/secrets.ts`); 9Router and OmniRoute keep tokens in SQLite rows. | Secrets go to the Windows secret store (DPAPI) through one boundary, `credentials.js` → `secretstore.js`; everything else holds a *reference* (`cred:<owner>:<kind>`). Provider sign-ins stay in each account's **own** provider profile. | The "one owner of how a secret is protected" rule. Mechanism differs (DPAPI, not a key file). |
| **Token refresh** | LainRouter and 9Router act as the OAuth client and refresh tokens themselves. | LAIN does **not** refresh other applications' tokens. The provider's own runtime renews its sign-in inside the account's own profile (`codex app-server`, Claude Code, Antigravity). A Codex sign-in moves only when it was issued to Codex's own client (`fabric/portable.js`). | Rejected on purpose: a token issued to another app's client is not LAIN's to use. |
| **Account isolation** | One DB row per account. | One provider home / config directory / instance profile per account (`drivers/codexhome.js`, `drivers/claudeaccount.js`, `drivers/antigravity.js`). *Connecting account B never modifies account A* — `tests/unit/authisolation.test.js`. No provider-global logout. | — |
| **Account fallback** | `selectAccount`: same product, ordered priority, never after output; per-quota-family locks (`src/account-failover.ts`, `DEFAULT_QUOTA_LOCK_MS` = 15 min). | Family policy *Automatic / Ask / Use only* over an eligibility index (`fabric/index.js`); fallback at a turn boundary, before output, same model and effort or it asks (`sessionintel.js`, `tests/unit/phase83.test.js`). | "Never after output" and "a lock per quota family", as rules. |
| **429: quota vs rate limit** | `classifyQuotaFailure`: only exhaustion language or a stated reset is a quota lock; a bare 429 is a short, retry-hinted cooldown. | `turnoutcome.js` separates `QUOTA_EXHAUSTED` from `PROVIDER_RATE_LIMIT`; a quota pause resumes at the provider's own reset (`quotapause.js`). | The distinction and the reason for it. |
| **Quota fetching** | Claude `/api/oauth/usage`; Codex `/backend-api/wham/usage` (primary/secondary windows, reset credits); Antigravity `fetchAvailableModels` (`remainingFraction` per model family); Z.ai monitor (unit 3 × 5 = 5-hour, unit 6 = weekly). | `fabric/quotaread.js`: Claude's usage read only for **LAIN-owned** profiles; Codex through its app-server's own rate-limit read; Z.ai monitor; Antigravity reported as *not reported*. Never a dummy generation to learn a number. | Endpoint shapes and window units. |
| **resetAt handling** | Windows normalised and ordered; staleness 90 min; health 50 / 20 / 5 % remaining. | `fabric/index.js normWindow` carries both used and remaining with which one the provider reported; expired windows are marked, and the index rebuilds at the earliest reported end. The usage tracker's tones are 20 / 5 % remaining (`usagetracker.js`). Per-window LAIN-observed usage and the *estimated effective capacity* are `resetwindows.js`'s. | Thresholds informed the tones. |
| **Several accounts, one route** | Per-account routes addressed by model prefix. | Provider family → logical model → backing account chosen by the policy; there is no "Account 3 › model" route (`fabric/index.js`). | — |
| **Provider families** | `SUBSCRIPTION_FAMILIES`: one family per real quota/billing system; grouping is display-only and never pools a subscription with an API product (`src/quota-families.ts`). | `fabric/index.js` `brandOf` / `providerFamilies`: a brand (OpenAI, Anthropic, Google…) groups its sources for people; each source keeps its own accounts, models and limits. A subscription's windows never appear on an API key (`tests/unit/providerfamily.test.js`). | The display-only rule, adopted. |
| **API credentials** | Sealed in the router DB. | Verified with the provider before they are kept (`harnessapp/accountops.js addKey`), stored in DPAPI, never read back or echoed; entered only in the Model Dashboard or Core's loopback account page — never in the terminal (`fabric/standalone.js`). | — |
| **Migration / import** | LainRouter `legacy-account-import.ts` previews *available / review / existing / unsupported*. | `fabric/migrate.js` classifies from what each source actually holds: `PORTABLE_AUTH`, `NATIVE_PROFILE_REFERENCE`, `REAUTH_REQUIRED`, `UNSUPPORTED`; imported metadata is never routable until LAIN's own sign-in or a verified portable credential makes it CONNECTED. | Store layouts, provider aliases, the preview-then-apply flow. |

## What LAIN deliberately does not take

- Acting as the OAuth client of another application, or refreshing its tokens.
- Reading another application's credential store outside an explicit import.
- A proxy or router process of its own between the person and their providers.
- Pooling different products' quotas into one number.

## Verification

Unit, fixtures only: `authisolation`, `phase83`, `providerfamily`,
`usagetracker`, `resetcapacity`, `githubaccounts`, `standalone`, `migration`,
`migrationclass`, `migrationverify`, `routerimport` (`node tests/run.js unit <name>`). Real accounts are exercised
only in Gate 4, without spending quota.
