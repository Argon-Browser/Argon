// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE,
  LOCALES,
  TRANSLATIONS,
  normalizeLocale,
  resolveLocale,
  t,
  createI18n,
  applyToDOM,
} from '../../argon/i18n.mjs';

test('i18n: default locale is en-US and covers 45 locales', () => {
  assert.equal(DEFAULT_LOCALE, 'en-US');
  const localeKeys = Object.keys(LOCALES);
  assert.equal(localeKeys.length, 45);
  for (const code of localeKeys) {
    assert.ok(TRANSLATIONS[code], `Locale ${code} must be present in TRANSLATIONS`);
    assert.ok(LOCALES[code].name, `Locale ${code} must have a name`);
    assert.ok(LOCALES[code].native, `Locale ${code} must have a native name`);
    assert.ok(LOCALES[code].dir === 'ltr' || LOCALES[code].dir === 'rtl', `Locale ${code} must specify dir`);
  }
});

test('i18n: RTL locales are marked correctly', () => {
  assert.equal(LOCALES['ar'].dir, 'rtl');
  assert.equal(LOCALES['he'].dir, 'rtl');
  assert.equal(LOCALES['en-US'].dir, 'ltr');
  assert.equal(LOCALES['pt-BR'].dir, 'ltr');
});

test('i18n: normalizeLocale handles tags, aliases, and fallbacks', () => {
  assert.equal(normalizeLocale('en-US'), 'en-US');
  assert.equal(normalizeLocale('en'), 'en-US');
  assert.equal(normalizeLocale('EN-US'), 'en-US');
  assert.equal(normalizeLocale('pt-BR'), 'pt-BR');
  assert.equal(normalizeLocale('pt_br'), 'pt-BR');
  assert.equal(normalizeLocale('pt'), 'pt');
  assert.equal(normalizeLocale('pt-PT'), 'pt');
  assert.equal(normalizeLocale('es'), 'es');
  assert.equal(normalizeLocale('es-ES'), 'es-ES');
  assert.equal(normalizeLocale('es-MX'), 'es');
  assert.equal(normalizeLocale('fr-CA'), 'fr');
  assert.equal(normalizeLocale('de-AT'), 'de');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh-TW'), 'zh-TW');
  assert.equal(normalizeLocale('zh-HK'), 'zh-TW');
  assert.equal(normalizeLocale('nb'), 'nb-NO');
  assert.equal(normalizeLocale('unknown-XYZ'), 'en-US');
  assert.equal(normalizeLocale(null), 'en-US');
  assert.equal(normalizeLocale(''), 'en-US');
});

test('i18n: resolveLocale respects preferences, Services, and context hierarchy', () => {
  // Explicit request
  assert.equal(resolveLocale('pt-BR'), 'pt-BR');
  assert.equal(resolveLocale('es'), 'es');

  // Mock Services prefs
  const mockWithPref = {
    Services: {
      prefs: {
        getStringPref(name) {
          return name === 'argon.locale' ? 'ja' : '';
        },
      },
    },
  };
  assert.equal(resolveLocale(null, mockWithPref), 'ja');

  // Mock Services appLocale
  const mockWithLocale = {
    Services: {
      locale: {
        appLocaleAsBCP47: 'fr',
      },
    },
  };
  assert.equal(resolveLocale(null, mockWithLocale), 'fr');

  // Mock DOM documentElement lang
  const mockWithDoc = {
    document: {
      documentElement: { lang: 'de' },
    },
  };
  assert.equal(resolveLocale(null, mockWithDoc), 'de');

  // Mock window navigator language
  const mockWithNav = {
    navigator: { language: 'it' },
  };
  assert.equal(resolveLocale(null, mockWithNav), 'it');

  // Default fallback when context is empty
  assert.equal(resolveLocale(null, {}), 'en-US');
});

