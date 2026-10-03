# Noema → LAIN migration (internal)

The product is **LAIN** again (2026-10-02); the command is `lain`. `noema` keeps working as an alias for the same
program, home and Core. It says this once per home:

```text
Noema has been renamed back to LAIN.
Use `lain` for future commands (`noema` keeps working for now).
```

Two older things share names with the current LAIN. They are told apart by **name or layout**, never by guesswork:

| | Obsolete pre-cleanup LAIN | Noema era (2026-09-29 … 10-02) | Current LAIN |
|---|---|---|---|
| Home | `~/.lain-v2` (later junction) / historical `~/.lain` | `~/.noema` | `~/.lain` |
| Executables | `LAIN.exe`, `lain-desktop-*.exe` | `noema.exe`, `noemaw.exe`, `Noema Harness.exe` | `lain.exe`, `lainw.exe`, `LAIN Harness.exe` |
| Install folder | `C:\Program Files\LAIN` (machine-wide) | `%LOCALAPPDATA%\Programs\Noema` | `%LOCALAPPDATA%\Programs\LAIN` (with `versions\`, `components.json`) |
| Installed-apps key | `…\Uninstall\LAIN` | `…\Uninstall\Noema` | `…\Uninstall\LAIN.Install` |
| Open With | `LAIN.File` / `LAIN.Open` | `Noema.File` / `Noema.Open` | `LAIN.Harness.File` / `LAIN.Harness.Open` |
| Start Menu | file `Programs\LAIN.lnk` | folder `Programs\Noema` | folder `Programs\LAIN` |
| Startup | `Startup\LAIN.lnk` | `Startup\Noema Harness.lnk` | `Startup\LAIN Harness.lnk` |
| Core pipe | — | `noema-core-<hash of ~/.noema>` | `lain-core-<hash of ~/.lain>` |
| Supervisor | — | `noema-supervisor.exe` | `lain-supervisor.exe` |

Nothing of the obsolete LAIN is restored: its executables are replaced or removed, and its entries are retired by
`lain legacy cleanup` (`src/legacycleanup.js`).

## The home (`src/home.js`, run first by `src/boot.js`)

- `~/.noema` → `~/.lain` by **one rename, never a copy**. Junctions are left at `~/.noema` and `~/.lain-v2`, so a
  Noema-era build, a script or a shortcut still finds the data.
- A record is written to `~/.lain/migrations/home-from-noema.json` (from, to, when, which version, junction).
- **In use → deferred.** If any process holds a file in the old home (a running Core or its supervisor), the rename
  fails and nothing moves. LAIN keeps using `~/.noema` and tries again on the next start.
- **A historical `~/.lain`** is a real folder with no migration record, sitting beside a real Noema home that has
  data. It is the obsolete LAIN's, so it is **set aside** to `~/.lain-archived-<time>` (renamed, never deleted, never
  adopted), and the Noema home moves in.
- Overrides: `LAIN_CONFIG_DIR` > `LAIN_HOME` > `NOEMA_CONFIG_DIR` > `NOEMA_HOME`. With any override set, nothing is
  migrated.
- Environment: `LAIN_*` is canonical. Every `NOEMA_X` is mirrored to `LAIN_X` when `LAIN_X` is unset.
- Credentials stay in DPAPI / Windows Credential Manager and are not touched by the move.

## A running Noema

A new LAIN asks `lain-core-<key>` first and then the Noema-era `noema-core-<hash of ~/.noema>`, so it never starts
a second Core beside a Noema that is still running on the same home (`src/corelock.js`).

## Projects (`src/projectmeta.js`)

- A project LAIN opens for the first time gets **`.lain/`**, with a `.gitignore` of `*`.
- A project that already has **`.noema/`** keeps using it as it is: one authority per project, never both written.
- `lain project migrate` moves `.noema/` → `.lain/` with one rename, renames `NOEMA.md` → `LAIN.md`, and adds `.lain/`
  to a project `.gitignore` that ignored `.noema/`. If both folders exist it reports that and merges nothing.
- Constitution: `.lain/LAIN.md` is canonical. A Noema-era `NOEMA.md` (or an older `AGENTS.md`) is read only while no
  `LAIN.md` exists.

## Installer and updater

- **Fresh install:** `%LOCALAPPDATA%\Programs\LAIN`, with `lain.exe`, `lainw.exe`, `LAIN Harness.exe`,
  `Uninstall LAIN.exe` and `noema.cmd`. The `noema.cmd` shim sets `LAIN_VIA=noema` and runs `lain.exe`.
- **Upgrade from Noema:** the choices recorded for the Noema install are carried over. Once LAIN is installed and its
  CLI has answered with the expected version, the Noema install is retired: its program folder, `Start Menu > Noema`,
  its PATH entry and its Installed-apps key (`Retire.Noema` in `distribution/setupsystem.cs`). Open With and Startup
  were already replaced by LAIN's own registration. Data is never touched by setup.
- **Over an obsolete LAIN folder** (`lain.exe` without `versions\` or `components.json`): its executables are
  overwritten by the payload, and its supervisor is removed.
- **In-place update of a Noema-era install** (through the Noema-era updater): every package still carries
  `app/bin/noema.js`, so the Noema launcher starts it. The updater accepts manifests for product `lain` or `noema`.
  The install keeps its Noema folder and launchers until the LAIN setup is run.
- The launcher runs `bin/lain.js`, or `bin/noema.js` for a Noema-era version kept for rollback.
- Release key: read from `~/.lain-release` or, where it was made, `~/.noema-release`. The key file, its DPAPI entropy
  and the key label are unchanged.

## What intentionally still says Noema

- The `noema` alias and its notice.
- Compatibility reads of `~/.noema`, `.noema/`, `NOEMA.md`, `NOEMA_*` and `noema-core-*`.
- The legacy registry, link and executable names that cleanup removes.
- The release key's sealed identifiers.
- History in comments.
