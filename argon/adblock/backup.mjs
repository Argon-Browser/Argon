// SPDX-License-Identifier: MPL-2.0
// Pure backup parsing: never downloads, persists configuration or swaps engines.
// The caller must compile the returned candidate and commit it transactionally.
import { validateSubscriptions, validateSubscriptionURL } from './subscriptions.mjs';
import { parseDynamicRule, parseHostnameSwitchRule, parseURLFilteringRule } from './dynamic.mjs';
import { sha256 } from './updater.mjs';

export const BACKUP_VERSION = 1;
// Verified against the pinned source, not a dashboard-shaped approximation.
export const UBLOCK_BACKUP_SOURCE = Object.freeze({
  commit: '3762a26fd65df422080c116e6a70d13bc8d57d62',
  url: 'https://github.com/gorhill/uBlock/blob/3762a26fd65df422080c116e6a70d13bc8d57d62/src/js/messaging.js#L1008-L1024',
  sha256: 'b59599553e0e5ff8d397bd9cff71c4e6eea0a4754f897265196e3879e9d8e6d4',
});
const FORMAT = 'argon-adblock-backup';
const clone = value => JSON.parse(JSON.stringify(value));
export const BACKUP_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024,
  filtersBytes: 1024 * 1024, sites: 10000, rules: 10000, depth: 32, nodes: 100000 });
const encoder = new TextEncoder();
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const configKeys = ['filters', 'sites', 'disabledLists', 'dynamicRules', 'hostnameSwitches', 'urlRules', 'largeMediaSize', 'subscriptions'];
const subscriptionKeys = ['id', 'url', 'title', 'enabled', 'intervalHours'];
const ephemeral = new Set(['privateSites', 'privateRules', 'privateFilters', 'privateSwitches', 'privateUrlRules', 'sessionRules', 'session', 'logger', 'logs', 'requests',
  'lastGoodSha256', 'cacheSha256', 'lastSources', 'lastUpdated', 'lastAttempt', 'error']);

function warning(warnings, code, path, message) { warnings.push({ code, path, message }); }

function unknownSettings(source, known, prefix, unsupported, warnings) {
  for (const [key, value] of Object.entries(source)) {
    if (known.includes(key)) continue;
    const path = prefix ? prefix + '.' + key : key;
    if (ephemeral.has(key)) { warning(warnings, 'excluded-ephemeral', path, 'Dado privado, temporário ou de cache excluído.'); continue; }
    unsupported[path] = value;
    warning(warnings, 'unsupported-setting', path, 'Configuração preservada, mas não aplicada pelo Argon.');
  }
}

function subscriptionExtensions(subscriptions, unsupported, warnings) {
  for (const sub of array(subscriptions, 'subscriptions', 64)) {
    unknownSettings(sub, subscriptionKeys, 'config.subscriptions.' + sub.id, unsupported, warnings);
  }
}

function retainedData(value, warnings, path = 'unsupported') {
  if (Array.isArray(value)) return value.map((item, index) => retainedData(item, warnings, path + '.' + index));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (ephemeral.has(key.split('.').at(-1))) {
      warning(warnings, 'excluded-ephemeral', path + '.' + key, 'Dado privado, temporário ou de cache excluído.');
    } else output[key] = retainedData(item, warnings, path + '.' + key);
  }
  return output;
}

function result(source, config, warnings, unsupported, catalog) {
  const retained = retainedData(unsupported, warnings);
  if (Object.keys(retained).length) config.migrationData = clone(retained);
  return { source, config, warnings, unsupported: retained, catalog };
}

// Only JSON data is accepted, not accessors, class instances, or executable
// objects. Proxies cannot be detected without traps; this is a JSON boundary.
function safeData(input) {
  let nodes = 0, bytes = 0;
  const seen = new Set();
  function visit(value, depth) {
    if (++nodes > BACKUP_LIMITS.nodes || depth > BACKUP_LIMITS.depth) throw new Error('Limite de profundidade/dados do backup');
    if (typeof value === 'string') {
      bytes += encoder.encode(value).length;
      if (bytes > BACKUP_LIMITS.bytes) throw new Error('Limite de tamanho do backup');
      return value;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Backup exige dados JSON');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if ((!array && proto !== Object.prototype && proto !== null) || (array && proto !== Array.prototype)) throw new Error('Protótipo inválido no backup');
    seen.add(value);
    const result = array ? [] : {};
    if (array && value.length > BACKUP_LIMITS.nodes) throw new Error('Limite de dados do backup');
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || forbidden.has(key)) throw new Error('Chave de protótipo insegura');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('Acessor não permitido: somente dados JSON');
      bytes += encoder.encode(key).length;
      result[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return result;
  }
  return visit(input, 0);
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Objeto inválido: ' + name);
  return value;
}

function boundedText(value, name, bytes = BACKUP_LIMITS.filtersBytes) {
  if (typeof value !== 'string' || value.length > bytes || encoder.encode(value).length > bytes || value.includes('\0')) throw new Error('Limite/tipo inválido: ' + name);
  return value;
}

function array(value, name, max = 10000) {
  if (!Array.isArray(value) || value.length > max) throw new Error('Limite/tipo inválido: ' + name);
  return value;
}

function listID(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id) || forbidden.has(id) || id === '.' || id === '..') throw new Error('ID de lista inválido');
  return id;
}