test('i18n: t() translates and falls back to English', () => {
  // English default
  assert.equal(t('adblock.site.thisTab', null, 'en-US'), 'This tab');
  assert.equal(t('adblock.button.label', null, 'en-US'), 'Argon Adblock');
  assert.equal(t('blocked.heading', null, 'en-US'), 'Navigation blocked');
  assert.equal(t('onboarding.welcome.title', null, 'en-US'), 'Meet Argon');

  // Portuguese
  assert.equal(t('adblock.site.thisTab', null, 'pt-BR'), 'Esta aba');
  assert.equal(t('blocked.heading', null, 'pt-BR'), 'Navegação bloqueada');
  assert.equal(t('onboarding.welcome.title', null, 'pt-BR'), 'Conheça o Argon');

  // Spanish
  assert.equal(t('adblock.site.thisTab', null, 'es'), 'Esta pestaña');
  assert.equal(t('blocked.heading', null, 'es'), 'Navegación bloqueada');

  // French
  assert.equal(t('adblock.site.thisTab', null, 'fr'), 'Cet onglet');
  assert.equal(t('blocked.heading', null, 'fr'), 'Navigation bloquée');

  // German
  assert.equal(t('adblock.site.thisTab', null, 'de'), 'Dieser Tab');
  assert.equal(t('blocked.heading', null, 'de'), 'Navigation blockiert');

  // Italian
  assert.equal(t('adblock.site.thisTab', null, 'it'), 'Questa scheda');
  assert.equal(t('blocked.heading', null, 'it'), 'Navigazione bloccata');

  // Russian
  assert.equal(t('adblock.site.thisTab', null, 'ru'), 'Эта вкладка');
  assert.equal(t('blocked.heading', null, 'ru'), 'Навигация заблокирована');

  // Japanese
  assert.equal(t('adblock.site.thisTab', null, 'ja'), 'このタブ');
  assert.equal(t('blocked.heading', null, 'ja'), 'アクセスがブロックされました');

  // Chinese Simplified
  assert.equal(t('adblock.site.thisTab', null, 'zh-CN'), '此标签页');
  assert.equal(t('blocked.heading', null, 'zh-CN'), '导航已被拦截');

  // Chinese Traditional
  assert.equal(t('adblock.site.thisTab', null, 'zh-TW'), '此分頁');
  assert.equal(t('blocked.heading', null, 'zh-TW'), '瀏覽已遭封鎖');

  // Missing key falls back to key itself
  assert.equal(t('totally.nonexistent.key', null, 'pt-BR'), 'totally.nonexistent.key');
});

test('i18n: interpolation replaces named parameters', () => {
  const en = t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'en-US');
  assert.equal(en, '18 of 19 lists selected');

  const pt = t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'pt-BR');
  assert.equal(pt, '18 de 19 listas selecionadas');

  const de = t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'de');
  assert.equal(de, '18 von 19 Listen ausgewählt');

  const fr = t('adblock.summary.listsSelected', { count: 18, total: 19 }, 'fr');
  assert.equal(fr, '18 sur 19 listes sélectionnées');
});

test('i18n: createI18n produces bound helper', () => {
  const i18n = createI18n(null, 'es');
  assert.equal(i18n.locale, 'es');
  assert.equal(i18n.t('adblock.site.thisTab'), 'Esta pestaña');
  assert.equal(i18n.t('blocked.back'), 'Volver');
});

