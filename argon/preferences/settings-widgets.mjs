// SPDX-License-Identifier: MIT
// Native Gecko/Acorn Lit widgets for Argon preferences inside about:preferences.
// Every widget renders in light DOM (matching SettingGroup and SettingPane) so
// Firefox's native findInPage search indexes and highlights its text directly.

import { html, nothing, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

import "chrome://global/content/elements/moz-badge.mjs";
import "chrome://global/content/elements/moz-box-button.mjs";
import "chrome://global/content/elements/moz-box-group.mjs";
import "chrome://global/content/elements/moz-box-item.mjs";
import "chrome://global/content/elements/moz-box-link.mjs";
import "chrome://global/content/elements/moz-button-group.mjs";
import "chrome://global/content/elements/moz-button.mjs";
import "chrome://global/content/elements/moz-checkbox.mjs";
import "chrome://global/content/elements/moz-fieldset.mjs";
import "chrome://global/content/elements/moz-input-color.mjs";
import "chrome://global/content/elements/moz-input-text.mjs";
import "chrome://global/content/elements/moz-message-bar.mjs";
import "chrome://global/content/elements/moz-radio-group.mjs";
import "chrome://global/content/elements/moz-segmented-control.mjs";
import "chrome://global/content/elements/moz-select.mjs";
import "chrome://global/content/elements/moz-textarea.mjs";
import "chrome://global/content/elements/moz-toggle.mjs";
import "chrome://global/content/elements/moz-visual-picker.mjs";

import {
  ACCENT_PRESETS,
  applyCustomizationToElement,
} from "chrome://browser/content/argon/customization.mjs";
import { adaptChromeManifest } from "chrome://browser/content/argon/compatibility-adapter.mjs";
import { inspectAndAdaptExtensionArchive } from "chrome://browser/content/argon/extension-installer.mjs";
import { resolveLocale, t } from "chrome://browser/content/argon/i18n.mjs";
import { PASSWORD_MANAGER_ICONS } from "chrome://browser/content/argon/onboarding-icons.mjs";
import {
  SHORTCUT_DEFINITIONS,
  createShortcutManager,
  formatShortcutFromEvent,
} from "chrome://browser/content/argon/shortcuts.mjs";
import { DNS_PROVIDERS, isValidDohUri } from "./dns-providers.mjs";
import {
  SAMPLE_BRIDGE_MANIFESTS,
  SETTINGS_SHORTCUTS,
  resolveGeckoEnvironment,
} from "./settings.mjs";

const RECOMMENDED_PASSWORD_MANAGERS = Object.freeze([
  Object.freeze({
    id: "protonpass",
    name: "Proton Pass",
    addonId: "78272b6fa58f4a1abaac99321d503a20@proton.me",
    xpiUrl:
      "https://addons.mozilla.org/firefox/downloads/latest/proton-pass/latest.xpi",
    url: "https://addons.mozilla.org/firefox/addon/proton-pass/",
    icon: PASSWORD_MANAGER_ICONS.protonpass,
    description:
      "Open-source privacy-first password manager operated by Proton in Switzerland/Europe.",
  }),
  Object.freeze({
    id: "bitwarden",
    name: "Bitwarden",
    addonId: "{446900e4-71c2-419f-a6a7-df9c091e268b}",
    xpiUrl:
      "https://addons.mozilla.org/firefox/downloads/latest/bitwarden-password-manager/latest.xpi",
    url: "https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/",
    icon: PASSWORD_MANAGER_ICONS.bitwarden,
    description:
      "Audited open-source password manager with optional self-hosting (Bitwarden / Vaultwarden).",
  }),
  Object.freeze({
    id: "keepassxc",
    name: "KeePassXC-Browser",
    addonId: "keepassxc-browser@keepassxc.org",
    xpiUrl:
      "https://addons.mozilla.org/firefox/downloads/latest/keepassxc-browser/latest.xpi",
    url: "https://addons.mozilla.org/firefox/addon/keepassxc-browser/",
    icon: PASSWORD_MANAGER_ICONS.keepassxc,
    description:
      "Local offline vault integration for the KeePassXC desktop application.",
  }),
  Object.freeze({
    id: "onepassword",
    name: "1Password",
    addonId: "{d634138d-c276-4fc8-924b-40a0ea21d284}",
    xpiUrl:
      "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi",
    url: "https://addons.mozilla.org/firefox/addon/1password-x-password-manager/",
    icon: PASSWORD_MANAGER_ICONS.onepassword,
    description:
      "Cross-platform password & passkey manager for individuals and teams.",
  }),
]);

export function colorDotSvgDataUrl(hex, { size = 16, radius = 7 } = {}) {
  const safeHex = /^#[0-9a-fA-F]{6}$/.test(String(hex || "").trim())
    ? String(hex).trim()
    : "#6478f5";
  const center = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${center}" cy="${center}" r="${radius}" fill="${safeHex}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function accentSwatchSvgDataUrl(hex) {
  const safeHex = /^#[0-9a-fA-F]{6}$/.test(String(hex || "").trim())
    ? String(hex).trim()
    : "#6478f5";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="44" viewBox="0 0 96 44"><rect x="6" y="6" width="84" height="32" rx="10" fill="${safeHex}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Accent preset visual picker + custom hex color picker + reset button.
 */
export class ArgonAccentSwatches extends MozLitElement {
  static properties = {
    accent: { type: String },
    locale: { type: String },
  };

  constructor() {
    super();
    this.accent = "#6478f5";
    this.locale = "en-US";
    this.customization = null;
    this.appearance = null;
    this.onAccentChange = null;
    this.onReset = null;
  }

  createRenderRoot() {
    return this;
  }

  updated() {
    const activeHex = String(this.accent || "#6478f5").trim().toLowerCase();
    const matchingPreset = ACCENT_PRESETS.find((p) => p.hex === activeHex);
    const picker = this.querySelector("#accent-swatches");
    if (picker) {
      const expected = matchingPreset ? matchingPreset.hex : "";
      if (picker.value !== expected) {
        picker.value = expected;
      }
      for (const item of picker.querySelectorAll("moz-visual-picker-item")) {
        const isMatch = item.dataset.accentHex === activeHex;
        if (item.checked !== isMatch) {
          item.checked = isMatch;
        }
        item.toggleAttribute("checked", isMatch);
        item.setAttribute("aria-checked", String(isMatch));
      }
    }
    const colorInput = this.querySelector("#argon-custom-accent-color");
    if (colorInput && colorInput.value !== activeHex) {
      colorInput.value = activeHex;
    }
  }

  #commitAccent(rawHex) {
    const candidate = String(rawHex || "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(candidate)) return;
    if (this.customization?.setAccent) {
      this.customization.setAccent(candidate);
      this.accent = this.customization.accent;
    } else {
      try {
        window?.Services?.prefs?.setStringPref?.("argon.ui.accent", candidate);
      } catch {}
      this.accent = candidate;
    }
    const state = this.customization?.getState?.() ?? {
      density: "normal",
      accent: this.accent,
      cornerRadius: "default",
      compactHideBookmarks: true,
    };
    applyCustomizationToElement(document.documentElement, state);
    try {
      const enumerator = window?.Services?.wm?.getEnumerator?.("navigator:browser");
      while (enumerator?.hasMoreElements?.()) {
        const browserWin = enumerator.getNext();
        if (browserWin?.document?.documentElement) {
          applyCustomizationToElement(browserWin.document.documentElement, state);
        }
      }
    } catch {}
    this.onAccentChange?.(this.accent);
    this.requestUpdate();
  }

  #onSwatchItemClick = (hex, event) => {
    event.stopPropagation();
    this.#commitAccent(hex);
  };

  #onPresetChange = (event) => {
    event.stopPropagation();
    const item = event.target?.closest?.("moz-visual-picker-item");
    const next =
      item?.dataset?.accentHex ||
      event.currentTarget?.value ||
      event.target?.value;
    if (next) {
      this.#commitAccent(next);
    }
  };

  #onCustomColorChange = (event) => {
    event.stopPropagation();
    const next = event.currentTarget?.value || event.target?.value;
    if (next) {
      this.#commitAccent(next);
    }
  };

  #onResetClick = (event) => {
    event.stopPropagation();
    this.onReset?.();
    this.accent = this.customization?.accent || "#6478f5";
    this.requestUpdate();
  };

  render() {
    const loc = this.locale || resolveLocale(null, window);
    const activeHex = String(this.accent || "#6478f5").trim().toLowerCase();
    const matchingPreset = ACCENT_PRESETS.find((p) => p.hex === activeHex);

    return html`
      <div class="argon-accent-controls">
        <moz-visual-picker
          id="accent-swatches"
          class="argon-accent-picker"
          name="argon-accent-preset"
          .label=${t("settings.appearance.accent", null, loc)}
          .value=${matchingPreset ? matchingPreset.hex : ""}
          @change=${this.#onPresetChange}
        >
          ${ACCENT_PRESETS.map(
            (preset) => html`
              <moz-visual-picker-item
                class="swatch-btn setting-chooser-item"
                data-accent-hex=${preset.hex}
                value=${preset.hex}
                ?checked=${preset.hex === activeHex}
                .value=${preset.hex}
                .checked=${preset.hex === activeHex}
                .label=${preset.name}
                .imageSrc=${accentSwatchSvgDataUrl(preset.hex)}
                @click=${(e) => this.#onSwatchItemClick(preset.hex, e)}
              ></moz-visual-picker-item>
            `
          )}
        </moz-visual-picker>

        <div class="argon-inline-actions">
          <moz-input-color
            id="argon-custom-accent-color"
            name="argon-custom-accent"
            .value=${activeHex}
            .label=${activeHex.toUpperCase()}
            @input=${this.#onCustomColorChange}
            @change=${this.#onCustomColorChange}
          ></moz-input-color>
          <moz-button
            id="appearance-reset-btn"
            .label=${t("settings.appearance.reset", null, loc)}
            @click=${this.#onResetClick}
          ></moz-button>
        </div>
      </div>
    `;
  }
}

