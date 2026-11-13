# Building Argon

Status: fork tooling, full Linux `x86_64` source compilation (`dist/bin/argon`),
Marionette chrome smoke tests on the compiled binary, and `.flatpak`
packaging are implemented and verified.

Argon is a fork of LibreWolf (built on Firefox Desktop / Gecko). It does not restyle an installed Firefox or LibreWolf:
it takes a pinned upstream source revision, applies the LibreWolf patch series and Argon's overlay to it,
and compiles a separate browser with its own binary, profile directory,
remoting name, vendor, and branding. A running Firefox, LibreWolf, and Argon do
not share profiles, windows, or URL hand-off.

Argon exclusively supports **Linux via Flatpak** (`io.github.argon_browser.Argon`). Windows and macOS are not supported.

## How the fork is organised

Argon combines LibreWolf's patch series (`patches/`, `settings/`, `l10n/`, `scripts/librewolf-patches.py`) with Argon's drift-checked overlay (`config/overlay.json`, `scripts/argon.py`):

| Piece | File | Role |
| :-- | :-- | :-- |
| Upstream pin | `config/firefox.lock.json`, `version` | Exact upstream revision, archive SHA-256, artifact task, and the SHA-256 of every upstream file Argon patches |
| LibreWolf patch series | `assets/patches.txt`, `patches/`, `settings/`, `l10n/` | Hardened privacy defaults, Linux XDG/D-Bus integration, and UI cleanups |
| Argon overlay | `config/overlay.json` | Every file Argon adds and every upstream file it patches, as data |
| Identity | `config/mozconfig`, `assets/mozconfig` | Build options that make the product Argon |
| Tools | `scripts/argon.py`, `scripts/librewolf-patches.py` | fetch, apply, bootstrap, build, run, package, flatpak |
| Argon sources | `browser/`, `argon/`, `packaging/flatpak/` | Chrome, branding, preferences, Argon modules, and Flatpak packaging |

Updating to a newer Firefox means changing the lock, re-running `apply`, and
fixing whatever hooks report drift. That keeps the diff against upstream small
and reviewable.

## Application identity

| What | Value | Where it is set |
| :-- | :-- | :-- |
| Binary | `argon` (`dist/bin/argon`) | `--with-app-name=argon` |
| application.ini Name | `Argon` | `--with-app-basename=Argon` |
| Display name, icons, brand strings | Argon | `--with-branding=browser/branding/argon` |
| Profile directory | `argon` (own profile root, never Firefox's) | overlay hook on `browser/moz.configure` |
| Remoting name, WM_CLASS | `argon` | `MOZ_APP_REMOTINGNAME=argon` |
| Vendor | `Argon` | overlay hook on `browser/moz.configure` |
| Distribution id | `io.github.argon_browser.Argon` | `--with-distribution-id` |
| Updater, crash reporter | disabled | no Argon update or crash server exists yet |

Two values intentionally stay upstream:

- **`MOZ_APP_ID`** stays Firefox's id. WebExtensions on addons.mozilla.org
  declare compatibility against it; keeping it is what lets Argon install AMO
  add-ons natively.
- **The User-Agent** keeps Firefox's product token (`MOZ_APP_UA_NAME` is
  empty), so sites that sniff the UA do not treat Argon as an unknown browser.

`MOZ_APP_VENDOR` and `MOZ_APP_PROFILE` are patched in `browser/moz.configure`
instead of `config/mozconfig` because `toolkit/moz.configure` declares both
with `project_flag()`, which restricts `possible_origins` to `("implied",)`;
setting them from the environment or mozconfig would make configure fail.

## Commands

