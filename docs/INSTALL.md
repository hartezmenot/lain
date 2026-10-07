# Installing LAIN on Windows

One installer, one product: `LAIN-Setup-<version>.exe` installs **LAIN CLI** and **LAIN Harness** (with LAIN Design)
for the current user — no administrator.

## What goes where

```
%LOCALAPPDATA%\Programs\LAIN\            the PROGRAM (replaced by updates, removed by uninstall)
  lain.exe                               the `lain` command (on your user PATH)
  lainw.exe                              the same launcher without a console (Open With)
  LAIN Harness.exe                       the desktop application
  Uninstall LAIN.exe                     maintenance: modify, repair, uninstall
  components.json · current · previous   what is installed; which version runs; the rollback version
  feed-sequence                          the highest update-manifest sequence accepted (anti-replay)
  versions\<v>\runtime\node.exe          the official Node.js build (verified against nodejs.org at release time)
  versions\<v>\app\…                     Core, CLI, the Harness (harness\), Design (design\), the prebuilt window host
                                         and its pre-rendered page (native\prebuilt\), the job supervisor
%USERPROFILE%\.lain\                     your DATA — settings, accounts, credentials (DPAPI), skills, sessions, logs
```

Nothing of the program is ever written into `.lain`; nothing of your data is ever written into the program folder.

## Start Menu, PATH, startup

- Start Menu: **LAIN** (the Harness), **LAIN CLI**, **Uninstall LAIN**. Optional Desktop shortcut **LAIN**.
- `lain` works in PowerShell, cmd and Windows Terminal (open a new one after installing).
- *Start LAIN at sign-in* is a Harness setting (off by default); when on, the Startup entry runs
  `%LOCALAPPDATA%\Programs\LAIN\LAIN Harness.exe --startup`.

## Setup switches

`--silent` · `--dir <folder>` · `--cli-only` · `--no-design` · `--no-path` · `--no-open-with` · `--no-open-folder` ·
`--no-start-menu` · `--desktop-shortcut` · `--repair` · `--uninstall [--remove-data]` · `--log <file>`.
`Uninstall LAIN.exe` inside an install acts on that install. Reinstalling the same version keeps its files; use
**Repair** to restore them.

## Repair and uninstall

- **Repair** restores every program file of the installed version; settings, accounts and sessions are untouched.
- **Uninstall** removes the program and its Start Menu, PATH, Open With and Startup entries. Your data stays unless
  you tick *Also remove LAIN user data*.
- *Remove data* removes exactly `%USERPROFILE%\.lain` (a test may name a folder inside TEMP) — nothing else, ever.
  Account folders inside it link into other programs' folders (`~\.codex`); those links are removed **as links** and
  never followed (`distribution/safedelete.cs`), so the other program's data is untouched.

## The WebView2 Runtime

The Harness draws with the Evergreen Microsoft Edge WebView2 Runtime that Windows 11 ships. Setup checks it is
registered **and whole** (its data files present). If it is missing or damaged, setup downloads Microsoft's installer
from go.microsoft.com, verifies Microsoft's signature and runs it (Windows asks for administrator approval to repair a
per-machine runtime). The Harness itself names a damaged runtime and offers the same repair.

## Updates

See [UPDATER.md](UPDATER.md): the CLI checks, downloads, verifies and stages updates by itself; the Harness offers
**Update** and **Restart LAIN**. Updates only ever change `%LOCALAPPDATA%\Programs\LAIN`.

## Building a release

From `D:\lain`: `npm run release -- --out <dir> --feed <dir>` — see [RUN-FROM-CHECKOUT.md](RUN-FROM-CHECKOUT.md).
