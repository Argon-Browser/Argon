// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import {
  BACKGROUND_SHIM_FILENAME,
  createChromeApiShimRuntime,
  generateBackgroundRuntimeShim,
} from "../../argon/extensions/background-runtime.mjs";
import { adaptChromeManifest } from "../../argon/extensions/compatibility-adapter.mjs";
import {
  buildZipArchive,
  computePackageIntegrity,
  crc32,
  inspectAndAdaptExtensionArchive,
  parseCrxPackage,
  readZipEntries,
  verifyPackageIntegrity,
} from "../../argon/extensions/extension-installer.mjs";

test("compatibility adapter translates MV3 service_worker, side_panel, options_page, and strips Chrome-only keys safely", () => {
  const chromeMv3 = {
    manifest_version: 3,
    name: "Chrome Productivity Suite",
    version: "1.2.3",
    minimum_chrome_version: "116",
    update_url: "https://clients2.google.com/service/update2/crx",
    options_page: "options.html",
    side_panel: {
      default_path: "sidebar.html",
    },
    permissions: ["storage", "tabs", "sidePanel", "offscreen"],
    host_permissions: ["https://example.org/*"],
    background: {
      service_worker: "sw.js",
      type: "module",
    },
  };

  const result = adaptChromeManifest(chromeMv3);
  assert.equal(result.ok, true);
  assert.equal(result.tier, "Adapted");
  assert.equal(
    result.adaptedManifest.browser_specific_settings.gecko.id,
    "chrome-productivity-suite@argon-bridge.local"
  );

  // Service worker bridged to background.scripts with shim
  assert.deepEqual(result.adaptedManifest.background, {
    scripts: [BACKGROUND_SHIM_FILENAME, "sw.js"],
    type: "module",
  });
  assert.ok(result.generatedFiles[BACKGROUND_SHIM_FILENAME]);

  // options_page -> options_ui
  assert.equal(result.adaptedManifest.options_page, undefined);
  assert.deepEqual(result.adaptedManifest.options_ui, {
    page: "options.html",
    open_in_tab: true,
  });

  // side_panel -> sidebar_action
  assert.equal(result.adaptedManifest.side_panel, undefined);
  assert.deepEqual(result.adaptedManifest.sidebar_action, {
    default_panel: "sidebar.html",
    default_title: "Chrome Productivity Suite",
  });

  // Chrome-only permissions stripped while standard permissions & hosts stay intact
  assert.deepEqual(result.adaptedManifest.permissions, ["storage", "tabs"]);
  assert.deepEqual(result.adaptedManifest.host_permissions, [
    "https://example.org/*",
  ]);
  assert.equal(result.adaptedManifest.minimum_chrome_version, undefined);
  assert.equal(result.adaptedManifest.update_url, undefined);
});

test("background runtime shim bridges MV3 service worker install/activate lifecycle and Chrome API aliases", async () => {
  const events = [];
  const targetGlobal = {
    addEventListener(type, fn) {
      events.push(["fallback", type, typeof fn]);
    },
  };

  const harness = createChromeApiShimRuntime(targetGlobal);
  assert.equal(typeof targetGlobal.skipWaiting, "function");
  assert.equal(typeof targetGlobal.clients?.claim, "function");
  assert.equal(typeof targetGlobal.chrome?.sidePanel?.setOptions, "function");
  assert.equal(typeof targetGlobal.chrome?.offscreen?.hasDocument, "function");

  let installedSettled = false;
  let activatedRan = false;

  targetGlobal.addEventListener("install", (evt) => {
    evt.waitUntil(
      Promise.resolve().then(() => {
        installedSettled = true;
      })
    );
  });

  targetGlobal.addEventListener("activate", () => {
    activatedRan = installedSettled;
  });

  harness.triggerInstall();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(installedSettled, true);
  assert.equal(activatedRan, true);
  assert.equal(await targetGlobal.chrome.offscreen.hasDocument(), false);

  const shimCode = generateBackgroundRuntimeShim({
    extensionId: "demo@argon-bridge.local",
    serviceWorker: "sw.js",
  });
  assert.match(shimCode, /demo@argon-bridge\.local/);
});

