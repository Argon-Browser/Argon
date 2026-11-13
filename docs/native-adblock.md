# Browser-owned native ad blocking

## Status — uBlock Origin core integrated, bounded scope documented

Argon runs the pinned **uBlock Origin filtering core**
(`3762a26fd65df422080c116e6a70d13bc8d57d62`) directly inside browser-owned
Gecko chrome (`argon/adblock/ublock-engine.sys.mjs` + `argon/adblock/service.sys.mjs`)
rather than bundling the legacy WebExtension. `argon.adblock.enabled` defaults to
`true`. The `uBlock0@raymondhill.net` enterprise auto-install policy was retired
from `settings/distribution/policies.json`, and existing profiles migrate user
filters, selected lists, site exceptions, dynamic/URL rules, hostname switches,
and external subscriptions via `ArgonAdblock.migrateAndRemoveLegacyExtension()`
before uninstalling the legacy add-on. All 9 parity gates in
[parity-evidence.json](parity-evidence.json) pass (`node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json`).
`BlockingAuthority` remains active so that if a user manually installs
`uBlock0@raymondhill.net`, Argon yields cleanly instead of running two
deciders.

A small Rust native library (`native/adblock/`, targeting **x86_64 Linux GNU**,
Brave `adblock-rust` 0.13.5, MPL-2.0) and its WASM build still exist and are
tested by `npm run test:adblock` / `python3 tests/adblock/test_native.py`, but
**the active browser runtime (`service.sys.mjs`) uses the isolated windowless-chrome
uBlock core (`UBlockGeckoEngine`) plus `OffMainThreadCompiler` (`compile-worker.mjs`)**.
No installed application or existing user profile is modified by tests.

## Runtime

- Classic browser window hook registers a process-global observer before that
  window's tabs start loading; repeated windows reuse the same singleton.
- Content HTTP(S)/WS(S) requests arriving while initial lists load are suspended
  and resumed once. Internal system-principal subresource fetches are excluded.
- Network matching uses unmodified upstream `static-net-filtering.js`,
  `hnswitches.js`, `url-net-filtering.js`, and `DynamicFirewall` (`dynamic.mjs`)
  through `UnifiedPolicy.decide()` (`policy.mjs`), including `$removeparam`,
  `$csp`, `$permissions`, `$header` (subresources), `$redirect` / `$redirect-rule`,
  `$websocket`, and strict-blocking.
- A Fission window actor (`ArgonAdblock`, matching `http://*/*`, `https://*/*`,
  `about:blank`, `about:srcdoc`) injects early MAIN-world scriptlets and early
  user-sheet CSS at `DOMWindowCreated`, and procedural cosmetics (`procedural.js`)
  at `DOMContentLoaded`; URLs are resolved from `WindowGlobalParent` /
  `BrowsingContext`, never supplied by web content. See [scope, security and GPL
  distribution obligations](native-ublock-cosmetics.md).
- Off-main-thread filter compilation (`OffMainThreadCompiler` in
  `compile-client.mjs` + `compile-worker.mjs`) runs network, cosmetic, scriptlet,
  and response-header list compilation on a background Gecko Worker thread in
  `SystemGlobal` (`offMainThreadCompiled: true`, `workerRuns > 0`), with main-thread
  fallback only for restricted mock realms without Worker constructors. Note that
  `compile-worker.mjs` uses a lightweight 2-label `publicSuffix.getDomain` fallback
  during worker compilation, whereas runtime `ublock-engine-bootstrap.js` and
  `service.sys.mjs` use Gecko's `Services.eTLD`.
- No `eval`, JIT code generation, or parent-process WASM/CSP security exemptions
  are used (`UBlockGeckoEngine` runs pure JS in a windowless system-principal
  chrome document).

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
`cap_ipaddress` are false. Argon retains conservative capability flags because
`cap_html_filtering` (HTML response body filtering such as `##^` / `$replace=`)
and `cap_ipaddress` (resolved-IP matching) are **not** implemented.

Active `!#include` paths must be relative safe path segments beneath the
including URL's directory, on the same HTTPS origin. Absolute URLs, traversal,
percent escapes, credentials, fragments and redirects are rejected. Limits:
8 include edges, 64 fetched files and 32 MiB source text per root, 16 MiB per
response/final list, 64 nested conditionals, 256 expression tokens and a
120-second abort signal per root expansion. Included files are independently
balanced; cycles fail. Inactive includes are not fetched. No filter code runs.

