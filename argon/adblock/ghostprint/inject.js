// GhostPrint, runs in the page's JavaScript context.
//
// The hooks below apply deterministic farbling to selected fingerprinting
// surfaces. They are not a complete browser privacy boundary and do not claim
// equivalence with Brave, Tor Browser, or Firefox Resist Fingerprinting.
//
// Design: Brave-style farbling. Every read of canvas pixels returns the real
// pixels perturbed by tiny, seed-determined noise (~1 in 32 pixels, ±1 per
// RGB channel, alpha untouched). The perturbation is a pure function of
// (seed, pixel position, source pixel values), so a canvas that is drawn
// identically twice produces byte-identical farbled output. EFF draws the
// same probe canvas on both of its runs within a page, so the hash is
// stable within the page; a different first-party origin has a different
// seed, so the hash differs across origins — which is what EFF rewards.
//
// Known caveat (documented, not silently ignored): because the source pixel
// values feed into the hash, if the browser renders the same canvas
// slightly differently between two draws (sub-pixel text/gradient
// variation), the farbled output could differ between EFF's two runs and
// the field would be flagged "randomized" within the page, losing
// cross-domain credit. In practice canvas rendering is deterministic for
// identical draw calls, so this is theoretical; if EFF ever stops passing,
// drop the source pixels from the hash (pure function of seed + position +
// dimensions).
//
// Audio's OfflineAudioContext rendering is mathematically deterministic, so
// value-dependent noise is safe there; a per-channel cache keeps repeated
// reads identical.
//
// Argon adaptation: seed and selected surfaces are lexical arguments.
// Installation status is a JSON return value, not a page-visible message.

