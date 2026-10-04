# LAIN Design — blueprint (D0 audit, 2026-10-04)

## What exists today

**The Harness** (`lain-harness`) is not Electron or Tauri. It is one HTML document that Core assembles from module
strings (`page/page.js`: each module exports `CSS`, `HTML`, `js()`), shown by a native WebView2 host (`native/host.cs`,
compiled on the user's machine). No bundler, no build step. Core serves it over a named pipe (`src/harnessapp/ipc.js`)
and answers `/api/*` (`src/harnessapp/routes.js` + `*routes.js`). Rooms are rail tabs (`page/shell/shell.js`:
`data-tab="home|ide|chat|model|usage|mcp|settings"`, `L.nav.tab()`); the IDE (`page/workbench/ide.js`) has an explorer,
editor groups, a bottom panel (Terminal/Problems/Output) and the Chat | Coding Agent sidecar (`L.botpane`).
**A new top-level tab plugs in as one more rail button** plus a view, exactly like the others.

**The Preview** (`src/workshop/*`, page `workbench/workshop.js`) already does a lot Design reuses:
the project's dev server (detected from what it declares, started through the process authority — `devserver.js`), a
static server for plain-file projects (`staticserve.js`), a proxy that injects a bridge script into the project's page
(`proxy.js`, `bridge.js`: hover, hold-to-inspect, selection box, resize handles, postMessage to the window), viewports
(`viewport.js`), CDP screenshots and DOM reads through a Workshop browser (`index.js`, `src/harness/cdp.js`,
`browser.js`), and **model input inside the Preview only** (`previewinput.js` + the `preview` tool: click, type, drag,
scroll, key — routed through the in-page bridge, never the OS).

**The `computer` tool** drives the real desktop (bridge.cs: SendInput, focus lock, kill switch). Design must not use it:
`design_interact` reuses the Preview's approach (in-page input) and CDP `Input.dispatch*` for headless runs.

**Tools**: `src/tools/core.js` fixes 17 core tools; `src/tools/index.js simpleActive()` is the one place a session's
list is computed. **Install**: `distribution/setupui.cs` (in lain-cli, not lain-harness) already has an optional
"LAIN Harness" checkbox and `Components`; `distribution/release.js` assembles the payload.

## Plan

| Piece | Where | Loaded when |
|---|---|---|
| `packages/design-core` — adapters, AST edit engine, flow graph, animations, snapshots, `design_*` tools, the preview runtime, the Vite plugin | lain-cli | only by a Design session or a `/api/design/*` route, and only if installed |
| `src/design.js` — locate/installed check, the Design session kind, the CDP driver for headless input | lain-cli Core | lazily, by the routes and the session |
| `src/harnessapp/designroutes.js` — `/api/design/*` | lain-cli Core | registered always; `require`s design-core on first call |
| `design/` — the Design tab UI (canvas, layers, inspector, flow overlay, prompt bar) | lain-harness | fetched by the page on first open (served beside the page via `assetDirs`, only when `design/` is present) |
| `page/shell/designentry.js` — the rail button (only if installed), Open in Design, the chip | lain-harness main page | always (a few hundred bytes; no Design logic) |

**A Design session** is an ordinary session with `kind: 'design'`. Its tool list is the 17 core tools plus five
`design_*` tools, fixed at creation. Normal sessions never see them; their prefix stays byte-identical (tested).

**Edits** are deterministic splices: parse (Babel for JS/JSX/TS, postcss for CSS, parse5 for HTML) only to find exact
source offsets, then replace those bytes. Formatting outside the edited span is untouched by construction, and Undo
restores bytes exactly. Every edit is checked against the bytes it was computed from (the stale-edit guard), written
inside Core's mutation transaction by a realpath-contained writer, snapshotted, then the preview reloads.

**Click → source**: plain HTML is served through Design's own preview server, which adds `data-lain-id` (a hash of
`file:line:col`, computed from parse5 source positions) to every element; React/Vite gets the same ids from a dev-only
Vite plugin added to the project's own Vite at `createServer` time — the project's config file is never edited.

**Wires** are code: a template per framework with a `lain:wire <id>` marker; `scanFlows()` reads marked wires and
plain navigation written by hand (`href`, `location.href`, `navigate()`, `<Link to>`). The only sidecar,
`.lain/design.json`, holds where flow nodes sit on the canvas — nothing with code meaning.

## Where the order and the code disagree (adapted, not stopped)

1. **No dependency in Core.** LAIN Core has zero runtime dependencies by policy. The parsers live only in
   `packages/design-core/package.json`; Core never requires them. No ts-morph: splicing at parser offsets is smaller,
   exact, and format-preserving.
2. **No Electron/Tauri bundle.** The "design-ui bundle" is a folder of page modules Core hands the window on demand.
3. **The visible preview is a WebView2 iframe**, which Core cannot drive over CDP. `design_interact` therefore drives the
   in-page Design runtime when a Design canvas is attached (so the person watches the cursor), and a headless Chromium
   over CDP otherwise (tests, CLI). Both are inside the preview; neither moves the real mouse.
4. **The installer lives in lain-cli** (`distribution/`). The Design checkbox goes there; installing it means putting
   `packages/design-core` with its `node_modules` into the payload. Building that payload offline needs the packages
   vendored at release time — **a release-host decision for the person** (no host is invented here).
5. **Android**: no emulator or adb here; D7 is built against XML layouts + Kotlin Activities and hand-assembled adb
   output (`tests/fixtures/design/android-chat/recorded`), and is marked unverified on a device. Jetpack Compose is not
   edited: an Android project with no XML layouts opens read-only and says so.
