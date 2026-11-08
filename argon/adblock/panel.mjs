// SPDX-License-Identifier: MPL-2.0
export function formatProtectionError(error) {
  const fallback = 'Falha desconhecida. Tente novamente ou recarregue a aba.';
  try {
    const text = (typeof error?.message === 'string' ? error.message : String(error ?? '')).trim();
    return !text || /^(null|undefined|\[object Object\])$/i.test(text) ? fallback : text;
  } catch { return fallback; }
}
export function installAdblockPanel(win) {
  const doc = win.document;
  if (doc.getElementById('argon-adblock-button')) return;
  const { ArgonAdblock: service } = win.ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs');
  const button = doc.createXULElement('toolbarbutton');
  button.id = 'argon-adblock-button';
  button.classList.add('toolbarbutton-1');
  for (const attr of ['label', 'tooltiptext', 'aria-label']) button.setAttribute(attr, 'Argon Adblock');
  button.setAttribute('image', 'chrome://browser/skin/tracking-protection.svg');
  button.setAttribute('aria-haspopup', 'dialog');
  const panel = doc.createXULElement('panel');
  panel.id = 'argon-adblock-panel';
  panel.setAttribute('type', 'arrow');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Argon Adblock — proteção nativa');
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
  const icon = (parent, path) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shape = doc.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', path);
    svg.append(shape); parent.append(svg);
  };
  const shield = 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z M8 12l3 3 5-6';
  const header = html('header', '', 'header');
  icon(header, shield);
  const identity = html('div', '', 'identity', header);
  const domain = html('h2', 'Esta aba', 'domain', identity);
  const siteStatus = html('p', 'Carregando proteção…', 'site-status', identity);
  const site = html('button', '', 'site', header);
  site.className = 'argon-adblock-switch';
  site.setAttribute('role', 'switch');
  site.setAttribute('aria-label', 'Proteção nativa neste site');
  site.setAttribute('aria-describedby', 'argon-adblock-site-status');
  site.disabled = true;
  const summary = html('div', '', 'summary');
  icon(summary, shield);
  const summaryText = html('div', '', null, summary);
  const summaryTitle = html('strong', 'Motor nativo', 'summary-title', summaryText);
  const summaryDetail = html('p', 'Carregando listas…', 'summary-detail', summaryText);
  const middle = html('div', '', 'middle');
  // Keep Firefox's implicit scroll-container tab stop out of the dialog order.
  middle.tabIndex = -1;
  const home = html('section', '', 'home', middle);
  const advanced = html('details', '', 'advanced', home);
  advanced.open = true;
  const advancedToggle = html('summary', '', 'advanced-toggle', advanced);
  icon(advancedToggle, 'M4 7h16M4 17h16M8 4v6M16 14v6');
  html('span', 'Opções avançadas', null, advancedToggle);
  const siteScope = html('p', '', 'site-scope', advanced);
  const { ArgonGhostPrint: ghost, SURFACES } = win.ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs');
  const ghostSection = html('section', '', 'ghost', advanced);
  const ghostHeader = html('div', '', 'ghost-header', ghostSection);
  ghostHeader.className = 'argon-adblock-row';
  html('h3', 'GhostPrint — antifingerprinting', null, ghostHeader);
  const ghostSite = html('button', '', 'ghost-site', ghostHeader);
  ghostSite.className = 'argon-adblock-switch';
  ghostSite.setAttribute('role', 'switch');
  ghostSite.setAttribute('aria-label', 'GhostPrint neste site');
  const ghostStatus = html('p', '', 'ghost-status', ghostSection);
  ghostStatus.setAttribute('role', 'status');
  ghostSite.setAttribute('aria-describedby', ghostStatus.id);
  html('p', 'Independente do adblock. Origem exata (protocolo, domínio e porta), incluindo quadros HTTP(S). Alterações exigem recarregar. Sem cobertura de workers ou todos os contextos. RFP/FPP do Gecko têm prioridade e nunca são desativados aqui.', null, ghostSection);
  const ghostDetails = html('p', '', 'ghost-surfaces', ghostSection);
  advanced.append(siteScope);
  const reload = html('button', '', 'reload', advanced);
  reload.className = 'argon-adblock-row';
  icon(reload, 'M20 7v5h-5M20 12a8 8 0 1 0-2 6');
  html('span', 'Recarregar esta aba', null, reload);
  reload.addEventListener('click', () => { panel.hidePopup(); win.gBrowser.selectedBrowser.reload(); });
  const views = {home};
  for (const [name, title] of [['lists-view', 'Listas de filtros'], ['settings-view', 'Configurações globais']]) {
    const view = html('section', '', name, middle);
    view.hidden = true;
    const back = html('button', '', name + '-back', view);
    back.className = 'argon-adblock-back';
    icon(back, 'm14 6-6 6 6 6');
    html('span', title, null, back);
    back.setAttribute('aria-label', 'Voltar à proteção do site');
    back.addEventListener('click', () => showView('home'));
    views[name] = view;
  }
  const showView = name => {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    middle.scrollTop = 0;
    if (name === 'home') (site.disabled ? advancedToggle : site).focus();
    else views[name].querySelector('button').focus();
  };
  const listBox = html('div', '', 'lists', views['lists-view']);
  html('p', 'Atualizações seguem as permissões de atualização de extensões nas configurações. Sem assinaturas personalizadas nesta versão.', null, views['lists-view']);
  const settings = views['settings-view'];
  const globalRow = html('div', '', null, settings);
  globalRow.className = 'argon-adblock-row';
  icon(globalRow, shield);
  html('span', 'Proteção nativa global', 'global-label', globalRow);
  const global = html('button', '', 'global', globalRow);
  global.className = 'argon-adblock-switch';
  global.setAttribute('role', 'switch');
  global.setAttribute('aria-labelledby', 'argon-adblock-global-label');
  html('h3', 'GhostPrint global', null, settings);
  const ghostGlobalLabel = html('label', 'Ativar GhostPrint (sem substituir RFP/FPP)', null, settings);
  const ghostGlobal = html('input', '', 'ghost-global', ghostGlobalLabel);
  ghostGlobal.type = 'checkbox';
  const ghostInputs = new Map();
  const surfaceLabels = { canvas: 'Canvas — leitura e exportação', webgl: 'WebGL — pixels e identificadores', webgpu: 'WebGPU — identificadores do adaptador', audio: 'Áudio — buffers e analisadores', navigator: 'Navigator — processadores lógicos', plugins: 'Plugins e tipos MIME — perfil PDF' };
  for (const name of SURFACES) {
    const row = html('label', surfaceLabels[name], null, settings);
    const input = html('input', '', 'ghost-' + name, row);
    input.type = 'checkbox'; ghostInputs.set(name, input);
    input.addEventListener('change', () => { win.Services.prefs.setBoolPref('argon.ghostprint.' + name, input.checked); status.textContent = 'Salvo. Recarregue a aba para aplicar GhostPrint.'; refresh(); });
  }
  ghostGlobal.addEventListener('change', () => { win.Services.prefs.setBoolPref('argon.ghostprint.enabled', ghostGlobal.checked); status.textContent = 'Salvo. Recarregue a aba para aplicar GhostPrint.'; refresh(); });
  const label = html('label', 'Meus filtros', null, settings);
  label.htmlFor = 'argon-adblock-filters';
  const editor = html('textarea', '', 'filters', settings);
  editor.rows = 6;
  editor.spellcheck = false;
  editor.setAttribute('aria-describedby', 'argon-adblock-filter-help');
  html('p', 'Uma regra por linha; apague para remover. Regras compatíveis com adblock-rust. Scriptlets e filtros procedurais ainda não têm paridade com uBlock Origin.', 'filter-help', settings);
  const save = html('button', 'Salvar filtros', 'save', settings);
  const feedback = html('div', '', 'feedback');
  const status = html('p', '', 'status', feedback);
  status.setAttribute('role', 'status');
  const error = html('p', '', 'error', feedback);
  error.setAttribute('role', 'alert');
  const footer = html('footer', '', 'footer');
  const listsButton = html('button', 'Listas de filtros', 'lists-toggle', footer);
  listsButton.addEventListener('click', () => showView('lists-view'));
  const settingsButton = html('button', 'Configurações globais', 'settings', footer);
  settingsButton.addEventListener('click', () => showView('settings-view'));
  const scope = html('p', 'Apenas o motor nativo. O uBlock Origin continua independente: desativar aqui não desativa a extensão.', 'scope');
  const close = html('button', 'Fechar', 'close', scope);
  close.addEventListener('click', () => panel.hidePopup());
  let baseline = '', siteURL = '', busy = false;
  const isPrivate = win.PrivateBrowsingUtils.isWindowPrivate(win);
  const refresh = () => {
    const key = service.siteKey(siteURL);
    const localEnabled = service.siteEnabled(siteURL, isPrivate);
    const enabled = service.enabled();
    domain.textContent = key || 'Esta aba';
    domain.title = key || '';
    site.disabled = !key || busy;
    site.setAttribute('aria-checked', String(localEnabled));
    siteStatus.textContent = !key ? 'Sem site HTTP(S) nesta aba' : !enabled ? 'Proteção global desativada' : localEnabled ? 'Proteção nativa ativada neste site' : 'Proteção nativa desativada neste site';
    siteScope.textContent = isPrivate ? 'Exceção apenas nesta sessão privada e neste endereço de domínio, sem incluir subdomínios.' : 'A escolha vale apenas para este endereço de domínio, sem incluir subdomínios.';
    global.setAttribute('aria-checked', String(enabled));
    ghostSite.disabled = !ghost.origin(siteURL);
    ghostSite.setAttribute('aria-checked', String(ghost.siteEnabled(siteURL, isPrivate)));
    ghostGlobal.checked = ghost.enabled();
    for (const [name, input] of ghostInputs) input.checked = win.Services.prefs.getBoolPref('argon.ghostprint.' + name, true);
    summaryTitle.textContent = enabled ? 'Motor nativo ativo' : 'Motor nativo desativado';
    const count = service.manifest.lists.filter(list => !service.config.disabledLists.includes(list.id)).length;
    summaryDetail.textContent = `${count} de ${service.manifest.lists.length} listas selecionadas`;
  };
  const run = async task => {
    if (busy) return;
    busy = true;
    error.textContent = ''; status.textContent = '';
    const controls = [site, global, save, ...listBox.querySelectorAll('input')];
    controls.forEach(control => { control.disabled = true; });
    try { await task(); status.textContent = 'Salvo. Recarregue a aba para aplicar os filtros visuais.'; }
    catch (e) { error.textContent = formatProtectionError(e); }
    finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      for (const input of listBox.querySelectorAll('input')) input.checked = !service.config.disabledLists.includes(input.dataset.listId);
      refresh();
    }
  };
  ghostSite.addEventListener('click', () => { ghost.setSite(siteURL, !ghost.siteEnabled(siteURL, isPrivate), isPrivate); status.textContent = 'Salvo. Recarregue a aba para aplicar GhostPrint.'; refresh(); });
  const readGhostStatus = async browser => {
    ghostStatus.textContent = 'Verificando instalação nesta página…'; ghostDetails.textContent = '';
    try {
      await ghost.ready;
      const result = await browser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status');
      if (browser !== win.gBrowser.selectedBrowser || panel.state === 'closed' || panel.state === 'hiding') return;
      const states = { installed: 'Hooks instalados nesta página (não garantem anonimato)', disabled: 'GhostPrint desativado nesta página', 'gecko-protection-conflict': 'RFP/FPP do Gecko ativo: GhostPrint não foi sobreposto', unavailable: 'GhostPrint indisponível', failed: 'Falha ao instalar GhostPrint', 'not-installed': 'Não instalado nesta página; recarregue', 'unsupported-origin': 'Contexto não suportado' };
      ghostStatus.textContent = states[result.state] || 'GhostPrint indisponível';
      const labels = { installed: 'instalado', unavailable: 'API indisponível', disabled: 'desativado', failed: 'falha' };
      ghostDetails.textContent = Object.entries(result.surfaces || {}).map(([name, state]) => `${surfaceLabels[name]}: ${labels[state] || 'desconhecido'}`).join(' · ');
    } catch { ghostStatus.textContent = 'GhostPrint indisponível nesta página; recarregue um site HTTP(S).'; }
  };
  site.addEventListener('click', () => run(() => service.setSite(siteURL, !service.siteEnabled(siteURL, isPrivate), isPrivate)));
  global.addEventListener('click', () => { win.Services.prefs.setBoolPref('argon.adblock.enabled', !service.enabled()); refresh(); });
  save.addEventListener('click', () => {
    const value = editor.value, expected = baseline;
    run(async () => { await service.saveFilters(value, expected); baseline = value; });
  });
  const refreshLists = () => {
    listBox.replaceChildren();
    for (const list of service.manifest.lists) {
      const label = html('label', '', null, listBox);
      html('span', list.title || list.id, null, label);
      const input = html('input', '', 'list-' + list.id, label);
      input.type = 'checkbox';
      input.dataset.listId = list.id;
      input.checked = !service.config.disabledLists.includes(list.id);
      input.addEventListener('change', () => {
        const checked = input.checked;
        run(() => service.change(config => { config.disabledLists = config.disabledLists.filter(id => id !== list.id); if (!checked) config.disabledLists.push(list.id); }));
      });
    }
  };
  panel.addEventListener('popupshown', () => (site.disabled ? advancedToggle : site).focus());
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { panel.hidePopup(); event.preventDefault(); }
    if (event.key === 'Tab') {
      const controls = [...body.querySelectorAll('button, input, textarea, summary')].filter(node => !node.disabled && node.getClientRects().length && (!node.closest('details') || node.tagName.toLowerCase() === 'summary' || node.closest('details').open));
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
    service.ready.then(() => { refresh(); refreshLists(); baseline = editor.value = service.config.filters; }).catch(e => { error.textContent = formatProtectionError(e); });
  });
  doc.getElementById('mainPopupSet').append(panel);
  doc.getElementById('nav-bar').insertBefore(button, doc.getElementById('nav-bar-overflow-button'));
}