/**
 * DNS Provider & Encrypted Resolution (DoH) native control widget.
 */
export class ArgonDnsSettings extends MozLitElement {
  static properties = {
    dnsState: { type: Object },
    locale: { type: String },
  };

  constructor() {
    super();
    this.settingsController = null;
    this.dnsState = {
      providerId: "system",
      strict: false,
      customUri: "",
      mode: 5,
      activeUri: "",
    };
    this.locale = "en-US";
  }

  createRenderRoot() {
    return this;
  }

  #sync() {
    if (this.settingsController?.getDnsState) {
      this.dnsState = this.settingsController.getDnsState();
    }
  }

  #onProviderChange = (event) => {
    event.stopPropagation();
    const next = event.currentTarget?.value || event.target?.value;
    if (!next || !this.settingsController?.setDnsProvider) return;
    this.settingsController.setDnsProvider(next);
    this.#sync();
  };

  #onStrictToggle = (event) => {
    event.stopPropagation();
    const pressed = Boolean(event.currentTarget?.pressed ?? event.target?.pressed);
    this.settingsController?.setDnsStrict?.(pressed);
    this.#sync();
  };

  #onCustomUriChange = (event) => {
    event.stopPropagation();
    const val = String(event.currentTarget?.value ?? event.target?.value ?? "");
    this.settingsController?.setDnsCustomUri?.(val);
    this.#sync();
  };

  render() {
    const loc = this.locale || resolveLocale(null, window);
    const isPt = String(loc || "").startsWith("pt");
    const currentId = this.dnsState?.providerId || "system";
    const isCustom = currentId === "custom";
    const isSystem = currentId === "system";

    return html`
      <div class="argon-workspaces-stack">
        <moz-select
          id="settings-dns-provider"
          .label=${t("settings.dns.providerLabel", null, loc)}
          .value=${currentId}
          @change=${this.#onProviderChange}
        >
          ${DNS_PROVIDERS.map(
            (provider) => html`
              <moz-option
                value=${provider.id}
                .value=${provider.id}
                .label=${isPt ? provider.namePt : provider.name}
                .description=${isPt ? provider.descriptionPt : provider.description}
              ></moz-option>
            `
          )}
        </moz-select>

        ${isCustom
          ? html`
              <moz-input-text
                id="settings-dns-custom-uri"
                .label=${t("settings.dns.customLabel", null, loc)}
                placeholder="https://dns.example.com/dns-query"
                .value=${this.dnsState?.customUri || ""}
                @change=${this.#onCustomUriChange}
              ></moz-input-text>
              ${!isValidDohUri(this.dnsState?.customUri) ? html`<moz-message-bar type="warning"
                .message=${isPt ? "Informe uma URL HTTPS válida. O resolvedor anterior continua ativo até salvar uma URL válida." : "Enter a valid HTTPS URL. The previous resolver remains active until a valid URL is saved."}
              ></moz-message-bar>` : nothing}
            `
          : nothing}

        ${!isSystem
          ? html`
              <moz-toggle
                id="settings-dns-strict"
                ?pressed=${Boolean(this.dnsState?.strict)}
                .pressed=${Boolean(this.dnsState?.strict)}
                .label=${t("settings.dns.strictLabel", null, loc)}
                .description=${t("settings.dns.strictDesc", null, loc)}
                @toggle=${this.#onStrictToggle}
              ></moz-toggle>
            `
          : nothing}
      </div>
    `;
  }
}

/**
 * Recommended Password Managers 1-click installer widget (parity with Onboarding).
 */
export class ArgonPasswordManagers extends MozLitElement {
  static properties = {
    locale: { type: String },
    statuses: { type: Object, state: true },
  };

  constructor() {
    super();
    this.locale = "en-US";
    this.statuses = {};
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#refreshInstalled();
  }

  async #refreshInstalled() {
    const { addonManager } = resolveGeckoEnvironment(window);
    if (!addonManager?.getAddonByID) return;
    const next = { ...this.statuses };
    for (const pm of RECOMMENDED_PASSWORD_MANAGERS) {
      try {
        const addon = await addonManager.getAddonByID(pm.addonId);
        if (addon) next[pm.id] = "installed";
      } catch {}
    }
    this.statuses = next;
  }

  async #installManager(pm, event) {
    event.stopPropagation();
    const cur = this.statuses[pm.id];
    if (cur === "installing" || cur === "installed") return;
    const { addonManager, topChromeWindow, systemPrincipal } =
      resolveGeckoEnvironment(window);
    if (!addonManager?.getInstallForURL) {
      topChromeWindow?.openTrustedLinkIn?.(pm.url, "tab");
      return;
    }
    this.statuses = { ...this.statuses, [pm.id]: "installing" };
    try {
      const install = await addonManager.getInstallForURL(pm.xpiUrl, {
        name: pm.name,
      });
      install.addListener?.({
        onInstallEnded: () => {
          this.statuses = { ...this.statuses, [pm.id]: "installed" };
        },
        onInstallCancelled: () => {
          this.statuses = { ...this.statuses, [pm.id]: "idle" };
        },
        onInstallFailed: () => {
          this.statuses = { ...this.statuses, [pm.id]: "error" };
        },
        onDownloadFailed: () => {
          this.statuses = { ...this.statuses, [pm.id]: "error" };
        },
      });
      const targetBrowser =
        window?.docShell?.chromeEventHandler ??
        topChromeWindow?.gBrowser?.selectedBrowser ??
        null;
      if (
        targetBrowser &&
        systemPrincipal &&
        typeof addonManager.installAddonFromWebpage === "function"
      ) {
        addonManager.installAddonFromWebpage(
          "application/x-xpinstall",
          targetBrowser,
          systemPrincipal,
          install
        );
      } else if (typeof install.install === "function") {
        install.install();
      }
    } catch {
      this.statuses = { ...this.statuses, [pm.id]: "error" };
    }
  }

  render() {
    return html`
      <moz-box-group id="settings-password-managers-list" type="list">
        ${RECOMMENDED_PASSWORD_MANAGERS.map((pm) => {
          const state = this.statuses[pm.id] || "idle";
          const btnLabel =
            state === "installed"
              ? "Installed"
              : state === "installing"
                ? "Installing…"
                : state === "error"
                  ? "Retry"
                  : "Install";
          return html`
            <moz-box-item
              data-pm-id=${pm.id}
              layout="large-icon"
              .iconSrc=${pm.icon}
              .label=${pm.name}
              .description=${pm.description}
            >
              <moz-button
                slot="actions"
                size="small"
                type=${state === "installed" ? "default" : "primary"}
                ?disabled=${state === "installed" || state === "installing"}
                .label=${btnLabel}
                @click=${(e) => this.#installManager(pm, e)}
              ></moz-button>
            </moz-box-item>
          `;
        })}
      </moz-box-group>
    `;
  }
}

