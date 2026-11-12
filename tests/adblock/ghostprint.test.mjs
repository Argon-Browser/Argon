import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPageContext } = require('../../third_party/ghostprint/tests/helpers/inject-harness.js');
const source = fs.readFileSync(new URL('../../argon/adblock/ghostprint/inject.js', import.meta.url), 'utf8');
const surfaces = ['canvas','webgl','webgpu','audio','navigator','plugins'];
const install = (context, selected) => JSON.parse(vm.runInContext(source + '(123456789,' + JSON.stringify(selected) + ')', context));
test('panel errors never display null or empty diagnostics', async () => {
  const panel=await import('../../argon/adblock/panel.mjs');
  assert.equal(typeof panel.formatProtectionError,'function');
  for (const value of [null,undefined,'','null','undefined',{},new Error('')]) {
    assert.equal(panel.formatProtectionError(value),'Unknown failure. Please try again or reload the tab.');
    assert.equal(panel.formatProtectionError(value, 'pt-BR'),'Falha desconhecida. Tente novamente ou recarregue a aba.');
    assert.equal(panel.formatProtectionError(value, 'es'),'Fallo desconocido. Inténtalo de nuevo o recarga la pestaña.');
  }
  assert.equal(panel.formatProtectionError(new Error('disk full')),'disk full');
  assert.equal(panel.formatProtectionError('network failed'),'network failed');
});
test('native adapter has no page messaging, storage or script-element transport', () => {
  assert.doesNotMatch(source, /postMessage|currentScript|sessionStorage/);
});
test('each surface can be disabled independently without disabling the others', () => {
  for (const omitted of surfaces) {
    const result = install(createPageContext(),surfaces.filter(s=>s!==omitted));
    assert.equal(result[omitted],'disabled');
    for (const name of surfaces.filter(s=>s!==omitted && s!=='audio')) assert.equal(result[name],'installed');
  }
});
test('unavailable APIs and failed installers are distinct from installed hooks', () => {
  const absent=createPageContext(); delete absent.CanvasRenderingContext2D;
  assert.equal(install(absent,surfaces).canvas,'unavailable');
  const locked=createPageContext(); Object.freeze(locked.CanvasRenderingContext2D.prototype);
  const result=install(locked,surfaces);
  assert.equal(result.canvas,'failed'); assert.equal(result.navigator,'installed');
});
test('adapted WebGL and WebGPU keep the actual GhostPrint behavior', async () => {
  const context = createPageContext(); install(context,surfaces);
  assert.equal(vm.runInContext("new HTMLCanvasElement().getContext('webgl').getParameter(0x1F00)",context),'Mozilla');
  const adapter = await vm.runInContext('navigator.gpu.requestAdapter()',context);
  assert.equal(adapter.info.vendor,''); assert.equal(adapter.info.architecture,''); assert.equal(adapter.info.device,'');
  assert.equal(adapter.info.description,'NVIDIA GeForce RTX 4090');
});
test('parent context lookup rejects a context owned by another process', async () => {
  const {ArgonGhostPrint: service} = await import('../../argon/adblock/ghostprint.sys.mjs');
  const principal = {isContentPrincipal:true,originNoSuffix:'https://private.example'};
  const bc = {currentWindowGlobal:{documentPrincipal:principal,domProcess:{osPid:42}}}; bc.top=bc;
  globalThis.BrowsingContext={get:()=>bc};
  try {
    assert.equal(service.receiveMessage({name:'ArgonGhostPrint:context',data:{id:1},target:{osPid:7}}),null);
    assert.deepEqual(service.receiveMessage({name:'ArgonGhostPrint:context',data:{id:1},target:{osPid:42}}),{origin:'https://private.example'});
    assert.equal(service.receiveMessage({name:'ArgonGhostPrint:context',data:null,target:{osPid:42}}),null);
  } finally { delete globalThis.BrowsingContext; }
});
test('pinned upstream and adapted source hashes match provenance', () => {
  const provenance = JSON.parse(fs.readFileSync(new URL('../../argon/adblock/ghostprint/provenance.json',import.meta.url)));
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(hash(source),provenance.adaptedInjectSHA256);
  assert.equal(hash(fs.readFileSync(new URL('../../third_party/ghostprint/inject.js',import.meta.url))),provenance.upstreamInjectSHA256);
  for (const [path, expected] of Object.entries(provenance.vendoredSHA256)) assert.equal(hash(fs.readFileSync(new URL('../../third_party/ghostprint/' + path,import.meta.url))),expected,path);
  assert.equal(provenance.commit,'3f63e4658f6516fa4f62e27d741e128e7cb7b7e7');
});

