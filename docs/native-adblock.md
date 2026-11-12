# Browser-owned Rust ad blocking (Linux integration)

## Status — not yet a complete uBlock replacement

The browser now runs **Brave adblock-rust 0.13.5**, not a JavaScript approximation,
through a small Rust C ABI and Gecko js-ctypes. Network cancellation and domain
CSS hiding have been exercised in the private packaged Argon/Gecko runtime.
`argon.adblock.enabled` defaults to true. The existing uBlock enterprise policy
is deliberately retained: this implementation does **not** yet reproduce all of
uBlock's behavior. Do not remove the fallback until the missing features below
are implemented and validated.

The checked-in native library targets **x86_64 Linux GNU** and was built on this
machine. Rebuild it in the release target's toolchain/sysroot; ABI compatibility
with older glibc distributions, Flatpak and other CPU architectures is not
asserted. Windows/macOS support is not implemented. On native-load failure the
observer releases suspended requests and reports an error, leaving uBlock as the
fallback. No installed application or existing user profile is modified by tests.

## Runtime

- Classic browser window hook registers a process-global observer before that
  window's tabs start loading; repeated windows reuse the same singleton.
- Content HTTP(S) requests arriving while initial lists load are suspended and
  resumed once. Internal system-principal fetches are excluded.
- Matching uses the real Rust engine with source URL, resource type and HTTP
  method, including its exception/important-rule precedence and URL rewriting.
- A Fission window actor requests parent-selected generic/hostname CSS and a
  source-reused uBO procedural subset; URL is derived from its WindowGlobal, not
  supplied by web content. Filters are data, never JavaScript source. The packaged
  interpreter runs only in the actual content realm: see [scope, security and
  GPL distribution obligations](native-ublock-cosmetics.md).
- The native library is fetched only from packaged chrome, copied to a unique
  profile filename for dlopen and immediately unlinked. It has no network API.
- Portable `engine.wasm` and its JS wrapper are also built and tested in Node.
  **They are not the browser backend**: Firefox 162 prohibits WASM/eval in the
  parent process regardless of sandbox principal. CSP and security preferences
  have not been weakened to work around that restriction.

## Lists and updates

`argon/adblock/lists.json` records source URL, title, retrieval time, SHA-256 and
original update interval for all **19** catalog filter entries without `off:true`.
The shipped text in `argon/adblock/lists/` is **resolved for Argon**, not the raw
upstream text: first-run blocking needs no network download. Upstream
copyright/license comments are retained in selected branches and include source
boundaries are annotated. Each entry records the URL, UTF-8 text byte count and
SHA-256 of every fetched source (root and active includes), plus the digest of
its final resolved text. Hashes describe decoded UTF-8 text, not HTTP wire bytes.

The maintainer command and runtime updater share `updater.mjs`; Python invokes
the Node CLI rather than maintaining a second conditional parser. Nested
`!#if`/`!#else`/`!#endif`, parentheses, `!`, `&&` and `||` are parsed as data,
never evaluated as JavaScript. Unknown capability names (even in inactive
branches), malformed structure and unknown directives reject the generation.
Safari content-blocker affinity hints are explicitly ignored on Gecko.

Capability policy: `env_firefox=true`; `env_chromium`, `env_mobile`, `env_safari`,
`env_mv3`, `ext_ubol`, `ext_ublock`, `adguard`, `cap_html_filtering` and
`cap_ipaddress` are false. Argon is neither uBO nor AdGuard; being able to parse
some of their rules does not justify asserting their identity. The bridge has
neither HTML filtering nor resolved-IP matching. This conservative selection
may omit identity-gated rules; it is **not** uBO parity.

Active `!#include` paths must be relative safe path segments beneath the
including URL's directory, on the same HTTPS origin. Absolute URLs, traversal,
percent escapes, credentials, fragments and redirects are rejected. Limits:
8 include edges, 64 fetched files and 32 MiB source text per root, 16 MiB per
response/final list, 64 nested conditionals, 256 expression tokens and a
120-second abort signal per root expansion. Included files are independently
balanced; cycles fail. Inactive includes are not fetched. No filter code runs.

Cache generations carry pipeline version, resolved hashes and source provenance;
legacy raw caches and corrupt/mismatched generations fall back to the validated
offline snapshot. All downloads and native compilation finish before the single
atomic profile-cache replacement and engine swap. Rejected native handles are
closed, leaving the previous engine active. Maintainer checkout snapshots stage
all files before publication and roll back ordinary write failures; publication
of the multiple source files is **not power-loss atomic**. Do not package/sync
concurrently with that command; manifest digests detect interrupted publication.

Both `extensions.update.enabled` and `extensions.update.autoUpdateDefault` must
be true for downloads. This reuses the existing onboarding/settings consent.
The updater checks hourly, attempts a complete generation at most daily after a
successful update, requires HTTPS, omits credentials, bounds list size and times
out requests. It retains the previous engine on failure and atomically writes a
complete cache generation. Individual catalog intervals are recorded but not yet
used for per-list scheduling. Opt-out prevents subsequent downloads and commits;
it does not cancel a request already in flight.

## Native toolbar and configuration

The shield replaces the old Appearance menu. Appearance, workspace switching,
onboarding and the command palette remain in settings / Ctrl+Shift+P (workspace
shortcuts remain intact). The native panel provides:

- A global native switch and a persisted **exact-hostname** exception, derived
  from the top-level page for both requests and child-frame cosmetics. A reload
  applies cosmetic changes. The exception covers all ports/schemes of that host,
  not sibling/subdomains. Non-HTTP(S) tabs cannot create exceptions.
- A multiline custom-filter editor: add or delete rules, then save. Unsupported
  Rust filter syntax may be ignored; saving is not a claim of uBO dialect parity.
- Individual switches for the 19 shipped lists. Update consent still follows
  extension-update settings; enabling a list immediately uses its offline copy.
- Native HTML controls with labels, initial focus, Tab/Shift+Tab containment,
  Escape dismissal, an announced error area and native status.

The panel visibly says these switches do **not** disable the uBlock fallback.
There are no fabricated counts, request logs, or claims of total replacement.
Custom HTTPS subscriptions and configuration import/export are not implemented.

`argon-adblock-config.json` in the profile stores custom filters, disabled list
IDs and hostname exceptions, never browsing history. Private-window site
exceptions stay in memory and clear when the last private context closes. A
private window inherits normal exceptions until explicitly overridden.
Configuration edits and downloaded-generation commits share a serialized queue;
stale filter-editor saves are rejected rather than overwriting another window.
Replacement engines are compiled before the atomic config write/swap. Errors
leave the previous engine active; retired/rejected native handles are closed.
Compilation still occurs on the main thread and may briefly pause the browser.

## Delivered native parity & off-main-thread architecture

- **Early Scriptlets & Redirect Resources (`child.sys.mjs`, `redirect-resources.json`)**:
  `DOMWindowCreated` resolves exact `WindowGlobalParent` context (`innerWindowId`)
  for top-level, cross-origin, `about:blank`, and `about:srcdoc` frames before
  inline scripts execute. Pinned redirect resources include tracker/analytics
  shims, 1x1 transparent pixels, `requiresTrust` gating, consent CMP no-ops
  (`__tcfapi`, `__uspapi`, `OneTrust`, `Cookiebot`, `Didomi`), and MIME-validated
  `$redirect` / `$redirect-rule` responses with exact-origin CORS.
- **Cosmetic & Procedural Engine (`procedural.js`, `ublock-cosmetic.mjs`)**:
  Supports `:has()`, `:has-text()`, `:matches-css()`, `:watch-attr()`, `:shadow()`
  (open and closed Shadow DOM), `:xpath()`, `:upward()`, and `:nth-ancestor()`.
  Collapsed user-sheet CSS is injected at `DOMWindowCreated` before first paint
  (eliminating CLS), and procedural evaluations enforce an 8 ms per-frame time
  budget across `requestAnimationFrame` slices.
- **Query Sanitization, Workers, WebSockets & CNAME Uncloaking**:
  Built-in `$removeparam` rules (`argon.adblock.removeparam.builtin`) strip
  `fbclid`, `gclid`, `utm_*`, `mc_eid`, and related tracking parameters through
  `UnifiedPolicy.decide()`. DedicatedWorker, SharedWorker, ServiceWorker, cached
  subresources, and WebSocket (`ws:`/`wss:` and `Upgrade: websocket`) channels
  route through the same pipeline with non-first-party `NullPrincipal` handling
  and TTL-cached, bounded-timeout DNS CNAME uncloaking.
- **Off-Main-Thread Compilation & Atomic Generations (`compile-worker.mjs`)**:
  Cosmetic, scriptlet, response-header, and network filter compilation runs on a
  dedicated background Worker thread (`OffMainThreadCompiler`), and every engine
  replacement commits atomically through `UnifiedPolicy.applyGeneration()`.
- **Shield Panel Native Tools (`panel.mjs`, `picker.mjs`, `logger.mjs`)**:
  Interactive Element Picker (with `ArrowUp`/`ArrowDown` ancestor traversal and
  live selector badge), multi-target Element Zapper (`Shift+Click`), searchable
  real-time Live Request Logger, response-stage `allowed -> blocked` counter
  reconciliation, and zero-IPC per-tab toolbar badge updates.

## Reproduce

Rust stable and `wasm32-unknown-unknown` target are required for rebuilding:

```sh
npm run build:adblock        # cargo --locked; emits build.json provenance
npm run update:adblock       # explicit maintainer network snapshot of all 19 lists
npm run test:adblock
python3 tests/adblock/test_snapshot.py  # maintainer publication rollback
npm test
npm run test:python
npm run test:dev
python3 scripts/dev-browser.py --sync-only
# In a venv with tests/browser/requirements.txt:
npm run test:browser:adblock
ARGON_TEST_BINARY="$PWD/.cache/argon-dev/runtime/argon" npm run test:browser
```

The real-browser test uses the synchronized private packaged Argon, not injected
service code. It enters and saves deterministic rules through the real panel,
checks local HTTP request cancellation and rendered CSS, then verifies top-level
site bypass also allows cross-host iframe requests and cosmetics. It exercises
global/list controls, add/remove persistence, keyboard Tab/Escape and announced
errors, concurrent edits, private exception non-persistence and failed-write
rollback. Pointer actions are used for native popup widgets because WebDriver
ElementClick's document hit-testing excludes those widgets. This is not a claim
of real-site or complete-list compatibility.

Rust engine license: MPL-2.0, upstream https://github.com/brave/adblock-rust.
The wrapper is MPL-2.0. `native/adblock/Cargo.lock` pins the dependency graph.
Filter lists remain under their upstream licenses, not the wrapper's license.