```bash
# Toolchain, RAM, disk, and identity report. Changes nothing.
python3 scripts/argon.py doctor

# Download the pinned archive, verify its SHA-256, extract it to the workspace.
python3 scripts/argon.py fetch

# Apply the Argon change set. All-or-nothing: every hook is checked for
# upstream drift before any file is written.
python3 scripts/argon.py apply

# Let mach install clang, rustc, cbindgen, and node into ~/.mozbuild.
python3 scripts/argon.py bootstrap

# Full source build with the Argon identity (two jobs by default).
python3 scripts/argon.py --jobs 2 build

# Launch dist/bin/argon with a development profile kept in the workspace.
python3 scripts/argon.py run

# Produce the distributable archive (refuses artifact builds).
python3 scripts/argon.py package

# Package the built archive into a single-file Flatpak bundle (io.github.argon_browser.Argon).
python3 scripts/argon.py flatpak

# Package a synchronized runtime directory directly into a .flatpak bundle.
python3 scripts/argon.py flatpak --runtime .cache/argon-dev/runtime --output .cache/dist/argon-0.1.0.en-US.linux-x86_64.flatpak

# Optional GPG signing (or set ARGON_GPG_SIGN / ARGON_GPG_HOMEDIR):
python3 scripts/argon.py flatpak --gpg-sign <KEY_ID>

# Validate Flatpak desktop/AppStream metadata and verify the bundle in an isolated FLATPAK_USER_DIR.
python3 scripts/argon.py verify-flatpak --require-full-omni --bundle .cache/dist/argon-0.1.0.en-US.linux-x86_64.flatpak
```

The same commands are available as `npm run doctor|fetch|apply|bootstrap|build|start|package|flatpak|verify:flatpak`.

The workspace defaults to `~/.cache/argon-build` (or `$XDG_CACHE_HOME/argon-build`);
override it with `ARGON_WORKSPACE` or `--workspace`. It must be an ASCII path
without spaces, which is also why it lives outside this repository. The tool
refuses the filesystem root, the home directory, the repository, a repository
ancestor, and paths with shell metacharacters.

### Front-end loop: `--artifact`

```bash
python3 scripts/argon.py --artifact build
```

Artifact builds download Mozilla's pre-built C++ and Rust components, so CSS,
JavaScript, XHTML, and FTL changes need no compiler. The downloaded binaries
carry Firefox's native identity (`dist/bin/firefox`, Firefox's profile root
and remoting name), so an artifact build is only a development loop, never an
Argon release. `package` refuses to package one.

Artifact resolution also needs an hg or git checkout to map the tree to a
Mozilla task (`ValueError: Must provide path to exactly one of hg and git`),
and git artifact builds need a **git-cinnabar** clone. The GitHub tarball that
`fetch` downloads has no VCS metadata; `doctor --artifact` reports this.

## The change set

| Target | Change |
| :-- | :-- |
| `browser/base/content/argon/` | `config/overlay.json` (207 files across core UI, appearance, workspaces, shortcuts, newtab, onboarding, settings, MV3 bridge, uBlock adblock, GhostPrint, bundled lists, and 45 locales) |
| `browser/base/jar.mn` | `content/browser/argon/*` entries matching every overlay file (checked by `tests/build/test_overlay.py`) |
| `browser/base/content/browser.xhtml` | `#include argon-window-hooks.inc.xhtml` after `browser-main.js` |
| `browser/app/profile/firefox.js` | `argon.*` defaults; Mozilla studies, Normandy, and data submission off by default; New Tab widgets and recommended stories off by default; sponsored shortcut services and their New Tab switch off |
| `browser/extensions/newtab/lib/AboutPreferences.sys.mjs` | Sponsored shortcuts setting hidden and removed from the New Tab settings pane; the "Support Firefox" toggle no longer writes it |
| `browser/moz.configure` | `MOZ_APP_VENDOR` (`Argon`) and `MOZ_APP_PROFILE` (`argon`) implied |
| `browser/branding/argon/` | branding package added |
| `settings/`, `packaging/flatpak/` | canonical `policies.json`, `librewolf.cfg`, `local-settings.js`, desktop entry, AppStream metainfo, and Flatpak bundle packaging |

Every insertion is wrapped in `BEGIN Argon overlay` / `END Argon overlay`
markers; a replaced line keeps the upstream original as a comment. Re-running
`apply` replaces the blocks instead of stacking duplicates.

Security behaviour stays upstream: add-on signing, sandboxing, Safe Browsing,
and the self-XSS paste guard are not relaxed, and `tests/build` fails if the
prefs or the mozconfig try to.

## Verified versus unverified

**Verified:**

- `fetch` against the real pinned archive: the SHA-256 matched the lock.
- `apply` against the real upstream hook files (`config/source-reference/`
  holds byte-identical copies, checked against the lock). The patched
  `browser/moz.configure` still parses as Python and carries exactly one
  `MOZ_APP_VENDOR` implication.