Cache generations carry pipeline version, resolved hashes and source provenance;
legacy raw caches and corrupt/mismatched generations fall back to the validated
offline snapshot. All downloads and compilation finish before the single atomic
profile-cache replacement and engine swap. Retired windowless engine instances are
closed after commit. Maintainer checkout snapshots stage all files before
publication and roll back ordinary write failures; publication of the multiple
source files is **not power-loss atomic**. Do not package/sync concurrently with
that command; manifest digests detect interrupted publication.

Both `extensions.update.enabled` and `extensions.update.autoUpdateDefault` must
be true for automatic background downloads. This reuses the existing
onboarding/settings consent, while explicit user actions ("Update now" or
single-subscription refresh in Filter Lists) run on demand. The updater checks
hourly, schedules each built-in list by its `Expires`/`updateAfter` interval
(with a 6-hour retry backoff on transient errors), fetches concurrently (capped
at 4), sends conditional `If-None-Match` / `If-Modified-Since` (`304 Not Modified`)
headers, and falls back to `fallbackUrls` mirrors from `lists.json`. When no
list hash changes, `service.sys.mjs` updates metadata in `argon-adblock-lists.json`
without recompiling the engine; on transient per-list failures, healthy lists
still update while failed lists retain their last-good copy and surface errors.
All fetches require HTTPS, omit credentials, reject redirects, bound list sizes,
and honor consent boundaries before commit.

## Native toolbar and configuration

The shield replaces the old Appearance menu. Appearance, workspace switching,
onboarding and the command palette remain in settings / Ctrl+Shift+P. The native
panel provides:

- A global native switch and a persisted **exact-hostname** exception, derived
  from the top-level page for requests, cosmetics, scriptlets, and response rules.
  A reload applies cosmetic/scriptlet changes. The exception covers all
  ports/schemes of that host, not sibling/subdomains. Non-HTTP(S) tabs cannot
  create exceptions.
- Per-site hostname switches (`no-scripting`, `no-cosmetic-filtering`,
  `no-large-media`, `no-remote-fonts`, `no-popups`, `no-csp-reports`),
  Element Picker, Element Zapper, Live Request Logger (with query/fragment
  redaction), and per-tab blocked-request badge counts.
- A multiline custom-filter editor, custom HTTPS subscriptions (`subscriptions.mjs`)
  with per-subscription enable toggles, schedule intervals, auto-extracted `! Title:` /
  `! Expires:` metadata, and individual refresh/remove actions, JSON backup/restore
  (`backup.mjs`), manual Filter Lists "Update now" toolbar with live status/error
  readout, and toggles for the 19 shipped lists.
  Unsupported syntax and untrusted privileged rules are rejected and surfaced
  in engine diagnostics rather than silently elevated.
- Native HTML controls with labels, initial focus, Tab/Shift+Tab containment,
  Escape dismissal, an announced error area and native status.

`argon-adblock-config.json` in the profile stores custom filters, disabled list
IDs, hostname exceptions, dynamic rules, hostname switches, URL rules, and custom
subscriptions—never browsing history. Private-window site exceptions, private
dynamic/switch/URL rules, private CNAME cache, and private logger entries stay in
memory and clear on `last-pb-context-exited`. Configuration edits and
downloaded-generation commits share a serialized queue; stale filter-editor saves
are rejected rather than overwriting another window.

## Delivered native parity & proven hard limits

- **Early Scriptlets & Redirect Resources (`child.sys.mjs`, `scriptlet-registry.mjs`, `redirect-resources.json`)**:
  `DOMWindowCreated` resolves exact `WindowGlobalParent` context (`innerWindowId`)
  for top-level, cross-origin, `about:blank`, and `about:srcdoc` frames before
  inline scripts execute. Pinned redirect resources enforce `requiresTrust` gating,
  `GET`-only method, and MIME-validated `data:` responses with exact-origin CORS.
  - *Hard limits*: `ISOLATED`-world scriptlets are rejected (`isolated-world`),
    untrusted sources cannot invoke `requiresTrust` resources/scriptlets
    (`untrusted-source`), and `NullPrincipal` sandboxes (`sandbox="allow-scripts"`)
    or non-HTTP(S) origins (`file://`, `Worker`, `ServiceWorker`) do not receive
    scriptlets. Early scriptlets execute in the page MAIN realm (not a WebExtension
    isolated world), so page JS can later overwrite unprotected globals unless
    locked by a trusted trap. `$redirect-rule=` alone never blocks an unblocked request.