function hostname(host) {
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s/@?#\\:%]/.test(host.replace(/^\[[0-9a-f:]+\]$/, 'ipv6')) || new URL('https://' + host).hostname !== host) throw new Error('Hostname inválido');
  return host;
}

function catalogOf(manifest) {
  const ids = new Set();
  return array(record(manifest, 'manifesto').lists, 'catálogo', 2048).map(item => {
    record(item, 'lista');
    const id = listID(item.id), url = validateSubscriptionURL(item.url);
    if (ids.has(id)) throw new Error('ID de catálogo duplicado');
    ids.add(id);
    return { id, url };
  });
}

function mapListIDs(ids, sourceCatalog, targetCatalog, path, unsupported, warnings) {
  const mapped = new Set(), unavailable = [];
  for (const id of ids) {
    listID(id);
    const source = sourceCatalog.find(list => list.id === id);
    const target = source ? targetCatalog.find(list => list.url === source.url) : targetCatalog.find(list => list.id === id);
    if (target) mapped.add(target.id);
    else {
      unavailable.push(id);
      warning(warnings, 'unavailable-list', path + '.' + id, 'Lista indisponível no manifesto atual; seleção preservada sem inventar substituta.');
    }
  }
  if (unavailable.length) unsupported[path] = unavailable;
  return [...mapped];
}

function validateConfig(config) {
  record(config, 'config');
  boundedText(config.filters, 'filters');
  if (/<(?:!doctype|html)/i.test(config.filters)) throw new Error('HTML não permitido em filtros');
  array(config.sites, 'sites', BACKUP_LIMITS.sites).forEach(hostname);
  array(config.disabledLists, 'disabledLists', 2048).forEach(listID);
  for (const line of array(config.dynamicRules, 'dynamicRules', BACKUP_LIMITS.rules)) {
    boundedText(line, 'regra dinâmica', 4096);
    const rule = parseDynamicRule(line);
    if (!rule) throw new Error('Regra dinâmica inválida');
    if (rule.src !== '*') hostname(rule.src);
    if (rule.des !== '*') hostname(rule.des);
  }
  for (const line of array(config.hostnameSwitches ?? [], 'hostnameSwitches', BACKUP_LIMITS.rules)) {
    boundedText(line, 'chave de site', 4096);
    const rule = parseHostnameSwitchRule(line);
    if (!rule) throw new Error('Chave de site inválida');
    if (rule.hostname !== '*') hostname(rule.hostname);
  }
  for (const line of array(config.urlRules ?? [], 'urlRules', BACKUP_LIMITS.rules)) {
    boundedText(line, 'regra de URL', 4096);
    const rule = parseURLFilteringRule(line);
    if (!rule) throw new Error('Regra dinâmica de URL inválida');
    if (rule.src !== '*') hostname(rule.src);
    const parsed = new URL(rule.url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('URL inválida em regra dinâmica');
    }
  }
  if (config.largeMediaSize !== undefined &&
      (!Number.isSafeInteger(config.largeMediaSize) || config.largeMediaSize < 0 || config.largeMediaSize > 1048576)) {
    throw new Error('Limite de mídia grande inválido');
  }
  validateSubscriptions(config.subscriptions);
  return config;
}

function portableSubscriptions(subscriptions = []) {
  validateSubscriptions(subscriptions);
  return subscriptions.map(({ id, url, title, enabled, intervalHours }) => ({ id, url, title, enabled, intervalHours }));
}

function restoredSubscriptions(subscriptions = []) {
  return validateSubscriptions(array(subscriptions, 'subscriptions', 64).map(({ id, url, title, enabled, intervalHours }) => ({ id, url, title, enabled, intervalHours,
    lastUpdated: 0, lastAttempt: 0, lastGoodSha256: null, lastSources: [], error: null,
  })));
}