// ─── BRAVE-GRADE GHOSTPRINT VERIFICATION TEST SUITE ──────────────────────────

function createFullPageContext(options = {}) {
  const context = createPageContext(options);

  function baseMeasureText(text) {
    const len = String(text != null ? text : '').length;
    const baseWidth = len * 10;
    return {
      width: baseWidth,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: baseWidth,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    };
  }

  if (!context.CanvasRenderingContext2D.prototype.measureText) {
    context.CanvasRenderingContext2D.prototype.measureText = function measureText(text) {
      return baseMeasureText(text);
    };
  }

  if (!context.OffscreenCanvasRenderingContext2D) {
    class OffscreenCanvasRenderingContext2D {
      measureText(text) {
        return baseMeasureText(text);
      }
      getImageData(sx, sy, sw, sh) {
        return { data: new Uint8ClampedArray(sw * sh * 4), width: sw, height: sh };
      }
    }
    context.OffscreenCanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;
  }
  const origOffscreenGetContext = context.OffscreenCanvas.prototype.getContext;
  context.OffscreenCanvas.prototype.getContext = function getContext(type, ...args) {
    if (type === '2d') {
      if (!this.context2d) this.context2d = new context.OffscreenCanvasRenderingContext2D();
      return this.context2d;
    }
    return origOffscreenGetContext ? origOffscreenGetContext.call(this, type, ...args) : null;
  };
  if (!context.OffscreenCanvas.prototype.convertToBlob) {
    context.OffscreenCanvas.prototype.convertToBlob = function convertToBlob() {
      return Promise.resolve(new Blob());
    };
  }

  const origReadPixels = context.WebGLRenderingContext.prototype.readPixels;
  context.WebGLRenderingContext.prototype.readPixels = function readPixels(x, y, width, height, format, type, pixels) {
    return origReadPixels.apply(this, arguments);
  };
  const webglProto = context.WebGLRenderingContext.prototype;
  if (!webglProto.getShaderPrecisionFormat) {
    webglProto.getShaderPrecisionFormat = function getShaderPrecisionFormat() {
      return { rangeMin: 127, rangeMax: 127, precision: 23 };
    };
  }
  const webgl2Proto = context.WebGL2RenderingContext.prototype;
  if (!webgl2Proto.getShaderPrecisionFormat) {
    webgl2Proto.getShaderPrecisionFormat = webglProto.getShaderPrecisionFormat;
  }
  if (!webgl2Proto.getBufferSubData) {
    webgl2Proto.PIXEL_PACK_BUFFER = 0x88EB;
    webgl2Proto.getBufferSubData = function getBufferSubData(target, srcByteOffset, dstData) {
      if (dstData && dstData.fill) {
        dstData.fill(128);
      }
    };
  }

  class AudioBuffer {
    constructor(numberOfChannels = 2, length = 1024) {
      this.numberOfChannels = numberOfChannels;
      this.length = length;
      this.sampleRate = 44100;
      this.channels = Array.from({ length: numberOfChannels }, (_, ch) => {
        const arr = new Float32Array(length);
        for (let i = 0; i < length; i++) arr[i] = ((ch + 1) * 0.1) + ((i % 50) / 500);
        return arr;
      });
    }
    getChannelData(channel) {
      if (channel < 0 || channel >= this.numberOfChannels) throw new RangeError('Channel out of range');
      return this.channels[channel];
    }
    copyFromChannel(destination, channel, startInChannel = 0) {
      const src = this.channels[channel];
      if (!src) throw new RangeError('Channel out of range');
      destination.set(src.subarray(startInChannel, startInChannel + destination.length));
    }
    copyToChannel(source, channel, startInChannel = 0) {
      const dst = this.channels[channel];
      if (!dst) throw new RangeError('Channel out of range');
      dst.set(source, startInChannel);
    }
  }

  class AnalyserNode {
    constructor() {
      this.frequencyBinCount = 128;
      this.fftSize = 256;
    }
    getFloatFrequencyData(array) {
      for (let i = 0; i < Math.min(array.length, this.frequencyBinCount); i++) array[i] = -50.0 + i * 0.1;
      return 'native-float-frequency';
    }
    getByteFrequencyData(array) {
      for (let i = 0; i < Math.min(array.length, this.frequencyBinCount); i++) array[i] = (50 + i) & 0xff;
      return 'native-byte-frequency';
    }
    getFloatTimeDomainData(array) {
      for (let i = 0; i < Math.min(array.length, this.fftSize); i++) array[i] = 0.5 + (i * 0.001);
      return 'native-float-time';
    }
    getByteTimeDomainData(array) {
      for (let i = 0; i < Math.min(array.length, this.fftSize); i++) array[i] = (128 + i) & 0xff;
      return 'native-byte-time';
    }
  }

  class AudioContext {
    createAnalyser() { return new AnalyserNode(); }
  }

  class OfflineAudioContext {
    constructor(numberOfChannels = 2, length = 1024, sampleRate = 44100) {
      this.buffer = new AudioBuffer(numberOfChannels, length);
    }
    startRendering() {
      return Promise.resolve(this.buffer);
    }
  }

  context.AudioBuffer = AudioBuffer;
  context.AnalyserNode = AnalyserNode;
  context.AudioContext = AudioContext;
  context.OfflineAudioContext = OfflineAudioContext;

  class SpeechSynthesisVoice {
    constructor(name, lang) {
      this.name = name;
      this.lang = lang;
      this.default = false;
      this.localService = true;
      this.voiceURI = name;
    }
  }
  class SpeechSynthesis {
    constructor() {
      this.voices = [
        new SpeechSynthesisVoice('Native Voice 1', 'en-US'),
        new SpeechSynthesisVoice('Native Voice 2', 'en-GB'),
      ];
    }
    getVoices() {
      return this.voices.slice();
    }
  }
  context.SpeechSynthesisVoice = SpeechSynthesisVoice;
  context.SpeechSynthesis = SpeechSynthesis;
  context.speechSynthesis = new SpeechSynthesis();

  class Screen {
    constructor() {
      this.width = 1920;
      this.height = 1080;
      this.availWidth = 1920;
      this.availHeight = 1040;
      this.colorDepth = 24;
      this.pixelDepth = 24;
    }
  }
  context.Screen = Screen;
  context.screen = new Screen();

  return context;
}

