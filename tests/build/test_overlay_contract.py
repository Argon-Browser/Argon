"""Consistency between the packaged chrome wiring and the overlay description.

The browser suite exercises the modules through a test-only resource:// mapped
directory, which cannot prove that a packaged build would find them. These
tests cover the wiring itself: every chrome:// URL referenced by the window
hooks must be copied into the tree and packaged by the jar manifest, and the
preferences the controller reads must exist in the defaults file.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import support

ROOT = Path(__file__).resolve().parents[2]
OVERLAY = json.loads((ROOT / "config" / "overlay.json").read_text())
LOCK = json.loads((ROOT / "config" / "firefox.lock.json").read_text())
HOOKS = ROOT / "browser" / "base" / "content" / "argon-window-hooks.inc.xhtml"
PREFS = ROOT / "argon" / "preferences" / "argon-prefs.js"
CONTROLLER = ROOT / "browser" / "base" / "content" / "argon-controller.mjs"
APPEARANCE = ROOT / "argon" / "preferences" / "appearance.mjs"
MOZCONFIG = ROOT / "config" / "mozconfig"


def declared_prefs(text):
    """Map pref name -> "true"/"false" for boolean defaults.

    `sticky_pref("browser.uidensity", 0)` has no match, so the pattern is
    anchored on the bool literals; multi-line pref() calls are handled by
    allowing whitespace between the arguments.
    """
    return {
        name: value
        for name, value in re.findall(r'pref\("([\w.-]+)",\s*(true|false)\s*\)', text)
    }


class OverlayContractTests(unittest.TestCase):
    def setUp(self):
        self.hooks_text = HOOKS.read_text(encoding="utf-8")
        self.referenced = re.findall(r"chrome://browser/content/argon/([\w./-]+)", self.hooks_text)

    def test_nova_ui_preferences_are_disabled_by_default(self):
        """Argon ships its own chrome, so upstream Nova defaults must not survive.

        The overlay must override every Nova flag that upstream defaults to
        true; a Nova UI that rewrites the chrome or the New Tab page would
        fight Argon's own appearance controller for the same surfaces.
        """
        prefs_text = PREFS.read_text(encoding="utf-8")
        declared = declared_prefs(prefs_text)
        reference = (ROOT / "config" / "source-reference" / "browser" / "app" /
                     "profile" / "firefox.js").read_text(encoding="utf-8")
        upstream = declared_prefs(reference)
        for name in support.NOVA_PREFS:
            self.assertEqual(upstream.get(name), "true",
                             f"{name} is not enabled upstream; keep the list current")
            self.assertIn(name, declared, f"{name} has no Argon default")
            self.assertEqual(declared[name], "false",
                             f"{name} must default to false in Argon")

    def test_sponsored_shortcuts_are_disabled_by_default(self):
        """Argon must not request or render sponsored shortcuts.

        Upstream enables the New Tab advertisement services and the user-facing
        switch. Every source defaults to false independently of upstream;
        existing user preferences can still override these defaults.
        """
        prefs_text = PREFS.read_text(encoding="utf-8")
        declared = declared_prefs(prefs_text)
        reference = (ROOT / "config" / "source-reference" / "browser" / "app" /
                     "profile" / "firefox.js").read_text(encoding="utf-8")
        upstream = declared_prefs(reference)
        for name in support.SPONSORED_SHORTCUT_PREFS:
            self.assertIn(name, declared, f"{name} has no Argon default")
            self.assertEqual(declared[name], "false",
                             f"{name} must default to false in Argon")
        for name in ("browser.topsites.contile.enabled",
                     "browser.newtabpage.activity-stream.unifiedAds.tiles.enabled"):
            self.assertEqual(upstream.get(name), "true",
                             f"{name} is not enabled upstream; keep the list current")

    def test_remote_rollouts_cannot_restore_sponsored_shortcut_defaults(self):
        declared = declared_prefs(PREFS.read_text(encoding="utf-8"))
        self.assertEqual(declared.get("nimbus.rollouts.enabled"), "false",
                         "Remote rollouts must not re-enable sponsored shortcuts")

    def test_newtab_widgets_and_recommended_stories_are_disabled_by_default(self):
        """New Tab widgets and recommended stories must default to off.

        The pinned upstream revision is a Nightly tree, which turns on every
        widget by default unless marketGate enforcement and the per-widget
        defaults are explicitly set in firefox.js.
        """
        declared = declared_prefs(PREFS.read_text(encoding="utf-8"))
        for name in (*support.NEWTAB_WIDGET_PREFS, *support.NEWTAB_STORIES_PREFS):
            self.assertIn(name, declared, f"{name} has no Argon default")
            self.assertEqual(declared[name], "false",
                             f"{name} must default to false in Argon")
        self.assertEqual(
            declared.get("browser.newtabpage.activity-stream.widgets.marketGate.enforceOnNightly"),
            "true",
            "Nightly builds must not bypass widget gating to re-enable widgets",
        )

    def test_the_sponsored_shortcuts_control_is_removed_from_new_tab_preferences(self):
        """Defaulting the pref to false is not enough while the UI can undo it.

        The New Tab settings pane is generated from AboutPreferences.sys.mjs.
        Hiding the setting and removing its template row makes the control
        unreachable, and the "Support Firefox" master toggle no longer writes
        the shortcut pref.
        """
        path = "browser/extensions/newtab/lib/AboutPreferences.sys.mjs"
        hook = next((h for h in OVERLAY["hooks"] if h["path"] == path), None)
        self.assertIsNotNone(hook, "the New Tab preferences module is not patched")
        assert hook is not None
        self.assertIn(path, LOCK["hooks"], "the patched module has no pinned upstream hash")
        self.assertEqual(hook.get("resource"),
                         "chrome/browser/builtin-addons/newtab/lib/AboutPreferences.sys.mjs",
                         "The development browser must apply the same settings patch")
        replacements = hook.get("replacements") or []
        self.assertEqual(len(replacements), 3, "expected setting, master toggle, and row edits")
        added = "\n".join(item["new"] for item in replacements)
        removed = "\n".join(item["old"] for item in replacements)
        self.assertIn("visible: () => false", added)
        self.assertIn("onUserChange(value, { sponsoredStories })", added)
        self.assertNotIn("sponsoredShortcuts.value", added)
        self.assertIn("home-prefs-shortcuts-by-option-sponsored-srd", removed)
        self.assertNotIn("home-prefs-shortcuts-by-option-sponsored-srd", added)

    def test_window_hooks_reference_argon_resources(self):
        self.assertTrue(self.referenced, "window hooks must load Argon resources")
        self.assertIn("tokens.css", self.referenced)
        self.assertIn("argon.css", self.referenced)
        self.assertIn("argon-controller.mjs", self.referenced)

    def test_every_referenced_resource_is_copied_into_the_tree(self):
        copied = {Path(entry["to"]).relative_to("browser/base/content/argon").as_posix(): entry for entry in OVERLAY["files"]}
        for name in self.referenced:
            self.assertIn(name, copied, f"{name} is referenced but never copied by the overlay")
            self.assertTrue(Path(copied[name]["to"]).is_relative_to("browser/base/content/argon"),
                             f"{name} must land in the packaged argon directory")
            self.assertTrue((ROOT / copied[name]["from"]).is_file(),
                            f"{copied[name]['from']} is missing from the repository")

    def test_every_referenced_resource_is_packaged_by_the_jar_hook(self):
        jar_hook = next(hook for hook in OVERLAY["hooks"] if hook["path"] == "browser/base/jar.mn")
        packaged = {Path(entry["source"]).relative_to("content/argon").as_posix() for entry in jar_hook["entries"]}
        for name in self.referenced:
            self.assertIn(name, packaged, f"{name} is not listed in the jar.mn overlay entries")
        for entry in jar_hook["entries"]:
            self.assertTrue(entry["source"].startswith("content/argon/"),
                            "jar.mn entries must point inside the packaged argon directory")

    def test_relative_module_dependencies_are_copied_and_packaged(self):
        """A window hook is unusable if one of its transitive imports is absent."""
        copied = {Path(entry["to"]).relative_to("browser/base/content/argon").as_posix(): ROOT / entry["from"] for entry in OVERLAY["files"]}
        jar_hook = next(hook for hook in OVERLAY["hooks"] if hook["path"] == "browser/base/jar.mn")
        packaged = {Path(entry["source"]).relative_to("content/argon").as_posix() for entry in jar_hook["entries"]}
        pending = [name for name in self.referenced if name.endswith(".mjs")]
        visited = set()
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            self.assertIn(name, copied, f"{name} is imported but never copied by the overlay")
            self.assertIn(name, packaged, f"{name} is imported but never packaged in jar.mn")
            imports = re.findall(r'(?:from\s*|import\s*\()\s*[\'"]\./([^\'"]+)',
                                 copied[name].read_text(encoding="utf-8"))
            pending.extend((Path(name).parent / item).as_posix() for item in imports)

    def test_the_preference_defaults_cover_every_preference_the_controller_reads(self):
        prefs_text = PREFS.read_text(encoding="utf-8")
        declared = set(re.findall(r'pref\("([\w.]+)"', prefs_text))
        used = set(re.findall(r'"argon\.[\w.]+"', APPEARANCE.read_text(encoding="utf-8")))
        used = {name.strip('"') for name in used}
        self.assertTrue(used, "the appearance controller must read argon.* preferences")
        for name in used:
            self.assertIn(name, declared, f"{name} is read by the controller but has no default")

    def test_the_controller_registers_only_on_browser_windows(self):
        source = CONTROLLER.read_text(encoding="utf-8")
        self.assertIn('getElementById?.("nav-bar")', source,
                      "auto-install must be gated on a browser chrome window")
        self.assertIn("ArgonAppearance", source, "double installation must be guarded")

    def test_the_overlay_does_not_disable_security_preferences(self):
        forbidden = re.compile(
            r"xpinstall\.signatures|security\.sandbox|browser\.safe_mode"
            r"|devtools\.selfxss\.count",
        )
        combined = PREFS.read_text(encoding="utf-8") + self.hooks_text
        self.assertIsNone(forbidden.search(combined),
                          "the overlay must not relax upstream security behaviour")

    def test_antifingerprint_engine_defaults_to_ghostprint(self):
        prefs_text = PREFS.read_text(encoding="utf-8")
        self.assertIn('pref("argon.antifingerprint.engine", "ghostprint");', prefs_text)
        self.assertIn('pref("argon.ghostprint.enabled", true);', prefs_text)
        self.assertIn('pref("privacy.resistFingerprinting", false);', prefs_text)

    def test_the_build_configuration_does_not_relax_add_on_signing(self):
        mozconfig = MOZCONFIG.read_text(encoding="utf-8")
        active = "\n".join(line for line in mozconfig.splitlines()
                           if not line.lstrip().startswith("#"))
        for flag in ("MOZ_REQUIRE_SIGNING", "--with-unsigned-addon-scopes",
                     "--allow-addon-sideload", "--enable-unverified-updates", "MOZILLA_OFFICIAL"):
            self.assertNotIn(flag, active, f"{flag} must not be set by the Argon build")

    def test_identity_hooks_only_touch_the_vendor_and_profile(self):
        hook = next(h for h in OVERLAY["hooks"] if h["path"] == "browser/moz.configure")
        self.assertEqual(hook["replace_line"], 'imply_option("MOZ_APP_VENDOR", "Mozilla")')
        self.assertEqual(
            hook["lines"],
            [
                'imply_option("MOZ_APP_VENDOR", "Argon")',
                'imply_option("MOZ_APP_PROFILE", "argon")',
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
