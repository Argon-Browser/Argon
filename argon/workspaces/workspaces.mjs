// SPDX-License-Identifier: MIT

export const WORKSPACES_PREFS = Object.freeze({
  enabled: "argon.workspaces.enabled",
  active: "argon.workspaces.active",
  list: "argon.workspaces.list",
  autoUnload: "argon.tabs.autoUnload",
});

export const DEFAULT_WORKSPACES = Object.freeze([
  Object.freeze({
    id: "general",
    name: "General",
    color: "#6478f5",
  }),
  Object.freeze({
    id: "work",
    name: "Work",
    color: "#10b981",
  }),
  Object.freeze({
    id: "personal",
    name: "Personal",
    color: "#f59e0b",
  }),
]);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function slugifyId(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base || "workspace";
}

export function normalizeWorkspacesList(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return DEFAULT_WORKSPACES.map((item) => ({ ...item }));
  }

  const seenIds = new Set();
  const normalized = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name || "").trim();
    if (!name) continue;
    const id = String(entry.id || slugifyId(name)).trim().toLowerCase();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const color =
      typeof entry.color === "string" && HEX_COLOR_RE.test(entry.color.trim())
        ? entry.color.trim().toLowerCase()
        : "#6478f5";
    normalized.push({ id, name: name.slice(0, 40), color });
  }

  if (normalized.length === 0) {
    return DEFAULT_WORKSPACES.map((item) => ({ ...item }));
  }
  return normalized;
}

function readStringPref(preferences, key, fallback) {
  if (!preferences?.getStringPref) return fallback;
  try {
    return preferences.getStringPref(key, fallback);
  } catch {
    try {
      return preferences.getStringPref(key);
    } catch {
      return fallback;
    }
  }
}

function readBoolPref(preferences, key, fallback) {
  if (!preferences?.getBoolPref) return fallback;
  try {
    return Boolean(preferences.getBoolPref(key, fallback));
  } catch {
    try {
      return Boolean(preferences.getBoolPref(key));
    } catch {
      return fallback;
    }
  }
}