const installWithSeed = (context, seed, selected) =>
  JSON.parse(vm.runInContext(source + '(' + seed + ',' + JSON.stringify(selected) + ')', context));

test('measureText farbles width and bounding boxes deterministically with layout stability', () => {
  const context1 = createFullPageContext();
  const context2 = createFullPageContext();
  const contextDiffSeed = createFullPageContext();

  installWithSeed(context1, 123456789, ['canvas']);
  installWithSeed(context2, 123456789, ['canvas']);
  installWithSeed(contextDiffSeed, 987654321, ['canvas']);

  const canvas1 = new context1.HTMLCanvasElement();
  const ctx1 = canvas1.getContext('2d');
  ctx1.font = '16px sans-serif';

  const text = 'The quick brown fox jumps over the lazy dog';
  const baselineWidth = text.length * 10;

  const m1 = ctx1.measureText(text);
  const m1Repeat = ctx1.measureText(text);

  assert.notEqual(m1.width, baselineWidth, 'Width must be perturbed');
  assert.ok(Math.abs(m1.width - baselineWidth) <= 0.03, 'Perturbation must stay within sub-pixel layout stability bound (±0.03px)');
  assert.ok(Math.abs(m1.width - baselineWidth) > 0, 'Perturbation must not be zero');

  assert.notEqual(m1.actualBoundingBoxRight, baselineWidth, 'Bounding box right must be perturbed');
  assert.notEqual(m1.actualBoundingBoxAscent, 10, 'Bounding box ascent must be perturbed');
  assert.ok(Math.abs(m1.actualBoundingBoxRight - baselineWidth) <= 0.03, 'Bounding box perturbation must be sub-pixel');

  assert.equal(m1.width, m1Repeat.width, 'Repeated measureText calls on identical text/font must be deterministic');
  assert.equal(m1.actualBoundingBoxRight, m1Repeat.actualBoundingBoxRight);

  const canvas2 = new context2.HTMLCanvasElement();
  const ctx2 = canvas2.getContext('2d');
  ctx2.font = '16px sans-serif';
  const m2 = ctx2.measureText(text);
  assert.equal(m1.width, m2.width, 'Identical seed and font must yield identical width');

  const canvasDiff = new contextDiffSeed.HTMLCanvasElement();
  const ctxDiff = canvasDiff.getContext('2d');
  ctxDiff.font = '16px sans-serif';
  const mDiff = ctxDiff.measureText(text);
  assert.notEqual(m1.width, mDiff.width, 'Different seeds must yield different perturbed widths');

  const offscreen = new context1.OffscreenCanvas(300, 150);
  const offCtx = offscreen.getContext('2d');
  offCtx.font = '16px sans-serif';
  const offM = offCtx.measureText(text);
  assert.equal(offM.width, m1.width, 'OffscreenCanvas context with same seed/font/text must match 2D canvas');
});