test('i18n: applyToDOM populates textContent, attributes, and document metadata', () => {
  const attributes = new Map();
  const elements = [
    {
      getAttribute: attr => (attr === 'data-i18n' ? 'blocked.heading' : null),
      textContent: 'Original',
    },
    {
      getAttribute: attr => (attr === 'data-i18n' ? 'blocked.back' : null),
      textContent: 'Original',
    },
    {
      getAttribute: attr => (attr === 'data-i18n-aria-label' ? 'adblock.panel.ariaLabel' : null),
      setAttribute: (attr, val) => attributes.set(`aria:${attr}`, val),
    },
    {
      getAttribute: attr => (attr === 'data-i18n-title' ? 'adblock.button.tooltip' : null),
      setAttribute: (attr, val) => attributes.set(`title:${attr}`, val),
    },
    {
      getAttribute: attr => (attr === 'data-i18n-placeholder' ? 'commands.placeholder' : null),
      setAttribute: (attr, val) => attributes.set(`ph:${attr}`, val),
    },
  ];

  const fakeDoc = {
    nodeType: 9,
    documentElement: { lang: 'en', dir: 'ltr' },
    querySelectorAll: selector => {
      if (selector === '[data-i18n]') return [elements[0], elements[1]];
      if (selector === '[data-i18n-aria-label]') return [elements[2]];
      if (selector === '[data-i18n-title]') return [elements[3]];
      if (selector === '[data-i18n-placeholder]') return [elements[4]];
      return [];
    },
  };

  // Apply Portuguese
  applyToDOM(fakeDoc, 'pt-BR');
  assert.equal(fakeDoc.documentElement.lang, 'pt-BR');
  assert.equal(fakeDoc.documentElement.dir, 'ltr');
  assert.equal(elements[0].textContent, 'Navegação bloqueada');
  assert.equal(elements[1].textContent, 'Voltar');
  assert.equal(attributes.get('aria:aria-label'), 'Argon Adblock — proteção nativa');
  assert.equal(attributes.get('title:title'), 'Argon Adblock');
  assert.equal(attributes.get('ph:placeholder'), 'Digite um comando ou pesquise…');

  // Apply Arabic (RTL)
  applyToDOM(fakeDoc, 'ar');
  assert.equal(fakeDoc.documentElement.lang, 'ar');
  assert.equal(fakeDoc.documentElement.dir, 'rtl');
  assert.equal(elements[0].textContent, 'تم حظر التنقل');
  assert.equal(elements[1].textContent, 'رجوع');

  // Apply English (Default)
  applyToDOM(fakeDoc, 'en-US');
  assert.equal(fakeDoc.documentElement.lang, 'en-US');
  assert.equal(fakeDoc.documentElement.dir, 'ltr');
  assert.equal(elements[0].textContent, 'Navigation blocked');
  assert.equal(elements[1].textContent, 'Go back');
});

