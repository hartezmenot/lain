# Installing Noema on Windows 11 (internal)

**Noema CLI is the base product.** Noema Harness is an optional part that can be added or removed at any time
without touching Core or the person's data. Both run the same Core, the same session store and the same accounts.

```text
noema.exe            the CLI (console launcher)
noemaw.exe           the same launcher without a console — Open With / the Model Dashboard shortcut, CLI-only installs
Noema Harness.exe    the desktop environment (only when the Harness is installed)
Uninstall Noema.exe  the maintenance program (Modify · Repair · Uninstall)
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
| `Noema-Setup-<v>.exe` | one file: the setup program with the payload embedded (per-user, no administrator) |
| `noema-<v>-win-x64.zip` | the update package (`runtime/` + `app/`) — what the updater downloads |
| `manifest-<channel>.json` + `.sig` | the update-feed entry, Ed25519-signed with the release key |

Everything is compiled by `csc.exe` from the .NET Framework that is part of Windows — no toolchain to install.
The payload is `package.json`'s `files` list plus the Harness package, `build-info.json` (version, channel, git
revision, feed), the prebuilt window host (`native/prebuilt/noema-harness-*.exe`) and, when
`rust/lain-supervisor` has been built with `cargo build --release`, the job supervisor as
`native/prebuilt/noema-supervisor.exe`.

### Dependencies a release adds

| Name | Version | Source | License | Purpose |
|---|---|---|---|---|
| Node.js (Windows x64 binary) | 24.16.0 | `https://nodejs.org/dist/v24.16.0/` — verified against nodejs.org's `SHASUMS256.txt` before use; cached in `%LOCALAPPDATA%\Noema\build-cache` | MIT (+ bundled third-party notices; `LICENSE` shipped as `runtime/LICENSE-node.txt`) | the private runtime Noema runs on — no Node needs to be installed |
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
  warn on first run of `Noema-Setup-*.exe`. `release.js` prints `UNSIGNED BINARIES` on every build. Do not
  describe a development installer as production-signed.

---

## What setup does (per-user)

```text
%LOCALAPPDATA%\Programs\Noema\          the program — nothing mutable is written here except the pointers
  noema.exe · noemaw.exe · Noema Harness.exe · Uninstall Noema.exe · noema.ico
  lain.cmd                               the deprecated `lain` command: a shim onto noema.exe (no LAIN executable ships)
  versions\<v>\runtime\node.exe (+ LICENSE-node.txt)
  versions\<v>\app\…                     Core, CLI, Model Dashboard, Preview host, the Harness page
  current · previous · pending           which version runs; the last good one; one not yet proven healthy
  components.json                        what is installed and which integrations this install added
%USERPROFILE%\.noema\                    the person's data: sessions, accounts, settings, usage, logs, caches
                                         (credentials themselves: DPAPI / Windows Credential Manager)
```

Order: WebView2 check (Microsoft signature) → a running Noema of THIS folder is asked to stop through its own
shutdown sequence → the version is unpacked **side by side** (an upgrade adds `versions\<new>`; the running files
are never overwritten) → pointers → launchers (an obsolete `lain.exe` / `lainw.exe` / `lain-supervisor.exe` in the
folder is removed; `lain.cmd` is written) → integrations → start at sign-in made to match the setting → LAIN's
leftovers (registered install only) → Installed-apps entry → **verified**: the installed `noema.exe --version` must
answer with "Noema" and the version, or setup fails.

### Start at sign-in

Settings → General → **Startup** (and `noema settings startup status | harness on|off | minimized on|off | restore
on|off`) — one canonical setting, `config.json` → `startup`: *Start Noema Harness when I sign in to Windows*
(default **off** — never opted in silently), *Start minimized* (off), *Restore previous workspace* (on). Windows is made
to match it with one per-user shortcut, `Startup\Noema Harness.lnk` → `<install>\Noema Harness.exe --startup` — the
version-independent launcher, so updates and rollbacks never rewrite it. Setup runs `noema settings startup sync
--owned` after install, repair, upgrade and add/remove-Harness (no Harness → no entry; the choice is kept) and
`remove --owned` at uninstall; `--owned` means setup only ever removes an entry that points into its own folder.
At `--startup` the launcher first applies an update staged at the previous shutdown, then starts the Harness; a Noema
already running (a CLI's Core) is shown, never duplicated. Exit Noema does not change the setting.

### LAIN's leftovers

A registered install runs `noema legacy cleanup --exe <launcher>` (also available by hand: `noema legacy status |
cleanup`): LAIN's Startup shortcut becomes the Startup setting above (once), LAIN's "Open with" entries become
Noema's, old `LAIN.exe` / `lain-desktop-*.exe` builds in the data folder, `Start Menu\LAIN.lnk` and an old
`Uninstall\LAIN` entry are removed. A machine-wide `C:\Program Files\LAIN` (administrator install) is reported,
never touched.

### Options

Wizard: **Noema CLI** (always) · **Noema Harness** (optional) · Add `noema` to PATH · Offer Noema in "Open with" ·
"Open folder in Noema" · Start Menu entries. Start Menu (folder "Noema"): Noema CLI · Noema Model Dashboard ·
Noema Harness (when installed) · Uninstall Noema.

Silent:

```text
Noema-Setup.exe --silent [--dir <folder>] [--harness | --cli-only]
                [--no-path] [--no-open-with] [--no-open-folder] [--no-start-menu] [--no-register] [--log <file>]
Noema-Setup.exe --silent --repair [--dir <folder>]
"Uninstall Noema.exe" --add-harness | --remove-harness [--dir <folder>]
"Uninstall Noema.exe" --uninstall [--silent] [--remove-data] [--dir <folder>]
```

A reinstall, repair or upgrade of a folder keeps the choices recorded in its `components.json` unless a flag says
otherwise.

### What it never does

- change a default application (no `(Default)` of any extension, no `UserChoice`) — Noema is only *offered* in
  "Open with" (`src/winassoc.js`, run by the installed runtime; it also removes LAIN's old `LAIN.File` entries when
  Noema registers)
- touch the machine PATH, HKLM, or another account
- remove anything it did not add: uninstall and reinstall undo only what `components.json` records
- stop a Noema or LAIN that is not running from its own folder
- put a secret in the registry, a command line, a URL or its log

### Uninstall

"Uninstall Noema" removes the program, the integrations it added and the Installed-apps entry, and **keeps the
data**. A separate, unchecked option — **"Also remove Noema user data"** — deletes `%USERPROFILE%\.noema` (after a
warning that lists what goes: sessions, accounts, settings, usage history), and LAIN's compatibility link
`~\.lain-v2` when it is a link to that folder.

---

## Verification

`tests/distribution` covers the pieces in-process. The installer itself is verified by the acceptance scripts
described in `docs/TESTING-NOEMA.md` — they run the **built** `Noema-Setup-*.exe`, never the repository.