/**
 * Isolated Workspaces creation & list management using moz-input-text,
 * moz-input-color, moz-button, moz-box-group, moz-box-item, and moz-badge.
 */
export class ArgonWorkspacesManager extends MozLitElement {
  static properties = {
    workspacesState: { type: Object },
    draftName: { type: String, state: true },
    draftColor: { type: String, state: true },
    locale: { type: String },
  };

  constructor() {
    super();
    this.workspacesController = null;
    this.workspacesState = {
      enabled: true,
      autoUnload: false,
      activeId: "general",
      workspaces: [],
    };
    this.draftName = "";
    this.draftColor = "#6478f5";
    this.locale = "en-US";
  }

  createRenderRoot() {
    return this;
  }

  refreshState() {
    if (this.workspacesController?.getState) {
      this.workspacesState = this.workspacesController.getState();
    }
  }

  #onNameInput = (event) => {
    event.stopPropagation();
    this.draftName = event.target?.value ?? "";
  };

  #onColorChange = (event) => {
    event.stopPropagation();
    this.draftColor = event.target?.value || "#6478f5";
  };

  #onCreateSubmit = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nameEl = this.querySelector("#new-workspace-name");
    const colorEl = this.querySelector("#new-workspace-color");
    const name = String(nameEl?.value ?? this.draftName ?? "").trim();
    if (!name || !this.workspacesController?.createWorkspace) return;
    const color = String(colorEl?.value ?? this.draftColor ?? "#6478f5");
    this.workspacesController.createWorkspace({ name, color });
    this.draftName = "";
    if (nameEl) nameEl.value = "";
    this.refreshState();
  };

  #switchWorkspace(id, event) {
    event.stopPropagation();
    this.workspacesController?.setActiveWorkspace?.(id);
    this.refreshState();
  }

  #deleteWorkspace(id, event) {
    event.stopPropagation();
    this.workspacesController?.deleteWorkspace?.(id);
    this.refreshState();
  }

  render() {
    const loc = this.locale || resolveLocale(null, window);
    const list = this.workspacesState?.workspaces ?? [];

    return html`
      <div class="argon-workspaces-stack">
        <form
          id="create-workspace-form"
          class="argon-workspace-create-row"
          @submit=${this.#onCreateSubmit}
        >
          <moz-input-text
            id="new-workspace-name"
            class="argon-workspace-name-input"
            .label=${t("settings.workspaces.create", null, loc)}
            placeholder="Research, Design, Finance…"
            maxlength="40"
            .value=${this.draftName}
            @input=${this.#onNameInput}
            @change=${this.#onNameInput}
          ></moz-input-text>
          <moz-input-color
            id="new-workspace-color"
            .value=${this.draftColor}
            .label=${this.draftColor.toUpperCase()}
            @change=${this.#onColorChange}
          ></moz-input-color>
          <moz-button
            id="create-workspace-submit"
            type="primary"
            .label=${t("settings.workspaces.add", null, loc)}
            @click=${this.#onCreateSubmit}
          ></moz-button>
        </form>

        <moz-box-group id="workspaces-list" type="list">
          ${repeat(
            list,
            (ws) => ws.id,
            (ws, idx) => html`
              <moz-box-item
                class="workspace-item"
                data-workspace-id=${ws.id}
                .iconSrc=${colorDotSvgDataUrl(ws.color)}
                .label=${ws.name}
                .description=${`${ws.tabCount ?? 0} tab(s) · Alt+${idx + 1}`}
              >
                ${ws.active
                  ? html`<moz-badge
                      slot="actions"
                      label="Active"
                    ></moz-badge>`
                  : html`<moz-button
                      slot="actions"
                      size="small"
                      type="primary"
                      label="Switch"
                      @click=${(e) => this.#switchWorkspace(ws.id, e)}
                    ></moz-button>`}
                <moz-button
                  slot="actions"
                  size="small"
                  label="Delete"
                  title=${
                    list.length > 1 && ws.canDelete === false
                      ? t("settings.workspaces.deleteBlocked", null, loc)
                      : ""
                  }
                  ?disabled=${list.length <= 1 || ws.canDelete === false}
                  @click=${(e) => this.#deleteWorkspace(ws.id, e)}
                ></moz-button>
              </moz-box-item>
            `
          )}
        </moz-box-group>
        <p class="argon-workspaces-note">
          ${t("settings.workspaces.containerNote", null, loc)}
        </p>
      </div>
    `;
  }
}

