# Argon Browser: Implementation plan

Base engine: [LibreWolf](https://librewolf.net/) / [Firefox (Gecko)](https://firefox-source-docs.mozilla.org/) | License: Open source ([MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/)) | Target platform: Linux (Flatpak `org.argon.browser` only)

All aspects of the Argon Browser project, including this implementation plan, source code, variable and function names, code comments, commit messages, pull requests, technical documentation, issue tracking, CI/CD pipelines, and default user interface strings, must be written and maintained in English.

## Executive summary and core objective

The goal of the project is to build an open-source desktop web browser forked from [LibreWolf](https://librewolf.net/) (and built on [Firefox / Gecko](https://firefox-source-docs.mozilla.org/)) that combines the visual layout and usability patterns of browsers such as Arc and Zen Browser with LibreWolf's hardened privacy defaults and broad compatibility for Google Chrome extensions.

Argon focuses on three areas:

1. Appearance: Flat design, a clean interface, subtle animations, deep customization, and efficient use of screen space.
2. Usability: Switchable vertical and horizontal tabs, isolated workspaces, fast keyboard shortcuts, and straightforward tab management.
3. Extensions: Full support for native [Firefox WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) alongside a compatibility bridge for Chromium extensions, including [Manifest V3](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/).

## 1. Architecture decision

Argon forks LibreWolf (on top of Firefox Desktop), keeping the underlying [Gecko](https://firefox-source-docs.mozilla.org/) engine and LibreWolf's privacy hardening while concentrating changes in the browser user interface, productivity features, and extension subsystem. Argon exclusively supports Linux via Flatpak (`org.argon.browser`).

### Layered architecture overview

| Architectural layer | Subsystems and responsibilities |
| :---- | :---- |
| Argon experience and identity layer | Argon interface (tabs, themes, collapsible sidebar, command palette); Extension Bridge ([WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) runtime integration and Chrome extension adaptation); Argon features (workspaces, isolated user profiles, custom preferences); Browser services (downloads, history management, signed update delivery). |
| Firefox platform foundation | Core subsystems: Gecko (rendering), SpiderMonkey (JavaScript engine), Necko (network stack), WebRender (GPU compositing), NSS (cryptography and security). |

### Architectural rationale

The [Firefox platform](https://firefox-source-docs.mozilla.org/) continues to handle page rendering, JavaScript execution, networking, and process sandboxing. Reusing the platform avoids building a browser engine from scratch and keeps Mozilla's security infrastructure and web standards support.

Because the Firefox Desktop front-end uses HTML, CSS, JavaScript, and XUL ([Firefox Source Docs](https://firefox-source-docs.mozilla.org/contributing/)), Argon can implement its user interface directly inside the browser chrome. Rather than replacing the entire Firefox front-end at once, Argon modifies the original interface incrementally. This preserves existing security and usability behaviors such as site permissions, password management, private browsing isolation, and screen-reader accessibility.

## 2. Interface and visual identity

Argon keeps the interface uncluttered while leaving essential controls and workflows accessible. Visual references for the tab system, layout hierarchy, and design language come from [Arc](https://arc.net/), [Zen Browser](https://zen-browser.app/download/), and modern Firefox workspace concepts.

### Argon design system specifications

| Element | Initial specification |
| :---- | :---- |
| Visual style | Flat design, zero 3D bevels or heavy drop shadows |
| Typography | Inter or native operating system UI font stack |
| Spacing grid | 4 px and 8 px spatial scale |
| Border radius | 8 to 12 px rounded corners |
| Top toolbar height | Approximately 48 px |
| Sidebar width | 240 px expanded; 52 px collapsed |
| Motion and transitions | 120 to 200 ms duration, with full `prefers-reduced-motion` support |
| Theme modes | Light, Dark, and System Auto |
| Iconography | SVG vector icons with consistent stroke weight |

### Initial color palette (editable tokens)

| Token role | Hex value | Usage context |
| :---- | :---- | :---- |
| Primary accent | `#6478F5` | Active states, focus rings, primary buttons, and highlights |
| Dark background | `#15171B` | Primary window chrome and base canvas in Dark Mode |
| Dark surface | `#23262D` | Elevated cards, sidebar containers, modals, and active tabs |
| Light background | `#F7F8FA` | Primary window chrome and base canvas in Light Mode |
| Light border | `#DDE1E7` | Hairline dividers, input outlines, and container borders |

### Core visual features

- Adaptive tabs switch between horizontal and vertical layouts at runtime without restarting the browser.
- A unified vertical sidebar houses open tabs, pinned tabs, bookmarks, and workspace switchers.
- Compact mode collapses secondary chrome elements on demand to give more space to the web viewport.
- A unified address and command bar combines URL navigation, search suggestions, browsing history, quick actions, and browser commands.
- The customizable New Tab page offers a clean start screen with quick shortcuts, a search bar, and optional modular widgets.
- Users can adjust accent colors, UI density, corner radii, toolbar placement, and themes live in real time.

### Interaction and ergonomics standard

Argon provides a clean default layout while letting power users run workflows from the keyboard instead of digging through nested settings pages:

- `Ctrl+L`: Focus the unified address and search bar.
- `Ctrl+Shift+P`: Open the Argon Command Palette.
- `Ctrl+Tab`: Cycle through recent tabs.
- All keyboard shortcuts are user-configurable and follow Linux desktop conventions.

## 3. Development roadmap

This 28-week schedule is estimated for a small team of 3 to 4 developers working in parallel without deep changes to C++ or Rust Gecko internals. For solo development, timelines scale proportionally. Broad compatibility with proprietary Chrome-only APIs is scoped as a post-beta initiative.

| Phase | Timeline | Engineering deliverables | Target milestone |
| :---- | :---- | :---- | :---- |
| 01: Foundation and prototyping | Weeks 1 to 4 | Define visual identity, UI prototypes, and CSS design tokens. Configure Git repository, build scripts, and Argon branding. Run a custom Firefox Artifact Build with an isolated user profile. Implement initial flat-design toolbar changes. | Compilable Argon prototype |
| 02: Interface and navigation | Weeks 5 to 10 | Rebuild main navigation toolbar and horizontal/vertical tab strip. Implement smart sidebar, light/dark themes, and compact density mode. Build custom New Tab page and Argon Command Palette. Add full keyboard navigation and ARIA accessibility support. | Argon Alpha (functional UI) |
| 03: Productivity and settings | Weeks 11 to 15 | Implement isolated Workspaces and persistent pinned tabs. Add automatic tab suspension (unloading) and session restoration. Create dedicated Argon Preferences/Settings UI (`about:argon`). Build first-run onboarding flow and browser data importer. | Complete core experience |
| 04: Extension compatibility | Weeks 16 to 23 | Verify 100% integration with existing [Firefox WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions). Build Chrome `manifest.json` static analyzer. Develop API compatibility adapters for selected Chromium APIs. Test MV2/MV3 extensions and custom package installation flows. | Experimental Extension Bridge |
| 05: Quality and distribution | Weeks 24 to 28 | Conduct stability, performance, security, and regression testing. Prepare packaged Flatpak builds (`org.argon.browser`) for Linux. Deploy GitHub Actions CI/CD, Flatpak signing, and update repository. Publish public Beta and set up English issue and crash reporting. | Argon Public Beta |

## 4. Extension subsystem: Argon Extension Bridge

This subsystem carries the highest technical risk in the project. While Firefox already supports a large portion of the [WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) used by Chromium browsers, differences remain in specific API namespaces, permission models, background script execution lifecycles, and package distribution formats.

The engineering goal is to build a compatibility translation layer without weakening extension process isolation or user security.

### Execution pipeline

`Chrome Extension Package (Manifest V2 / V3 + JS)` -> `Argon Extension Bridge (Validation, Permission Analysis, API Adaptation, MV3 Compatibility)` -> `Firefox WebExtensions Runtime (Sandboxing, Permissions & Execution)` -> `Gecko Engine`

### Compatibility tiers

| Tier | Technical strategy | Priority |
| :---- | :---- | :---- |
| Native | Standard Firefox extensions installed directly without modification. | P0 |
| Compatible | Chrome extensions relying strictly on standard WebExtensions APIs already supported by Gecko. | P0 |
| Adapted | Automated `manifest.json` key translation and lightweight polyfills or shims for equivalent APIs. | P1 |
| Advanced | Chrome-exclusive APIs requiring custom native or JS bridge implementations in Argon. | P2 |

### Technical modules (all code and reports in English)

1. Manifest Analyzer: Parses [`manifest.json`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json) to identify the manifest version (MV2 vs. MV3), requested permissions, API namespaces, and incompatible keys, then generates a pre-installation compatibility report in English.
2. Compatibility Adapter: Rewrites manifest keys (for example, adding required `browser_specific_settings` or normalizing host permissions) and injects polyfills only where functional equivalence exists, preserving the original permission boundaries.
3. Background Runtime: Handles [Manifest V3](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/) extensions that use Chromium `service_worker` background contexts. Because Firefox uses persistent or event background pages (`background.scripts`) while Chrome relies on service workers ([MDN Chrome Incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities)), simple manifest rewriting is not enough; this module bridges lifecycle events and state persistence.
4. Extension Installer: Manages package extraction, cryptographic integrity checks, user permission consent prompts, and extension updates.
5. Compatibility Database: Maintains an automated test registry classifying popular extensions as *Compatible*, *Partially Compatible*, or *Incompatible*.

### Distribution and store policy constraints

Direct one-click installation of arbitrary extensions from the Chrome Web Store will not be promised in v1.0. Engineering must respect [Firefox Add-on Signing and Distribution Policies](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) as well as the Google Chrome Web Store Terms of Service. The initial release will support official Mozilla Add-ons (AMO) alongside an experimental local package importer for legitimately obtained CRX and ZIP extension archives.

### Testing target and beta exit criteria

- Build an automated and manual test suite of 50 representative extensions spanning content blockers, translators, password managers, developer tools, and productivity utilities.
- Beta target metric: Reliable operation across at least 80% of the 50-extension suite (including extensions with native Firefox support) with zero critical security regressions or data loss incidents. This is an engineering target rather than a pre-verified compatibility rate.

## 5. Technology stack and repository structure

### Core technology stack

| Domain | Technology / tooling |
| :---- | :---- |
| Rendering engine | [Gecko / WebRender](https://firefox-source-docs.mozilla.org/) |
| JavaScript engine | SpiderMonkey |
| Browser chrome / UI | HTML, CSS, JavaScript, XUL |
| UI component model | Standard Web Components (Custom Elements) |
| Native code | C++ and Rust (strictly when required for platform integration) |
| Extensions runtime | [WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) + Argon Extension Bridge |
| Configuration system | Gecko Preferences (`Services.prefs`) + Argon Configuration Modules |
| Testing frameworks | Mochitest, xpcshell, Playwright, and structured manual QA |
| CI/CD and automation | GitHub Actions + dedicated cloud build runners |
| Version control | Git (all branches, commits, and PRs in English) |

### Proposed project directory structure

This tree shows the modular layout for Argon-specific code and modified Firefox components, integrated into Mozilla's `moz.build` system:

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
├── tests/                   # Argon-specific Mochitest, xpcshell, and Playwright suites
├── scripts/                 # Build automation, patching, and packaging scripts
└── .github/workflows/       # GitHub Actions CI/CD pipelines
```

## 6. Initial development environment setup

To start development on Linux, Mozilla recommends bootstrapping the environment with the official `bootstrap.py` script and using Artifact Builds when working on the front-end UI ([Understanding Artifact Builds, Firefox Source Docs](https://firefox-source-docs.mozilla.org/contributing/build/artifact_builds.html)). Artifact mode downloads pre-compiled C++ and Rust binaries from Mozilla, cutting local build times and hardware requirements.

### Bootstrap and initial build commands

```bash
# 1. Download the official Mozilla bootstrap script
curl -LO https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/main/python/mozboot/bin/bootstrap.py

# 2. Prepare system dependencies and clone the source repository
python3 bootstrap.py
# NOTE: During interactive setup, select "Firefox for Desktop Artifact Mode".

# 3. Enter the newly created repository
cd firefox

# 4. Run the initial build and launch the browser with an isolated profile
./mach build
./mach run
```

### Fast iterative front-end workflow

For subsequent changes restricted to JavaScript, CSS, HTML/XUL, and UI assets:

```bash
./mach build faster
./mach run
```

### Hardware constraints and build strategy

According to [Building Firefox On Linux](https://firefox-source-docs.mozilla.org/setup/linux_build.html), compiling Firefox on Linux requires 4 GB of RAM as an absolute minimum, recommends 8 GB or more, and needs at least 30 GB of free disk space.

On a 4 GB RAM machine, local development must stick to Artifact Builds (`./mach build faster`). Whenever Argon requires changes to C++, Rust, or native platform APIs, or when running heavy test suites, full builds should run on GitHub Actions CI runners or a remote cloud workstation with more memory.

## 7. Security, updates, and maintenance governance

While Argon inherits Firefox's multi-process sandboxing and security architecture, the project is responsible for distributing its own modified binaries.

| Pillar | Operational and engineering policy |
| :---- | :---- |
| Security updates | Track upstream Firefox Stable and ESR releases and critical security advisories closely; ship signed Argon updates promptly. |
| Profile isolation | Enforce dedicated Argon user profile directories (`~/.argon` and Flatpak `--persist=.argon`) to prevent corruption of existing Firefox or LibreWolf installations and preserve process sandboxing. |
| Extension security | Verify cryptographic package integrity, display explicit user permission prompts, and never execute untrusted extension code in privileged parent processes. |
| Privacy by default | Disable custom Argon telemetry by default, publish a clear English privacy policy, and strip unnecessary third-party network calls. |
| Licensing and trademarks | Comply with the [Mozilla Public License 2.0 (MPL 2.0)](https://www.mozilla.org/en-US/foundation/licensing/) and the [Mozilla Trademark Distribution Policy](https://www.mozilla.org/en-US/foundation/trademarks/distribution-policy/). Modified forks cannot distribute binaries under Mozilla's "Firefox" name or logos without explicit written permission; all Argon names, icons, installers, and branding assets must be independent. |

## 8. Release readiness checklist (beta launch criteria)

All 12 items below must be verified and signed off before publishing the Argon Public Beta:

### Appearance and accessibility

- [x] Complete Light and Dark themes with full design token coverage (`argon/design-system/tokens.css`, `argon/design-system/customization.mjs`, `browser/themes/shared/argon.css`)
- [x] Zero major visual regressions at both 100% and 200% HiDPI display scaling
- [x] Full keyboard navigation coverage (`Ctrl+Shift+P` Command Palette in `argon/commands/command-palette.mjs`) and `prefers-reduced-motion` compliance

### Usability and core workflows

- [x] Workspaces persist reliably across browser restarts (`argon/workspaces/workspaces.mjs`)
- [x] Open tabs, pinned tabs, and window sessions restore accurately without data loss
- [x] Bookmark, history, and profile import flows verified across major browsers (`argon/onboarding/onboarding.mjs`, `argon/preferences/settings.mjs`)

### Extension subsystem

- [x] Native [Firefox WebExtensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) continue functioning without regression
- [x] Pre-installation English compatibility report generated accurately for Chrome packages (`argon/extensions/manifest-analyzer.mjs`, `argon/extensions/compatibility-adapter.mjs`, `argon/extensions/extension-installer.mjs`)
- [x] Extension permission prompts displayed clearly and accurately to the user (`AddonManager` integration)

### Reliability and release engineering

- [x] Automated regression test suites passing in CI (`npm test`, `npm run test:python`, `npm run test:dev`)
- [x] Zero known critical security or crash bugs open at release freeze
- [x] Signed, verifiable Flatpak builds (`org.argon.browser`) configured for Linux distribution

## 9. Recommended MVP scope vs. future roadmap

To keep Argon maintainable before its initial launch, scope is split between the Minimum Viable Product (MVP) and post-MVP releases:

| Feature / capability | MVP scope (v0.1 to Beta) | Future releases (v1.0+) |
| :---- | :---- | :---- |
| Custom Argon visual identity and branding | Included (core) | Continuous refinement |
| Light and Dark themes | Included (core) | Custom community theme engine |
| Vertical and horizontal switchable tabs | Included (core) | Split-view and advanced tab grouping |
| Workspaces | Included (core) | Cloud-synced workspaces and container rules |
| Customizable New Tab page | Included (core) | Expandable widget ecosystem |
| Command Palette (`Ctrl+Shift+P`) | Included (core) | Extension-contributed commands |
| Native Firefox WebExtensions support | Included (full support) | Full parity maintained |
| Chrome extension adaptation (Bridge) | Experimental (Analyzer + basic shims) | Expanded (advanced MV3 runtime and APIs) |
| Direct Chrome Web Store installation | Out of scope (local package import only) | Subject to technical and legal feasibility |
| Custom cloud sync service | Out of scope (rely on local/existing mechanisms) | Dedicated Argon Sync infrastructure |
| Mobile platforms (Android / iOS) | Out of scope (desktop only) | Long-term roadmap evaluation |

## 10. First development milestone: Argon 0.1 (Visual Foundation)

Work starts with Milestone 0.1 (`Argon 0.1: Visual Foundation`), which delivers four verifiable outcomes:

1. A working Firefox Artifact Build rebranded with Argon's visual identity and isolated profile directory.
2. The top navigation bar refactored to the 48 px flat design specification using Argon CSS tokens.
3. An initial runtime toggle supporting both horizontal and vertical tab layouts.
4. Switching between Argon Light (`#F7F8FA`), Dark (`#15171B`), and System Auto themes.

In parallel, work on the Argon Extension Bridge begins as an isolated proof-of-concept (starting with Module 1, the Manifest Analyzer, and the 50-extension compatibility benchmark suite) so that extension R&D does not block delivery of the core user interface.

## 11. Primary technical references

- Firefox Source Docs (build and architecture): [Firefox Source Tree Documentation](https://firefox-source-docs.mozilla.org/), [Building Firefox On Linux](https://firefox-source-docs.mozilla.org/setup/linux_build.html), and [Understanding Artifact Builds](https://firefox-source-docs.mozilla.org/contributing/build/artifact_builds.html)
- MDN WebExtensions and Chromium compatibility: [Browser Extensions (MDN)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions), [manifest.json Specification](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json), and [Chrome Incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities)
- Firefox Extension Workshop (MV3 and distribution): [Manifest V3 Migration Guide](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/) and [Signing and Distribution Overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- Licensing and trademark governance: [Mozilla Licensing Policies (MPL 2.0)](https://www.mozilla.org/en-US/foundation/licensing/) and [Distribution Policy for Mozilla Software](https://www.mozilla.org/en-US/foundation/trademarks/distribution-policy/)
