# LAIN Design

An optional room in LAIN Harness for changing an app's screens by hand: drag, resize, restyle, add components, and wire
screens together. Every change is made in the project's source code, by a small exact edit you can read in the diff
and undo. Nothing about your app is stored anywhere else.

## Install

- **New install:** the LAIN installer has a **LAIN Design** checkbox, on by default.
- **Add or remove later:** Settings › Apps › LAIN › Modify (or run LAIN-Setup again) and tick or untick it, or run
  `Uninstall LAIN.exe --add-design` / `--remove-design`.
- **Hide without removing:** Settings › General › Components › LAIN Design.
- **From source:** `npm ci --omit=dev --prefix packages/design-core`.

Without Design, LAIN loads none of its code. The rail has no Design room, the Preview has no "Open in Design" button,
and ordinary sessions are exactly what they were before.

## What you can open

Design adopts the frontend you already have. It shows the **real running app**, never a redrawing of it.

| Project | Detected by | How Design finds an element's source | Edits |
|---|---|---|---|
| Plain HTML/CSS/JS (also `public/`, `www/`, a static `server.js`) | `.html` files | exact (ids added to the served page when it equals the file) | full |
| React + Vite (with or without React Router) | `react` + `vite` | exact (a Vite plugin added at start; your config is not edited) | full (style object, CSS class, scoped class, Tailwind utilities) |
| Vue + Vite | `vue` + `vite` | exact (the same plugin, for `<template>`) | full |
| SvelteKit / Svelte + Vite | `@sveltejs/kit` or `svelte` | exact (the same plugin) | full |
| Next.js (app or pages router) | `next` | resolved: React's own component names (`_debugInfo` for Server Components) | full for styles (CSS modules, global CSS); markup when mapped |
| Nuxt, Astro, Angular, Solid, Remix, other bundlers | their package | resolved or inferred; styles through the running page's CSS rule | styles full; markup when mapped |
| Android (XML layouts) | `settings.gradle(.kts)` + `AndroidManifest.xml` | exact | full for XML layouts; **unverified on a device**. Jetpack Compose: read-only |
| Anything else | — | — | read-only, with the reason |

### Running your app

1. **Attach first.** If your dev server is already running (a port Design finds open and that serves this project),
   Design uses it. Your terminal, your HMR, your server.
2. **Otherwise launch it** through LAIN's process manager: your own `dev` script (on a free port), or your project's
   Vite with Design's plugin, or a static server for plain files. The recipe that worked is kept in
   `.lain/design.json`.
3. **If neither works**, the project opens read-only with **Set launch command**: a command and a port, kept in
   `.lain/design.json`.

Design never edits your config files to instrument them. It adds `.lain/design.json` and `.lain/design/` to
`.git/info/exclude`, so `git status` stays clean. Telemetry flags of the frameworks it starts are turned off.

**Gated pages** (Launch & sign-in…): a cookie file exported from your browser, a login script that reads its secrets
from the environment, or a test URL that signs a test user in. These are paths and a URL, stored in LAIN's settings,
not the project. Design keeps no password, and a captured state blanks anything typed into a password field.

### Finding the source (the mapping ladder)

The Inspector shows how sure Design is about where an element comes from:

| Tier | Means |
|---|---|
| **exact** | Design instrumented this element at compile time |
| **resolved** | the framework's own dev hook named the file (`__svelte_meta`, Vue's `__file`, React's component owner) |
| **inferred** | a unique static match by tag, text, classes and attributes, above a threshold |
| **agent** | the Agent said where it is (**Ask the Agent where this is**), cached in `.lain/design/mappings.json` |
| **none** | selectable; style edits still work through the CSS rule; markup changes go to the prompt bar |

A near-tie is never guessed. Design shows the candidates and asks. An element rendered many times (a list, a reused
component) asks **"edit the component or only this instance?"**. The component is the default; "only this
instance" goes to the prompt bar, because one item of a list is data.

## The room

- **Top:** device, Design / Flow, Undo / Redo, Live (use the screens like the app and record a test), Run test, Open in IDE.
- **Left:** Screens, each with its layers. Drag a layer to reorder it. **+** adds a button, text, image or container,
  optionally with an image (.png, .ico, .svg, …) and a wire to another screen.
- **Center:** every screen in a device frame. Click to select. Drag to move: guides snap to the parent and siblings
  (hold Alt to skip snapping), the corner handle resizes, and the **→** handle wires the element to another screen.
- **Right:** the Inspector covers X, Y, W, H, gap, padding, radius, opacity, rotation, font size, colour and fill.
  Animation is a preset, a duration and an easing. Behavior covers trigger, action, target screen, transition,
  duration and easing.
- **Bottom:** describe a change to the Agent. The bar shows one status line, the diff, the result of any test the
  Agent ran, and the latest **change card**.

### Where a style goes

