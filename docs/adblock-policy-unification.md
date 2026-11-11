# Unified adblock policy: one authoritative decision pipeline

## Status

The native engine and the uBlock Origin extension currently block **independently**.
Native cancellation cannot be undone by the extension, and a native site exception does
not stop the extension from filtering the same site. That is the unsafe state this
document replaces with a single decision pipeline and a parity gate that must pass
before the extension policy is removed.

**The uBlock Origin enterprise policy stays installed.** `settings/distribution/policies.json`
still installs `uBlock0@raymondhill.net`, and the tests fail if that entry disappears
before every parity gate is met. Nothing here is a claim of uBO parity.

## Problem

Two independent blockers are not a transparent fallback:

- The extension cannot undo a request the native engine already cancelled, so a native
  allow is not authoritative.
- A native site exception does not reach the extension, so requests and cosmetics stay
  blocked after the user disables protection for a site.
- Filter-list updates, custom filters, strict-block and dynamic rules live in separate
  stores, so the two engines can disagree about the same URL.
- Removing the extension before parity leaves scriptlets, redirect resources, response
  filtering and modifiers unowned.

## Architecture

`argon/adblock/policy.mjs` is pure JavaScript (no Gecko imports) so Node unit tests and
the packaged chrome module share one implementation. The engine, cosmetic provider,
extension adapter and sinks are injected.

```
                    ┌──────────────────────────────┐
   request ───────► │ UnifiedPolicy.decide()       │ ──► allow | block | redirect
                    │  1. unified exceptions       │
                    │  2. strict-block / dynamic   │
                    │  3. authority engine         │
                    └──────────────┬───────────────┘
                                   │ exceptions / generations
                    ┌──────────────▼───────────────┐
                    │ sinks                        │
                    │  RecordingSink (tests)       │
                    │  PolicyDocumentSink (uBO)    │
                    │  NoopSink (after removal)    │
                    └──────────────────────────────┘
```

### One decision point

`decide(request)` returns exactly one verdict and is the only function that turns a
request into an action:

1. **Unified exceptions.** In `native` authority, an excepted top-level site returns
   `allow` immediately; the engine is never consulted and cosmetics are suppressed.
2. **Strict-block and dynamic rules.** The same pipeline consumes them, in order, and
   they are outranked by an exception. Strict-block applies to the document, not to its
   subresources. The pinned `DynamicFirewall` (`argon/adblock/dynamic.mjs`) plugs in
   through `DynamicFirewallAdapter`; its `noop` action falls through to the static
   engine.
3. **Authority engine.** In `native` mode the Rust engine decides, including redirect
   resources (a matched `data:` redirect replaces the response; anything else is
   rejected and never redirected cross-origin). In `extension` mode the extension
   adapter decides and the native engine is never consulted. There is no mode in which
   both decide.

Response CSP comes from the same engine generation through `cspFor(request)`, and is
suppressed for an excepted site and never produced in extension authority.

In `extension` authority the pipeline still owns the exception store, but it publishes
decisions instead of enforcing them: exceptions, strict-block rules and dynamic rules are
emitted to the sinks, and the extension adapter is the only decider. There is never a
second native decision that could contradict or duplicate it. `DynamicRules` is the
built-in strict-block/simple-dynamic store; `DynamicFirewallAdapter` is the uBO-compatible
path over the pinned `argon/adblock/dynamic.mjs` firewall.

### One exception store

`ExceptionStore` is the single write path for site decisions. Keys are exact hostnames
of HTTP(S) URLs: an exception covers every port and scheme of that host, never sibling
or subdomains. Private-window overrides are in-memory only and never persist.

### One generation transaction

`applyGeneration({ compile, validate, persist, commit })` compiles a candidate,
validates it, writes the durable cache/config, and only then swaps the live engine and
configuration. Any failure before `commit` leaves the previous engine, configuration and
cache untouched. Strict-block and dynamic rules are part of the same generation.

### Extension coordination contract

A retained extension is a **policy consumer**, not a second decider. Every exception
change is published to registered sinks. `PolicyDocumentSink` renders the
`ExtensionSettings` fragment that keeps the extension in sync:

```json
{
  "ExtensionSettings": {
    "uBlock0@raymondhill.net": { "runtime_blocked_hosts": ["*://example.com"] }
  }
}
```

Firefox 153+ applies `runtime_blocked_hosts` to content scripts **and** requests, so an
excepted site stops being filtered by the extension as well as by the native engine.
Match patterns carry no path component and `*://host` is exact-host scope, matching the
native exception semantics.

Limits, stated plainly:

