# A VS Code–compatible extension host for LAIN: investigation and plan

Status as of 2026-09-25: **not built.** LAIN installs extensions (.vsix, folder, https URL, Open VSX with sha256) and uses only their **snippets**. Extension code, themes, grammars, language servers and debuggers from extensions do not run. The UI says this for every installed extension. This document covers what it would take to run them properly, and in what order.

## What "compatible" would have to mean

An extension is a Node.js module that calls `require('vscode')`. That API has around 1,600 functions, events and types. Nearly every useful extension depends on some combination of:

| Surface | Used by | Hard part |
|---|---|---|
| `contributes.*` in package.json (languages, grammars, themes, snippets, keybindings, configuration) | almost all | Pure data, no code runs. **This is the cheap, safe first step.** |
| `languages.register*Provider` (completion, hover, definition, references, rename, formatting, code actions, diagnostics) | language extensions | Providers must be marshalled to Monaco across a process boundary. |
| Language Server Protocol (`vscode-languageclient`) | Python, Go, Rust, C#, Java… | Most of these ship or download a native server. LSP itself is a stable protocol. |
| `workspace.fs`, `workspace.findFiles`, file watchers, `TextDocument`/`TextEditor` models | most | A document model must be kept in sync with LAIN's editor buffers. |
| `window.*` UI (quick picks, input boxes, status bar, tree views, webviews) | many | Webviews need a sandboxed iframe with a message bridge. |
| `debug.*` and Debug Adapter Protocol | debuggers | DAP is a stable protocol; LAIN has no debug UI yet. |
| `tasks.*`, `terminal.*`, SCM providers, auth providers | some | Must go through LAIN's own owners (pty.js, gitops, connections). |

## Architecture

```
LAIN Core (Node) ──IPC (JSON-RPC over a pipe)── Extension Host process (Node, one per workspace)
     │                                               │  loads extension main modules
     │                                               │  provides a `vscode` API shim
     │                                               └─ spawns language servers / debug adapters
     └── owns: files, buffers, terminals, git, credentials, permissions
Window (Monaco) ──providers proxied through Core── Extension Host
```

- **Process isolation.** The host runs as a separate `node` process and never inside Core. A crashing or hung extension kills only the host, which is restarted with a backoff and a visible "Extension host restarted" notice. This is the same pattern VS Code uses, and the reason is the same: third-party code must not take the editor down.
- **Permissions.** An extension declares nothing, and VS Code runs it with the user's full rights. LAIN should not. Proposal: extensions run with a **grant**, the same model as LAIN plugins (`plugins.js` and the tool gate). The grant covers workspace read, workspace write, spawning processes, network, and secrets. Anything outside the grant is refused at the IPC boundary. A default grant of "read the workspace + provide language features" covers most language extensions without a spawn right, but language servers need spawn. That is a per-extension prompt with the server's path shown.
- **Open VSX compatibility.** Install already verifies sha256 from Open VSX. `engines.vscode` should be checked against the API version the shim implements; newer extensions are refused with the reason.
- **Version compatibility.** The shim declares an API version. Unimplemented calls throw `NotSupportedInLAIN(name)` and are counted per extension, so the UI can say "Python: 3 features unavailable in LAIN" rather than failing silently.

## Order of work (each step ships on its own)

1. **Declarative contributions (no code).**
   - TextMate grammars, through `vscode-textmate` + `vscode-oniguruma` (WASM) in the window, bridged to Monaco tokens.
   - Themes, mapped to Monaco themes.
   - `contributes.languages`: file associations, comments and brackets config.
   - `contributes.configuration` defaults.
   - `contributes.keybindings` for commands LAIN has.

   Risk is low, since no third-party code runs; the grammar engine is data-driven.
2. **LSP client in Core, without the extension host.** Configure language servers directly (pyright, gopls, rust-analyzer, typescript-language-server) with a spawn grant. Proxy definitions, references, rename, diagnostics and formatting to Monaco. This also gives the Coding Agent deterministic references and renames beyond TS/JS (spec §37), which LAIN's focus packet would then use in place of its lexical scan.
3. **Extension host, language-feature subset.** Load extensions whose activation needs only `languages.*`, `workspace` read, `TextDocument`, `commands`, `window.showInformationMessage` and the configuration API. Anything more is reported as unavailable.
4. **Webviews and tree views**, in a sandboxed iframe (CSP, no Node, message port only).
5. **DAP debugging**, with a debug UI in the IDE (breakpoints, call stack, variables, launch.json).

## Foundations already in place

- `src/extensions.js`: install from .vsix, folder, URL or Open VSX (sha256 verified); zip-slip, zip64, encryption and size refusals (`zipread.js`); global and workspace scope; enable/disable/uninstall/update; manifests kept as data.
- `src/plugins.js` + `tools/index.js`: permission grants enforced at the tool gate. This is the model the host's grant should reuse.
- `src/editorprofile.js` + `page/pageprofile.js`: settings, snippets, and single- and two-part keybindings applied to Monaco.
- `src/focuspacket.js`: the place where LSP-backed references would replace the lexical scan.

## What LAIN will not do

It will not run extension code in Core, run extensions without a grant, claim "compatible" for an extension whose used APIs are not implemented, or use the Microsoft Marketplace, whose terms restrict it to Microsoft products.
