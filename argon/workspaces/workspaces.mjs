// SPDX-License-Identifier: MIT

export const WORKSPACES_PREFS = Object.freeze({
  enabled: "argon.workspaces.enabled",
  active: "argon.workspaces.active",
  list: "argon.workspaces.list",
  autoUnload: "argon.tabs.autoUnload",
  containers: "argon.workspaces.containers",
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
  contextualIdentities = null,
  isPrivate = false,
  getAllTabs = () => [...(gBrowser?.tabs || [])],
} = {}) {
  let disposed = false;
  const isolated = Boolean(contextualIdentities && gBrowser);
  let containers = {};
  const containerExists = (id) => {
    try {
      return Boolean(contextualIdentities.getPublicIdentityFromId(id));
    } catch {
      return false;
    }
  };
  const ensureContainers = () => {
    if (!isolated) return;
    if (!workspaces.some(ws => ws.id === 'general')) {
      workspaces = [{ ...DEFAULT_WORKSPACES[0] }, ...workspaces];
      persistWorkspaces();
    }
    try { containers = JSON.parse(readStringPref(preferences, WORKSPACES_PREFS.containers, '{}')); }
    catch { containers = {}; }
    if (!containers || typeof containers !== 'object' || Array.isArray(containers)) containers = {};
    let changed = false;
    const used = new Set();
    for (const ws of workspaces) {
      if (ws.id === 'general') {
        if (containers[ws.id] !== 0) { containers[ws.id] = 0; changed = true; }
        used.add(0);
        continue;
      }
      const current = containers[ws.id];
      const usable =
        Number.isSafeInteger(current) &&
        current > 0 &&
        !used.has(current) &&
        containerExists(current);
      if (usable) {
        used.add(current);
        continue;
      }
      // The container service can refuse to work in a restricted window, so a
      // failure must never take the whole browser window down.
      let identity = null;
      try {
        identity = contextualIdentities.create(`Argon: ${ws.name}`, 'briefcase', 'blue');
      } catch {
        identity = null;
      }
      if (!identity) {
        delete containers[ws.id];
        changed = true;
        continue;
      }
      containers[ws.id] = identity.userContextId;
      used.add(identity.userContextId);
      changed = true;
    }
    if (changed) preferences?.setStringPref?.(WORKSPACES_PREFS.containers, JSON.stringify(containers));
  };
  const contextOf = tab => Number(tab?.userContextId ?? tab?.getAttribute?.('usercontextid') ?? 0);
  const ownerOf = tab => workspaces.find(ws => containers[ws.id] === contextOf(tab))?.id;

  // Gecko reports the container as a string when it restores or duplicates a
  // session tab, and omits it when a link opens in a new tab. Decide the
  // container before the browser element exists so the first request already
  // carries the right storage principal.
  const containerForNewTab = (options = {}) => {
    const explicit = options.userContextId;
    if (explicit != null) return Number(explicit) || 0;
    const opener = options.openerBrowser;
    if (opener) return Number(opener.getAttribute?.('usercontextid') ?? 0);
    const inherited = options.openWindowInfo?.originAttributes?.userContextId;
    if (inherited != null) return Number(inherited) || 0;
    if (!enabled) return 0;
    return containers[activeId] ?? 0;
  };


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

  ensureContainers();

  const getTabWorkspace = (tab) => {
    if (!tab) return activeId;
    if (isolated) {
      const owner = ownerOf(tab);
      if (owner) { tagTab(tab, owner); return owner; }
      // Existing external containers belong to General, never to two workspaces.
      tagTab(tab, 'general');
      return 'general';
    }
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
    tagTab(tab, activeId);
    return activeId;
  };

  const tagTab = (tab, validId) => {
    if (tab.dataset) tab.dataset.argonWorkspace = validId;
    tab.setAttribute?.('data-argon-workspace', validId);
    try { sessionStore?.setCustomTabValue?.(tab, 'argon-workspace', validId); } catch {}
  };

  const assignTabToWorkspace = (tab, workspaceId, { sync = true } = {}) => {
    if (!tab) return;
    const validId = workspaces.some((ws) => ws.id === workspaceId)
      ? workspaceId
      : activeId;
    if (isolated && contextOf(tab) !== containers[validId]) {
      const url = tab.linkedBrowser?.currentURI?.spec || 'about:newtab';
      if (!/^(https?:|about:blank$|about:newtab$)/.test(url)) {
        throw new Error('This tab cannot be reopened in another workspace');
      }
      const replacement = gBrowser.addTrustedTab(url, {
        userContextId: containers[validId] ?? 0,
        inBackground: true,
      });
      tagTab(replacement, validId);
      if (tab.pinned) gBrowser.pinTab?.(replacement);
      if (tab === gBrowser.selectedTab) gBrowser.selectedTab = replacement;
      // Gecko retains its normal beforeunload handling. A cancelled close leaves
      // the original in its original workspace and container.
      gBrowser.removeTab(tab);
      if (sync) {
        // The tab now lives in the destination workspace, so follow it there.
        if (activeId !== validId) {
          activeId = validId;
          persistActiveId();
        }
        syncBrowserTabs();
        notify();
      }
      return replacement;
    }
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
    return tab;
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
      if (tab.ownerDocument) tab.removeAttribute('hidden');
      else tab.hidden = false;
    } else {
      if (typeof gBrowser?.hideTab === "function") {
        try {
          gBrowser.hideTab(tab);
          // Native hideTab refuses pinned tabs; workspace pins are local.
          if (isolated && tab.pinned && !tab.hidden && !tab.linkedBrowser?._sharingState?.webRTC?.sharing) {
            if (tab.ownerDocument) {
              tab.setAttribute('hidden', 'true');
              gBrowser.tabContainer?._invalidateCachedVisibleTabs?.();
              const event = tab.ownerDocument.createEvent('Events');
              event.initEvent('TabHide', true, false);
              tab.dispatchEvent(event);
            } else tab.hidden = true;
          }
          return;
        } catch {
          // Fallback to hidden property.
        }
      }
      if (tab.ownerDocument) tab.setAttribute('hidden', 'true');
      else tab.hidden = true;
    }
  };

  // Firefox closes a window when its last visible tab goes away and ignores
  // the tabs of the other workspaces because they are hidden. Switch to a
  // workspace that still holds tabs so the window survives the close.
  const keepWindowOpen = (tab) => {
    if (!enabled || !tab || tab.hidden) return;
    // A window that is going away must not be kept alive by a workspace.
    if (gBrowser?.ownerGlobal?.closed) return;
    const visible = gBrowser.tabs.filter(
      (other) => other !== tab && !other.hidden && other.isOpen !== false
    );
    if (visible.length > 0) return;
    const owner = getTabWorkspace(tab);
    const fallback = workspaces.find(
      (ws) =>
        ws.id !== owner &&
        gBrowser.tabs.some((other) => getTabWorkspace(other) === ws.id)
    );
    if (!fallback) return;
    activeId = fallback.id;
    persistActiveId();
    syncBrowserTabs();
    notify();
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
      const shouldShow = (!isolated && isPinned) || wsId === activeId;
      if (shouldShow) {
        visibleInActive.push(tab);
      }
    }

    // Firefox requires at least one visible tab before hiding the currently
    // selected tab. Ensure a tab exists in the active workspace first.
    if (visibleInActive.length === 0 && typeof gBrowser?.addTrustedTab === "function") {
      try {
        const created = gBrowser.addTrustedTab("about:newtab", isolated ? { userContextId: containers[activeId] } : {});
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
      ((!isolated && Boolean(selectedTab.pinned)) || getTabWorkspace(selectedTab) === activeId);

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
      const shouldShow = (!isolated && isPinned) || wsId === activeId;
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
      isolated,
      privateWindow: isPrivate,
      autoUnload,
      activeId,
      activeWorkspace:
        workspaces.find((ws) => ws.id === activeId) ?? workspaces[0],
      workspaces: workspaces.map((ws) => ({
        ...ws,
        tabCount: counts[ws.id] ?? 0,
        active: ws.id === activeId,
        canDelete: workspaces.length > 1 && (!isolated || (ws.id !== "general" &&
          !getAllTabs().some(tab => ownerOf(tab) === ws.id))),
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
      if (key === WORKSPACES_PREFS.containers) return;
      if (
        key &&
        !key.startsWith("argon.workspaces.") &&
        key !== WORKSPACES_PREFS.autoUnload
      ) {
        return;
      }
      workspaces = loadWorkspaces();
      ensureContainers();
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

  // Supply the container before Gecko creates the browser or starts a request.
  // Preserve explicit contexts and opener inheritance (including session restore).
  const originalAddTab = gBrowser?.addTab;
  let wrappedAddTab;
  if (isolated && originalAddTab) {
    wrappedAddTab = function(uri, options = {}) {
      const userContextId = containerForNewTab(options);
      const tab = originalAddTab.call(this, uri, { ...options, userContextId });
      tagTab(tab, ownerOf(tab) || 'general');
      return tab;
    };
    gBrowser.addTab = wrappedAddTab;
  }
  const originalRemoveTab = gBrowser?.removeTab;
  let wrappedRemoveTab;
  if (originalRemoveTab) {
    wrappedRemoveTab = function(tab, ...rest) {
      try {
        keepWindowOpen(tab);
      } catch {
        // Never block a close because the workspace bookkeeping failed.
      }
      return originalRemoveTab.call(this, tab, ...rest);
    };
    gBrowser.removeTab = wrappedRemoveTab;
  }
  const onTabOpen = event => { getTabWorkspace(event.target); };
  const onRestore = () => { syncBrowserTabs(); notify(); };
  const onSelect = () => {
    if (!enabled || !isolated || !gBrowser.selectedTab) return;
    const owner = getTabWorkspace(gBrowser.selectedTab);
    if (owner === activeId) return;
    activeId = owner;
    persistActiveId();
    syncBrowserTabs();
    notify();
  };
  gBrowser?.tabContainer?.addEventListener?.('TabOpen', onTabOpen);
  gBrowser?.tabContainer?.addEventListener?.('SSTabRestored', onRestore);
  gBrowser?.tabContainer?.addEventListener?.('TabSelect', onSelect);
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
      while (workspaces.some((ws) => ws.id === candidateId) || (isolated && Object.hasOwn(containers, candidateId))) {
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
      ensureContainers();
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
      ensureContainers();
      notify();
      return { ...workspaces[index] };
    },
    deleteWorkspace(id) {
      if (isolated && id === "general") {
        throw new RangeError("The default storage workspace cannot be deleted");
      }
      if (isolated && getAllTabs().some(tab => ownerOf(tab) === id)) {
        throw new RangeError(
          "Move or close this workspace's tabs before deleting it"
        );
      }
      if (workspaces.length <= 1) {
        throw new RangeError("Cannot delete the last remaining workspace");
      }
      const exists = workspaces.some((ws) => ws.id === id);
      if (!exists) {
        throw new RangeError(`Unknown Argon workspace: ${id}`);
      }
      const removedContainer = isolated ? containers[id] : null;
      workspaces = workspaces.filter((ws) => ws.id !== id);
      if (isolated && removedContainer) {
        // The container holds the workspace's cookies and storage, so removing
        // the workspace has to remove both.
        delete containers[id];
        preferences?.setStringPref?.(
          WORKSPACES_PREFS.containers,
          JSON.stringify(containers)
        );
        try {
          contextualIdentities.remove(Number(removedContainer));
        } catch {
          // The container may already be gone from the browser.
        }
      }
      const fallbackId =
        activeId === id ? workspaces[0].id : resolveActiveId(activeId);
      activeId = fallbackId;

      const tabs = gBrowser?.tabs ? [...gBrowser.tabs] : [];
      for (const tab of tabs) {
        if (getTabWorkspace(tab) === id) {
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
      if (wrappedAddTab && gBrowser.addTab === wrappedAddTab) gBrowser.addTab = originalAddTab;
      if (wrappedRemoveTab && gBrowser.removeTab === wrappedRemoveTab) gBrowser.removeTab = originalRemoveTab;
      gBrowser?.tabContainer?.removeEventListener?.('TabOpen', onTabOpen);
      gBrowser?.tabContainer?.removeEventListener?.('SSTabRestored', onRestore);
      gBrowser?.tabContainer?.removeEventListener?.('TabSelect', onSelect);
      preferences?.removeObserver?.("argon.workspaces.", observer);
      preferences?.removeObserver?.(WORKSPACES_PREFS.autoUnload, observer);
    },
  };
}