test('measureText defeats font probing by varying perturbations across font families', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['canvas']);

  const canvas = new context.HTMLCanvasElement();
  const ctx = canvas.getContext('2d');

  const probeText = 'mmmmmmmmmmlli';
  ctx.font = '16px Arial';
  const mArial = ctx.measureText(probeText);

  ctx.font = '16px monospace';
  const mMonospace = ctx.measureText(probeText);

  ctx.font = '16px serif';
  const mSerif = ctx.measureText(probeText);

  ctx.font = '16px sans-serif';
  const mSans = ctx.measureText(probeText);

  const widths = new Set([mArial.width, mMonospace.width, mSerif.width, mSans.width]);
  assert.ok(widths.size >= 3, 'Different fonts must yield distinct farbled metrics to break font enumeration');
});

test('WebGL getParameter, UNMASKED strings, capability ranges, and readPixels are farbled', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['webgl']);

  const canvas = new context.HTMLCanvasElement();
  const gl = canvas.getContext('webgl');
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

  assert.equal(gl.getParameter(gl.VENDOR), 'Mozilla');
  assert.equal(gl.getParameter(gl.RENDERER), 'Mozilla');
  if (debugInfo) {
    assert.notEqual(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), 'Mozilla');
    assert.notEqual(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL), 'Mozilla');
    assert.equal(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), 'Real GPU Vendor');
    assert.equal(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL), 'Real GPU Renderer');
  }

  const maxTex = gl.getParameter(0x0D33);
  assert.ok(maxTex === 4096 || maxTex === 4095, 'MAX_TEXTURE_SIZE must be farbled or consistent');

  const format = gl.getShaderPrecisionFormat(35633, 36338);
  assert.ok(format && typeof format.precision === 'number');
  assert.ok(format.precision >= 22 && format.precision <= 24, 'Precision must be subtly jittered (±1)');

  const pixels1 = new Uint8Array(128 * 128 * 4);
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels1);
  const pixels1Repeat = new Uint8Array(128 * 128 * 4);
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels1Repeat);
  assert.deepEqual(Array.from(pixels1), Array.from(pixels1Repeat), 'readPixels must be deterministic within same seed');

  const contextDiff = createFullPageContext();
  installWithSeed(contextDiff, 987654321, ['webgl']);
  const glDiff = new contextDiff.HTMLCanvasElement().getContext('webgl');
  const pixelsDiff = new Uint8Array(128 * 128 * 4);
  glDiff.readPixels(0, 0, 128, 128, glDiff.RGBA, glDiff.UNSIGNED_BYTE, pixelsDiff);
  assert.notDeepEqual(Array.from(pixels1), Array.from(pixelsDiff), 'readPixels must vary across seeds');
});

test('WebGL2 getBufferSubData farbles PIXEL_PACK_BUFFER asynchronously', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['webgl']);

  const canvas = new context.HTMLCanvasElement();
  const gl2 = canvas.getContext('webgl2');

  const pboData = new Uint8Array(1024);
  gl2.getBufferSubData(0x88EB, 0, pboData);

  const altered = Array.from(pboData).filter(b => b !== 128);
  assert.ok(altered.length > 0, 'PBO buffer must have farbled bytes');
  for (const byte of altered) {
    assert.ok(byte === 127 || byte === 129, 'Farbled noise must be ±1');
  }
});

