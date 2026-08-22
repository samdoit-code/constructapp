# assets/

Brand assets for the app: the Construtora Moreira logo, generated PWA/iPhone
icons, and the web manifest.

## Logo files

- `source/logo-original.jpg` — the original logo as provided, unmodified. Keep
  this if the logo is ever replaced or the derived assets below need
  regenerating (different crop, padding, or colors).
- `logo-white.png` / `logo-white.webp` — the logo recolored solid white with
  the background made transparent, tightly cropped. Used via `<picture>`
  (webp preferred, png fallback) in both the app header and the sign-in
  screen, as a plain static mark — no animation. Recolor technique: treat
  each pixel's distance from the (near-white) background as its alpha value,
  fill RGB with pure white — turns any-colored line art into a clean white
  silhouette without touching its shape.

Two different animated treatments for this logo on the sign-in screen (a
Lottie-based one, then a CSS "two halves slide together" one) were tried and
reverted — neither looked good in practice. The sign-in screen is
intentionally a plain static logo on a flat background now; don't
reintroduce motion there without being asked.

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
