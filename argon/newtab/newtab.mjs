// SPDX-License-Identifier: MIT

import {
  createNewTabController,
  isLikelyUrlInput,
  normalizeShortcutUrl,
} from "./newtab-state.mjs";

async function loadNewTabDependencies() {
  const candidates = [
    ["./appearance.mjs", "./customization.mjs", "./i18n.mjs"],
    [
      "../preferences/appearance.mjs",
      "../design-system/customization.mjs",
      "../i18n.mjs",
    ],
  ];
  let lastError;
  for (const urls of candidates) {
    try {
      const [appearance, customization, i18n] = await Promise.all(
        urls.map((url) => import(/* @vite-ignore */ url))
      );
      return { appearance, customization, i18n };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function resolveNewTabEnv(win = globalThis.window) {
  let services =
    win?.Services ??
    globalThis.Services ??
    win?.browsingContext?.topChromeWindow?.Services ??
    null;

  if (!services) {
    const cu =
      win?.ChromeUtils ??
      globalThis.ChromeUtils ??
      win?.browsingContext?.topChromeWindow?.ChromeUtils ??
      null;
    if (typeof cu?.importESModule === "function") {
      try {
        services =
          cu.importESModule("resource://gre/modules/Services.sys.mjs")
            ?.Services ?? null;
      } catch {
        services = null;
      }
    }
  }

  const topChromeWindow =
    win?.browsingContext?.topChromeWindow ??
    win?.docShell?.chromeEventHandler?.ownerGlobal ??
    services?.wm?.getMostRecentBrowserWindow?.() ??
    services?.wm?.getMostRecentWindow?.("navigator:browser") ??
    null;

  return {
    services,
    prefs: services?.prefs ?? null,
    search: services?.search ?? null,
    topChromeWindow,
  };
}

function readBoolPref(prefs, key, fallback) {
  if (!prefs?.getBoolPref) return fallback;
  try {
    return Boolean(prefs.getBoolPref(key, fallback));
  } catch {
    try {
      return Boolean(prefs.getBoolPref(key));
    } catch {
      return fallback;
    }
  }
}

function readStringPref(prefs, key, fallback) {
  if (!prefs?.getStringPref) return fallback;
  try {
    const val = prefs.getStringPref(key, fallback);
    return val !== undefined && val !== null ? String(val) : fallback;
  } catch {
    try {
      const val = prefs.getStringPref(key);
      return val !== undefined && val !== null ? String(val) : fallback;
    } catch {
      return fallback;
    }
  }
}

function getHostname(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname || parsed.protocol).replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getMonogram(title, url) {
  const source = String(title || getHostname(url) || "A").trim();
  const match = /[A-Za-z0-9]/.exec(source);
  return (match ? match[0] : "A").toUpperCase();
}

function parseWorkspacesSnapshot(prefs, topChromeWindow) {
  if (topChromeWindow?.ArgonWorkspaces?.getState) {
    return topChromeWindow.ArgonWorkspaces.getState();
  }
  let list = [
    { id: "general", name: "General", color: "#6478f5" },
    { id: "work", name: "Work", color: "#10b981" },
    { id: "personal", name: "Personal", color: "#f59e0b" },
  ];
  const rawList = readStringPref(prefs, "argon.workspaces.list", "");
  if (rawList) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed) && parsed.length) {
        list = parsed;
      }
    } catch {}
  }
  const activeId = readStringPref(prefs, "argon.workspaces.active", list[0].id);
  const activeWorkspace = list.find((w) => w.id === activeId) ?? list[0];
  return {
    enabled: readBoolPref(prefs, "argon.workspaces.enabled", true),
    activeId: activeWorkspace?.id ?? "general",
    activeWorkspace,
    workspaces: list.map((w) => ({ ...w, active: w.id === activeWorkspace?.id })),
  };
}

function readShieldStatus(prefs) {
  const adblock = readBoolPref(prefs, "argon.adblock.enabled", true);
  const afpPref = readStringPref(prefs, "argon.antifingerprint.engine", "");
  const ghost = readBoolPref(prefs, "argon.ghostprint.enabled", true);
  const rfp = readBoolPref(prefs, "privacy.resistFingerprinting", false);
  let afp = afpPref;
  if (!afp) {
    if (ghost && rfp) afp = "both";
    else if (rfp) afp = "firefox";
    else if (ghost) afp = "ghostprint";
    else afp = "off";
  }
  const httpsOnly = readBoolPref(prefs, "dom.security.https_only_mode", true);
  const dnsProvider = readStringPref(prefs, "argon.dns.provider", "system");
  return { adblock, afp, httpsOnly, dnsProvider };
}