test('Web Audio AnalyserNode, AudioBuffer, and OfflineAudioContext are farbled deterministically', async () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['audio']);

  const oac = new context.OfflineAudioContext();
  const renderedBuffer = await oac.startRendering();

  const ch0 = renderedBuffer.getChannelData(0);
  const ch0Repeat = renderedBuffer.getChannelData(0);
  assert.strictEqual(ch0, ch0Repeat, 'AudioBuffer.getChannelData must return cached farbled view');

  assert.ok(renderedBuffer.channels[0].some((s, idx) => s !== ch0[idx]), 'Farbled view must differ from native backing samples');

  const copyTarget = new Float32Array(512);
  renderedBuffer.copyFromChannel(copyTarget, 0, 0);
  assert.deepEqual(Array.from(copyTarget), Array.from(ch0.subarray(0, 512)), 'copyFromChannel must match getChannelData view');

  const analyser = new context.AudioContext().createAnalyser();
  const floatFreq = new Float32Array(128);
  const byteFreq = new Uint8Array(128);
  const floatTime = new Float32Array(256);
  const byteTime = new Uint8Array(256);

  analyser.getFloatFrequencyData(floatFreq);
  analyser.getByteFrequencyData(byteFreq);
  analyser.getFloatTimeDomainData(floatTime);
  analyser.getByteTimeDomainData(byteTime);

  assert.ok(Array.from(floatFreq).some(v => v !== -50), 'Float frequency data must contain farbled samples');
  assert.ok(Array.from(byteFreq).some(v => v !== ((50 + 0) & 0xff)), 'Byte frequency data must contain farbled samples');
  assert.ok(Array.from(floatTime).some(v => v !== 0.5), 'Float time domain data must contain farbled samples');
  assert.ok(Array.from(byteTime).some(v => v !== 128), 'Byte time domain data must contain farbled samples');
});

test('speechSynthesis.getVoices appends deterministic synthetic voice alias', () => {
  const context1 = createFullPageContext();
  const context2 = createFullPageContext();
  const contextDiffSeed = createFullPageContext();

  installWithSeed(context1, 123456789, ['speech']);
  installWithSeed(context2, 123456789, ['speech']);
  installWithSeed(contextDiffSeed, 987654321, ['speech']);

  const voices1 = context1.speechSynthesis.getVoices();
  const voices1Repeat = context1.speechSynthesis.getVoices();

  assert.equal(voices1.length, 3, 'Must append 1 synthetic voice to the 2 native voices');
  const synthetic1 = voices1[2];
  assert.match(synthetic1.name, /^Synthetic Voice \d+$/, 'Synthetic voice name format');
  assert.equal(synthetic1.lang, 'en-US');
  assert.equal(synthetic1.default, false);
  assert.equal(synthetic1.localService, true);

  assert.equal(synthetic1.name, voices1Repeat[2].name, 'Repeated getVoices calls must be deterministic');
  const voices2 = context2.speechSynthesis.getVoices();
  assert.equal(synthetic1.name, voices2[2].name, 'Identical seed must yield identical synthetic voice');

  const voicesDiff = contextDiffSeed.speechSynthesis.getVoices();
  assert.notEqual(synthetic1.name, voicesDiff[2].name, 'Different seed must yield different synthetic voice alias');
});

test('hooked methods and getters spoof native Function.prototype.toString', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['canvas', 'webgl', 'audio', 'navigator', 'screen', 'speech']);

  const canvas = new context.HTMLCanvasElement();
  const ctx2d = canvas.getContext('2d');
  const gl = canvas.getContext('webgl');
  const audio = new context.AudioContext().createAnalyser();
  const buffer = new context.AudioBuffer();
  const oac = new context.OfflineAudioContext();

  const methodsToTest = [
    [ctx2d.measureText, 'measureText', 1],
    [ctx2d.getImageData, 'getImageData', 4],
    [canvas.toDataURL, 'toDataURL', 0],
    [gl.getParameter, 'getParameter', 1],
    [gl.readPixels, 'readPixels', 7],
    [context.speechSynthesis.getVoices, 'getVoices', 0],
    [buffer.getChannelData, 'getChannelData', 1],
    [buffer.copyFromChannel, 'copyFromChannel', 2],
    [oac.startRendering, 'startRendering', 0],
    [audio.getFloatFrequencyData, 'getFloatFrequencyData', 1],
  ];

  for (const [fn, expectedName, expectedLength] of methodsToTest) {
    assert.equal(typeof fn, 'function', `${expectedName} must be a function`);
    assert.equal(fn.name, expectedName, `${expectedName} name must match`);
    assert.equal(fn.length, expectedLength, `${expectedName} length must match`);

    const expectedStr = `function ${expectedName}() { [native code] }`;
    assert.equal(fn.toString(), expectedStr, `${expectedName}.toString() must spoof [native code]`);
    assert.equal(fn.propertyIsEnumerable('toString'), false, `${expectedName}.toString must be non-enumerable`);
  }
});

