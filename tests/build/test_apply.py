"""Behavior of `scripts/argon.py apply` against a stand-in checkout.

The hooks are patched in place, so the tests pin the three properties that make
the result usable: the block is idempotent, each block is valid for its host
file's syntax, and drift in an upstream hook fails closed.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import support


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="argon-apply-")
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        self.source = self.workspace / "source"
        support.make_source_tree(self.source)
        support.write_source_info(self.workspace)

    def tearDown(self):
        self._tmp.cleanup()

    def apply(self):
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_previous_sponsor_overlay_migrates_without_accepting_source_drift(self):
        overlay = json.loads((support.REPO / "config/overlay.json").read_text())
        hook = next(h for h in overlay["hooks"] if h["path"] == support.NEWTAB_PREFERENCES)
        target = self.source / support.NEWTAB_PREFERENCES
        previous = target.read_text()
        for replacement in hook["previous_replacements"]:
            previous = previous.replace(replacement["old"], replacement["new"], 1)
        target.write_text(previous)
        self.apply()
        self.assertNotIn('subcategory: "support-firefox"', target.read_text())
        target.write_text(previous + "\n// unexpected upstream drift\n")
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("drift", result.stderr)

    def test_overlay_files_and_branding_are_copied_into_the_tree(self):
        self.apply()
        for name in ("tokens.css", "argon.css", "argon-controller.mjs", "appearance.mjs"):
            target = self.source / "browser/base/content/argon" / name
            self.assertTrue(target.is_file(), f"missing {name}")
        self.assertTrue((self.source / "browser/branding/argon/moz.build").is_file())
        self.assertTrue((self.source / "browser/base/content/argon-window-hooks.inc.xhtml").is_file())

    def test_jar_hook_inserts_entries_before_the_anchor(self):
        self.apply()
        text = (self.source / "browser/base/jar.mn").read_text()
        block = text.split("# BEGIN Argon overlay")[1].split("# END Argon overlay")[0]
        for name in ("tokens.css", "argon.css", "argon-controller.mjs", "appearance.mjs"):
            self.assertIn(f"content/browser/argon/{name}", block)
        self.assertLess(text.index("# BEGIN Argon overlay"), text.index("# L10n resources and overrides."))

    def test_preference_hook_is_inlined_because_firefox_js_is_not_preprocessed(self):
        self.apply()
        text = (self.source / "browser/app/profile/firefox.js").read_text()
        block = text.split("// BEGIN Argon overlay")[1].split("// END Argon overlay")[0]
        self.assertNotIn("#include", block,
                         "firefox.js has no preprocessor, so prefs must be inlined")
        self.assertIn('pref("argon.theme"', block)
        self.assertIn('pref("argon.tabs.layout"', block)

    def test_preference_hook_inlines_the_nova_defaults_after_the_upstream_ones(self):
        """The appended block must override upstream, not sit in front of it.

        firefox.js has no preprocessor and prefs are read in order, so an
        earlier upstream `true` would win if the Argon block came first.
        """
        self.apply()
        text = (self.source / "browser/app/profile/firefox.js").read_text()
        block = text.split("// BEGIN Argon overlay")[1].split("// END Argon overlay")[0]
        self.assertNotIn("#include", block)
        for name in support.NOVA_PREFS:
            self.assertIn(f'pref("{name}", false)', block,
                          f"{name} must be overridden inside the inlined Argon block")
        upstream_position = text.index(f'pref("{support.NOVA_PREFS[0]}", true)')
        self.assertGreater(text.index("// BEGIN Argon overlay"), upstream_position,
                           "Argon overrides must come after the upstream defaults")

    def test_xhtml_hook_uses_closed_comment_markers_so_the_include_runs(self):
        self.apply()
        text = (self.source / "browser/base/content/browser.xhtml").read_text()
        self.assertIn("<!-- BEGIN Argon overlay -->", text)
        self.assertIn("<!-- END Argon overlay -->", text)
        begin = text.index("<!-- BEGIN Argon overlay -->")
        end = text.index("<!-- END Argon overlay -->")
        directive = text.index("#include argon-window-hooks.inc.xhtml")
        self.assertGreater(directive, begin)
        self.assertLess(directive, end)
        # The directive must not sit inside a comment: the comment closes on the
        # same line as the begin marker, before the directive line.
        between = text[begin:directive]
        self.assertEqual(between.count("<!--"), 1)
        self.assertEqual(between.count("-->"), 1, "the begin comment must be closed before the include")
        self.assertGreater(text.index("#include argon-window-hooks.inc.xhtml"),
                           text.index("browser-main.js"))

    def test_apply_is_idempotent_and_does_not_duplicate_blocks(self):
        self.apply()
        self.apply()
        for relative, marker in [
            ("browser/base/jar.mn", "# BEGIN Argon overlay"),
            ("browser/app/profile/firefox.js", "// BEGIN Argon overlay"),
            ("browser/base/content/browser.xhtml", "<!-- BEGIN Argon overlay -->"),
            ("browser/moz.configure", "# BEGIN Argon overlay"),
        ]:
            text = (self.source / relative).read_text()
            self.assertEqual(text.count(marker), 1, f"{relative} gained a duplicate block")

    def test_drift_in_an_upstream_hook_fails_closed_before_patching(self):
        jar = self.source / "browser/base/jar.mn"
        jar.write_text(jar.read_text() + "\n# upstream changed this file\n")
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("drift", (result.stdout + result.stderr).lower())
        self.assertNotIn("BEGIN Argon overlay", jar.read_text(),
                         "a drifted hook must not be patched")

    def test_vendor_hook_replaces_the_implied_mozilla_vendor(self):
        self.apply()
        text = (self.source / "browser/moz.configure").read_text()
        self.assertIn('imply_option("MOZ_APP_VENDOR", "Argon")', text)
        self.assertIn('imply_option("MOZ_APP_PROFILE", "argon")', text)
        self.assertNotIn('\nimply_option("MOZ_APP_VENDOR", "Mozilla")', text,
                         "two implied vendors would make configure fail")
        self.assertIn('# upstream: imply_option("MOZ_APP_VENDOR", "Mozilla")', text)
        self.assertIn('imply_option("MOZ_APP_ID", "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}")', text,
                      "the Firefox app id stays so AMO add-ons remain compatible")

    def test_apply_is_all_or_nothing_when_a_later_hook_drifted(self):
        configure = self.source / "browser/moz.configure"
        configure.write_text(configure.read_text() + "\n# upstream changed this file\n")
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("drift", (result.stdout + result.stderr).lower())
        for relative in support.HOOK_PATHS:
            self.assertNotIn("BEGIN Argon overlay", (self.source / relative).read_text(),
                             f"{relative} was patched although another hook drifted")
        self.assertNotIn("visible: () => false",
                         (self.source / support.NEWTAB_PREFERENCES).read_text(),
                         "the New Tab patch ran although another hook drifted")
        self.assertFalse((self.source / "browser/base/content/argon").exists())

    def test_sponsored_shortcuts_control_patch_is_applied_and_idempotent(self):
        """The New Tab settings pane must not offer a way back in.

        The patch is exact-text, not a marked block, so re-applying it must
        leave the file byte-identical and report no work.
        """
        self.apply()
        target = self.source / support.NEWTAB_PREFERENCES
        patched = target.read_text()
        self.assertIn("visible: () => false", patched)
        self.assertIn("onUserChange(value, { sponsoredStories })", patched)
        self.assertNotIn("sponsoredShortcuts.value = !!value", patched)
        self.assertNotIn("home-prefs-shortcuts-by-option-sponsored-srd", patched)
        self.assertEqual(patched.count("visible: () => false"), 2,
                         "sponsored shortcuts and the support toggle must both be hidden")

        report = self.apply()
        self.assertEqual(target.read_text(), patched, "apply must not rewrite a patched file")
        actions = {hook["path"]: hook["action"] for hook in report["hooks"]}
        self.assertEqual(actions[support.NEWTAB_PREFERENCES], "unchanged")

    def test_drift_in_the_newtab_preferences_hook_fails_closed(self):
        target = self.source / support.NEWTAB_PREFERENCES
        target.write_text(target.read_text() + "\n// upstream changed this file\n")
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("drift", (result.stdout + result.stderr).lower())
        self.assertNotIn("visible: () => false", target.read_text(),
                         "a drifted New Tab module must not be patched")

    def test_apply_requires_a_checkout(self):
        shutil.rmtree(self.source)
        result = support.run_cli(["apply"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fetch", (result.stdout + result.stderr).lower())

    def mozconfig(self, artifact):
        module = support.load_tool()
        workspace = module.Workspace(support.REPO, self.workspace)
        lock = json.loads(support.REAL_LOCK.read_text())
        return "\n".join(module.mozconfig_lines(workspace, lock, artifact=artifact)), lock

    def test_default_mozconfig_builds_an_independent_argon(self):
        joined, _ = self.mozconfig(artifact=False)
        for option in (
            "--enable-bootstrap",
            "--with-app-name=argon",
            "--with-app-basename=Argon",
            "--with-branding=browser/branding/argon",
            "--with-distribution-id=org.argon.browser",
            "MOZ_APP_REMOTINGNAME=argon",
            "--disable-updater",
        ):
            self.assertIn(option, joined)
        self.assertNotIn("--enable-artifact-builds", joined)
        self.assertNotIn("MOZILLA_OFFICIAL", joined.replace("MOZILLA_OFFICIAL is not set", ""))
        self.assertNotRegex(joined, r"(?m)^export MOZ_APP_(VENDOR|PROFILE)",
                            "project_flag options have possible_origins=('implied',) and are set by the overlay")
        self.assertIn(f"MOZ_OBJDIR={self.workspace / 'obj'}", joined)

    def test_artifact_mozconfig_is_front_end_only_and_pins_the_revision(self):
        joined, lock = self.mozconfig(artifact=True)
        self.assertIn("--enable-artifact-builds", joined)
        self.assertIn("--with-branding=browser/branding/argon", joined)
        self.assertNotIn("--with-app-name", joined,
                         "artifact binaries are named firefox; renaming would break the build")
        self.assertIn("MOZ_OBJDIR=", joined)
        # Artifact resolution needs a VCS checkout; pin the revision that the
        # clone must be at so artifacts are not chosen from a newer candidate.
        self.assertIn(lock["artifacts"]["hg_revision"], joined,
                      "the artifact revision must be pinned in the mozconfig")

    def test_doctor_warns_that_a_tarball_checkout_cannot_resolve_artifacts(self):
        self.apply()
        result = support.run_cli(["--artifact", "doctor"], workspace=self.workspace)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["source_present"])
        self.assertIsNone(report["source_vcs"], "the stand-in tree has no hg/git metadata")
        self.assertTrue(any("git-cinnabar" in warning for warning in report["warnings"]),
                        "doctor must name the artifact-resolution blocker")

    def test_doctor_reports_a_git_checkout_when_present(self):
        (self.source / ".git").mkdir()
        report = json.loads(support.run_cli(["--artifact", "doctor"], workspace=self.workspace).stdout)
        self.assertEqual(report["source_vcs"], "git")
        self.assertFalse(any("git-cinnabar" in warning for warning in report["warnings"]))

    def test_run_refuses_without_a_build_and_targets_the_argon_binary(self):
        result = support.run_cli(["run", "--dry-run"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("build", result.stderr.lower())
        binary = self.workspace / "obj/dist/bin/argon"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o755)
        result = support.run_cli(["--dry-run", "run"], workspace=self.workspace)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["command"][0], str(binary))
        self.assertEqual(report["identity"], "argon")
        self.assertIn("--no-remote", report["command"])

    def test_package_refuses_an_artifact_build(self):
        binary = self.workspace / "obj/dist/bin/firefox"
        binary.parent.mkdir(parents=True)
        binary.write_text("")
        result = support.run_cli(["package"], workspace=self.workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not distributable", result.stderr)

if __name__ == "__main__":
    unittest.main(verbosity=2)
