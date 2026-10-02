# Testing LAIN (internal)

`node tests/run.js <tier> [fileRegex]` — tiers run in one process each, in an isolated home (`LAIN_ISOLATED`), with
the mock provider unless a test says otherwise. Nothing a tier does may reach the person's real home, PATH, Start
Menu, "Open with" registrations or accounts.

| Tier | What it proves |
|---|---|
| `unit` | modules in-process — including `discipline` (asks, CheckState baselines/discrimination, test-integrity fixtures, claim downgrade, arbiter states, proportional verification, OUTCOME SATISFIED, no blind retries, dialects, profiles, digest, LAIN.md — see EXECUTION-DISCIPLINE.md), `startup` (off by default, per-user shortcut to the version-independent launcher, no dead entry, LAIN's choice carried over once, Settings and CLI share one setting, legacy cleanup), `dash`/`standalone` (no credential in terminal output or a URL), `noemaupdate` (signed feed, SHA-256 rejection, stage/apply, health), `noemarename` (home move by rename + junction, deferred when in use, `lain` shim, `.lain`/`.lain` authority, LAIN's old pipe name found), `noemalifecycle` (restart after checkpoint/task, Later, no silent restart) |
| `integration` | modules against real OS pieces — `previewinput-real` drives the Preview bridge in a real headless Chromium: click, type, keys, drag, scroll, `preview_read`, refusals (file picker, credentials, other sites, new windows), yielding to the person |
| `workflow` · `cli` · `global` · `harness` | the smoke tiers: the real `bin/lain.js` as a child process, the TUI over pipes, the Harness page in a real browser/WebView2 |
| `distribution` | `install.test.js` (the checkout setup: `lain` shims, PATH handling) · `installer.test.js` — builds real **unsigned** 0.1.0 and 0.1.1 releases and runs the installer matrix in temporary folders: clean CLI-only · the installed copy depends on nothing in the checkout · add Harness later · repair · clean CLI + Harness · upgrade side by side (an obsolete `lain.exe` removed) · no LAIN executable ships and `lain.cmd` is a shim with the notice once · start at sign-in (temporary APPDATA) survives repair and upgrade, goes with the Harness and comes back with it, and uninstall leaves no entry · uninstall program only · uninstall + data · nothing outside the sandbox changed |

## Acceptance scripts (`tests/acceptance/`, run by hand)

They exercise BUILT artifacts and, for the last two, the person's REAL accounts — so they are never part of a tier.

