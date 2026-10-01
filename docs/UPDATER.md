# The Noema updater (internal)

One implementation — `src/update/updater.js` — used by the CLI (`src/update/cli.js`), the Harness
(`src/harnessapp/updateroutes.js`) and `noema update`. It applies only to an **installed** Noema (the launcher sets
`NOEMA_INSTALL_ROOT`); a development checkout reports that it has nothing to switch.

## The feed

`<feed>/manifest-<channel>.json` and its detached Ed25519 signature `manifest-<channel>.json.sig` (base64).
Channels: **stable** (default) and **preview** (`config.json` → `update.channel`). The feed URL comes from the
build (`build-info.json`), `config.json` → `update.feed`, or `NOEMA_UPDATE_FEED`; it may be HTTPS or a folder.

```json
{
  "schema": 1, "product": "noema", "channel": "stable", "version": "0.1.1", "released": "2026-10-01T…Z",
  "minimumCompatible": "0.1.0", "protocol": 1, "minimumCli": "0.1.0", "minimumHarness": "0.1.0",
  "mandatory": false, "security": false, "notes": "https://…", "summary": ["…"],
  "assets": [{ "arch": "x64", "kind": "app", "name": "noema-0.1.1-win-x64.zip", "url": "noema-0.1.1-win-x64.zip",
               "size": 44755682, "sha256": "…64 hex…" }]
}
```

Trust: the manifest is parsed only after its signature verifies against a key in `src/update/trust.js`
(`NOEMA_UPDATE_TEST_KEY` is accepted **only** in an isolated test run). The package is trusted only when its SHA-256
equals the signed manifest's. Anything else is refused and deleted, and the installed version is untouched.

## Check · download · verify · stage

| Step | What happens |
|---|---|
| check | at most every 6 h (cached in `<home>/update/state.json`); the CLI's first check is 30 s after an interactive start; timers are unref'd — no background CPU, never a poll loop |
| download | the asset for this machine → `<install>\staging\<v>.zip.part` |
| verify | SHA-256 against the signed manifest; mismatch → rejected, deleted |
| stage | unpacked with `tar.exe` into `versions\<v>.staging`, checked (`runtime\node.exe`, `app\bin\noema.js`), then renamed to `versions\<v>` — beside the running version |

## Apply and restart (the launcher protocol)

`apply()` sets `previous ← current`, `current ← staged`, `pending ← staged` and writes `restart.json`
(`{ args, cwd }`); the app exits with **75**. The launcher (`distribution/launcher.cs`) starts the new version with
those arguments (`--resume <session> --after-update`, plus `--desktop` for the Harness). The new version writes
`health-<v>` once it has started a session (`markHealthy`); the launcher clears `pending` as soon as that appears.
**Rollback:** a pending version that exits with a failure before reporting healthy (within 60 s) is replaced by
`previous` automatically, recorded in `rolled-back`, and the person is told.

## When it restarts (never silently)

| Situation | CLI | Harness |
|---|---|---|
| idle (no turn, nothing typed for a minute) | "Noema X is ready — restarting now; this session continues." → restarts in the same terminal, same session | the **Update** button appears beside Usage; nothing restarts until chosen |
| a task is running | "Noema X installed and ready. Restart to update — it restarts after the current task" (default); `/update now · after-checkpoint · after-task · later` | the dropdown offers **Restart after current checkpoint** / **Restart after task** / **Later**; "Restart now" is refused while the Agent works |

Safe restart sequence (`src/update/lifecycle.js`): commit the task checkpoint → save the session → release the
writer lease (a pause, not an ending) → stop the turn **at** the checkpoint → apply → exit 75 → the launcher starts
the new version → the session resumes from the committed checkpoint (the position is the durable commit, so a
stale "Step 3/4" cannot recur).

`noema update` (nothing running): check → stage → apply without restarting; the next `noema` starts the new version.

**Staged at shutdown, applied at sign-in.** `stage()` also writes the `staged` pointer. If Windows shuts down with an
update staged, nothing is replaced mid-shutdown; at the next sign-in the Startup entry runs the launcher with
`--startup`, which sets `previous ← current`, `current ← staged`, `pending ← staged` **before anything starts** — one
launch of the new version (never "start old → replace → restart"), with the usual health check and rollback.

## Exit Noema (the same lifecycle)

Closing the window keeps Noema running in the tray. **Exit Noema** (power button in the rail, File menu, tray)
ends it — after a confirmation when idle; while the Agent works: *Close window and keep task running* · *Exit after
current checkpoint* · *Stop task and exit* · *Cancel*.
