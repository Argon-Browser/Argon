# Argon Browser

Argon is an open source desktop web browser for Linux built on LibreWolf and Mozilla's Gecko engine. It pairs vertical tabs and workspaces with hardened privacy defaults and a compatibility bridge for Chromium extensions.

Argon runs as an independent application with its own binary (`argon`), dedicated profile directory, and Flatpak package (`org.argon.browser`). It operates alongside existing Firefox or LibreWolf installations without sharing cookies, history, or active sessions.

## What Argon includes

- Switchable tab layouts: switch between standard horizontal tabs and a collapsible vertical sidebar at runtime without restarting the browser.
- Workspaces: organize tabs into distinct contexts with separate active tabs. Pinned tabs remain accessible across every workspace.
- Command palette: open a keyboard launcher with Ctrl+Shift+P to search open tabs, run browser commands, switch workspaces, and filter bookmarks.
- Extension compatibility: install add-ons from addons.mozilla.org directly, or run Chromium extensions through the built-in Extension Bridge, which converts manifests, handles Chrome API namespaces, and bridges Manifest V3 service workers to Gecko's background page architecture.
- Privacy defaults: telemetry reporting, Mozilla studies, Normandy experiments, and sponsored New Tab tiles are removed or disabled by default. Argon also includes tracker-blocking filter rules based on uBlock Origin.
- Dedicated preferences and setup: configure themes, search engines, privacy toggles, and layout options from a custom settings page at `about:argon` or during the first-run onboarding flow.
- Custom appearance: choose Light, Dark, or System Auto themes, with real-time adjustments for accent colors, UI density, and corner radius.

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

## Testing

Argon maintains test suites for interface state, build tooling, extension analysis, and browser chrome geometry:

```bash
npm test            # Run unit tests for appearance, commands, extensions, and workspaces
npm run test:python # Run python tests for build scripts, overlays, and branding assets
npm run test:dev    # Test the dev launcher watcher and synchronization logic
npm run site        # Serve the companion website locally at http://127.0.0.1:4173
```

## Extension compatibility analyzer

Argon includes a command-line tool to inspect a Chrome extension's `manifest.json` before installation:

```bash
npm run analyze -- path/to/manifest.json
```

The analyzer runs static checks on permissions, host declarations, and background service worker requirements, outputting a clear compatibility report with any identified security considerations.

## Repository layout

- `argon/`: Argon frontend modules, including workspaces, the command palette, the extension bridge, preferences, and the onboarding flow.
- `browser/`: Firefox and LibreWolf chrome modifications, themes, and branding assets.
- `config/`: Upstream source lock, mozconfig definitions, and the overlay map.
- `docs/`: Technical guides covering [branding](./docs/branding.md), [building](./docs/building.md), and the [extension bridge](./docs/extension-bridge.md).
- `packaging/`: Flatpak manifests, desktop files, and application metadata.
- `patches/`: Privacy and Linux integration patches from LibreWolf.
- `scripts/`: Build automation, dependency management, and test runners.
- `tests/`: Automated unit, integration, and browser smoke tests.
- `website/`: Landing page source and interactive extension analyzer studio.

## License and upstream credits

Argon Browser source code is licensed under the [Mozilla Public License 2.0 (MPL 2.0)](./LICENSE). Upstream Firefox and LibreWolf components remain under their respective MPL 2.0 and open source licenses.

The first-run onboarding flow is inspired by [Helium](https://github.com/imputnet/helium), and the default uBlock Origin filter rules are sourced from Helium.

Firefox is a trademark of the Mozilla Foundation.
