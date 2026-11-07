# Argon Browser

Status: Phase 1, Foundation and prototyping (pre-alpha, Milestone 0.1 in progress)  
Base engine: [LibreWolf](https://librewolf.net/) / [Firefox (Gecko)](https://firefox-source-docs.mozilla.org/) · Target platform: Linux (Flatpak only)

Argon is an open-source desktop web browser forked from [LibreWolf](https://librewolf.net/) (built on [Firefox / Gecko](https://firefox-source-docs.mozilla.org/)). It builds from LibreWolf and Firefox source into its own product: its own binary, profile directory, vendor, and branding, installed and run alongside (never inside) an existing Firefox or LibreWolf installation, and distributed exclusively as a Linux Flatpak (`org.argon.browser`). It pairs a layout and workflow inspired by Arc and Zen Browser with LibreWolf's hardened privacy defaults, native Firefox WebExtensions support, and a compatibility bridge for Chromium extensions (Manifest V2 and V3).

## Current project status

The project is in Phase 1, actively building Milestone 0.1 (`Argon 0.1: Visual Foundation`).

| Area or deliverable | Current state | Target phase |
| :--- | :--- | :--- |
| Architecture and implementation plan | Completed ([`Argon Browser — Implementation Plan.md`](./Argon%20Browser%20%E2%80%94%20Implementation%20Plan.md)) | Phase 1 |
| Repository and version control setup | Initialized | Phase 1 |
| Design tokens and flat 48 px toolbar | Implemented and verified in real Firefox | Phase 1 (Milestone 0.1) |
| Light / Dark / System Auto theme switcher | Implemented and verified in real Firefox | Phase 1 (Milestone 0.1) |
| Adaptive horizontal and vertical tab strip | Implemented on Firefox's native sidebar tabs; verified in real Firefox | Phase 1 (Milestone 0.1) |
| Argon appearance controller and preferences | Implemented, unit and browser tested | Phase 1 (Milestone 0.1) |
| Argon branding package and icons | Implemented for the Linux target ([`docs/branding.md`](./docs/branding.md)) | Phase 1 (Milestone 0.1) |
| Official Argon Browser website (`website/`) | Implemented with live Extension Bridge studio, interactive chrome comparison, and brand kit hub (`npm run site`) | Phase 1 (Milestone 0.1) |
| Fork build tooling (pinned upstream, change set, Argon identity) | Implemented and offline tested; first full build pending a machine with enough RAM ([`docs/building.md`](./docs/building.md)) | Phase 1 (Milestone 0.1) |
| Independent application identity (`argon` binary, profile, remoting name, vendor) | Configured in [`config/mozconfig`](./config/mozconfig) and [`config/overlay.json`](./config/overlay.json); unverified until the first full build | Phase 1 (Milestone 0.1) |
| Manifest analyzer (Extension Bridge module 1) | Implemented with CLI ([`docs/extension-bridge.md`](./docs/extension-bridge.md)) | Phase 4 |
| 50-extension benchmark registry | Scaffolded; every entry `NOT_TESTED` | Phase 4 |
| Extension Bridge modules 2-5 | Not started | Phase 4 |
| Smart sidebar, command palette, and New Tab | Planned | Phase 2 |
| Workspaces, tab suspension, and `about:argon` | Planned | Phase 3 |
| Flatpak packaging and public beta | Planned | Phase 5 |

The Milestone 0.1 chrome is verified against a real Gecko 159 through
Marionette in an isolated temporary profile (`tests/browser/test_chrome.py`):
the 48 px flat toolbar, the three theme modes, and the tab layout switch work
in real browser chrome while Firefox's own tab element, session, and sidebar
implementation stay in charge. A compiled `argon` binary has not been produced
yet; see [`docs/building.md`](./docs/building.md) for what is and is not
verified.

## Core design and features

### Appearance

Argon uses a flat interface without 3D bevels or heavy drop shadows, built on a `4 px` and `8 px` spatial grid with `8 to 12 px` corner radii. The top toolbar is `48 px` tall. The design tokens are defined in [`argon/design-system/tokens.css`](./argon/design-system/tokens.css), including the `240 px` expanded and `52 px` collapsed sidebar widths and the `120 to 200 ms` motion scale that respects `prefers-reduced-motion`.

Milestone 0.1 exposes two of those controls at runtime, from the Argon toolbar button: the theme (`#F7F8FA` Light, `#15171B` Dark, or System Auto) and the tab layout. Adjustable accent colours, UI density, and corner radii are specified in the token layer but are not yet exposed in the interface.

### Usability and navigation

Tabs can switch between horizontal and vertical layouts at runtime. A vertical sidebar holds open tabs, pinned tabs, bookmarks, and workspace switchers in one dock, while a compact mode hides secondary chrome to give more room to web content. Workspaces isolate browsing sessions and pair with automatic tab unloading to save memory. Keyboard shortcuts follow Linux desktop conventions and remain user-configurable, including `Ctrl+L` for the unified address bar and `Ctrl+Shift+P` for the command palette.

### Extensions

Standard Firefox add-ons from Mozilla Add-ons (AMO) run natively. For Chromium packages, the Argon Extension Bridge provides a multi-stage pipeline: a static `manifest.json` analyzer that generates an English compatibility report before installation, a manifest and API shim adapter, a background runtime that bridges Manifest V3 service workers to Gecko's background page model, and a local CRX/ZIP package installer. All extensions run inside Gecko's existing WebExtensions sandbox and permission model.

## Architecture overview

Argon is a fork of LibreWolf (built on Firefox Desktop / Gecko), maintained as a reviewable patch set and overlay on top of a pinned upstream revision rather than a full copy of mozilla-central (see [`docs/building.md`](./docs/building.md)). Gecko handles rendering, SpiderMonkey runs JavaScript, Necko manages networking, WebRender handles GPU compositing, and NSS provides cryptography. Argon modifies the front-end layer (HTML, CSS, JavaScript, XUL, and Web Components) and the extension subsystem so that site permissions, password management, private browsing isolation, and screen-reader accessibility stay intact across upstream updates.

### Planned repository layout

```text
argon/
├── browser/                 # Modified Firefox Desktop components
│   ├── base/content/        # Main browser window (browser.xhtml) and navigation logic
│   ├── components/          # Core browser features and services
│   ├── themes/              # Platform theme integration and CSS overrides
│   └── branding/argon/      # Argon logos, wordmarks, and branding assets
│
├── argon/                   # Argon-exclusive modules (100% English codebase)
│   ├── design-system/       # CSS design tokens and reusable Web Components
│   ├── workspaces/          # Workspace isolation and session management
│   ├── commands/            # Command Palette UI and action registry
│   ├── extensions/          # Argon Extension Bridge (Analyzer, Adapter, Runtime)
│   ├── preferences/         # Custom Argon settings UI and preference handlers
│   └── onboarding/          # First-run welcome flow and profile migration
│
├── website/                 # Argon Browser landing page, live Extension Bridge studio, and brand hub
├── tests/                   # Argon-specific Mochitest, xpcshell, and Playwright suites
├── scripts/                 # Build automation, patching, and packaging scripts
└── .github/workflows/       # GitHub Actions CI/CD pipelines
```

## Development roadmap

The 28-week schedule below is estimated for a team of 3 to 4 developers working in parallel.

| Phase | Timeline | Deliverables | Target milestone |
| :--- | :--- | :--- | :--- |
| 1. Foundation and prototyping *(current)* | Weeks 1 to 4 | Visual identity and CSS design tokens, Git and build script setup, Argon built from Firefox source with its own identity and profile, initial flat toolbar. | Compilable Argon prototype (`v0.1`) |
| 2. Interface and navigation | Weeks 5 to 10 | Navigation toolbar, horizontal and vertical tab strip, smart sidebar, Light/Dark/Compact modes, New Tab page, command palette, keyboard and ARIA support. | Argon Alpha (functional UI) |
| 3. Productivity and settings | Weeks 11 to 15 | Isolated workspaces, persistent pinned tabs, automatic tab unloading, `about:argon` preferences UI, onboarding flow, browser data importer. | Complete core experience |
| 4. Extension compatibility | Weeks 16 to 23 | Native WebExtensions verification, Chrome `manifest.json` analyzer, Chromium API adapters, MV2/MV3 background runtime bridge, local CRX/ZIP importer, 50-extension test suite. | Experimental Extension Bridge |
| 5. Quality and distribution | Weeks 24 to 28 | Stability, performance, security, and regression testing; Linux Flatpak (`org.argon.browser`) packaged builds; GitHub Actions CI/CD and signed Flatpak updates. | Argon Public Beta |

## Building Argon

Argon compiles from a pinned Firefox revision with the Argon change set
applied. Full details, including the identity table and what is verified, are
in [`docs/building.md`](./docs/building.md).

```bash
npm run doctor      # toolchain, RAM, disk, and identity report; changes nothing
npm run fetch       # download and verify the pinned Firefox source
npm run apply       # apply the Argon change set (all-or-nothing, drift-checked)
npm run bootstrap   # let mach install clang, Rust, cbindgen, and node
npm run build       # full build: dist/bin/argon with the Argon identity
npm start           # launch the build with a development profile
npm run package     # distributable archive (argon-*.tar.xz)
npm run flatpak     # single-file Flatpak bundle (argon-*.flatpak / org.argon.browser)
```

The build workspace lives in `~/.cache/argon-build` (override with
`ARGON_WORKSPACE`). A full build needs about 40 GB of disk and, realistically,
8 GB of RAM or more; lower `--jobs` on smaller machines
(`python3 scripts/argon.py --jobs 1 build`) or build on a CI runner.

For CSS/JS/XHTML/FTL work, `npm run build:artifact` downloads Mozilla's
pre-built engine instead of compiling it. Those binaries keep Firefox's native
identity, so artifact builds are a development loop only and cannot be
packaged as Argon.

## Frontend development without compiling Gecko

Use a prebuilt, packaged Argon engine for the local UI loop:

```bash
npm run dev
```

The launcher uses `artifacts/layout-fix/argon/argon` when available, otherwise
the installed Linux Flatpak. To use an extracted GitHub Actions build instead:

```bash
npm run dev -- --binary /path/to/argon/argon
# Or set ARGON_DEV_BINARY to that binary.
```

Only Python's standard library is required. The engine is copied once into
`.cache/argon-dev/runtime`; its separate profile stays in
`.cache/argon-dev/profile`. The original installation and build workspace are
never modified. Changes to overlay-listed CSS/JavaScript modules, the window
hooks, preference defaults, and packaged branding assets are synchronized into
the private archive and restart the development browser automatically. Packaged
JavaScript replacement hooks with an explicit `resource` path are synchronized
too, including removal of the sponsored shortcuts setting. The launcher checks
those modules against the pinned upstream hashes and rejects drift or partial
patches rather than changing an incompatible engine. Startup caches are
invalidated so changed modules are actually loaded.

This is restart-on-save, not hot module replacement: unsaved page state may be
lost on restart. Closing the window or pressing Ctrl+C stops the loop. Invalid
or incomplete manifest saves leave the running browser unchanged. C++/Rust,
new native components, and unsupported preprocessing still require a build.
Existing user preference values in the development profile override defaults.

```bash
npm run dev -- --sync-only        # Synchronize without opening a window.
npm run dev -- --no-watch         # Synchronize and launch once.
npm run dev -- -- --headless      # Forward browser flags after --.
npm run test:dev                  # Offline sync, watcher and isolation tests.
```

These commands do not push commits, dispatch or cancel GitHub Actions, change
workflows, or alter an already-running CI build's pinned revision.

## Testing

Argon separates fast unit tests from tests that need a real browser.

```bash
# Unit tests (appearance state, extension analyzer, CLI, benchmark registry)
npm test

# Python suites (fork build tooling, branding package)
npm run test:python

# Analyze an extension manifest statically (exit code carries the verdict)
npm run analyze -- path/to/manifest.json

# Serve the Argon Browser website locally (http://127.0.0.1:4173)
npm run site

# Browser chrome smoke tests: loads the Argon modules into a real Gecko browser
# inside an isolated temporary profile and asserts on live chrome geometry.
python3 -m venv .cache/browser-venv
.cache/browser-venv/bin/python -m pip install -r tests/browser/requirements.txt
.cache/browser-venv/bin/python tests/browser/test_chrome.py

# Diagnostic side-by-side of a clean Firefox window versus an Argon one
.cache/browser-venv/bin/python tests/browser/diagnose.py
```

Set `ARGON_TEST_BINARY` to point the browser tests at a built Argon
(`~/.cache/argon-build/obj/dist/bin/argon`). Until the first full build exists
they default to the installed Firefox as a Gecko test host; either way they
never touch an existing profile.
Screenshots and the Firefox log land in `artifacts/chrome-smoke/` for review.

The browser tests assert real geometry rather than preferences alone, so they
catch the failure mode where a preference is set but nothing visibly changes.
They also verify that Firefox's native tab element survives a layout switch
instead of being cloned or replaced.

## Development standards and governance

All project artifacts, including documentation, source code, identifiers, comments, commit messages, pull requests, issue tracking, CI/CD configurations, and default UI strings, are written in English.

Argon keeps its own profile root (`MOZ_APP_PROFILE=argon`), remoting name, and vendor, so it never opens, locks, or migrates a Firefox profile in place and never hands URLs to a running Firefox. Argon builds do not set `MOZ_TELEMETRY_REPORTING` or `MOZILLA_OFFICIAL`, and the default preferences turn off Mozilla studies, Normandy experiments, and data submission; `argon.telemetry.enabled` (default `false`) is reserved for Argon's own telemetry, which does not exist yet. Extension code never runs in privileged parent processes.

Argon disables the upstream Nova UI refresh by default. The pinned Firefox revision ships `browser.nova.enabled`, `browser.newtabpage.activity-stream.nova.enabled`, and `browser.aboutaddons.novaThemesPickerEnabled` as `true`; Argon overrides all three to `false` in [`argon/preferences/argon-prefs.js`](./argon/preferences/argon-prefs.js). Nova rewrites the chrome and the New Tab page that Argon styles itself, so leaving it on would have two designs fighting over the same surfaces. The flags stay re-enableable from `about:config` for comparison, but no Argon build ships with Nova enabled.

Argon also disables New Tab widgets and recommended stories by default, and removes sponsored shortcuts from the New Tab page. The default preferences turn off the Widgets container, every built-in widget (including Weather and Nightly's market-gate bypass), and Recommended stories while leaving their toggles available in the New Tab customize panel and `about:preferences#home`. For sponsored shortcuts, the default preferences disable the user-facing switch, the Contile and unified ads (MARS) tile services, and the address bar's sponsored top sites; the New Tab settings module is patched so the "Sponsored shortcuts" control is not rendered and the "Support Firefox" toggle cannot turn it back on. The change set is in [`config/overlay.json`](./config/overlay.json) and the values are pinned by `tests/build`.

Repository code is currently covered by the root [`LICENSE`](./LICENSE). Upstream Firefox and Gecko components remain under the [Mozilla Public License 2.0 (MPL 2.0)](https://www.mozilla.org/en-US/MPL/2.0/), and distributed binaries follow the [Mozilla Trademark Distribution Policy](https://www.mozilla.org/en-US/foundation/trademarks/distribution-policy/) with independent Argon branding. Full specifications and the 12-point beta release checklist are in [`Argon Browser — Implementation Plan.md`](./Argon%20Browser%20%E2%80%94%20Implementation%20Plan.md).
