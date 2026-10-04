# Running LAIN Desktop from a checkout (Windows, no installer)

Two folders side by side: `D:\lain` (this repository) and `D:\lain-harness` (the Harness). Node.js 20+ on PATH.

**Once:**
1. `npm ci --omit=dev --prefix packages/design-core`, which adds the parsers LAIN Design needs.
2. `powershell -NoProfile -ExecutionPolicy Bypass -File tools\dev\make-shortcut.ps1`, which adds **LAIN Desktop (dev)** to the Start menu.

**Start:** press Windows, type `LAIN Desktop`. Or run `tools\dev\lain-desktop.cmd` from any folder; it is the same as
`set LAIN_HARNESS_DIR=D:\lain-harness` followed by `node D:\lain\bin\lain.js --desktop`. Flags:
- `--dev` opens the developer window (devtools).
- `--no-design` runs a copy without Design.

A LAIN that is already running (the installed one, or a CLI) has to be exited first. Otherwise only its window would come to the front.
The first start compiles the window host (`csc.exe`, part of Windows) into LAIN's home folder.

**Update:** `git pull` in both folders, then `npm test` (and `npm ci --omit=dev --prefix packages/design-core` if its
`package-lock.json` changed). Restart LAIN Desktop. The installed LAIN and its updater are not involved.

**Remove the shortcut:** run `tools\dev\make-shortcut.ps1 -Remove`.
