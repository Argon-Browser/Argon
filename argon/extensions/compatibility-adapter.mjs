// SPDX-License-Identifier: MPL-2.0

import {
  BACKGROUND_SHIM_FILENAME,
  generateBackgroundRuntimeShim,
} from "./background-runtime.mjs";
import { sanitizeManifest } from "./json-safety.mjs";
import { analyzeManifest } from "./manifest-analyzer.mjs";

export const CHROME_ONLY_PERMISSIONS = new Set([
  "background",
  "ChromeOS",
  " contentSettings",
  "contentSettings",
  "debugger",
  "declarativeContent",
  "desktopCapture",
  "documentScan",
  "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform",
  "enterprise.networkingAttributes",
  "enterprise.platformKeys",
  "experimental",
  "favicon",
  "fileBrowserHandler",
  "fileSystemProvider",
  "fontSettings",
  "gcm",
  "loginState",
  "offscreen",
  "pageCapture",
  "platformKeys",
  "power",
  "printerProvider",
  "printing",
  "printingMetrics",
  "processes",
  "proxy",
  "readingList",
  "sidePanel",
  "system.cpu",
  "system.display",
  "system.memory",
  "system.storage",
  "tabCapture",
  "tabGroups",
  "tts",
  "ttsEngine",
  "vpnProvider",
  "wallpaper",
]);

export const CHROME_REMOVABLE_MANIFEST_KEYS = new Set([
  "key",
  "minimum_chrome_version",
  "update_url",
  "oauth2",
  "externally_connectable",
  "version_name",
]);

export function deriveGeckoExtensionId(name, fallbackSlug = "extension") {
  const slug =
    String(name || fallbackSlug)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42) || fallbackSlug;
  return `${slug}@argon-bridge.local`;
}

/**
 * Adapts a Chromium or WebExtension manifest for execution on Gecko without
 * mutating the caller's object or broadening permission boundaries.
 */
