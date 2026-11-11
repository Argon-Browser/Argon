// SPDX-License-Identifier: MPL-2.0
// Executes the pinned Brave adblock-rust engine in browser-owned WebAssembly.
export class RustAdblockEngine {
  static async create(bytes, wasm = WebAssembly) {
    const { instance } = await wasm.instantiate(bytes, {});
    return new RustAdblockEngine(instance.exports);
  }
  constructor(exports) { this.exports = exports; }
  call(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const pointer = this.exports.input_buffer(bytes.length);
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    const output = this.exports.execute();
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(this.exports.memory.buffer, output, this.exports.output_len())));
    if (result.error) throw new Error(result.error);
    return result;
  }
  load(lists, resources) { return this.call({ op: 'load', lists, resources }); }
  check(url, source, type, method = 'GET') { return this.call({ op: 'check', url, source, type, method }); }
  csp(url, source, type, method = 'GET') { return this.call({ op: 'csp', url, source, type, method }).directives; }
  cosmetic(url) { return this.call({ op: 'cosmetic', url }); }
}