test('i18n: upgraded adblock UI hero, stats, actions, categories, and backup keys', () => {
  // Hero statuses
  assert.equal(t('adblock.hero.status', null, 'en-US'), 'Protection status');
  assert.equal(t('adblock.hero.status', null, 'pt-BR'), 'Status da proteção');
  assert.equal(t('adblock.hero.status', null, 'pt'), 'Estado da proteção');
  assert.equal(t('adblock.hero.status', null, 'es'), 'Estado de la protección');
  assert.equal(t('adblock.hero.status', null, 'fr'), 'État de la protection');
  assert.equal(t('adblock.hero.status', null, 'de'), 'Schutzstatus');
  assert.equal(t('adblock.hero.status', null, 'ja'), '保護ステータス');
  assert.equal(t('adblock.hero.status', null, 'zh-CN'), '保护状态');
  assert.equal(t('adblock.hero.status', null, 'zh-TW'), '保護狀態');

  assert.equal(t('adblock.hero.protected', null, 'en-US'), 'Protected on this site');
  assert.equal(t('adblock.hero.protected', null, 'pt-BR'), 'Protegido nesta página');
  assert.equal(t('adblock.hero.paused', null, 'en-US'), 'Protection paused');
  assert.equal(t('adblock.hero.paused', null, 'pt-BR'), 'Proteção pausada');
  assert.equal(t('adblock.hero.shieldsUp', null, 'en-US'), 'Shields Up');
  assert.equal(t('adblock.hero.shieldsUp', null, 'pt-BR'), 'Escudos ativos');

  // Stats labels and parameter interpolation
  assert.equal(t('adblock.stats.blockedPage', null, 'en-US'), 'Blocked on this page');
  assert.equal(t('adblock.stats.blockedPage', null, 'pt-BR'), 'Bloqueados nesta página');
  assert.equal(t('adblock.stats.trackersAds', null, 'en-US'), 'Trackers & ads');
  assert.equal(t('adblock.stats.trackersAds', null, 'pt-BR'), 'Rastreadores e anúncios');
  assert.equal(t('adblock.stats.zeroThreats', null, 'en-US'), 'No threats blocked yet');
  assert.equal(t('adblock.stats.zeroThreats', null, 'pt-BR'), 'Zero bloqueios');
  assert.equal(t('adblock.stats.itemsBlocked', { count: 42 }, 'en-US'), '42 items blocked');
  assert.equal(t('adblock.stats.itemsBlocked', { count: 42 }, 'pt-BR'), '42 itens bloqueados');

  // Quick actions
  assert.equal(t('adblock.action.picker', null, 'en-US'), 'Block element');
  assert.equal(t('adblock.action.picker', null, 'pt-BR'), 'Bloquear elemento');
  assert.equal(t('adblock.action.logger', null, 'en-US'), 'Network logger');
  assert.equal(t('adblock.action.logger', null, 'pt-BR'), 'Registro de rede');
  assert.equal(t('adblock.action.logger', null, 'pt'), 'Registo de rede');
  assert.equal(t('adblock.action.ghostprint', null, 'en-US'), 'Fingerprint protection');
  assert.equal(t('adblock.action.ghostprint', null, 'pt-BR'), 'Proteção contra impressão digital');
  assert.equal(t('adblock.action.reload', null, 'en-US'), 'Reload page');
  assert.equal(t('adblock.action.reload', null, 'pt-BR'), 'Recarregar página');

  // Categories & Tabs
  assert.equal(t('adblock.category.ads', null, 'en-US'), 'Advertising');
  assert.equal(t('adblock.category.ads', null, 'pt-BR'), 'Anúncios');
  assert.equal(t('adblock.category.privacy', null, 'en-US'), 'Privacy');
  assert.equal(t('adblock.category.privacy', null, 'pt-BR'), 'Privacidade');
  assert.equal(t('adblock.category.annoyances', null, 'en-US'), 'Annoyances');
  assert.equal(t('adblock.category.annoyances', null, 'pt-BR'), 'Incômodos');
  assert.equal(t('adblock.category.annoyances', null, 'pt'), 'Incómodos');
  assert.equal(t('adblock.category.security', null, 'en-US'), 'Security');
  assert.equal(t('adblock.category.security', null, 'pt-BR'), 'Segurança');
  assert.equal(t('adblock.category.enabledCount', { enabled: 3, total: 5 }, 'en-US'), '3 of 5 enabled');
  assert.equal(t('adblock.category.enabledCount', { enabled: 3, total: 5 }, 'pt-BR'), '3 de 5 ativadas');
  assert.equal(t('adblock.tabs.home', null, 'pt-BR'), 'Início');
  assert.equal(t('adblock.tabs.lists', null, 'pt-BR'), 'Listas de filtros');
  assert.equal(t('adblock.tabs.settings', null, 'pt-BR'), 'Configurações');
  assert.equal(t('adblock.tabs.settings', null, 'pt'), 'Definições');

  // Backup & Restore
  assert.equal(t('adblock.backup.title', null, 'en-US'), 'Backup & restore');
  assert.equal(t('adblock.backup.title', null, 'pt-BR'), 'Backup e restauração');
  assert.equal(t('adblock.backup.title', null, 'pt'), 'Cópia de segurança e restauro');
  assert.equal(t('adblock.backup.export', null, 'pt-BR'), 'Exportar backup');
  assert.equal(t('adblock.backup.import', null, 'pt-BR'), 'Importar backup');
  assert.equal(t('adblock.backup.success', null, 'pt-BR'), 'Backup restaurado com sucesso!');
  assert.equal(t('adblock.backup.reset', null, 'pt-BR'), 'Restaurar padrões');

  // Authority badge
  assert.equal(t('adblock.badge.ublockNotice', null, 'en-US'), 'Managed by uBlock Origin');
  assert.equal(t('adblock.badge.ublockNotice', null, 'pt-BR'), 'Gerenciado pelo uBlock Origin');

  // Compatibility aliases
  assert.equal(t('adblock.hero.protectedOnSite', null, 'pt-BR'), 'Protegido nesta página');
  assert.equal(t('adblock.hero.protectionPaused', null, 'pt-BR'), 'Proteção pausada');
  assert.equal(t('adblock.stats.blockedOnPage', null, 'pt-BR'), 'Bloqueados nesta página');
  assert.equal(t('adblock.stats.trackersAndAds', null, 'pt-BR'), 'Rastreadores e anúncios');
  assert.equal(t('adblock.stats.noThreats', null, 'pt-BR'), 'Zero bloqueios');
  assert.equal(t('adblock.action.blockElement', null, 'pt-BR'), 'Bloquear elemento');
  assert.equal(t('adblock.action.networkLogger', null, 'pt-BR'), 'Registro de rede');
  assert.equal(t('adblock.action.fingerprintProtection', null, 'pt-BR'), 'Proteção contra impressão digital');
  assert.equal(t('adblock.action.reloadPage', null, 'pt-BR'), 'Recarregar página');
  assert.equal(t('adblock.lists.categoryAds', null, 'pt-BR'), 'Anúncios');
  assert.equal(t('adblock.lists.categoryPrivacy', null, 'pt-BR'), 'Privacidade');
  assert.equal(t('adblock.lists.categoryAnnoyances', null, 'pt-BR'), 'Incômodos');
  assert.equal(t('adblock.lists.categorySecurity', null, 'pt-BR'), 'Segurança');
  assert.equal(t('adblock.lists.categoryCustom', null, 'pt-BR'), 'Listas personalizadas');
});

