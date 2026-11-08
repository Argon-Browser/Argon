# Argon Browser

Argon is an open source desktop web browser for Linux built on LibreWolf and Mozilla's Gecko engine. It pairs vertical tabs and workspaces with hardened privacy defaults and a compatibility bridge for Chromium extensions.

Argon runs as an independent application with its own binary (`argon`), dedicated profile directory, and Flatpak package (`org.argon.browser`). It operates alongside existing Firefox or LibreWolf installations without sharing cookies, history, or active sessions.

## What Argon includes

- Switchable tab layouts: switch between standard horizontal tabs and a collapsible vertical sidebar at runtime without restarting the browser.
- Workspaces: organize tabs into distinct contexts with separate active tabs. Pinned tabs remain accessible across every workspace.
- Command palette: open a keyboard launcher with Ctrl+Shift+P to search open tabs, run browser commands, switch workspaces, and filter bookmarks.
- Extension compatibility: install add-ons from addons.mozilla.org directly, or run Chromium extensions through the built-in Extension Bridge, which converts manifests, handles Chrome API namespaces, and bridges Manifest V3 service workers to Gecko's background page architecture.
- Privacy defaults: telemetry reporting, Mozilla studies, Normandy experiments, and sponsored New Tab tiles are removed or disabled by default.
- Native adblock panel: a Brave Shields-inspired toolbar panel controls browser-owned network blocking, per-site exceptions, custom rules, and 19 bundled default filter lists. Network matching uses Brave's adblock-rust; generic and procedural cosmetics reuse pinned uBlock Origin source.
- GhostPrint integration: optional browser-packaged fingerprint perturbation for Canvas, WebGL, WebGPU metadata, Audio, hardware concurrency, and Plugin/MIME surfaces, with global, per-site, and individual surface controls. Gecko's existing fingerprinting protections take precedence.
- Dedicated preferences and setup: configure themes, search engines, privacy toggles, and layout options through native `about:preferences` with the Argon settings shell, or during the first-run onboarding flow.
- Custom appearance: choose Light, Dark, or System Auto themes, with real-time adjustments for accent colors, UI density, and corner radius.

## Native protection status

The native blocker is **not yet a complete replacement for uBlock Origin**. The existing uBlock installation policy remains enabled; its controls and exceptions are independent of the native panel. Running both is not a transparent fallback: an extension cannot undo a request already cancelled by the native engine.

The native implementation includes offline default lists, conditional/include processing, atomic configuration updates, hostname-scoped site exceptions, and a subset of uBlock's generic/procedural cosmetics. Scriptlets, redirect resources, HTML/response filtering, full rule compatibility, custom URL subscriptions, migration, and advanced tools such as the picker and logger remain incomplete. See the [replacement checklist](./docs/native-adblock-parity.md) and [uBlock cosmetic integration](./docs/native-ublock-cosmetics.md).

GhostPrint is separate from adblock. If Gecko Resist Fingerprinting (RFP) or Fingerprinting Protection (FPP) applies, GhostPrint hooks are not layered on top; the panel reports the conflict without weakening Gecko settings. Changes require reloading the page. Its JavaScript hooks do not cover every realm or API and do not guarantee anonymity. See [GhostPrint integration and limitations](./docs/ghostprint.md).

The checked-in native engine targets Linux x86_64 GNU and has been exercised in an isolated packaged Argon runtime. Other platforms, older glibc compatibility, Flatpak compatibility for this new library, and a full source-built release containing these changes have not been validated.

## Installation

Argon distributes primarily as a Linux Flatpak package.

### Flatpak

You can install the Flatpak bundle directly:

```bash
flatpak install --user org.argon.browser.flatpak
flatpak run org.argon.browser
```

## Building from source

Argon compiles on Linux x86_64 using Mozilla's `mach` toolchain, applying LibreWolf's privacy patches and the Argon overlay onto a pinned source tree.

### System requirements

- Linux x86_64
- Python 3.10 or newer
- Node.js 22 or newer
- Git
- Rust/Cargo and the `wasm32-unknown-unknown` target when rebuilding the native adblock artifacts
- At least 8 GB of RAM and 40 GB of free disk space

### Build steps

```bash
npm run doctor      # Check toolchain, RAM, disk space, and application identity
npm run fetch       # Download and verify the pinned upstream source archive
npm run apply       # Apply LibreWolf patches and the Argon overlay
npm run bootstrap   # Install required toolchains via mach
npm run build       # Compile dist/bin/argon with the Argon identity
npm start           # Launch the built browser with a development profile
npm run flatpak     # Build the distributable Flatpak bundle
```