/**
 * Argon Keyboard Shortcuts & Command Palette launcher using moz-button,
 * moz-button-group, moz-message-bar, moz-box-group, moz-box-item, and moz-badge.
 */
export class ArgonShortcutsList extends MozLitElement {
  static properties = {
    locale: { type: String },
    shortcuts: { type: Array },
    capturingId: { type: String, state: true },
    conflictInfo: { type: Object, state: true },
    statusMessage: { type: String, state: true },
  };

  constructor() {
    super();
    this.locale = "en-US";
    this.shortcutManager = null;
    this.shortcuts = [];
    this.onOpenCommandPalette = null;
    this.onOpenNativeKeyboard = null;
    this.onCaptureStateChange = null;
    this.capturingId = null;
    this.conflictInfo = null;
    this.statusMessage = "";
    this._ownedManager = null;
    this._unsubManager = null;
    this._captureListener = null;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#ensureSubscribed();
  }

  updated(changed) {
    super.updated(changed);
    if (changed.has("shortcutManager")) {
      this.#ensureSubscribed();
    }
  }

  disconnectedCallback() {
    this.#stopCapture();
    this._unsubManager?.();
    this._unsubManager = null;
    this._ownedManager?.dispose?.();
    this._ownedManager = null;
    super.disconnectedCallback();
  }