test('navigator.deviceMemory and screen properties are normalized/spoofed', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['navigator', 'screen']);

  assert.ok([2, 4, 8].includes(context.navigator.deviceMemory), 'deviceMemory must be normalized to standard tier');

  const screen = context.screen;
  assert.ok([1920, 1366, 1440, 1536, 2560].includes(screen.width), 'screen.width must match standard desktop resolution');
  assert.ok([1080, 768, 900, 864, 1440].includes(screen.height), 'screen.height must match standard desktop resolution');
  assert.equal(screen.width, screen.availWidth);
  assert.equal(screen.availHeight, screen.height - 40);
  assert.equal(screen.colorDepth, 24);
  assert.equal(screen.pixelDepth, 24);
});

test('WebGL UNMASKED vendor and renderer return realistic farbled strings when native returns Mozilla', () => {
  const context = createFullPageContext();
  context.WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 0x1F00 || param === 0x1F01) return 'Mozilla';
    if (param === 0x9245 || param === 0x9246) return 'Mozilla';
    return null;
  };
  installWithSeed(context, 123456789, ['webgl']);

  const canvas = new context.HTMLCanvasElement();
  const gl = canvas.getContext('webgl');
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

  const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
  const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);

  assert.notEqual(vendor, 'Mozilla');
  assert.notEqual(renderer, 'Mozilla');
  assert.ok(typeof vendor === 'string' && vendor.length > 0);
  assert.ok(typeof renderer === 'string' && renderer.length > 0);
});

test('WebGL canvas toDataURL farbles correctly without blank output', () => {
  const context = createFullPageContext();
  installWithSeed(context, 123456789, ['canvas', 'webgl']);

  const canvas = new context.HTMLCanvasElement();
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl');

  const dataUrl = canvas.toDataURL();
  assert.ok(dataUrl && dataUrl.startsWith('data:image/png'));
  assert.notEqual(dataUrl, 'data:,');
});

