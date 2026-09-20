# Installing LAIN, and how to start it

One product, two entrypoints. They are not two applications: both start or
attach to the same Core, the same session store and the same authority.

```text
LAIN.exe     the native Harness window
lain         the CLI
```

---

## How I start it

| | |
|---|---|
| **GUI** | **Start Menu → LAIN**, or `<install>\LAIN.exe` |
| **CLI** | **`lain`** in any new terminal (with PATH integration), or `<install>\lain.cmd` |
| **From a checkout** | `node bin/lain.js` for the CLI · `node bin/lain.js --desktop` for the window |

The default install directory is `C:\Program Files\LAIN`, and nothing inside
LAIN assumes it — every runtime path derives from where the program actually
is, or from the user data directory.

---

## Building the installer

```text
node distribution/build.js          →  dist\LAIN-Setup.exe
```

One file, about 2 MB. It is compiled by the `csc.exe` that is part of Windows
and carries the product as an embedded archive; there is no build toolchain to
install. The payload IS `package.json`'s `files` allowlist — never a second
hand-written list, because two lists drift and the symptom is an installed LAIN
missing one module.

**The artifact is what gets certified.** `tests/distribution/installer.test.js`
installs *that file* and checks the result. A distribution only ever tested by
running `node src/...` in the repository has not been tested: the repository has
files the artifact does not, and every one of them is a way for the installed
product to work for a reason the user will not have.

---

## What the installer asks

```text
Install location:  [C:\Program Files\LAIN]  [Browse…]
[✓] Add the LAIN CLI to PATH
[ ] Create a desktop shortcut
                                          [Install]
```

That is all of it. Provider accounts, model sources and connections are
configured **in LAIN**, where they can be tested against the thing they
configure — an installer that asks for them is asking before it can verify
anything.

Silent, for scripts:

```text
LAIN-Setup.exe --silent --dir "D:\Apps\LAIN" --path [--desktop]
LAIN-Setup.exe --uninstall --dir "D:\Apps\LAIN" --silent [--remove-data]
```

---

## Settled policies

### Node — REQUIRED AND DETECTED, not bundled

LAIN needs **Node 18 or newer**. The installer finds it before it writes
anything, reports which one it will use, and refuses with the exact locations it
searched if there is none. `LAIN.exe` reports the same thing natively if Node
disappears afterwards, so the failure is never mysterious.

**Bundling was measured and declined, for now.** `node.exe` is 88 MB against a
6.5 MB product, and redistributing it properly means shipping the official
binary from a verified download together with its licence text — not copying
whatever `node.exe` happens to be on the build machine. That is a
fetch-and-verify step of the kind `native/vendor.js` already performs for the
WebView2 SDK, and it is a reasonable future option. It is recorded here so the
choice is a decision rather than an accident.

### WebView2 — the runtime is Windows', the SDK is ours

The WebView2 **runtime** ships with Windows 11 and updates with Edge. Nothing
is installed for it.

The **SDK** LAIN links against is vendored into the payload (`native/vendor/`,
801 KB) — added because the clean-room audit found an installed copy could not
build `LAIN.exe` without network access: *"the WebView2 SDK is not vendored"*. A
product that needs the internet to finish installing itself is not installed.

If the runtime is absent or in a bad state, the native host says which, with the
HRESULT — `0x8007139F` is reported as a state error rather than a missing
runtime. **It never falls back to a browser.**

### Program files and user data are separate

| Where | What |
|---|---|
| the install directory | the program: `bin`, `src`, `native`, `distribution`, `LAIN.exe`, `lain.cmd`, `launch.json` |
| `%USERPROFILE%\.lain-v2` | sessions, goals, plans, findings, credentials, caches, logs, desktop state |

Nothing mutable is written into the install directory. **Uninstalling removes
the program and keeps the work** — data goes only with an explicit
`--remove-data`.

### PATH

The **user's** PATH, never the machine's: installing a command for yourself
should not need administrator and should not change what other accounts
resolve. It is added once, is not duplicated by an upgrade, and is removed on
uninstall by exact directory match — every other entry comes back
byte-identical.

**Adding a directory to PATH does not make it win.** If something else answers
to `lain` first — an npm-installed copy in `%APPDATA%\npm`, say — the installer
says so, names it, and leaves it alone. It is the person's.

### Start Menu

`Start Menu → LAIN` targets **`LAIN.exe`**. Never `lain.cmd`, never `node.exe`,
never a URL: a shortcut that opens a console window or a browser is not this
product.

---

## Upgrade and uninstall

**Upgrade** replaces the program and keeps the work. A running LAIN is asked to
stop through **its own shutdown sequence** (`corelock` → `teardown.js`) before
any binary is replaced — the gateway, jobs, terminals, sessions, window and
lock, in the order they have to stop in. Killing is the last resort and is
reported. Files the new version no longer ships are removed rather than left to
be loaded.

**Uninstall** removes the program, the Start Menu and desktop shortcuts, the
PATH entry it added, and the Add/Remove Programs registration — and keeps the
sessions.