- **Cosmetic & Procedural Engine (`child.sys.mjs`, `procedural.js`, `ublock-cosmetic.mjs`)**:
  Generic, specific, exception (`#@#`), entity (`.*`), regex host scopes, `$elemhide` /
  `$specifichide` / `$generichide`, and upstream procedural operators (`:has()`,
  `:has-text()`, `:matches-css()`, `:watch-attr()`, `:shadow()`, `:xpath()`,
  `:upward()`, `:nth-ancestor()`, `:style()`, `:remove()`, `:remove-attr()`,
  `:remove-class()`). Static user-sheet CSS is injected at `DOMWindowCreated` and
  propagated into open and closed Shadow DOM via Gecko Xray `openOrClosedShadowRoot`
  at `DOMContentLoaded`.
  - *Hard limits*: Procedural `:shadow()` hooks `Element.prototype.attachShadow`
    at `DOMContentLoaded`, so **closed** shadow roots attached before `DOMContentLoaded`
    are missed by procedural `:shadow()` (though still styled by static Xray CSS).
- **Network, Response Filtering, WebSockets, & CNAME Uncloaking (`policy.mjs`, `response.mjs`, `service.sys.mjs`)**:
  Built-in `$removeparam` (`argon.adblock.removeparam.builtin`), `@@$removeparam`
  exceptions, `ws:`/`wss:` WebSocket blocking (`$websocket` + `DynamicFirewall`),
  `$csp`, `$permissions`, subresource `$header=`, and bounded `##^responseheader(...)`.
  - *Hard limits*:
    - HTML body filtering (`$replace=`, `##^` HTML rules) is **not supported** (`cap_html_filtering=false`).
    - `$header=` cancels matching **subresources** only (`ResponseGate` skips `$header=` on `document`/`subdocument`).
    - `##^responseheader(...)` is strictly bounded to `{location, refresh, report-to, set-cookie}` with literal hostname scopes; arbitrary headers (e.g. `x-custom-secret`) and generic `##^responseheader(...)` without hostname scope are rejected in `responseHeaders.diagnostics`.
    - CNAME DNS uncloaking skips `document` requests, `localhost`/`.local`/`.test`/IP literals, and caps resolution at `120 ms` (10-minute TTL cache).
    - Top-level `TYPE_DOCUMENT` requests log under the pre-navigation `innerWindowId` at `http-on-modify-request` time; `logger.entriesFor(pageIdentityFor(browser))` aggregates subresources of the active `innerWindowId` with queries/fragments stripped (`redactURL`).
    - Gecko/LibreWolf's built-in `privacy.query_stripping.strip_list` (`settings/librewolf.cfg`) strips parameters such as `fbclid` independently of Argon's `@@$removeparam` or site exceptions.

## Reproduce

```sh
npm run test:adblock
python3 tests/adblock/test_snapshot.py  # maintainer publication rollback
npm test
npm run test:python
npm run test:dev
python3 scripts/dev-browser.py --sync-only
# In a venv with tests/browser/requirements.txt:
node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json
npm run test:browser:adblock
npm run test:browser:limits
ARGON_TEST_BINARY="$PWD/.cache/argon-dev/runtime/argon" npm run test:browser
```

The real-browser suites (`tests/browser/test_adblock.py`, `test_adblock_limits.py`,
`test_adblock_response.py`, `test_adblock_tools.py`, `test_scriptlets.py`,
`test_ublock_core.py`, `test_ublock_cosmetic.py`, `test_adblock_policy.py`,
`test_adblock_authority.py`) run against the synchronized `.cache/argon-dev/runtime/argon`
binary without injecting production service code.

Wrapper license: MPL-2.0. Pinned uBlock Origin filtering core & procedural
cosmetic adapter: GPL-3.0-or-later (`argon/adblock/ublock/`). Optional native Rust
library (`native/adblock/`): Brave `adblock-rust` 0.13.5, MPL-2.0. Filter lists
remain under their upstream licenses.