test('i18n: onboarding Firefox Nova visual option translations', () => {
  // English (en-US)
  assert.equal(t('onboarding.appearance.nova', null, 'en-US'), 'Firefox Nova visual refresh');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'en-US'),
    "Enable Firefox's modern Nova design with rounded tabs, updated toolbar icons, and Activity Stream refresh."
  );

  // Portuguese (pt-BR / pt-PT)
  assert.equal(t('onboarding.appearance.nova', null, 'pt-BR'), 'Visual Nova do Firefox');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'pt-BR'),
    'Ativar o design Nova moderno do Firefox com abas arredondadas, ícones atualizados e novo visual da página inicial.'
  );
  assert.equal(t('onboarding.appearance.nova', null, 'pt-PT'), 'Visual Nova do Firefox');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'pt-PT'),
    'Ativar o design Nova moderno do Firefox com abas arredondadas, ícones atualizados e novo visual da página inicial.'
  );

  // Spanish (es-ES / es-419)
  assert.equal(t('onboarding.appearance.nova', null, 'es-ES'), 'Aspecto visual Nova de Firefox');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'es-ES'),
    'Activa el diseño moderno Nova de Firefox con pestañas redondeadas e iconos actualizados.'
  );
  assert.equal(t('onboarding.appearance.nova', null, 'es-419'), 'Aspecto visual Nova de Firefox');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'es-419'),
    'Activa el diseño moderno Nova de Firefox con pestañas redondeadas e iconos actualizados.'
  );

  // German (de-DE)
  assert.equal(t('onboarding.appearance.nova', null, 'de-DE'), 'Firefox Nova-Design');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'de-DE'),
    'Aktiviert das moderne Nova-Design von Firefox mit abgerundeten Tabs und aktualisierten Symbolen.'
  );

  // French (fr-FR)
  assert.equal(t('onboarding.appearance.nova', null, 'fr-FR'), 'Design visuel Firefox Nova');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'fr-FR'),
    'Active le design moderne Nova de Firefox avec des onglets arrondis et des icônes actualisées.'
  );

  // Italian (it-IT)
  assert.equal(t('onboarding.appearance.nova', null, 'it-IT'), 'Stile visivo Firefox Nova');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'it-IT'),
    'Attiva il moderno design Nova di Firefox con schede arrotondate e icone aggiornate.'
  );

  // Japanese (ja-JP)
  assert.equal(t('onboarding.appearance.nova', null, 'ja-JP'), 'Firefox Nova ビジュアルリフレッシュ');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'ja-JP'),
    '角丸タブと最新のツールバーアイコンを備えた Firefox の最新 Nova デザインを有効にします。'
  );

  // Russian (ru-RU)
  assert.equal(t('onboarding.appearance.nova', null, 'ru-RU'), 'Визуальный стиль Firefox Nova');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'ru-RU'),
    'Включает современный дизайн Firefox Nova с закругленными вкладками и обновленными значками.'
  );

  // Chinese (zh-CN)
  assert.equal(t('onboarding.appearance.nova', null, 'zh-CN'), 'Firefox Nova 视觉革新');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'zh-CN'),
    '启用 Firefox 现代 Nova 设计，带来圆角标签页与全新工具栏图标。'
  );

  // Traditional Chinese (zh-TW)
  assert.equal(t('onboarding.appearance.nova', null, 'zh-TW'), 'Firefox Nova 視覺革新');
  assert.equal(
    t('onboarding.appearance.novaDesc', null, 'zh-TW'),
    '啟用 Firefox 現代 Nova 設計，帶來圓角分頁與全新工具列圖示。'
  );

  // Fallbacks across all 45 supported locales
  for (const loc of Object.keys(LOCALES)) {
    assert.ok(t('onboarding.appearance.nova', null, loc));
    assert.ok(t('onboarding.appearance.novaDesc', null, loc));
  }
});