| Script | Needs | What it does |
|---|---|---|
| `update.js <LAIN-Setup-0.1.0.exe> <feed folder with 0.1.1>` | a signed 0.1.0 setup and a signed 0.1.1 feed (`release.js --feed <folder>`) | installs into temp folders and proves: **idle** auto-update (check → download → verify → stage → restart into 0.1.1, same session, pending cleared once healthy) · **active task** (announced, never interrupted, restarted after the task) · **tampered package** rejected (SHA-256) · **tampered manifest** rejected (signature) · one-shot `lain update` · a broken version **rolled back** automatically · **start at sign-in + staged update** (A: the setting registers the version-independent launcher; B: an update staged at shutdown waits; C: the `--startup` launch applies it before anything runs; D: the entry survives unchanged) |
| `windows.js <LAIN-Setup.exe>` | a setup | one REAL per-user install at the default location with every integration, checked: Installed apps entry (name, version, publisher, icon, uninstall/modify), Start Menu entries and icons, user PATH + `where lain`, Open With / Open folder (offered, no default or UserChoice changed, LAIN's old entries replaced), version resources, icons, **UNSIGNED** status; then a real uninstall. LAIN's own "Open with" keys are exported first and imported back; the script fails if anything differs from before |
| `surfaces.js <screenshot folder>` | a checkout with the Harness package beside it | the real WebView2 windows in an isolated home: `lain model` (dashboard mode — Model room only, opened on its section, no secrets), `lain preview` (Preview alone; a model action Core → window → page → back), and the Harness Update button, dropdown and Exit confirmation; screenshots |
| `realmodel.js text\|preview` | the person's configured Z.ai connection (`lain:zai`, key by DPAPI reference) | one real GLM-5.3-Flash request through `App.once`, model/connection chosen **in memory only** (config is never saved); `preview` has the model drive the Preview with `preview_read` / `preview_click`; prints provider, account, route, model, effort and tokens from the usage receipts |
| `realoauth.js <accountA> <accountB>` | two signed-in Codex accounts — **no sign-in is started** | A: identity (masked), quota, model list, one "Reply OK" request, quota after; B: every file fingerprinted before and after, identity compared |

Real-account scripts print no token, key or cookie; identities are masked. Use them sparingly — each costs real
quota.

## Evidence labels

REAL VERIFIED — the real artifact, OS or account did it and the result was checked. FAKE VERIFIED — the same code
path with a fake at one end (mock provider, scratch registry hive, test signing key). NOT VERIFIED — not run, or run
without a check that could fail.

## Proportional verification (2026-10-01)

A test is worth running when its failure could change whether *this* change is complete. `node tests/capabilities.js`
reads the working trees (LAIN and the Harness) and prints the level and the commands:

| Level | When | What runs |
|---|---|---|
| TARGETED | a local change | the unit files named after the touched modules |
| IMPACT | a change another surface reads | unit + integration + the touched capability smokes |
| SUBSYSTEM | three or more capabilities touched | the same, every file of those capabilities |
| PROJECT | Core's turn path (`app`, `turn`, `provider`, `tools/`, `discipline/`, the runner) | every tier |
| RELEASE | packaging | every tier + distribution, **never from cache** |

Named capabilities are selections over the existing tiers (no file moved): `node tests/run.js smoke-core | smoke-cli |
smoke-harness | smoke-preview | smoke-provider | smoke-global | smoke-installer | smoke-updater | smoke-release`.
Scopes are conservative: each capability lists what cannot affect it; everything else does.

**`--cache`** reuses a file's last PASS only while its fingerprint is identical — the test file, the content hash of every
source file in its capability's scope, the Node version and the platform (`.lain-test-cache.json`, gitignored). Any
relevant edit re-runs it; a failure removes the entry; `smoke-release` ignores the cache.

## What "real" means — the classification

Every test and acceptance script is labelled by what is genuinely real in it. None of these is called "real" unless
its row says so.

| Class | Real | Mocked | Proves | Does NOT prove | Examples |
|---|---|---|---|---|---|
| FIXTURE | the module | everything around it | the module's contract | wiring, timing, OS | `tests/unit/*` |
| HEADLESS INTEGRATION | modules wired together, real FS | the network (mock provider / fake servers) | modules agree | a process, a screen | `tests/integration/*`, `antigravityhttps` (fake Google) |
| REAL PROCESS + FAKE MODEL | the `lain` binary, real shells, real FS, real supervisor | the model (mock script or `bench/latency/fakemodel.js`) | the product loop, latency LAIN adds | model behaviour | `tests/smoke/*`, `bench/latency/run.js` |
| REAL TTY | ConPTY + VT screen (pywinpty + pyte) | the model | what a person *sees* in a terminal | the model | `tests/tty/realtty.js`, `bench/cliux/run.js` |
| REAL WINDOW | WebView2 window, real input | the model | what a person sees and clicks | the model, installers | `*-real.test.js` in the harness tier |
| REAL MODEL | a provider's model through LAIN | nothing on the model path; account chosen in memory | LAIN + a real model complete a task | other accounts, quota policy | `tests/acceptance/realmodel.js`, `bench/latency/real.js` |
| REAL PROVIDER ACCOUNT | a signed-in account's own reads | nothing | identity, quota, model list | execution quality | `tests/acceptance/realoauth.js`, the Z.ai monitor read |
| REAL INSTALLER | built setup, real per-user install | test signing key | install / upgrade / uninstall on Windows | code signing | `tests/acceptance/windows.js`, `update.js` |

How the earlier successful real tests were run, and the rules kept: real accounts are chosen **in memory only**
(`config.save` disabled), nothing secret is printed, identities are masked, spend is counted from the usage receipts the
run itself wrote, and a script that touches the person's registrations exports them first and restores them after.

Reusable real-test scenarios: `PreviewGeometryReal` (`previewaccept-real`), `OAuthIsolationReal` (`realoauth.js`),
`CrashResumeReal` (`autocontinue` integration + `inflight`), `UpdaterRollbackReal` (`acceptance/update.js`),
`InstallerReal` (`acceptance/windows.js`), `CLIContinuationReal` (`bench/cliux/run.js` for what is seen;
`autocontinue` integration for the goal loop).
