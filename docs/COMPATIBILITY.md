# Compatibility (internal)

## Versions

`noema --version` → `Noema CLI <version> (<channel>[, <git revision>]) · node <version>`. The Harness reports
`Noema Harness <version>` from the same build (`build-info.json`: product, version, channel, revision, built, feed).
A checkout reports channel `development`. Executables carry the version, product "Noema" and the file description
("Noema CLI", "Noema", "Noema Harness", "Noema Setup") in their version resources.

## Core protocol

`src/update/compat.js` — `PROTOCOL = 1`: the shape of the window ↔ Core messages (IPC routes, state projection) and
the Core control pipe verbs (`show`, `status`, `open`, `preview`, `quit`, `dashboard:<section>`).
The Core's `status` answer carries its version and protocol. A launch that finds a running Core of another version
says so ("Noema 0.1.1 is installed; this Core still runs 0.1.0 — restart it to update"); a **protocol** mismatch
refuses to attach and names which one to restart (`attach()`, used by `src/desktoprun.js`).

## The release manifest

| Field | Meaning |
|---|---|
| `minimumCompatible` | the oldest installed version that can update straight to this one — an older one is told to install the intermediate version first |
| `protocol` | the Core protocol this release speaks |
| `minimumCli` / `minimumHarness` | the oldest CLI / Harness that can attach to this Core |
| `mandatory` / `security` | shown to the person; they never cause a silent restart |

The CLI and the Harness are always the same build (one package, one Core), so within an install they are
compatible by construction; the fields exist for the Harness being added later from an older/newer setup and for
future split releases.

## Data

Sessions, accounts and settings written by LAIN are read by Noema unchanged (same formats, moved home). The
project store accepts `.lain/` and `.noema/` (`docs/MIGRATION.md`). A downgrade to an older Noema (the launcher's
rollback) reads the same home; nothing written by the newer version is required by the older one.
