# Where LAIN lives (2026-09-23)

Three places, three owners. Nothing is duplicated between them.

| Path | What | Version control |
|---|---|---|
| `D:\lain` | **LAIN Core + CLI**: the one runtime (sessions, Goal, tools, permissions, workers, Browser/Computer, providers, Bot state, crash recovery), the CLI renderer, the tests and benches | git, the canonical repository |
| `D:\lain-harness` | **LAIN Harness**: the visual frontend (`page/`) and its native WebView2 host (`native/host.cs`). Presentation only | its own git repository, history extracted from this one |
| `E:\AI\models`, `E:\AI\runtime` | **Model store**: specialist weights and their runtimes (Laya, Violetto's GGUF, the patched llama.cpp) | none: machine state, never committed |

## Relocation

The canonical checkout moved from `C:\Users\Hartezmenot\Documents\lain-v2`
to `D:\lain`. It was **moved, not re-initialised**: the `.git` directory went
with it, so the history and the commits are the same (`git log` is unchanged,
HEAD `90d0a50`).

What was switched over:
- the global `lain` command: the npm junction `%APPDATA%\npm\node_modules\lain`
  now points at `D:\lain`;
- LAIN Desktop's `~/.lain-v2/desktop/launch.json` entry;
- the trusted-path entry in `~/.lain-v2/config.json`, which was backed up first
  to `config.json.pre-move-20260923`. The 9 connections were not touched.

The running LAIN (the Desktop host and its supervisor) was stopped and started
again from `D:\lain`. The supervisor's executable path was checked through
`Win32_Process`.

The old directory holds only `MOVED.txt`, so it cannot become authoritative
again by accident. References to the old path that remain are historical
(dated STATUS entries and session transcripts) and are left as they were.

## Harness separation

- **The boundary is the one that already existed.** The Harness talks to Core
  over the local HTTP API (`src/harnessapp/routes.js`, `state.js`), and the
  native window uses the named pipe (`src/harnessapp/ipc.js`). Neither the page
  nor the host holds state of its own.
- **What moved.** The page modules (`src/harnessapp/page*.js` → `page/`),
  `native/host.cs`, and the WebView2 SDK fetcher (`native/vendor.js`, with its
  `native/vendor/` cache).
- **What stayed in Core.** Every route, the state projection, IPC, the Desktop
  lifecycle (`src/desktop*.js`) and the build step. Core compiles the host from
  the Harness's `hostSource` and serves the Harness's `html()`.
- **The contract.** `src/harnesslocation.js` loads the package (`CONTRACT = 1`)
  from, in order:
  1. `LAIN_HARNESS_DIR`;
  2. `<lain>/harness`, where an installed build carries it
     (`distribution/payload.js`);
  3. the sibling `../lain-harness`.

  If none is found, the desktop surface reports the Harness as not installed,
  and the CLI does not notice.
- **History.** The Harness history was extracted with `git filter-branch
  --index-filter` in a `--no-local` clone, so this repository's history was
  not rewritten. In `D:\lain-harness` the restructure (`page/`, `index.js`,
  `package.json`) is staged but **not committed**.
- **Proof.** The harness tier (37/37) and distribution tier (48/48) pass
  against the separated layout. `tests/smoke/desktop-real.test.js` builds the
  host from the Harness source and loads its page through Core.

## Model store

- **Nothing multi-gigabyte enters either repository.** `workers/manifest.json`
  records identity only: the model id, package version, SHA-256, licence and
  runtime.
- **Machine paths are per user.** Defaults live in the manifest, and overrides
  go in `cfg.workers.<id>` in `~/.lain-v2/config.json`, never in the repo.

| Store path | Contents |
|---|---|
| `E:\AI\models\laya\hf` | Laya weights, 2.3 GB (Hugging Face cache layout) |
| `E:\AI\runtime\specialists` | uv venv: `laya==0.3.6` with CPU torch |
| `E:\AI\models\violetto` | `limite-1b-violetto-Q4_K_M.gguf`, SHA-256 `e306eafb…d5fe7` (verified), with `limite.patch` and the tokenizer/template files |
| `E:\AI\runtime\llama.cpp-limite` | llama.cpp at `58367713` plus `limite.patch`, built with MSVC for CPU |

The Laya adapter runs offline (`HF_HUB_OFFLINE=1`). It downloads only when
`LAIN_WORKER_ALLOW_DOWNLOAD=1` is set.