test('Pilar B.1: CreepJS/Castle anti-detection camouflage (no own toString, no .prototype, non-constructible, brand checks, hidden registry symbol)', () => {
  const context = createFullPageContext();
  const symsBefore = vm.runInContext('Object.getOwnPropertySymbols(globalThis).length', context);
  installWithSeed(context, 123456789, ['canvas', 'webgl', 'audio', 'navigator', 'plugins', 'screen', 'speech']);
  const symsAfter = vm.runInContext('Object.getOwnPropertySymbols(globalThis).length', context);
  assert.equal(symsAfter, symsBefore, 'Registry symbol must be concealed from Object.getOwnPropertySymbols(window)');

  const probe = vm.runInContext(`
    (() => {
      const fn = CanvasRenderingContext2D.prototype.getImageData;
      const ownNames = Object.getOwnPropertyNames(fn).sort();
      const hasOwnToString = Object.prototype.hasOwnProperty.call(fn, 'toString');
      const hasPrototype = 'prototype' in fn;
      let constructThrew = false;
      try { Reflect.construct(fn, []); } catch (e) { constructThrew = e instanceof TypeError; }

      const hcGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency').get;
      const hcGetterOwnToString = Object.prototype.hasOwnProperty.call(hcGetter, 'toString');
      const hcGetterHasProto = 'prototype' in hcGetter;
      const hcGetterStr = Function.prototype.toString.call(hcGetter);
      let protoReceiverThrew = false;
      try { Navigator.prototype.hardwareConcurrency; } catch (e) { protoReceiverThrew = e instanceof TypeError; }
      let plainObjReceiverThrew = false;
      try { hcGetter.call({}); } catch (e) { plainObjReceiverThrew = e instanceof TypeError; }

      const swGetter = Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get;
      let screenProtoThrew = false;
      try { Screen.prototype.width; } catch (e) { screenProtoThrew = e instanceof TypeError; }
      let screenPlainThrew = false;
      try { swGetter.call({}); } catch (e) { screenPlainThrew = e instanceof TypeError; }

      return {
        ownNames,
        hasOwnToString,
        hasPrototype,
        constructThrew,
        hcGetterOwnToString,
        hcGetterHasProto,
        hcGetterStr,
        protoReceiverThrew,
        plainObjReceiverThrew,
        screenProtoThrew,
        screenPlainThrew,
      };
    })()
  `, context);

  assert.deepEqual([...probe.ownNames], ['length', 'name']);
  assert.equal(probe.hasOwnToString, false, 'Hooked method must NOT define an own toString property');
  assert.equal(probe.hasPrototype, false, 'Hooked WebIDL method must NOT expose .prototype');
  assert.equal(probe.constructThrew, true, 'Reflect.construct on WebIDL method must throw TypeError');
  assert.equal(probe.hcGetterOwnToString, false);
  assert.equal(probe.hcGetterHasProto, false);
  assert.equal(probe.hcGetterStr, 'function hardwareConcurrency() { [native code] }');
  assert.equal(probe.protoReceiverThrew, true, 'Navigator.prototype.hardwareConcurrency must throw Illegal invocation');
  assert.equal(probe.plainObjReceiverThrew, true, 'Getter called on {} must throw Illegal invocation');
  assert.equal(probe.screenProtoThrew, true, 'Screen.prototype.width must throw Illegal invocation');
  assert.equal(probe.screenPlainThrew, true);
});

test('Pilar B.2: WorkerGlobalScope, OffscreenCanvas (single-farbling), transparent alpha===0 safety, and matchMedia coherency', () => {
  // 1. Transparent alpha === 0 pixels must NEVER be mutated to impossible premultiplied RGB [1, 0, 0, 0]
  const ctxAlpha = createFullPageContext();
  ctxAlpha.CanvasRenderingContext2D.prototype.getImageData = function (_sx, _sy, sw, sh) {
    const data = new ctxAlpha.Uint8ClampedArray(sw * sh * 4);
    // Half transparent [0,0,0,0], half opaque [120,120,120,255]
    for (let i = 0; i < data.length; i += 4) {
      if (i < data.length / 2) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
      } else {
        data[i] = 120; data[i + 1] = 120; data[i + 2] = 120; data[i + 3] = 255;
      }
    }
    return { data, width: sw, height: sh };
  };
  installWithSeed(ctxAlpha, 123456789, ['canvas']);
  const cAlpha = new ctxAlpha.HTMLCanvasElement();
  cAlpha.width = 32;
  cAlpha.height = 32;
  const ctx2dAlpha = cAlpha.getContext('2d');
  ctx2dAlpha.canvas = cAlpha;
  const alphaOut = ctx2dAlpha.getImageData(0, 0, 32, 32).data;
  for (let i = 0; i < alphaOut.length / 2; i += 4) {
    assert.deepEqual([alphaOut[i], alphaOut[i + 1], alphaOut[i + 2], alphaOut[i + 3]], [0, 0, 0, 0],
      'Transparent alpha===0 pixel must never receive RGB noise');
  }
  let opaqueChanged = 0;
  for (let i = alphaOut.length / 2; i < alphaOut.length; i += 4) {
    if (alphaOut[i] !== 120 || alphaOut[i + 1] !== 120 || alphaOut[i + 2] !== 120) opaqueChanged++;
  }
  assert.ok(opaqueChanged > 0, 'Opaque pixels must still be deterministically farbled');

  // 2. WorkerGlobalScope realm (no window/Document/HTMLCanvasElement, has WorkerNavigator + OffscreenCanvas)
  class WorkerGlobalScope {}
  class WorkerNavigator {}
  const workerGlobal = Object.create(WorkerGlobalScope.prototype);
  Object.assign(workerGlobal, {
    WorkerGlobalScope,
    WorkerNavigator,
    navigator: new WorkerNavigator(),
    importScripts: () => {},
    OffscreenCanvas: createFullPageContext().OffscreenCanvas,
    OffscreenCanvasRenderingContext2D: createFullPageContext().OffscreenCanvasRenderingContext2D,
    Uint8ClampedArray,
    Uint8Array,
    Float32Array,
    ArrayBuffer,
  });
  workerGlobal.self = workerGlobal;
  workerGlobal.globalThis = workerGlobal;
  const workerCtx = vm.createContext(workerGlobal);
  const workerStatus = JSON.parse(vm.runInContext(
    source + '(123456789, ["canvas", "navigator"], { mode: "balanced", rfp: false })',
    workerCtx,
  ));
  assert.equal(workerStatus.canvas, 'installed', 'Canvas/OffscreenCanvas must install in WorkerGlobalScope');
  assert.equal(workerStatus.navigator, 'installed', 'WorkerNavigator must install in WorkerGlobalScope');

  // Verify Worker and Window share the EXACT same hardwareConcurrency & deviceMemory for the same seed!
  const winCtx = createFullPageContext();
  winCtx.innerWidth = 1280;
  winCtx.innerHeight = 720;
  winCtx.matchMedia = q => ({ matches: q === '(min-width: 0px)', media: q });
  installWithSeed(winCtx, 123456789, ['navigator', 'screen']);
  assert.equal(workerCtx.navigator.hardwareConcurrency, winCtx.navigator.hardwareConcurrency);
  assert.equal(workerCtx.navigator.deviceMemory, winCtx.navigator.deviceMemory);

  // Verify matchMedia(device-width) coherency with spoofed screen.width
  const spoofW = winCtx.screen.width;
  assert.equal(winCtx.matchMedia(`(device-width: ${spoofW}px)`).matches, true);
  assert.equal(winCtx.matchMedia(`(device-width: ${spoofW + 123}px)`).matches, false);
});

