# Argon Browser

Argon is an open-source desktop web browser for Linux built on LibreWolf and Mozilla's Gecko engine. It combines vertical tab management and isolated workspaces with built-in privacy protections and a compatibility bridge for Chromium extensions.

Argon runs as an independent application with its own binary (`argon`), a dedicated profile directory, and a Flatpak package (`org.argon.browser`). It runs alongside existing Firefox or LibreWolf installations without sharing cookies, history, or active sessions.

![Argon Browser with vertical tabs in dark mode](docs/assets/dark-vertical.png)

## Core features

### Native Rust-backed adblock engine

Argon integrates a browser-native content blocker powered by Brave's `adblock-rust` engine, compiled as both a native shared library (`libargon_adblock.so`) and a WebAssembly fallback (`engine.wasm`).

![Argon Native Adblock Panel](docs/assets/adblock-panel.png)

- Network-level request evaluation using Brave's adblock engine, pre-loaded with default filter lists.
- Remote filter list subscriptions managed directly by URL.
- Interactive element picker built on Gecko's `JSWindowActor` to create persistent cosmetic rules without third-party extensions.
- Hostname and request-type dynamic filtering rules (allow, block, and noop).
- Procedural cosmetic filtering and scriptlet injection to defuse anti-adblock scripts and sanitize DOM elements before page scripts execute.

### GhostPrint anti-fingerprinting

Argon protects against browser fingerprinting with GhostPrint, which applies deterministic, seed-based perturbation ("farbling") to browser APIs. GhostPrint is Argon's default anti-fingerprinting engine.

![Argon Privacy and Anti-Fingerprinting Settings](docs/assets/settings-privacy.png)

- Perturbation across Canvas (`getImageData`, `toDataURL`, `toBlob`), WebGL (`readPixels` and normalized GPU parameters), AudioContext (`AudioBuffer`, `AnalyserNode`), WebGPU device properties, hardware concurrency, and font and MIME enumeration.
- Per-session nonce rotation that regenerates seeds between browser sessions and isolates nonces in private browsing contexts.
- In-settings engine switching in `about:preferences`: choose GhostPrint (web-compatible farbling), Firefox Resist Fingerprinting (RFP strict spoofing), or both together.

### Tab layouts and workspaces

Argon supports different tab arrangements without requiring browser restarts or external add-ons:

- Dynamic switching between horizontal tabs and a collapsible vertical sidebar.
- Workspaces for organizing tabs into separate contexts (such as General, Work, and Personal) with independent active tabs.
- Pinned tabs kept globally across all workspaces or locked to specific contexts.
- Command palette (`Ctrl+Shift+P`) for tab search, workspace navigation, and browser commands.

### Chromium extension bridge

Argon includes a compatibility bridge to run Manifest V3 Chromium extensions alongside standard Firefox add-ons:

- Automatic translation of Chrome manifests into Gecko-compatible schemas.
- Background service worker runtime shim (`argon-mv3-runtime-shim.js`) mapping `skipWaiting` and `clients.claim` to Gecko background page lifecycles.
- API namespace aliasing from `chrome.*` to standard WebExtension APIs.
- Static analyzer for reviewing extension packages and manifest permissions prior to installation.

### First-run onboarding

Argon provides a first-run setup wizard inspired by Helium to configure initial settings:

- Theme selection across System Auto, Dark, and Light, with an optional toggle for Firefox Nova styling.
- Search engine selection (DuckDuckGo, Brave Search, SearXNG, Startpage, or Google) saved to system-level configuration.
- Query parameter stripping to remove tracking tokens and show clean URLs in the address bar.
- Browser data import for bookmarks, history, and passwords from existing installations.

### Localization (i18n)

Argon includes interface translations for 45+ languages in `l10n/`, with runtime language switching via the `argon.locale` preference.

---

## Developer workflow

Argon includes scripts for local development, synchronization, testing, and debugging.

### Development commands

| Command | Action |
| --- | --- |
| `npm run dev` | Launch the development browser with automatic file synchronization and live reload on save |
| `npm run dev:reset` | Reset the development profile to clean defaults and launch the browser |
| `npm run reset` | Reset the development profile and synchronize files without launching the browser |
| `npm run run:reset` | Alias to reset profile and start the browser |
| `npm run dev:sync` | Synchronize modified chrome and frontend files into the development profile without launching |

