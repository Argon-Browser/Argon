# Argon Branding & Brand Kit

Status: canonical Argon brand kit and Firefox-compatible branding package
(`browser/branding/argon/` + `brand-kit/`), used by full Argon builds
(`config/mozconfig`).

## Visual identity

The Argon mark is a flat rounded square (`rx = 20` on a `128 × 128` grid,
`15.625%` corner radius) in **Argon Obsidian** (`#1E1E1E`) carrying a warm
**Argon Ivory** (`#FBF8F4`) geometric **"A"** with four defining traits:

1. **Circularly rounded apex cap** (`r = 8.55 u` centered at `(64, 31.4)`, top
   tangent at `y = 22.85 u`).
2. **Flat horizontal baseline feet** (`y = 106 u`, left foot `x = 16..31 u`,
   right foot `x = 97..112 u`).
3. **Sharp inner V vertex** at `(64, 41.5)`.
4. **Detached floating trapezoidal crossbar** (`y = 78..87 u`, top `x = 50.5..77.5 u`,
   bottom `x = 46..82 u`), separated from both inner legs by a `6.5 u` air gap.

It contains no Mozilla or Firefox artwork, wordmarks, or colour marks. The
name "Argon" is an independent identity and is not translated or
transliterated.

### Product strings

| Key | Value |
| :-- | :-- |
| Short name | Argon |
| Full name | Argon Browser |
| Vendor | Argon |
| Bundle / Distribution ID | `org.argon.browser` |

### Color palette

| Token / Name | Hex | RGB | Role |
| :-- | :-- | :-- | :-- |
| **Argon Obsidian** (`--argon-brand-obsidian`) | `#1E1E1E` | `30, 30, 30` | Primary mark container & dark brand surface |
| **Argon Ivory** (`--argon-brand-ivory`) | `#FBF8F4` | `251, 248, 244` | Primary mark glyph & warm light brand surface |
| **Argon Accent** (`--argon-accent`) | `#6478F5` | `100, 120, 245` | Interactive controls & private-browsing mark glyph |
| **Chrome Dark BG** (`--argon-bg` dark) | `#15171B` | `21, 23, 27` | Primary dark window & toolbar surface |
| **Chrome Dark Surface** (`--argon-surface` dark) | `#23262D` | `35, 38, 45` | Elevated dark cards, tabs, and popups |
| **Chrome Light BG** (`--argon-bg` light) | `#F7F8FA` | `247, 248, 250` | Primary light window & toolbar surface |

## Brand Kit inventory (`brand-kit/`)

| File | Description |
| :-- | :-- |
| `brand-kit/argon-brand-sheet.png` | `1600 × 1100` visual overview sheet (mark variants, 128u construction grid, lockups, palette, icon scale) |
| `brand-kit/mark-primary.svg`, `mark-primary-512.png` | Primary mark (`#1E1E1E` container, `#FBF8F4` glyph) |
| `brand-kit/mark-inverted.svg`, `mark-inverted-512.png` | Inverted mark for light badges (`#FBF8F4` container, `#1E1E1E` glyph) |
| `brand-kit/mark-private.svg`, `mark-private-512.png` | Private browsing mark (`#15171B` container, `#6478F5` glyph) |
| `brand-kit/glyph-ivory.svg`, `glyph-ivory-512.png` | Standalone uncontained glyph in Ivory (`#FBF8F4`) |
| `brand-kit/glyph-obsidian.svg`, `glyph-obsidian-512.png` | Standalone uncontained glyph in Obsidian (`#1E1E1E`) |
| `brand-kit/lockup-dark.svg`, `lockup-light.svg` | Horizontal mark + wordmark lockups for dark and light surfaces |
| `brand-kit/construction-grid.svg` | Vector construction diagram on the `128 × 128` coordinate system |
| `brand-kit/brand-tokens.json` | Machine-readable geometry, color, and typography tokens |

## Browser branding package (`browser/branding/argon/`)

`browser/branding/argon/` mirrors the layout Firefox's branding module expects,
so the directory is copied into the pinned upstream tree by
`python3 scripts/argon.py apply`.

| Asset | Purpose |
| :-- | :-- |
| `default{16,32,48,64,128}.png` | Application icons, exact square sizes |
| `default256.png` | High-density application icon |
| `content/branding/about-logo.png`, `about-logo@2x.png` | About dialog mark (`#1E1E1E` / `#FBF8F4`) |
| `content/branding/about-logo.svg` | Vector source for the mark |
| `content/branding/about-wordmark.svg` | Mark with the Argon wordmark |
| `content/branding/firefox-wordmark.svg` | Wordmark file at the name upstream expects; the artwork is Argon |
| `content/branding/about-logo-private*.png` | Dark-chrome + accent mark for private windows |
| `content/branding/document_pdf.svg` | File-type association artwork |
| `content/branding/aboutDialog.css` | Flat about-dialog styling |
| `moz.build`, `configure.sh` | Build integration and application identity |
| `content/{moz.build,jar.mn}` | Packaging of the branding resources |
| `locales/{moz.build,jar.mn}`, `locales/en-US/{brand.ftl,brand.properties}` | English brand strings |
| `pref/firefox-branding.js` | Branding preferences |

## Regenerating

All raster assets in `browser/branding/argon/` and `brand-kit/` are generated
from the 128-unit geometry in `scripts/generate-branding.py`:

```bash
python3 scripts/generate-branding.py
```

Pillow is required to run the generator, but the generated PNG files
are committed, so nothing at build or test time depends on Pillow.

## Tests

```bash
python3 -m unittest discover -s tests/branding -v
```
