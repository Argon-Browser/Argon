# GhostPrint in Argon

Argon vendors GhostPrint 1.1.0 from
https://github.com/gnustella-lab/GhostPrint at commit
`3f63e4658f6516fa4f62e27d741e128e7cb7b7e7` (MIT).
The original copyright/license is in `third_party/ghostprint/LICENSE` and
`argon/adblock/ghostprint/LICENSE`. Original sources and behavioral tests are
retained in `third_party/ghostprint/`. The packaged adapter and original/adapter
SHA-256 hashes are in `argon/adblock/ghostprint/provenance.json`.

## Controls and defaults

The existing adblock panel has a GhostPrint section under advanced controls:

- Per-site switch: **exact top-level HTTP(S) origin** (scheme, hostname and
  port), including HTTP(S) child frames. Not the adblock's hostname-only scope.
- Global GhostPrint checkbox and six independent surface checkboxes in global
  settings. These use `argon.ghostprint.enabled` and
  `argon.ghostprint.{canvas,webgl,webgpu,audio,navigator,plugins}`, default true.
- Site exceptions use `argon.ghostprint.sites`. Private exceptions and seeds
  remain in memory and are discarded when the last private context exits.
  Private site choices do not inherit or alter ordinary site exceptions.
- All changes require reload. Hooks in an existing document are not revoked.
- Adblock global/site switches affect only adblock, not GhostPrint. uBlock Origin
  remains independent of both.

**Gecko RFP/FPP takes precedence.** If Resist Fingerprinting or Fingerprinting
Protection is enabled (including the applicable private-mode preference), Argon
reports a conflict and does not install GhostPrint hooks. It never unlocks or
changes those preferences. LibreWolf normally enables RFP; the tested packaged
runtime also enables FPP during startup. Consequently a selected GhostPrint
checkbox is not a claim that hooks installed. The panel separately shows actual
loaded-document status and per-surface unavailable/failed/disabled states.
There is deliberately no button here to weaken Gecko protection to enable hooks.

## Actual implementation and trust boundary

The browser registers a JSWindowActor for matching HTTP(S) documents, all frames,
at `DOMWindowCreated`, before early inline page scripts. Source is loaded from
packaged chrome resources, not the network. A read-only synchronous Gecko process
message resolves the top-level principal from the parent process's
`BrowsingContext`/`WindowGlobalParent`; a child cannot supply a site URL as policy.
This synchronous read is necessary for cross-process frames: their parent-process
WindowGlobal and principal are not accessible in the child, and awaiting an actor
query would miss early inline scripts. The listener accepts only a context id,
returns only an authoritative content origin, and has no mutation/configuration
operation. The listener also validates that the Gecko process message manager's
OS PID owns the nominated current WindowGlobal before returning any origin.
Ordinary page scripts cannot access this IPC interface.

Hooks execute in the **actual page realm**, under its content principal, via
`Services.scriptloader.loadSubScriptWithOptions` with the unwrapped content
window as the explicit target and `wantReturnValue: true`. The packaged file
returns an installer function. Only a numeric seed and a cloned data-only array
of surface names are passed to it. No system-principal function, callback,
service, actor or object enters the page. The installation result is a JSON
string, not page `postMessage` data. There are no injected DOM script elements,
extension transport, storage reads, CSP changes, security-pref changes,
telemetry, or remotely downloaded runtime code. A failed load/context/crypto/
install is not reported as active protection.

A content-principal sandbox with a window prototype was explicitly rejected:
its Function constructor can evade the document's CSP even without chrome
privileges. The real-browser regression test calls the installed hook's
constructor under hash-only CSP and requires `EvalError`, proving this escape
is closed. Gecko may hide source for chrome-URL scripts in `Function.toString`;
this is not used as evidence of successful protection.

The upstream algorithms are unchanged. The adapter changes only the IIFE to a
lexical-argument function, removes extension seed/report transport, adds six
installer gates, and returns a JSON summary. Original code is retained alongside
its suite for review. The upstream per-realm registry and hooks live in the
page realm and remain detectable/tamperable by page JavaScript. Installation
status is an initial hook-installation result,
not continuous proof that a hostile page has not replaced a hook.

Session secrets are generated with Gecko's random UUID generator and never
persisted or placed on a page/storage/script URL. SHA-256 mixes the session
secret, exact top-level origin, and authoritative document origin attributes
(including container/private partitioning) into GhostPrint's 32-bit seed range.
Regular and private sessions have distinct secrets; closing the last private
context rotates the private secret. Repeated reads/reloads in one session/site
are deterministic, different top-level origins/containers/private sessions are
partitioned. As upstream uses a 32-bit farbling seed, collisions are possible;
this seed is not a cryptographic identity or anonymity guarantee.

## Surfaces and limitations

- Canvas: sparse RGB perturbation for getImageData, toDataURL, toBlob; alpha
  unchanged. Exports are intentionally no longer byte-identical to originals.
- WebGL: safe RGBA/UNSIGNED_BYTE typed-array readPixels, normalized vendor/
  renderer, one inert synthetic extension. Hook installation does not imply a
  usable GPU context (headless systems may not have one).
- WebGPU: vendor/architecture/device scrubbing only; no API is enabled by Argon.
  In the tested Gecko runtime this API was unavailable and was labeled as such.
- Audio: AudioBuffer and AnalyserNode farbling; upstream copy semantics may affect
  editing software that depends on directly mutable live sample arrays.
- Navigator: hardwareConcurrency only (not every Navigator property).
- Plugins/MIME types: coherent synthetic PDF profile; not native internal slots.

No coverage is claimed for workers, worklets, special/opaque/non-HTTP(S) documents,
about:blank/srcdoc/data/blob realms, offscreen 2D/export paths, WebGL PBO readback,
or all WebGPU features. Uncovered realms and native methods remain bypasses.
Synthetic objects, descriptors, function toString and realm differences are
observable. No guarantee against IP/cookie/account/font/screen/network correlation,
or equivalence to Brave/Tor/RFP. No remote fingerprinting score is claimed.

Startup registers the actor after the packaged source has loaded; documents that
already exist need reload and are reported as not installed, not retroactively
marked protected. JS-only hooks cannot revoke references saved in uncovered
realms. Browser source recompilation is not required by the isolated development
runtime; that is not a full release build verification.

## Verification

```
python3 scripts/dev-browser.py --sync-only
npm run test:ghostprint
npm run test:browser:ghostprint
npm run test:browser
npm test
npm run test:python
npm run test:dev
npm run test:adblock
```

`tests/browser/test_ghostprint.py` starts the packaged Gecko without injecting
production modules/hooks from the test. A local server returns a hash-only strict
script-src CSP (no unsafe-inline/eval) and a very first inline API probe. It checks
real changed canvas pixels/audio samples, alpha and repeated-read consistency,
cross-origin frame coverage and exception propagation, accessible native pointer
controls and actual reload effects, independent Canvas/global toggles, private
seed separation and in-memory exception behavior, and RFP conflict preservation.
Only this isolated opt-out test disables RFP/FPP after startup in its own temporary
profile; production never does. GPU APIs are feature-detected rather than enabled
for a test. Upstream's 96 tests are VM/API fixtures, not GPU hardware verification.
Marionette may emit its existing socket ResourceWarnings during startup.