export function createBackup(config, { manifest, now = () => Date.now() } = {}) {
  const unsupported = safeData(config.migrationData || {});
  unknownSettings(config, [...configKeys, 'migrationData'], 'config', unsupported, []);
  subscriptionExtensions(config.subscriptions || [], unsupported, []);
  const data = { format: FORMAT, version: BACKUP_VERSION, createdAt: now(),
    catalog: catalogOf(manifest),
    config: { filters: config.filters || '', sites: [...(config.sites || [])],
      disabledLists: [...(config.disabledLists || [])], dynamicRules: [...(config.dynamicRules || [])],
      hostnameSwitches: [...(config.hostnameSwitches || [])], urlRules: [...(config.urlRules || [])],
      largeMediaSize: Number.isSafeInteger(config.largeMediaSize) ? config.largeMediaSize : 50,
      subscriptions: portableSubscriptions(config.subscriptions) },
    unsupported: retainedData(unsupported, []),
  };
  validateConfig({ ...data.config, subscriptions: restoredSubscriptions(data.config.subscriptions) });
  return safeData(data);
}

function lines(value, name, max = 10000) {
  if (typeof value === 'string') return array(boundedText(value, name).split(/\r?\n/), name, max);
  return array(value, name, max).map(line => boundedText(line, name));
}

