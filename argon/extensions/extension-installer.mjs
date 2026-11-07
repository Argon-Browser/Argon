// SPDX-License-Identifier: MPL-2.0

import { adaptChromeManifest } from "./compatibility-adapter.mjs";
import { analyzeManifest } from "./manifest-analyzer.mjs";

const CRX_MAGIC = 0x34327243; // "Cr24" in little-endian
const ZIP_LOCAL_FILE_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_END_CENTRAL_DIR_SIG = 0x06054b50;

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected binary package data as Uint8Array or ArrayBuffer");
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Computes the SHA-256 cryptographic integrity digest of an extension archive.
 */
export async function computePackageIntegrity(inputBytes) {
  const bytes = toUint8Array(inputBytes);
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = bytesToHex(new Uint8Array(digestBuffer));
  return {
    algorithm: "SHA-256",
    hex,
    sri: `sha256-${hex}`,
    byteLength: bytes.byteLength,
  };
}

export async function verifyPackageIntegrity(inputBytes, expectedHexOrSri) {
  const integrity = await computePackageIntegrity(inputBytes);
  const cleanExpected = String(expectedHexOrSri || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256-/, "");
  return {
    verified: Boolean(cleanExpected) && integrity.hex === cleanExpected,
    expected: cleanExpected,
    actual: integrity.hex,
    integrity,
  };
}

/**
 * Parses a Chrome Extension `.crx` container (CRX2 or CRX3) and extracts the
 * embedded ZIP archive payload without executing any contained scripts.
 */
export function parseCrxPackage(inputBytes) {
  const bytes = toUint8Array(inputBytes);
  if (bytes.byteLength < 12) {
    throw new RangeError("CRX package is truncated (fewer than 12 bytes)");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== CRX_MAGIC) {
    throw new Error("Invalid CRX magic header (expected 'Cr24')");
  }

  const version = view.getUint32(4, true);
  if (version === 2) {
    if (bytes.byteLength < 16) {
      throw new RangeError("CRX2 header is truncated");
    }
    const pubKeyLen = view.getUint32(8, true);
    const sigLen = view.getUint32(12, true);
    const zipOffset = 16 + pubKeyLen + sigLen;
    if (zipOffset > bytes.byteLength) {
      throw new RangeError("CRX2 header lengths exceed package size");
    }
    return {
      format: "crx2",
      version: 2,
      headerByteLength: zipOffset,
      zipPayload: bytes.subarray(zipOffset),
    };
  }

  if (version === 3) {
    const headerLen = view.getUint32(8, true);
    const zipOffset = 12 + headerLen;
    if (zipOffset > bytes.byteLength) {
      throw new RangeError("CRX3 header length exceeds package size");
    }
    return {
      format: "crx3",
      version: 3,
      headerByteLength: zipOffset,
      zipPayload: bytes.subarray(zipOffset),
    };
  }

  throw new Error(`Unsupported CRX container version: ${version}`);
}

export function detectArchiveContainer(inputBytes) {
  const bytes = toUint8Array(inputBytes);
  if (bytes.byteLength >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sig = view.getUint32(0, true);
    if (sig === CRX_MAGIC) {
      return parseCrxPackage(bytes);
    }
    if (sig === ZIP_LOCAL_FILE_SIG || sig === ZIP_END_CENTRAL_DIR_SIG) {
      return {
        format: "zip",
        version: null,
        headerByteLength: 0,
        zipPayload: bytes,
      };
    }
  }
  throw new Error(
    "Unrecognized archive container (expected CRX2, CRX3, ZIP, or XPI)"
  );
}