function formatDnsLabel(providerId, loc) {
  const isPt = String(loc || "").startsWith("pt");
  switch (providerId) {
    case "cloudflare":
      return "Cloudflare";
    case "quad9":
      return "Quad9";
    case "nextdns":
      return "NextDNS";
    case "mullvad":
      return "Mullvad";
    case "adguard":
      return "AdGuard";
    case "custom":
      return isPt ? "Personalizado" : "Custom DoH";
    default:
      return isPt ? "Sistema" : "System";
  }
}

function formatAfpLabel(engine, loc) {
  const isPt = String(loc || "").startsWith("pt");
  switch (engine) {
    case "both":
      return isPt ? "Combinado" : "Combined";
    case "firefox":
      return "Firefox RFP";
    case "off":
      return isPt ? "Desativado" : "Off";
    default:
      return "GhostPrint";
  }
}

export async function mountArgonNewTab(doc = document, win = window) {
  if (!doc || !win) return null;

  const {
    appearance: { APPEARANCE, normalizeTheme },
    customization: {
      CUSTOMIZATION_DEFAULTS,
      CUSTOMIZATION_PREFS,
      applyCustomizationToElement,
      normalizeAccentColor,
      normalizeCornerRadius,
      normalizeDensity,
    },
    i18n: { applyToDOM, resolveLocale, t },
  } = await loadNewTabDependencies();

  const { prefs, search, topChromeWindow } = resolveNewTabEnv(win);
  const controller = createNewTabController({ preferences: prefs });

  const media = win.matchMedia?.("(prefers-color-scheme: dark)") ?? {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };

  const syncAppearanceTokens = () => {
    const themePref = normalizeTheme(
      readStringPref(prefs, APPEARANCE.prefs.theme, APPEARANCE.defaults.theme)
    );
    const effective =
      themePref === "system" ? (media.matches ? "dark" : "light") : themePref;
    doc.documentElement.setAttribute("data-argon-theme", themePref);
    doc.documentElement.setAttribute("data-argon-color-scheme", effective);

    applyCustomizationToElement(doc.documentElement, {
      density: normalizeDensity(
        readStringPref(
          prefs,
          CUSTOMIZATION_PREFS.density,
          CUSTOMIZATION_DEFAULTS.density
        )
      ),
      accent: normalizeAccentColor(
        readStringPref(
          prefs,
          CUSTOMIZATION_PREFS.accent,
          CUSTOMIZATION_DEFAULTS.accent
        )
      ),
      cornerRadius: normalizeCornerRadius(
        readStringPref(
          prefs,
          CUSTOMIZATION_PREFS.cornerRadius,
          CUSTOMIZATION_DEFAULTS.cornerRadius
        )
      ),
    });

    const loc = resolveLocale(null, win);
    applyToDOM(doc, loc);
  };

  // DOM References
  const clockSection = doc.getElementById("newtab-clock-widget");
  const clockTimeEl = doc.getElementById("newtab-clock-time");
  const clockDateEl = doc.getElementById("newtab-clock-date");
  const greetingEl = doc.getElementById("newtab-greeting");

  const searchSection = doc.getElementById("newtab-search-section");
  const searchForm = doc.getElementById("newtab-search-form");
  const searchInput = doc.getElementById("newtab-search-input");
  const searchBadge = doc.getElementById("newtab-search-engine-badge");

  const shortcutsSection = doc.getElementById("newtab-shortcuts-section");
  const shortcutsGrid = doc.getElementById("newtab-shortcuts-grid");
  const addShortcutBtn = doc.getElementById("newtab-add-shortcut-btn");

  const widgetsGrid = doc.getElementById("newtab-widgets-grid");
  const shieldCard = doc.getElementById("newtab-widget-shield");
  const workspacesCard = doc.getElementById("newtab-widget-workspaces");
  const notesCard = doc.getElementById("newtab-widget-notes");
  const notesInput = doc.getElementById("newtab-notes-input");

  const shieldAdblockEl = doc.getElementById("newtab-shield-adblock");
  const shieldAfpEl = doc.getElementById("newtab-shield-afp");
  const shieldHttpsEl = doc.getElementById("newtab-shield-https");
  const shieldDnsEl = doc.getElementById("newtab-shield-dns");

  const workspacesListEl = doc.getElementById("newtab-workspaces-list");
  const activeWsPill = doc.getElementById("newtab-active-workspace-pill");
  const activeWsDot = doc.getElementById("newtab-active-workspace-dot");
  const activeWsName = doc.getElementById("newtab-active-workspace-name");

  const customizeBtn = doc.getElementById("newtab-customize-btn");
  const settingsBtn = doc.getElementById("newtab-settings-btn");
  const customizeDrawer = doc.getElementById("newtab-customize-drawer");
  const drawerCloseBtn = doc.getElementById("newtab-drawer-close");

  const optSearch = doc.getElementById("newtab-opt-search");
  const optShortcuts = doc.getElementById("newtab-opt-shortcuts");
  const optClock = doc.getElementById("newtab-opt-clock");
  const optClock24h = doc.getElementById("newtab-opt-clock24h");
  const optShield = doc.getElementById("newtab-opt-shield");
  const optWorkspaces = doc.getElementById("newtab-opt-workspaces");
  const optNotes = doc.getElementById("newtab-opt-notes");
  const resetShortcutsBtn = doc.getElementById("newtab-reset-shortcuts-btn");
  const resetAllBtn = doc.getElementById("newtab-reset-all-btn");
  const openHomePrefsBtn = doc.getElementById("newtab-open-home-prefs-btn");
  const shieldSettingsLink = doc.getElementById("newtab-shield-settings-link");
  const workspacesSettingsLink = doc.getElementById(
    "newtab-workspaces-settings-link"
  );

  const modalBackdrop = doc.getElementById("newtab-shortcut-modal");
  const modalForm = doc.getElementById("newtab-shortcut-form");
  const modalTitle = doc.getElementById("newtab-modal-title");
  const modalTitleInput = doc.getElementById("newtab-shortcut-title-input");
  const modalUrlInput = doc.getElementById("newtab-shortcut-url-input");
  const modalError = doc.getElementById("newtab-shortcut-error");
  const modalCancelBtn = doc.getElementById("newtab-shortcut-cancel");

  let editingShortcutId = null;

  const openPrefsSection = (section) => {
    if (typeof topChromeWindow?.ArgonAppearance?.openSettings === "function") {
      topChromeWindow.ArgonAppearance.openSettings(section);
      return;
    }
    if (typeof topChromeWindow?.openPreferences === "function") {
      topChromeWindow.openPreferences(section);
      return;
    }
    win.location.assign(
      section ? `about:preferences#${section}` : "about:preferences"
    );
  };

  const navigateCurrentTab = (url) => {
    if (typeof topChromeWindow?.openTrustedLinkIn === "function") {
      topChromeWindow.openTrustedLinkIn(url, "current");
      return;
    }
    win.location.assign(url);
  };

  const resolveActiveSearchEngine = async () => {
    const selectedFallback = readStringPref(
      prefs,
      "argon.search.selected",
      "DuckDuckGo"
    );
    if (search) {
      try {
        await search.init?.();
        const engine =
          (await search.getDefault?.()) ?? search.defaultEngine ?? null;
        if (engine) return engine;
      } catch {}
    }
    return {
      name: selectedFallback || "DuckDuckGo",
      getSubmission: (query) => ({
        uri: {
          spec: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        },
      }),
    };
  };

  const updateSearchBadge = async () => {
    const engine = await resolveActiveSearchEngine();
    if (searchBadge) {
      searchBadge.textContent = engine?.name || "DuckDuckGo";
    }
  };

  const renderClock = () => {
    const state = controller.getState();
    const loc = resolveLocale(null, win);
    const now = new Date();
    const hour = now.getHours();

    if (clockTimeEl) {
      try {
        clockTimeEl.textContent = now.toLocaleTimeString(loc || undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: !state.clock24h,
        });
      } catch {
        const hh = String(
          state.clock24h ? hour : hour % 12 || 12
        ).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const suffix = state.clock24h ? "" : hour >= 12 ? " PM" : " AM";
        clockTimeEl.textContent = `${hh}:${mm}${suffix}`;
      }
    }

    if (clockDateEl) {
      try {
        clockDateEl.textContent = now.toLocaleDateString(loc || undefined, {
          weekday: "long",
          month: "short",
          day: "numeric",
        });
      } catch {
        clockDateEl.textContent = now.toDateString();
      }
    }

    if (greetingEl) {
      let key = "newtab.greeting.evening";
      if (hour >= 5 && hour < 12) key = "newtab.greeting.morning";
      else if (hour >= 12 && hour < 18) key = "newtab.greeting.afternoon";
      greetingEl.textContent = t(key, null, loc);
    }
  };

  const openShortcutModal = (shortcut = null) => {
    const loc = resolveLocale(null, win);
    editingShortcutId = shortcut?.id ?? null;
    if (modalTitle) {
      modalTitle.textContent = t(
        shortcut ? "newtab.editShortcutTitle" : "newtab.addShortcutTitle",
        null,
        loc
      );
    }
    if (modalTitleInput) modalTitleInput.value = shortcut?.title ?? "";
    if (modalUrlInput) modalUrlInput.value = shortcut?.url ?? "";
    if (modalError) {
      modalError.hidden = true;
      modalError.textContent = "";
    }
    if (modalBackdrop) modalBackdrop.hidden = false;
    modalTitleInput?.focus?.();
  };

  const closeShortcutModal = () => {
    editingShortcutId = null;
    if (modalBackdrop) modalBackdrop.hidden = true;
  };

  const renderShortcuts = (shortcuts) => {
    if (!shortcutsGrid) return;
    const loc = resolveLocale(null, win);
    shortcutsGrid.replaceChildren();

    if (!shortcuts.length) {
      const empty = doc.createElement("div");
      empty.className = "newtab-shortcuts-empty";
      empty.textContent = t("newtab.noShortcuts", null, loc);
      shortcutsGrid.append(empty);
      return;
    }

    for (const item of shortcuts) {
      const tile = doc.createElement("div");
      tile.className = "newtab-shortcut-tile";
      tile.setAttribute("role", "listitem");
      tile.dataset.shortcutId = item.id;

      const link = doc.createElement("a");
      link.className = "newtab-shortcut-link";
      link.href = item.url;
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        navigateCurrentTab(item.url);
      });

      const avatar = doc.createElement("span");
      avatar.className = "newtab-shortcut-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = getMonogram(item.title, item.url);

      const meta = doc.createElement("span");
      meta.className = "newtab-shortcut-meta";

      const title = doc.createElement("span");
      title.className = "newtab-shortcut-title";
      title.textContent = item.title;

      const host = doc.createElement("span");
      host.className = "newtab-shortcut-host";
      host.textContent = getHostname(item.url);

      meta.append(title, host);
      link.append(avatar, meta);

      const actions = doc.createElement("div");
      actions.className = "newtab-shortcut-actions";

      const editBtn = doc.createElement("button");
      editBtn.type = "button";
      editBtn.className = "newtab-tile-action-btn";
      editBtn.title = t("newtab.edit", null, loc);
      editBtn.setAttribute("aria-label", `${t("newtab.edit", null, loc)} ${item.title}`);
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openShortcutModal(item);
      });

      const removeBtn = doc.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "newtab-tile-action-btn";
      removeBtn.title = t("newtab.remove", null, loc);
      removeBtn.setAttribute(
        "aria-label",
        `${t("newtab.remove", null, loc)} ${item.title}`
      );
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.removeShortcut(item.id);
      });

      actions.append(editBtn, removeBtn);
      tile.append(link, actions);
      shortcutsGrid.append(tile);
    }
  };

  const renderShield = () => {
    const loc = resolveLocale(null, win);
    const shield = readShieldStatus(prefs);
    if (shieldAdblockEl) {
      shieldAdblockEl.textContent = shield.adblock
        ? t("newtab.status.active", null, loc)
        : t("newtab.status.paused", null, loc);
      shieldAdblockEl.dataset.state = shield.adblock ? "on" : "off";
    }
    if (shieldAfpEl) {
      shieldAfpEl.textContent = formatAfpLabel(shield.afp, loc);
      shieldAfpEl.dataset.state = shield.afp === "off" ? "off" : "on";
    }
    if (shieldHttpsEl) {
      shieldHttpsEl.textContent = shield.httpsOnly
        ? t("newtab.status.on", null, loc)
        : t("newtab.status.off", null, loc);
      shieldHttpsEl.dataset.state = shield.httpsOnly ? "on" : "off";
    }
    if (shieldDnsEl) {
      shieldDnsEl.textContent = formatDnsLabel(shield.dnsProvider, loc);
      shieldDnsEl.dataset.state = shield.dnsProvider === "system" ? "off" : "on";
    }
  };

  const renderWorkspaces = () => {
    const snap = parseWorkspacesSnapshot(prefs, topChromeWindow);
    if (activeWsPill) {
      activeWsPill.hidden = !snap.enabled || !snap.activeWorkspace;
      if (activeWsDot && snap.activeWorkspace?.color) {
        activeWsDot.style.backgroundColor = snap.activeWorkspace.color;
      }
      if (activeWsName && snap.activeWorkspace?.name) {
        activeWsName.textContent = snap.activeWorkspace.name;
      }
    }
    if (!workspacesListEl) return;
    workspacesListEl.replaceChildren();
    for (const ws of snap.workspaces) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "newtab-workspace-chip";
      btn.dataset.workspaceId = ws.id;
      btn.setAttribute("aria-pressed", String(Boolean(ws.active)));

      const dot = doc.createElement("span");
      dot.className = "newtab-ws-dot";
      dot.style.backgroundColor = ws.color || "#6478f5";

      const label = doc.createElement("span");
      label.textContent = ws.name;

      btn.append(dot, label);
      btn.addEventListener("click", () => {
        if (topChromeWindow?.ArgonWorkspaces?.setActiveWorkspace) {
          topChromeWindow.ArgonWorkspaces.setActiveWorkspace(ws.id);
        } else {
          prefs?.setStringPref?.("argon.workspaces.active", ws.id);
        }
        renderWorkspaces();
      });
      workspacesListEl.append(btn);
    }
  };

  const renderState = (state = controller.getState()) => {
    if (clockSection) clockSection.hidden = !state.widgets.clock;
    if (searchSection) searchSection.hidden = !state.showSearch;
    if (shortcutsSection) shortcutsSection.hidden = !state.showShortcuts;

    if (shieldCard) shieldCard.hidden = !state.widgets.shield;
    if (workspacesCard) workspacesCard.hidden = !state.widgets.workspaces;
    if (notesCard) notesCard.hidden = !state.widgets.notes;
    if (widgetsGrid) {
      widgetsGrid.hidden =
        !state.widgets.shield && !state.widgets.workspaces && !state.widgets.notes;
    }

    if (notesInput && notesInput.value !== state.notes) {
      notesInput.value = state.notes;
    }

    if (optSearch) optSearch.checked = state.showSearch;
    if (optShortcuts) optShortcuts.checked = state.showShortcuts;
    if (optClock) optClock.checked = state.widgets.clock;
    if (optClock24h) optClock24h.checked = state.clock24h;
    if (optShield) optShield.checked = state.widgets.shield;
    if (optWorkspaces) optWorkspaces.checked = state.widgets.workspaces;
    if (optNotes) optNotes.checked = state.widgets.notes;

    const loc = resolveLocale(null, win);
    if (searchInput) {
      searchInput.placeholder = t("newtab.searchPlaceholder", null, loc);
    }
    if (notesInput) {
      notesInput.placeholder = t("newtab.notesPlaceholder", null, loc);
    }

    renderClock();
    renderShortcuts(state.shortcuts);
    renderShield();
    renderWorkspaces();
  };

  // Event bindings
  searchForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = String(searchInput?.value || "").trim();
    if (!raw) return;
    if (isLikelyUrlInput(raw)) {
      try {
        navigateCurrentTab(normalizeShortcutUrl(raw));
        return;
      } catch {}
    }
    const engine = await resolveActiveSearchEngine();
    const submission = engine?.getSubmission?.(raw);
    const targetUrl =
      submission?.uri?.spec ??
      `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
    navigateCurrentTab(targetUrl);
  });

  addShortcutBtn?.addEventListener("click", () => openShortcutModal(null));
  modalCancelBtn?.addEventListener("click", closeShortcutModal);
  modalBackdrop?.addEventListener("mousedown", (event) => {
    if (event.target === modalBackdrop) closeShortcutModal();
  });

  modalForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = modalTitleInput?.value ?? "";
    const url = modalUrlInput?.value ?? "";
    try {
      if (editingShortcutId) {
        controller.updateShortcut(editingShortcutId, { title, url });
      } else {
        controller.addShortcut({ title, url });
      }
      closeShortcutModal();
    } catch (err) {
      if (modalError) {
        modalError.hidden = false;
        modalError.textContent = err?.message || "Invalid URL";
      }
    }
  });

  const setDrawerOpen = (open) => {
    if (!customizeDrawer) return;
    customizeDrawer.hidden = !open;
    customizeBtn?.setAttribute("aria-expanded", String(open));
  };

  customizeBtn?.addEventListener("click", () => {
    setDrawerOpen(Boolean(customizeDrawer?.hidden));
  });
  drawerCloseBtn?.addEventListener("click", () => setDrawerOpen(false));

  settingsBtn?.addEventListener("click", () => openPrefsSection("home"));
  openHomePrefsBtn?.addEventListener("click", () => openPrefsSection("home"));
  shieldSettingsLink?.addEventListener("click", () => openPrefsSection("privacy"));
  workspacesSettingsLink?.addEventListener("click", () =>
    openPrefsSection("workspaces")
  );

  activeWsPill?.addEventListener("click", () => {
    const snap = parseWorkspacesSnapshot(prefs, topChromeWindow);
    if (!snap.workspaces.length) return;
    const idx = snap.workspaces.findIndex((w) => w.id === snap.activeId);
    const next = snap.workspaces[(idx + 1) % snap.workspaces.length];
    if (next) {
      if (topChromeWindow?.ArgonWorkspaces?.setActiveWorkspace) {
        topChromeWindow.ArgonWorkspaces.setActiveWorkspace(next.id);
      } else {
        prefs?.setStringPref?.("argon.workspaces.active", next.id);
      }
      renderWorkspaces();
    }
  });

  optSearch?.addEventListener("change", () =>
    controller.setShowSearch(optSearch.checked)
  );
  optShortcuts?.addEventListener("change", () =>
    controller.setShowShortcuts(optShortcuts.checked)
  );
  optClock?.addEventListener("change", () =>
    controller.setWidgetEnabled("clock", optClock.checked)
  );
  optClock24h?.addEventListener("change", () =>
    controller.setClock24h(optClock24h.checked)
  );
  optShield?.addEventListener("change", () =>
    controller.setWidgetEnabled("shield", optShield.checked)
  );
  optWorkspaces?.addEventListener("change", () =>
    controller.setWidgetEnabled("workspaces", optWorkspaces.checked)
  );
  optNotes?.addEventListener("change", () =>
    controller.setWidgetEnabled("notes", optNotes.checked)
  );

  notesInput?.addEventListener("input", () => {
    controller.setNotes(notesInput.value);
  });

  resetShortcutsBtn?.addEventListener("click", () =>
    controller.resetShortcuts()
  );
  resetAllBtn?.addEventListener("click", () => controller.resetDefaults());

  win.addEventListener?.("keydown", (event) => {
    if (event.key === "Escape") {
      if (modalBackdrop && !modalBackdrop.hidden) {
        closeShortcutModal();
      } else if (customizeDrawer && !customizeDrawer.hidden) {
        setDrawerOpen(false);
      }
    }
  });

  // Observers for live updates from chrome / preferences
  const chromePrefObserver = {
    observe() {
      syncAppearanceTokens();
      renderShield();
      renderWorkspaces();
      updateSearchBadge();
    },
  };
  for (const prefix of [
    "argon.theme",
    "argon.ui.",
    "argon.locale",
    "argon.adblock.",
    "argon.antifingerprint.",
    "argon.ghostprint.",
    "argon.dns.",
    "argon.workspaces.",
    "argon.search.",
    "dom.security.https_only_mode",
    "privacy.resistFingerprinting",
  ]) {
    try {
      prefs?.addObserver?.(prefix, chromePrefObserver);
    } catch {}
  }

  media.addEventListener?.("change", syncAppearanceTokens);

  const unsubscribeController = controller.onChange((nextState) => {
    renderState(nextState);
  });

  const clockInterval = win.setInterval?.(renderClock, 15000) ?? null;

  syncAppearanceTokens();
  renderState();
  updateSearchBadge();

  doc.documentElement.dataset.argonNewtabReady = "true";

  const api = {
    controller,
    dispose() {
      unsubscribeController();
      controller.dispose();
      media.removeEventListener?.("change", syncAppearanceTokens);
      if (clockInterval !== null) {
        win.clearInterval?.(clockInterval);
      }
      for (const prefix of [
        "argon.theme",
        "argon.ui.",
        "argon.locale",
        "argon.adblock.",
        "argon.antifingerprint.",
        "argon.ghostprint.",
        "argon.dns.",
        "argon.workspaces.",
        "argon.search.",
        "dom.security.https_only_mode",
        "privacy.resistFingerprinting",
      ]) {
        try {
          prefs?.removeObserver?.(prefix, chromePrefObserver);
        } catch {}
      }
    },
  };

  win.ArgonNewTab = api;
  win.addEventListener?.("unload", () => api.dispose(), { once: true });
  return api;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        mountArgonNewTab(document, window);
      },
      { once: true }
    );
  } else {
    mountArgonNewTab(document, window);
  }
}