test('i18n: adblock subscriptions keys exist across all locales with PT and EN', () => {
  // English
  assert.equal(t('adblock.subscriptions.add', null, 'en-US'), 'Add filter list from URL');
  assert.equal(t('adblock.subscriptions.placeholder', null, 'en-US'), 'https://example.com/filter-list.txt');
  assert.equal(t('adblock.subscriptions.button', null, 'en-US'), 'Add');
  assert.equal(t('adblock.subscriptions.remove', null, 'en-US'), 'Remove');
  assert.equal(t('adblock.subscriptions.invalidUrl', null, 'en-US'), 'Invalid HTTPS URL');
  assert.equal(t('adblock.subscriptions.success', null, 'en-US'), 'List added successfully');

  // Portuguese (pt-BR and pt)
  for (const loc of ['pt-BR', 'pt']) {
    assert.equal(t('adblock.subscriptions.add', null, loc), 'Adicionar lista via URL');
    assert.equal(t('adblock.subscriptions.placeholder', null, loc), 'https://example.com/filter-list.txt');
    assert.equal(t('adblock.subscriptions.button', null, loc), 'Adicionar');
    assert.equal(t('adblock.subscriptions.remove', null, loc), 'Remover');
    assert.equal(t('adblock.subscriptions.invalidUrl', null, loc), 'URL HTTPS inválida');
    assert.equal(t('adblock.subscriptions.success', null, loc), 'Lista adicionada com sucesso');
  }

  // Across all 45 locales
  for (const loc of Object.keys(LOCALES)) {
    assert.ok(t('adblock.subscriptions.add', null, loc));
    assert.ok(t('adblock.subscriptions.placeholder', null, loc));
    assert.ok(t('adblock.subscriptions.button', null, loc));
    assert.ok(t('adblock.subscriptions.remove', null, loc));
    assert.ok(t('adblock.subscriptions.invalidUrl', null, loc));
    assert.ok(t('adblock.subscriptions.success', null, loc));
  }
});