export function createWorkspacesController({
  preferences = null,
  sessionStore = null,
  gBrowser = null,
  onChange = null,
} = {}) {
  let disposed = false;

  const loadWorkspaces = () =>
    normalizeWorkspacesList(
      readStringPref(
        preferences,
        WORKSPACES_PREFS.list,
        JSON.stringify(DEFAULT_WORKSPACES)
      )
    );

  let workspaces = loadWorkspaces();

  const resolveActiveId = (candidateId) => {
    const target = String(
      candidateId ??
        readStringPref(
          preferences,
          WORKSPACES_PREFS.active,
          workspaces[0]?.id ?? "general"
        )
    )
      .trim()
      .toLowerCase();
    return workspaces.some((ws) => ws.id === target)
      ? target
      : workspaces[0].id;
  };

  let activeId = resolveActiveId();
  let enabled = readBoolPref(preferences, WORKSPACES_PREFS.enabled, true);
  let autoUnload = readBoolPref(
    preferences,
    WORKSPACES_PREFS.autoUnload,
    false
  );

  const persistWorkspaces = () => {
    preferences?.setStringPref?.(
      WORKSPACES_PREFS.list,
      JSON.stringify(workspaces)
    );
  };

  const persistActiveId = () => {
    preferences?.setStringPref?.(WORKSPACES_PREFS.active, activeId);
  };

  const getTabWorkspace = (tab) => {
    if (!tab) return activeId;
    let stored =
      tab.dataset?.argonWorkspace ??
      tab.getAttribute?.("data-argon-workspace") ??
      null;
    if (!stored && sessionStore?.getCustomTabValue) {
      try {
        stored = sessionStore.getCustomTabValue(tab, "argon-workspace") || null;
      } catch {
        stored = null;
      }
    }
    if (stored && workspaces.some((ws) => ws.id === stored)) {
      if (tab.dataset) tab.dataset.argonWorkspace = stored;
      tab.setAttribute?.("data-argon-workspace", stored);
      return stored;
    }
    assignTabToWorkspace(tab, activeId, { sync: false });
    return activeId;
  };

  const assignTabToWorkspace = (tab, workspaceId, { sync = true } = {}) => {
    if (!tab) return;
    const validId = workspaces.some((ws) => ws.id === workspaceId)
      ? workspaceId
      : activeId;
    if (tab.dataset) {
      tab.dataset.argonWorkspace = validId;
    }
    tab.setAttribute?.("data-argon-workspace", validId);
    if (sessionStore?.setCustomTabValue) {
      try {
        sessionStore.setCustomTabValue(tab, "argon-workspace", validId);
      } catch {
        // Ignore if tab is not yet registered in SessionStore.
      }
    }
    if (sync) {
      syncBrowserTabs();
      notify();
    }
  };

  const setTabVisibility = (tab, visible) => {
    if (!tab) return;
    if (visible) {
      if (typeof gBrowser?.showTab === "function") {
        try {
          gBrowser.showTab(tab);
          return;
        } catch {
          // Fallback to hidden property.
        }
      }
      tab.hidden = false;
    } else {
      if (typeof gBrowser?.hideTab === "function") {
        try {
          gBrowser.hideTab(tab);
          return;
        } catch {
          // Fallback to hidden property.
        }
      }
      tab.hidden = true;
    }
  };

  const syncBrowserTabs = () => {
    const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
    if (tabs.length === 0) return;

    if (!enabled) {
      for (const tab of tabs) {
        setTabVisibility(tab, true);
      }
      return;
    }

    const visibleInActive = [];
    for (const tab of tabs) {
      const wsId = getTabWorkspace(tab);
      const isPinned = Boolean(tab.pinned);
      const shouldShow = isPinned || wsId === activeId;
      if (shouldShow) {
        visibleInActive.push(tab);
      }
    }

    // Firefox requires at least one visible tab before hiding the currently
    // selected tab. Ensure a tab exists in the active workspace first.
    if (visibleInActive.length === 0 && typeof gBrowser?.addTrustedTab === "function") {
      try {
        const created = gBrowser.addTrustedTab("about:newtab");
        if (created) {
          assignTabToWorkspace(created, activeId, { sync: false });
          visibleInActive.push(created);
        }
      } catch {
        // Ignore if addTrustedTab is unavailable in test mocks.
      }
    }

    const selectedTab = gBrowser?.selectedTab ?? null;
    const selectedVisible =
      selectedTab &&
      (Boolean(selectedTab.pinned) || getTabWorkspace(selectedTab) === activeId);

    if (!selectedVisible && visibleInActive.length > 0 && gBrowser) {
      const preferredTab =
        visibleInActive.find(
          (tab) => !tab.pinned && getTabWorkspace(tab) === activeId
        ) ?? visibleInActive[0];
      setTabVisibility(preferredTab, true);
      try {
        gBrowser.selectedTab = preferredTab;
      } catch {
        // Ignore selection errors.
      }
    }

    for (const tab of tabs) {
      const isPinned = Boolean(tab.pinned);
      const wsId = getTabWorkspace(tab);
      const shouldShow = isPinned || wsId === activeId;
      setTabVisibility(tab, shouldShow);
    }

    if (autoUnload) {
      unloadInactiveWorkspaceTabs();
    }
  };

  const unloadInactiveWorkspaceTabs = () => {
    const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
    let unloadedCount = 0;
    for (const tab of tabs) {
      if (tab === gBrowser?.selectedTab) continue;
      if (tab.pinned || tab.soundPlaying || tab.sharing) continue;
      const wsId = getTabWorkspace(tab);
      if (wsId === activeId) continue;
      if (typeof gBrowser?.discardBrowser === "function") {
        try {
          gBrowser.discardBrowser(tab);
          unloadedCount += 1;
        } catch {
          // Ignore tabs that refuse discard.
        }
      } else if (tab.linkedpanel || !tab.hasAttribute?.("pending")) {
        tab.discarded = true;
        unloadedCount += 1;
      }
    }
    return unloadedCount;
  };

  const unloadBackgroundTabs = () => {
    const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
    let unloadedCount = 0;
    for (const tab of tabs) {
      if (tab === gBrowser?.selectedTab) continue;
      if (tab.pinned || tab.soundPlaying || tab.sharing) continue;
      if (typeof gBrowser?.discardBrowser === "function") {
        try {
          gBrowser.discardBrowser(tab);
          unloadedCount += 1;
        } catch {
          // Ignore tabs that refuse discard.
        }
      } else {
        tab.discarded = true;
        unloadedCount += 1;
      }
    }
    return unloadedCount;
  };

  const getTabCounts = () => {
    const counts = Object.fromEntries(workspaces.map((ws) => [ws.id, 0]));
    const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
    for (const tab of tabs) {
      if (tab.pinned) continue;
      const wsId = getTabWorkspace(tab);
      counts[wsId] = (counts[wsId] ?? 0) + 1;
    }
    return counts;
  };

  const getState = () => {
    const counts = getTabCounts();
    return {
      enabled,
      autoUnload,
      activeId,
      activeWorkspace:
        workspaces.find((ws) => ws.id === activeId) ?? workspaces[0],
      workspaces: workspaces.map((ws) => ({
        ...ws,
        tabCount: counts[ws.id] ?? 0,
        active: ws.id === activeId,
      })),
    };
  };

  const notify = () => {
    if (disposed) return;
    onChange?.(getState());
  };

  const observer = {
    observe(_subject, _topic, data) {
      if (disposed) return;
      const key = String(data || "");
      if (
        key &&
        !key.startsWith("argon.workspaces.") &&
        key !== WORKSPACES_PREFS.autoUnload
      ) {
        return;
      }
      workspaces = loadWorkspaces();
      activeId = resolveActiveId();
      enabled = readBoolPref(preferences, WORKSPACES_PREFS.enabled, true);
      autoUnload = readBoolPref(
        preferences,
        WORKSPACES_PREFS.autoUnload,
        false
      );
      syncBrowserTabs();
      notify();
    },
  };

  preferences?.addObserver?.("argon.workspaces.", observer);
  preferences?.addObserver?.(WORKSPACES_PREFS.autoUnload, observer);

  syncBrowserTabs();
  notify();

  return {
    get enabled() {
      return enabled;
    },
    get autoUnload() {
      return autoUnload;
    },
    get activeId() {
      return activeId;
    },
    get workspaces() {
      return workspaces.map((ws) => ({ ...ws }));
    },
    getState,
    getActiveWorkspace() {
      return {
        ...(workspaces.find((ws) => ws.id === activeId) ?? workspaces[0]),
      };
    },
    setActiveWorkspace(id) {
      const target = String(id || "").trim().toLowerCase();
      if (!workspaces.some((ws) => ws.id === target)) {
        throw new RangeError(`Unknown Argon workspace: ${id}`);
      }
      if (activeId === target) return getState();
      activeId = target;
      persistActiveId();
      syncBrowserTabs();
      notify();
      return getState();
    },
    switchByIndex(index) {
      if (index < 0 || index >= workspaces.length) return getState();
      return this.setActiveWorkspace(workspaces[index].id);
    },
    createWorkspace({ name, color = "#6478f5" } = {}) {
      const trimmedName = String(name || "").trim();
      if (!trimmedName) {
        throw new RangeError("Workspace name cannot be empty");
      }
      const validColor =
        typeof color === "string" && HEX_COLOR_RE.test(color.trim())
          ? color.trim().toLowerCase()
          : "#6478f5";
      const baseId = slugifyId(trimmedName);
      let candidateId = baseId;
      let suffix = 2;
      while (workspaces.some((ws) => ws.id === candidateId)) {
        candidateId = `${baseId}-${suffix}`;
        suffix += 1;
      }
      const entry = {
        id: candidateId,
        name: trimmedName.slice(0, 40),
        color: validColor,
      };
      workspaces = [...workspaces, entry];
      persistWorkspaces();
      notify();
      return entry;
    },
    renameWorkspace(id, nextName) {
      const trimmedName = String(nextName || "").trim();
      if (!trimmedName) {
        throw new RangeError("Workspace name cannot be empty");
      }
      const index = workspaces.findIndex((ws) => ws.id === id);
      if (index === -1) {
        throw new RangeError(`Unknown Argon workspace: ${id}`);
      }
      workspaces = workspaces.map((ws, i) =>
        i === index ? { ...ws, name: trimmedName.slice(0, 40) } : ws
      );
      persistWorkspaces();
      notify();
      return { ...workspaces[index] };
    },
    deleteWorkspace(id) {
      if (workspaces.length <= 1) {
        throw new RangeError("Cannot delete the last remaining workspace");
      }
      const exists = workspaces.some((ws) => ws.id === id);
      if (!exists) {
        throw new RangeError(`Unknown Argon workspace: ${id}`);
      }
      workspaces = workspaces.filter((ws) => ws.id !== id);
      const fallbackId =
        activeId === id ? workspaces[0].id : resolveActiveId(activeId);
      activeId = fallbackId;

      const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
      for (const tab of tabs) {
        const currentWs =
          tab.dataset?.argonWorkspace ??
          tab.getAttribute?.("data-argon-workspace");
        if (currentWs === id) {
          assignTabToWorkspace(tab, fallbackId, { sync: false });
        }
      }

      persistWorkspaces();
      persistActiveId();
      syncBrowserTabs();
      notify();
      return getState();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      preferences?.setBoolPref?.(WORKSPACES_PREFS.enabled, enabled);
      syncBrowserTabs();
      notify();
      return getState();
    },
    setAutoUnload(value) {
      autoUnload = Boolean(value);
      preferences?.setBoolPref?.(WORKSPACES_PREFS.autoUnload, autoUnload);
      if (autoUnload) {
        unloadInactiveWorkspaceTabs();
      }
      notify();
      return getState();
    },
    getTabWorkspace,
    assignTabToWorkspace,
    syncBrowserTabs,
    unloadInactiveWorkspaceTabs,
    unloadBackgroundTabs,
    dispose() {
      disposed = true;
      preferences?.removeObserver?.("argon.workspaces.", observer);
      preferences?.removeObserver?.(WORKSPACES_PREFS.autoUnload, observer);
    },
  };
}