  #getManager() {
    if (this.shortcutManager) return this.shortcutManager;
    if (!this._ownedManager) {
      const { prefs } = resolveGeckoEnvironment(window);
      this._ownedManager = createShortcutManager({ preferences: prefs });
    }
    return this._ownedManager;
  }

  #ensureSubscribed() {
    const mgr = this.#getManager();
    this._unsubManager?.();
    this._unsubManager = mgr.onChange((list) => {
      this.shortcuts = list;
      this.requestUpdate();
    });
    this.shortcuts = mgr.getAll();
  }

  #stopCapture() {
    if (this._captureListener) {
      window.removeEventListener("keydown", this._captureListener, true);
      this._captureListener = null;
    }
    if (this.capturingId) {
      this.capturingId = null;
      this.onCaptureStateChange?.(false);
    }
  }

  #startCapture(entry, event) {
    event?.stopPropagation?.();
    if (entry.configurable === false) return;
    if (this.capturingId === entry.id) {
      this.#stopCapture();
      this.statusMessage = "";
      return;
    }

    this.#stopCapture();
    this.conflictInfo = null;
    this.statusMessage = "";
    this.capturingId = entry.id;
    this.onCaptureStateChange?.(true);

    const mgr = this.#getManager();
    this._captureListener = (keyEvent) => {
      if (
        keyEvent.key === "Control" ||
        keyEvent.key === "Shift" ||
        keyEvent.key === "Alt" ||
        keyEvent.key === "Meta" ||
        keyEvent.key === "OS" ||
        keyEvent.key === "Super"
      ) {
        return;
      }

      keyEvent.preventDefault();
      keyEvent.stopPropagation();

      if (
        keyEvent.key === "Escape" &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey &&
        !keyEvent.shiftKey
      ) {
        this.#stopCapture();
        this.statusMessage = "";
        return;
      }

      const combo = formatShortcutFromEvent(keyEvent, {
        allowNumberRange: Boolean(entry.allowNumberRange),
      });
      if (!combo) {
        this.statusMessage =
          "Include Ctrl, Alt, or Meta (or press a function key F1–F12). Press Esc to cancel.";
        return;
      }

      const conflict = mgr.findConflict(combo, entry.id);
      if (conflict) {
        this.#stopCapture();
        this.conflictInfo = {
          targetId: entry.id,
          targetTitle: entry.title,
          combo,
          conflictEntry: conflict,
        };
        return;
      }

      mgr.setShortcut(entry.id, combo);
      this.shortcuts = mgr.getAll();
      this.#stopCapture();
      this.statusMessage = "";
    };

    window.addEventListener("keydown", this._captureListener, true);
  }

  #handleClear(entry, event) {
    event?.stopPropagation?.();
    this.#stopCapture();
    this.conflictInfo = null;
    this.statusMessage = "";
    const mgr = this.#getManager();
    mgr.clearShortcut(entry.id);
    this.shortcuts = mgr.getAll();
  }

  #handleReset(entry, event) {
    event?.stopPropagation?.();
    this.#stopCapture();
    this.conflictInfo = null;
    this.statusMessage = "";
    const mgr = this.#getManager();
    mgr.resetShortcut(entry.id);
    this.shortcuts = mgr.getAll();
  }

  #handleResetAll = (event) => {
    event?.stopPropagation?.();
    this.#stopCapture();
    this.conflictInfo = null;
    this.statusMessage = "";
    const mgr = this.#getManager();
    mgr.resetAll();
    this.shortcuts = mgr.getAll();
  };

  #handleReplaceConflict = (event) => {
    event?.stopPropagation?.();
    if (!this.conflictInfo) return;
    const { targetId, combo, conflictEntry } = this.conflictInfo;
    const mgr = this.#getManager();
    if (conflictEntry?.configurable !== false) {
      mgr.clearShortcut(conflictEntry.id);
    }
    mgr.setShortcut(targetId, combo);
    this.conflictInfo = null;
    this.shortcuts = mgr.getAll();
  };

  #handleDismissConflict = (event) => {
    event?.stopPropagation?.();
    this.conflictInfo = null;
  };

  #handleOpenPalette = (event) => {
    event.stopPropagation();
    this.onOpenCommandPalette?.();
  };

  #handleOpenNativeKeyboard = (event) => {
    event.stopPropagation();
    if (typeof this.onOpenNativeKeyboard === "function") {
      this.onOpenNativeKeyboard();
      return;
    }
    const { topChromeWindow } = resolveGeckoEnvironment(window);
    topChromeWindow?.openTrustedLinkIn?.("about:keyboard", "tab");
  };

  render() {
    const loc = this.locale || resolveLocale(null, window);
    const list = this.shortcuts?.length
      ? this.shortcuts
      : SHORTCUT_DEFINITIONS.map((item) => ({
          ...item,
          combo: item.defaultCombo,
          isCustom: false,
        }));

    return html`
      <div class="argon-shortcuts-stack">
        <moz-button-group class="argon-shortcuts-toolbar">
          <moz-button
            id="settings-open-command-palette"
            type="primary"
            .label=${t("settings.shortcuts.openPalette", null, loc)}
            @click=${this.#handleOpenPalette}
          ></moz-button>
          <moz-button
            id="settings-open-native-keyboard"
            .label=${t("settings.shortcuts.nativeKeyboard", null, loc)}
            @click=${this.#handleOpenNativeKeyboard}
          ></moz-button>
          <moz-button
            id="settings-reset-all-shortcuts"
            .label=${t("settings.shortcuts.resetAll", null, loc)}
            @click=${this.#handleResetAll}
          ></moz-button>
        </moz-button-group>

        ${this.statusMessage
          ? html`
              <moz-message-bar
                id="argon-shortcut-status-bar"
                type="info"
                .message=${this.statusMessage}
              ></moz-message-bar>
            `
          : nothing}

        ${this.conflictInfo
          ? html`
              <moz-message-bar
                id="argon-shortcut-conflict-bar"
                type="warning"
                .heading=${`Shortcut Conflict: ${this.conflictInfo.combo}`}
                .message=${`${this.conflictInfo.combo} is currently assigned to "${this.conflictInfo.conflictEntry.title}".`}
              >
                <moz-button
                  slot="actions"
                  id="argon-shortcut-replace-btn"
                  size="small"
                  type="primary"
                  label="Replace"
                  @click=${this.#handleReplaceConflict}
                ></moz-button>
                <moz-button
                  slot="actions"
                  id="argon-shortcut-cancel-conflict-btn"
                  size="small"
                  label="Cancel"
                  @click=${this.#handleDismissConflict}
                ></moz-button>
              </moz-message-bar>
            `
          : nothing}

        <moz-box-group id="argon-shortcuts-box-group" type="list">
          ${list.map((entry) => {
            const isCapturing = this.capturingId === entry.id;
            const badgeLabel = isCapturing
              ? t("settings.shortcuts.pressKeys", null, loc)
              : entry.combo || t("settings.shortcuts.unassigned", null, loc);
            return html`
              <moz-box-item
                data-shortcut-id=${entry.id}
                .label=${entry.title}
                .description=${entry.description}
              >
                <moz-badge
                  slot="actions"
                  .label=${badgeLabel}
                ></moz-badge>
                ${entry.configurable !== false
                  ? html`
                      <moz-button
                        slot="actions"
                        size="small"
                        type=${isCapturing ? "primary" : "default"}
                        data-shortcut-action="record"
                        data-argon-shortcut-capture=${isCapturing ? "true" : "false"}
                        .label=${isCapturing
                          ? t("settings.shortcuts.cancel", null, loc)
                          : t("settings.shortcuts.record", null, loc)}
                        @click=${(e) => this.#startCapture(entry, e)}
                      ></moz-button>
                      <moz-button
                        slot="actions"
                        size="small"
                        data-shortcut-action="clear"
                        ?disabled=${!entry.combo}
                        .label=${t("settings.shortcuts.clear", null, loc)}
                        @click=${(e) => this.#handleClear(entry, e)}
                      ></moz-button>
                      <moz-button
                        slot="actions"
                        size="small"
                        data-shortcut-action="reset"
                        ?disabled=${!entry.isCustom}
                        .label=${t("settings.shortcuts.reset", null, loc)}
                        @click=${(e) => this.#handleReset(entry, e)}
                      ></moz-button>
                    `
                  : nothing}
              </moz-box-item>
            `;
          })}
        </moz-box-group>
      </div>
    `;
  }
}

/**
 * Chromium Extension Bridge workbench using moz-segmented-control, moz-textarea,
 * moz-button, moz-button-group, moz-message-bar, moz-fieldset, moz-box-group,
 * moz-box-item, and moz-badge.
 */
export class ArgonExtensionBridge extends MozLitElement {
  static properties = {
    activePreset: { type: String, state: true },
    manifestText: { type: String, state: true },
    adaptation: { type: Object, state: true },
    errorMessage: { type: String, state: true },
    installLabel: { type: String, state: true },
    installDisabled: { type: Boolean, state: true },
    hasAdaptedXpi: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.activePreset = "mv3-worker";
    this.manifestText = JSON.stringify(
      SAMPLE_BRIDGE_MANIFESTS["mv3-worker"],
      null,
      2
    );
    this.adaptation = adaptChromeManifest(SAMPLE_BRIDGE_MANIFESTS["mv3-worker"]);
    this.errorMessage = "";
    this.installLabel = "Install Adapted Package";
    this.installDisabled = false;
    this.hasAdaptedXpi = false;
    this.adaptedXpiBytes = null;
  }

  createRenderRoot() {
    return this;
  }

  #readEditorText() {
    const editor = this.querySelector("#manifest-json-input");
    return typeof editor?.value === "string" ? editor.value : this.manifestText;
  }

  #analyzeText(rawText) {
    this.manifestText = rawText;
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      this.errorMessage = `JSON Parse Error: ${err.message}`;
      this.adaptation = null;
      return null;
    }
    this.errorMessage = "";
    const result = adaptChromeManifest(parsed);
    this.adaptation = result;
    return result;
  }

  #onPresetChange = (event) => {
    event.stopPropagation();
    const key = event.target?.value;
    const preset = SAMPLE_BRIDGE_MANIFESTS[key];
    if (!preset) return;
    this.activePreset = key;
    this.adaptedXpiBytes = null;
    this.hasAdaptedXpi = false;
    const formatted = JSON.stringify(preset, null, 2);
    const editor = this.querySelector("#manifest-json-input");
    if (editor) editor.value = formatted;
    this.#analyzeText(formatted);
  };

  #onEditorInput = (event) => {
    event.stopPropagation();
    this.manifestText = event.target?.value ?? "";
  };

  #onAnalyzeClick = (event) => {
    event.stopPropagation();
    this.#analyzeText(this.#readEditorText());
  };

  #onDownloadClick = (event) => {
    event.stopPropagation();
    const result = this.#analyzeText(this.#readEditorText());
    if (!result?.adaptedManifest) return;
    const jsonText = `${JSON.stringify(result.adaptedManifest, null, 2)}\n`;
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
    link.href = url;
    link.download = "manifest.adapted.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  #onTriggerUpload = (event) => {
    event.stopPropagation();
    this.querySelector("#extension-file-input")?.click();
  };

  #onFileChange = async (event) => {
    event.stopPropagation();
    const input = event.target;
    const file = input?.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (file.name.endsWith(".json")) {
      const text = new TextDecoder("utf-8").decode(bytes);
      this.adaptedXpiBytes = null;
      this.hasAdaptedXpi = false;
      const editor = this.querySelector("#manifest-json-input");
      if (editor) editor.value = text;
      this.#analyzeText(text);
      return;
    }

    try {
      const archiveResult = await inspectAndAdaptExtensionArchive(bytes);
      const formatted = JSON.stringify(archiveResult.rawManifest, null, 2);
      this.manifestText = formatted;
      const editor = this.querySelector("#manifest-json-input");
      if (editor) editor.value = formatted;
      this.errorMessage = "";
      this.adaptation = archiveResult.adaptation;
      this.adaptedXpiBytes = archiveResult.adaptedXpiBytes;
      this.hasAdaptedXpi = Boolean(archiveResult.adaptedXpiBytes);
      this.installLabel = "Install Adapted Package";
      this.installDisabled = false;
    } catch (err) {
      this.errorMessage = `Archive Error: ${err.message}`;
      this.adaptation = null;
      this.adaptedXpiBytes = null;
      this.hasAdaptedXpi = false;
    }
  };

  #onInstallClick = async (event) => {
    event.stopPropagation();
    if (!this.adaptedXpiBytes) return;
    const { addonManager, topChromeWindow, systemPrincipal } =
      resolveGeckoEnvironment(window);

    if (addonManager?.getInstallForURL) {
      const blob = new Blob([this.adaptedXpiBytes], {
        type: "application/x-xpinstall",
      });
      const blobUrl = URL.createObjectURL(blob);
      try {
        this.installDisabled = true;
        this.installLabel = "Installing…";
        const install = await addonManager.getInstallForURL(blobUrl, {
          name:
            this.adaptation?.adaptedManifest?.name || "Adapted Extension",
        });
        install.addListener?.({
          onInstallEnded: () => {
            this.installLabel = "Installed";
            URL.revokeObjectURL(blobUrl);
          },
          onInstallCancelled: () => {
            this.installDisabled = false;
            this.installLabel = "Install Adapted Package";
            URL.revokeObjectURL(blobUrl);
          },
          onInstallFailed: () => {
            this.installDisabled = false;
            this.installLabel = "Retry Install";
            URL.revokeObjectURL(blobUrl);
          },
        });
        const targetBrowser =
          window?.docShell?.chromeEventHandler ??
          topChromeWindow?.gBrowser?.selectedBrowser ??
          null;
        if (
          targetBrowser &&
          systemPrincipal &&
          typeof addonManager.installAddonFromWebpage === "function"
        ) {
          addonManager.installAddonFromWebpage(
            "application/x-xpinstall",
            targetBrowser,
            systemPrincipal,
            install
          );
          return;
        }
        if (typeof install.install === "function") {
          install.install();
          return;
        }
      } catch {
        URL.revokeObjectURL(blobUrl);
      }
    }

    const blob = new Blob([this.adaptedXpiBytes], {
      type: "application/x-xpinstall",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
    link.href = url;
    link.download = `${this.adaptation?.extensionId || "adapted-extension"}.xpi`;
    link.click();
    URL.revokeObjectURL(url);
  };

  #renderReport() {
    if (this.errorMessage) {
      return html`
        <div id="extension-bridge-report" class="argon-bridge-report">
          <moz-message-bar
            type="error"
            .message=${this.errorMessage}
          ></moz-message-bar>
        </div>
      `;
    }

    const adaptation = this.adaptation;
    if (!adaptation) {
      return html`<div id="extension-bridge-report"></div>`;
    }

    const manifestName =
      adaptation.adaptedManifest?.name ||
      adaptation.initialAnalysis?.manifest?.name ||
      "Extension Manifest";
    const manifestVer =
      adaptation.adaptedManifest?.manifest_version ??
      adaptation.initialAnalysis?.manifest?.manifestVersion ??
      "?";
    const findings = adaptation.finalAnalysis?.findings ?? [];
    const adaptations = adaptation.adaptations ?? [];
    const assessment = adaptation.finalAnalysis?.assessment ?? "clean";
    const hasError = findings.some((f) => f.severity === "error");
    const barType = hasError
      ? "error"
      : findings.length > 0
        ? "warning"
        : "success";

    return html`
      <div id="extension-bridge-report" class="argon-bridge-report">
        <moz-message-bar
          type=${barType}
          .heading=${`${manifestName} (MV${manifestVer}) · Tier: ${adaptation.tier}`}
          .message=${`Static Assessment: ${assessment}`}
        ></moz-message-bar>

        ${adaptations.length > 0
          ? html`
              <moz-fieldset
                .label=${`Automatic Adaptations (${adaptations.length})`}
                headinglevel="4"
              >
                <moz-box-group type="list">
                  ${adaptations.map(
                    (item) => html`
                      <moz-box-item .label=${item.description}>
                        <moz-badge
                          slot="actions"
                          .label=${item.code}
                        ></moz-badge>
                      </moz-box-item>
                    `
                  )}
                </moz-box-group>
              </moz-fieldset>
            `
          : nothing}

        ${findings.length > 0
          ? html`
              <moz-fieldset
                .label=${`Diagnostic Findings (${findings.length})`}
                headinglevel="4"
              >
                <moz-box-group type="list">
                  ${findings.map(
                    (finding) => html`
                      <moz-box-item
                        .label=${finding.path}
                        .description=${finding.message}
                      >
                        <moz-badge
                          slot="actions"
                          .label=${finding.severity.toUpperCase()}
                        ></moz-badge>
                      </moz-box-item>
                    `
                  )}
                </moz-box-group>
              </moz-fieldset>
            `
          : html`
              <moz-box-group>
                <moz-box-item
                  label="No static compatibility issues detected after adaptation."
                ></moz-box-item>
              </moz-box-group>
            `}
      </div>
    `;
  }

  render() {
    return html`
      <div class="argon-bridge-stack">
        <div class="argon-bridge-toolbar">
          <moz-segmented-control
            id="extension-bridge-presets"
            name="argon-bridge-preset"
            .value=${this.activePreset}
            @change=${this.#onPresetChange}
          >
            <moz-segmented-control-item
              data-manifest-preset="mv3-worker"
              value="mv3-worker"
              label="MV3 Service Worker"
            ></moz-segmented-control-item>
            <moz-segmented-control-item
              data-manifest-preset="mv2-clean"
              value="mv2-clean"
              label="Clean MV2"
            ></moz-segmented-control-item>
            <moz-segmented-control-item
              data-manifest-preset="chrome-sidepanel"
              value="chrome-sidepanel"
              label="SidePanel + Offscreen"
            ></moz-segmented-control-item>
          </moz-segmented-control>

          <moz-button
            id="extension-import-btn"
            size="small"
            iconSrc="chrome://browser/skin/import.svg"
            label="Import .crx / .zip / manifest.json"
            @click=${this.#onTriggerUpload}
          ></moz-button>
          <input
            type="file"
            id="extension-file-input"
            accept=".json,.crx,.zip,.xpi"
            hidden
            @change=${this.#onFileChange}
          />
        </div>

        <moz-textarea
          id="manifest-json-input"
          class="argon-manifest-textarea"
          label="Source manifest.json"
          description="Paste a Chromium MV2/MV3 manifest or import a .crx/.zip archive to inspect and adapt it for Gecko."
          rows="12"
          spellcheck="false"
          .value=${this.manifestText}
          @input=${this.#onEditorInput}
          @change=${this.#onEditorInput}
        ></moz-textarea>

        <moz-button-group class="argon-bridge-actions">
          <moz-button
            id="analyze-manifest-btn"
            type="primary"
            label="Analyze & Adapt Manifest"
            @click=${this.#onAnalyzeClick}
          ></moz-button>
          <moz-button
            id="download-adapted-manifest-btn"
            label="Download Adapted JSON"
            @click=${this.#onDownloadClick}
          ></moz-button>
          <moz-button
            id="install-adapted-xpi-btn"
            type="primary"
            ?hidden=${!this.hasAdaptedXpi}
            ?disabled=${this.installDisabled}
            .label=${this.installLabel}
            @click=${this.#onInstallClick}
          ></moz-button>
        </moz-button-group>

        ${this.#renderReport()}
      </div>
    `;
  }
}

export function defineArgonSettingsWidgets(win = window) {
  const registry = win?.customElements ?? customElements;
  if (!registry.get("argon-accent-swatches")) {
    registry.define("argon-accent-swatches", ArgonAccentSwatches);
  }
  if (!registry.get("argon-dns-settings")) {
    registry.define("argon-dns-settings", ArgonDnsSettings);
  }
  if (!registry.get("argon-password-managers")) {
    registry.define("argon-password-managers", ArgonPasswordManagers);
  }
  if (!registry.get("argon-workspaces-manager")) {
    registry.define("argon-workspaces-manager", ArgonWorkspacesManager);
  }
  if (!registry.get("argon-shortcuts-list")) {
    registry.define("argon-shortcuts-list", ArgonShortcutsList);
  }
  if (!registry.get("argon-extension-bridge")) {
    registry.define("argon-extension-bridge", ArgonExtensionBridge);
  }
}