test('i18n: GhostPrint and anti-fingerprint switcher keys exist across all locales with PT and EN', () => {
  const afpKeys = [
    'settings.privacy.afpTitle',
    'settings.privacy.afpDesc',
    'settings.privacy.afpGhostprint',
    'settings.privacy.afpGhostprintDesc',
    'settings.privacy.afpFirefox',
    'settings.privacy.afpFirefoxDesc',
    'settings.privacy.afpBoth',
    'settings.privacy.afpBothDesc',
    'onboarding.privacy.ghostprint',
    'onboarding.privacy.ghostprintDesc',
  ];

  // English (en-US)
  assert.equal(t('settings.privacy.afpTitle', null, 'en-US'), 'Anti-fingerprint protection');
  assert.equal(
    t('settings.privacy.afpDesc', null, 'en-US'),
    'Choose how Argon protects against browser fingerprinting and cross-site tracking.'
  );
  assert.equal(t('settings.privacy.afpGhostprint', null, 'en-US'), 'GhostPrint (Default)');
  assert.equal(
    t('settings.privacy.afpGhostprintDesc', null, 'en-US'),
    'Adds subtle random noise to canvas, WebGL, and audio data to reduce tracking.'
  );
  assert.equal(t('settings.privacy.afpFirefox', null, 'en-US'), 'Firefox RFP');
  assert.equal(
    t('settings.privacy.afpFirefoxDesc', null, 'en-US'),
    "Uses Firefox's built-in protection to standardize screen dimensions, hardware details, and time zone."
  );
  assert.equal(t('settings.privacy.afpBoth', null, 'en-US'), 'Combined');
  assert.equal(
    t('settings.privacy.afpBothDesc', null, 'en-US'),
    'Applies both GhostPrint noise and Firefox fingerprint resistance.'
  );
  assert.equal(t('onboarding.privacy.ghostprint', null, 'en-US'), 'GhostPrint anti-fingerprint protection');
  assert.equal(
    t('onboarding.privacy.ghostprintDesc', null, 'en-US'),
    'Randomizes canvas, WebGL, audio, and hardware signatures to prevent tracking across sites.'
  );

  // Portuguese (pt-BR, pt, and pt-PT alias)
  for (const loc of ['pt-BR', 'pt', 'pt-PT']) {
    assert.equal(t('settings.privacy.afpTitle', null, loc), 'Proteção contra fingerprint');
    assert.equal(
      t('settings.privacy.afpDesc', null, loc),
      'Escolha como o Argon protege contra fingerprinting e rastreamento entre sites.'
    );
    assert.equal(t('settings.privacy.afpGhostprint', null, loc), 'GhostPrint (Padrão)');
    assert.equal(
      t('settings.privacy.afpGhostprintDesc', null, loc),
      'Adiciona pequenas variações aleatórias a canvas, WebGL e áudio para evitar rastreamento.'
    );
    assert.equal(t('settings.privacy.afpFirefox', null, loc), 'Firefox RFP');
    assert.equal(
      t('settings.privacy.afpFirefoxDesc', null, loc),
      'Usa a proteção integrada do Firefox para padronizar dimensões de tela, hardware e fuso horário.'
    );
    assert.equal(t('settings.privacy.afpBoth', null, loc), 'Combinado');
    assert.equal(
      t('settings.privacy.afpBothDesc', null, loc),
      'Aplica o ruído do GhostPrint e a proteção contra fingerprint do Firefox.'
    );
    assert.equal(t('onboarding.privacy.ghostprint', null, loc), 'Proteção contra fingerprint GhostPrint');
    assert.equal(
      t('onboarding.privacy.ghostprintDesc', null, loc),
      'Gera pequenas variações em assinaturas de canvas, WebGL, áudio e hardware para impedir o rastreamento entre sites.'
    );
  }

  // Across all 45 locales
  for (const loc of Object.keys(LOCALES)) {
    for (const key of afpKeys) {
      const value = t(key, null, loc);
      assert.ok(value, `Key ${key} must resolve to non-empty string in locale ${loc}`);
      assert.notEqual(value, key, `Key ${key} must not be unlocalized in locale ${loc}`);
    }
  }
});