(function (ARGON_SEED, ARGON_SURFACES, ARGON_OPTIONS) {
  'use strict';

  // Argon supplies data-only lexical arguments, not page-controlled transport.
  const SEED = ARGON_SEED;
  if (!Number.isSafeInteger(SEED) || SEED < 1 || SEED > 0xFFFFFFFE) throw new Error('Invalid GhostPrint seed');
  const OPTIONS = ARGON_OPTIONS && typeof ARGON_OPTIONS === 'object' ? ARGON_OPTIONS : Object.create(null);
  const MODE = OPTIONS.mode === 'strict' ? 'strict' : (OPTIONS.mode === 'off' ? 'off' : 'balanced');
  const RFP_ACTIVE = OPTIONS.rfp === true;
  if (MODE === 'off') return JSON.stringify({});

  const REGISTRY_FALLBACK_KEY = '__ghostprint_installation_v1__';
  const pageGlobal = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
  const origGetOwnPropertySymbols = typeof Object.getOwnPropertySymbols === 'function'
    ? Object.getOwnPropertySymbols.bind(Object)
    : null;
  const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
  const origGetOwnPropertyDescriptors = typeof Object.getOwnPropertyDescriptors === 'function'
    ? Object.getOwnPropertyDescriptors.bind(Object)
    : null;
  const origReflectOwnKeys = typeof Reflect !== 'undefined' && typeof Reflect.ownKeys === 'function'
    ? Reflect.ownKeys.bind(Reflect)
    : null;

  let installationRegistry;
  let hiddenRegistryKey = null;
  try {
    const canUsePrivateSymbol = typeof Symbol === 'function' && origGetOwnPropertySymbols !== null;
    if (canUsePrivateSymbol) {
      const symbols = origGetOwnPropertySymbols(pageGlobal);
      for (const symbol of symbols) {
        const candidate = pageGlobal[symbol];
        if (candidate && candidate.version === 1
          && candidate.installers && candidate.patchedWebGLContexts) {
          installationRegistry = candidate;
          hiddenRegistryKey = candidate.registryKey || symbol;
          if (!installationRegistry.canvasWebGLContexts) {
            installationRegistry.canvasWebGLContexts = new WeakMap();
          }
          break;
        }
      }
    } else {
      installationRegistry = pageGlobal[REGISTRY_FALLBACK_KEY];
      if (installationRegistry && !installationRegistry.canvasWebGLContexts) {
        installationRegistry.canvasWebGLContexts = new WeakMap();
      }
    }
    if (!installationRegistry) {
      hiddenRegistryKey = canUsePrivateSymbol ? Symbol() : REGISTRY_FALLBACK_KEY;
      installationRegistry = {
        version: 1,
        registryKey: hiddenRegistryKey,
        patchedWebGLContexts: new WeakSet(),
        canvasWebGLContexts: new WeakMap(),
        textMetricsDeltas: new WeakMap(),
        shaderPrecisionValues: new WeakMap(),
        blobPayloads: new Map(),
        installers: Object.create(null),
      };
      Object.defineProperty(pageGlobal, hiddenRegistryKey, {
        value: installationRegistry,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    } else {
      if (!installationRegistry.textMetricsDeltas) installationRegistry.textMetricsDeltas = new WeakMap();
      if (!installationRegistry.shaderPrecisionValues) installationRegistry.shaderPrecisionValues = new WeakMap();
      if (!installationRegistry.blobPayloads) installationRegistry.blobPayloads = new Map();
    }
  } catch (_) {
    return;
  }

  // ─── CreepJS-grade Native Function & Descriptor Camouflage ──────────────
  // Uses concise method syntax `{ [name]() {} }[name]` so hooked functions:
  // 1. Have NO `.prototype` property (`'prototype' in fn === false`)
  // 2. Throw native `TypeError: ... is not a constructor` on `new` / `Reflect.construct`
  // 3. Have NO own `.toString` property (`Object.hasOwn(fn, 'toString') === false`)
  // 4. Expose exact `['length', 'name']` own keys with `{ writable: false, enumerable: false, configurable: true }`
  // 5. Return `function <name>() { [native code] }` via `Function.prototype.toString`
  let nativeFunctionNames = installationRegistry.nativeFunctionNames;
  if (!nativeFunctionNames) {
    nativeFunctionNames = new WeakMap();
    installationRegistry.nativeFunctionNames = nativeFunctionNames;
  }

  function makeNative(fn, name, length) {
    if (!fn || typeof fn !== 'function') return fn;
    const fnName = typeof name === 'string' ? name : (fn.name || '');
    const fnLen = typeof length === 'number' ? length : (typeof fn.length === 'number' ? fn.length : 0);
    // If fn has an own `.prototype` (classic function declaration/expression),
    // re-wrap inside a concise method so `'prototype' in wrapper === false`
    // and `Reflect.construct(wrapper, [])` throws native TypeError.
    let targetFn = fn;
    if (Object.prototype.hasOwnProperty.call(fn, 'prototype')) {
      targetFn = ({
        [fnName]() {
          return Reflect.apply(fn, this, arguments);
        },
      })[fnName];
    }
    try {
      Object.defineProperty(targetFn, 'length', {
        value: fnLen,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch (_) {}
    try {
      Object.defineProperty(targetFn, 'name', {
        value: fnName,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch (_) {}
    try {
      nativeFunctionNames.set(targetFn, fnName);
    } catch (_) {}
    return targetFn;
  }

  if (!installationRegistry.toStringPatched && typeof Function !== 'undefined' && Function.prototype) {
    try {
      const origToStringDesc = origGetOwnPropertyDescriptor(Function.prototype, 'toString');
      const origFunctionToString = origToStringDesc && typeof origToStringDesc.value === 'function'
        ? origToStringDesc.value
        : Function.prototype.toString;
      const patchedToString = makeNative(({
        toString() {
          if (typeof this === 'function' && nativeFunctionNames.has(this)) {
            const fnName = nativeFunctionNames.get(this);
            const displayName = fnName.startsWith('get ') || fnName.startsWith('set ')
              ? fnName.slice(4)
              : fnName;
            return 'function ' + displayName + '() { [native code] }';
          }
          return Reflect.apply(origFunctionToString, this, arguments);
        },
      }).toString, 'toString', 0);
      Object.defineProperty(Function.prototype, 'toString', {
        value: patchedToString,
        writable: origToStringDesc ? origToStringDesc.writable : true,
        enumerable: origToStringDesc ? origToStringDesc.enumerable : false,
        configurable: origToStringDesc ? origToStringDesc.configurable : true,
      });
      installationRegistry.toStringPatched = true;
    } catch (_) {}
  }

  // Conceal the per-realm registry symbol from `Object.getOwnPropertySymbols(window)`,
  // `Reflect.ownKeys(window)`, and `Object.getOwnPropertyDescriptor(window, sym)`.
  if (!installationRegistry.registryConcealed && hiddenRegistryKey !== null && typeof hiddenRegistryKey === 'symbol') {
    try {
      if (origGetOwnPropertySymbols) {
        const symDesc = origGetOwnPropertyDescriptor(Object, 'getOwnPropertySymbols');
        if (symDesc && symDesc.configurable !== false) {
          const wrappedGetSyms = makeNative(({
            getOwnPropertySymbols(target) {
              const syms = origGetOwnPropertySymbols(target);
              return target === pageGlobal ? syms.filter((s) => s !== hiddenRegistryKey) : syms;
            },
          }).getOwnPropertySymbols, 'getOwnPropertySymbols', 1);
          Object.defineProperty(Object, 'getOwnPropertySymbols', { ...symDesc, value: wrappedGetSyms });
        }
      }
      if (origReflectOwnKeys && typeof Reflect === 'object') {
        const rkDesc = origGetOwnPropertyDescriptor(Reflect, 'ownKeys');
        if (rkDesc && rkDesc.configurable !== false) {
          const wrappedOwnKeys = makeNative(({
            ownKeys(target) {
              const keys = origReflectOwnKeys(target);
              return target === pageGlobal ? keys.filter((k) => k !== hiddenRegistryKey) : keys;
            },
          }).ownKeys, 'ownKeys', 1);
          Object.defineProperty(Reflect, 'ownKeys', { ...rkDesc, value: wrappedOwnKeys });
        }
      }
      const gopdDesc = origGetOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor');
      if (gopdDesc && gopdDesc.configurable !== false) {
        const wrappedGOPD = makeNative(({
          getOwnPropertyDescriptor(target, prop) {
            if (target === pageGlobal && prop === hiddenRegistryKey) return undefined;
            return origGetOwnPropertyDescriptor(target, prop);
          },
        }).getOwnPropertyDescriptor, 'getOwnPropertyDescriptor', 2);
        Object.defineProperty(Object, 'getOwnPropertyDescriptor', { ...gopdDesc, value: wrappedGOPD });
      }
      if (origGetOwnPropertyDescriptors) {
        const gopdsDesc = origGetOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptors');
        if (gopdsDesc && gopdsDesc.configurable !== false) {
          const wrappedGOPDs = makeNative(({
            getOwnPropertyDescriptors(target) {
              const descs = origGetOwnPropertyDescriptors(target);
              if (target === pageGlobal && descs) delete descs[hiddenRegistryKey];
              return descs;
            },
          }).getOwnPropertyDescriptors, 'getOwnPropertyDescriptors', 1);
          Object.defineProperty(Object, 'getOwnPropertyDescriptors', { ...gopdsDesc, value: wrappedGOPDs });
        }
      }
      installationRegistry.registryConcealed = true;
    } catch (_) {}
  }

  // ─── Deterministic 32-bit hash mixer ─────────────────────────────────────
  // Stateless. Same args + same SEED → same output, always.
  function mix() {
    let h = SEED;
    for (let i = 0; i < arguments.length; i++) {
      h = Math.imul(h ^ (arguments[i] >>> 0), 0x9e3779b9) >>> 0;
      h ^= h >>> 16;
    }
    return h >>> 0;
  }

  function strHash(str) {
    if (typeof str !== 'string') str = String(str || '');
    let h1 = 0xdeadbeef ^ SEED, h2 = 0x41c6ce57 ^ SEED;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return h1 >>> 0;
  }

  function defineMethod(obj, prop, fn, length) {
    if (!obj) return false;
    try {
      const origDesc = origGetOwnPropertyDescriptor(obj, prop);
      if (origDesc && origDesc.configurable === false && origDesc.writable === false) return false;
      const inferredLen = typeof length === 'number'
        ? length
        : (origDesc && typeof origDesc.value === 'function' ? origDesc.value.length : fn.length);
      const wrapped = makeNative(fn, prop, inferredLen);
      if (origDesc) {
        Object.defineProperty(obj, prop, {
          value: wrapped,
          writable: 'writable' in origDesc ? origDesc.writable : true,
          enumerable: origDesc.enumerable,
          configurable: origDesc.configurable,
        });
      } else {
        Object.defineProperty(obj, prop, {
          value: wrapped,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function defineGetter(obj, prop, getter, brandOptions) {
    if (!obj) return false;
    try {
      const origDesc = origGetOwnPropertyDescriptor(obj, prop);
      if (origDesc && origDesc.configurable === false) return false;
      const origGet = origDesc && typeof origDesc.get === 'function' ? origDesc.get : null;
      const expectedProto = brandOptions && brandOptions.proto ? brandOptions.proto : null;
      const expectedInstance = brandOptions && brandOptions.instance ? brandOptions.instance : null;
      const guardedGetter = function () {
        if (origGet) {
          // Run Gecko's genuine C++ WebIDL brand check on `this` first!
          const nativeVal = Reflect.apply(origGet, this, []);
          return getter.call(this, nativeVal);
        }
        if (expectedProto && (this === expectedProto || !this || (typeof this !== 'object' && typeof this !== 'function'))) {
          throw new TypeError('Illegal invocation');
        }
        if (expectedProto && expectedInstance && this !== expectedInstance && !expectedProto.isPrototypeOf(this)) {
          throw new TypeError('Illegal invocation');
        }
        return getter.call(this, origDesc ? origDesc.value : undefined);
      };
      const wrappedGetter = makeNative(guardedGetter, 'get ' + prop, 0);
      const nextDesc = {
        get: wrappedGetter,
        enumerable: origDesc ? origDesc.enumerable : true,
        configurable: origDesc ? origDesc.configurable : true,
      };
      if (origDesc && 'set' in origDesc) nextDesc.set = origDesc.set;
      Object.defineProperty(obj, prop, nextDesc);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ─── CANVAS ──────────────────────────────────────────────────────────────
  // Farble canvas reads the way Brave does: apply tiny, IMPERCEPTIBLE, seed-
  // determined noise to the *real* pixels instead of replacing them. This is
  // both correct for EFF and non-destructive for legitimate canvas use
  // (image editors, croppers, format converters, QR/chart exporters, etc.) —
  // with the caveat that exported bytes (toDataURL/toBlob) are imperceptibly
  // altered, see the README.
  //
  // Determinism is what makes this safe for EFF's twice-per-page probe: the
  // perturbation is a pure function of (seed, pixel position, source pixel
  // values). EFF draws the *same* probe canvas on both runs, so identical
  // source pixels + identical seed → byte-identical output → a stable hash
  // within the page. A different first-party origin has a different seed →
  // different noise → a different hash → the cross-domain difference EFF
  // rewards with the "randomized fingerprint" status.

  function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  function isTypedArray(value, name) {
    return Boolean(
      value &&
      typeof ArrayBuffer !== 'undefined' &&
      ArrayBuffer.isView(value) &&
      Object.prototype.toString.call(value) === '[object ' + name + ']',
    );
  }

  const TEXT_METRICS_SCALES = [
    ['width', 1.0, true],
    ['actualBoundingBoxLeft', 0.5, false],
    ['actualBoundingBoxRight', 0.5, false],
    ['actualBoundingBoxAscent', 0.25, false],
    ['actualBoundingBoxDescent', 0.25, false],
    ['fontBoundingBoxAscent', 0.25, false],
    ['fontBoundingBoxDescent', 0.25, false],
  ];

  function ensureTextMetricsPrototypePatched() {
    if (installationRegistry.textMetricsProtoPatched) return true;
    const TMClass = typeof TextMetrics !== 'undefined' ? TextMetrics : null;
    if (!TMClass || !TMClass.prototype) return false;
    let patchedAny = false;
    for (const [prop, scale, clampZero] of TEXT_METRICS_SCALES) {
      const desc = origGetOwnPropertyDescriptor(TMClass.prototype, prop);
      if (!desc || typeof desc.get !== 'function' || desc.configurable === false) continue;
      patchedAny = defineGetter(TMClass.prototype, prop, function (nativeVal) {
        if (typeof nativeVal !== 'number') return nativeVal;
        const delta = installationRegistry.textMetricsDeltas.get(this);
        if (typeof delta !== 'number') return nativeVal;
        const out = nativeVal + delta * scale;
        return clampZero ? Math.max(0, out) : out;
      }) || patchedAny;
    }
    if (patchedAny) installationRegistry.textMetricsProtoPatched = true;
    return patchedAny;
  }

  function hookMeasureText(proto) {
    // Coexist cleanly with Gecko RFP: avoid double font-metric collision when RFP already locks base fonts.
    if (RFP_ACTIVE) return;
    if (!proto || typeof proto.measureText !== 'function') return;
    const origMeasureText = proto.measureText;
    const useNativeProto = ensureTextMetricsPrototypePatched();
    defineMethod(proto, 'measureText', function measureText(text) {
      const metrics = Reflect.apply(origMeasureText, this, arguments);
      if (!metrics) return metrics;
      try {
        const fontStr = (this && typeof this.font === 'string') ? this.font : '';
        const textStr = String(text != null ? text : '');
        const h = mix(0x464F4E54, strHash(fontStr), strHash(textStr));
        const delta = ((((h & 0xFFFF) + 0.5) / 0x10000) - 0.5) * 0.03; // non-zero deterministic ±0.015px
        if (useNativeProto) {
          installationRegistry.textMetricsDeltas.set(metrics, delta);
          return metrics;
        }
        // Fallback for non-WebIDL test doubles (zero Proxy!)
        const clone = Object.create(Object.getPrototypeOf(metrics));
        for (const key of Reflect.ownKeys ? Reflect.ownKeys(metrics) : Object.keys(metrics)) {
          const d = origGetOwnPropertyDescriptor(metrics, key);
          if (d) Object.defineProperty(clone, key, d);
        }
        for (const [prop, scale, clampZero] of TEXT_METRICS_SCALES) {
          const val = metrics[prop];
          if (typeof val === 'number') {
            const nextVal = clampZero ? Math.max(0, val + delta * scale) : val + delta * scale;
            Object.defineProperty(clone, prop, {
              value: nextVal,
              writable: false,
              enumerable: true,
              configurable: true,
            });
          }
        }
        return clone;
      } catch (_) {
        return metrics;
      }
    }, 1);
  }

  function farblePixels(data, width, height, originX, originY, sourceWidth, sourceHeight) {
    if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;

    const pixelCount = Math.min(data.length / 4, width * height);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const index = pixelIndex * 4;
      // Never perturb transparent premultiplied pixels (alpha === 0): non-zero RGB
      // with alpha 0 is physically impossible in premultiplied canvas buffers and
      // triggers CreepJS/Castle transparent-pixel spoofing flags.
      if (data[index + 3] === 0) continue;
      const localX = pixelIndex % width;
      const localY = Math.floor(pixelIndex / width);
      const absoluteX = originX + localX;
      const absoluteY = originY + localY;
      const h = mix(
        absoluteX,
        absoluteY,
        sourceWidth,
        sourceHeight,
        data[index],
        data[index + 1],
        data[index + 2],
      );
      if ((h & 0x1f) === 0) {
        data[index]     = clampByte(data[index]     + ((h >>> 5)  % 3) - 1);
        data[index + 1] = clampByte(data[index + 1] + ((h >>> 11) % 3) - 1);
        data[index + 2] = clampByte(data[index + 2] + ((h >>> 17) % 3) - 1);
      }
    }
  }

  const isWorkerRealm = (typeof WorkerGlobalScope !== 'undefined' && pageGlobal instanceof WorkerGlobalScope) ||
    (typeof window === 'undefined' && typeof importScripts === 'function');

  function installCanvasProtection() {
    if (installationRegistry.installers.canvas) {
      return { installed: true, reason: 'already-installed' };
    }
    const Canvas2DClass = typeof CanvasRenderingContext2D !== 'undefined'
      ? CanvasRenderingContext2D
      : null;
    const CanvasElementClass = typeof HTMLCanvasElement !== 'undefined'
      ? HTMLCanvasElement
      : null;
    const DocumentClass = typeof Document !== 'undefined' ? Document : null;
    const Offscreen2DClass = typeof OffscreenCanvasRenderingContext2D !== 'undefined'
      ? OffscreenCanvasRenderingContext2D
      : null;
    const OffscreenCanvasClass = typeof OffscreenCanvas !== 'undefined'
      ? OffscreenCanvas
      : null;

    if (!isWorkerRealm) {
      if (!Canvas2DClass || !CanvasElementClass || !DocumentClass) {
        return { installed: false, reason: 'api-unavailable' };
      }
    } else if (!Offscreen2DClass && !OffscreenCanvasClass) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const origGetImageData = Canvas2DClass && Canvas2DClass.prototype ? Canvas2DClass.prototype.getImageData : null;
    const origToDataURL = CanvasElementClass && CanvasElementClass.prototype ? CanvasElementClass.prototype.toDataURL : null;
    const origToBlob = CanvasElementClass && CanvasElementClass.prototype ? CanvasElementClass.prototype.toBlob : null;
    const origGetContext = CanvasElementClass && CanvasElementClass.prototype ? CanvasElementClass.prototype.getContext : null;
    const origCreateElement = DocumentClass && DocumentClass.prototype ? DocumentClass.prototype.createElement : null;
    const origOffscreenGetContext = OffscreenCanvasClass && OffscreenCanvasClass.prototype
      ? OffscreenCanvasClass.prototype.getContext
      : null;
    const origOffscreenGetImageData = Offscreen2DClass && Offscreen2DClass.prototype
      ? Offscreen2DClass.prototype.getImageData
      : null;

    let scratchCanvas = null;
    let scratchCtx = null;

    function copyWebGLToImageData(gl, tctx, w, h) {
      if (!gl || typeof gl.readPixels !== 'function') return false;
      try {
        const pixels = new Uint8Array(w * h * 4);
        let boundFBO = null;
        if (typeof gl.getParameter === 'function' && typeof gl.bindFramebuffer === 'function') {
          boundFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          if (boundFBO) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (boundFBO && typeof gl.bindFramebuffer === 'function') {
          gl.bindFramebuffer(gl.FRAMEBUFFER, boundFBO);
        }
        let hasData = false;
        for (let i = 0; i < pixels.length; i++) {
          if (pixels[i] !== 0) { hasData = true; break; }
        }
        if (!hasData) return false;
        const id = tctx.createImageData(w, h);
        const rowBytes = w * 4;
        for (let y = 0; y < h; y++) {
          const srcOffset = (h - 1 - y) * rowBytes;
          const dstOffset = y * rowBytes;
          id.data.set(pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
        }
        // Note: if gl.readPixels was already wrapped by GhostPrint WebGL, do NOT double-farble;
        // only farble if WebGL surface was not active on this context.
        if (!installationRegistry.installers.webgl) {
          farblePixels(id.data, w, h, 0, 0, w, h);
        }
        tctx.putImageData(id, 0, 0);
        return true;
      } catch (_) {
        return false;
      }
    }

    function farbledCopy(src, reuseScratch) {
      const w = src.width, h = src.height;
      if (w <= 0 || h <= 0 || !origCreateElement || !origGetContext || !origGetImageData) return null;
      try {
        let tmp, tctx;
        if (reuseScratch) {
          if (scratchCanvas && !scratchCtx) scratchCanvas = null;
          if (!scratchCanvas) {
            scratchCanvas = origCreateElement.call(document, 'canvas');
            scratchCtx = origGetContext.call(scratchCanvas, '2d');
          }
          if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
            scratchCanvas.width = w;
            scratchCanvas.height = h;
          }
          tmp = scratchCanvas;
          tctx = scratchCtx;
        } else {
          tmp = origCreateElement.call(document, 'canvas');
          tmp.width = w;
          tmp.height = h;
          tctx = origGetContext.call(tmp, '2d');
        }
        if (!tctx) return null;

        let gl = installationRegistry.canvasWebGLContexts
          ? installationRegistry.canvasWebGLContexts.get(src)
          : null;
        if (!gl) {
          try {
            gl = origGetContext.call(src, 'webgl2') ||
                 origGetContext.call(src, 'webgl') ||
                 origGetContext.call(src, 'experimental-webgl');
          } catch (_) {}
        }

        const copiedFromWebGL = copyWebGLToImageData(gl, tctx, w, h);
        if (!copiedFromWebGL) {
          tctx.drawImage(src, 0, 0);
          const id = origGetImageData.call(tctx, 0, 0, w, h);
          if (gl) {
            let hasData = false;
            for (let i = 0; i < id.data.length; i++) {
              if (id.data[i] !== 0) { hasData = true; break; }
            }
            if (!hasData) return null;
          }
          farblePixels(id.data, w, h, 0, 0, w, h);
          tctx.putImageData(id, 0, 0);
        }
        return tmp;
      } catch (_) {
        return null;
      }
    }

    try {
      let installedPrimary = false;
      if (Canvas2DClass && Canvas2DClass.prototype && typeof origGetImageData === 'function') {
        if (!defineMethod(Canvas2DClass.prototype, 'getImageData', function getImageData() {
          const imageData = Reflect.apply(origGetImageData, this, arguments);
          try {
            const settings = arguments[4];
            const pixelFormat = settings && settings.pixelFormat;
            const data = imageData && imageData.data;
            if (pixelFormat && pixelFormat !== 'rgba-unorm8') return imageData;
            if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return imageData;

            const width = toInteger(imageData.width);
            const height = toInteger(imageData.height);
            const sourceCanvas = this && this.canvas;
            const sourceWidth = toInteger(sourceCanvas && sourceCanvas.width);
            const sourceHeight = toInteger(sourceCanvas && sourceCanvas.height);
            if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return imageData;

            const requestedX = toInteger(arguments[0]);
            const requestedY = toInteger(arguments[1]);
            const originX = toInteger(arguments[2]) < 0 ? requestedX - width : requestedX;
            const originY = toInteger(arguments[3]) < 0 ? requestedY - height : requestedY;
            farblePixels(data, width, height, originX, originY, sourceWidth, sourceHeight);
          } catch (_) {}
          return imageData;
        }, 4)) {
          return { installed: false, reason: 'installer-error' };
        }
        installedPrimary = true;
      }

      if (Canvas2DClass && Canvas2DClass.prototype && typeof Canvas2DClass.prototype.measureText === 'function') {
        hookMeasureText(Canvas2DClass.prototype);
      }

      if (CanvasElementClass && CanvasElementClass.prototype &&
          typeof origToDataURL === 'function' &&
          typeof origCreateElement === 'function' &&
          typeof origGetContext === 'function' &&
          typeof origGetImageData === 'function') {
        if (!defineMethod(CanvasElementClass.prototype, 'toDataURL', function toDataURL() {
          const copy = farbledCopy(this, true);
          if (copy) return Reflect.apply(origToDataURL, copy, arguments);
          return Reflect.apply(origToDataURL, this, arguments);
        }, 0)) {
          return { installed: false, reason: 'installer-error' };
        }
      }

      if (CanvasElementClass && CanvasElementClass.prototype &&
          typeof origToBlob === 'function' &&
          typeof origCreateElement === 'function' &&
          typeof origGetContext === 'function' &&
          typeof origGetImageData === 'function') {
        if (!defineMethod(CanvasElementClass.prototype, 'toBlob', function toBlob() {
          const copy = farbledCopy(this, false);
          if (copy) return Reflect.apply(origToBlob, copy, arguments);
          return Reflect.apply(origToBlob, this, arguments);
        }, 1)) {
          return { installed: false, reason: 'installer-error' };
        }
      }

      if (Offscreen2DClass && Offscreen2DClass.prototype) {
        if (typeof Offscreen2DClass.prototype.measureText === 'function') {
          hookMeasureText(Offscreen2DClass.prototype);
        }
        if (typeof origOffscreenGetImageData === 'function') {
          const ok = defineMethod(Offscreen2DClass.prototype, 'getImageData', function getImageData() {
            const imageData = Reflect.apply(origOffscreenGetImageData, this, arguments);
            try {
              const settings = arguments[4];
              const pixelFormat = settings && settings.pixelFormat;
              const data = imageData && imageData.data;
              if (pixelFormat && pixelFormat !== 'rgba-unorm8') return imageData;
              if (!isTypedArray(data, 'Uint8ClampedArray') || data.length % 4 !== 0) return imageData;

              const width = toInteger(imageData.width);
              const height = toInteger(imageData.height);
              const sourceCanvas = this && this.canvas;
              const sourceWidth = toInteger(sourceCanvas && sourceCanvas.width) || width;
              const sourceHeight = toInteger(sourceCanvas && sourceCanvas.height) || height;
              if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return imageData;

              const requestedX = toInteger(arguments[0]);
              const requestedY = toInteger(arguments[1]);
              const originX = toInteger(arguments[2]) < 0 ? requestedX - width : requestedX;
              const originY = toInteger(arguments[3]) < 0 ? requestedY - height : requestedY;
              farblePixels(data, width, height, originX, originY, sourceWidth, sourceHeight);
            } catch (_) {}
            return imageData;
          }, 4);
          installedPrimary = ok || installedPrimary;
        }
      }

      if (OffscreenCanvasClass && OffscreenCanvasClass.prototype &&
          typeof OffscreenCanvasClass.prototype.convertToBlob === 'function') {
        const origConvertToBlob = OffscreenCanvasClass.prototype.convertToBlob;
        const ok = defineMethod(OffscreenCanvasClass.prototype, 'convertToBlob', function convertToBlob() {
          try {
            const w = this.width, h = this.height;
            if (w > 0 && h > 0 && typeof OffscreenCanvasClass === 'function') {
              const snapshot = new OffscreenCanvasClass(w, h);
              const sctx = origOffscreenGetContext
                ? origOffscreenGetContext.call(snapshot, '2d')
                : snapshot.getContext('2d');
              if (sctx && typeof sctx.putImageData === 'function') {
                const gl = installationRegistry.canvasWebGLContexts
                  ? installationRegistry.canvasWebGLContexts.get(this)
                  : null;
                const copiedGL = copyWebGLToImageData(gl, sctx, w, h);
                if (!copiedGL && typeof sctx.drawImage === 'function') {
                  sctx.drawImage(this, 0, 0);
                  if (origOffscreenGetImageData) {
                    const id = origOffscreenGetImageData.call(sctx, 0, 0, w, h);
                    farblePixels(id.data, w, h, 0, 0, w, h);
                    sctx.putImageData(id, 0, 0);
                  } else if (typeof sctx.getImageData === 'function') {
                    // Already farbled once by hooked getImageData
                    const id = sctx.getImageData(0, 0, w, h);
                    sctx.putImageData(id, 0, 0);
                  }
                }
                return Reflect.apply(origConvertToBlob, snapshot, arguments);
              }
            }
          } catch (_) {}
          return Reflect.apply(origConvertToBlob, this, arguments);
        }, 0);
        installedPrimary = ok || installedPrimary;
      }

      if (!installedPrimary) {
        return { installed: false, reason: 'installer-error' };
      }
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }

    installationRegistry.installers.canvas = true;
    return { installed: true };
  }

  // ─── WEBGL ───────────────────────────────────────────────────────────────
  // Fingerprint2 reads the rendered WebGL canvas via gl.canvas.toDataURL()
  // — the canvas override above handles that. We also farble readPixels for
  // fingerprinters that use it directly.
  //
  // Only RGBA + UNSIGNED_BYTE buffers are perturbed: that is the byte layout
  // (4 bytes/pixel) the nudge loop assumes. Other format/type combos (e.g.
  // RGB with 3 bytes/pixel, or float buffers) are left untouched so a ±1
  // nudge can't misalign and corrupt legitimate reads.
  function installWebGLProtection() {
    if (installationRegistry.installers.webgl) {
      return { installed: true, reason: 'already-installed' };
    }
    const contextSources = [];
    if (typeof HTMLCanvasElement !== 'undefined' &&
        typeof HTMLCanvasElement.prototype.getContext === 'function') {
      contextSources.push(HTMLCanvasElement);
    }
    if (typeof OffscreenCanvas !== 'undefined' &&
        typeof OffscreenCanvas.prototype.getContext === 'function') {
      contextSources.push(OffscreenCanvas);
    }
    const webglClasses = [];
    if (typeof WebGLRenderingContext !== 'undefined') webglClasses.push(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') webglClasses.push(WebGL2RenderingContext);
    if (contextSources.length === 0 && webglClasses.length === 0) {
      return { installed: false, reason: 'api-unavailable' };
    }
    const patchedWebGLContexts = installationRegistry.patchedWebGLContexts;
    const webglContextStates = new WeakMap();
    const patchedWebGLPrototypes = new WeakSet();
    const SYNTHETIC_EXTENSION_PARTS = Object.freeze({
      subjects: Object.freeze(['surface', 'raster', 'frame', 'pixel', 'shader', 'buffer', 'vector']),
      roles: Object.freeze(['pipeline', 'resolver', 'allocator']),
    });

    function resolvePlatformGPUPool() {
      let plat = '';
      try {
        plat = typeof navigator !== 'undefined' && navigator
          ? String(navigator.platform || navigator.userAgent || '').toLowerCase()
          : '';
      } catch (_) {}
      if (plat.includes('mac') || plat.includes('darwin')) {
        return [
          { vendor: 'Apple', renderer: 'Apple M1' },
          { vendor: 'Apple', renderer: 'Apple M2' },
          { vendor: 'Apple', renderer: 'Apple M3' },
        ];
      }
      if (plat.includes('win')) {
        return [
          { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
          { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
          { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ];
      }
      // Linux / Unix / generic X11 & Wayland Mesa/OpenGL profiles
      return [
        { vendor: 'Intel', renderer: 'Mesa Intel(R) Graphics (ADL GT2)' },
        { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2' },
        { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2' },
        { vendor: 'AMD', renderer: 'AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6, DRM 3.54)' },
      ];
    }

    const REALISTIC_GPUS = Object.freeze(resolvePlatformGPUPool());

    function syntheticExtensionPool() {
      const pool = [];
      for (const subject of SYNTHETIC_EXTENSION_PARTS.subjects) {
        for (const role of SYNTHETIC_EXTENSION_PARTS.roles) {
          const name = 'EXT_' + subject + '_' + role;
          const objectName = name
            .toLowerCase()
            .split('_')
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
          pool.push({ name, objectName });
        }
      }
      return pool;
    }

    const SYNTHETIC_EXTENSIONS = Object.freeze(syntheticExtensionPool());

    function createSyntheticExtensionObject(objectName) {
      const extension = {};
      if (typeof Symbol === 'function' && Symbol.toStringTag) {
        try {
          Object.defineProperty(extension, Symbol.toStringTag, {
            value: objectName,
            configurable: false,
            enumerable: false,
            writable: false,
          });
        } catch (_) {}
      }
      return extension;
    }

    function getWebGLContextState(ctx) {
      let state = webglContextStates.get(ctx);
      if (!state) {
        state = {
          syntheticExtension: null,
          syntheticExtensionObject: null,
          supportedExtensions: null,
        };
        webglContextStates.set(ctx, state);
      }
      return state;
    }

    function cacheSyntheticExtension(state, realExtensions) {
      if (state.syntheticExtension) return true;
      if (!Array.isArray(realExtensions)) return false;

      const realNames = new Set(realExtensions.map((name) => String(name).toLowerCase()));
      const start = mix(0x57454247) % SYNTHETIC_EXTENSIONS.length;
      for (let offset = 0; offset < SYNTHETIC_EXTENSIONS.length; offset += 1) {
        const candidate = SYNTHETIC_EXTENSIONS[(start + offset) % SYNTHETIC_EXTENSIONS.length];
        if (!realNames.has(candidate.name.toLowerCase())) {
          state.syntheticExtension = candidate;
          state.syntheticExtensionObject = createSyntheticExtensionObject(candidate.objectName);
          state.supportedExtensions = realExtensions.concat(candidate.name);
          return true;
        }
      }
      return false;
    }

    function farbleWebGLReadPixels(ctx, args) {
      const originX = toInteger(args[0]);
      const originY = toInteger(args[1]);
      const width = toInteger(args[2]);
      const height = toInteger(args[3]);
      const format = args[4];
      const type = args[5];
      const pixels = args[6];
      // WebGL 2 also accepts a numeric PBO offset in args[6]. Only typed-array
      // reads expose bytes that this wrapper can safely post-process.
      const dstOffset = typeof args[7] === 'number' ? toInteger(args[7]) : 0;
      const byteCount = width > 0 && height > 0 ? width * height * 4 : 0;
      const start = Math.max(0, dstOffset);
      const end = Math.min(pixels && pixels.length, start + byteCount);
      if (byteCount <= 0 || !pixels || format !== ctx.RGBA || type !== ctx.UNSIGNED_BYTE ||
          (!isTypedArray(pixels, 'Uint8Array') && !isTypedArray(pixels, 'Uint8ClampedArray'))) {
        return;
      }
      const canvasW = toInteger(ctx && ctx.drawingBufferWidth) || toInteger(ctx && ctx.canvas && ctx.canvas.width) || width;
      const canvasH = toInteger(ctx && ctx.drawingBufferHeight) || toInteger(ctx && ctx.canvas && ctx.canvas.height) || height;
      for (let i = start; i + 3 < end; i += 4) {
        if (pixels[i + 3] === 0) continue;
        const pIdx = (i - start) >>> 2;
        const absX = originX + (pIdx % width);
        const absY = originY + Math.floor(pIdx / width);
        const hash = mix(absX, absY, canvasW, canvasH, pixels[i], pixels[i + 1], pixels[i + 2]);
        if ((hash & 0x1f) === 0) {
          pixels[i] = clampByte(pixels[i] + ((hash >>> 5) % 3) - 1);
          pixels[i + 1] = clampByte(pixels[i + 1] + ((hash >>> 11) % 3) - 1);
          pixels[i + 2] = clampByte(pixels[i + 2] + ((hash >>> 17) % 3) - 1);
        }
      }
    }

    function ensureShaderPrecisionPrototypePatched() {
      if (installationRegistry.shaderPrecisionProtoPatched) return true;
      const SPFClass = typeof WebGLShaderPrecisionFormat !== 'undefined' ? WebGLShaderPrecisionFormat : null;
      if (!SPFClass || !SPFClass.prototype) return false;
      const desc = origGetOwnPropertyDescriptor(SPFClass.prototype, 'precision');
      if (!desc || typeof desc.get !== 'function' || desc.configurable === false) return false;
      const ok = defineGetter(SPFClass.prototype, 'precision', function (nativeVal) {
        if (installationRegistry.shaderPrecisionValues.has(this)) {
          return installationRegistry.shaderPrecisionValues.get(this);
        }
        return nativeVal;
      });
      if (ok) installationRegistry.shaderPrecisionProtoPatched = true;
      return ok;
    }

    function replaceMethod(target, name, applyTrap) {
      let descriptor = origGetOwnPropertyDescriptor(target, name);
      let owner = target;
      while (!descriptor && owner) {
        owner = Object.getPrototypeOf(owner);
        if (owner) descriptor = origGetOwnPropertyDescriptor(owner, name);
      }
      if (owner !== target && owner && patchedWebGLPrototypes.has(owner)) {
        return true;
      }
      const original = descriptor && typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
      if (!original) return false;
      const replacement = makeNative(({
        [name]() {
          return applyTrap(original, this, arguments);
        },
      })[name], name, original.length);
      try {
        Object.defineProperty(target, name, {
          value: replacement,
          writable: 'writable' in descriptor ? descriptor.writable : true,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
        return true;
      } catch (_) {
        return false;
      }
    }

    function patchWebGLPrototype(proto) {
      if (!proto || patchedWebGLPrototypes.has(proto)) return false;
      const nativeGetSupportedExtensions = typeof proto.getSupportedExtensions === 'function'
        ? proto.getSupportedExtensions
        : null;
      if (!nativeGetSupportedExtensions || typeof proto.getExtension !== 'function') return false;
      const methodNames = ['readPixels', 'getParameter', 'getSupportedExtensions', 'getExtension'];
      if (typeof proto.getShaderPrecisionFormat === 'function') methodNames.push('getShaderPrecisionFormat');
      if (typeof proto.getBufferSubData === 'function') methodNames.push('getBufferSubData');
      const originalDescriptors = new Map(
        methodNames.map((name) => [name, origGetOwnPropertyDescriptor(proto, name)]),
      );
      const useNativePrecisionProto = ensureShaderPrecisionPrototypePatched();

      const installedMethods = [];
      installedMethods.push(replaceMethod(proto, 'readPixels', (target, thisArg, args) => {
        const result = Reflect.apply(target, thisArg, args);
        farbleWebGLReadPixels(thisArg, args);
        return result;
      }));
      installedMethods.push(replaceMethod(proto, 'getParameter', (target, thisArg, args) => {
        const value = Reflect.apply(target, thisArg, args);
        const parameter = args[0];
        if (parameter === 0x1F00 || parameter === 0x1F01) return 'Mozilla';
        if (parameter === 0x9245 && value !== null) {
          if (MODE !== 'strict' && typeof value === 'string' && value.length > 0 && value !== 'Mozilla') {
            return value;
          }
          const gpuIdx = mix(0x57475055) % REALISTIC_GPUS.length;
          return REALISTIC_GPUS[gpuIdx].vendor;
        }
        if (parameter === 0x9246 && value !== null) {
          if (MODE !== 'strict' && typeof value === 'string' && value.length > 0 && value !== 'Mozilla') {
            return value;
          }
          const gpuIdx = mix(0x57475055) % REALISTIC_GPUS.length;
          return REALISTIC_GPUS[gpuIdx].renderer;
        }

        // Integer capabilities farbling
        if (typeof value === 'number' && value > 0) {
          if (parameter === 0x0D33 || parameter === 0x851C || parameter === 0x84E8 ||
              parameter === 0x8869 || parameter === 0x8DFB || parameter === 0x8DFC ||
              parameter === 0x8B4D) {
            return (mix(0x57474C31, parameter) & 1) ? value - 1 : value;
          }
        }

        // Dimension / range farbling
        if (parameter === 0x0D3A || parameter === 0x846E || parameter === 0x846D) {
          if (value && ArrayBuffer.isView(value) && value.length >= 2) {
            try {
              const copy = new value.constructor(value);
              if (mix(0x57474C32, parameter) & 1) {
                copy[1] = Math.max(copy[0], copy[1] - 1);
              }
              return copy;
            } catch (_) {}
          }
        }

        return value;
      }));
      installedMethods.push(replaceMethod(
        proto,
        'getSupportedExtensions',
        (target, thisArg, args) => {
          const realExtensions = Reflect.apply(target, thisArg, args);
          if (!Array.isArray(realExtensions)) return realExtensions;
          const state = getWebGLContextState(thisArg);
          cacheSyntheticExtension(state, realExtensions);
          return state.supportedExtensions ? state.supportedExtensions.slice() : realExtensions.slice();
        },
      ));
      installedMethods.push(replaceMethod(proto, 'getExtension', (target, thisArg, args) => {
        const state = getWebGLContextState(thisArg);
        if (!state.syntheticExtension) {
          const realExtensions = Reflect.apply(nativeGetSupportedExtensions, thisArg, []);
          cacheSyntheticExtension(state, realExtensions);
        }
        const requestedName = '' + args[0];
        if (state.syntheticExtension &&
            requestedName.toLowerCase() === state.syntheticExtension.name.toLowerCase()) {
          return state.syntheticExtensionObject;
        }
        return Reflect.apply(target, thisArg, args);
      }));
      if (typeof proto.getShaderPrecisionFormat === 'function') {
        installedMethods.push(replaceMethod(proto, 'getShaderPrecisionFormat', (target, thisArg, args) => {
          const format = Reflect.apply(target, thisArg, args);
          if (!format) return format;
          const shaderType = toInteger(args[0]);
          const precisionType = toInteger(args[1]);
          const h = mix(0x50524543, shaderType, precisionType);
          const delta = (h % 3) - 1;
          const origPrecision = toInteger(format.precision);
          const newPrecision = Math.max(0, origPrecision + delta);
          if (useNativePrecisionProto) {
            installationRegistry.shaderPrecisionValues.set(format, newPrecision);
            return format;
          }
          const clone = Object.create(Object.getPrototypeOf(format));
          Object.defineProperties(clone, {
            rangeMin: { value: format.rangeMin, enumerable: true, configurable: true },
            rangeMax: { value: format.rangeMax, enumerable: true, configurable: true },
            precision: { value: newPrecision, enumerable: true, configurable: true },
          });
          return clone;
        }));
      }
      if (typeof proto.getBufferSubData === 'function') {
        installedMethods.push(replaceMethod(proto, 'getBufferSubData', (target, thisArg, args) => {
          const result = Reflect.apply(target, thisArg, args);
          try {
            const glTarget = args[0];
            const PIXEL_PACK_BUFFER = (thisArg && thisArg.PIXEL_PACK_BUFFER) || 0x88EB;
            if (glTarget === PIXEL_PACK_BUFFER || glTarget === 0x88EB) {
              const dstData = args[2];
              const dstOffset = typeof args[3] === 'number' ? toInteger(args[3]) : 0;
              const length = typeof args[4] === 'number' ? toInteger(args[4]) : 0;
              if (dstData && ArrayBuffer.isView(dstData)) {
                const bpe = dstData.BYTES_PER_ELEMENT || 1;
                const byteOffset = dstData.byteOffset + dstOffset * bpe;
                const byteLength = length > 0
                  ? length * bpe
                  : dstData.byteLength - dstOffset * bpe;
                if (byteLength > 0 && byteOffset >= 0 && byteOffset + byteLength <= dstData.buffer.byteLength) {
                  const bytes = new Uint8Array(dstData.buffer, byteOffset, byteLength);
                  for (let i = 0; i + 3 < bytes.length; i += 4) {
                    if (bytes[i + 3] === 0) continue;
                    const pixelIndex = i >>> 2;
                    const hash = mix(0x50424F, pixelIndex, bytes[i], bytes[i + 1], bytes[i + 2]);
                    if ((hash & 0x1f) === 0) {
                      bytes[i] = clampByte(bytes[i] + ((hash >>> 5) % 3) - 1);
                      bytes[i + 1] = clampByte(bytes[i + 1] + ((hash >>> 11) % 3) - 1);
                      bytes[i + 2] = clampByte(bytes[i + 2] + ((hash >>> 17) % 3) - 1);
                    }
                  }
                }
              }
            }
          } catch (_) {}
          return result;
        }));
      }
      if (installedMethods.some((installed) => !installed)) {
        for (const name of methodNames) {
          const descriptor = originalDescriptors.get(name);
          try {
            if (descriptor) Object.defineProperty(proto, name, descriptor);
            else delete proto[name];
          } catch (_) {}
        }
        return false;
      }
      patchedWebGLPrototypes.add(proto);
      return true;
    }

    for (const WebGLClass of webglClasses) patchWebGLPrototype(WebGLClass.prototype);

    function contextUsesPatchedPrototype(ctx) {
      for (const WebGLClass of webglClasses) {
        try {
          if (ctx instanceof WebGLClass && patchedWebGLPrototypes.has(WebGLClass.prototype)) return true;
        } catch (_) {}
      }
      return false;
    }

    function patchWebGLContext(ctx) {
      if (patchedWebGLContexts.has(ctx) || !ctx || typeof ctx.readPixels !== 'function') return;
      patchedWebGLContexts.add(ctx);
      getWebGLContextState(ctx);
      if (contextUsesPatchedPrototype(ctx)) return;
      patchWebGLPrototype(ctx);
    }

    for (const ContextSource of contextSources) {
      const originalGetContext = ContextSource.prototype.getContext;
      defineMethod(ContextSource.prototype, 'getContext', function getContext() {
        const type = arguments[0];
        const ctx = Reflect.apply(originalGetContext, this, arguments);
        if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
          if (installationRegistry.canvasWebGLContexts) {
            installationRegistry.canvasWebGLContexts.set(this, ctx);
          }
          patchWebGLContext(ctx);
        }
        return ctx;
      }, 1);
    }

    installationRegistry.installers.webgl = true;
    return { installed: true };
  }

  // ─── WEBGPU ──────────────────────────────────────────────────────────────
  // Brave 1.93 empties the three stable hardware identifiers that ship in
  // GPUAdapterInfo. Keep adapter/device capabilities and methods untouched.
  function installWebGPUProtection() {
    if (installationRegistry.installers.webgpu) {
      return { installed: true, reason: 'already-installed' };
    }

    const GPUAdapterInfoClass = typeof GPUAdapterInfo !== 'undefined' ? GPUAdapterInfo : null;
    const GPUAdapterClass = typeof GPUAdapter !== 'undefined' ? GPUAdapter : null;
    const GPUDeviceClass = typeof GPUDevice !== 'undefined' ? GPUDevice : null;
    let gpuObject = null;
    try {
      gpuObject = typeof navigator !== 'undefined' ? navigator.gpu : null;
    } catch (_) {}
    if (!GPUAdapterInfoClass && !GPUAdapterClass && !GPUDeviceClass && !gpuObject) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const protectedInfoObjects = new WeakMap();
    const protectedAdapterPrototypes = new WeakSet();
    const protectedDevicePrototypes = new WeakSet();

    function replaceGetter(proto, property, transform) {
      if (!proto) return false;
      const descriptor = origGetOwnPropertyDescriptor(proto, property);
      if (!descriptor || typeof descriptor.get !== 'function' || descriptor.configurable === false) {
        return false;
      }
      const original = descriptor.get;
      const replacement = makeNative(({
        ['get ' + property]() {
          return transform(Reflect.apply(original, this, arguments));
        },
      })['get ' + property], 'get ' + property, 0);
      try {
        Object.defineProperty(proto, property, { ...descriptor, get: replacement });
        return true;
      } catch (_) {
        return false;
      }
    }

    const scrubbedProperties = ['vendor', 'architecture', 'device'];
    const protectedPrototypeProperties = new Set();
    if (GPUAdapterInfoClass && GPUAdapterInfoClass.prototype) {
      for (const property of scrubbedProperties) {
        if (replaceGetter(GPUAdapterInfoClass.prototype, property, () => '')) {
          protectedPrototypeProperties.add(property);
        }
      }
    }

    function protectAdapterInfo(info) {
      if (!info || (typeof info !== 'object' && typeof info !== 'function')) return info;
      if (protectedInfoObjects.has(info)) return protectedInfoObjects.get(info);
      if (protectedPrototypeProperties.size === scrubbedProperties.length &&
          (!GPUAdapterInfoClass || info instanceof GPUAdapterInfoClass)) {
        protectedInfoObjects.set(info, info);
        return info;
      }
      const proto = Object.getPrototypeOf(info);
      if (proto && proto !== Object.prototype) {
        let protoScrubbed = 0;
        for (const property of scrubbedProperties) {
          if (replaceGetter(proto, property, () => '')) protoScrubbed += 1;
        }
        if (protoScrubbed === scrubbedProperties.length) {
          protectedInfoObjects.set(info, info);
          return info;
        }
      }
      const clone = Object.create(proto || Object.prototype);
      for (const key of (origReflectOwnKeys ? origReflectOwnKeys(info) : Object.keys(info))) {
        if (scrubbedProperties.includes(key)) continue;
        const d = origGetOwnPropertyDescriptor(info, key);
        if (d) Object.defineProperty(clone, key, d);
      }
      for (const property of scrubbedProperties) {
        Object.defineProperty(clone, property, {
          value: '',
          writable: false,
          enumerable: true,
          configurable: true,
        });
      }
      protectedInfoObjects.set(info, clone);
      return clone;
    }

    function replacePromiseMethod(proto, property, transform) {
      if (!proto) return false;
      let descriptor = origGetOwnPropertyDescriptor(proto, property);
      let owner = proto;
      while (!descriptor && owner) {
        owner = Object.getPrototypeOf(owner);
        if (owner) descriptor = origGetOwnPropertyDescriptor(owner, property);
      }
      if (!descriptor || typeof descriptor.value !== 'function') return false;
      const original = descriptor.value;
      const replacement = makeNative(({
        [property]() {
          const result = Reflect.apply(original, this, arguments);
          return result && typeof result.then === 'function' ? result.then(transform) : result;
        },
      })[property], property, original.length);
      try {
        Object.defineProperty(proto, property, {
          value: replacement,
          writable: 'writable' in descriptor ? descriptor.writable : true,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
        return true;
      } catch (_) {
        return false;
      }
    }

    function protectDevice(device) {
      if (!device || (typeof device !== 'object' && typeof device !== 'function')) return device;
      const proto = Object.getPrototypeOf(device);
      if (proto && !protectedDevicePrototypes.has(proto)) {
        replaceGetter(proto, 'adapterInfo', protectAdapterInfo);
        protectedDevicePrototypes.add(proto);
      }
      return device;
    }

    function protectAdapter(adapter) {
      if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter;
      const proto = Object.getPrototypeOf(adapter);
      if (proto && !protectedAdapterPrototypes.has(proto)) {
        replaceGetter(proto, 'info', protectAdapterInfo);
        replacePromiseMethod(proto, 'requestDevice', protectDevice);
        protectedAdapterPrototypes.add(proto);
      }
      return adapter;
    }

    let installed = protectedPrototypeProperties.size > 0;
    let adapterInfoGetterInstalled = false;
    let deviceInfoGetterInstalled = false;
    if (GPUAdapterClass && GPUAdapterClass.prototype) {
      adapterInfoGetterInstalled = replaceGetter(
        GPUAdapterClass.prototype,
        'info',
        protectAdapterInfo,
      );
      installed = adapterInfoGetterInstalled || installed;
    }
    if (GPUDeviceClass && GPUDeviceClass.prototype) {
      deviceInfoGetterInstalled = replaceGetter(
        GPUDeviceClass.prototype,
        'adapterInfo',
        protectAdapterInfo,
      );
      installed = deviceInfoGetterInstalled || installed;
    }
    if (gpuObject && (!adapterInfoGetterInstalled || !deviceInfoGetterInstalled)) {
      const gpuProto = Object.getPrototypeOf(gpuObject);
      installed = replacePromiseMethod(gpuProto, 'requestAdapter', protectAdapter) || installed;
    }

    if (!installed) return { installed: false, reason: 'descriptors-unavailable' };
    installationRegistry.installers.webgpu = true;
    return { installed: true };
  }

  function installAudioProtection() {
    if (installationRegistry.installers.audio) {
      return { installed: true, reason: 'already-installed' };
    }
    const pageWindow = typeof window !== 'undefined' ? window : (typeof pageGlobal !== 'undefined' ? pageGlobal : null);
    if (!pageWindow) return { installed: false, reason: 'api-unavailable' };

    // Protect each available read surface independently. AudioBuffer samples are
    // copied into a stable farbled view only after the native read succeeds, so
    // getChannelData/copyFromChannel observe the same view without mutating the
    // native buffer backing audio playback.
    const OfflineAudioCtxClass = pageWindow.OfflineAudioContext || pageWindow.webkitOfflineAudioContext;
    const AudioCtxClass = pageWindow.AudioContext || pageWindow.webkitAudioContext;
    const AudioBufferClass = pageWindow.AudioBuffer;
    const AnalyserNodeClass = pageWindow.AnalyserNode;
    if (!OfflineAudioCtxClass && !AudioCtxClass && !AudioBufferClass && !AnalyserNodeClass) {
      return { installed: false, reason: 'api-unavailable' };
    }
    const origGetChannelData = AudioBufferClass && AudioBufferClass.prototype
      ? AudioBufferClass.prototype.getChannelData
      : null;
    const audioBufferStates = new WeakMap();
    const patchedAnalyserNodes = new WeakSet();

    function getAudioBufferState(buffer) {
      let state = audioBufferStates.get(buffer);
      if (!state) {
        state = { farbledChannels: new Map() };
        audioBufferStates.set(buffer, state);
      }
      return state;
    }

    const AUDIO_DITHER_SCALE = MODE === 'strict' ? 1.2e-5 : 3.5e-6;

    function farbleAudioRange(data, channel, start, end, logicalStart = start) {
      if (!isTypedArray(data, 'Float32Array')) return;
      const first = Math.max(0, toInteger(start));
      const last = Math.min(data.length, Math.max(first, toInteger(end)));
      const logicalBase = toInteger(logicalStart);
      for (let i = first; i < last; i += 1) {
        const value = data[i];
        if (!Number.isFinite(value)) continue;
        const h = mix(0xA710, channel, logicalBase + (i - first));
        if ((h & 0xff) < 8) {
          const rawDelta = ((h / 0x100000000) - 0.5) * AUDIO_DITHER_SCALE;
          const delta = rawDelta === 0 ? AUDIO_DITHER_SCALE * 0.25 : rawDelta;
          let next = value + delta;
          if (value >= -1.0 && value <= 1.0) {
            if (next > 1.0) next = value - Math.abs(delta);
            else if (next < -1.0) next = value + Math.abs(delta);
          }
          data[i] = next;
        }
      }
    }

    function cloneFarbledAudioChannel(data, channel) {
      if (!isTypedArray(data, 'Float32Array')) return data;
      const copy = new Float32Array(data.length);
      copy.set(data);
      farbleAudioRange(copy, channel, 0, copy.length);
      return copy;
    }

    function farbleWholeAudioChannel(buffer, state, originalGetChannelData, channel) {
      const cached = state.farbledChannels.get(channel);
      if (cached) return cached;
      const data = Reflect.apply(originalGetChannelData, buffer, [channel]);
      const farbled = cloneFarbledAudioChannel(data, channel);
      if (farbled !== data) state.farbledChannels.set(channel, farbled);
      return farbled;
    }

    function patchAudioBufferPrototype() {
      if (!AudioBufferClass || !AudioBufferClass.prototype) return;
      const proto = AudioBufferClass.prototype;
      const originalGetChannelData = typeof proto.getChannelData === 'function'
        ? proto.getChannelData
        : null;
      const originalCopyFromChannel = typeof proto.copyFromChannel === 'function'
        ? proto.copyFromChannel
        : null;
      const originalCopyToChannel = typeof proto.copyToChannel === 'function'
        ? proto.copyToChannel
        : null;

      if (originalGetChannelData) {
        defineMethod(proto, 'getChannelData', function getChannelData() {
          const data = Reflect.apply(originalGetChannelData, this, arguments);
          try {
            const state = getAudioBufferState(this);
            const channel = toInteger(arguments[0]);
            const farbled = state.farbledChannels.get(channel) ||
              cloneFarbledAudioChannel(data, channel);
            if (farbled !== data) state.farbledChannels.set(channel, farbled);
            return farbled;
          } catch (_) {}
          return data;
        }, 1);
      }

      if (originalCopyFromChannel) {
        defineMethod(proto, 'copyFromChannel', function copyFromChannel() {
          const result = Reflect.apply(originalCopyFromChannel, this, arguments);
          try {
            const destination = arguments[0];
            const channel = toInteger(arguments[1]);
            const start = toInteger(arguments[2]);
            const state = getAudioBufferState(this);
            let sourceData = null;
            if (originalGetChannelData) {
              sourceData = farbleWholeAudioChannel(this, state, originalGetChannelData, channel);
              if (!sourceData) sourceData = Reflect.apply(originalGetChannelData, this, [channel]);
              if (destination && typeof destination.length === 'number' && sourceData) {
                const count = Math.min(destination.length, sourceData.length - start);
                for (let i = 0; i < count; i += 1) destination[i] = sourceData[start + i];
              }
            } else {
              const count = destination && typeof destination.length === 'number'
                ? destination.length
                : 0;
              farbleAudioRange(destination, channel, 0, count, start);
            }
          } catch (_) {}
          return result;
        }, 2);
      }

      if (originalCopyToChannel) {
        defineMethod(proto, 'copyToChannel', function copyToChannel() {
          const result = Reflect.apply(originalCopyToChannel, this, arguments);
          if (originalGetChannelData) try {
            const source = arguments[0];
            const channel = toInteger(arguments[1]);
            const start = toInteger(arguments[2]);
            const state = getAudioBufferState(this);
            const farbled = state.farbledChannels.get(channel);
            if (farbled) {
              const data = Reflect.apply(originalGetChannelData, this, [channel]);
              const count = source && typeof source.length === 'number' ? source.length : 0;
              const first = Math.max(0, start);
              const last = Math.min(farbled.length, first + count);
              for (let index = first; index < last; index += 1) farbled[index] = data[index];
              farbleAudioRange(farbled, channel, start, start + count);
            }
          } catch (_) {}
          return result;
        }, 2);
      }
    }

    function farbleAnalyserArray(node, array, kind, tag, limitProperty) {
      if (!array || typeof array.length !== 'number') return;
      const limitValue = Number(node && node[limitProperty]);
      if (!Number.isSafeInteger(limitValue) || limitValue <= 0) return;
      const limit = Math.min(array.length, limitValue);
      const isFloat = kind === 'float';
      if (isFloat && !isTypedArray(array, 'Float32Array')) return;
      if (!isFloat && !isTypedArray(array, 'Uint8Array')) return;

      const scale = tag === 1 ? 5e-3 : AUDIO_DITHER_SCALE;
      for (let i = 0; i < limit; i += 1) {
        const value = array[i];
        if (isFloat) {
          if (!Number.isFinite(value)) continue;
          const h = mix(0xA711, tag, i);
          if ((h & 0xff) < 8) {
            const rawDelta = ((h / 0x100000000) - 0.5) * scale;
            array[i] = value + (rawDelta === 0 ? scale * 0.25 : rawDelta);
          }
        } else {
          const h = mix(0xA712, tag, i);
          if ((h & 0xff) < 32) array[i] = Math.max(0, Math.min(255, value + ((h >>> 8) % 3) - 1));
        }
      }
    }

    // Shared by the prototype patcher and the per-instance fallback patcher.
    const ANALYSER_METHOD_SPECS = [
      ['getFloatFrequencyData', 'float', 1, 'frequencyBinCount'],
      ['getByteFrequencyData', 'byte', 2, 'frequencyBinCount'],
      ['getFloatTimeDomainData', 'float', 3, 'fftSize'],
      ['getByteTimeDomainData', 'byte', 4, 'fftSize'],
    ];

    function patchAnalyserMethods(proto) {
      if (!proto) return false;
      let installed = false;
      for (const [name, kind, tag, limitProperty] of ANALYSER_METHOD_SPECS) {
        const original = typeof proto[name] === 'function' ? proto[name] : null;
        if (!original) continue;
        installed = defineMethod(proto, name, function () {
          const result = Reflect.apply(original, this, arguments);
          try { farbleAnalyserArray(this, arguments[0], kind, tag, limitProperty); } catch (_) {}
          return result;
        }, 1) || installed;
      }
      return installed;
    }

    function patchAnalyserInstance(analyser, protoPatched) {
      if (!analyser || protoPatched || patchedAnalyserNodes.has(analyser)) return analyser;
      patchedAnalyserNodes.add(analyser);
      for (const [name, kind, tag, limitProperty] of ANALYSER_METHOD_SPECS) {
        const original = typeof analyser[name] === 'function' ? analyser[name] : null;
        if (!original) continue;
        defineMethod(analyser, name, function () {
          const result = Reflect.apply(original, this, arguments);
          try { farbleAnalyserArray(this, arguments[0], kind, tag, limitProperty); } catch (_) {}
          return result;
        }, 1);
      }
      return analyser;
    }

    patchAudioBufferPrototype();

    if (OfflineAudioCtxClass && OfflineAudioCtxClass.prototype &&
        typeof OfflineAudioCtxClass.prototype.startRendering === 'function') {
      const origStartRendering = OfflineAudioCtxClass.prototype.startRendering;
      defineMethod(OfflineAudioCtxClass.prototype, 'startRendering', function startRendering() {
        const promise = Reflect.apply(origStartRendering, this, arguments);
        if (!promise || typeof promise.then !== 'function') return promise;
        return promise.then((buffer) => {
          try {
            if (buffer && typeof buffer.numberOfChannels === 'number') {
              const state = getAudioBufferState(buffer);
              const channelCount = buffer.numberOfChannels;
              for (let ch = 0; ch < channelCount; ch++) {
                farbleWholeAudioChannel(
                  buffer,
                  state,
                  origGetChannelData || buffer.getChannelData,
                  ch,
                );
              }
            }
          } catch (_) {}
          return buffer;
        });
      }, 0);
    }

    const AudioCompletionEventClass = pageWindow.OfflineAudioCompletionEvent;
    if (AudioCompletionEventClass && AudioCompletionEventClass.prototype) {
      const origRenderedBufferDescriptor = origGetOwnPropertyDescriptor(
        AudioCompletionEventClass.prototype,
        'renderedBuffer',
      );
      if (origRenderedBufferDescriptor && typeof origRenderedBufferDescriptor.get === 'function') {
        defineGetter(AudioCompletionEventClass.prototype, 'renderedBuffer', function (buf) {
          if (buf && typeof buf.numberOfChannels === 'number') {
            try {
              const state = getAudioBufferState(buf);
              for (let ch = 0; ch < buf.numberOfChannels; ch++) {
                farbleWholeAudioChannel(buf, state, origGetChannelData || buf.getChannelData, ch);
              }
            } catch (_) {}
          }
          return buf;
        });
      }
    }

    let analyserProtoPatched = false;
    if (AnalyserNodeClass && AnalyserNodeClass.prototype) {
      analyserProtoPatched = patchAnalyserMethods(AnalyserNodeClass.prototype);
    }
    const BaseAudioCtxClass = pageWindow.BaseAudioContext;
    const ctxClassesToPatch = [AudioCtxClass, OfflineAudioCtxClass, BaseAudioCtxClass].filter(Boolean);
    for (const Cls of ctxClassesToPatch) {
      if (Cls.prototype && typeof Cls.prototype.createAnalyser === 'function') {
        const origCreate = Cls.prototype.createAnalyser;
        defineMethod(Cls.prototype, 'createAnalyser', function createAnalyser() {
          const node = Reflect.apply(origCreate, this, arguments);
          return patchAnalyserInstance(node, analyserProtoPatched);
        }, 0);
      }
    }

    installationRegistry.installers.audio = true;
    return { installed: true };
  }

  // Coherent hardware profile table shared identically between Window and WorkerGlobalScope
  const HARDWARE_TIERS = MODE === 'strict'
    ? Object.freeze([
        Object.freeze([4, 8]),
        Object.freeze([8, 8]),
      ])
    : Object.freeze([
        Object.freeze([2, 2]),
        Object.freeze([4, 4]),
        Object.freeze([4, 8]),
        Object.freeze([6, 8]),
        Object.freeze([8, 8]),
        Object.freeze([12, 8]),
        Object.freeze([16, 8]),
      ]);
  const SELECTED_HW_TIER = HARDWARE_TIERS[mix(0xC0FFEE) % HARDWARE_TIERS.length];

  function installNavigatorProtection() {
    if (installationRegistry.installers.navigator) {
      return { installed: true, reason: 'already-installed' };
    }
    const NavigatorClass = typeof Navigator !== 'undefined'
      ? Navigator
      : (typeof WorkerNavigator !== 'undefined' ? WorkerNavigator : null);
    if (!NavigatorClass || typeof navigator === 'undefined') {
      return { installed: false, reason: 'api-unavailable' };
    }
    const [spoofedHC, spoofedDM] = SELECTED_HW_TIER;
    const brandOpts = { proto: NavigatorClass.prototype, instance: navigator };
    const prototypeInstalled = defineGetter(
      NavigatorClass.prototype,
      'hardwareConcurrency',
      () => spoofedHC,
      brandOpts,
    );
    if (!prototypeInstalled || Object.prototype.hasOwnProperty.call(navigator, 'hardwareConcurrency')) {
      defineGetter(navigator, 'hardwareConcurrency', () => spoofedHC);
    }

    const dmInstalled = defineGetter(
      NavigatorClass.prototype,
      'deviceMemory',
      () => spoofedDM,
      brandOpts,
    );
    if (!dmInstalled || Object.prototype.hasOwnProperty.call(navigator, 'deviceMemory')) {
      defineGetter(navigator, 'deviceMemory', () => spoofedDM);
    }

    installationRegistry.installers.navigator = true;
    return { installed: true };
  }

  function installScreenProtection() {
    if (installationRegistry.installers.screen) {
      return { installed: true, reason: 'already-installed' };
    }
    const ScreenClass = typeof Screen !== 'undefined' ? Screen : null;
    const screenObject = typeof screen !== 'undefined' ? screen : null;
    if (!ScreenClass && !screenObject) {
      return { installed: false, reason: 'api-unavailable' };
    }
    // Coexist cleanly with Gecko RFP letterboxing: when RFP is active, Gecko C++
    // already aligns screen dimensions with the letterboxed inner viewport.
    if (RFP_ACTIVE) {
      installationRegistry.installers.screen = true;
      return { installed: true };
    }

    const SCREEN_RESOLUTIONS = [
      [1920, 1080],
      [1366, 768],
      [1440, 900],
      [1536, 864],
      [2560, 1440],
    ];
    let [resW, resH] = SCREEN_RESOLUTIONS[mix(0x5C8EE1) % SCREEN_RESOLUTIONS.length];
    const pageWin = typeof window !== 'undefined' ? window : null;
    if (MODE === 'balanced' && pageWin && typeof pageWin.innerWidth === 'number' && typeof pageWin.innerHeight === 'number') {
      if (pageWin.innerWidth > resW || pageWin.innerHeight > resH) {
        const fitting = SCREEN_RESOLUTIONS.find(([w, h]) => w >= pageWin.innerWidth && h >= pageWin.innerHeight);
        if (fitting) {
          resW = fitting[0];
          resH = fitting[1];
        }
      }
    }
    const availH = Math.max(0, resH - 40);
    const targetProto = (ScreenClass && ScreenClass.prototype) || screenObject;
    const brandOpts = targetProto !== screenObject ? { proto: targetProto, instance: screenObject } : null;

    let installed = false;
    installed = defineGetter(targetProto, 'width', () => resW, brandOpts) || installed;
    installed = defineGetter(targetProto, 'height', () => resH, brandOpts) || installed;
    installed = defineGetter(targetProto, 'availWidth', () => resW, brandOpts) || installed;
    installed = defineGetter(targetProto, 'availHeight', () => availH, brandOpts) || installed;
    installed = defineGetter(targetProto, 'colorDepth', () => 24, brandOpts) || installed;
    installed = defineGetter(targetProto, 'pixelDepth', () => 24, brandOpts) || installed;
    defineGetter(targetProto, 'availLeft', () => 0, brandOpts);
    defineGetter(targetProto, 'availTop', () => 0, brandOpts);

    if (screenObject && targetProto !== screenObject) {
      if (Object.prototype.hasOwnProperty.call(screenObject, 'width')) {
        defineGetter(screenObject, 'width', () => resW);
        defineGetter(screenObject, 'height', () => resH);
        defineGetter(screenObject, 'availWidth', () => resW);
        defineGetter(screenObject, 'availHeight', () => availH);
        defineGetter(screenObject, 'colorDepth', () => 24);
        defineGetter(screenObject, 'pixelDepth', () => 24);
      }
    }

    // Harmonize ScreenOrientation, outerWidth/outerHeight, devicePixelRatio, and CSS matchMedia
    if (typeof ScreenOrientation !== 'undefined' && ScreenOrientation.prototype) {
      const orientBrand = { proto: ScreenOrientation.prototype, instance: screenObject && screenObject.orientation };
      defineGetter(ScreenOrientation.prototype, 'type', () => (resW >= resH ? 'landscape-primary' : 'portrait-primary'), orientBrand);
      defineGetter(ScreenOrientation.prototype, 'angle', () => 0, orientBrand);
    }

    const spoofedDPR = MODE === 'strict' ? ((mix(0xD981) & 1) ? 2 : 1) : null;
    if (pageWin) {
      if (spoofedDPR !== null) {
        defineGetter(pageWin, 'devicePixelRatio', () => spoofedDPR);
      }
      defineGetter(pageWin, 'outerWidth', function (nativeVal) {
        const iw = typeof pageWin.innerWidth === 'number' && pageWin.innerWidth > 0 ? pageWin.innerWidth : resW;
        const base = typeof nativeVal === 'number' && nativeVal > 0 ? nativeVal : iw;
        return Math.min(resW, Math.max(iw, base));
      });
      defineGetter(pageWin, 'outerHeight', function (nativeVal) {
        const ih = typeof pageWin.innerHeight === 'number' && pageWin.innerHeight > 0 ? pageWin.innerHeight : availH;
        const base = typeof nativeVal === 'number' && nativeVal > 0 ? nativeVal : ih;
        return Math.min(availH, Math.max(ih, base));
      });

      if (typeof pageWin.matchMedia === 'function') {
        const origMatchMedia = pageWin.matchMedia;
        defineMethod(pageWin, 'matchMedia', function matchMedia(query) {
          let rewritten = String(query != null ? query : '');
          // Translate deprecated device-width / device-height probes so they match spoofed screen
          if (/device-(?:width|height)/i.test(rewritten)) {
            rewritten = rewritten
              .replace(/\(\s*device-width\s*:\s*(\d+)px\s*\)/gi, (_, n) => Number(n) === resW ? '(min-width: 0px)' : 'not all')
              .replace(/\(\s*min-device-width\s*:\s*(\d+)px\s*\)/gi, (_, n) => resW >= Number(n) ? '(min-width: 0px)' : 'not all')
              .replace(/\(\s*max-device-width\s*:\s*(\d+)px\s*\)/gi, (_, n) => resW <= Number(n) ? '(min-width: 0px)' : 'not all')
              .replace(/\(\s*device-height\s*:\s*(\d+)px\s*\)/gi, (_, n) => Number(n) === resH ? '(min-width: 0px)' : 'not all')
              .replace(/\(\s*min-device-height\s*:\s*(\d+)px\s*\)/gi, (_, n) => resH >= Number(n) ? '(min-width: 0px)' : 'not all')
              .replace(/\(\s*max-device-height\s*:\s*(\d+)px\s*\)/gi, (_, n) => resH <= Number(n) ? '(min-width: 0px)' : 'not all');
          }
          if (MODE === 'strict' && /prefers-color-scheme/i.test(rewritten)) {
            rewritten = rewritten
              .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, 'not all')
              .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(min-width: 0px)');
          }
          const mql = Reflect.apply(origMatchMedia, this, [rewritten]);
          if (rewritten !== String(query != null ? query : '') && mql) {
            try {
              Object.defineProperty(mql, 'media', {
                value: String(query),
                writable: false,
                enumerable: true,
                configurable: true,
              });
            } catch (_) {}
          }
          return mql;
        }, 1);
      }
    }

    if (!installed) return { installed: false, reason: 'installer-error' };
    installationRegistry.installers.screen = true;
    return { installed: true };
  }

  function installSpeechProtection() {
    if (installationRegistry.installers.speech) {
      return { installed: true, reason: 'already-installed' };
    }
    const SpeechSynthesisClass = typeof SpeechSynthesis !== 'undefined' ? SpeechSynthesis : null;
    const speechObject = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    if (!SpeechSynthesisClass && !speechObject) {
      return { installed: false, reason: 'api-unavailable' };
    }

    const proto = (SpeechSynthesisClass && SpeechSynthesisClass.prototype) || speechObject;
    if (!proto || typeof proto.getVoices !== 'function') {
      return { installed: false, reason: 'api-unavailable' };
    }

    const origGetVoices = proto.getVoices;
    const syntheticId = mix(0x504545) % 100;
    const voiceProto = typeof SpeechSynthesisVoice !== 'undefined' && SpeechSynthesisVoice.prototype
      ? SpeechSynthesisVoice.prototype
      : Object.prototype;

    const syntheticVoice = Object.create(voiceProto);
    try {
      Object.defineProperties(syntheticVoice, {
        name: { value: 'Synthetic Voice ' + syntheticId, enumerable: true, configurable: true },
        lang: { value: 'en-US', enumerable: true, configurable: true },
        voiceURI: { value: 'synthetic-voice-' + syntheticId, enumerable: true, configurable: true },
        default: { value: false, enumerable: true, configurable: true },
        localService: { value: true, enumerable: true, configurable: true },
      });
    } catch (_) {}

    const defaultVoice = Object.create(voiceProto);
    try {
      Object.defineProperties(defaultVoice, {
        name: { value: 'Standard Voice ' + syntheticId, enumerable: true, configurable: true },
        lang: { value: 'en-US', enumerable: true, configurable: true },
        voiceURI: { value: 'standard-voice-' + syntheticId, enumerable: true, configurable: true },
        default: { value: true, enumerable: true, configurable: true },
        localService: { value: true, enumerable: true, configurable: true },
      });
    } catch (_) {}

    if (!defineMethod(proto, 'getVoices', function getVoices() {
      const realVoices = Reflect.apply(origGetVoices, this, arguments);
      if (!Array.isArray(realVoices)) return realVoices;
      try {
        if (realVoices.length === 0) return [defaultVoice];
        const copy = realVoices.slice();
        if (copy.some((v) => v && v.voiceURI === 'synthetic-voice-' + syntheticId)) {
          return copy;
        }
        copy.push(syntheticVoice);
        return copy;
      } catch (_) {
        return realVoices;
      }
    }, 0)) {
      return { installed: false, reason: 'installer-error' };
    }

    installationRegistry.installers.speech = true;
    return { installed: true };
  }

  function installPluginProtection() {
    if (installationRegistry.installers.plugins) {
      return { installed: true, reason: 'already-installed' };
    }
    const NavigatorClass = typeof Navigator !== 'undefined' ? Navigator : null;
    if (!NavigatorClass || typeof navigator === 'undefined') {
      return { installed: false, reason: 'api-unavailable' };
    }
    try {
      const realPlugins = navigator.plugins;
      const realMimeTypes = navigator.mimeTypes;
      if (!realPlugins || typeof realPlugins.length !== 'number') {
        return { installed: false, reason: 'api-unavailable' };
      }

      const PluginClass = typeof Plugin !== 'undefined' ? Plugin : null;
      const MimeTypeClass = typeof MimeType !== 'undefined' ? MimeType : null;

      function createNativeLikeObject(Class, fallbackObject) {
        let prototype;
        try {
          prototype = Class && Class.prototype
            ? Class.prototype
            : fallbackObject
              ? Object.getPrototypeOf(fallbackObject)
              : Object.prototype;
          return Object.create(prototype);
        } catch (_) {
          try {
            const object = {};
            Object.setPrototypeOf(object, prototype || Object.prototype);
            return object;
          } catch (_) {
            return {};
          }
        }
      }

      function setValue(target, property, value, enumerable = false) {
        try {
          Object.defineProperty(target, property, {
            value,
            writable: false,
            configurable: true,
            enumerable,
          });
        } catch (_) {}
      }

      function readItem(collection, index) {
        try {
          if (collection && typeof collection.item === 'function') {
            return collection.item(index);
          }
        } catch (_) {}
        try { return collection[index] || null; } catch (_) { return null; }
      }

      function mimeKey(mime) {
        return mime && typeof mime.type === 'string' ? mime.type : mime;
      }

      function readPluginMimes(plugin) {
        const entries = [];
        if (!plugin || typeof plugin.length !== 'number') return entries;
        for (let i = 0; i < plugin.length; i += 1) {
          const mime = readItem(plugin, i);
          if (mime) entries.push(mime);
        }
        return entries;
      }

      function isPdfMime(mime) {
        if (!mime || typeof mime.type !== 'string') return false;
        return mime.type === 'application/pdf' || mime.type === 'text/pdf';
      }

      function isPdfPlugin(plugin) {
        if (!plugin) return false;
        const name = typeof plugin.name === 'string' ? plugin.name.toLowerCase() : '';
        const description = typeof plugin.description === 'string'
          ? plugin.description.toLowerCase()
          : '';
        if (name.includes('pdf') || description.includes('pdf')) return true;
        return readPluginMimes(plugin).some((mime) => isPdfMime(mime));
      }

      function createMimeRecord(source, enabledPlugin) {
        const mime = createNativeLikeObject(MimeTypeClass, source);
        setValue(mime, 'type', source && source.type);
        setValue(mime, 'description', source && source.description);
        setValue(mime, 'suffixes', source && source.suffixes);
        setValue(mime, 'enabledPlugin', enabledPlugin);
        return mime;
      }

      function createPluginRecord(source, sourceMimes) {
        const plugin = createNativeLikeObject(PluginClass, source);
        const mimes = sourceMimes.map((sourceMime) => createMimeRecord(sourceMime, plugin));
        setValue(plugin, 'name', source && source.name);
        setValue(plugin, 'description', source && source.description);
        setValue(plugin, 'filename', source && source.filename);
        setValue(plugin, 'length', mimes.length);
        mimes.forEach((mime, index) => setValue(plugin, String(index), mime, true));
        mimes.forEach((mime) => {
          if (typeof mime.type === 'string' && mime.type.length > 0) {
            setValue(plugin, mime.type, mime);
          }
        });
        setValue(plugin, 'item', makeNative(function item(index) {
          if (this !== plugin) throw new TypeError('Illegal invocation');
          const i = toInteger(index);
          return i >= 0 && i < mimes.length ? mimes[i] : null;
        }, 'item', 1));
        setValue(plugin, 'namedItem', makeNative(function namedItem(type) {
          if (this !== plugin) throw new TypeError('Illegal invocation');
          return mimes.find((mime) => mime.type === String(type)) || null;
        }, 'namedItem', 1));
        return { plugin, mimes };
      }

      const pluginEntries = [];
      const mimeEntries = [];
      const mimeByKey = new Map();
      const pluginRecords = new Map();

      function registerPlugin(source, plugin, mimes) {
        const recordMimes = new Map();
        for (const mime of mimes) {
          const key = mimeKey(mime);
          if (!recordMimes.has(key)) recordMimes.set(key, mime);
        }
        pluginEntries.push(plugin);
        pluginRecords.set(source, { plugin, mimes: recordMimes });
        for (const [key, mime] of recordMimes) {
          if (!mimeByKey.has(key)) {
            mimeByKey.set(key, mime);
            mimeEntries.push(mime);
          }
        }
      }

      for (let i = 0; i < realPlugins.length; i += 1) {
        const plugin = readItem(realPlugins, i);
        if (!plugin) continue;
        const retainedMimes = readPluginMimes(plugin).filter((mime) => !isPdfMime(mime));
        const uniqueMimes = retainedMimes.filter((mime, index) => {
          const key = mimeKey(mime);
          return !mimeByKey.has(key) &&
            retainedMimes.findIndex((candidate) => mimeKey(candidate) === key) === index;
        });
        if (isPdfPlugin(plugin)) {
          if (uniqueMimes.length === 0) continue;
          const normalized = createPluginRecord(plugin, uniqueMimes);
          registerPlugin(plugin, normalized.plugin, normalized.mimes);
          continue;
        }
        if (uniqueMimes.length === retainedMimes.length || retainedMimes.length === 0) {
          registerPlugin(plugin, plugin, retainedMimes);
        } else if (uniqueMimes.length > 0) {
          const normalized = createPluginRecord(plugin, uniqueMimes);
          registerPlugin(plugin, normalized.plugin, normalized.mimes);
        }
      }

      if (realMimeTypes && typeof realMimeTypes.length === 'number') {
        for (let i = 0; i < realMimeTypes.length; i += 1) {
          const mime = readItem(realMimeTypes, i);
          if (!mime || isPdfMime(mime)) continue;
          const key = mimeKey(mime);
          if (mimeByKey.has(key)) continue;
          const ownerRecord = pluginRecords.get(mime.enabledPlugin);
          const canonical = ownerRecord && ownerRecord.mimes.has(key)
            ? ownerRecord.mimes.get(key)
            : createMimeRecord(mime, null);
          mimeByKey.set(key, canonical);
          mimeEntries.push(canonical);
        }
      }

      const FAKE_POOL = [
        { name: 'PDF.js', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Mozilla PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Portable Document Format', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      ];
      const profile = FAKE_POOL[mix(0xF00BAA) % FAKE_POOL.length];
      const fakePlugin = createNativeLikeObject(PluginClass, pluginEntries[0]);
      const fakeMimes = [
        ['application/pdf', 'Portable Document Format', 'pdf'],
        ['text/pdf', 'Portable Document Format', 'pdf'],
      ].map(([type, description, suffixes]) => {
        const mime = createNativeLikeObject(MimeTypeClass, mimeEntries[0]);
        setValue(mime, 'type', type);
        setValue(mime, 'description', description);
        setValue(mime, 'suffixes', suffixes);
        setValue(mime, 'enabledPlugin', fakePlugin);
        return mime;
      });

      setValue(fakePlugin, 'name', profile.name);
      setValue(fakePlugin, 'description', profile.description);
      setValue(fakePlugin, 'filename', profile.filename);
      setValue(fakePlugin, 'length', fakeMimes.length);
      fakeMimes.forEach((mime, index) => setValue(fakePlugin, String(index), mime, true));
      fakeMimes.forEach((mime) => setValue(fakePlugin, mime.type, mime));
      setValue(fakePlugin, 'item', makeNative(function item(index) {
        if (this !== fakePlugin) throw new TypeError('Illegal invocation');
        const i = toInteger(index);
        return i >= 0 && i < fakeMimes.length ? fakeMimes[i] : null;
      }, 'item', 1));
      setValue(fakePlugin, 'namedItem', makeNative(function namedItem(type) {
        if (this !== fakePlugin) throw new TypeError('Illegal invocation');
        return fakeMimes.find((mime) => mime.type === String(type)) || null;
      }, 'namedItem', 1));

      pluginEntries.push(fakePlugin);
      for (const mime of fakeMimes) mimeEntries.push(mime);

      const PluginArrayClass = typeof PluginArray !== 'undefined' ? PluginArray : null;
      const MimeTypeArrayClass = typeof MimeTypeArray !== 'undefined' ? MimeTypeArray : null;

      function makeList(entries, nameProperty, ArrayClass, fallbackCollection) {
        const list = createNativeLikeObject(ArrayClass, fallbackCollection);
        setValue(list, 'length', entries.length);
        entries.forEach((entry, index) => {
          setValue(list, String(index), entry, true);
          const name = entry && entry[nameProperty];
          if (typeof name === 'string' && name.length > 0) {
            setValue(list, name, entry);
          }
        });
        setValue(list, 'item', makeNative(function item(index) {
          if (this !== list) throw new TypeError('Illegal invocation');
          const i = toInteger(index);
          return i >= 0 && i < entries.length ? entries[i] : null;
        }, 'item', 1));
        setValue(list, 'namedItem', makeNative(function namedItem(name) {
          if (this !== list) throw new TypeError('Illegal invocation');
          const value = String(name);
          return entries.find((entry) => entry && entry[nameProperty] === value) || null;
        }, 'namedItem', 1));
        setValue(list, 'refresh', makeNative(function refresh() {
          if (this !== list) throw new TypeError('Illegal invocation');
        }, 'refresh', 0));
        setValue(list, Symbol.iterator, makeNative(function* values() {
          if (this !== list) throw new TypeError('Illegal invocation');
          for (const entry of entries) yield entry;
        }, 'values', 0));
        return list;
      }

      const pluginList = makeList(pluginEntries, 'name', PluginArrayClass, realPlugins);
      const mimeList = makeList(mimeEntries, 'type', MimeTypeArrayClass, realMimeTypes);
      const navBrand = { proto: NavigatorClass.prototype, instance: navigator };
      const pluginsInstalled = defineGetter(
        NavigatorClass.prototype,
        'plugins',
        () => pluginList,
        navBrand,
      );
      const mimeTypesInstalled = defineGetter(
        NavigatorClass.prototype,
        'mimeTypes',
        () => mimeList,
        navBrand,
      );
      if (!pluginsInstalled) defineGetter(navigator, 'plugins', () => pluginList);
      if (!mimeTypesInstalled) defineGetter(navigator, 'mimeTypes', () => mimeList);
      installationRegistry.installers.plugins = true;
      return { installed: true };
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }
  }

  // ─── WORKER & OFFSCREENCANVAS REALM BRIDGE ───────────────────────────────
  // Extends deterministic farbling into DedicatedWorker & SharedWorker realms
  // using the exact same SEED, active surfaces, hardware tier, and mode so
  // worker-offloaded fingerprinting matches the document realm 100%.
  function buildWorkerBootstrapCode(activeSurfaces) {
    const cfgJson = JSON.stringify({
      seed: SEED,
      surfaces: activeSurfaces,
      mode: MODE,
      rfp: RFP_ACTIVE,
      hc: SELECTED_HW_TIER[0],
      dm: SELECTED_HW_TIER[1],
    });
    return `(function(CFG){'use strict';try{` +
      `const SEED=CFG.seed,SURFACES=CFG.surfaces,MODE=CFG.mode,RFP=CFG.rfp;` +
      `const nativeNames=new WeakMap();` +
      `function makeNative(fn,name,len){let t=fn;if(Object.prototype.hasOwnProperty.call(fn,'prototype')){t=({[name](){return Reflect.apply(fn,this,arguments);}})[name];}try{Object.defineProperty(t,'length',{value:len,writable:false,enumerable:false,configurable:true});Object.defineProperty(t,'name',{value:name,writable:false,enumerable:false,configurable:true});nativeNames.set(t,name);}catch(_){}return t;}` +
      `const origTSDesc=Object.getOwnPropertyDescriptor(Function.prototype,'toString');` +
      `if(origTSDesc&&typeof origTSDesc.value==='function'){const origTS=origTSDesc.value;const pTS=makeNative(({toString(){if(typeof this==='function'&&nativeNames.has(this)){const n=nativeNames.get(this);return 'function '+(n.startsWith('get ')?n.slice(4):n)+'() { [native code] }';}return Reflect.apply(origTS,this,arguments);}}).toString,'toString',0);Object.defineProperty(Function.prototype,'toString',{...origTSDesc,value:pTS});}` +
      `function mix(){let h=SEED;for(let i=0;i<arguments.length;i++){h=Math.imul(h^(arguments[i]>>>0),0x9e3779b9)>>>0;h^=h>>>16;}return h>>>0;}` +
      `function strHash(s){s=String(s||'');let h1=0xdeadbeef^SEED,h2=0x41c6ce57^SEED;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}return(Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909))>>>0;}` +
      `function clamp(v){return v<0?0:v>255?255:v;}` +
      `function farble(d,w,h,ox,oy,sw,sh){if(!d||d.length%4!==0||w<=0||h<=0)return;const n=Math.min(d.length/4,w*h);for(let p=0;p<n;p++){const idx=p*4;if(d[idx+3]===0)continue;const ax=ox+(p%w),ay=oy+Math.floor(p/w);const m=mix(ax,ay,sw,sh,d[idx],d[idx+1],d[idx+2]);if((m&0x1f)===0){d[idx]=clamp(d[idx]+((m>>>5)%3)-1);d[idx+1]=clamp(d[idx+1]+((m>>>11)%3)-1);d[idx+2]=clamp(d[idx+2]+((m>>>17)%3)-1);}}}` +
      `if(SURFACES.includes('navigator')&&typeof WorkerNavigator!=='undefined'&&WorkerNavigator.prototype){for(const[prop,val]of[['hardwareConcurrency',CFG.hc],['deviceMemory',CFG.dm]]){const d=Object.getOwnPropertyDescriptor(WorkerNavigator.prototype,prop);if(d&&d.configurable===false)continue;const og=d&&typeof d.get==='function'?d.get:null;const g=makeNative(function(){if(og)Reflect.apply(og,this,[]);else if(!(this instanceof WorkerNavigator))throw new TypeError('Illegal invocation');return val;},'get '+prop,0);Object.defineProperty(WorkerNavigator.prototype,prop,{get:g,enumerable:d?d.enumerable:true,configurable:d?d.configurable:true});}}` +
      `if(SURFACES.includes('canvas')){if(typeof OffscreenCanvasRenderingContext2D!=='undefined'&&OffscreenCanvasRenderingContext2D.prototype){const p=OffscreenCanvasRenderingContext2D.prototype;const og=p.getImageData;if(typeof og==='function'){const d=Object.getOwnPropertyDescriptor(p,'getImageData');const w=makeNative(function getImageData(){const id=Reflect.apply(og,this,arguments);try{const sw=(this&&this.canvas&&this.canvas.width)||id.width,sh=(this&&this.canvas&&this.canvas.height)||id.height;const rx=Math.trunc(Number(arguments[0])||0),ry=Math.trunc(Number(arguments[1])||0);const ox=(Number(arguments[2])<0?rx-id.width:rx),oy=(Number(arguments[3])<0?ry-id.height:ry);farble(id.data,id.width,id.height,ox,oy,sw,sh);}catch(_){}return id;},'getImageData',4);Object.defineProperty(p,'getImageData',{...(d||{writable:true,enumerable:true,configurable:true}),value:w});}` +
      `if(!RFP&&typeof p.measureText==='function'&&typeof TextMetrics!=='undefined'&&TextMetrics.prototype){const deltas=new WeakMap();const wd=Object.getOwnPropertyDescriptor(TextMetrics.prototype,'width');if(wd&&typeof wd.get==='function'&&wd.configurable!==false){const owg=wd.get;Object.defineProperty(TextMetrics.prototype,'width',{...wd,get:makeNative(function(){const v=Reflect.apply(owg,this,[]);const dl=deltas.get(this);return typeof dl==='number'?Math.max(0,v+dl):v;},'get width',0)});const omt=p.measureText;const mtd=Object.getOwnPropertyDescriptor(p,'measureText');Object.defineProperty(p,'measureText',{...(mtd||{writable:true,enumerable:true,configurable:true}),value:makeNative(function measureText(t){const m=Reflect.apply(omt,this,arguments);if(m){const h=mix(0x464F4E54,strHash(this&&this.font||''),strHash(String(t??'')));deltas.set(m,((((h&0xFFFF)+0.5)/0x10000)-0.5)*0.03);}return m;},'measureText',1)});}}}` +
      `if(typeof OffscreenCanvas!=='undefined'&&OffscreenCanvas.prototype&&typeof OffscreenCanvas.prototype.convertToBlob==='function'){const ocb=OffscreenCanvas.prototype.convertToBlob,ogc=OffscreenCanvas.prototype.getContext,ogid=typeof OffscreenCanvasRenderingContext2D!=='undefined'&&OffscreenCanvasRenderingContext2D.prototype.getImageData;const cbd=Object.getOwnPropertyDescriptor(OffscreenCanvas.prototype,'convertToBlob');Object.defineProperty(OffscreenCanvas.prototype,'convertToBlob',{...(cbd||{writable:true,enumerable:true,configurable:true}),value:makeNative(function convertToBlob(){try{const w=this.width,h=this.height;if(w>0&&h>0){const snap=new OffscreenCanvas(w,h);const sc=ogc.call(snap,'2d');if(sc&&sc.drawImage){sc.drawImage(this,0,0);const id=sc.getImageData(0,0,w,h);sc.putImageData(id,0,0);return Reflect.apply(ocb,snap,arguments);}}}catch(_){}return Reflect.apply(ocb,this,arguments);},'convertToBlob',0)});}}` +
      `if(SURFACES.includes('webgl')){const gpus=${JSON.stringify([
        { vendor: 'Intel', renderer: 'Mesa Intel(R) Graphics (ADL GT2)' },
        { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2' },
        { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2' },
        { vendor: 'AMD', renderer: 'AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6, DRM 3.54)' },
      ])};for(const C of[typeof WebGLRenderingContext!=='undefined'?WebGLRenderingContext:null,typeof WebGL2RenderingContext!=='undefined'?WebGL2RenderingContext:null].filter(Boolean)){const pr=C.prototype;if(!pr)continue;if(typeof pr.readPixels==='function'){const orp=pr.readPixels,d=Object.getOwnPropertyDescriptor(pr,'readPixels');Object.defineProperty(pr,'readPixels',{...d,value:makeNative(function readPixels(){const r=Reflect.apply(orp,this,arguments);try{const ox=Math.trunc(Number(arguments[0])||0),oy=Math.trunc(Number(arguments[1])||0),w=Math.trunc(Number(arguments[2])||0),h=Math.trunc(Number(arguments[3])||0),px=arguments[6];if(w>0&&h>0&&px&&arguments[4]===this.RGBA&&arguments[5]===this.UNSIGNED_BYTE){const cw=this.drawingBufferWidth||w,ch=this.drawingBufferHeight||h;farble(px,w,h,ox,oy,cw,ch);}}catch(_){}return r;},'readPixels',orp.length)});}` +
      `if(typeof pr.getParameter==='function'){const ogp=pr.getParameter,d=Object.getOwnPropertyDescriptor(pr,'getParameter');Object.defineProperty(pr,'getParameter',{...d,value:makeNative(function getParameter(p){const v=Reflect.apply(ogp,this,arguments);if(p===0x1F00||p===0x1F01)return'Mozilla';if(p===0x9245&&v!==null)return(MODE!=='strict'&&typeof v==='string'&&v&&v!=='Mozilla')?v:gpus[mix(0x57475055)%gpus.length].vendor;if(p===0x9246&&v!==null)return(MODE!=='strict'&&typeof v==='string'&&v&&v!=='Mozilla')?v:gpus[mix(0x57475055)%gpus.length].renderer;return v;},'getParameter',1)});}}}` +
      `}catch(_){}})(${cfgJson});\n`;
  }

  function installWorkerRealmBridge(activeSurfaces) {
    if (isWorkerRealm || installationRegistry.installers.workers) return;
    if (!activeSurfaces.some((s) => s === 'canvas' || s === 'webgl' || s === 'webgpu' || s === 'navigator')) return;
    if (typeof URL !== 'function' || typeof Blob !== 'function') return;
    const OrigWorker = typeof Worker === 'function' ? Worker : null;
    const OrigSharedWorker = typeof SharedWorker === 'function' ? SharedWorker : null;
    if (!OrigWorker && !OrigSharedWorker) return;

    const origCreateObjectURL = typeof URL.createObjectURL === 'function' ? URL.createObjectURL.bind(URL) : null;
    const origRevokeObjectURL = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : null;
    if (!origCreateObjectURL) return;

    const blobPayloads = installationRegistry.blobPayloads;
    defineMethod(URL, 'createObjectURL', function createObjectURL(obj) {
      const url = Reflect.apply(origCreateObjectURL, this, arguments);
      try {
        if (typeof url === 'string' && obj instanceof Blob) {
          if (blobPayloads.size >= 128) {
            blobPayloads.delete(blobPayloads.keys().next().value);
          }
          blobPayloads.set(url, obj);
        }
      } catch (_) {}
      return url;
    }, 1);

    if (origRevokeObjectURL) {
      defineMethod(URL, 'revokeObjectURL', function revokeObjectURL(url) {
        try { blobPayloads.delete(String(url)); } catch (_) {}
        return Reflect.apply(origRevokeObjectURL, this, arguments);
      }, 1);
    }

    const bootstrapCode = buildWorkerBootstrapCode(activeSurfaces);

    function wrapWorkerScriptURL(rawURL, options) {
      if (typeof rawURL !== 'string' && !(typeof URL === 'function' && rawURL instanceof URL)) return null;
      const urlStr = String(rawURL);
      const isModule = Boolean(options && typeof options === 'object' && options.type === 'module');
      if (urlStr.startsWith('blob:')) {
        const origBlob = blobPayloads.get(urlStr);
        if (!origBlob) return null;
        const wrappedBlob = new Blob([bootstrapCode, origBlob], {
          type: origBlob.type || 'application/javascript',
        });
        return origCreateObjectURL(wrappedBlob);
      }
      if (urlStr.startsWith('data:text/javascript') || urlStr.startsWith('data:application/javascript')) {
        const commaIdx = urlStr.indexOf(',');
        if (commaIdx > 0) {
          const meta = urlStr.slice(0, commaIdx);
          const payload = urlStr.slice(commaIdx + 1);
          const isBase64 = /;base64/i.test(meta);
          if (isBase64 && typeof atob === 'function' && typeof btoa === 'function') {
            return meta + ',' + btoa(bootstrapCode + atob(payload));
          }
          return meta + ',' + encodeURIComponent(bootstrapCode + decodeURIComponent(payload));
        }
      }
      if (typeof location === 'object' && location && /^https?:$/.test(location.protocol)) {
        try {
          const resolved = new URL(urlStr, location.href);
          if (resolved.origin === location.origin) {
            const loaderLine = isModule
              ? `import ${JSON.stringify(resolved.href)};\n`
              : `importScripts(${JSON.stringify(resolved.href)});\n`;
            const trampolineBlob = new Blob([bootstrapCode, loaderLine], { type: 'application/javascript' });
            return origCreateObjectURL(trampolineBlob);
          }
        } catch (_) {}
      }
      return null;
    }

    function hookWorkerConstructor(propName, Ctor) {
      if (!Ctor || typeof Proxy !== 'function') return;
      const desc = origGetOwnPropertyDescriptor(pageGlobal, propName);
      if (desc && desc.configurable === false && desc.writable === false) return;
      const wrappedCtor = new Proxy(Ctor, {
        construct(target, args, newTarget) {
          if (args.length > 0) {
            let syntheticURL = null;
            try {
              syntheticURL = wrapWorkerScriptURL(args[0], args[1]);
              if (syntheticURL) {
                const patchedArgs = args.slice();
                patchedArgs[0] = syntheticURL;
                return Reflect.construct(target, patchedArgs, newTarget === wrappedCtor ? target : newTarget);
              }
            } catch (_) {
              if (syntheticURL && syntheticURL.startsWith('blob:') && origRevokeObjectURL) {
                try { origRevokeObjectURL(syntheticURL); } catch (_) {}
              }
              // CSP `worker-src` blocked blob: trampoline — fall back cleanly to original script URL!
            }
          }
          return Reflect.construct(target, args, newTarget === wrappedCtor ? target : newTarget);
        },
      });
      nativeFunctionNames.set(wrappedCtor, propName);
      try {
        if (Ctor.prototype) {
          const ctorDesc = origGetOwnPropertyDescriptor(Ctor.prototype, 'constructor');
          if (!ctorDesc || ctorDesc.configurable !== false) {
            Object.defineProperty(Ctor.prototype, 'constructor', {
              value: wrappedCtor,
              writable: ctorDesc ? ctorDesc.writable : true,
              enumerable: ctorDesc ? ctorDesc.enumerable : false,
              configurable: ctorDesc ? ctorDesc.configurable : true,
            });
          }
        }
        Object.defineProperty(pageGlobal, propName, {
          value: wrappedCtor,
          writable: desc ? desc.writable : true,
          enumerable: desc ? desc.enumerable : false,
          configurable: desc ? desc.configurable : true,
        });
      } catch (_) {}
    }

    hookWorkerConstructor('Worker', OrigWorker);
    hookWorkerConstructor('SharedWorker', OrigSharedWorker);
    installationRegistry.installers.workers = true;
  }

  function runInstaller(name, installer) {
    try {
      const result = installer();
      return result && typeof result === 'object'
        ? result
        : { installed: Boolean(result) };
    } catch (_) {
      return { installed: false, reason: 'installer-error' };
    }
  }

  // Keep the result private. Exposing it on window would give pages a direct
  // feature-detection oracle. The extension context can still use the same
  // runner when a privileged diagnostic channel is added later.
  const surfacesList = Array.isArray(ARGON_SURFACES) ? ARGON_SURFACES : [];
  const installationResults = {
    canvas: surfacesList.includes('canvas') ? runInstaller('canvas', installCanvasProtection) : { installed: false, reason: 'disabled' },
    webgl: surfacesList.includes('webgl') ? runInstaller('webgl', installWebGLProtection) : { installed: false, reason: 'disabled' },
    webgpu: surfacesList.includes('webgpu') ? runInstaller('webgpu', installWebGPUProtection) : { installed: false, reason: 'disabled' },
    audio: surfacesList.includes('audio') ? runInstaller('audio', installAudioProtection) : { installed: false, reason: 'disabled' },
    navigator: surfacesList.includes('navigator') ? runInstaller('navigator', installNavigatorProtection) : { installed: false, reason: 'disabled' },
    plugins: surfacesList.includes('plugins') ? runInstaller('plugins', installPluginProtection) : { installed: false, reason: 'disabled' },
    screen: surfacesList.includes('screen') ? runInstaller('screen', installScreenProtection) : { installed: false, reason: 'disabled' },
    speech: surfacesList.includes('speech') ? runInstaller('speech', installSpeechProtection) : { installed: false, reason: 'disabled' },
  };
  try { installWorkerRealmBridge(surfacesList); } catch (_) {}

  function summarizeInstallerResult(result) {
    if (!result || typeof result !== 'object') {
      return Boolean(result) ? 'installed' : 'failed';
    }
    if (result.installed === true) return 'installed';
    if (result.reason === 'api-unavailable' || result.reason === 'descriptors-unavailable') {
      return 'unavailable';
    }
    return 'failed';
  }

  return JSON.stringify(Object.fromEntries(Object.entries(installationResults).map(([key, value]) => [key, value.reason === 'disabled' ? 'disabled' : summarizeInstallerResult(value)])));
})