async function migrateUBlock(data, catalog) {
  if (typeof data.version !== 'string' || !/^\d[\w.+-]{0,63}$/.test(data.version) ||
      !Number.isSafeInteger(data.timeStamp) || data.timeStamp < 0) throw new Error('Formato de backup uBO inválido');
  record(data.userSettings, 'userSettings');
  const selected = array(data.selectedFilterLists, 'selectedFilterLists', 2048);
  const unsupported = {}, warnings = [];
  const config = { filters: boundedText(lines(data.userFilters, 'userFilters', 100000).join('\n'), 'userFilters'),
    sites: [], disabledLists: [], dynamicRules: [], hostnameSwitches: [], urlRules: [], largeMediaSize: 50, subscriptions: [] };
  unknownSettings(data, ['timeStamp', 'version', 'userSettings', 'selectedFilterLists', 'whitelist', 'netWhitelist',
    'dynamicFilteringString', 'hostnameSwitchesString', 'urlFilteringString', 'userFilters'], '', unsupported, warnings);
  unknownSettings(data.userSettings, ['externalLists', 'largeMediaSize'], 'userSettings', unsupported, warnings);
  if (data.userSettings.largeMediaSize !== undefined) {
    if (Number.isSafeInteger(data.userSettings.largeMediaSize) && data.userSettings.largeMediaSize >= 0 && data.userSettings.largeMediaSize <= 1048576) {
      config.largeMediaSize = data.userSettings.largeMediaSize;
    } else {
      unsupported['userSettings.largeMediaSize'] = data.userSettings.largeMediaSize;
      warning(warnings, 'unsupported-setting', 'userSettings.largeMediaSize', 'Limite de mídia inválido preservado sem aplicação.');
    }
  }

  const external = new Set();
  if (data.userSettings.externalLists !== undefined) {
    for (const line of lines(data.userSettings.externalLists, 'externalLists', 64)) {
      if (!line.trim() || /^\s*[!#]/.test(line)) continue;
      external.add(validateSubscriptionURL(line));
    }
  }
  const selectedIDs = [], selectedURLs = new Set();
  for (const key of selected) {
    boundedText(key, 'selectedFilterLists', 2048);
    if (/^[a-z][a-z0-9+.-]*:/i.test(key)) {
      const url = validateSubscriptionURL(key);
      const builtIn = catalog.find(list => list.url === url);
      if (builtIn) selectedIDs.push(builtIn.id);
      else { external.add(url); selectedURLs.add(url); }
    } else if (key !== 'user-filters') selectedIDs.push(listID(key));
  }
  const mapped = mapListIDs(selectedIDs, [], catalog, 'selectedFilterLists', unsupported, warnings);
  config.disabledLists = catalog.filter(list => !mapped.includes(list.id)).map(list => list.id);
  for (const url of external) {
    const builtIn = catalog.find(list => list.url === url);
    if (builtIn) continue;
    config.subscriptions.push({ id: (await sha256(url)).slice(0, 16), url,
      title: new URL(url).hostname, enabled: selectedURLs.has(url), intervalHours: 24,
      lastUpdated: 0, lastAttempt: 0, lastGoodSha256: null, lastSources: [], error: null });
  }
  if (config.filters && !selected.includes('user-filters')) {
    unsupported.userFilters = data.userFilters;
    config.filters = '';
    warning(warnings, 'disabled-custom-filters', 'userFilters', 'Filtros pessoais desativados no backup uBO; preservados sem ativação.');
  }

  const whitelist = lines(data.whitelist ?? data.netWhitelist ?? [], 'whitelist', BACKUP_LIMITS.sites);
  if (whitelist.some(line => line.trim() && !line.trim().startsWith('#'))) {
    unsupported.whitelist = data.whitelist ?? data.netWhitelist;
    for (const line of whitelist) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      try {
        if (line.endsWith('-scheme')) throw new Error('Diretiva de esquema');
        config.sites.push(hostname(line));
        warning(warnings, 'exception-scope', 'whitelist', 'Exceção importada apenas para o hostname exato; subdomínios do uBO não são abrangidos.');
      } catch {
        warning(warnings, 'unsupported-exception', 'whitelist', 'Diretiva de exceção uBO preservada, mas não aplicada (caminho, esquema ou padrão).');
      }
    }
  }
  const rejected = [];
  for (const line of lines(data.dynamicFilteringString ?? '', 'dynamicFilteringString', BACKUP_LIMITS.rules)) {
    if (!line.trim()) continue;
    const rule = parseDynamicRule(line);
    try {
      if (!rule) throw new Error('Regra não suportada');
      if (rule.src !== '*') hostname(rule.src);
      if (rule.des !== '*') hostname(rule.des);
      config.dynamicRules.push(`${rule.src} ${rule.des} ${rule.type} ${rule.action}`);
    } catch { rejected.push(line); }
  }
  if (rejected.length) {
    unsupported.dynamicFilteringString = rejected;
    warning(warnings, 'unsupported-dynamic-rule', 'dynamicFilteringString', 'Regras dinâmicas não suportadas foram preservadas sem aplicação.');
  }
  const rejectedSwitches = [];
  for (const line of lines(data.hostnameSwitchesString ?? '', 'hostnameSwitchesString', BACKUP_LIMITS.rules)) {
    if (!line.trim() || /^\s*[!#]/.test(line)) continue;
    const rule = parseHostnameSwitchRule(line);
    try {
      if (!rule) throw new Error('Chave de site não suportada');
      if (rule.hostname !== '*') hostname(rule.hostname);
      config.hostnameSwitches.push(rule.line);
    } catch { rejectedSwitches.push(line); }
  }
  if (rejectedSwitches.length) {
    unsupported.hostnameSwitchesString = rejectedSwitches;
    warning(warnings, 'unsupported-hostname-switch', 'hostnameSwitchesString', 'Chaves de site não suportadas foram preservadas sem aplicação.');
  }
  const rejectedUrls = [];
  for (const line of lines(data.urlFilteringString ?? '', 'urlFilteringString', BACKUP_LIMITS.rules)) {
    if (!line.trim() || /^\s*[!#]/.test(line)) continue;
    const rule = parseURLFilteringRule(line);
    try {
      if (!rule) throw new Error('Regra de URL não suportada');
      if (rule.src !== '*') hostname(rule.src);
      const parsed = new URL(rule.url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error('URL inválida');
      config.urlRules.push(rule.line);
    } catch { rejectedUrls.push(line); }
  }
  if (rejectedUrls.length) {
    unsupported.urlFilteringString = rejectedUrls;
    warning(warnings, 'unsupported-url-rule', 'urlFilteringString', 'Regras dinâmicas de URL não suportadas foram preservadas sem aplicação.');
  }
  validateConfig(config);
  return result('ublock', config, warnings, unsupported, catalog);
}

export async function parseBackup(input, { manifest } = {}) {
  if (typeof input === 'string' && (input.length > BACKUP_LIMITS.bytes || encoder.encode(input).length > BACKUP_LIMITS.bytes)) throw new Error('Limite de tamanho do backup');
  const data = safeData(typeof input === 'string' ? JSON.parse(input) : input);
  record(data, 'backup');
  const catalog = catalogOf(manifest);
  if (!Object.hasOwn(data, 'format')) return migrateUBlock(data, catalog);
  if (data.format !== FORMAT || data.version !== BACKUP_VERSION) throw new Error('Formato ou versão de backup não suportado');
  if (!Number.isSafeInteger(data.createdAt) || data.createdAt < 0) throw new Error('Data do backup inválida');
  catalogOf({ lists: data.catalog });
  const warnings = [], unsupported = record(data.unsupported || {}, 'unsupported');
  for (const path of Object.keys(unsupported)) warning(warnings, 'unsupported-setting', path, 'Configuração preservada, mas não aplicada pelo Argon.');
  unknownSettings(data, ['format', 'version', 'createdAt', 'catalog', 'config', 'unsupported'], '', unsupported, warnings);
  record(data.config, 'config');
  unknownSettings(data.config, configKeys, 'config', unsupported, warnings);
  const config = Object.fromEntries(configKeys.map(key => [key, data.config[key]]));
  config.hostnameSwitches = config.hostnameSwitches ?? [];
  config.urlRules = config.urlRules ?? [];
  config.largeMediaSize = config.largeMediaSize ?? 50;
  subscriptionExtensions(data.config.subscriptions || [], unsupported, warnings);
  config.subscriptions = restoredSubscriptions(data.config.subscriptions);
  validateConfig(config);
  config.disabledLists = mapListIDs(config.disabledLists, data.catalog, catalog, 'config.disabledLists', unsupported, warnings);
  return result('argon', config, warnings, unsupported, catalog);
}