test("extension installer parses CRX2/CRX3 headers, verifies SHA-256 integrity, and produces adapted XPI archives", async () => {
  const sourceManifest = {
    manifest_version: 3,
    name: "Archive Test Extension",
    version: "1.0.0",
    permissions: ["storage", "offscreen"],
    background: {
      service_worker: "worker.js",
    },
  };

  const zipPayload = buildZipArchive({
    "manifest.json": JSON.stringify(sourceManifest, null, 2),
    "worker.js": "console.log('worker ready');\n",
  });

  // Wrap zipPayload inside a valid CRX3 binary container ("Cr24", version=3, headerLen=4)
  const crxHeader = new Uint8Array(16);
  const view = new DataView(crxHeader.buffer);
  view.setUint32(0, 0x34327243, true); // "Cr24"
  view.setUint32(4, 3, true); // version 3
  view.setUint32(8, 4, true); // 4-byte protobuf header stub
  const crx3Bytes = new Uint8Array(crxHeader.byteLength + zipPayload.byteLength);
  crx3Bytes.set(crxHeader, 0);
  crx3Bytes.set(zipPayload, crxHeader.byteLength);

  const parsedCrx = parseCrxPackage(crx3Bytes);
  assert.equal(parsedCrx.format, "crx3");
  assert.equal(parsedCrx.version, 3);
  assert.equal(parsedCrx.zipPayload.byteLength, zipPayload.byteLength);

  const integrity = await computePackageIntegrity(crx3Bytes);
  assert.equal(integrity.algorithm, "SHA-256");
  assert.match(integrity.hex, /^[0-9a-f]{64}$/);

  const verified = await verifyPackageIntegrity(crx3Bytes, integrity.sri);
  assert.equal(verified.verified, true);

  const inspected = await inspectAndAdaptExtensionArchive(crx3Bytes);
  assert.equal(inspected.containerFormat, "crx3");
  assert.equal(inspected.adaptation.ok, true);
  assert.equal(inspected.adaptation.tier, "Adapted");
  assert.ok(inspected.adaptedXpiBytes instanceof Uint8Array);

  // Verify the adapted XPI contains both the rewritten manifest.json and generated shim
  const adaptedEntries = await readZipEntries(inspected.adaptedXpiBytes);
  assert.equal(adaptedEntries.has("manifest.json"), true);
  assert.equal(adaptedEntries.has("worker.js"), true);
  assert.equal(adaptedEntries.has(BACKGROUND_SHIM_FILENAME), true);

  const adaptedManifest = JSON.parse(
    new TextDecoder().decode(adaptedEntries.get("manifest.json"))
  );
  assert.deepEqual(adaptedManifest.background.scripts, [
    BACKGROUND_SHIM_FILENAME,
    "worker.js",
  ]);
  assert.deepEqual(adaptedManifest.permissions, ["storage"]);
});

function buildDeflatedZip(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const compressed = deflateRawSync(raw);
    const sum = crc32(raw);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    local.push(lh, compressed);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
    offset += lh.length + compressed.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const chunk of local) { out.set(chunk, pos); pos += chunk.length; }
  for (const chunk of central) { out.set(chunk, pos); pos += chunk.length; }
  out.set(eocd, pos);
  return out;
}

test("extension installer inflates multi-entry deflated archives concurrently and preserves untouched compressed payloads", async () => {
  const repeatedAsset = "/* compressible padding */ ".repeat(200);
  const sourceEntries = [
    [
      "manifest.json",
      JSON.stringify({
        manifest_version: 3,
        name: "Deflated Multi Entry",
        version: "2.0.0",
        permissions: ["storage"],
        background: { service_worker: "bg.js" },
      }),
    ],
    ["bg.js", "console.log('bg');\n"],
  ];
  for (let i = 0; i < 20; i += 1) {
    sourceEntries.push([`assets/chunk-${i}.js`, `${repeatedAsset}// #${i}\n`]);
  }
  const deflatedZip = buildDeflatedZip(sourceEntries);
  const uncompressedPayloadBytes = sourceEntries.reduce(
    (sum, [, body]) => sum + body.length,
    0
  );

  const readBack = await readZipEntries(deflatedZip);
  assert.deepEqual([...readBack.keys()], sourceEntries.map(([name]) => name));
  assert.equal(new TextDecoder().decode(readBack.get("assets/chunk-17.js")), `${repeatedAsset}// #17\n`);

  const inspected = await inspectAndAdaptExtensionArchive(deflatedZip);
  assert.equal(inspected.adaptation.ok, true);
  assert.ok(inspected.adaptedXpiBytes.byteLength < uncompressedPayloadBytes / 4);

  const adaptedEntries = await readZipEntries(inspected.adaptedXpiBytes);
  assert.equal(adaptedEntries.has(BACKGROUND_SHIM_FILENAME), true);
  assert.equal(
    new TextDecoder().decode(adaptedEntries.get("assets/chunk-19.js")),
    `${repeatedAsset}// #19\n`
  );
  const adaptedManifest = JSON.parse(
    new TextDecoder().decode(adaptedEntries.get("manifest.json"))
  );
  assert.equal(adaptedManifest.background.scripts[0], BACKGROUND_SHIM_FILENAME);
});