1. The element's own inline style, if it already sets that property.
2. A class only this element uses.
3. Otherwise, a new class just for it (`lain-…`).

A class shared by several elements is never changed silently: Design asks **"Change all N uses, or only this one?"**.
In a Tailwind project the utilities on the element are rewritten.

### How a drag moves things

- **An absolutely positioned element** changes its top/left/right/bottom. It keeps its anchor, which switches sides
  when you drag past the middle (top-right becomes top-left).
- **A flex or grid child** offers **Reorder** (the default when you drop it between siblings), **Offset**, or **Make
  absolute**.

### Every edit is proven

Before writing, Design predicts what the page should look like (the element's box, or the computed value). It
writes through the same stale-edit guard and mutation path as every LAIN edit, waits for your dev server's hot
reload, and measures the page again. If the element is more than **1 px** from the prediction, the write is undone
byte for byte. The status line then says why: an `!important` rule at file:line, a transform on a parent, a static
position, the element's own transform. It also offers what would work instead: Offset it, Make it absolute, Open
the winning rule, Ask the Agent.

For styles in an app Design did not instrument, the running page decides. Design asks the browser which rule sets
the property on this element, traces that rule to your file (source maps, Vite's ids, webpack's banners, CSS-module
names) and edits that declaration.

### Responsive

At a phone-sized device an edit lands inside the `@media` rule that applies at that width. Changing a base rule that
a breakpoint also overrides asks **"All sizes or only this breakpoint?"**. "Only this breakpoint" writes a new rule
inside the `@media` block.

### The design language

Design reads your tokens without running anything: CSS custom properties, SCSS variables, the Tailwind theme, and the
scales your stylesheets actually use (a 4- or 8-px grid, font sizes, radii, colours).

- Sliders snap to the scale (hold Alt for free values). A typed number is kept as typed, and an off-scale value is
  flagged, not refused.
- Colour pickers list your project's colours first, named tokens first.
- A value equal to a token is written as the token: `var(--brand)`, `$brand`, or `text-ink`.
- **+** gives a new element the classes of its nearest sibling of the same kind.

### Change cards

Every kept edit, yours or the Agent's, leaves a card in `.lain/design/artifacts/` (git-ignored). A card holds:

- before and after pictures;
- the diff;
- the proof;
- for the Agent, the frames of the test it ran.

The latest card sits in the prompt bar, and **All changes** opens the drawer. From the drawer:

- **Restore to here** undoes every later change.
- A comment goes to the Agent with that card as its context.

While the Agent drives the canvas, its frame is outlined with **Agent is testing**.

### Screens and states

Screens come from your router: Next app/pages, SvelteKit, Nuxt, Astro, React Router, Vue Router, Angular, or plain
files. When no router declares them, the search button **crawls** the running app's links.

**Capture state** keeps what you did in Live (opened a menu, signed in, filled a form) as a named state of that
screen. Its ▶ chip replays it.

### Wires and transitions

A wire is code in your project, between `// lain:wire` markers. It calls a small helper block that Design writes once.

- **Actions:** go to screen, toggle dropdown, open as modal, back, set state.
- **Transitions:** slide left/right/up, fade, scale, expand from element, dropdown reveal. Each has a duration and
  easing.

Flow mode shows these wires and the navigation you wrote yourself (links, `location.href`, `navigate()`,
`startActivity`).

## The Agent in a Design session

A Design session is its own kind: the usual tools plus five more, fixed for the whole session.

| Tool | Does |
|---|---|
| `design_inspect` | screens, flows and the undo stack; a screen's layers; a layer's (or a page selector's) source with its tier, styles, where a change would go, its measured box; `map` records where an unmapped element is rendered |
| `design_edit` | the same proven edits as the canvas; a question (shared class, breakpoint, flex move, many instances, ambiguous mapping) comes back as the question, and an edit that does not hold is undone with the reason |
| `design_flow` | list, add, update and remove wires |
| `design_interact` | drives the preview with a virtual cursor and keyboard: the open Design canvas if there is one, otherwise a headless browser of Design's own (Android: adb). Never your mouse, keyboard or windows. |
| `design_snapshot` | list, undo, redo, restore |

These five schemas take 3,151 bytes together. Ordinary sessions have none of them, and their prompt and cache prefix are byte-identical with or without Design.

Undo and Redo are file patches, not commits. Each restores the exact bytes, and refuses to run if the file changed
since the edit.

### Security

The preview is served on its own loopback origin, separate from LAIN's window, through a proxy that passes your dev
server's hot-reload websocket through untouched. Core's routes are not reachable over HTTP at all: they travel over
LAIN's authenticated named pipe. So nothing your app's JavaScript does can call them. The proxy refuses any `Host`
that is not local, which defeats DNS rebinding. The canvas frames get `allow-same-origin` only because their origin
differs from the window's.
