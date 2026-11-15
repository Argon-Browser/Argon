// SPDX-License-Identifier: MIT

import {
  createShortcutManager,
  matchesShortcutEvent,
  matchWorkspaceShortcutIndex,
} from "./shortcuts.mjs";

export function scoreCommandMatch(command, rawQuery) {
  const query = String(rawQuery || "")
    .trim()
    .toLowerCase();
  if (!query) return 1;

  const title = String(command.title || "").toLowerCase();
  const category = String(command.category || "").toLowerCase();
  const description = String(command.description || "").toLowerCase();
  const keywords = Array.isArray(command.keywords)
    ? command.keywords.map((k) => String(k).toLowerCase()).join(" ")
    : "";

  const tokens = query.split(/\s+/).filter(Boolean);
  const haystack = `${title} ${category} ${description} ${keywords}`;

  for (const token of tokens) {
    if (!haystack.includes(token)) {
      return 0;
    }
  }

  const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean);
  if (title === query) return 100;
  if (title.startsWith(query)) return 95;
  if (tokens.every((token) => titleWords.includes(token))) return 90;
  if (title.includes(query)) return 85;
  if (
    tokens.every((token) => titleWords.some((word) => word.startsWith(token)))
  ) {
    return 80;
  }
  if (tokens.every((token) => title.includes(token))) return 70;
  if (category.startsWith(query)) return 60;
  if (
    tokens.every((token) => title.includes(token) || category.includes(token))
  ) {
    return 55;
  }
  if (keywords.includes(query)) return 45;
  return 30;
}

export function filterCommands(commands = [], rawQuery = "") {
  const scored = [];
  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    if (typeof command.isAvailable === "function" && !command.isAvailable()) {
      continue;
    }
    const score = scoreCommandMatch(command, rawQuery);
    if (score > 0) {
      scored.push({ command, score });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.command.title || "").localeCompare(
      String(b.command.title || "")
    );
  });
  return scored.map((item) => item.command);
}

