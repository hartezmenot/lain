# The LAIN updater (internal)

One implementation — `src/update/updater.js` — used by the CLI (`src/update/cli.js`), the Harness
(`src/harnessapp/updateroutes.js`) and `lain update`. It applies only to an **installed** LAIN (the launcher sets
`LAIN_INSTALL_ROOT`); a development checkout reports that it has nothing to switch.

## The feed

`<feed>/manifest-<channel>.json` and its detached Ed25519 signature `manifest-<channel>.json.sig` (base64).
Channels: **stable** (default) and **preview** (`config.json` → `update.channel`). The feed URL comes from the
build (`build-info.json`), `config.json` → `update.feed`, or `LAIN_UPDATE_FEED`; it may be HTTPS or a folder.

```json
{
  "schema": 1, "product": "lain", "channel": "stable", "version": "0.1.1", "released": "2026-10-01T…Z",
  "minimumCompatible": "0.1.0", "protocol": 1, "minimumCli": "0.1.0", "minimumHarness": "0.1.0",
  "mandatory": false, "security": false, "notes": "https://…", "summary": ["…"],
  "assets": [{ "arch": "x64", "kind": "app", "name": "lain-0.1.1-win-x64.zip", "url": "lain-0.1.1-win-x64.zip",
               "size": 44755682, "sha256": "…64 hex…" }]
}
```

Trust: the manifest is parsed only after its signature verifies against a key in `src/update/trust.js`
(`LAIN_UPDATE_TEST_KEY` is accepted **only** in an isolated test run). The package is trusted only when its SHA-256
equals the signed manifest's. Anything else is refused and deleted, and the installed version is untouched.

## Check · download · verify · stage

| Step | What happens |
|---|---|
| check | at most every 6 h (cached in `<home>/update/state.json`); the CLI's first check is 30 s after an interactive start; timers are unref'd — no background CPU, never a poll loop |
| download | the asset for this machine → `<install>\staging\<v>.zip.part` |
| verify | SHA-256 against the signed manifest; mismatch → rejected, deleted |
| stage | unpacked with `tar.exe` into `versions\<v>.staging`, checked (`runtime\node.exe`, `app\bin\lain.js`), then renamed to `versions\<v>` — beside the running version |

## Apply and restart (the launcher protocol)

`apply()` sets `previous ← current`, `current ← staged`, `pending ← staged` and writes `restart.json`
(`{ args, cwd }`); the app exits with **75**. The launcher (`distribution/launcher.cs`) starts the new version with
those arguments (`--resume <session> --after-update`, plus `--desktop` for the Harness). The new version writes
`health-<v>` once it has started a session (`markHealthy`); the launcher clears `pending` as soon as that appears.
**Rollback:** a pending version that exits with a failure before reporting healthy (within 60 s) is replaced by
`previous` automatically, recorded in `rolled-back`, and the person is told.

## One state, two policies (2026-10-07)

The phase every surface reads (`updater.js` PHASES, written to `<home>/update/state.json` while it happens):
CURRENT · CHECKING · AVAILABLE · DOWNLOADING · VERIFYING · STAGED · RESTART_REQUIRED (a staged version, seen by a
running LAIN) · FAILED. One view in Core (`src/update/ux.js`) — the CLI header and the Harness read the same.

**Anti-replay.** Every signed manifest carries `sequence` (grows with every release), `issued_at` and `expires_at`.
A manifest with a lower sequence than the highest accepted is a replay and refused — the highest is remembered in the
state *and* beside the install (`feed-sequence`), so a data reset cannot reopen it. Expired or future-dated manifests
are refused. A staged package must name the manifest's version in its own `build-info.json`.

**The CLI is automatic.** It checks, downloads, verifies and stages by itself (`update.auto`, on by default).
- Completely idle (no model request, task, background job or agent, no open question, decision or permission, no
  unsent draft, no keystroke for a minute): it restarts into the new version at once and the session resumes.
- Busy: never interrupted. One notice — `✓ LAIN x.y.z installed · restart when the current task finishes` — and, at
  the next idle boundary, one more: `✓ Update installed · Restart to activate — /update now · /update later`. Left
  idle after that, it restarts by itself. `/update later` keeps it staged and stops the automatic restart.
- With `update.auto` off: said once, nothing restarts by itself.

**The Harness asks.** It checks by itself; when a release is available: *LAIN x.y.z is available* [**Update**]
[**Later**]. Update downloads, verifies and stages; then *✓ Update installed · Restart to activate*
[**Restart LAIN**] [**Later**] — or, while the Coding Agent works, [**Restart after task**] [**Later**].

**The active task is never killed.** "Working" (`lifecycle.busy`) is a turn, the Coding Agent's run, an in-process
background job, or a background agent — each ends with the process, so "now" is refused for all of them (a supervised
job outlives LAIN and does not count).

Safe restart sequence (`src/update/lifecycle.js`): commit the task checkpoint → save the session → release the
writer lease (a pause, not an ending) → stop the turn **at** the checkpoint → apply → exit 75 → the launcher starts
the new version → the session resumes from the committed checkpoint (the position is the durable commit, so a
stale "Step 3/4" cannot recur).

`lain update` (nothing running): check → stage → apply without restarting; the next `lain` starts the new version.

**Staged at shutdown, applied at sign-in.** `stage()` also writes the `staged` pointer. If Windows shuts down with an
update staged, nothing is replaced mid-shutdown; at the next sign-in the Startup entry runs the launcher with
`--startup`, which sets `previous ← current`, `current ← staged`, `pending ← staged` **before anything starts** — one
launch of the new version (never "start old → replace → restart"), with the usual health check and rollback.

## Exit LAIN (the same lifecycle)

Closing the window keeps LAIN running in the tray. **Exit LAIN** (power button in the rail, File menu, tray)
ends it — after a confirmation when idle; while the Agent works: *Close window and keep task running* · *Exit after
current checkpoint* · *Stop task and exit* · *Cancel*.
