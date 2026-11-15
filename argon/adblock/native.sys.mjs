// SPDX-License-Identifier: MPL-2.0
const { ctypes } = ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs');
const NATIVE_LIB_CHROME_URL = 'chrome://browser/content/argon/adblock/libargon_adblock.so';

function resolveUnpackedLibraryPath() {
  try {
    const uri = Services.io.newURI(NATIVE_LIB_CHROME_URL);
    const chromeRegistry = Cc['@mozilla.org/chrome/chrome-registry;1']?.getService?.(Ci.nsIChromeRegistry);
    const resolved = chromeRegistry?.convertChromeURL?.(uri);
    if (resolved?.scheme === 'file') {
      const file = resolved.QueryInterface(Ci.nsIFileURL)?.file;
      if (file?.exists?.() && file.isFile?.()) return file.path;
    }
  } catch {}
  return null;
}

function openEngineLibrary(path) {
  const library = ctypes.open(path);
  try {
    const call = library.declare('execute_json', ctypes.default_abi, ctypes.char.ptr, ctypes.char.ptr);
    return new NativeAdblockEngine(library, call);
  } catch (error) {
    library.close();
    throw error;
  }
}

// No privileged WASM/eval exemptions: load the bundled native Rust library.
export class NativeAdblockEngine {
  static async create() {
    if (Services.appinfo.OS !== 'Linux') throw new Error('Native adblock library currently built for Linux only; keep uBlock fallback');
    const directPath = resolveUnpackedLibraryPath();
    if (directPath) {
      try {
        return openEngineLibrary(directPath);
      } catch {}
    }
    const bytes = new Uint8Array(await (await fetch(NATIVE_LIB_CHROME_URL)).arrayBuffer());
    const path = PathUtils.join(PathUtils.profileDir, 'argon-adblock-' + Services.uuid.generateUUID().toString() + '.so');
    await IOUtils.write(path, bytes, { mode: 'create' });
    try {
      return openEngineLibrary(path);
    } finally { await IOUtils.remove(path); }
  }
  constructor(library, invoke) { this.library = library; this.invoke = invoke; }
  call(value) {
    const result = JSON.parse(this.invoke(JSON.stringify(value)).readString());
    if (result.error) throw new Error(result.error);
    return result;
  }
  close() { if (this.library) { this.library.close(); this.library = null; } }
  load(lists) { return this.call({ op: 'load', lists }); }
  check(url, source, type, method = 'GET') { return this.call({ op: 'check', url, source, type, method }); }
  cosmetic(url) { return this.call({ op: 'cosmetic', url }); }
}
