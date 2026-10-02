# Installing LAIN on Windows 11 (internal)

**LAIN CLI is the base product.** LAIN Harness is an optional part that can be added or removed at any time
without touching Core or the person's data. Both run the same Core, the same session store and the same accounts.

```text
lain.exe            the CLI (console launcher)
lainw.exe           the same launcher without a console — Open With / the Model Dashboard shortcut, CLI-only installs
LAIN Harness.exe    the desktop environment (only when the Harness is installed)
Uninstall LAIN.exe  the maintenance program (Modify · Repair · Uninstall)
```

---

## Building a release

```text
node distribution/release.js --version 0.1.1 [--channel stable|preview] [--out dist]
                             [--feed <url or folder>] [--harness-dir ../lain-harness] [--summary "a|b"] [--unsigned]
```

Output, in `<out>`:

| File | What it is |
|---|---|
| `LAIN-Setup-<v>.exe` | one file: the setup program with the payload embedded (per-user, no administrator) |
| `lain-<v>-win-x64.zip` | the update package (`runtime/` + `app/`) — what the updater downloads |
| `manifest-<channel>.json` + `.sig` | the update-feed entry, Ed25519-signed with the release key |

Everything is compiled by `csc.exe` from the .NET Framework that is part of Windows — no toolchain to install.
The payload is `package.json`'s `files` list plus the Harness package, `build-info.json` (version, channel, git
revision, feed), the prebuilt window host (`native/prebuilt/lain-harness-*.exe`) and, when
`rust/lain-supervisor` has been built with `cargo build --release`, the job supervisor as
`native/prebuilt/lain-supervisor.exe`.

### Dependencies a release adds

| Name | Version | Source | License | Purpose |
|---|---|---|---|---|
| Node.js (Windows x64 binary) | 24.16.0 | `https://nodejs.org/dist/v24.16.0/` — verified against nodejs.org's `SHASUMS256.txt` before use; cached in `%LOCALAPPDATA%\LAIN\build-cache` | MIT (+ bundled third-party notices; `LICENSE` shipped as `runtime/LICENSE-node.txt`) | the private runtime LAIN runs on — no Node needs to be installed |
| Microsoft Edge WebView2 Runtime | the one Windows 11 ships | part of Windows 11 (evergreen, updated with Edge); setup verifies it is present and **Microsoft-signed** | Microsoft | draws the Harness, the Model Dashboard and the Preview |
| WebView2 SDK | as vendored in `native/vendor/` | already vendored (NuGet `Microsoft.Web.WebView2`) | BSD-style (Microsoft) | the host links against it |
| .NET Framework 4.8 (`csc.exe`, WinForms) | part of Windows 11 | Windows | Microsoft | compiles and runs the launchers, the setup program and the window host |
| `tar.exe` (bsdtar) | part of Windows 10/11 | `%SystemRoot%\System32` | BSD | unpacks the verified update package |

No other runtime dependency is added. Nothing is downloaded from a mirror; the only download at build time is the
official Node.js archive, and the only download at run time is the signed update feed.

### Signing

- **The update feed is signed** (Ed25519). The private key is DPAPI-protected (CurrentUser) at
  `%USERPROFILE%\.noema-release\release-signing.key.dpapi` and is read only by `release.js`; the public key is
  compiled into `src/update/trust.js`. `--unsigned` builds produce no feed at all.
- **The executables are NOT code-signed.** No Authenticode certificate is configured. Windows SmartScreen will
  warn on first run of `LAIN-Setup-*.exe`. `release.js` prints `UNSIGNED BINARIES` on every build. Do not
  describe a development installer as production-signed.

---

## What setup does (per-user)

```text
%LOCALAPPDATA%\Programs\LAIN\          the program — nothing mutable is written here except the pointers
  lain.exe · lainw.exe · LAIN Harness.exe · Uninstall LAIN.exe · lain.ico
  noema.cmd                              the compatibility `noema` command: LAIN_VIA=noema, then lain.exe
  versions\<v>\runtime\node.exe (+ LICENSE-node.txt)
  versions\<v>\app\…                     Core, CLI, Model Dashboard, Preview host, the Harness page
  current · previous · pending           which version runs; the last good one; one not yet proven healthy
  components.json                        what is installed and which integrations this install added
%USERPROFILE%\.lain\                    the person's data: sessions, accounts, settings, usage, logs, caches
                                         (credentials themselves: DPAPI / Windows Credential Manager)
```

