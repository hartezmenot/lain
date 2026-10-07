# Running LAIN from the checkout (development)

One folder: `D:\lain`. It holds everything — Core, the CLI, the Harness (`harness/`), Design
(`packages/design-core/`), the installer and updater (`distribution/`), tests and docs. Node.js 20+ on PATH.

| | Where |
|---|---|
| Development | `D:\lain` (this repository) |
| Installed product | `%LOCALAPPDATA%\Programs\LAIN` (see [INSTALL.md](INSTALL.md)) |
| Your data | `%USERPROFILE%\.lain` — the one home, for the installed product and the checkout alike |

## First time

```
npm run vendor          # the WebView2 SDK (pinned + SHA-256) and the editor/terminal code the Harness page serves
npm run build:design    # LAIN Design's parsers (npm ci --omit=dev in packages/design-core)
npm run build:harness   # compiles the window host into native/build (csc.exe, part of Windows)
```

## Run

| | |
|---|---|
| `npm start` (`node bin/lain.js`) | the CLI from the checkout |
| `npm run desktop` (`node bin/lain.js --desktop`) | the Harness from the checkout (`--dev` adds devtools) |
| `tools\dev\lain-desktop.cmd` | the same, as a developer launcher — never put in the Start Menu |

A running installed LAIN and a checkout share `~\.lain`; exit one before starting the other (the launcher says so).
The checkout builds its window host, terminal bridge and Computer Control helpers into `native\build` — never into
`~\.lain`.

## Test and build — all from `D:\lain`

| | |
|---|---|
| `npm run test:unit` · `test:integration` · `test:core` | Core |
| `npm run test:cli` · `test:tty` | the CLI (spawned); the real-terminal cases (`LAIN_TTY_PYTHON` → a venv with pywinpty + pyte) |
| `npm run test:harness` | the Harness in a real window |
| `npm run test:design` | Design unit + canvas (fixtures: `node tools/dev/design-fixtures.js`) |
| `npm run test:distribution` | the installer, in temporary folders only (it refuses to run otherwise) |
| `npm run build:supervisor` | the Rust job supervisor (cargo) |
| `npm run build:installer` | an unsigned `LAIN-Setup-<v>.exe` into `dist\` |
| `npm run release -- --out <dir> --feed <dir>` | installer + update package + signed feed (release key: DPAPI-sealed in `%USERPROFILE%\.lain-release`) |

On this machine the local release feed is `%LOCALAPPDATA%\LAIN\releases`: build a release there and the installed
LAIN finds the update by itself.