export function createCommandRegistry({
  appearance = null,
  customization = null,
  workspaces = null,
  shortcutManager = null,
  preferences = null,
  onOpenSettings = null,
  onOpenOnboarding = null,
  onOpenImport = null,
  onFocusAddressBar = null,
  onNewTab = null,
  onPinCurrentTab = null,
  onDuplicateCurrentTab = null,
  onMoveCurrentTab = null,
} = {}) {
  const customCommands = new Map();
  const ownsShortcutManager = !shortcutManager;
  const activeShortcutManager =
    shortcutManager ?? createShortcutManager({ preferences });

  const resolveShortcut = (id, fallback) => {
    try {
      const value = activeShortcutManager?.getShortcut?.(id);
      return value || undefined;
    } catch {
      return fallback;
    }
  };

  const getBuiltInCommands = () => {
    const wsShortcut = resolveShortcut("switchWorkspace", "Alt+1…9");
    const wsPrefix = wsShortcut ? wsShortcut.replace(/\+1…9$/, "") : "";

    const list = [
      {
        id: "appearance.theme.light",
        title: "Switch Theme: Light",
        category: "Appearance",
        description: "Apply Argon Light (#F7F8FA) surface tokens",
        keywords: ["theme", "light", "bright", "color", "scheme"],
        run: () => appearance?.setTheme?.("light"),
      },
      {
        id: "appearance.theme.dark",
        title: "Switch Theme: Dark",
        category: "Appearance",
        description: "Apply Argon Dark (#15171B) surface tokens",
        keywords: ["theme", "dark", "night", "color", "scheme"],
        run: () => appearance?.setTheme?.("dark"),
      },
      {
        id: "appearance.theme.system",
        title: "Switch Theme: System Auto",
        category: "Appearance",
        description: "Follow the Linux desktop color scheme automatically",
        keywords: ["theme", "system", "auto", "os"],
        run: () => appearance?.setTheme?.("system"),
      },
      {
        id: "appearance.tabs.horizontal",
        title: "Switch Tabs: Horizontal Strip",
        category: "Appearance",
        description: "Place tabs in the top horizontal strip",
        keywords: ["tabs", "horizontal", "layout", "top"],
        run: () => appearance?.setLayout?.("horizontal"),
      },
      {
        id: "appearance.tabs.vertical",
        title: "Switch Tabs: Vertical Sidebar",
        category: "Appearance",
        description: "Dock native tabs in the 240 px vertical sidebar",
        keywords: ["tabs", "vertical", "sidebar", "layout"],
        run: () => appearance?.setLayout?.("vertical"),
      },
      {
        id: "appearance.tabs.toggle",
        title: "Toggle Vertical Tab Strip",
        category: "Appearance",
        description: "Switch between horizontal and vertical tab strips",
        shortcut: resolveShortcut("toggleVerticalTabs", "Ctrl+Alt+V"),
        keywords: ["tabs", "vertical", "horizontal", "toggle", "sidebar"],
        run: () =>
          appearance?.setLayout?.(
            appearance?.layout === "vertical" ? "horizontal" : "vertical"
          ),
      },
      {
        id: "appearance.toolbar.top",
        title: "Toolbar Placement: Top (Tabs First)",
        category: "Appearance",
        description: "Place tab strip above the address bar at the top",
        keywords: ["toolbar", "placement", "top", "tabs", "layout"],
        run: () => customization?.setToolbarPlacement?.("top"),
      },
      {
        id: "appearance.toolbar.topReversed",
        title: "Toolbar Placement: Top (Address Bar First)",
        category: "Appearance",
        description: "Place address bar above the horizontal tab strip",
        keywords: ["toolbar", "placement", "reversed", "urlbar", "tabs"],
        run: () => customization?.setToolbarPlacement?.("top-reversed"),
      },
      {
        id: "appearance.toolbar.bottom",
        title: "Toolbar Placement: Bottom",
        category: "Appearance",
        description: "Dock the browser toolbar and tab strip at the bottom edge",
        keywords: ["toolbar", "placement", "bottom", "dock", "layout"],
        run: () => customization?.setToolbarPlacement?.("bottom"),
      },
      {
        id: "appearance.toolbar.cycle",
        title: "Cycle Toolbar Placement",
        category: "Appearance",
        description: "Rotate between Top, Top Reversed, and Bottom toolbars",
        shortcut: resolveShortcut("cycleToolbarPlacement", "Ctrl+Alt+T"),
        keywords: ["toolbar", "placement", "cycle", "position"],
        run: () => customization?.cycleToolbarPlacement?.(),
      },
      {
        id: "appearance.sidebar.left",
        title: "Sidebar Position: Left",
        category: "Appearance",
        description: "Dock the vertical tab strip and sidebar on the left side",
        keywords: ["sidebar", "vertical", "left", "position"],
        run: () => customization?.setSidebarPosition?.("left"),
      },
      {
        id: "appearance.sidebar.right",
        title: "Sidebar Position: Right",
        category: "Appearance",
        description: "Dock the vertical tab strip and sidebar on the right side",
        keywords: ["sidebar", "vertical", "right", "position"],
        run: () => customization?.setSidebarPosition?.("right"),
      },
      {
        id: "appearance.density.toggle",
        title: "Toggle Compact Density Mode",
        category: "Appearance",
        description:
          "Collapse secondary chrome padding to maximize viewport space",
        shortcut: resolveShortcut("compactDensity", "Ctrl+Shift+D"),
        keywords: ["compact", "density", "zen", "minimal", "toolbar"],
        run: () => customization?.toggleCompactMode?.(),
      },
      {
        id: "navigation.focusUrlbar",
        title: "Focus Address & Search Bar",
        category: "Navigation",
        description: "Jump focus to the unified URL and search bar",
        shortcut: resolveShortcut("focusAddressBar", "Ctrl+L"),
        keywords: ["url", "address", "search", "bar", "location"],
        run: () => onFocusAddressBar?.(),
      },
      {
        id: "tabs.new",
        title: "Open New Tab",
        category: "Tabs",
        description: "Open a new tab in the active workspace",
        shortcut: resolveShortcut("newTab", "Ctrl+T"),
        keywords: ["new", "tab", "open"],
        run: () => onNewTab?.(),
      },
      {
        id: "tabs.pin",
        title: "Pin / Unpin Current Tab",
        category: "Tabs",
        description:
          "Pinned tabs remain persistent across all Argon workspaces",
        keywords: ["pin", "unpin", "tab", "persistent"],
        run: () => onPinCurrentTab?.(),
      },
      {
        id: "tabs.duplicate",
        title: "Duplicate Current Tab",
        category: "Tabs",
        description: "Clone the active tab within the current workspace",
        keywords: ["duplicate", "clone", "tab"],
        run: () => onDuplicateCurrentTab?.(),
      },
      {
        id: "tabs.unloadInactive",
        title: "Suspend Inactive Background Tabs",
        category: "Tabs",
        description:
          "Unload non-pinned background tabs to reclaim system memory",
        keywords: ["suspend", "unload", "discard", "memory", "tabs", "sleep"],
        run: () => workspaces?.unloadBackgroundTabs?.(),
      },
      {
        id: "argon.openSettings",
        title: "Open Argon Settings & Extension Bridge",
        category: "Settings & Extensions",
        description:
          "Configure themes, workspaces, privacy, and Chrome extension compatibility",
        shortcut: resolveShortcut("openExtensionBridge", "Ctrl+Shift+E"),
        keywords: [
          "settings",
          "preferences",
          "about:argon",
          "extensions",
          "chrome",
          "bridge",
          "analyzer",
        ],
        run: () => onOpenSettings?.("extensions"),
      },
      {
        id: "argon.openOnboarding",
        title: "Open Welcome & First-Run Setup",
        category: "Settings & Extensions",
        description:
          "Re-run the Argon Browser onboarding and search engine selector",
        keywords: ["onboarding", "welcome", "setup", "wizard", "search"],
        run: () => onOpenOnboarding?.(),
      },
      {
        id: "argon.importData",
        title: "Import Bookmarks, Passwords & History",
        category: "Settings & Extensions",
        description: "Launch the browser profile migration wizard",
        keywords: ["import", "migrate", "bookmarks", "passwords", "history"],
        run: () => onOpenImport?.(),
      },
    ];

    const wsList = workspaces?.workspaces ?? [];
    wsList.forEach((ws, index) => {
      list.push({
        id: `workspaces.switch.${ws.id}`,
        title: `Switch Workspace: ${ws.name}`,
        category: "Workspaces",
        description: `Activate the ${ws.name} isolated tab workspace`,
        shortcut:
          index < 9 && wsPrefix ? `${wsPrefix}+${index + 1}` : undefined,
        keywords: ["workspace", "switch", ws.name.toLowerCase(), ws.id],
        run: () => workspaces?.setActiveWorkspace?.(ws.id),
      });
      if (onMoveCurrentTab && ws.id !== workspaces.activeId) {
        list.push({
          id: `workspaces.move.${ws.id}`,
          title: `Reopen Tab in Workspace: ${ws.name}`,
          category: 'Workspaces',
          description: 'Reload this URL with the destination session. Unsaved page state is not transferred.',
          keywords: ['workspace', 'move', 'container', ws.name.toLowerCase()],
          run: () => onMoveCurrentTab(ws.id),
        });
      }
    });

    return [...list, ...customCommands.values()];
  };

  return {
    shortcutManager: activeShortcutManager,
    ownsShortcutManager,
    getCommands() {
      return getBuiltInCommands();
    },
    search(query = "") {
      return filterCommands(getBuiltInCommands(), query);
    },
    registerCommand(command) {
      if (!command || typeof command.id !== "string" || !command.id.trim()) {
        throw new RangeError("Command must define a non-empty string id");
      }
      if (typeof command.title !== "string" || !command.title.trim()) {
        throw new RangeError("Command must define a non-empty string title");
      }
      if (typeof command.run !== "function") {
        throw new RangeError("Command must define a run() function");
      }
      customCommands.set(command.id, { ...command });
    },
    unregisterCommand(id) {
      return customCommands.delete(id);
    },
    execute(id) {
      const cmd = getBuiltInCommands().find((item) => item.id === id);
      if (!cmd) {
        throw new RangeError(`Unknown Argon command: ${id}`);
      }
      return cmd.run();
    },
  };
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function createHtmlElement(doc, tag) {
  if (typeof doc.createElementNS === "function") {
    return doc.createElementNS(XHTML_NS, tag);
  }
  return doc.createElement(tag);
}

const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;

export function installCommandPalette(win, options = {}) {
  const doc = win?.document;
  if (!doc) return null;
  if (win.ArgonCommandPalette) return win.ArgonCommandPalette;

  const registry = createCommandRegistry(options);

  let isOpen = false;
  let selectedIndex = 0;
  let currentResults = [];

  let overlay = null;
  let input = null;
  let list = null;
  let emptyEl = null;
  let errorEl = null;
  const rowPool = [];
  let activeRowCount = 0;
  let lastRenderMode = null;

  const ensureOverlay = () => {
    if (overlay) return overlay;

    overlay = createHtmlElement(doc, "div");
    overlay.id = "argon-command-palette-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Argon Command Palette");
    overlay.hidden = true;

    const modal = createHtmlElement(doc, "div");
    modal.id = "argon-command-palette";

    const header = createHtmlElement(doc, "div");
    header.className = "argon-cp-header";

    input = createHtmlElement(doc, "input");
    input.id = "argon-command-palette-input";
    input.type = "text";
    input.placeholder = "Type a command or search actions…";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "argon-command-palette-list");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Search Argon commands");

    const shortcutHint = createHtmlElement(doc, "kbd");
    shortcutHint.className = "argon-cp-esc-hint";
    shortcutHint.textContent = "Esc";

    header.append(input, shortcutHint);

    list = createHtmlElement(doc, "div");
    list.id = "argon-command-palette-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Available commands");

    modal.append(header, list);
    overlay.appendChild(modal);

    const host = doc.getElementById("mainPopupSet") || doc.documentElement;
    host.appendChild(overlay);

    input.addEventListener("input", () => {
      selectedIndex = 0;
      renderResults();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (currentResults.length > 0) {
          selectedIndex = (selectedIndex + 1) % currentResults.length;
          updateSelectionAttributes();
        }
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (currentResults.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + currentResults.length) % currentResults.length;
          updateSelectionAttributes();
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        executeSelected();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        close();
      }
    });

    return overlay;
  };

  const acquireRow = (idx) => {
    if (rowPool[idx]) {
      return rowPool[idx];
    }

    const item = createHtmlElement(doc, "button");
    item.type = "button";
    item.id = `argon-cp-item-${idx}`;
    item.setAttribute("role", "option");

    const textGroup = createHtmlElement(doc, "div");
    textGroup.className = "argon-cp-item-text";

    const titleRow = createHtmlElement(doc, "div");
    titleRow.className = "argon-cp-item-title-row";

    const categoryBadge = createHtmlElement(doc, "span");
    categoryBadge.className = "argon-cp-category";

    const title = createHtmlElement(doc, "span");
    title.className = "argon-cp-title";

    titleRow.append(categoryBadge, title);
    textGroup.appendChild(titleRow);
    item.appendChild(textGroup);

    const desc = createHtmlElement(doc, "span");
    desc.className = "argon-cp-desc";

    const kbd = createHtmlElement(doc, "kbd");
    kbd.className = "argon-cp-shortcut";

    const row = {
      index: idx,
      item,
      textGroup,
      titleRow,
      categoryBadge,
      title,
      desc,
      kbd,
      hasDesc: false,
      hasShortcut: false,
      lastCommandId: null,
      lastCategory: null,
      lastTitle: null,
      lastDesc: null,
      lastShortcut: null,
    };

    item.addEventListener("mouseenter", () => {
      selectedIndex = row.index;
      updateSelectionAttributes();
    });

    item.addEventListener("click", () => {
      executeSelected(row.index);
    });

    rowPool[idx] = row;
    return row;
  };

  const renderError = (message) => {
    ensureOverlay();
    if (!errorEl) {
      errorEl = createHtmlElement(doc, "div");
      errorEl.className = "argon-cp-error";
      errorEl.setAttribute("role", "alert");
    }
    errorEl.textContent = message;
    list.replaceChildren(errorEl);
    activeRowCount = 0;
    lastRenderMode = "error";
    input.removeAttribute("aria-activedescendant");
  };

  const renderResults = () => {
    ensureOverlay();
    currentResults = registry.search(input.value);
    if (selectedIndex >= currentResults.length) {
      selectedIndex = Math.max(0, currentResults.length - 1);
    }

    if (currentResults.length === 0) {
      if (!emptyEl) {
        emptyEl = createHtmlElement(doc, "div");
        emptyEl.className = "argon-cp-empty";
        emptyEl.textContent = "No matching commands found.";
      }
      if (lastRenderMode !== "empty") {
        list.replaceChildren(emptyEl);
      }
      activeRowCount = 0;
      lastRenderMode = "empty";
      input.removeAttribute("aria-activedescendant");
      return;
    }

    const visibleItems = new Array(currentResults.length);
    for (let idx = 0; idx < currentResults.length; idx += 1) {
      const cmd = currentResults[idx];
      const row = acquireRow(idx);
      row.index = idx;
      const active = idx === selectedIndex;

      row.item.className = active ? "argon-cp-item selected" : "argon-cp-item";
      row.item.setAttribute("aria-selected", String(active));
      if (row.lastCommandId !== cmd.id) {
        row.item.dataset.commandId = cmd.id;
        row.lastCommandId = cmd.id;
      }

      const categoryText = cmd.category || "General";
      if (row.lastCategory !== categoryText) {
        row.categoryBadge.textContent = categoryText;
        row.lastCategory = categoryText;
      }
      if (row.lastTitle !== cmd.title) {
        row.title.textContent = cmd.title;
        row.lastTitle = cmd.title;
      }

      const hasDesc = Boolean(cmd.description);
      if (hasDesc) {
        if (row.lastDesc !== cmd.description) {
          row.desc.textContent = cmd.description;
          row.lastDesc = cmd.description;
        }
        if (!row.hasDesc) {
          row.textGroup.replaceChildren(row.titleRow, row.desc);
          row.hasDesc = true;
        }
      } else if (row.hasDesc) {
        row.textGroup.replaceChildren(row.titleRow);
        row.hasDesc = false;
        row.lastDesc = null;
      }

      const hasShortcut = Boolean(cmd.shortcut);
      if (hasShortcut) {
        if (row.lastShortcut !== cmd.shortcut) {
          row.kbd.textContent = cmd.shortcut;
          row.lastShortcut = cmd.shortcut;
        }
        if (!row.hasShortcut) {
          row.item.replaceChildren(row.textGroup, row.kbd);
          row.hasShortcut = true;
        }
      } else if (row.hasShortcut) {
        row.item.replaceChildren(row.textGroup);
        row.hasShortcut = false;
        row.lastShortcut = null;
      }

      visibleItems[idx] = row.item;
    }

    if (lastRenderMode !== "items" || activeRowCount !== currentResults.length) {
      list.replaceChildren(...visibleItems);
    }
    activeRowCount = currentResults.length;
    lastRenderMode = "items";

    input.setAttribute(
      "aria-activedescendant",
      `argon-cp-item-${selectedIndex}`
    );
  };

  const updateSelectionAttributes = () => {
    for (let idx = 0; idx < activeRowCount; idx += 1) {
      const el = rowPool[idx].item;
      const active = idx === selectedIndex;
      el.className = active ? "argon-cp-item selected" : "argon-cp-item";
      el.classList.toggle("selected", active);
      el.setAttribute("aria-selected", String(active));
      if (active) {
        el.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (currentResults.length > 0 && input) {
      input.setAttribute(
        "aria-activedescendant",
        `argon-cp-item-${selectedIndex}`
      );
    }
  };

  const executeSelected = (idx = selectedIndex) => {
    const target = currentResults[idx];
    if (!target) return;
    close();
    try {
      target.run();
    } catch (error) {
      // Keep the palette open so the user can read why the command failed.
      open();
      renderError(error?.message || String(error));
    }
  };

  const open = (initialQuery = "") => {
    ensureOverlay();
    isOpen = true;
    overlay.hidden = false;
    input.value = initialQuery;
    selectedIndex = 0;
    renderResults();
    input.focus?.();
    input.select?.();
  };

  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    if (overlay) {
      overlay.hidden = true;
    }
    if (input) {
      input.value = "";
    }
  };

  const toggle = () => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  };

  let captureSuspended = false;
  const shortcutManager = registry.shortcutManager;

  const isCapturingTarget = (target) => {
    if (captureSuspended) return true;
    if (target?.dataset?.argonShortcutCapture === "true") return true;
    const active = doc.activeElement;
    return active?.dataset?.argonShortcutCapture === "true";
  };

  const onWindowKeyDown = (event) => {
    if (isOpen && event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !FUNCTION_KEY_RE.test(String(event.key || ""))
    ) {
      return;
    }

    if (isCapturingTarget(event.target)) {
      return;
    }

    const paletteCombo = shortcutManager?.getShortcut?.("commandPalette") || "Ctrl+Shift+P";
    if (
      matchesShortcutEvent(event, paletteCombo) ||
      (paletteCombo === "Ctrl+Shift+P" &&
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "P" || event.key === "p"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
      return;
    }

    const compactCombo = shortcutManager?.getShortcut?.("compactDensity") || "";
    if (compactCombo && matchesShortcutEvent(event, compactCombo)) {
      event.preventDefault();
      options.customization?.toggleCompactMode?.();
      return;
    }

    const bridgeCombo = shortcutManager?.getShortcut?.("openExtensionBridge") || "";
    if (bridgeCombo && matchesShortcutEvent(event, bridgeCombo)) {
      event.preventDefault();
      options.onOpenSettings?.("extensions");
      return;
    }

    const verticalCombo = shortcutManager?.getShortcut?.("toggleVerticalTabs") || "";
    if (verticalCombo && matchesShortcutEvent(event, verticalCombo)) {
      event.preventDefault();
      const next =
        options.appearance?.layout === "vertical" ? "horizontal" : "vertical";
      options.appearance?.setLayout?.(next);
      return;
    }

    const placementCombo = shortcutManager?.getShortcut?.("cycleToolbarPlacement") || "";
    if (placementCombo && matchesShortcutEvent(event, placementCombo)) {
      event.preventDefault();
      options.customization?.cycleToolbarPlacement?.();
      return;
    }

    const focusDef = shortcutManager?.getDefinition?.("focusAddressBar");
    const focusCombo = shortcutManager?.getShortcut?.("focusAddressBar") || "";
    if (
      focusCombo &&
      focusCombo !== focusDef?.defaultCombo &&
      matchesShortcutEvent(event, focusCombo)
    ) {
      event.preventDefault();
      options.onFocusAddressBar?.();
      return;
    }

    const newTabDef = shortcutManager?.getDefinition?.("newTab");
    const newTabCombo = shortcutManager?.getShortcut?.("newTab") || "";
    if (
      newTabCombo &&
      newTabCombo !== newTabDef?.defaultCombo &&
      matchesShortcutEvent(event, newTabCombo)
    ) {
      event.preventDefault();
      options.onNewTab?.();
      return;
    }

    const wsCombo = shortcutManager?.getShortcut?.("switchWorkspace") || "";
    if (wsCombo) {
      const idx = matchWorkspaceShortcutIndex(event, wsCombo);
      const wsList = options.workspaces?.workspaces ?? [];
      if (idx >= 0 && idx < wsList.length) {
        event.preventDefault();
        options.workspaces.switchByIndex(idx);
      }
    }
  };

  win.addEventListener?.("keydown", onWindowKeyDown, true);

  const api = {
    get isOpen() {
      return isOpen;
    },
    get shortcutManager() {
      return shortcutManager;
    },
    setCaptureSuspended(suspended) {
      captureSuspended = Boolean(suspended);
    },
    open,
    close,
    toggle,
    registry,
    dispose() {
      win.removeEventListener?.("keydown", onWindowKeyDown, true);
      if (registry.ownsShortcutManager) {
        shortcutManager?.dispose?.();
      }
      overlay?.remove?.();
      overlay = null;
      input = null;
      list = null;
      emptyEl = null;
      errorEl = null;
      rowPool.length = 0;
      activeRowCount = 0;
      lastRenderMode = null;
      delete win.ArgonCommandPalette;
      if (win.ArgonShortcuts === shortcutManager) {
        delete win.ArgonShortcuts;
      }
    },
  };

  win.ArgonCommandPalette = api;
  win.ArgonShortcuts = shortcutManager;
  return api;
}
