# LAIN → Noema migration (internal)

The product is **Noema**; the command is `noema`. `lain` keeps working as a shim to the same program, the same home
and the same Core, and says once per home:

```text
LAIN has been renamed to Noema.
The `lain` command is deprecated; use `noema`.
```

## The home (`src/home.js`, run first by `src/boot.js`)

| Before | After |
|---|---|
| `%USERPROFILE%\.lain-v2` | `%USERPROFILE%\.noema` |

- **One rename, never a copy** — a multi-GB home moves in milliseconds and nothing is duplicated.
- A **junction** is left at `.lain-v2` → `.noema`, so an older LAIN, a script or a shortcut still finds the data.
- A record is written to `.noema\migrations\home-from-lain.json` (from, to, when, by which version, junction).
- **In use → deferred.** If any process holds a file in the old home (a running LAIN or its supervisor), the rename
  fails and nothing moves: Noema keeps using `.lain-v2` as its home and tries again on the next start.
- Overrides: `NOEMA_CONFIG_DIR` > `NOEMA_HOME` > `LAIN_CONFIG_DIR`. With any override set, nothing is migrated.
- Environment: every `NOEMA_X` is mirrored to `LAIN_X` for modules that still read the old name (an explicit
  `LAIN_X` is never overwritten).

The old home's pieces keep their layout inside the new home (sessions, accounts, workspaces, usage receipts,
settings, extensions, skills, supervisor state); credentials stay in DPAPI / Windows Credential Manager and are
not touched by the move.

## A running LAIN

A new Noema looks for a running Core under `noema-core-<key>` and then under LAIN's `lain-core-<key>` (the key is
the home path), so it never starts a second Core beside a LAIN that is still running on the same home
(`src/corelock.js`). The setup program asks a Noema in its own install folder to shut down through its own
sequence; it never stops a LAIN or Noema that runs from anywhere else.

## Projects (`src/projectmeta.js`)

- A project Noema opens for the first time gets **`.noema/`** (with a `.gitignore` of `*`, so it stays out of the
  person's commits).
- A project that already has **`.lain/`** keeps using it, as it is — one authority per project, never both written.
- `noema project migrate` moves `.lain/` → `.noema/` (one rename), writes `migrated-from-lain.json`, and adds
  `.noema/` to a project `.gitignore` that ignored `.lain/`. Deliberate, because a project may track `.lain/` in its
  own history. If both folders exist it reports that and merges nothing.
- `.lain/preview.json`, `.lain/AGENTS.md`, `.lain/extensions`, `.lain/project.json` are read from whichever folder
  is the project's authority. Global instructions: `~/.noema/AGENTS.md`, or LAIN's `~/.lain/AGENTS.md` when only that
  one exists.

## Windows integration

- "Open with": `Noema.File` / `Noema.Open` / `Applications\<launcher>`; LAIN's `LAIN.File`, `LAIN.Open` and
  `Applications\LAIN.exe` are removed when Noema registers or unregisters, so Explorer never shows two entries.
- Start Menu: a "Noema" folder; LAIN's old single `LAIN.lnk` is removed by an install that adds Start Menu entries.
- Start at sign-in: LAIN's `Startup\LAIN.lnk` (→ LAIN.exe) is carried over ONCE to Noema's `startup.harness` setting
  and replaced by `Startup\Noema Harness.lnk` (`src/startup.js`); an explicit "off" is never overridden.
- Executables: no `LAIN.exe` is built or shipped. The development launcher is `<home>\desktop\Noema Harness.exe`;
  `noema legacy cleanup` (`src/legacycleanup.js`, also run by a registered install) removes LAIN's old `LAIN.exe`
  and `lain-desktop-*.exe`, and setup removes a `lain.exe` from its own folder on upgrade.
- The `lain` command: `bin/lain.js` (npm) and `lain.cmd` (installed) are shims onto the same Noema — same home,
  same Core, same pipe namespace, no shadow config — and print the rename notice once per home.
- Process and pipe names: `noema-harness-*.exe` (window host), `noema-pty-*.exe`, `noema-core-*`/`noema-harness-*`
  pipes, `noema-supervisor.exe` (the Rust crate's directory keeps its internal name `rust/lain-supervisor`; the
  binary it builds is `noema-supervisor`). The cache cleaner still recognises LAIN's old build names.

## What intentionally still says LAIN

The deprecation notice; `window.LAIN` (the page's internal namespace); `lain.app` (the page's internal virtual
origin, never shown and never on the network); `LAIN_*` environment variables (mirrored from `NOEMA_*`);
comments and history in the source.
