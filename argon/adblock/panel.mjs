// SPDX-License-Identifier: MPL-2.0
import { t, resolveLocale } from '../i18n.mjs';
import { createBackup, parseBackup } from './backup.mjs';
import { startElementTool } from './picker.mjs';
import { RequestLogger } from './logger.mjs';
import { createNativeTools } from './tools.sys.mjs';

const EN_FALLBACKS = {
  'adblock.hero.protected': 'Protected on this site',
  'adblock.hero.paused': 'Protection paused on this site',
  'adblock.hero.shieldsUp': 'Shields Up',
  'adblock.hero.shieldsDown': 'Shields Down',
  'adblock.hero.status': 'Protection status',
  'adblock.stats.blockedPage': 'Blocked on this page',
  'adblock.stats.trackersAds': 'Trackers & ads',
  'adblock.stats.zeroThreats': 'No threats blocked yet',
  'adblock.stats.itemsBlocked': '{count} items blocked',
  'adblock.action.picker': 'Block element',
  'adblock.action.zapper': 'Zap element (temporary)',
  'adblock.action.firewall': 'Dynamic filtering',
  'adblock.action.logger': 'Live Logger',
  'adblock.action.ghostprint': 'Fingerprint protection',
  'adblock.action.reload': 'Reload this tab',
  'adblock.switches.title': 'Per-site switches',
  'adblock.switches.noPopups': 'Block popups',
  'adblock.switches.noLargeMedia': 'Block large media (>50 KB)',
  'adblock.switches.noCosmetic': 'Disable cosmetic filtering',
  'adblock.switches.noRemoteFonts': 'Block remote fonts',
  'adblock.switches.noScripting': 'Disable JavaScript',
  'adblock.switches.noCspReports': 'Block CSP reports',
  'adblock.firewall.matrixTitle': 'Quick firewall cells (current site)',
  'adblock.firewall.inherit': 'Inherit',
  'adblock.firewall.allow': 'Allow',
  'adblock.firewall.noop': 'Noop',
  'adblock.firewall.block': 'Block',
  'adblock.firewall.rulesLabel': 'Dynamic hostname rules (src dst type action)',
  'adblock.firewall.urlRulesLabel': 'Dynamic URL rules (src url-prefix type action)',
  'adblock.firewall.applyTemp': 'Apply temporary',
  'adblock.firewall.revertTemp': 'Revert',
  'adblock.firewall.savePerm': 'Save permanent',
  'adblock.logger.filterAll': 'All requests',
  'adblock.logger.filterBlocked': 'Blocked',
  'adblock.logger.filterAllowed': 'Allowed',
  'adblock.logger.filterModified': 'Redirected / Rewritten',
  'adblock.logger.searchPlaceholder': 'Filter domain, path, or rule…',
  'adblock.logger.clear': 'Clear tab log',
  'adblock.ghostprint.modeLabel': 'Protection mode',
  'adblock.ghostprint.modeBalanced': 'Balanced (Banking & corporate safe)',
  'adblock.ghostprint.modeStrict': 'Strict (Per-navigation isolation)',
  'adblock.ghostprint.modeOff': 'Off',
  'adblock.category.ads': 'Advertising',
  'adblock.category.privacy': 'Privacy',
  'adblock.category.annoyances': 'Annoyances',
  'adblock.category.security': 'Security',
  'adblock.category.custom': 'Custom Lists',
  'adblock.category.enabledCount': '{enabled} of {total} enabled',
  'adblock.tabs.home': 'Home',
  'adblock.tabs.lists': 'Filter Lists',
  'adblock.tabs.settings': 'Settings',
  'adblock.backup.title': 'Backup & Restore',
  'adblock.backup.export': 'Export Backup',
  'adblock.backup.import': 'Import Backup',
  'adblock.backup.success': 'Configuration saved successfully.',
  'adblock.backup.importError': 'Failed to import backup.',
  'adblock.subscriptions.add': 'Add filter list from URL',
  'adblock.subscriptions.placeholder': 'https://example.com/filter-list.txt',
  'adblock.subscriptions.button': 'Add',
  'adblock.subscriptions.remove': 'Remove',
  'adblock.subscriptions.invalidUrl': 'Invalid HTTPS URL',
  'adblock.subscriptions.success': 'List added successfully',
};

const PT_FALLBACKS = {
  'adblock.hero.protected': 'Protegido neste site',
  'adblock.hero.paused': 'Proteção pausada neste site',
  'adblock.hero.shieldsUp': 'Escudos Ativos',
  'adblock.hero.shieldsDown': 'Escudos Pausados',
  'adblock.hero.status': 'Status da proteção',
  'adblock.stats.blockedPage': 'Bloqueados nesta página',
  'adblock.stats.trackersAds': 'Rastreadores e anúncios',
  'adblock.stats.zeroThreats': 'Nenhuma ameaça bloqueada',
  'adblock.stats.itemsBlocked': '{count} itens bloqueados',
  'adblock.action.picker': 'Bloquear elemento',
  'adblock.action.zapper': 'Ocultar elemento (temporário)',
  'adblock.action.firewall': 'Filtragem dinâmica',
  'adblock.action.logger': 'Registro de rede',
  'adblock.action.ghostprint': 'Proteção contra impressão digital',
  'adblock.action.reload': 'Recarregar esta aba',
  'adblock.switches.title': 'Chaves por site',
  'adblock.switches.noPopups': 'Bloquear pop-ups',
  'adblock.switches.noLargeMedia': 'Bloquear mídia grande (>50 KB)',
  'adblock.switches.noCosmetic': 'Desativar filtros cosméticos',
  'adblock.switches.noRemoteFonts': 'Bloquear fontes remotas',
  'adblock.switches.noScripting': 'Desativar JavaScript',
  'adblock.switches.noCspReports': 'Bloquear relatórios CSP',
  'adblock.firewall.matrixTitle': 'Células rápidas do firewall (site atual)',
  'adblock.firewall.inherit': 'Herdar',
  'adblock.firewall.allow': 'Permitir',
  'adblock.firewall.noop': 'Noop',
  'adblock.firewall.block': 'Bloquear',
  'adblock.firewall.rulesLabel': 'Regras dinâmicas de host (origem destino tipo ação)',
  'adblock.firewall.urlRulesLabel': 'Regras dinâmicas de URL (origem prefixo-url tipo ação)',
  'adblock.firewall.applyTemp': 'Aplicar temporário',
  'adblock.firewall.revertTemp': 'Reverter',
  'adblock.firewall.savePerm': 'Salvar permanente',
  'adblock.logger.filterAll': 'Todas as requisições',
  'adblock.logger.filterBlocked': 'Bloqueadas',
  'adblock.logger.filterAllowed': 'Permitidas',
  'adblock.logger.filterModified': 'Redirecionadas / Reescritas',
  'adblock.logger.searchPlaceholder': 'Filtrar domínio, caminho ou regra…',
  'adblock.logger.clear': 'Limpar registro',
  'adblock.ghostprint.modeLabel': 'Modo de proteção',
  'adblock.ghostprint.modeBalanced': 'Equilibrado (Compatível com bancos/apps)',
  'adblock.ghostprint.modeStrict': 'Estrito (Isolamento por navegação)',
  'adblock.ghostprint.modeOff': 'Desativado',
  'adblock.category.ads': 'Publicidade',
  'adblock.category.privacy': 'Privacidade',
  'adblock.category.annoyances': 'Incômodos',
  'adblock.category.security': 'Segurança',
  'adblock.category.custom': 'Listas Personalizadas',
  'adblock.category.enabledCount': '{enabled} de {total} ativas',
  'adblock.tabs.home': 'Início',
  'adblock.tabs.lists': 'Listas de Filtros',
  'adblock.tabs.settings': 'Configurações',
  'adblock.backup.title': 'Backup e Restauração',
  'adblock.backup.export': 'Exportar Backup',
  'adblock.backup.import': 'Importar Backup',
  'adblock.backup.success': 'Configuração salva com sucesso.',
  'adblock.backup.importError': 'Falha ao importar backup.',
  'adblock.subscriptions.add': 'Adicionar lista via URL',
  'adblock.subscriptions.placeholder': 'https://example.com/filter-list.txt',
  'adblock.subscriptions.button': 'Adicionar',
  'adblock.subscriptions.remove': 'Remover',
  'adblock.subscriptions.invalidUrl': 'URL HTTPS inválida',
  'adblock.subscriptions.success': 'Lista adicionada com sucesso',
};

