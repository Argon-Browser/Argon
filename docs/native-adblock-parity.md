# Native adblock replacement gates

Argon replaces the bundled uBlock Origin extension with a browser-owned Gecko UI backed
by the pinned upstream uBlock Origin filtering core (`3762a26fd65df422080c116e6a70d13bc8d57d62`).
The enterprise policy no longer installs `uBlock0@raymondhill.net`, and existing user
profiles migrate their uBlock Origin storage (`user-filters`, `selectedFilterLists`,
`netWhitelist`, `dynamicFilteringString`, `urlFilteringString`, `hostnameSwitchesString`,
and external list URLs) before uninstalling the legacy add-on. All 9 parity gates are
verified via `node scripts/adblock-policy.mjs verify --evidence docs/parity-evidence.json`.

## Delivered controls

- Native shield toolbar panel replacing the Appearance menu.
- Global enable/disable and exact-hostname exceptions for the top-level site,
  including requests and cosmetics in child frames.
- Custom filter editor and switches for the 19 default list identities.
- Keyboard navigation, labels, error announcements and reload action.
- In-memory private-site overrides; serialized configuration writes and rollback
  when replacement configuration cannot be saved.

## Blocking migration gates

1. List ingestion must expand relative includes and evaluate environment and
   capability conditionals before compiling. Raw source files are not necessarily
   complete lists. Preserve source provenance, bound downloads and recursive
   includes, and retain the last good generation on failure. In particular,
   Firefox identity must not imply unsupported HTML-filtering capability.
2. Package reviewed, pinned redirect/scriptlet resources. Preserve resource
   permissions and dependencies; custom filters and third-party subscriptions
   must not acquire privileged resource permissions. Scriptlets may only execute
   in the intended content realm, never the privileged actor or parent realm.
3. Implement redirect responses with correct MIME, principal, CSP and CORS
   handling. Cancelling a request is not equivalent to supplying its redirect
   resource. A redirect-rule alone must not independently block a request.
4. Generic cosmetics and the source-reused procedural subset now have a real
   browser-owned implementation: see [the scoped implementation and evidence](native-ublock-cosmetics.md).
   Hash-only script CSP, `style-src 'none'`, hostile page-return values, DOM mutation,
   unhide, site exemptions and genuine BFCache resumption are exercised. Entity/regex
   host scopes, closed shadow roots, `watch-attr`, hard work bounds and the complete
   operator/context matrix remain open; this does not close the whole parity gate.
5. Integrate early scriptlets, response CSP and supported response filtering.
   DOMContentLoaded is too late for rules intended to prevent initial scripts.
6. Verify request context and interception for workers, service workers, caches,
   WebSockets, redirects, initial startup and private/container contexts.
   Unknown initiators must not be silently treated as first-party.
7. Inventory syntax compatibility against a pinned uBlock version. Distinguish
   parsed rules from rules actually executed. The current Rust engine does not
   implement every uBO modifier or response-filtering feature; UI controls cannot
   close those semantic gaps.

## Remaining product features

- Custom URL subscriptions and their update/error management.
- Configuration backup/import and migration of existing uBlock user rules,
  exceptions, subscriptions and regional selections.
- Element picker/zapper, request logger and genuine per-page counters.
- Dynamic filtering, temporary/permanent decisions and strict-block interstitials.
- Off-main-thread compilation, startup/memory benchmarks and release-platform
  build/ABI coverage.

## Acceptance evidence

Exercise real packaged-browser interactions and observable requests, not only
preference values. Run native-only differential fixtures against a pinned uBlock
release, with startup/offline/update-failure cases, private and normal windows,
frames, cache/service-worker paths and unsupported-rule reporting. Test that site
exceptions restore requests and cosmetics, that removed rules stop applying, and
that failed updates do not replace the working generation. Until this evidence
exists, do not remove the extension policy or describe the implementation as a
100% replacement.