- The fragment is rendered from the unified store by `scripts/adblock-policy.mjs
  fragment` and by the sink. Applying it to a running browser needs a policy refresh
  (restart or admin push); Firefox does not re-read `distribution/policies.json` on
  demand. Until that refresh, the native pipeline is the authority and the extension may
  still block the site. The native side restores immediately and suppresses cosmetics.
- Private exceptions are deliberately **not** written to the extension policy; they are
  ephemeral by contract.
- The extension policy is removed only through `scripts/adblock-policy.mjs retire`,
  which refuses while any parity gate is unmet.

### Parity gate

`ParityGate` holds a versioned checklist of the blocking-migration gates from
[native-adblock-parity.md](native-adblock-parity.md) plus the two invariants proven here
(exception coordination, last-good updates). `assertRetirementAllowed()` throws while any
gate is unmet, and `retireExtension()` removes the extension entry only after every gate
records evidence. Evidence lives in a maintainer-owned JSON file; no evidence file is
checked in, so the default state is "unmet" and retirement is refused.

## Migration phases

1. **Single pipeline (this change).** `policy.mjs` implements the decision point, the
   exception store, the generation transaction and the sinks. Tests prove the invariants.
   The service adopts `UnifiedPolicy` so `NetworkGate` becomes a transport adapter that
   only suspends/resumes and calls `decide`; nothing else cancels a channel.
2. **Extension neutralization.** With parity evidence recorded for scriptlets, redirect
   resources/responses, modifiers and response filtering, the extension is reduced to a
   policy consumer and the coordination fragment is applied.
3. **Removal.** `retire` deletes the `uBlock0@raymondhill.net` entry from
   `settings/distribution/policies.json`. `NoopSink` replaces the extension sink.

## Integration steps for the service

These are deliberately not applied by this change, which does not edit the existing
engine files:

- `service.sys.mjs`: construct `UnifiedPolicy` with the native engine, the uBO cosmetic
  adapter, the shared `ExceptionStore`, the `DynamicRules`/`DynamicFirewallAdapter`
  compiled from the user's strict-block and dynamic lines, and the sinks. Route
  `setSite`/`saveFilters`/`change` through it; keep the serialized queue and the atomic
  cache write.
- `network.mjs`: keep only suspend/resume/rewrite/redirect; replace the direct
  `engine.check` call with `policy.decide(request)` and map the verdict's `redirect`
  field to the existing redirect callback.
- `parent.sys.mjs`: replace the `engine.cosmetic` + `ublockCosmetics` pair with
  `policy.cosmeticsFor(url, { topURL, isPrivate })`, and apply `policy.cspFor(request)`
  directives for supported response CSP.
- `dynamic.mjs`: construct the `DynamicFirewall` with an eTLD+1 `domainOf` helper and
  wrap it in `DynamicFirewallAdapter`.
- `bootstrap.js`: unchanged.
- `config/overlay.json`: add `policy.mjs` to `files` and the jar entries (done here);
  `dynamic.mjs`, the redirect resources and the scriptlet catalog need the same entries
  before a packaged build can use them.

## Tests

```sh
node --test tests/adblock/policy-unification.test.mjs tests/adblock/policy-gate.test.mjs
node --test tests/adblock/dynamic.test.mjs          # the pinned firewall itself
node scripts/adblock-policy.mjs status
node scripts/adblock-policy.mjs verify          # exits 1 while gates are unmet
node scripts/adblock-policy.mjs fragment --sites example.com,other.test
python3 scripts/dev-browser.py --sync-only
ARGON_TEST_BINARY=.cache/argon-dev/runtime/argon \
  .cache/browser-venv/bin/python tests/browser/test_adblock_policy.py
```

`tests/adblock/policy-unification.test.mjs` proves: one verdict per request, exceptions
outranking the engine and strict-block rules, cosmetics suppression for excepted sites,
strict-block and dynamic rules in the same pipeline, the pinned `DynamicFirewall` and
redirect resources feeding that pipeline, response CSP suppression, last-good generation
on failure, and the exact `runtime_blocked_hosts` fragment for excepted hosts (and its
removal). `tests/adblock/policy-gate.test.mjs` proves retirement is refused while gates
are unmet and that the shipping policy still installs uBlock Origin.
`tests/browser/test_adblock_policy.py` repeats the coordination proof inside packaged
Gecko, so the module is exercised through the real chrome loader rather than Node.

## Non-goals

- No claim of uBO dialect parity, HTML filtering, resolved-IP matching, response-body
  filtering or early scriptlets.
- No per-profile enterprise policy writer: Firefox reads `policies.json` from the
  installation directory, so runtime exceptions are applied by the native pipeline and
  the extension fragment is refreshed by the tooling.
- No removal of the extension policy.