const SITE_SWITCH_DEFS = [
  ['no-popups', 'adblock.switches.noPopups'],
  ['no-large-media', 'adblock.switches.noLargeMedia'],
  ['no-cosmetic-filtering', 'adblock.switches.noCosmetic'],
  ['no-remote-fonts', 'adblock.switches.noRemoteFonts'],
  ['no-scripting', 'adblock.switches.noScripting'],
  ['no-csp-reports', 'adblock.switches.noCspReports'],
];

const FIREWALL_CELL_TYPES = ['*', '3p', '3p-script', '3p-frame', '1p-script', 'image'];

export function formatProtectionError(error, locale = null) {
  const fallback = t('adblock.error.fallback', null, locale);
  try {
    const text = (typeof error?.message === 'string' ? error.message : String(error ?? '')).trim();
    if (!text || /^(null|undefined|\[object Object\])$/i.test(text)) return fallback;
    if (text.includes('Filters changed in another window') || text.includes('Filtros alterados em outra janela')) {
      return t('adblock.error.filtersChanged', null, locale);
    }
    if (text.includes('Invalid filters') || text.includes('Filtros inválidos')) {
      return t('adblock.error.invalidFilters', null, locale);
    }
    return text;
  } catch { return fallback; }
}

export function installAdblockPanel(win) {
  const doc = win.document;
  if (doc.getElementById('argon-adblock-button')) return;

  const locale = resolveLocale(null, win);
  const isPt = String(locale || '').startsWith('pt');
  const fallbacks = isPt ? PT_FALLBACKS : EN_FALLBACKS;
  const _t = (key, params = null) => {
    let text;
    try { text = t(key, params, locale, win); } catch {}
    if (!text || text === key) {
      text = fallbacks[key] || EN_FALLBACKS[key] || key;
      if (params && typeof text === 'string') {
        for (const [k, v] of Object.entries(params)) {
          text = text.replaceAll('{' + k + '}', String(v));
        }
      }
    }
    return text;
  };

  const { ArgonAdblock: service } = win.ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
  if (!service.logger) {
    service.logger = new RequestLogger();
  }

  const isPrivate = win.PrivateBrowsingUtils.isWindowPrivate(win);
  const readPageIdentity = () => {
    const browser = win.gBrowser?.selectedBrowser;
    if (typeof service.pageIdentityFor === 'function') {
      return service.pageIdentityFor(browser, isPrivate);
    }
    const spec = browser?.currentURI?.spec || '';
    return {
      topBrowsingContextId: browser?.browserId || browser?.browsingContext?.id || 1,
      navigationId: browser?.browsingContext?.top?.currentWindowGlobal?.innerWindowId ?? 1,
      private: isPrivate,
      hostname: service.siteKey(spec),
      url: spec,
    };
  };

  let nativeTools = null, toolsFirewall = null;
  const ensureNativeTools = () => {
    if (!doc.nodePrincipal?.isSystemPrincipal || !service.engine?.firewall || !service.logger) return null;
    if (nativeTools && toolsFirewall === service.engine.firewall) return nativeTools;
    toolsFirewall = service.engine.firewall;
    nativeTools = createNativeTools({
      document: doc,
      firewall: service.engine.firewall,
      logger: service.logger,
      persistPermanent: (rules, { expected }) => service.saveDynamicRules(rules, { expected }),
      readSelectedPage: readPageIdentity,
      runElementTool: async mode => {
        const browser = win.gBrowser?.selectedBrowser;
        const actor = browser?.browsingContext?.currentWindowGlobal?.getActor('ArgonAdblock');
        if (!actor) return null;
        return actor.sendQuery('pickElement', { mode });
      },
      saveCosmeticRule: rule => service.addCosmeticRule(rule, false),
      savePrivateCosmeticRule: rule => service.addCosmeticRule(rule, true),
    });
    return nativeTools;
  };

  const button = doc.createXULElement('toolbarbutton');
  button.id = 'argon-adblock-button';
  button.classList.add('toolbarbutton-1');
  for (const attr of ['label', 'tooltiptext', 'aria-label']) button.setAttribute(attr, _t('adblock.button.label'));
  button.setAttribute('image', 'chrome://browser/skin/tracking-protection.svg');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');

  const panel = doc.createXULElement('panel');
  panel.id = 'argon-adblock-panel';
  panel.setAttribute('type', 'arrow');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', _t('adblock.panel.ariaLabel'));

  const body = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  body.className = 'argon-adblock-body';
  panel.append(body);

  const html = (tag, text, id, parent = body) => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
    if (text) node.textContent = text;
    if (id) node.id = 'argon-adblock-' + id;
    parent.append(node);
    return node;
  };

  const icon = (parent, path, id = null) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (id) svg.id = id;
    const shape = doc.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    parent.append(svg);
    return svg;
  };

  const shieldPath = 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z M8 12l3 3 5-6';

  // Site identity and native Gecko checkbox controls.
  const header = html('header', '', 'header');
  const shield = doc.createXULElement('image');
  shield.id = 'argon-adblock-hero-shield';
  shield.setAttribute('src', 'chrome://browser/skin/tracking-protection.svg');
  shield.setAttribute('aria-hidden', 'true');
  header.append(shield);
  const identity = html('div', '', 'identity', header);
  const domain = html('h2', _t('adblock.site.thisTab'), 'domain', identity);
  const siteStatus = html('p', _t('adblock.site.loading'), 'site-status', identity);
  const site = html('input', '', 'site', header);
  site.type = 'checkbox';
  site.className = 'argon-adblock-switch';
  site.setAttribute('role', 'switch');
  site.setAttribute('aria-label', _t('adblock.site.toggleAria'));
  site.setAttribute('aria-describedby', 'argon-adblock-site-status');
  site.disabled = true;

  // Protection summary.
  const summary = html('div', '', 'summary');
  const statsRow = html('div', '', null, summary);
  statsRow.className = 'argon-adblock-stats-row';
  const pageBlockedCount = html('span', '0', 'page-blocked-count', statsRow);
  pageBlockedCount.className = 'argon-adblock-stat-number';
  const pageBlockedLabel = html('span', _t('adblock.stats.zeroThreats'), 'page-blocked-label', statsRow);
  pageBlockedLabel.className = 'argon-adblock-stat-label';

  const summaryMeta = html('div', '', null, summary);
  summaryMeta.className = 'argon-adblock-stats-meta';
  const summaryTitle = html('strong', _t('adblock.summary.title'), 'summary-title', summaryMeta);
  const summaryDetail = html('p', _t('adblock.summary.loadingLists'), 'summary-detail', summaryMeta);

  // 3. MIDDLE SCROLLABLE VIEWS
  const middle = html('div', '', 'middle');
  middle.tabIndex = -1;

  // Home View
  const home = html('section', '', 'home', middle);

  // Advanced collapsible details
  const advanced = html('details', '', 'advanced', home);
  advanced.open = true;
  const advancedToggle = html('summary', '', 'advanced-toggle', advanced);
  icon(advancedToggle, 'M4 7h16M4 17h16M8 4v6M16 14v6');
  html('span', _t('adblock.options.advanced'), null, advancedToggle);

  // GhostPrint Protection Card (first inside advanced so status is immediately visible above fold)
  const { ArgonGhostPrint: ghost, SURFACES } = win.ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs');
  const ghostSection = html('section', '', 'ghost', advanced);
  ghostSection.className = 'argon-adblock-ghost-card';
  const ghostHeader = html('div', '', 'ghost-header', ghostSection);
  ghostHeader.className = 'argon-adblock-row';
  html('h3', _t('adblock.ghostprint.title'), null, ghostHeader);
  const ghostSite = html('input', '', 'ghost-site', ghostHeader);
  ghostSite.type = 'checkbox';
  ghostSite.className = 'argon-adblock-switch';
  ghostSite.setAttribute('role', 'switch');
  ghostSite.setAttribute('aria-label', _t('adblock.ghostprint.siteToggle'));
  const ghostStatus = html('p', '', 'ghost-status', ghostSection);
  ghostStatus.setAttribute('role', 'status');
  ghostSite.setAttribute('aria-describedby', ghostStatus.id);
  html('p', _t('adblock.ghostprint.description'), null, ghostSection);
  const ghostDetails = html('p', '', 'ghost-surfaces', ghostSection);

  // Quick Actions Toolbar (inside advanced)
  const quickActions = html('div', '', 'quick-actions', advanced);
  quickActions.className = 'argon-adblock-actions-grid';

  // Element Picker Button
  const pickerBtn = html('button', '', 'picker-btn', quickActions);
  pickerBtn.type = 'button';
  pickerBtn.className = 'argon-adblock-action-tile';
  pickerBtn.setAttribute('title', _t('adblock.action.picker'));
  icon(pickerBtn, 'M12 2v4M12 18v4M2 12h4M18 12h4 M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z');
  html('span', _t('adblock.action.picker'), null, pickerBtn);

  // Element Zapper Button
  const zapperBtn = html('button', '', 'zapper-btn', quickActions);
  zapperBtn.type = 'button';
  zapperBtn.className = 'argon-adblock-action-tile';
  zapperBtn.setAttribute('title', _t('adblock.action.zapper'));
  icon(zapperBtn, 'M13 2 4 14h7l-1 8 9-12h-7Z');
  html('span', _t('adblock.action.zapper'), null, zapperBtn);

  // Dynamic Filtering Button
  const firewallBtn = html('button', '', 'firewall-btn', quickActions);
  firewallBtn.type = 'button';
  firewallBtn.className = 'argon-adblock-action-tile';
  firewallBtn.setAttribute('title', _t('adblock.action.firewall'));
  icon(firewallBtn, 'M4 5h16v14H4z M4 10h16 M10 5v14');
  html('span', _t('adblock.action.firewall'), null, firewallBtn);

  // Live Logger Button
  const loggerBtn = html('button', '', 'logger-btn', quickActions);
  loggerBtn.type = 'button';
  loggerBtn.className = 'argon-adblock-action-tile';
  loggerBtn.setAttribute('title', _t('adblock.action.logger'));
  icon(loggerBtn, 'M4 6h16M4 12h16M4 18h10');
  html('span', _t('adblock.action.logger'), null, loggerBtn);

  // Reload Button
  const reload = html('button', '', 'reload', quickActions);
  reload.type = 'button';
  reload.className = 'argon-adblock-row argon-adblock-action-tile';
  reload.setAttribute('title', _t('adblock.reload.button'));
  icon(reload, 'M20 7v5h-5M20 12a8 8 0 1 0-2 6');
  html('span', _t('adblock.reload.button'), null, reload);
  reload.addEventListener('click', () => { panel.hidePopup(); win.gBrowser.selectedBrowser.reload(); });

  // Per-Site Switches (uBlock Origin hnswitches)
  const siteSwitchesCard = html('section', '', 'site-switches', advanced);
  siteSwitchesCard.className = 'argon-adblock-settings-card';
  html('h3', _t('adblock.switches.title'), null, siteSwitchesCard);
  const siteSwitchInputs = new Map();
  for (const [switchName, labelKey] of SITE_SWITCH_DEFS) {
    const label = html('label', '', null, siteSwitchesCard);
    label.className = 'argon-adblock-list-item';
    html('span', _t(labelKey), null, label);
    const input = html('input', '', 'switch-' + switchName, label);
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.dataset.switchName = switchName;
    siteSwitchInputs.set(switchName, input);
  }

  const siteScope = html('p', '', 'site-scope', advanced);

  const manageExtension = html('button', _t('adblock.settings.extensionSettings'), 'extension', home);
  manageExtension.className = 'argon-adblock-row';
  manageExtension.hidden = true;
  manageExtension.addEventListener('click', () => {
    panel.hidePopup();
    service.authority?.openExtensionSettings?.(win);
  });

  // Views Map
  const views = { home };

  for (const [name, title] of [
    ['lists-view', _t('adblock.lists.title')],
    ['settings-view', _t('adblock.settings.title')],
    ['firewall-view', _t('adblock.action.firewall')],
    ['logger-view', _t('adblock.action.logger')],
  ]) {
    const view = html('section', '', name, middle);
    view.hidden = true;
    const back = html('button', '', name + '-back', view);
    back.className = 'argon-adblock-row argon-adblock-back';
    icon(back, 'M15 18l-6-6 6-6');
    html('span', title, null, back);
    back.setAttribute('aria-label', _t('adblock.lists.back'));
    back.addEventListener('click', () => showView('home'));
    views[name] = view;
  }

  const showView = name => {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    middle.scrollTop = 0;
    if (name === 'home') (site.disabled ? advancedToggle : site).focus();
    else views[name].querySelector('button').focus();
    listsButton.setAttribute('aria-expanded', String(name === 'lists-view'));
    settingsButton.setAttribute('aria-expanded', String(name === 'settings-view'));
  };

  // Filter Lists View
  const listsView = views['lists-view'];
  html('p', _t('adblock.lists.description'), null, listsView);
  const listBox = html('div', '', 'lists', listsView);

  // Subscriptions Section
  const subSection = html('div', '', 'subscriptions-section', listsView);
  subSection.className = 'argon-adblock-category-group argon-adblock-subscriptions-section';
  const subHeader = html('div', '', 'subscriptions-header', subSection);
  subHeader.className = 'argon-adblock-category-header';
  html('strong', _t('adblock.subscriptions.add'), null, subHeader);

  const subForm = html('div', '', 'subscription-form', subSection);
  subForm.className = 'argon-adblock-subscription-form';

  const subInput = html('input', '', 'subscription-url', subForm);
  subInput.type = 'url';
  subInput.placeholder = _t('adblock.subscriptions.placeholder') || 'https://example.com/filter-list.txt';
  subInput.setAttribute('aria-label', _t('adblock.subscriptions.add'));

  const subAddBtn = html('button', _t('adblock.subscriptions.button'), 'subscription-add', subForm);
  subAddBtn.type = 'button';
  subAddBtn.className = 'argon-adblock-subscription-add-btn';

  const subFeedback = html('div', '', 'subscription-feedback', subSection);
  const subStatus = html('p', '', 'subscription-status', subFeedback);
  subStatus.setAttribute('role', 'status');
  const subError = html('p', '', 'subscription-error', subFeedback);
  subError.setAttribute('role', 'alert');

  const subListContainer = html('div', '', 'subscriptions-list', subSection);
  subListContainer.className = 'argon-adblock-subscriptions-list';

  // Settings View
  const settings = views['settings-view'];
  const globalCard = html('div', '', null, settings);
  globalCard.className = 'argon-adblock-settings-card';
  const globalRow = html('div', '', null, globalCard);
  globalRow.className = 'argon-adblock-row';
  icon(globalRow, shieldPath);
  html('span', _t('adblock.settings.globalAdblock'), 'global-label', globalRow);
  const global = html('input', '', 'global', globalRow);
  global.type = 'checkbox';
  global.className = 'argon-adblock-switch';
  global.setAttribute('role', 'switch');
  global.setAttribute('aria-labelledby', 'argon-adblock-global-label');

  const ghostCard = html('div', '', null, settings);
  ghostCard.className = 'argon-adblock-settings-card';
  html('h3', _t('adblock.settings.globalGhostprint'), null, ghostCard);
  const ghostGlobalLabel = html('label', _t('adblock.settings.globalGhostprintLabel'), null, ghostCard);
  const ghostGlobal = html('input', '', 'ghost-global', ghostGlobalLabel);
  ghostGlobal.type = 'checkbox';
  const ghostModeRow = html('label', _t('adblock.ghostprint.modeLabel'), null, ghostCard);
  ghostModeRow.className = 'argon-adblock-list-item';
  const ghostModeSelect = html('select', '', 'ghost-mode', ghostModeRow);
  for (const [val, label] of [
    ['balanced', _t('adblock.ghostprint.modeBalanced')],
    ['strict', _t('adblock.ghostprint.modeStrict')],
    ['off', _t('adblock.ghostprint.modeOff')],
  ]) {
    const opt = html('option', label, null, ghostModeSelect);
    opt.value = val;
  }
  ghostModeSelect.addEventListener('change', () => {
    const mode = ghostModeSelect.value;
    if (typeof ghost.setMode === 'function') ghost.setMode(mode);
    else win.Services.prefs.setStringPref('argon.ghostprint.mode', mode);
    status.textContent = _t('adblock.status.savedGhostprint');
    refresh();
  });
  const ghostInputs = new Map();
  const surfaceLabels = {
    canvas: _t('adblock.surfaces.canvas'),
    webgl: _t('adblock.surfaces.webgl'),
    webgpu: _t('adblock.surfaces.webgpu'),
    audio: _t('adblock.surfaces.audio'),
    hardware: _t('adblock.surfaces.hardware'),
    battery: _t('adblock.surfaces.battery'),
    fonts: _t('adblock.surfaces.fonts'),
    screen: _t('adblock.surfaces.screen'),
    speech: _t('adblock.surfaces.speech'),
  };
  for (const name of SURFACES) {
    const row = html('label', surfaceLabels[name] || name, null, ghostCard);
    const input = html('input', '', 'ghost-' + name, row);
    input.type = 'checkbox';
    input.addEventListener('change', () => { win.Services.prefs.setBoolPref('argon.ghostprint.' + name, input.checked); status.textContent = _t('adblock.status.savedGhostprint'); refresh(); });
    ghostInputs.set(name, input);
  }
  ghostGlobal.addEventListener('change', () => { win.Services.prefs.setBoolPref('argon.ghostprint.enabled', ghostGlobal.checked); status.textContent = _t('adblock.status.savedGhostprint'); refresh(); });

  const filtersCard = html('div', '', null, settings);
  filtersCard.className = 'argon-adblock-settings-card';
  const editorLabel = html('label', _t('adblock.settings.myFilters'), null, filtersCard);
  editorLabel.setAttribute('for', 'argon-adblock-filters');
  const editor = html('textarea', '', 'filters', filtersCard);
  editor.rows = 8;
  editor.spellcheck = false;
  editor.setAttribute('aria-describedby', 'argon-adblock-filter-help');
  html('p', _t('adblock.settings.filterHelp'), 'filter-help', filtersCard);
  const save = html('button', _t('adblock.settings.save'), 'save', filtersCard);

  // Backup / Restore Card
  const backupCard = html('div', '', 'backup-section', settings);
  backupCard.className = 'argon-adblock-settings-card';
  html('h3', _t('adblock.backup.title'), null, backupCard);
  const backupRow = html('div', '', null, backupCard);
  backupRow.className = 'argon-adblock-backup-row';
  const backupBtn = html('button', _t('adblock.backup.export'), 'backup-btn', backupRow);
  backupBtn.type = 'button';
  const restoreBtn = html('button', _t('adblock.backup.import'), 'restore-btn', backupRow);
  restoreBtn.type = 'button';
  const restoreFile = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
  restoreFile.type = 'file';
  restoreFile.id = 'argon-adblock-restore-file';
  restoreFile.accept = '.json,application/json';
  restoreFile.style.display = 'none';
  backupCard.append(restoreFile);

  // Dynamic Filtering & URL Rules View
  const firewallView = views['firewall-view'];
  const matrixCard = html('div', '', 'firewall-matrix-card', firewallView);
  matrixCard.className = 'argon-adblock-settings-card';
  html('h3', _t('adblock.firewall.matrixTitle'), null, matrixCard);
  const firewallMatrix = html('div', '', 'firewall-matrix', matrixCard);

  const dynEditorCard = html('div', '', 'firewall-editor-card', firewallView);
  dynEditorCard.className = 'argon-adblock-settings-card';
  const dynLabel = html('label', _t('adblock.firewall.rulesLabel'), null, dynEditorCard);
  dynLabel.setAttribute('for', 'argon-adblock-dynamic-rules');
  const dynEditor = html('textarea', '', 'dynamic-rules', dynEditorCard);
  dynEditor.rows = 5;
  dynEditor.spellcheck = false;

  const urlRulesLabel = html('label', _t('adblock.firewall.urlRulesLabel'), null, dynEditorCard);
  urlRulesLabel.setAttribute('for', 'argon-adblock-url-rules');
  const urlRulesEditor = html('textarea', '', 'url-rules', dynEditorCard);
  urlRulesEditor.rows = 4;
  urlRulesEditor.spellcheck = false;

  const firewallButtons = html('div', '', 'firewall-actions', dynEditorCard);
  firewallButtons.className = 'argon-adblock-backup-row';
  const fwApplyBtn = html('button', _t('adblock.firewall.applyTemp'), 'firewall-apply', firewallButtons);
  fwApplyBtn.type = 'button';
  const fwRevertBtn = html('button', _t('adblock.firewall.revertTemp'), 'firewall-revert', firewallButtons);
  fwRevertBtn.type = 'button';
  const fwCommitBtn = html('button', _t('adblock.firewall.savePerm'), 'firewall-commit', firewallButtons);
  fwCommitBtn.type = 'button';

  // Logger View
  const loggerView = views['logger-view'];
  const loggerToolbar = html('div', '', 'logger-toolbar', loggerView);
  loggerToolbar.className = 'argon-adblock-logger-toolbar';
  const loggerFilter = html('select', '', 'logger-filter', loggerToolbar);
  for (const [val, label] of [
    ['all', _t('adblock.logger.filterAll')],
    ['blocked', _t('adblock.logger.filterBlocked')],
    ['allowed', _t('adblock.logger.filterAllowed')],
    ['modified', _t('adblock.logger.filterModified')],
  ]) {
    const opt = html('option', label, null, loggerFilter);
    opt.value = val;
  }
  const loggerSearch = html('input', '', 'logger-search', loggerToolbar);
  loggerSearch.type = 'search';
  loggerSearch.placeholder = _t('adblock.logger.searchPlaceholder');
  loggerSearch.setAttribute('aria-label', _t('adblock.logger.searchPlaceholder'));
  const loggerClearBtn = html('button', _t('adblock.logger.clear'), 'logger-clear', loggerToolbar);
  loggerClearBtn.type = 'button';
  const loggerSummary = html('p', '', 'logger-summary', loggerView);
  const loggerList = html('div', '', 'logger-list', loggerView);

  // Feedback (Status & Error)
  const feedback = html('div', '', 'feedback');
  const status = html('p', '', 'status', feedback);
  status.setAttribute('role', 'status');
  const error = html('p', '', 'error', feedback);
  error.setAttribute('role', 'alert');

  // Footer Navigation
  const footer = html('footer', '', 'footer');
  const listsButton = html('button', _t('adblock.lists.button'), 'lists-toggle', footer);
  listsButton.addEventListener('click', () => showView('lists-view'));
  const settingsButton = html('button', _t('adblock.settings.button'), 'settings', footer);
  settingsButton.addEventListener('click', () => showView('settings-view'));

  listsButton.setAttribute('aria-controls', views['lists-view'].id);
  settingsButton.setAttribute('aria-controls', views['settings-view'].id);

  // Scope & Close
  const scope = html('p', _t('adblock.settings.singleAuthority'), 'scope');
  const close = html('button', _t('adblock.settings.close'), 'close', scope);
  close.addEventListener('click', () => panel.hidePopup());

  body.append(header, summary, middle, feedback, footer, scope);

  let baseline = '', siteURL = '', busy = false;

  const refresh = () => {
    const key = service.siteKey(siteURL);
    const localEnabled = service.siteEnabled(siteURL, isPrivate);
    const enabled = service.enabled();
    const native = service.authority?.native === true;
    manageExtension.hidden = native;
    save.disabled = global.disabled = !native || busy;
    backupBtn.disabled = restoreBtn.disabled = !native || busy;
    fwApplyBtn.disabled = fwRevertBtn.disabled = !native || busy;
    fwCommitBtn.disabled = !native || busy || isPrivate;
    for (const input of listBox.querySelectorAll('input')) input.disabled = !native || busy;
    subAddBtn.disabled = subInput.disabled = !native || busy;
    for (const btn of subListContainer.querySelectorAll('button')) btn.disabled = !native || busy;
    domain.textContent = key || _t('adblock.site.thisTab');
    domain.title = key || '';
    site.disabled = !native || !key || busy;
    site.checked = localEnabled;
    site.setAttribute('aria-checked', String(site.checked));
    for (const [switchName, input] of siteSwitchInputs) {
      input.disabled = !native || !key || busy || !localEnabled || !enabled;
      const active = typeof service.getSiteSwitch === 'function'
        ? service.getSiteSwitch(switchName, siteURL, isPrivate)
        : false;
      input.checked = active;
      input.setAttribute('aria-checked', String(active));
    }
    header.setAttribute('data-protection', (!native || !key || !enabled || !localEnabled) ? 'paused' : 'active');
    siteStatus.textContent = !native ? _t('adblock.site.ublockActive') : !key ? _t('adblock.site.noHttp') : !enabled ? _t('adblock.site.disabledGlobal') : localEnabled ? _t('adblock.site.active') : _t('adblock.site.paused');
    siteScope.textContent = isPrivate ? _t('adblock.site.scopePrivate') : _t('adblock.site.scopeDomain');
    global.checked = enabled;
    global.setAttribute('aria-checked', String(global.checked));
    ghostSite.disabled = !ghost.origin(siteURL);
    ghostSite.checked = ghost.siteEnabled(siteURL, isPrivate);
    ghostSite.setAttribute('aria-checked', String(ghostSite.checked));
    ghostGlobal.checked = ghost.enabled();
    const currentGhostMode = typeof ghost.mode === 'function'
      ? ghost.mode()
      : win.Services.prefs.getStringPref('argon.ghostprint.mode', 'balanced');
    ghostModeSelect.value = currentGhostMode;
    for (const [name, input] of ghostInputs) input.checked = win.Services.prefs.getBoolPref('argon.ghostprint.' + name, true);
    summaryTitle.textContent = !native ? _t('adblock.summary.ublockAuthority') : enabled ? _t('adblock.summary.active') : _t('adblock.summary.disabled');
    const count = service.manifest.lists.filter(list => !service.config.disabledLists.includes(list.id)).length;
    summaryDetail.textContent = _t('adblock.summary.listsSelected', { count, total: service.manifest.lists.length });

    // Live block stats & zero-IPC toolbar badge
    const pageId = readPageIdentity();
    const counters = service.logger ? service.logger.countersFor(pageId) : null;
    const blockedCount = (counters?.blocked || 0) + (counters?.redirected || 0);
    button.setAttribute('badged', 'true');
    if (native && enabled && localEnabled) {
      pageBlockedCount.textContent = String(blockedCount);
      pageBlockedLabel.textContent = blockedCount === 0 ? _t('adblock.stats.zeroThreats') : _t('adblock.stats.blockedPage');
      button.setAttribute('badge', blockedCount > 0 ? (blockedCount > 99 ? '99+' : String(blockedCount)) : '');
    } else if (!native) {
      pageBlockedCount.textContent = '—';
      pageBlockedLabel.textContent = _t('adblock.summary.ublockAuthority');
      button.setAttribute('badge', '');
    } else {
      pageBlockedCount.textContent = '0';
      pageBlockedLabel.textContent = _t('adblock.hero.paused');
      button.setAttribute('badge', '');
    }
  };

  const run = async task => {
    if (busy) return;
    busy = true;
    error.textContent = ''; status.textContent = '';
    const controls = [
      site, global, save, backupBtn, restoreBtn, subAddBtn, subInput,
      fwApplyBtn, fwRevertBtn, fwCommitBtn,
      ...siteSwitchInputs.values(),
      ...listBox.querySelectorAll('input'),
      ...subListContainer.querySelectorAll('button'),
    ];
    controls.forEach(control => { if (control) control.disabled = true; });
    try { await task(); status.textContent = _t('adblock.status.savedFilters'); }
    catch (e) { error.textContent = formatProtectionError(e, locale); }
    finally {
      busy = false;
      controls.forEach(control => { if (control) control.disabled = false; });
      for (const input of listBox.querySelectorAll('input')) input.checked = !service.config.disabledLists.includes(input.dataset.listId);
      refreshSubscriptions();
      refresh();
    }
  };

  for (const [switchName, input] of siteSwitchInputs) {
    input.addEventListener('change', () => {
      if (typeof service.toggleSiteSwitch !== 'function') return;
      const desired = input.checked;
      run(() => service.toggleSiteSwitch(switchName, siteURL, desired, isPrivate));
    });
  }

  ghostSite.addEventListener('click', () => { ghost.setSite(siteURL, !ghost.siteEnabled(siteURL, isPrivate), isPrivate); status.textContent = _t('adblock.status.savedGhostprint'); refresh(); });

  const readGhostStatus = async browser => {
    ghostStatus.textContent = _t('adblock.ghostprint.checking'); ghostDetails.textContent = '';
    try {
      await ghost.ready;
      const result = await browser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status');
      if (browser !== win.gBrowser.selectedBrowser || panel.state === 'closed' || panel.state === 'hiding') return;
      const states = {
        installed: _t('adblock.ghostprint.installed'),
        disabled: _t('adblock.ghostprint.disabled'),
        'gecko-protection-conflict': _t('adblock.ghostprint.conflict'),
        unavailable: _t('adblock.ghostprint.unavailable'),
        failed: _t('adblock.ghostprint.failed'),
        'not-installed': _t('adblock.ghostprint.notInstalled'),
        'unsupported-origin': _t('adblock.ghostprint.unsupported'),
      };
      ghostStatus.textContent = states[result.state] || _t('adblock.ghostprint.unavailable');
      const labels = {
        installed: _t('adblock.surfaceState.installed'),
        unavailable: _t('adblock.surfaceState.unavailable'),
        disabled: _t('adblock.surfaceState.disabled'),
        failed: _t('adblock.surfaceState.failed'),
      };
      ghostDetails.textContent = Object.entries(result.surfaces || {}).map(([name, state]) => `${surfaceLabels[name] || name}: ${labels[state] || _t('adblock.surfaceState.unknown')}`).join(' · ');
    } catch { ghostStatus.textContent = _t('adblock.ghostprint.unavailableHttp'); }
  };

  site.addEventListener('click', () => run(() => service.setSite(siteURL, !service.siteEnabled(siteURL, isPrivate), isPrivate)));
  global.addEventListener('click', () => { win.Services.prefs.setBoolPref('argon.adblock.enabled', !service.enabled()); refresh(); });
  save.addEventListener('click', () => {
    const value = editor.value, expected = baseline;
    run(async () => { await service.saveFilters(value, expected); baseline = value; });
  });

  // Element Picker & Element Zapper shared launcher
  const launchElementTool = async mode => {
    panel.hidePopup();
    try {
      const tools = service.tools || ensureNativeTools();
      if (tools?.pick) {
        const res = await tools.pick(mode);
        if (mode === 'picker' && res?.rule) win.gBrowser?.selectedBrowser?.reload?.();
        return;
      }
      const browser = win.gBrowser?.selectedBrowser;
      const actor = browser?.browsingContext?.currentWindowGlobal?.getActor('ArgonAdblock');
      if (actor) {
        const res = await actor.sendQuery('pickElement', { mode });
        if (mode === 'picker' && res?.rule) {
          if (typeof service.addCosmeticRule === 'function') {
            await service.addCosmeticRule(res.rule, isPrivate);
          } else {
            const cur = service.config.filters || '';
            const updated = cur ? (cur.endsWith('\n') ? cur + res.rule : cur + '\n' + res.rule) : res.rule;
            await service.saveFilters(updated);
          }
          browser.reload?.();
        }
      } else {
        const contentDoc = browser?.contentDocument;
        if (contentDoc) {
          const tool = startElementTool(contentDoc, { mode });
          const result = await tool.result;
          if (mode === 'picker' && result?.rule) {
            const cur = service.config.filters || '';
            const updated = cur ? (cur.endsWith('\n') ? cur + result.rule : cur + '\n' + result.rule) : result.rule;
            await service.saveFilters(updated);
            browser.reload?.();
          }
        }
      }
    } catch (e) {
      console.error('Element tool error:', e);
    }
  };

  pickerBtn.addEventListener('click', () => launchElementTool('picker'));
  zapperBtn.addEventListener('click', () => launchElementTool('zapper'));

  // Dynamic Firewall View Refresh & Handlers
  const actionCodeMap = { 0: '', 1: 'block', 2: 'allow', 3: 'noop' };
  const refreshFirewall = () => {
    firewallMatrix.replaceChildren();
    const fw = service.engine?.firewall;
    const urlRulesStore = service.engine?.urlRules;
    const srcHost = service.siteKey(siteURL) || '*';
    dynEditor.value = fw ? fw.toArray({ private: isPrivate }).join('\n') : (service.config.dynamicRules || []).join('\n');
    urlRulesEditor.value = urlRulesStore ? urlRulesStore.toArray({ private: isPrivate }).join('\n') : (service.config.urlRules || []).join('\n');
    if (!fw) return;

    const addCellRow = (label, des, type) => {
      const row = html('div', '', null, firewallMatrix);
      row.className = 'argon-adblock-firewall-row';
      html('span', label, null, row);
      const select = html('select', '', null, row);
      select.dataset.src = srcHost;
      select.dataset.des = des;
      select.dataset.type = type;
      const current = actionCodeMap[fw.evaluateCell(srcHost, des, type, { private: isPrivate }) || 0] || '';
      for (const [val, txt] of [
        ['', _t('adblock.firewall.inherit')],
        ['allow', _t('adblock.firewall.allow')],
        ['noop', _t('adblock.firewall.noop')],
        ['block', _t('adblock.firewall.block')],
      ]) {
        const opt = html('option', txt, null, select);
        opt.value = val;
        if (val === current) opt.selected = true;
      }
      select.value = current;
      select.addEventListener('change', () => {
        try {
          if (!select.value) fw.removeSession(srcHost, des, type, { private: isPrivate });
          else fw.setSession(srcHost, des, type, select.value, { private: isPrivate });
          dynEditor.value = fw.toArray({ private: isPrivate }).join('\n');
        } catch (err) {
          error.textContent = formatProtectionError(err, locale);
        }
      });
    };

    for (const type of FIREWALL_CELL_TYPES) {
      addCellRow(`${srcHost} * ${type}`, '*', type);
    }
    const pageId = readPageIdentity();
    const seenHosts = new Set();
    for (const entry of (service.logger ? service.logger.entriesFor(pageId, { limit: 100 }) : [])) {
      if (entry.host && entry.host !== srcHost) seenHosts.add(entry.host);
    }
    for (const host of [...seenHosts].slice(0, 20)) {
      addCellRow(`${srcHost} → ${host}`, host, '*');
    }
  };

  firewallBtn.addEventListener('click', () => {
    showView('firewall-view');
    refreshFirewall();
  });

  fwApplyBtn.addEventListener('click', () => {
    run(async () => {
      const tools = ensureNativeTools();
      if (tools?.dynamic) {
        await tools.dynamic.replaceTemporary(dynEditor.value, { private: isPrivate });
      } else if (service.engine?.firewall) {
        service.engine.firewall.replaceSession(dynEditor.value, { private: isPrivate });
      }
      if (service.engine?.urlRules) {
        service.engine.urlRules.replaceSession(urlRulesEditor.value, { private: isPrivate });
      }
      refreshFirewall();
    });
  });

  fwRevertBtn.addEventListener('click', () => {
    run(async () => {
      const tools = ensureNativeTools();
      if (tools?.dynamic) {
        await tools.dynamic.revertTemporary({ private: isPrivate });
      } else if (service.engine?.firewall) {
        service.engine.firewall.revertSession({ private: isPrivate });
      }
      if (service.engine?.urlRules) {
        service.engine.urlRules.revertSession({ private: isPrivate });
      }
      refreshFirewall();
    });
  });

  fwCommitBtn.addEventListener('click', () => {
    if (isPrivate) return;
    run(async () => {
      const tools = ensureNativeTools();
      if (tools?.dynamic) {
        await tools.dynamic.replaceTemporary(dynEditor.value, { private: false });
        await tools.dynamic.savePermanent({ private: false });
      } else if (typeof service.saveDynamicRules === 'function') {
        await service.saveDynamicRules(dynEditor.value);
      }
      if (typeof service.saveURLRules === 'function') {
        await service.saveURLRules(urlRulesEditor.value);
      }
      refreshFirewall();
    });
  });

  // Logger Refresh & Handler
  const refreshLogger = () => {
    loggerList.replaceChildren();
    const pageId = readPageIdentity();
    const allEntries = service.logger ? service.logger.entriesFor(pageId, { limit: 100 }) : [];
    const filterVal = loggerFilter.value || 'all';
    const searchQuery = String(loggerSearch.value || '').trim().toLowerCase();
    const entries = allEntries.filter(entry => {
      if (filterVal === 'blocked' && entry.decision !== 'blocked') return false;
      if (filterVal === 'allowed' && entry.decision !== 'allowed') return false;
      if (filterVal === 'modified' && entry.decision !== 'redirected' && entry.decision !== 'rewritten') return false;
      if (searchQuery) {
        const haystack = `${entry.url || ''} ${entry.host || ''} ${entry.type || ''} ${entry.rule || ''}`.toLowerCase();
        if (!haystack.includes(searchQuery)) return false;
      }
      return true;
    });
    const counters = service.logger ? service.logger.countersFor(pageId) : { blocked: 0, allowed: 0, redirected: 0, rewritten: 0 };
    const modified = (counters.redirected || 0) + (counters.rewritten || 0);
    loggerSummary.textContent = `${counters.blocked || 0} blocked · ${counters.allowed || 0} allowed · ${modified} modified`;
    if (entries.length === 0) {
      const empty = html('p', 'No requests recorded yet for this tab. Reload to capture live traffic.', null, loggerList);
      empty.className = 'argon-adblock-empty-state';
      return;
    }
    const srcHost = service.siteKey(siteURL) || '*';
    for (const entry of entries) {
      const row = html('div', '', null, loggerList);
      row.className = 'argon-adblock-logger-row';
      const badge = html('span', entry.decision, null, row);
      badge.className = 'argon-adblock-logger-badge';
      badge.dataset.decision = entry.decision;
      const type = html('span', `${entry.method || 'GET'} ${entry.type}`, null, row);
      type.className = 'argon-adblock-logger-type';
      const url = html('span', entry.url, null, row);
      url.className = 'argon-adblock-logger-url';
      url.title = entry.url;
      if (entry.rule) {
        const rule = html('span', `[${entry.ruleSource || 'rule'}] ${entry.rule}`, null, row);
        rule.className = 'argon-adblock-logger-rule';
        rule.title = entry.rule;
      }
      if (service.engine?.firewall && entry.host) {
        const actions = html('div', '', null, row);
        actions.className = 'argon-adblock-logger-actions';
        for (const action of ['block', 'allow', 'noop']) {
          const quickBtn = html('button', action, null, actions);
          quickBtn.type = 'button';
          quickBtn.addEventListener('click', () => {
            service.engine.firewall.setSession(srcHost, entry.host, '*', action, { private: isPrivate });
            status.textContent = `${srcHost} ${entry.host} * ${action}`;
          });
        }
      }
    }
  };

  loggerFilter.addEventListener('change', refreshLogger);
  loggerSearch.addEventListener('input', refreshLogger);
  loggerClearBtn.addEventListener('click', () => {
    service.logger?.clearPage?.(readPageIdentity());
    refreshLogger();
    refresh();
  });

  loggerBtn.addEventListener('click', () => {
    showView('logger-view');
    refreshLogger();
  });

  // Backup & Restore Handlers
  backupBtn.addEventListener('click', () => {
    run(async () => {
      const backupData = createBackup(service.config, { manifest: service.manifest });
      const jsonStr = JSON.stringify(backupData, null, 2);
      try {
        const blob = new win.Blob([jsonStr], { type: 'application/json' });
        const blobUrl = win.URL.createObjectURL(blob);
        const a = doc.createElementNS('http://www.w3.org/1999/xhtml', 'a');
        a.href = blobUrl;
        a.download = `argon-adblock-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        win.URL.revokeObjectURL(blobUrl);
      } catch {}
      status.textContent = _t('adblock.backup.success');
    });
  });

  restoreBtn.addEventListener('click', () => {
    restoreFile.click();
  });

  restoreFile.addEventListener('change', async () => {
    const file = restoreFile.files?.[0];
    if (!file) return;
    run(async () => {
      const text = await file.text();
      const parsed = await parseBackup(text, { manifest: service.manifest });
      await service.change(config => {
        config.filters = parsed.config.filters || '';
        config.sites = [...(parsed.config.sites || [])];
        config.disabledLists = [...(parsed.config.disabledLists || [])];
        if (parsed.config.dynamicRules) config.dynamicRules = [...parsed.config.dynamicRules];
        if (parsed.config.hostnameSwitches) config.hostnameSwitches = [...parsed.config.hostnameSwitches];
        if (parsed.config.urlRules) config.urlRules = [...parsed.config.urlRules];
        if (parsed.config.largeMediaSize !== undefined) config.largeMediaSize = parsed.config.largeMediaSize;
        if (parsed.config.subscriptions) config.subscriptions = [...parsed.config.subscriptions];
        if (parsed.config.migrationData) config.migrationData = parsed.config.migrationData;
      });
      baseline = editor.value = service.config.filters;
      status.textContent = parsed.source === 'ublock' ? _t('adblock.backup.ublockDetected') : _t('adblock.backup.success');
      refresh();
      refreshLists();
    });
    restoreFile.value = '';
  });

  // Categorized List Display
  const categorizeList = id => {
    if (/badware|urlhaus|malicious/i.test(id)) return 'security';
    if (/privacy|spyware|easyprivacy/i.test(id)) return 'privacy';
    if (/annoyance|cookie|newsletter|notification/i.test(id)) return 'annoyances';
    return 'advertising';
  };

  const categoryTitles = {
    advertising: _t('adblock.category.ads'),
    privacy: _t('adblock.category.privacy'),
    security: _t('adblock.category.security'),
    annoyances: _t('adblock.category.annoyances'),
  };

  const refreshLists = () => {
    listBox.replaceChildren();
    const native = service.authority?.native === true;
    const catMap = { advertising: [], privacy: [], security: [], annoyances: [] };
    for (const list of service.manifest?.lists || []) {
      const cat = categorizeList(list.id);
      (catMap[cat] || catMap.advertising).push(list);
    }
    for (const [catKey, lists] of Object.entries(catMap)) {
      if (!lists.length) continue;
      const group = html('div', '', null, listBox);
      group.className = 'argon-adblock-category-group';
      const catHeader = html('div', '', null, group);
      catHeader.className = 'argon-adblock-category-header';
      html('strong', categoryTitles[catKey] || catKey, null, catHeader);
      const enabledInCat = lists.filter(l => !service.config.disabledLists.includes(l.id)).length;
      html('span', _t('adblock.category.enabledCount', { enabled: enabledInCat, total: lists.length }), null, catHeader);
      const itemsContainer = html('div', '', null, group);
      for (const list of lists) {
        const label = html('label', '', null, itemsContainer);
        label.className = 'argon-adblock-list-item';
        html('span', list.title || list.id, null, label);
        const input = html('input', '', 'list-' + list.id, label);
        input.type = 'checkbox';
        input.dataset.listId = list.id;
        input.disabled = !native || busy;
        input.checked = !service.config.disabledLists.includes(list.id);
        input.addEventListener('change', () => {
          const checked = input.checked;
          run(() => service.change(config => {
            config.disabledLists = config.disabledLists.filter(id => id !== list.id);
            if (!checked) config.disabledLists.push(list.id);
          }));
        });
      }
    }
    refreshSubscriptions();
  };

  const refreshSubscriptions = () => {
    subListContainer.replaceChildren();
    const native = service.authority?.native === true;
    const subs = typeof service.getSubscriptions === 'function'
      ? service.getSubscriptions()
      : (service.subscriptions?.subscriptions || service.config?.subscriptions || []);

    for (const sub of subs) {
      const item = html('div', '', null, subListContainer);
      item.className = 'argon-adblock-list-item argon-adblock-subscription-item';
      item.dataset.subId = sub.id;

      const meta = html('div', '', null, item);
      meta.className = 'argon-adblock-subscription-meta';

      const title = html('span', sub.title || sub.url, null, meta);
      title.className = 'argon-adblock-subscription-title';
      title.title = sub.url;

      if (sub.error) {
        const errSpan = html('span', sub.error, null, meta);
        errSpan.className = 'argon-adblock-subscription-error-msg';
      }

      const removeBtn = html('button', _t('adblock.subscriptions.remove'), null, item);
      removeBtn.className = 'argon-adblock-subscription-remove';
      removeBtn.setAttribute('aria-label', _t('adblock.subscriptions.remove'));
      removeBtn.disabled = !native || busy;
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        subStatus.textContent = '';
        subError.textContent = '';
        error.textContent = '';
        status.textContent = '';
        try {
          if (typeof service.removeSubscription === 'function') {
            await service.removeSubscription(sub.id);
          } else if (service.subscriptions?.remove) {
            await service.subscriptions.remove(sub.id);
          }
          refreshSubscriptions();
          refresh();
        } catch (e) {
          const msg = formatProtectionError(e, locale);
          subError.textContent = msg;
          error.textContent = msg;
        } finally {
          removeBtn.disabled = !native || busy;
        }
      });
    }
  };

  const handleAddSubscription = async () => {
    const raw = (subInput.value || '').trim();
    subStatus.textContent = '';
    subError.textContent = '';
    error.textContent = '';
    status.textContent = '';

    if (!raw.startsWith('https://') || /[\s\\\x00-\x1f\x7f]/.test(raw)) {
      const msg = _t('adblock.subscriptions.invalidUrl');
      subError.textContent = msg;
      error.textContent = msg;
      return;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error('invalid');
      }
    } catch {
      const msg = _t('adblock.subscriptions.invalidUrl');
      subError.textContent = msg;
      error.textContent = msg;
      return;
    }

    subAddBtn.disabled = true;
    subInput.disabled = true;
    try {
      if (typeof service.addSubscription === 'function') {
        await service.addSubscription(raw);
      } else if (service.subscriptions?.add) {
        await service.subscriptions.add(raw);
      }
      subInput.value = '';
      const okMsg = _t('adblock.subscriptions.success');
      subStatus.textContent = okMsg;
      status.textContent = okMsg;
      refreshSubscriptions();
      refresh();
    } catch (e) {
      const msg = formatProtectionError(e, locale);
      subError.textContent = msg;
      error.textContent = msg;
    } finally {
      const native = service.authority?.native === true;
      subAddBtn.disabled = !native || busy;
      subInput.disabled = !native || busy;
    }
  };

  subAddBtn.addEventListener('click', handleAddSubscription);
  subInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddSubscription();
    }
  });

  panel.addEventListener('popupshown', () => (site.disabled ? advancedToggle : site).focus());
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { panel.hidePopup(); event.preventDefault(); }
    if (event.key === 'Tab') {
      const controls = [...body.querySelectorAll('button, input, select, textarea, summary')].filter(node => !node.disabled && node.getClientRects().length && (!node.closest('details') || node.tagName.toLowerCase() === 'summary' || node.closest('details').open) && !node.closest('[hidden]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && doc.activeElement === first) { last.focus(); event.preventDefault(); }
      else if (!event.shiftKey && doc.activeElement === last) { first.focus(); event.preventDefault(); }
    }
  });
  panel.addEventListener('popuphidden', () => { button.setAttribute('aria-expanded', 'false'); win.gURLBar?.focus(); });

  button.addEventListener('command', () => {
    siteURL = win.gBrowser.selectedBrowser.currentURI.spec;
    showView('home');
    error.textContent = ''; status.textContent = '';
    button.setAttribute('aria-expanded', 'true');
    panel.openPopup(button, 'after_end');
    readGhostStatus(win.gBrowser.selectedBrowser);
    service.ready.then(() => {
      refresh();
      refreshLists();
      baseline = editor.value = service.config.filters;
    }).catch(e => {
      error.textContent = formatProtectionError(e, locale);
    });
  });

  const syncToolbarBadgeOnly = () => {
    try {
      const currentSpec = win.gBrowser?.selectedBrowser?.currentURI?.spec || '';
      const key = service.siteKey(currentSpec);
      const localEnabled = service.siteEnabled(currentSpec, isPrivate);
      const enabled = service.enabled();
      const native = service.authority?.native === true;
      button.setAttribute('badged', 'true');
      if (native && enabled && localEnabled && key && service.logger) {
        const counters = service.logger.countersFor(readPageIdentity());
        const count = (counters?.blocked || 0) + (counters?.redirected || 0);
        button.setAttribute('badge', count > 0 ? (count > 99 ? '99+' : String(count)) : '');
      } else {
        button.setAttribute('badge', '');
      }
      if (panel.state === 'open') {
        siteURL = currentSpec;
        refresh();
        if (!views['logger-view'].hidden) refreshLogger();
      }
    } catch {}
  };

  let liveBadgeTimer = null;
  const scheduleLiveSync = () => {
    if (liveBadgeTimer !== null) return;
    if (typeof win.setTimeout === 'function') {
      liveBadgeTimer = win.setTimeout(() => {
        liveBadgeTimer = null;
        syncToolbarBadgeOnly();
      }, 120);
    } else {
      syncToolbarBadgeOnly();
    }
  };

  const unsubscribeLogger = typeof service.logger?.subscribe === 'function'
    ? service.logger.subscribe(scheduleLiveSync)
    : null;
  win.gBrowser?.tabContainer?.addEventListener?.('TabSelect', syncToolbarBadgeOnly);
  const tabsProgressListener = {
    onLocationChange(browser) {
      if (browser === win.gBrowser?.selectedBrowser) syncToolbarBadgeOnly();
    },
  };
  win.gBrowser?.addTabsProgressListener?.(tabsProgressListener);
  win.addEventListener?.('unload', () => {
    if (liveBadgeTimer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(liveBadgeTimer);
    unsubscribeLogger?.();
    win.gBrowser?.tabContainer?.removeEventListener?.('TabSelect', syncToolbarBadgeOnly);
    win.gBrowser?.removeTabsProgressListener?.(tabsProgressListener);
  }, { once: true });

  doc.getElementById('mainPopupSet').append(panel);
  doc.getElementById('nav-bar').insertBefore(button, doc.getElementById('nav-bar-overflow-button'));
}
