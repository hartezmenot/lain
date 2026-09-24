# TeamDesk — design spec

The settings page is a work tool. It is quiet, dense and exact.

## Voice and content

- Page heading (h1): **Settings**. Card heading (h2): **Workspace settings**.
- Plain, specific copy. No marketing language ("supercharge", "unleash",
  "seamless", "cutting-edge", "next-generation", "AI-powered" and friends).
- No emoji anywhere in the UI — not in the title, headings, buttons or copy.
- The save button reads **Save changes**. No exclamation marks, no all-caps.

## Colour and surface

- Neutral surfaces: page `#f6f7f9`, cards `#ffffff`, lines `#d9dee3`.
- One accent, `--accent: #2b6cb0`, for the primary button and the send button.
- **No gradients** and no coloured glow shadows, anywhere.

## Content density

- The page shows the settings a person came to change — nothing else. No
  marketing metrics ("10x", "99.9%", "teams trust us"), no badges or pills.
- No card inside a card. One surface per section.
- Corner radius at most 8 px on cards and controls (the avatar is a circle).

## Spacing

Only the spacing tokens: 4, 8, 12, 16, 24, 32 px (`--space-1` … `--space-6`).
Every padding on `.card` and `.btn` is one of those values.

## Controls

- Form controls — the workspace name input, the digest select and the save
  button — are all **36 px tall**.

## Responsive

- At 375 px wide (a phone) the page never scrolls sideways.

## Geometry

Top bar
- 56 px tall.
- The avatar is a **32 × 32 px circle**, vertically centred in the top bar.

Note composer (fixed to the bottom of the viewport)
- The composer box is **64 px tall** (outer, border included).
- The send button is a **40 × 40 px square**, vertically centred on the
  composer's outer box, and its right edge sits **12 px inside the composer's
  outer right edge** (border included in that 12).
- The composer has **equal left and right margins** to the viewport (24 px
  each), at every width.

## Behaviour

- The top bar shows the signed-in user's display name.
- Saved settings are what the next page load shows.
- Diagnostics are quiet by default: no debug output unless `LOG_LEVEL=debug`,
  no request bodies in logs, never a password.
