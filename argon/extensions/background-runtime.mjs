// SPDX-License-Identifier: MPL-2.0

export const BACKGROUND_SHIM_FILENAME = "argon-mv3-runtime-shim.js";

/**
 * Generates a self-contained JavaScript shim that bridges Chromium MV3
 * service-worker lifecycle events (`install`, `activate`, `skipWaiting`,
 * `clients.claim`) and safe `chrome.*` API namespace aliases onto Gecko's
 * event-driven background environment without elevating permissions.
 */
export function generateBackgroundRuntimeShim(options = {}) {
  const extensionId = String(options.extensionId || "argon-extension");
  const serviceWorkerPath = String(options.serviceWorker || "");

  return `/* Argon Extension Bridge — MV3 Background Runtime & Chrome API Shim
 * Generated for: ${extensionId}
 * Source worker: ${serviceWorkerPath || "(background scripts)"}
 */
(function initArgonExtensionBridge(globalScope) {
  "use strict";

  if (globalScope.__argonBridgeInitialized) {
    return;
  }
  Object.defineProperty(globalScope, "__argonBridgeInitialized", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const browserApi = globalScope.browser || globalScope.chrome || {};
  if (!globalScope.chrome) {
    globalScope.chrome = browserApi;
  }

  // 1. Service Worker lifecycle compatibility (skipWaiting / clients.claim)
  if (typeof globalScope.skipWaiting !== "function") {
    globalScope.skipWaiting = function skipWaiting() {
      return Promise.resolve();
    };
  }

  if (!globalScope.clients) {
    globalScope.clients = {
      claim() {
        return Promise.resolve();
      },
      matchAll() {
        return Promise.resolve([]);
      },
      get() {
        return Promise.resolve(undefined);
      },
      openWindow(url) {
        if (browserApi.tabs && typeof browserApi.tabs.create === "function") {
          return browserApi.tabs.create({ url: String(url || "") });
        }
        return Promise.resolve(null);
      },
    };
  }

  // 2. Bridge addEventListener("install" | "activate") onto runtime.onInstalled / onStartup
  const origAddEventListener =
    typeof globalScope.addEventListener === "function"
      ? globalScope.addEventListener.bind(globalScope)
      : null;

  const installListeners = [];
  const activateListeners = [];

  function createExtendableEvent(type) {
    const promises = [];
    return {
      type,
      waitUntil(promise) {
        if (promise && typeof promise.then === "function") {
          promises.push(Promise.resolve(promise));
        }
      },
      _settled: () => Promise.allSettled(promises),
    };
  }

  if (origAddEventListener) {
    globalScope.addEventListener = function argonAddEventListener(
      type,
      listener,
      optionsOrCapture
    ) {
      if (typeof listener === "function") {
        if (type === "install") {
          installListeners.push(listener);
          return;
        }
        if (type === "activate") {
          activateListeners.push(listener);
          return;
        }
      }
      return origAddEventListener(type, listener, optionsOrCapture);
    };
  }

  if (browserApi.runtime?.onInstalled?.addListener) {
    browserApi.runtime.onInstalled.addListener(() => {
      const installEvt = createExtendableEvent("install");
      for (const fn of installListeners) {
        try {
          fn(installEvt);
        } catch (err) {
          console.error("[Argon Bridge] SW install listener error:", err);
        }
      }
      installEvt._settled().then(() => {
        const activateEvt = createExtendableEvent("activate");
        for (const fn of activateListeners) {
          try {
            fn(activateEvt);
          } catch (err) {
            console.error("[Argon Bridge] SW activate listener error:", err);
          }
        }
      });
    });
  }

  // 3. Action / BrowserAction alias normalization
  if (globalScope.chrome) {
    if (!globalScope.chrome.action && globalScope.chrome.browserAction) {
      globalScope.chrome.action = globalScope.chrome.browserAction;
    } else if (!globalScope.chrome.browserAction && globalScope.chrome.action) {
      globalScope.chrome.browserAction = globalScope.chrome.action;
    }

    // 4. Safe sidePanel -> sidebarAction adapter where available
    if (!globalScope.chrome.sidePanel) {
      const sidebar = browserApi.sidebarAction || null;
      globalScope.chrome.sidePanel = {
        setOptions(options, callback) {
          if (sidebar?.setPanel && options?.path) {
            sidebar.setPanel({ panel: options.path });
          }
          if (typeof callback === "function") callback();
          return Promise.resolve();
        },
        setPanelBehavior(_behavior, callback) {
          if (typeof callback === "function") callback();
          return Promise.resolve();
        },
        getOptions(_options, callback) {
          const result = { enabled: Boolean(sidebar) };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result);
        },
        open(_options, callback) {
          if (sidebar?.open) {
            try {
              sidebar.open();
            } catch {
              // Requires user gesture in Gecko.
            }
          }
          if (typeof callback === "function") callback();
          return Promise.resolve();
        },
      };
    }

    // 5. Safe offscreen stub so extensions probing chrome.offscreen do not throw TypeError
    if (!globalScope.chrome.offscreen) {
      globalScope.chrome.offscreen = {
        Reason: {
          TESTING: "TESTING",
          AUDIO_PLAYBACK: "AUDIO_PLAYBACK",
          IFRAME_SCRIPTING: "IFRAME_SCRIPTING",
          DOM_SCRAPING: "DOM_SCRAPING",
          BLOBS: "BLOBS",
          DOM_PARSER: "DOM_PARSER",
          USER_MEDIA: "USER_MEDIA",
          DISPLAY_MEDIA: "DISPLAY_MEDIA",
          WEB_RTC: "WEB_RTC",
          CLIPBOARD: "CLIPBOARD",
          LOCAL_STORAGE: "LOCAL_STORAGE",
          WORKERS: "WORKERS",
          BATTERY_STATUS: "BATTERY_STATUS",
          MATCH_MEDIA: "MATCH_MEDIA",
          GEOLOCATION: "GEOLOCATION",
        },
        hasDocument(callback) {
          if (typeof callback === "function") callback(false);
          return Promise.resolve(false);
        },
        createDocument(_params, callback) {
          if (typeof callback === "function") callback();
          return Promise.resolve();
        },
        closeDocument(callback) {
          if (typeof callback === "function") callback();
          return Promise.resolve();
        },
      };
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
`;
}

/**
 * In-memory runtime harness for testing and executing the Chrome API shim
 * against a target global scope.
 */
export function createChromeApiShimRuntime(targetGlobal = {}) {
  const listeners = {
    installed: [],
    startup: [],
  };

  if (!targetGlobal.browser) {
    targetGlobal.browser = {
      runtime: {
        onInstalled: {
          addListener(fn) {
            listeners.installed.push(fn);
          },
        },
        onStartup: {
          addListener(fn) {
            listeners.startup.push(fn);
          },
        },
      },
    };
  }

  const shimSource = generateBackgroundRuntimeShim({
    extensionId: "runtime-harness@argon-bridge.local",
  });
  const runner = new Function("self", "globalThis", shimSource);
  runner(targetGlobal, targetGlobal);

  return {
    global: targetGlobal,
    triggerInstall(details = { reason: "install" }) {
      for (const fn of listeners.installed) {
        fn(details);
      }
    },
    triggerStartup() {
      for (const fn of listeners.startup) {
        fn();
      }
    },
  };
}
