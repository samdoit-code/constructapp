# assets/

Brand assets for the app: the Construtora Moreira logo, generated PWA/iPhone
icons, and the web manifest.

## Logo files

- `source/logo-original.jpg` — the original logo as provided, unmodified. Keep
  this if the logo is ever replaced or the derived assets below need
  regenerating (different crop, padding, or colors).
- `logo-white.png` / `logo-white.webp` — the logo recolored solid white with
  the background made transparent, tightly cropped. Used via `<picture>`
  (webp preferred, png fallback) in the app header, and as the two-piece
  animated mark on the sign-in screen (see below). Recolor technique: treat
  each pixel's distance from the (near-white) background as its alpha value,
  fill RGB with pure white — turns any-colored line art into a clean white
  silhouette without touching its shape.

### Sign-in screen logo animation

The sign-in screen (`#authGate .logo-hero`) renders `logo-white.png` twice,
each copy clipped to one natural half of the mark (`clip-path: inset(...)`,
split at the gap between the "C" and the "M", found by profiling which
column has the fewest opaque pixels) and animated in from its own side with
a soft overshoot, plus a warm glow that breathes in afterward. Pure CSS
(`@keyframes`), no animation library — kept the "pieces settle into place"
treatment lightweight rather than hand-authoring something like Lottie for
it, since the two-piece split is simple to maintain by eye if the logo is
ever swapped (re-check the split % against the new artwork's C/M gap).

## Icons (`icon-*.png`, `apple-touch-icon.png`, `favicon*`)

Generated from the logo's full color version, centered with padding on a
solid **orange** (`#e0651f`, the app's `--orange`) square — not
cropped/redesigned, just contain-fit — at the sizes each consumer needs:
- `icon-192.png` / `icon-512.png` — referenced by `manifest.json` (Android/PWA).
- `apple-touch-icon.png` (180×180) — iOS home-screen icon. Must NOT be
  transparent — iOS fills transparent areas with black, hence the solid
  background.
- `favicon.ico` (multi-size) + `favicon-16.png` / `favicon-32.png` — browser
  tab icon.

If the logo is ever replaced, regenerate all of these from the new
`source/logo-original.jpg` at the same crop/padding ratios and background
color rather than hand-editing the PNGs.

## `manifest.json`

Standard web app manifest; referenced from `index.html`'s `<head>` via
`<link rel="manifest">`. iOS itself doesn't read this (it uses
`apple-touch-icon` instead) — it's here for any Android/desktop PWA install
prompt.

Note: `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style`
were tried here briefly and reverted — they change how iOS computes the
safe-area/viewport for a home-screen PWA and caused a blank gap below the
bottom tab bar. Re-test carefully on an actual iOS device before
reintroducing either.