async function inflateRawBytes(compressedBytes) {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const response = new Response(ds.readable);
  const ab = await response.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Reads all file entries from a ZIP archive buffer (supporting Store method 0
 * and Deflate method 8).
 */
export async function readZipEntries(inputZipBytes) {
  const bytes = toUint8Array(inputZipBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (EOCD) record from the end of the buffer
  let eocdOffset = -1;
  const minEocdSearch = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minEocdSearch; i -= 1) {
    if (view.getUint32(i, true) === ZIP_END_CENTRAL_DIR_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP archive: End of Central Directory not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const decoder = new TextDecoder("utf-8");
  const entries = new Map();
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > bytes.byteLength) {
      throw new RangeError("Truncated ZIP central directory entry");
    }
    const sig = view.getUint32(ptr, true);
    if (sig !== ZIP_CENTRAL_DIR_SIG) {
      throw new Error("Corrupt ZIP central directory signature");
    }

    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const fileName = decoder.decode(nameBytes);

    ptr += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith("/")) continue;

    if (localHeaderOffset + 30 > bytes.byteLength) {
      throw new RangeError(`Invalid local header offset for ${fileName}`);
    }
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== ZIP_LOCAL_FILE_SIG) {
      throw new Error(`Invalid local file header signature for ${fileName}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new RangeError(`Truncated file data for ${fileName}`);
    }

    const rawSlice = bytes.subarray(dataStart, dataEnd);
    let contentBytes;
    if (compressionMethod === 0) {
      contentBytes = new Uint8Array(rawSlice);
    } else if (compressionMethod === 8) {
      contentBytes = await inflateRawBytes(rawSlice);
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for ${fileName}`
      );
    }

    entries.set(fileName, contentBytes);
  }

  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a valid ZIP/XPI archive from a map or object of `{ [path]: Uint8Array | string }`.
 */
export function buildZipArchive(filesMap) {
  const encoder = new TextEncoder();
  const entries =
    filesMap instanceof Map
      ? [...filesMap.entries()]
      : Object.entries(filesMap);

  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const [rawName, rawContent] of entries) {
    const cleanName = String(rawName).replace(/^\/+/, "");
    const nameBytes = encoder.encode(cleanName);
    const dataBytes =
      typeof rawContent === "string"
        ? encoder.encode(rawContent)
        : toUint8Array(rawContent);
    const crc = crc32(dataBytes);
    const size = dataBytes.byteLength;

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_SIG, true);
    localView.setUint16(4, 20, true); // Version needed: 2.0
    localView.setUint16(6, 0x0800, true); // UTF-8 flag
    localView.setUint16(8, 0, true); // Store method (0)
    localView.setUint16(10, 0, true); // Mod time
    localView.setUint16(12, 0, true); // Mod date
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIR_SIG, true);
    centralView.setUint16(4, 20, true); // Version made by
    centralView.setUint16(6, 20, true); // Version needed
    centralView.setUint16(8, 0x0800, true); // UTF-8 flag
    centralView.setUint16(10, 0, true); // Store method (0)
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);
    localOffset += localHeader.byteLength + size;
  }

  let centralSize = 0;
  for (const chunk of centralChunks) {
    centralSize += chunk.byteLength;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_END_CENTRAL_DIR_SIG, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);
  eocdView.setUint16(20, 0, true);

  const totalSize = localOffset + centralSize + 22;
  const output = new Uint8Array(totalSize);
  let cursor = 0;
  for (const chunk of localChunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  for (const chunk of centralChunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  output.set(eocd, cursor);
  return output;
}

/**
 * Inspects a `.crx`, `.zip`, or `.xpi` archive, extracts `manifest.json`,
 * runs static analysis and compatibility adaptation, and builds an adapted
 * XPI package ready for installation.
 */
export async function inspectAndAdaptExtensionArchive(
  inputBytes,
  options = {}
) {
  const integrity = await computePackageIntegrity(inputBytes);
  const container = detectArchiveContainer(inputBytes);
  const entries = await readZipEntries(container.zipPayload);

  if (!entries.has("manifest.json")) {
    throw new Error("Extension archive does not contain a root manifest.json");
  }

  const decoder = new TextDecoder("utf-8");
  const rawManifestText = decoder.decode(entries.get("manifest.json"));
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(rawManifestText);
  } catch (err) {
    throw new Error(`Malformed manifest.json in archive: ${err.message}`);
  }

  const analysis = analyzeManifest(parsedManifest);
  const adaptation = adaptChromeManifest(parsedManifest, options);

  let adaptedXpiBytes = null;
  if (adaptation.ok && adaptation.adaptedManifest) {
    const updatedEntries = new Map(entries);
    updatedEntries.set(
      "manifest.json",
      `${JSON.stringify(adaptation.adaptedManifest, null, 2)}\n`
    );
    for (const [fileName, fileSource] of Object.entries(
      adaptation.generatedFiles
    )) {
      updatedEntries.set(fileName, fileSource);
    }
    adaptedXpiBytes = buildZipArchive(updatedEntries);
  }

  return {
    containerFormat: container.format,
    integrity,
    fileCount: entries.size,
    fileNames: [...entries.keys()],
    rawManifest: parsedManifest,
    analysis,
    adaptation,
    adaptedXpiBytes,
  };
}