- Every option in `config/mozconfig` was checked against the `moz.configure`
  files of the pinned revision.
- End-to-end runtime verification on the compiled `162.0a1` Argon binary
  (`Name=Argon`, `Vendor=Argon`, `Profile=argon`, `RemotingName=argon`),
  Marionette browser regression suites, overlay parity checks, `SHA256SUMS`
  generation, and isolated Flatpak bundle deployment verification
  (`verify-flatpak --require-full-omni`, `desktop-file-validate`,
  `appstreamcli validate --no-net --strict`).
- Offline tests for idempotency, drift detection, all-or-nothing apply, the
  generated mozconfig in both modes, `run`, `package`, `flatpak`, and
  `verify-flatpak`.

**Pending external infrastructure:**

- **Signing keys & hosted Flatpak remote.** Unsigned `.flatpak` single-file
  bundles with `SHA256SUMS` work out of the box; passing `--gpg-sign` /
  `ARGON_GPG_SIGN` signs OSTree commits and bundles once release GPG keys are
  provisioned on CI or a release host.

## GitHub Actions full build

`.github/workflows/build.yml` runs the end-to-end Linux x86_64 source build on
GitHub Actions (`push` to `main`/`v*` tags or `workflow_dispatch`):

1. Frees ~55 GB of pre-installed runner bloat and provisions an 8 GB swapfile
   so Rust LTO and `libxul.so` linking do not run out of disk or memory.
2. Runs contract and metadata checks (`npm test`, `npm run test:python`,
   `npm run test:dev`, `node scripts/adblock-policy.mjs verify`,
   `desktop-file-validate`, and `appstreamcli validate --no-net --strict`).
3. Restores/saves cached Mozilla toolchains (`~/.mozbuild`), Rust (`~/.cargo`,
   `~/.rustup`), and the verified upstream tarball.
4. Runs `fetch`, `apply`, `bootstrap`, and `build` (`dist/bin/argon`).
5. Verifies `dist/bin/application.ini` (`Name=Argon`, `Vendor=Argon`,
   `Profile=argon`, `RemotingName=argon`) and `dist/bin/argon --version`.
6. Runs the Marionette regression suite (`test_chrome`, `test_adblock`,
   `test_ublock_cosmetic`, `test_ghostprint`, `test_workspaces`,
   `test_customization`, `test_onboarding`, `test_settings`, `test_i18n`) with
   `ARGON_TEST_BINARY` pointed at the newly compiled `dist/bin/argon`.
7. Runs `package` (`./mach package`), `flatpak` (`python3 scripts/argon.py flatpak`),
   and `verify-flatpak --require-full-omni`, checks `sha256sum -c SHA256SUMS`,
   uploads `argon-*.flatpak`, `SHA256SUMS`, `application.ini`, and screenshots as
   `argon-flatpak-x86_64`, and publishes a GitHub Release (marked prerelease for
   `alpha`/`beta`/`rc` tags) on `v*` tags.

## Installing the Flatpak bundle

```bash
sha256sum -c SHA256SUMS
flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y argon-0.1.0.en-US.linux-x86_64.flatpak
flatpak run io.github.argon_browser.Argon
```

## Requirements

From Mozilla's Linux build documentation: 4 GB RAM minimum, 8 GB or more
recommended, and at least 30 GB of free disk space (an optimised objdir plus
the source tree is closer to 40 GB). Any change to C++, Rust, or native
platform APIs requires a full build.

## Tests

```bash
python3 -m unittest discover -s tests/build -v
```

The overlay contract checks transitive relative module imports, not just the
resources linked directly from `browser.xhtml`. On the installed Firefox test
host, the chrome smoke suite stages exactly those manifest files and loads the
window's real stylesheet and module hooks. With `ARGON_TEST_BINARY` set, it
injects nothing: the built browser must initialize its own appearance controls.
The rendered tab label/background and New Tab color scheme are checked in
addition to toolbar geometry. Theme selection also sets Gecko's native web
appearance preference; System restores automatic OS matching.

Set `ARGON_TEST_ARTIFACTS` to keep screenshots and logs from different test
binaries in separate directories.