6. The existing Preview's "Edit size → Apply" hands a draft to the Coding Agent. Design keeps that path untouched and
   adds the deterministic one beside it.

## Not verifiable here (Linux container, no Windows desktop)

WebView2 rendering of the tab, drag/snap feel, the visible virtual cursor in the window, the installer (C#), and
anything Android on a device. Headless tests cover the engine, adapters, routes, tool schemas, cache proofs and
module-loading proofs, plus preview geometry and input in headless Chromium.

## Built (D1–D8) — what landed, file by file

| Piece | Files |
|---|---|
| Engine | `packages/design-core/src/` — `text` (splices, ids, hunk diffs), `html`, `css`, `jsx`, `xml` (parsers → offsets), `web` (HTML adapter, style planner, ops, commit/undo), `react` (React/Vite adapter + Vite plugin), `android` (layouts, Activities, adb), `layout` + `snap` (drag semantics, guides), `flow` + `animations` (wires, presets), `snapshots`, `server` (preview), `runtime` (in-page), `headless` (CDP driver), `tools` (design_*), `context` (prompt bar pack), `index` |
| Core | `src/design.js` (the one door), `src/harnessapp/designroutes.js`, `src/tools/index.js` (Design session tools), `src/session.js` + `src/sessionpool.js` (`kind: 'design'`), `src/components.js` + `src/settings.js` (component, switch) |
| Installer | `distribution/setup.cs`, `setupui.cs` (checkbox, `--design/--no-design/--add-design/--remove-design`), `release.js` + `designpayload.js` (staging) |
| Harness | `page/shell/designentry.js` (the door), `design/design.js` + `design.css` (the surface), `shell.js` (`nav.register`), `client.js` (`onSent`), `webvendor.js` (serve `design/`), `native/host.cs` (image file picker) |
| Tests | `tests/unit/design*.test.js`, `tests/integration/design-real.test.js`, `tests/designbench.js`, fixtures `chat-messenger`, `react-mini`, `android-chat` |

Changes from the plan above: the surface is served by `assetDirs` (not a `/api/design/ui` route); `fileguard` is the
engine's own byte check inside `mutation.transact/change`; the Android adapter edits XML layouts, not Compose.

## D9 — adopting any existing frontend (detect, map, align)

| Piece | Files |
|---|---|
| Detect and launch | `packages/design-core/src/detect.js` (framework, bundler, styling, router, launch recipe), `launch.js` (attach with evidence → the dev script on a free port → the project's own Vite via `vitehost.js` → a static server), `src/design.js` (LAIN's ProcessManager spawns; recipe and launch in `.lain/design.json`; `.git/info/exclude`) |
| One proxy | `proxy.js` (own loopback origin, Host check, HMR websocket passed through, runtime injected into HTML) |
| Mapping ladder | `plugins.js` + `tmpl.js` (JSX, Vue and Svelte instrumentation at transform time, `order: 'pre'`), `mapper.js` (exact → resolved → inferred → agent → none; near-ties ask), `runtime.js` (`describe`, React owners incl. `_debugInfo`, Svelte/Vue dev hooks) |
| Styles through the running page | `styles.js` (CDP `CSS.getMatchedStylesForNode`; origin via source maps, Vite ids, webpack banners and CSS-module names, a unique snippet in the project) |
| Alignment proof | `adopt.js` (`planStyle`, `prove`: predict with a probe, write, wait for HMR, re-measure, >1 px → byte-exact undo + `explain`), `pipeline.js` (every canvas and `design_edit` edit) |
| Screens and states | `routes.js` (Next app/pages, SvelteKit, Nuxt, Astro, React Router, Vue Router, Angular, files), `crawl.js`, `states.js`; sign-in in `index.js` (`signIn`: cookie jar, login script, test URL) |
| Design language | `tokens.js` (CSS vars, SCSS `$`, Tailwind theme read statically, grid and scales; `snap`, `offScale`, `token`, `utility`); `web.js` insert borrows the nearest same-kind sibling's classes |
| Change cards | `cards.js` (`.lain/design/artifacts/`), Agent test frames from `tools.js` |
| AnyFrontend adapter | `app.js` (`AppProject`: one adapter over JSX, Vue and Svelte templates, layouts and imported components as layers) |
| Core routes | `designroutes.js`: select, map-ask, launch, states, crawl, cards, tokens, auth; edit through the pipeline |
| Harness | `design/design.js`: tier badge and candidates, Ask the Agent, breakpoint/instance/mapping questions, revert reason + alternatives, snapping sliders, off-scale flags, project colours first, Capture state and ▶ replay, crawl, Launch & sign-in…, Set launch command, change-card bar + drawer (restore, comment), "Agent is testing" frame |
| Fixtures and tests | `tests/fixtures/design/{react-mini (Tailwind), vue-mini, sveltekit-mini, next-mini, spa-scss, legacy-public, running-server}`, `tools/dev/design-fixtures.js` (installs them; tests skip unless `LAIN_DESIGN_REQUIRE_FIXTURES=1`), `tests/integration/design-adopt.test.js` (the ten acceptance tests) |

Adapted, not stopped:

- Plain-HTML ids are added to the served page only when the served body equals the file. A server that rewrites the
  page falls back to the CSS origin.
- Next has no transform hook Design can add without editing `next.config`. Its elements resolve through React's
  component names instead of being instrumented.
- "Only this instance" of a repeated element is data, not markup. It goes to the prompt bar.
- Variants (optional in the order) are not built.
