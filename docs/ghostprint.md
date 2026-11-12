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

**Brave-style farbling applies regardless of Gecko RFP/FPP.** GhostPrint installs
its deterministic farbling hooks even when Resist Fingerprinting or Fingerprinting
Protection is enabled in Gecko. It never unlocks or changes those preferences.
The panel separately shows actual loaded-document status and per-surface
unavailable/failed/disabled states.

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

## Surfaces, stealth camouflage, and modes

- **Camouflage (`inject.js`)**: Concise-method WebIDL wrappers preserve exact
  property descriptors (`writable`, `enumerable`, `configurable`), carry no own
  `.toString` or `.prototype` property, reject `Reflect.construct` with native
  `TypeError`, enforce authentic C++ WebIDL receiver brand checks (`this`), avoid
  `Proxy` wrappers on `TextMetrics` and `WebGLShaderPrecisionFormat`, and conceal
  the per-realm idempotency symbol from `Object.getOwnPropertySymbols` and
  `Reflect.ownKeys`.
- **Canvas & OffscreenCanvas (2D & WebGL)**: Sparse RGB perturbation for
  `getImageData`, `toDataURL`, `toBlob`, `OffscreenCanvasRenderingContext2D.getImageData`,
  and single-pass `OffscreenCanvas.convertToBlob`; `alpha === 0` transparent pixels
  remain `[0, 0, 0, 0]` to avoid premultiplied-alpha anomalies; `measureText`
  applies sub-pixel deterministic jitter (skipped when `privacy.resistFingerprinting`
  is active).
- **WebGL & WebGL 2**: Coordinate-consistent `readPixels` and `getBufferSubData`
  (`PIXEL_PACK_BUFFER`), OS-coherent `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL`
  profiles, capability range jitter, and one deterministic synthetic extension.
- **Workers (`WorkerGlobalScope`)**: `Worker` and `SharedWorker` (`blob:`, `data:`,
  and same-origin scripts when permitted by CSP) inherit the top-level document's
  deterministic seed, coherent `(hardwareConcurrency, deviceMemory)` tier, and
  `OffscreenCanvas` 2D/WebGL protections.
- **Audio**: Sub-16-bit-LSB inaudible deterministic dither (`~3.5e-6` in
  `balanced`, `~1.2e-5` in `strict`) on `AudioBuffer` and `AnalyserNode`, bounded
  within `[-1.0, 1.0]` without mutating native playback buffers.
- **Hardware, Screen, Speech & Plugins**: Coherent `(hardwareConcurrency, deviceMemory)`
  pairs, desktop `Screen` + `outerWidth`/`outerHeight` + `devicePixelRatio` +
  `window.matchMedia` coherency, deterministic `speechSynthesis.getVoices()`
  synthetic voice, and `PluginArray`/`MimeTypeArray` PDF profile.
- **Resilience Modes & RFP (`argon.ghostprint.mode`)**:
  - `balanced` (default): origin-session deterministic seed and viewport-safe
    screen/font behavior for banking and corporate web apps.
  - `strict`: per-top-navigation seed shared across child frames and workers,
    full GPU string scrubbing, normalized DPR, and normalized `prefers-color-scheme`.
  - `off`: disables hook installation completely.
  - When `privacy.resistFingerprinting` is active, GhostPrint avoids double font
    jitter and preserves Gecko RFP's letterboxed screen dimensions.

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
