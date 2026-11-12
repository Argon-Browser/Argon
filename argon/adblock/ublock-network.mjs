// SPDX-License-Identifier: GPL-3.0-or-later
// Host adapter for the unmodified pinned uBlock network engine. One module
// realm per generation: upstream keeps its engine registers at module scope.
import snfe from './ublock/src/js/static-net-filtering.js';
import { AstFilterParser } from './ublock/src/js/static-filtering-parser.js';
import { CompiledListReader, CompiledListWriter } from './ublock/src/js/static-filtering-io.js';
import { FilteringContext } from './ublock/src/js/filtering-context.js';
import { LineIterator } from './ublock/src/js/text-utils.js';

const types = {
  document: 'main_frame',
  subdocument: 'sub_frame',
  xmlhttprequest: 'xmlhttprequest',
  csp_report: 'beacon',
};

const safeRedirectHref = (candidate, original) => {
  if (!candidate || candidate === original) return '';
  try {
    const parsed = new URL(candidate);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
};

export function compileNetworkList(text, { index = 0, trustedSource = false, trustedTokens = new Set() } = {}) {
  const compiler = snfe.createCompiler();
  const parser = new AstFilterParser({
    maxTokenLength: snfe.MAX_TOKEN_LENGTH,
    trustedSource: !!trustedSource,
    trustedTokens,
  });
  const writer = new CompiledListWriter();
  writer.properties.set('name', String(index));
  const diagnostics = [];
  const lines = new LineIterator(String(text || ''));
  while (!lines.eot()) {
    let line = lines.next();
    while (line.endsWith(' \\') && lines.peek(4) === '    ') {
      line = line.slice(0, -2).trim() + lines.next().trim();
    }
    parser.parse(line);
    if (!parser.isFilter() || !parser.isNetworkFilter()) continue;
    if (!compiler.compile(parser, writer) && diagnostics.length < 1000) {
      diagnostics.push({ list: index, rule: line, error: compiler.error || 'Unsupported network filter' });
    }
  }
  return { compiled: writer.toString(), diagnostics };
}

export class UBlockNetworkEngine {
  constructor() {
    this.context = new FilteringContext();
    this.resources = new Map();
    this.diagnostics = [];
  }

  compileList(text, options = {}) {
    return compileNetworkList(text, options);
  }

  load(lists, resources = []) {
    snfe.reset();
    this.diagnostics = [];
    this.resources.clear();
    const trustedTokens = new Set();
    for (const resource of resources) {
      const uri = `data:${resource.mime};base64,${resource.content}`;
      for (const name of [resource.name, ...(resource.aliases || [])]) {
        this.resources.set(name, uri);
        if (resource.requiresTrust) trustedTokens.add(name);
      }
    }
    for (const [index, entry] of lists.entries()) {
      if (entry && typeof entry === 'object' && typeof entry.compiled === 'string') {
        if (Array.isArray(entry.diagnostics)) {
          for (const item of entry.diagnostics) {
            if (this.diagnostics.length >= 1000) break;
            this.diagnostics.push(item);
          }
        }
        snfe.fromCompiled(new CompiledListReader(entry.compiled));
        continue;
      }
      const text = typeof entry === 'string' ? entry : (entry?.text || '');
      const trustedSource = typeof entry === 'object' && entry !== null && entry.trusted === true;
      const result = compileNetworkList(text, { index, trustedSource, trustedTokens });
      for (const item of result.diagnostics) {
        if (this.diagnostics.length >= 1000) break;
        this.diagnostics.push(item);
      }
      snfe.fromCompiled(new CompiledListReader(result.compiled));
    }
    snfe.freeze();
    // The JS engine is complete without optional WASM acceleration. No eval,
    // JIT source generation or parent-process security exemptions are used.
    return { loaded: true, diagnostics: this.diagnostics };
  }

  request(url, source, type, method = 'GET') {
    const context = this.context.fromDetails({ originURL: source, url, type: types[type] || type });
    context.setMethod(method);
    context.aliasURL = undefined;
    context.redirectURL = undefined;
    return context;
  }

  check(url, source, type, method = 'GET', options = {}) {
    let context = this.request(url, source, type, method);
    let result = snfe.matchRequest(context);
    let uncloaked = false;
    const cname = typeof options?.cname === 'string' ? options.cname.trim().toLowerCase() : '';
    if (result === 0 && cname && cname !== context.getHostname()) {
      const cnameCheck = this.request(source || url, source || url, 'cname', '');
      if (snfe.matchRequest(cnameCheck, 0b11) !== 2) {
        try {
          const aliased = new URL(url);
          aliased.hostname = cname;
          if (aliased.hostname === cname) {
            const cnameContext = this.request(aliased.href, source, type, method);
            cnameContext.aliasURL = url;
            const cnameResult = snfe.matchRequest(cnameContext);
            if (cnameResult !== 0) {
              context = cnameContext;
              result = cnameResult;
              uncloaked = true;
            }
          }
        } catch {}
      }
    }
    const log = result ? snfe.toLogData() : null;
    const output = { matched: result === 1 };
    if (uncloaked) output.cname = cname;
    if (log) output[result === 2 ? 'exception' : 'filter'] = { raw_line: log.raw };
    if (result === 1) {
      snfe.redirectRequest({
        hasToken: name => this.resources.has(name),
        tokenToURL: (_context, name) => this.resources.get(name),
      }, context);
      if (context.redirectURL) {
        output.redirect = context.redirectURL;
      } else {
        snfe.urlSkip(context, true);
        const skipped = safeRedirectHref(context.redirectURL, url);
        if (skipped) {
          output.matched = false;
          output.rewritten_url = skipped;
        }
      }
    } else {
      const modifyContext = uncloaked ? this.request(url, source, type, method) : context;
      snfe.transformURL(modifyContext);
      if (!modifyContext.redirectURL) snfe.urlSkip(modifyContext, false);
      if (!modifyContext.redirectURL) snfe.filterQuery(modifyContext);
      const rewritten = safeRedirectHref(modifyContext.redirectURL, url);
      if (rewritten) output.rewritten_url = rewritten;
    }
    return output;
  }

  csp(url, source, type, method) {
    const directives = snfe.matchAndFetchModifiers(this.request(url, source, type, method), 'csp') || [];
    return directives.filter(d => (d.bits & 1) === 0).map(d => d.value);
  }

  permissions(url, source, type, method) {
    const directives = snfe.matchAndFetchModifiers(this.request(url, source, type, method), 'permissions') || [];
    return directives.filter(d => (d.bits & 1) === 0).map(d => d.value.replaceAll('|', ', '));
  }

  matchHeaders(url, source, type, method, responseHeaders = [], requestHeaders = []) {
    const context = this.request(url, source, type, method);
    const result = snfe.matchHeaders(context, responseHeaders, requestHeaders);
    const log = result ? snfe.toLogData() : null;
    const output = { matched: result === 1 };
    if (log) output[result === 2 ? 'exception' : 'filter'] = { raw_line: log.raw };
    return output;
  }

  cosmetic(url) {
    const generichide = snfe.matchRequest(this.request(url, url, 'generichide', ''), 0b11) === 2;
    const specifichide = snfe.matchRequest(this.request(url, url, 'specifichide', ''), 0b11) === 2;
    return { generichide, specifichide, elemhide: generichide && specifichide };
  }

  close() {
    snfe.reset();
  }
}
