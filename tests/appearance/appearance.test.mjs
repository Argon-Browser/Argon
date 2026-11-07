import assert from "node:assert/strict";
import test from "node:test";

async function subject() {
  try {
    return await import("../../argon/preferences/appearance.mjs");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

class Preferences {
  values = new Map();
  observers = new Set();
  getStringPref(key, fallback) { return this.values.get(key) ?? fallback; }
  setStringPref(key, value) {
    this.values.set(key, value);
    for (const observer of this.observers) observer.observe(null, "nsPref:changed", key);
  }
  addObserver(prefix, observer) { this.observers.add(observer); }
  removeObserver(prefix, observer) { this.observers.delete(observer); }
}

function environment() {
  const preferences = new Preferences();
  const root = { dataset: {} };
  const media = new EventTarget();
  media.matches = false;
  const layouts = [];
  return { preferences, root, media, layouts, setVerticalTabs: value => layouts.push(value) };
}

test("appearance starts in system light mode with horizontal native tabs", async () => {
  const { createAppearanceController } = await subject();
  assert.equal(typeof createAppearanceController, "function", "Appearance controller is implemented");
  const env = environment();
  const controller = createAppearanceController(env);
  assert.equal(controller.theme, "system");
  assert.equal(controller.effectiveTheme, "light");
  assert.equal(controller.layout, "horizontal");
  assert.deepEqual(env.root.dataset, {
    argonTheme: "system", argonColorScheme: "light", argonTabs: "horizontal",
  });
  assert.deepEqual(env.layouts, [false]);
  controller.dispose();
});

test("theme changes persist and restore without a browser restart", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  const controller = createAppearanceController(env);
  assert.equal(typeof controller.setTheme, "function");
  for (const theme of ["dark", "light", "system"]) {
    controller.setTheme(theme);
    assert.equal(controller.theme, theme);
    assert.equal(env.preferences.getStringPref("argon.theme"), theme);
    assert.equal(env.root.dataset.argonColorScheme, theme === "system" ? "light" : theme);
  }
  controller.setTheme("dark");
  controller.dispose();
  const restored = createAppearanceController(env);
  assert.equal(restored.theme, "dark");
  assert.equal(env.root.dataset.argonColorScheme, "dark");
  restored.dispose();
});

test("layout changes use native tabs and persist the choice", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  const controller = createAppearanceController(env);
  assert.equal(typeof controller.setLayout, "function");
  controller.setLayout("vertical");
  assert.equal(controller.layout, "vertical");
  assert.equal(env.root.dataset.argonTabs, "vertical");
  assert.equal(env.layouts.at(-1), true);
  controller.dispose();
  const restored = createAppearanceController(env);
  assert.equal(restored.layout, "vertical");
  restored.setLayout("horizontal");
  assert.equal(env.layouts.at(-1), false);
  restored.dispose();
});

test("external preference changes synchronize open windows and disposal removes observers", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  const first = createAppearanceController(env);
  const secondRoot = { dataset: {} };
  const second = createAppearanceController({ ...env, root: secondRoot });
  env.preferences.setStringPref("argon.theme", "dark");
  env.preferences.setStringPref("argon.tabs.layout", "vertical");
  assert.equal(first.theme, "dark");
  assert.equal(secondRoot.dataset.argonColorScheme, "dark");
  assert.equal(second.layout, "vertical");
  first.dispose();
  second.dispose();
  assert.equal(env.preferences.observers.size, 0);
  env.preferences.setStringPref("argon.theme", "light");
  assert.equal(first.theme, "dark");
});

test("system theme follows OS changes while an explicit theme stays fixed", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  const controller = createAppearanceController(env);
  env.media.matches = true;
  env.media.dispatchEvent(new Event("change"));
  assert.equal(env.root.dataset.argonColorScheme, "dark");
  controller.setTheme("light");
  env.media.dispatchEvent(new Event("change"));
  assert.equal(env.root.dataset.argonColorScheme, "light");
  controller.setTheme("system");
  controller.dispose();
  env.media.matches = false;
  env.media.dispatchEvent(new Event("change"));
  assert.equal(env.root.dataset.argonColorScheme, "dark");
});

test("invalid appearance values cannot enter preferences or the DOM", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  env.preferences.setStringPref("argon.theme", "untrusted");
  env.preferences.setStringPref("argon.tabs.layout", "unsupported");
  const controller = createAppearanceController(env);
  assert.equal(controller.theme, "system");
  assert.equal(controller.layout, "horizontal");
  assert.throws(() => controller.setTheme("invalid"), RangeError);
  assert.throws(() => controller.setLayout("invalid"), RangeError);
  assert.throws(() => controller.setTheme(null), RangeError);
  env.preferences.setStringPref("argon.theme", "other");
  assert.equal(controller.theme, "system");
  controller.dispose();
});

test("state changes notify a subscriber so dependent UI can re-render", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  let notifications = 0;
  const snapshots = [];
  const controller = createAppearanceController({
    ...env,
    onChange: (state) => { notifications++; snapshots.push(state); },
  });
  assert.equal(notifications, 1, "Subscribers are notified of the initial state");
  assert.deepEqual(snapshots[0], { theme: "system", layout: "horizontal", effectiveTheme: "light" });
  controller.setTheme("dark");
  assert.equal(notifications, 2);
  assert.deepEqual(snapshots[1], { theme: "dark", layout: "horizontal", effectiveTheme: "dark" });
  controller.setLayout("vertical");
  assert.equal(notifications, 3);
  env.preferences.setStringPref("argon.theme", "light");
  assert.equal(notifications, 4, "Out-of-band preference changes notify subscribers");
  env.media.matches = true;
  env.media.dispatchEvent(new Event("change"));
  assert.equal(notifications, 5, "Operating system theme changes notify subscribers");
  controller.dispose();
  controller.setTheme("system");
  assert.equal(notifications, 5, "Disposed controllers stop notifying");
});

test("preference changes outside the argon namespace are ignored", async () => {
  const { createAppearanceController } = await subject();
  const env = environment();
  const controller = createAppearanceController(env);
  controller.setTheme("dark");
  // The observer is registered for the "argon." prefix only, so unrelated
  // preferences must never disturb appearance state.
  env.preferences.setStringPref("browser.ui.density", "compact");
  assert.equal(controller.theme, "dark");
  assert.equal(env.root.dataset.argonColorScheme, "dark");
  controller.dispose();
});

export { environment };