### Testing commands

| Command | Action |
| --- | --- |
| `npm test` | Run the full test suite (adblock, GhostPrint, cosmetics, appearance, onboarding, extensions) |
| `npm run test:dev` | Test the development server watcher and synchronization mechanisms |
| `npm run test:adblock` | Test adblock-rust filtering, cosmetic injection, and native ABI wrappers |
| `npm run test:ghostprint` | Run GhostPrint verification tests and surface perturbation checks |
| `npm run test:python` | Run Python tests for build automation and overlay validation |
| `npm run test:browser` | Execute end-to-end browser smoke tests in an isolated runtime |

---

## Extension compatibility analyzer

Argon provides a command-line tool to inspect a Chrome extension's `manifest.json` before installation:

```bash
npm run analyze -- path/to/manifest.json
```

The analyzer runs static checks on permissions, host declarations, and background service worker requirements, reporting any unsupported APIs or permission warnings.

---

## Installation

Argon is packaged primarily as a Linux Flatpak.

### Flatpak

Install and run the Flatpak bundle:

```bash
flatpak install --user org.argon.browser.flatpak
flatpak run org.argon.browser
```

---

## Building from source

Argon builds on Linux x86_64 using Mozilla's `mach` toolchain, applying LibreWolf privacy patches and the Argon overlay onto a pinned source tree.

### System requirements

- Linux x86_64
- Python 3.10 or newer
- Node.js 22 or newer
- Git
- Rust and Cargo (with `wasm32-unknown-unknown` target for rebuilding adblock artifacts)
- Minimum 8 GB RAM and 40 GB free disk space

### Build steps

```bash
npm run doctor      # Check toolchain, memory, disk space, and application identity
npm run fetch       # Download and verify the pinned upstream source archive
npm run apply       # Apply LibreWolf patches and the Argon overlay
npm run bootstrap   # Install required toolchains via mach
npm run build       # Compile dist/bin/argon
npm start           # Launch the built browser with a development profile
npm run flatpak     # Package the distributable Flatpak bundle
```

To rebuild the native filter engine and vendored cosmetic interpreter:

```bash
npm run build:adblock
python3 scripts/build-ublock-cosmetics.py
npm run update:adblock
```

---

## Repository layout

- `argon/`: Core Argon frontend modules (native adblock panel, workspaces, command palette, extension bridge, preferences, onboarding).
- `native/adblock/`: Rust wrapper source and build definitions for the native filter engine.
- `third_party/ghostprint/`: Pinned GhostPrint upstream source, license, and test fixtures.
- `browser/`: Firefox and LibreWolf chrome modifications, theme styling, and branding assets.
- `config/`: Upstream source configuration, mozconfig definitions, and overlay maps.
- `docs/`: Technical documentation and asset files.
- `l10n/`: Locale definitions and translation files for 45+ languages.
- `packaging/`: Flatpak manifests, desktop entry files, and appstream metadata.
- `patches/`: Privacy and Linux integration patches from LibreWolf.
- `scripts/`: Development utilities, build automation, and test runners.
- `tests/`: Automated unit, integration, and browser smoke tests.
- `website/`: Landing page source and interactive extension analyzer.

---

## License and upstream credits

Argon Browser is open source under the [Mozilla Public License 2.0 (MPL 2.0)](./LICENSE). Individual vendored components retain their respective licenses:

- [Brave adblock-rust](https://github.com/brave/adblock-rust) (MPL 2.0): Native network filter matching engine. Rust dependency notices are in [THIRD-PARTY-NOTICES.txt](./argon/adblock/THIRD-PARTY-NOTICES.txt).
- [uBlock Origin](https://github.com/gorhill/ublock) (GPL-3.0-or-later): Cosmetic filtering logic and procedural scriptlet interpreter. Notices and license are in [argon/adblock/ublock/LICENSE.txt](./argon/adblock/ublock/LICENSE.txt).
- [GhostPrint](https://github.com/gnustella-lab/GhostPrint) (MIT): Fingerprint perturbation engine. Notices and license are in [third_party/ghostprint/LICENSE](./third_party/ghostprint/LICENSE).
- [Helium](https://github.com/imputnet/helium): Inspiration for onboarding flow and default privacy selections.
- [LibreWolf](https://librewolf.net/): Upstream privacy and security patch foundations.

Firefox is a trademark of the Mozilla Foundation.
