# assets/

Brand assets for the app: the Construtora Moreira logo, generated PWA/iPhone
icons, the web manifest, and the self-hosted animation library used on the
sign-in screen.

## Logo files

- `source/logo-original.jpg` — the original logo as provided, unmodified. Keep
  this if the logo is ever replaced or the derived assets below need
  regenerating (different crop, padding, or colors).
- `logo-white.png` / `logo-white.webp` — the logo recolored solid white with
  the background made transparent, tightly cropped, sized for the app header
  and sign-in screen (used via `<picture>` with the webp as the preferred
  source and png as the universal fallback). Recolor technique: treat each
  pixel's distance from the (near-white) background as its alpha value, fill
  RGB with pure white — this turns any-colored line art into a clean white
  silhouette without touching its shape.

## Icons (`icon-*.png`, `apple-touch-icon.png`, `favicon*`)

Generated from the logo's full color version, centered with padding on a
white square (contain-fit, not cropped/redesigned), at the sizes each
consumer needs:
- `icon-192.png` / `icon-512.png` — referenced by `manifest.json` (Android/PWA).
- `apple-touch-icon.png` (180×180) — iOS home-screen icon. Must NOT be
  transparent — iOS fills transparent areas with black, hence the white
  background.
- `favicon.ico` (multi-size) + `favicon-16.png` / `favicon-32.png` — browser
  tab icon.

If the logo is ever replaced, regenerate all of these from the new
`source/logo-original.jpg` at the same crop/padding ratios rather than hand-editing
the PNGs.

## `manifest.json`

Standard web app manifest; referenced from `index.html`'s `<head>` via
`<link rel="manifest">`. iOS itself doesn't read this (it uses
`apple-touch-icon` + the `apple-mobile-web-app-*` meta tags in `index.html`
instead) — it's here for any Android/desktop PWA install prompt.

## `lottie-light.min.js` + `anim-login.json`

The sign-in screen's small "twinkling lights" animation. `lottie-light.min.js`
is the MIT-licensed [lottie-web](https://www.npmjs.com/package/lottie-web)
player (the "light" build — no expressions support, which this animation
doesn't use), self-hosted rather than loaded from a CDN so the decorative
animation never depends on a third party being reachable. `anim-login.json`
is a small hand-authored Lottie file (~10 circles fading in/out on a
staggered loop) — not exported from a design tool, so if it's ever edited by
hand again: Lottie keyframes in this build require integer frame numbers and
explicit `i`/`o` easing-handle objects on every non-final keyframe, or the
shape silently fails to render (stays hidden) instead of erroring.