Order: WebView2 check (Microsoft signature) → a running LAIN of THIS folder is asked to stop through its own
shutdown sequence → the version is unpacked **side by side** (an upgrade adds `versions\<new>`; the running files
are never overwritten) → pointers → launchers (the payload's `lain.exe` / `lainw.exe` replace any obsolete ones; a
leftover supervisor, Noema launcher or Noema-era `lain.cmd` is removed; `noema.cmd` is written) → integrations →
start at sign-in made to match the setting → the obsolete LAIN's leftovers (registered install only) →
Installed-apps entry (`Uninstall\LAIN.Install`) → **verified**: the installed `lain.exe --version` must answer with
"LAIN" and the version, or setup fails → a Noema-era install (`Programs\Noema`) is retired (see docs/MIGRATION.md).

### Start at sign-in

Settings → General → **Startup** (and `lain settings startup status | harness on|off | minimized on|off | restore
on|off`) — one canonical setting, `config.json` → `startup`: *Start LAIN Harness when I sign in to Windows*
(default **off** — never opted in silently), *Start minimized* (off), *Restore previous workspace* (on). Windows is made
to match it with one per-user shortcut, `Startup\LAIN Harness.lnk` → `<install>\LAIN Harness.exe --startup` — the
version-independent launcher, so updates and rollbacks never rewrite it. Setup runs `lain settings startup sync
--owned` after install, repair, upgrade and add/remove-Harness (no Harness → no entry; the choice is kept) and
`remove --owned` at uninstall; `--owned` means setup only ever removes an entry that points into its own folder.
At `--startup` the launcher first applies an update staged at the previous shutdown, then starts the Harness; a LAIN
already running (a CLI's Core) is shown, never duplicated. Exit LAIN does not change the setting.

### The obsolete LAIN's leftovers

A registered install runs `lain legacy cleanup --exe <launcher>` (also available by hand: `lain legacy status |
cleanup`): the obsolete pre-cleanup LAIN's Startup shortcut becomes the Startup setting above (once), its "Open with"
entries (`LAIN.File`) are replaced by the current ones (`LAIN.Harness.File`), old `LAIN.exe` / `lain-desktop-*.exe`
builds (and stale Noema-era `noema-harness-*.exe`) in the data folder, the file `Start Menu\LAIN.lnk` and the old
`Uninstall\LAIN` entry are removed — every one a name the current LAIN never uses. A machine-wide `C:\Program Files\LAIN` (administrator install) is reported,
never touched.

### Options

Wizard: **LAIN CLI** (always) · **LAIN Harness** (optional) · Add `lain` to PATH · Offer LAIN in "Open with" ·
"Open folder in LAIN" · Start Menu entries. Start Menu (folder "LAIN"): LAIN CLI · LAIN Model Dashboard ·
LAIN Harness (when installed) · Uninstall LAIN.

Silent:

```text
LAIN-Setup.exe --silent [--dir <folder>] [--harness | --cli-only]
                [--no-path] [--no-open-with] [--no-open-folder] [--no-start-menu] [--no-register] [--log <file>]
LAIN-Setup.exe --silent --repair [--dir <folder>]
"Uninstall LAIN.exe" --add-harness | --remove-harness [--dir <folder>]
"Uninstall LAIN.exe" --uninstall [--silent] [--remove-data] [--dir <folder>]
```

A reinstall, repair or upgrade of a folder keeps the choices recorded in its `components.json` unless a flag says
otherwise.

### What it never does

- change a default application (no `(Default)` of any extension, no `UserChoice`) — LAIN is only *offered* in
  "Open with" (`src/winassoc.js`, run by the installed runtime; it also removes the obsolete `LAIN.File` and the
  Noema-era `Noema.File` entries when LAIN registers)
- touch the machine PATH, HKLM, or another account
- remove anything it did not add: uninstall and reinstall undo only what `components.json` records
- stop a LAIN that is not running from its own folder (a Noema install being upgraded is asked to stop the same way)
- put a secret in the registry, a command line, a URL or its log

### Uninstall

"Uninstall LAIN" removes the program, the integrations it added and the Installed-apps entry, and **keeps the
data**. A separate, unchecked option — **"Also remove LAIN user data"** — deletes `%USERPROFILE%\.lain` (after a
warning that lists what goes: sessions, accounts, settings, usage history), and the compatibility links
`~\.noema` and `~\.lain-v2` when they are links.

---

## Verification

`tests/distribution` covers the pieces in-process. The installer itself is verified by the acceptance scripts
described in `docs/TESTING-LAIN.md` — they run the **built** `LAIN-Setup-*.exe`, never the repository.
