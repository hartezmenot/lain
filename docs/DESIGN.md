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

| Project | Detected by | Preview | Edits |
|---|---|---|---|
| Plain HTML/CSS/JS | `.html` files at the root (or `pages/`) | Design's own local server | full |
| React + Vite | `react` in package.json | your project's Vite with one plugin added at start (your config file is not edited); needs a trusted project and installed `node_modules` | full (style object, CSS class, scoped class, Tailwind utilities) |
| Android (XML layouts) | `settings.gradle(.kts)` + a module with `AndroidManifest.xml` | the device or emulator over adb | full for XML layouts; **unverified on a device**. Jetpack Compose (no XML layouts): read-only |
| Anything else | — | — | read-only, with the reason |

## The room

- **Top:** device, Design / Flow, Undo / Redo, Live (use the screens like the app and record a test), Run test, Open in IDE.
- **Left:** Screens, each with its layers. Drag a layer to reorder it. **+** adds a button, text, image or container,
  optionally with an image (.png, .ico, .svg, …) and a wire to another screen.
- **Center:** every screen in a device frame. Click to select. Drag to move: guides snap to the parent and siblings
  (hold Alt to skip snapping), the corner handle resizes, and the **→** handle wires the element to another screen.
- **Right:** the Inspector covers X, Y, W, H, gap, padding, radius, opacity, rotation, font size, colour and fill.
  Animation is a preset, a duration and an easing. Behavior covers trigger, action, target screen, transition,
  duration and easing.
- **Bottom:** describe a change to the Agent. The bar shows one status line, the diff, and the result of any test the
  Agent ran.

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
| `design_inspect` | screens, flows and the undo stack; a screen's layers; a layer's source, styles, where a change would go, its measured box |
| `design_edit` | the same exact edits as the canvas; a shared class or a flex move comes back as the question |
| `design_flow` | list, add, update and remove wires |
| `design_interact` | drives the preview with a virtual cursor and keyboard: the open Design canvas if there is one, otherwise a headless browser of Design's own (Android: adb). Never your mouse, keyboard or windows. |
| `design_snapshot` | list, undo, redo, restore |

These five schemas take 2,806 bytes together.

Undo and Redo are file patches, not commits. Each restores the exact bytes, and refuses to run if the file changed
since the edit.
