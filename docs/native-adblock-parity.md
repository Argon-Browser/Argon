# Native adblock replacement gates

Argon replaces the bundled uBlock Origin extension with a browser-owned Gecko UI backed
by the pinned upstream uBlock Origin filtering core (`3762a26fd65df422080c116e6a70d13bc8d57d62`).
The enterprise policy no longer installs `uBlock0@raymondhill.net`, and existing user
profiles migrate their uBlock Origin storage (`user-filters`, `selectedFilterLists`,
`netWhitelist`, `dynamicFilteringString`, `urlFilteringString`, `hostnameSwitchesString`,
and external list URLs) before uninstalling the legacy add-on. All 9 parity gates are
verified via `node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json`.

## Delivered controls & engine parity

- Native shield toolbar panel replacing the Appearance menu (`panel.mjs`).
- Global enable/disable and exact-hostname exceptions for the top-level site,
  including requests, cosmetics, scriptlets, and response rules in child frames.
- Custom filter editor, custom HTTPS subscriptions (`subscriptions.mjs`), JSON
  backup/restore/migration (`backup.mjs`), and switches for the 19 default lists.
- Per-site hostname switches, interactive Element Picker, Element Zapper,
  Live Request Logger (with URL query/fragment redaction), and per-tab counters.
- Keyboard navigation, labels, error announcements, private in-memory isolation,
  and atomic generation transactions (`policy.mjs`, `compile-worker.mjs`).

## Parity gate status (9/9 met)

All 9 migration gates tracked in [parity-evidence.json](parity-evidence.json) are met
and verified by `node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json`:

1. `list-ingestion`: conditional directives (`!#if`), bounded same-origin `!#include`,
   SHA-256 provenance, and atomic last-good generation rollback (`updater.mjs`).
2. `redirect-resources`: pinned resources with `requiresTrust` and `trustedTokens` gating
   (`redirect-resources.json`, `scriptlet-registry.mjs`).
3. `redirect-responses`: `GeckoResourceRedirector` enforces `GET`, MIME, content principal,
   page CSP, and exact-origin CORS (`response.mjs`, `response.sys.mjs`).
4. `cosmetics-parity`: generic, specific, procedural (`:style`, `:remove`, `:remove-attr`,
   `:remove-class`, `:watch-attr`, `:shadow`), entity (`.*`), regex host scopes,
   `$elemhide`/`$specifichide`/`$generichide`, and site exceptions (`ublock-cosmetic.mjs`).
5. `scriptlets-early`: synchronous `DOMWindowCreated` MAIN-world scriptlets, `$csp`,
   `$permissions`, subresource `$header=`, and bounded `##^responseheader(...)`.
6. `request-contexts`: startup channel suspension, cross-origin frames, caches/304 merges,
   popups, WebSockets, CNAME DNS uncloaking (with `120 ms` timeout and local/doc skip),
   and private-browsing isolation (`service.sys.mjs`, `network.mjs`).
7. `dialect-inventory`: unmodified upstream `static-net-filtering.js`, `hnswitches.js`,
   and `url-net-filtering.js` with explicit parser/compiler diagnostics.
8. `exception-coordination`: single `UnifiedPolicy` and `ExceptionStore` across network,
   cosmetics, scriptlets, dynamic rules, switches, and response headers (`policy.mjs`).
9. `update-failure-last-good`: isolated windowless-chrome engine generation per compile,
   committed atomically only after durable cache/config persistence succeeds.

## Proven hard limits (intentionally out of scope)

- **HTML body filtering (`cap_html_filtering=false`)**: `$replace=` and `##^` HTML
  response-body rewriting are not supported (`non-cosmetic-extended` diagnostics).
- **Resolved-IP matching (`cap_ipaddress=false`)**: IP-address filter lists are excluded.
- **Document `$header=` & unbounded `##^responseheader`**: `$header=` runs only on
  subresources; `##^responseheader(...)` only removes `{location, refresh, report-to, set-cookie}`
  on literal hostname scopes.
- **Early closed Shadow DOM procedural timing**: static hiding CSS penetrates early closed
  shadow roots via Gecko Xray `openOrClosedShadowRoot`, whereas procedural `:shadow()` hooks
  `Element.prototype.attachShadow` at `DOMContentLoaded` and misses earlier closed roots.
- **MAIN-world scriptlets & untrusted trust boundaries**: scriptlets run in the content
  MAIN realm (not a WebExtension isolated world), and `ISOLATED` scriptlets / untrusted
  `requiresTrust` rules / `NullPrincipal` sandboxes / Workers do not receive scriptlets.
- **Optional Rust binary (`native/adblock/`)**: remains Linux x86_64 only for `test:adblock`;
  the active browser service uses the cross-platform pure-JS uBlock core.

## Acceptance & limits verification

Run the unit, policy-gate, and real packaged-Gecko suites (including `test_adblock_limits.py`):

```sh
node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json
npm run test:adblock
npm run test:browser:adblock
npm run test:browser:limits
```

