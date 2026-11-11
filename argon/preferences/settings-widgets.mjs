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

import { ACCENT_PRESETS } from "chrome://browser/content/argon/customization.mjs";
import { adaptChromeManifest } from "chrome://browser/content/argon/compatibility-adapter.mjs";
import { inspectAndAdaptExtensionArchive } from "chrome://browser/content/argon/extension-installer.mjs";
import { resolveLocale, t } from "chrome://browser/content/argon/i18n.mjs";
import {
  SAMPLE_BRIDGE_MANIFESTS,
  SETTINGS_SHORTCUTS,
  resolveGeckoEnvironment,
} from "./settings.mjs";

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
    this.onReset = null;
  }

  createRenderRoot() {
    return this;
  }

  #onPresetChange = (event) => {
    event.stopPropagation();
    const next = event.target?.value;
    if (next && this.customization?.setAccent) {
      this.customization.setAccent(next);
      this.accent = this.customization.accent;
    }
  };

  #onCustomColorChange = (event) => {
    event.stopPropagation();
    const next = event.target?.value;
    if (next && this.customization?.setAccent) {
      this.customization.setAccent(next);
      this.accent = this.customization.accent;
    }
  };

  #onResetClick = (event) => {
    event.stopPropagation();
    this.onReset?.();
  };

  render() {
    const loc = this.locale || resolveLocale(null, window);
    const activeHex = String(this.accent || "#6478f5").toLowerCase();
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
                .value=${preset.hex}
                .label=${preset.name}
                .imageSrc=${accentSwatchSvgDataUrl(preset.hex)}
              ></moz-visual-picker-item>
            `
          )}
        </moz-visual-picker>

        <div class="argon-inline-actions">
          <moz-input-color
            id="argon-custom-accent-color"
            .value=${activeHex}
            .label=${activeHex.toUpperCase()}
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
                  ?disabled=${list.length <= 1}
                  @click=${(e) => this.#deleteWorkspace(ws.id, e)}
                ></moz-button>
              </moz-box-item>
            `
          )}
        </moz-box-group>
      </div>
    `;
  }
}

/**
 * Argon Keyboard Shortcuts & Command Palette launcher using moz-button,
 * moz-box-group, moz-box-item, and moz-badge.
 */
export class ArgonShortcutsList extends MozLitElement {
  static properties = {
    locale: { type: String },
  };

  constructor() {
    super();
    this.locale = "en-US";
    this.onOpenCommandPalette = null;
  }

  createRenderRoot() {
    return this;
  }

  #handleOpenPalette = (event) => {
    event.stopPropagation();
    this.onOpenCommandPalette?.();
  };

  render() {
    return html`
      <div class="argon-shortcuts-stack">
        <div>
          <moz-button
            id="settings-open-command-palette"
            type="primary"
            label="Open Command Palette"
            @click=${this.#handleOpenPalette}
          ></moz-button>
        </div>

        <moz-box-group id="argon-shortcuts-box-group" type="list">
          ${SETTINGS_SHORTCUTS.map(
            (entry) => html`
              <moz-box-item
                data-shortcut-id=${entry.id}
                .label=${entry.title}
                .description=${entry.description}
              >
                <moz-badge
                  slot="actions"
                  .label=${entry.shortcut}
                ></moz-badge>
              </moz-box-item>
            `
          )}
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
