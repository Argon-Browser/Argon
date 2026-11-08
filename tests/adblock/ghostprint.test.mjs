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
  for (const value of [null,undefined,'','null','undefined',{},new Error('')]) assert.equal(panel.formatProtectionError(value),'Falha desconhecida. Tente novamente ou recarregue a aba.');
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
