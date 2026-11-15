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

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const ZIP_IO_CONCURRENCY = 8;

async function transformRawBytes(bytes, stream) {
  const writer = stream.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const ab = await new Response(stream.readable).arrayBuffer();
  await writePromise;
  return new Uint8Array(ab);
}

async function inflateRawBytes(compressedBytes) {
  return transformRawBytes(compressedBytes, new DecompressionStream("deflate-raw"));
}

async function deflateRawBytes(uncompressedBytes) {
  return transformRawBytes(uncompressedBytes, new CompressionStream("deflate-raw"));
}

async function mapWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parses ZIP End-of-Central-Directory and Central Directory headers synchronously,
 * returning byte slices for all file entries without decompressing payloads.
 */
function parseZipDirectory(inputZipBytes) {
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

  const records = new Map();
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > bytes.byteLength) {
      throw new RangeError("Truncated ZIP central directory entry");
    }
    const sig = view.getUint32(ptr, true);
    if (sig !== ZIP_CENTRAL_DIR_SIG) {
      throw new Error("Corrupt ZIP central directory signature");
    }

    const flags = view.getUint16(ptr + 8, true);
    const compressionMethod = view.getUint16(ptr + 10, true);
    const modTime = view.getUint16(ptr + 12, true);
    const modDate = view.getUint16(ptr + 14, true);
    const entryCrc = view.getUint32(ptr + 16, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
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

    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for ${fileName}`
      );
    }

    records.set(fileName, {
      fileName,
      flags,
      compressionMethod,
      modTime,
      modDate,
      crc: entryCrc,
      compressedSize,
      uncompressedSize,
      rawSlice: bytes.subarray(dataStart, dataEnd),
    });
  }

  return records;
}

/**
 * Reads all file entries from a ZIP archive buffer (supporting Store method 0
 * and Deflate method 8) with bounded-concurrency inflation.
 */
export async function readZipEntries(inputZipBytes) {
  const records = parseZipDirectory(inputZipBytes);
  const entries = new Map();
  const deflateRecords = [];

  for (const [fileName, rec] of records) {
    if (rec.compressionMethod === 0) {
      entries.set(fileName, new Uint8Array(rec.rawSlice));
    } else {
      entries.set(fileName, null);
      deflateRecords.push(rec);
    }
  }

  await mapWithConcurrency(deflateRecords, ZIP_IO_CONCURRENCY, async (rec) => {
    entries.set(rec.fileName, await inflateRawBytes(rec.rawSlice));
  });

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

function buildPreparedEntry(rawName, rawContent) {
  const cleanName = String(rawName).replace(/^\/+/, "");
  const nameBytes = encoder.encode(cleanName);
  const dataBytes =
    typeof rawContent === "string"
      ? encoder.encode(rawContent)
      : toUint8Array(rawContent);
  return {
    nameBytes,
    method: 0,
    flags: 0x0800,
    modTime: 0,
    modDate: 0,
    crc: crc32(dataBytes),
    uncompressedSize: dataBytes.byteLength,
    compressedBytes: dataBytes,
  };
}

async function buildCompressedPreparedEntry(rawName, rawContent) {
  const entry = buildPreparedEntry(rawName, rawContent);
  if (typeof CompressionStream === "function" && entry.uncompressedSize >= 128) {
    const deflated = await deflateRawBytes(entry.compressedBytes);
    if (deflated.byteLength < entry.uncompressedSize) {
      entry.method = 8;
      entry.compressedBytes = deflated;
    }
  }
  return entry;
}

function assembleZipArchive(preparedEntries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of preparedEntries) {
    const {
      nameBytes,
      method,
      flags,
      modTime,
      modDate,
      crc,
      uncompressedSize,
      compressedBytes,
    } = entry;
    const compressedSize = compressedBytes.byteLength;

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_SIG, true);
    localView.setUint16(4, 20, true); // Version needed: 2.0
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, modTime, true);
    localView.setUint16(12, modDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, compressedBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIR_SIG, true);
    centralView.setUint16(4, 20, true); // Version made by
    centralView.setUint16(6, 20, true); // Version needed
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, modTime, true);
    centralView.setUint16(14, modDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);
    localOffset += localHeader.byteLength + compressedSize;
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
  eocdView.setUint16(8, preparedEntries.length, true);
  eocdView.setUint16(10, preparedEntries.length, true);
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
 * Builds a valid ZIP/XPI archive from a map or object of `{ [path]: Uint8Array | string }`.
 */
export function buildZipArchive(filesMap) {
  const entries =
    filesMap instanceof Map
      ? [...filesMap.entries()]
      : Object.entries(filesMap);
  const preparedEntries = entries.map(([rawName, rawContent]) =>
    buildPreparedEntry(rawName, rawContent)
  );
  return assembleZipArchive(preparedEntries);
}

/**
 * Inspects a `.crx`, `.zip`, or `.xpi` archive, extracts `manifest.json`,
 * runs static analysis and compatibility adaptation, and builds an adapted
 * XPI package preserving untouched entry payloads and compression metadata.
 */
export async function inspectAndAdaptExtensionArchive(
  inputBytes,
  options = {}
) {
  const integrity = await computePackageIntegrity(inputBytes);
  const container = detectArchiveContainer(inputBytes);
  const records = parseZipDirectory(container.zipPayload);
  const manifestRecord = records.get("manifest.json");

  if (!manifestRecord) {
    throw new Error("Extension archive does not contain a root manifest.json");
  }

  const manifestBytes =
    manifestRecord.compressionMethod === 8
      ? await inflateRawBytes(manifestRecord.rawSlice)
      : manifestRecord.rawSlice;
  const rawManifestText = decoder.decode(manifestBytes);
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(rawManifestText);
  } catch (err) {
    throw new Error(`Malformed manifest.json in archive: ${err.message}`);
  }

  const analysis = analyzeManifest(parsedManifest, { fromJsonParse: true });
  const adaptation = adaptChromeManifest(parsedManifest, {
    ...options,
    fromJsonParse: true,
    initialAnalysis: analysis,
  });

  let adaptedXpiBytes = null;
  if (adaptation.ok && adaptation.adaptedManifest) {
    const replacements = new Map();
    replacements.set(
      "manifest.json",
      `${JSON.stringify(adaptation.adaptedManifest, null, 2)}\n`
    );
    for (const [fileName, fileSource] of Object.entries(
      adaptation.generatedFiles
    )) {
      replacements.set(fileName, fileSource);
    }

    const compressedReplacements = new Map();
    await mapWithConcurrency(
      [...replacements.entries()],
      ZIP_IO_CONCURRENCY,
      async ([fileName, fileSource]) => {
        compressedReplacements.set(
          fileName,
          await buildCompressedPreparedEntry(fileName, fileSource)
        );
      }
    );

    const preparedEntries = [];
    for (const [fileName, rec] of records) {
      if (compressedReplacements.has(fileName)) {
        preparedEntries.push(compressedReplacements.get(fileName));
        compressedReplacements.delete(fileName);
      } else {
        const cleanName = String(fileName).replace(/^\/+/, "");
        preparedEntries.push({
          nameBytes: encoder.encode(cleanName),
          method: rec.compressionMethod,
          flags: (rec.flags | 0x0800) & ~0x0008,
          modTime: rec.modTime,
          modDate: rec.modDate,
          crc: rec.crc,
          uncompressedSize: rec.uncompressedSize,
          compressedBytes: rec.rawSlice,
        });
      }
    }
    for (const [fileName] of replacements) {
      if (compressedReplacements.has(fileName)) {
        preparedEntries.push(compressedReplacements.get(fileName));
      }
    }

    adaptedXpiBytes = assembleZipArchive(preparedEntries);
  }

  return {
    containerFormat: container.format,
    integrity,
    fileCount: records.size,
    fileNames: [...records.keys()],
    rawManifest: parsedManifest,
    analysis,
    adaptation,
    adaptedXpiBytes,
  };
}
