# LAIN for Chrome

A companion extension for the Chrome you already use — inspects and drives
tabs you explicitly authorize, for a connected LAIN session. Not the Harness
UI, the Frontend Workshop or a WebModel sign-in profile; see
`docs/LAIN_HARNESS_BLUEPRINT.md` §24's "LAIN for Chrome" subsection for how
it fits.

## Install (development)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this `extension/` folder.
2. In LAIN, run `/chrome connect`. It prints a token.
3. Click the LAIN for Chrome icon → paste the token → **Connect**.
4. Open the tab you want reachable → click **Authorize this tab** in the
   popup. Nothing is reachable until you do this, for any tab.
5. `/chrome status` in LAIN shows the bridge state and authorized tab count.

Disconnect any time from the popup or `/chrome disconnect` — the extension's
next request is then refused, not silently ignored.

## What it can and cannot do

- Only tabs you explicitly authorize, one popup click at a time.
- Targets elements by role/name/text (`find`'s `ref`), never a raw click
  coordinate.
- Everything a page returns — text, form values, element names — is treated
  as untrusted webpage content, never as something you said.
- It does not touch the native LAIN Harness window — that always uses
  ordinary mouse/keyboard/WebView2 input.

## Acceptance fixture

`fixture/acceptance.html` is a static page with a button, a dynamically
revealed element, a form, a long scroll, and one paragraph of
prompt-injection-shaped text — used to drive connect → enumerate → inspect →
click → type → navigate → switch tab → scroll → screenshot → verify by hand.
See docs/STATUS.md for what has and has not been run against a real Chrome
session.