For frontend UI development (CSS, JavaScript, and HTML) without recompiling Gecko:

```bash
npm run dev         # Launch the development browser with automatic reload on save
```

To rebuild the browser-owned filter engine and reproduce the vendored cosmetic interpreter:

```bash
npm run build:adblock
python3 scripts/build-ublock-cosmetics.py
# Explicit maintainer action; downloads and refreshes the offline list snapshots:
npm run update:adblock
```

The native engine is built with the pinned Cargo dependency graph. Rebuild it in the intended release toolchain/sysroot rather than assuming the checked-in Linux library is portable. See [native adblock build and runtime notes](./docs/native-adblock.md).

## Testing

Argon maintains test suites for interface state, build tooling, extension analysis, and browser chrome geometry:

```bash
npm test            # Run unit tests, including adblock, GhostPrint, and cosmetic adapters
npm run test:python # Run python tests for build scripts, overlays, and branding assets
npm run test:dev    # Test the dev launcher watcher and synchronization logic
npm run test:adblock # Test filtering, list pipeline, cosmetics, and native ABI
npm run test:ghostprint # Run the adapter and pinned upstream GhostPrint tests
python3 tests/adblock/test_snapshot.py # Verify list-publication rollback
# Requires the browser-test venv and an isolated packaged Argon runtime:
npm run test:browser # Exercise actual chrome, adblock, cosmetics, and GhostPrint
npm run site        # Serve the companion website locally at http://127.0.0.1:4173
```

## Extension compatibility analyzer

Argon includes a command-line tool to inspect a Chrome extension's `manifest.json` before installation:

```bash
npm run analyze -- path/to/manifest.json
```

The analyzer runs static checks on permissions, host declarations, and background service worker requirements, outputting a clear compatibility report with any identified security considerations.

## Repository layout

- `argon/`: Argon frontend modules, including the native protection panel, filter lists, workspaces, the command palette, the extension bridge, preferences, and the onboarding flow.
- `native/adblock/`: Rust wrapper source and locked dependency graph for the native filter engine.
- `third_party/ghostprint/`: Pinned original GhostPrint source, license, and behavioral tests.
- `browser/`: Firefox and LibreWolf chrome modifications, themes, and branding assets.
- `config/`: Upstream source lock, mozconfig definitions, and the overlay map.
- `docs/`: Technical guides covering [branding](./docs/branding.md), [building](./docs/building.md), and the [extension bridge](./docs/extension-bridge.md).
- `packaging/`: Flatpak manifests, desktop files, and application metadata.
- `patches/`: Privacy and Linux integration patches from LibreWolf.
- `scripts/`: Build automation, dependency management, and test runners.
- `tests/`: Automated unit, integration, and browser smoke tests.
- `website/`: Landing page source and interactive extension analyzer studio.

## License and upstream credits

The repository's top-level license is [Mozilla Public License 2.0 (MPL 2.0)](./LICENSE). Individual files and vendored components retain their own licenses; the repository is not uniformly MPL-only.

- [Brave adblock-rust](https://github.com/brave/adblock-rust), MPL-2.0: native network-filter matching. Rust dependency notices are retained in [THIRD-PARTY-NOTICES.txt](./argon/adblock/THIRD-PARTY-NOTICES.txt).
- [uBlock Origin](https://github.com/gorhill/ublock), GPL-3.0-or-later: pinned parser and procedural interpreter sources, with original notices, [license](./argon/adblock/ublock/LICENSE.txt), and [provenance](./argon/adblock/ublock/provenance.json). CSS-tree retains its MIT license. Direct integration has combined-work and Corresponding Source implications; review the [distribution boundary](./docs/native-ublock-cosmetics.md#license-and-distribution-boundary) before publishing a binary release.
- [GhostPrint](https://github.com/gnustella-lab/GhostPrint), MIT: pinned fingerprint-perturbation code, with original [license](./third_party/ghostprint/LICENSE) and [adapter provenance](./argon/adblock/ghostprint/provenance.json).
- [Helium](https://github.com/imputnet/helium): inspiration for the first-run onboarding and the default filter-list selection. Filter content remains under each upstream list's terms.

The protection panel's layout is inspired by Brave Shields; Argon is not affiliated with Brave, uBlock Origin, or GhostPrint.

Firefox is a trademark of the Mozilla Foundation.
