// SPDX-License-Identifier: MIT
// Extend the native top-level preferences document, not a second preferences
// implementation. Firefox retains its pane registry, bindings, search, history,
// policies, localization, feature gates and privileged subdialogs.
import { mountArgonSettings } from "./settings.mjs";
import "chrome://browser/content/argon/customization.mjs";
import "chrome://browser/content/argon/workspaces.mjs";
import "chrome://browser/content/argon/compatibility-adapter.mjs";
import "chrome://browser/content/argon/extension-installer.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const RESOURCE_ROOT = "chrome://browser/content/argon/";
const PANES = Object.freeze({
  appearance: ["paneArgonAppearance", "Argon Appearance", "chrome://global/skin/icons/eye.svg"],
  workspaces: ["paneWorkspaces", "Workspaces & Tabs", "chrome://browser/skin/preferences/category-general.svg"],
  extensions: ["paneExtensions", "Extension Bridge", "chrome://mozapps/skin/extensions/extension.svg"],
  privacy: ["paneHardening", "Privacy Hardening", "chrome://browser/skin/preferences/category-privacy-security.svg"],
  shortcuts: ["paneShortcuts", "Shortcuts & Commands", "chrome://global/skin/icons/cursor-arrow.svg"],
});

export async function initializeArgonPreferences(doc, win) {
  const categories = doc.getElementById("categories");
  const main = doc.getElementById("mainPrefPane");
  if (!categories || !main || doc.documentElement.hasAttribute("data-argon-settings")) {
    throw new Error("Argon settings requires an uninitialized native preferences document");
  }

  // Parse only trusted, packaged markup. Never execute the template's scripts
  // or replace native controls with serialized copies (that loses bindings).
  const response = await win.fetch(`${RESOURCE_ROOT}settings-content.html`);
  if (!response.ok) throw new Error("Could not load the packaged Argon settings content");
  const template = new win.DOMParser().parseFromString(await response.text(), "text/html");
  const brand = template.querySelector(".sidebar-brand");
  const footer = template.querySelector(".sidebar-footer");
  if (!brand || !footer) throw new Error("Incomplete Argon settings template");

  const styles = ["tokens.css", "settings.css", "settings-native.css"].map(name =>
    new Promise((resolve, reject) => {
      const link = doc.createElementNS(HTML_NS, "link");
      link.rel = "stylesheet";
      link.href = `${RESOURCE_ROOT}${name}`;
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", () => reject(new Error(`Missing settings stylesheet: ${name}`)), { once: true });
      doc.head.append(link);
    })
  );

  const sidebar = doc.createElementNS(HTML_NS, "aside");
  sidebar.id = "argon-settings-app";
  sidebar.className = "settings-sidebar";
  sidebar.setAttribute("aria-label", "Browser Settings");
  categories.before(sidebar);
  sidebar.append(doc.importNode(brand, true), categories, doc.importNode(footer, true));
  sidebar.parentElement.classList.add("argon-preferences-layout");

  const divider = doc.createElementNS(HTML_NS, "hr");
  divider.className = "argon-nav-divider";
  categories.append(divider);
  for (const [section, [category, label, icon]] of Object.entries(PANES)) {
    const source = template.querySelector(`[data-section="${section}"]`);
    if (!source) throw new Error(`Missing Argon settings section: ${section}`);
    const pane = doc.importNode(source, true);
    pane.dataset.category = category;
    pane.classList.add("argon-native-section");
    pane.classList.remove("visible");
    pane.removeAttribute("inert");
    pane.hidden = true;
    // The native router/search owns visibility and keyboard navigation.
    pane.removeAttribute("role");
    main.append(pane);

    const button = doc.createElementNS(HTML_NS, "moz-page-nav-button");
    button.id = `category-argon-${section}`;
    button.setAttribute("view", category);
    button.textContent = label;
    button.title = label;
    button.setAttribute("iconsrc", icon);
    categories.append(button);
    win.register_module(category, { init() {} });
  }

  await win.customElements.whenDefined("moz-page-nav");
  await categories.updateComplete;
  const navStyle = doc.createElementNS(HTML_NS, "link");
  navStyle.rel = "stylesheet";
  navStyle.href = `${RESOURCE_ROOT}settings-native.css`;
  styles.push(new Promise((resolve, reject) => {
    navStyle.addEventListener("load", resolve, { once: true });
    navStyle.addEventListener("error", reject, { once: true });
  }));
  categories.shadowRoot.append(navStyle);

  doc.documentElement.setAttribute("data-argon-settings", "true");
  await Promise.all(styles);
  win.ArgonSettings = await mountArgonSettings(doc, win, { nativeNavigation: true });
  doc.documentElement.setAttribute("data-argon-settings-ready", "true");
}
