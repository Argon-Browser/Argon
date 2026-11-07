// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCENT_PRESETS,
  CORNER_RADII,
  DENSITIES,
  createCustomizationController,
  resolveAccentTokens,
} from "../../argon/design-system/customization.mjs";

class FakePrefs {
  strings = new Map();
  bools = new Map();
  observers = new Set();

  getStringPref(key, fallback) {
    return this.strings.has(key) ? this.strings.get(key) : fallback;
  }

  setStringPref(key, value) {
    this.strings.set(key, String(value));
    for (const obs of this.observers) {
      obs.observe(null, "nsPref:changed", key);
    }
  }

  getBoolPref(key, fallback) {
    return this.bools.has(key) ? this.bools.get(key) : fallback;
  }

  setBoolPref(key, value) {
    this.bools.set(key, Boolean(value));
    for (const obs of this.observers) {
      obs.observe(null, "nsPref:changed", key);
    }
  }

  addObserver(_prefix, obs) {
    this.observers.add(obs);
  }

  removeObserver(_prefix, obs) {
    this.observers.delete(obs);
  }
}

function createFakeRoot() {
  const props = new Map();
  return {
    dataset: {},
    style: {
      setProperty(name, value) {
        props.set(name, value);
      },
      removeProperty(name) {
        props.delete(name);
      },
      getPropertyValue(name) {
        return props.get(name) ?? "";
      },
    },
  };
}

test("customization controller initializes with clean defaults and updates density, accent, and corner radius live", () => {
  const preferences = new FakePrefs();
  const root = createFakeRoot();
  const snapshots = [];

  const controller = createCustomizationController({
    preferences,
    root,
    onChange: (state) => snapshots.push(state),
  });

  assert.equal(controller.density, "normal");
  assert.equal(controller.accent, "#6478f5");
  assert.equal(controller.cornerRadius, "default");
  assert.equal(root.dataset.argonDensity, undefined);
  assert.equal(root.style.getPropertyValue("--argon-accent"), "");

  // Toggle compact density
  assert.equal(controller.toggleCompactMode(), "compact");
  assert.equal(controller.density, "compact");
  assert.equal(root.dataset.argonDensity, "compact");

  // Update accent color by preset id and hex
  controller.setAccent("emerald");
  assert.equal(controller.accent, "#10b981");
  assert.equal(root.style.getPropertyValue("--argon-accent"), "#10b981");

  controller.setCornerRadius("relaxed");
  assert.equal(controller.cornerRadius, "relaxed");
  assert.equal(root.dataset.argonRadius, "relaxed");
  assert.equal(root.style.getPropertyValue("--argon-radius-lg"), "16px");

  // Reset back to defaults
  controller.resetDefaults();
  assert.equal(controller.density, "normal");
  assert.equal(controller.accent, "#6478f5");
  assert.equal(controller.cornerRadius, "default");
  assert.equal(root.dataset.argonDensity, undefined);
  assert.equal(root.style.getPropertyValue("--argon-accent"), "");

  assert.ok(snapshots.length >= 5);
  controller.dispose();
});

test("customization controller rejects invalid density, accent, and corner radius values", () => {
  const preferences = new FakePrefs();
  const root = createFakeRoot();
  const controller = createCustomizationController({ preferences, root });

  assert.ok(DENSITIES.includes("compact"));
  assert.ok(CORNER_RADII.includes("sharp"));
  assert.ok(ACCENT_PRESETS.length >= 6);

  assert.throws(() => controller.setDensity("ultra"), RangeError);
  assert.throws(() => controller.setAccent("not-a-color"), RangeError);
  assert.throws(() => controller.setCornerRadius("oval"), RangeError);

  const tokens = resolveAccentTokens("#8b5cf6");
  assert.equal(tokens.accent, "#8b5cf6");
  assert.match(tokens.strong, /^#[0-9a-f]{6}$/);

  controller.dispose();
});