export function adaptChromeManifest(rawManifest, options = {}) {
  const gate = sanitizeManifest(rawManifest);
  const initialAnalysis = analyzeManifest(rawManifest);

  if (!gate.ok || !initialAnalysis.valid) {
    return {
      ok: false,
      tier: "Incompatible",
      adaptedManifest: null,
      generatedFiles: {},
      adaptations: [],
      removedPermissions: [],
      initialAnalysis,
      finalAnalysis: initialAnalysis,
    };
  }

  const adapted = structuredClone(gate.manifest);
  const adaptations = [];
  const removedPermissions = [];
  const generatedFiles = {};

  // 1. Ensure browser_specific_settings.gecko.id exists for Gecko installation
  const hasGeckoId = Boolean(
    adapted.browser_specific_settings?.gecko?.id ||
      adapted.applications?.gecko?.id
  );
  if (!hasGeckoId) {
    const generatedId =
      options.extensionId || deriveGeckoExtensionId(adapted.name);
    if (
      !adapted.browser_specific_settings ||
      typeof adapted.browser_specific_settings !== "object"
    ) {
      adapted.browser_specific_settings = {};
    }
    if (
      !adapted.browser_specific_settings.gecko ||
      typeof adapted.browser_specific_settings.gecko !== "object"
    ) {
      adapted.browser_specific_settings.gecko = {};
    }
    adapted.browser_specific_settings.gecko.id = generatedId;
    adapted.browser_specific_settings.gecko.strict_min_version =
      options.strictMinVersion || "128.0";
    adaptations.push({
      code: "ADDED_GECKO_EXTENSION_ID",
      path: "browser_specific_settings.gecko.id",
      description: `Added Gecko extension identifier "${generatedId}" required for WebExtension installation.`,
    });
  }

  const extensionId =
    adapted.browser_specific_settings?.gecko?.id ||
    adapted.applications?.gecko?.id ||
    deriveGeckoExtensionId(adapted.name);

  // 2. Translate options_page -> options_ui
  if (typeof adapted.options_page === "string" && adapted.options_page.trim()) {
    const page = adapted.options_page.trim();
    if (!adapted.options_ui || typeof adapted.options_ui !== "object") {
      adapted.options_ui = {
        page,
        open_in_tab: true,
      };
      adaptations.push({
        code: "TRANSLATED_OPTIONS_PAGE",
        path: "options_page",
        description: `Translated legacy "options_page" ("${page}") to standard "options_ui".`,
      });
    }
    delete adapted.options_page;
  }

  // 3. Translate side_panel -> sidebar_action
  if (adapted.side_panel && typeof adapted.side_panel === "object") {
    const defaultPath = adapted.side_panel.default_path;
    if (
      typeof defaultPath === "string" &&
      defaultPath.trim() &&
      !adapted.sidebar_action
    ) {
      adapted.sidebar_action = {
        default_panel: defaultPath.trim(),
        default_title: adapted.short_name || adapted.name,
      };
      adaptations.push({
        code: "TRANSLATED_SIDE_PANEL",
        path: "side_panel",
        description: `Mapped Chromium "side_panel.default_path" ("${defaultPath.trim()}") to Firefox "sidebar_action".`,
      });
    }
    delete adapted.side_panel;
  }

  // 4. Adapt MV3 background.service_worker to Gecko event page scripts + runtime shim
  if (
    adapted.background &&
    typeof adapted.background === "object" &&
    typeof adapted.background.service_worker === "string"
  ) {
    const workerScript = adapted.background.service_worker.trim();
    const existingScripts = Array.isArray(adapted.background.scripts)
      ? adapted.background.scripts.filter((s) => typeof s === "string")
      : [];

    const scripts = [BACKGROUND_SHIM_FILENAME];
    for (const s of existingScripts) {
      if (!scripts.includes(s)) scripts.push(s);
    }
    if (workerScript && !scripts.includes(workerScript)) {
      scripts.push(workerScript);
    }

    const nextBackground = {
      scripts,
    };
    if (adapted.background.type === "module") {
      nextBackground.type = "module";
    }
    adapted.background = nextBackground;

    generatedFiles[BACKGROUND_SHIM_FILENAME] = generateBackgroundRuntimeShim({
      extensionId,
      serviceWorker: workerScript,
    });

    adaptations.push({
      code: "BRIDGED_MV3_SERVICE_WORKER",
      path: "background.service_worker",
      description: `Adapted MV3 "background.service_worker" ("${workerScript}") to Gecko event-driven "background.scripts" with "${BACKGROUND_SHIM_FILENAME}".`,
    });
  }

  // 5. Filter out Chrome-only permissions while preserving standard API & host permissions
  for (const field of ["permissions", "optional_permissions"]) {
    if (Array.isArray(adapted[field])) {
      const kept = [];
      for (const entry of adapted[field]) {
        if (typeof entry === "string" && CHROME_ONLY_PERMISSIONS.has(entry)) {
          removedPermissions.push({ field, permission: entry });
        } else {
          kept.push(entry);
        }
      }
      if (kept.length !== adapted[field].length) {
        adapted[field] = kept;
        adaptations.push({
          code: "STRIPPED_CHROME_ONLY_PERMISSIONS",
          path: field,
          description: `Removed unsupported Chromium-specific permissions from "${field}": ${removedPermissions
            .filter((p) => p.field === field)
            .map((p) => p.permission)
            .join(", ")}.`,
        });
      }
    }
  }

  // 6. Strip non-portable Chrome Web Store metadata keys
  for (const key of CHROME_REMOVABLE_MANIFEST_KEYS) {
    if (Object.hasOwn(adapted, key)) {
      delete adapted[key];
      adaptations.push({
        code: "REMOVED_CHROME_STORE_KEY",
        path: key,
        description: `Removed Chromium-specific manifest key "${key}".`,
      });
    }
  }

  // 7. Normalize MV2 web_accessible_resources when needed or keep valid shape
  const finalAnalysis = analyzeManifest(adapted);

  let tier = "Compatible";
  if (hasGeckoId && adaptations.length === 0) {
    tier = "Native";
  } else if (
    adaptations.some(
      (a) =>
        a.code !== "ADDED_GECKO_EXTENSION_ID" &&
        a.code !== "REMOVED_CHROME_STORE_KEY"
    )
  ) {
    tier = "Adapted";
  }

  return {
    ok: finalAnalysis.valid,
    tier,
    extensionId,
    adaptedManifest: adapted,
    generatedFiles,
    adaptations,
    removedPermissions,
    initialAnalysis,
    finalAnalysis,
  };
}