test('Pilar B.3: balanced vs strict vs off modes and Gecko RFP coexistence (no double font collision or letterbox override)', () => {
  // 1. RFP active: measureText is NOT double-jittered and screen dimensions preserve RFP letterboxed values
  const rfpCtx = createFullPageContext();
  rfpCtx.screen.width = 1000;
  rfpCtx.screen.height = 700;
  const rfpRes = JSON.parse(vm.runInContext(
    source + '(123456789, ["canvas", "screen"], { mode: "balanced", rfp: true })',
    rfpCtx,
  ));
  assert.equal(rfpRes.canvas, 'installed');
  assert.equal(rfpRes.screen, 'installed');
  const mRfp = new rfpCtx.HTMLCanvasElement().getContext('2d').measureText('RFP test');
  assert.equal(mRfp.width, 'RFP test'.length * 10, 'RFP active must avoid double font metric collision');
  assert.equal(rfpCtx.screen.width, 1000, 'RFP active must preserve RFP letterboxed screen width');
  assert.equal(rfpCtx.screen.height, 700, 'RFP active must preserve RFP letterboxed screen height');

  // 2. Strict mode: scrubs even real GPU UNMASKED strings and normalizes devicePixelRatio + prefers-color-scheme
  const strictCtx = createFullPageContext();
  strictCtx.devicePixelRatio = 1.375;
  strictCtx.matchMedia = q => ({ matches: q === '(min-width: 0px)', media: q });
  JSON.parse(vm.runInContext(
    source + '(123456789, ["webgl", "navigator", "screen"], { mode: "strict", rfp: false })',
    strictCtx,
  ));
  const glStrict = new strictCtx.HTMLCanvasElement().getContext('webgl');
  const dbg = glStrict.getExtension('WEBGL_debug_renderer_info');
  assert.notEqual(glStrict.getParameter(dbg.UNMASKED_VENDOR_WEBGL), 'Real GPU Vendor',
    'Strict mode must scrub real hardware vendor string');
  assert.ok([1, 2].includes(strictCtx.devicePixelRatio), 'Strict mode must normalize fractional DPR');
  assert.equal(strictCtx.matchMedia('(prefers-color-scheme: light)').matches, true);
  assert.equal(strictCtx.matchMedia('(prefers-color-scheme: dark)').matches, false);
});
