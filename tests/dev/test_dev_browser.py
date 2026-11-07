"""Offline tests for the isolated, no-compile browser development loop."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/dev-browser.py"


class DevBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="argon-dev-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "Área de desenvolvimento"
        overlay = json.loads((ROOT / "config/overlay.json").read_text())
        sources = ["config/overlay.json", "config/firefox.lock.json",
                   "browser/base/content/argon-window-hooks.inc.xhtml",
                   "argon/preferences/argon-prefs.js", *(entry["from"] for entry in overlay["files"])]
        for relative in sources:
            target = self.repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        shutil.copytree(ROOT / "browser/branding/argon", self.repo / "browser/branding/argon")
        self.base = self.root / "prebuilt app"
        (self.base / "browser").mkdir(parents=True)
        self.binary = self.base / "argon"
        self.binary.write_bytes(b"precompiled fixture engine")
        self.binary.chmod(0o755)
        (self.base / "application.ini").write_text("[App]\nName=Argon\nVendor=Argon\nProfile=argon\n")
        self.archive = self.base / "browser/omni.ja"
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("chrome/browser/content/browser/browser.xhtml",
                             "<html><head><!-- BEGIN Argon overlay -->old hooks"
                             "<!-- END Argon overlay --></head></html>")
            archive.writestr("defaults/preferences/firefox.js", 'pref("fixture.upstream", true);\n')
            archive.writestr("unchanged.txt", b"keep upstream resources")
            for hook in overlay["hooks"]:
                if "resource" in hook:
                    archive.writestr(hook["resource"],
                                     (ROOT / "config/source-reference" / hook["path"]).read_bytes())
        self.workspace = self.repo / ".cache/argon-dev"

    def subject(self):
        self.assertTrue(SCRIPT.is_file(), "The no-compile development launcher must exist")
        spec = importlib.util.spec_from_file_location("argon_dev", SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_sync_uses_a_private_runtime_and_copies_the_shipping_resources(self):
        dev = self.subject()
        original_archive = self.archive.read_bytes()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        self.assertNotEqual(runtime, self.base)
        self.assertEqual((runtime / "argon").read_bytes(), self.binary.read_bytes())
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            self.assertEqual(archive.read("chrome/browser/content/browser/argon/argon.css"),
                             (self.repo / "browser/themes/shared/argon.css").read_bytes())
            self.assertEqual(archive.read("chrome/browser/content/browser/argon/appearance.mjs"),
                             (self.repo / "argon/preferences/appearance.mjs").read_bytes())
            self.assertEqual(archive.read("unchanged.txt"), b"keep upstream resources")
        self.assertEqual(self.archive.read_bytes(), original_archive, "The prebuilt app stays read-only")

    def test_sync_removes_the_sponsored_shortcuts_setting_from_the_packaged_browser(self):
        dev = self.subject()
        original_archive = self.archive.read_bytes()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        resource = "chrome/browser/builtin-addons/newtab/lib/AboutPreferences.sys.mjs"
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            module = archive.read(resource).decode()
        self.assertNotIn("home-prefs-shortcuts-by-option-sponsored-srd", module)
        self.assertNotIn("sponsoredShortcuts.value = !!value", module)
        self.assertIn("visible: () => false", module)
        self.assertEqual(self.archive.read_bytes(), original_archive)
        dev.sync_resources(self.repo, self.base, runtime)
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            self.assertEqual(archive.read(resource).decode(), module)

    def test_packaged_replacement_drift_leaves_the_last_good_runtime_unchanged(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        destination = runtime / "browser/omni.ja"
        previous = destination.read_bytes()
        resource = "chrome/browser/builtin-addons/newtab/lib/AboutPreferences.sys.mjs"
        with zipfile.ZipFile(self.archive) as archive:
            files = {info.filename: archive.read(info) for info in archive.infolist()}
        original = files[resource].decode()
        overlay = json.loads((self.repo / "config/overlay.json").read_text())
        hook = next(hook for hook in overlay["hooks"] if hook.get("resource") == resource)
        replacement = hook["replacements"][0]
        for name, contents in {
            "drift": original + "\n// Different upstream revision\n",
            "partial": original.replace(replacement["old"], replacement["new"], 1),
            "missing": None,
        }.items():
            with self.subTest(case=name):
                with zipfile.ZipFile(self.archive, "w") as archive:
                    for path, data in files.items():
                        if path != resource:
                            archive.writestr(path, data)
                        elif contents is not None:
                            archive.writestr(path, contents)
                base = self.archive.read_bytes()
                with self.assertRaises(dev.DevError):
                    dev.sync_resources(self.repo, self.base, runtime)
                self.assertEqual(destination.read_bytes(), previous)
                self.assertEqual(self.archive.read_bytes(), base)
                self.assertEqual(list(destination.parent.glob(".argon-ui-*")), [])

    def test_sync_accepts_a_base_that_already_has_the_sponsored_shortcuts_patch(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        resource = "chrome/browser/builtin-addons/newtab/lib/AboutPreferences.sys.mjs"
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            patched = archive.read(resource)
        with zipfile.ZipFile(self.archive) as archive:
            files = {info.filename: archive.read(info) for info in archive.infolist()}
        files[resource] = patched
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        original = self.archive.read_bytes()
        dev.sync_resources(self.repo, self.base, runtime)
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            self.assertEqual(archive.read(resource), patched)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_sync_refreshes_branding_window_hooks_and_preference_defaults(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        first = dev.source_snapshot(self.repo)
        wordmark = self.repo / "browser/branding/argon/content/branding/firefox-wordmark.svg"
        wordmark.write_text('<svg xmlns="http://www.w3.org/2000/svg"><text>Changed</text></svg>')
        prefs = self.repo / "argon/preferences/argon-prefs.js"
        prefs.write_text(prefs.read_text() + '\npref("argon.dev.fixture", true);\n')
        hooks = self.repo / "browser/base/content/argon-window-hooks.inc.xhtml"
        hooks.write_text(hooks.read_text() + '\n<link data-dev-fixture="true" />\n')
        self.assertNotEqual(dev.source_snapshot(self.repo), first)
        dev.sync_resources(self.repo, self.base, runtime)
        with zipfile.ZipFile(runtime / "browser/omni.ja") as archive:
            self.assertEqual(archive.read("chrome/browser/content/branding/firefox-wordmark.svg"),
                             wordmark.read_bytes())
            self.assertEqual(archive.read("chrome/browser/content/branding/icon32.png"),
                             (self.repo / "browser/branding/argon/default32.png").read_bytes())
            window = archive.read("chrome/browser/content/browser/browser.xhtml").decode()
            self.assertIn('data-dev-fixture="true"', window)
            self.assertEqual(window.count("BEGIN Argon overlay"), 1)
            self.assertNotIn("# This Source", window)
            defaults = archive.read("defaults/preferences/firefox.js").decode()
            self.assertIn('pref("fixture.upstream", true);', defaults)
            self.assertIn('pref("argon.dev.fixture", true);', defaults)
            self.assertEqual(defaults.count("BEGIN Argon development defaults"), 1)

    def test_sync_copies_librewolf_settings_and_policies_when_present(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        (self.repo / "settings/defaults/pref").mkdir(parents=True, exist_ok=True)
        (self.repo / "settings/distribution").mkdir(parents=True, exist_ok=True)
        (self.repo / "settings/librewolf.cfg").write_text('// Argon hardened cfg\ndefaultPref("argon.cfg.loaded", true);\n')
        (self.repo / "settings/defaults/pref/local-settings.js").write_text('pref("general.config.filename", "librewolf.cfg");\n')
        (self.repo / "settings/distribution/policies.json").write_text('{"policies":{"DisableAppUpdate":true}}\n')
        before = dev.source_snapshot(self.repo)
        dev.sync_resources(self.repo, self.base, runtime)
        self.assertEqual((runtime / "librewolf.cfg").read_text(),
                         (self.repo / "settings/librewolf.cfg").read_text())
        self.assertEqual((runtime / "defaults/pref/local-settings.js").read_text(),
                         (self.repo / "settings/defaults/pref/local-settings.js").read_text())
        self.assertEqual((runtime / "distribution/policies.json").read_text(),
                         (self.repo / "settings/distribution/policies.json").read_text())
        (self.repo / "settings/librewolf.cfg").write_text('// Updated cfg\n')
        self.assertNotEqual(dev.source_snapshot(self.repo), before)

    def test_invalid_source_input_does_not_replace_the_last_good_archive(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        dev.sync_resources(self.repo, self.base, runtime)
        archive = runtime / "browser/omni.ja"
        previous = archive.read_bytes()
        manifest = self.repo / "config/overlay.json"
        overlay = json.loads(manifest.read_text())
        overlay["files"][0]["from"] = "../../outside.css"
        manifest.write_text(json.dumps(overlay))
        with self.assertRaises(dev.DevError):
            dev.sync_resources(self.repo, self.base, runtime)
        self.assertEqual(archive.read_bytes(), previous)

    def invalid_manifests(self):
        valid = json.loads((self.repo / "config/overlay.json").read_text())
        hooks = {hook["path"]: index for index, hook in enumerate(valid["hooks"])}
        jar = ("hooks", hooks["browser/base/jar.mn"], "entries")
        window = ("hooks", hooks["browser/base/content/browser.xhtml"], "include")
        defaults = ("hooks", hooks["browser/app/profile/firefox.js"], "include")
        newtab = ("hooks", hooks["browser/extensions/newtab/lib/AboutPreferences.sys.mjs"])
        fields = [
            ("files", ("files",), {}),
            ("file", ("files", 0), None),
            ("file-source", ("files", 0, "from"), []),
            ("file-destination", ("files", 0, "to"), {}),
            ("hooks", ("hooks",), {}),
            ("hook", ("hooks", 0), None),
            ("hook-path", ("hooks", 0, "path"), []),
            ("branding", ("branding",), []),
            ("branding-source", ("branding", "from"), None),
            ("jar-entries", jar, {}),
            ("jar-entry", (*jar, 0), None),
            ("jar-destination", (*jar, 0, "destination"), []),
            ("jar-source", (*jar, 0, "source"), {}),
            ("window-include", window, []),
            ("defaults-include", defaults, False),
            ("replacements", (*newtab, "replacements"), {}),
            ("replacement", (*newtab, "replacements", 0), None),
            ("replacement-old", (*newtab, "replacements", 0, "old"), ""),
            ("replacement-new", (*newtab, "replacements", 0, "new"), []),
        ]
        variants = {"null": None, "array": []}
        for name, resource in {"type": None, "absolute": "/outside.mjs", "parent": "../outside.mjs"}.items():
            invalid = json.loads(json.dumps(valid))
            invalid["hooks"][newtab[1]]["resource"] = resource
            variants["resource-" + name] = invalid
        for name, path, value in fields:
            for missing in (False, True) if isinstance(path[-1], str) else (False,):
                invalid = json.loads(json.dumps(valid))
                parent = invalid
                for key in path[:-1]:
                    parent = parent[key]
                if missing:
                    del parent[path[-1]]
                else:
                    parent[path[-1]] = value
                variants[name + ("-missing" if missing else "")] = invalid
        for path, index in hooks.items():
            if path in {"browser/base/jar.mn", "browser/base/content/browser.xhtml",
                        "browser/app/profile/firefox.js"}:
                invalid = json.loads(json.dumps(valid))
                del invalid["hooks"][index]
                variants["missing-hook-" + path] = invalid
        return variants

    def test_consumed_manifest_structures_raise_dev_error(self):
        dev = self.subject()
        manifest = self.repo / "config/overlay.json"
        for name, invalid in self.invalid_manifests().items():
            with self.subTest(manifest=name):
                manifest.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(dev.DevError, r"config/overlay\.json"):
                    dev.resource_updates(self.repo)

    def test_invalid_hook_lock_is_rejected_before_the_watcher_accepts_a_save(self):
        dev = self.subject()
        lock = self.repo / "config/firefox.lock.json"
        for value in (None, [], {"hooks": []}, {"hooks": {"fixture": False}}):
            with self.subTest(lock=value):
                lock.write_text(json.dumps(value))
                with self.assertRaisesRegex(dev.DevError, r"config/firefox\.lock\.json"):
                    dev.source_snapshot(self.repo)

    def test_reusing_the_runtime_does_not_replace_the_development_profile(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        profile = self.workspace / "profile"
        profile.mkdir()
        (profile / "prefs.js").write_text("development preferences")
        self.assertEqual(dev.prepare_runtime(self.binary, self.workspace), runtime)
        self.assertEqual((profile / "prefs.js").read_text(), "development preferences")

    def fake_browser(self):
        self.binary.write_text("#!" + sys.executable + "\n" + '''
import json, os, pathlib, signal, sys, time
profile = pathlib.Path(sys.argv[sys.argv.index('--profile') + 1])
with (profile / 'launches.jsonl').open('a') as out:
    out.write(json.dumps({'pid': os.getpid(), 'args': sys.argv[1:],
                          'purge': os.environ.get('MOZ_PURGE_CACHES')}) + '\\n')
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
if '--fixture-exit' in sys.argv:
    sys.exit(0)
while True:
    time.sleep(0.05)
''')

    def start_dev(self, *args):
        code = ("import importlib.util,sys; from pathlib import Path; "
                "s=importlib.util.spec_from_file_location('dev',sys.argv[1]); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                "sys.exit(m.main(sys.argv[3:],repo=Path(sys.argv[2])))")
        log = (self.root / f"dev-{time.monotonic_ns()}.log").open("w")
        process = subprocess.Popen([sys.executable, "-u", "-c", code, str(SCRIPT), str(self.repo),
                                    "--binary", str(self.binary), *args], stdout=log, stderr=log)
        self.dev_log = Path(log.name)
        log.close()
        self.addCleanup(self.stop_dev, process)
        return process

    @staticmethod
    def stop_dev(process):
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=10)

    def launches(self):
        path = self.workspace / "profile/launches.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def wait_for(self, predicate):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("Development loop did not reach the expected state")

    def test_sync_only_cli_never_launches_the_browser(self):
        self.fake_browser()
        process = self.start_dev("--sync-only")
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertTrue((self.workspace / "runtime/browser/omni.ja").is_file())
        self.assertEqual(self.launches(), [])

    def test_watch_restarts_after_valid_changes_and_cleans_up_its_own_browser(self):
        self.fake_browser()
        process = self.start_dev()
        self.wait_for(lambda: len(self.launches()) == 1)
        first = self.launches()[0]
        self.assertIn("--no-remote", first["args"])
        self.assertIn("--new-instance", first["args"])
        self.assertEqual(first["purge"], "1")
        self.assertIn(str(self.workspace / "profile"), first["args"])
        manifest = self.repo / "config/overlay.json"
        valid = manifest.read_text()
        manifest.write_text("{")
        time.sleep(0.8)
        self.assertIsNone(process.poll(), "An incomplete save must not kill the development loop")
        self.assertEqual(len(self.launches()), 1)
        manifest.write_text(valid)
        css = self.repo / "browser/themes/shared/argon.css"
        css.write_text(css.read_text() + "\n:root { --dev-saved: yes; }\n")
        self.wait_for(lambda: len(self.launches()) == 2)
        second = self.launches()[1]
        self.assertNotEqual(first["pid"], second["pid"])
        with self.assertRaises(ProcessLookupError):
            os.kill(first["pid"], 0)
        with zipfile.ZipFile(self.workspace / "runtime/browser/omni.ja") as archive:
            self.assertIn(b"--dev-saved: yes", archive.read("chrome/browser/content/browser/argon/argon.css"))
        self.stop_dev(process)
        with self.assertRaises(ProcessLookupError):
            os.kill(second["pid"], 0)

    def test_watch_keeps_its_browser_alive_for_invalid_manifests_and_recovers(self):
        self.fake_browser()
        manifest = self.repo / "config/overlay.json"
        valid = manifest.read_text()
        variants = self.invalid_manifests()
        cases = ["null", "files", "file-source", "hook-path", "branding",
                 "jar-entry", "jar-source", "window-include", "defaults-include"]
        css = self.repo / "browser/themes/shared/argon.css"

        def save_manifest(text):
            saved = manifest.with_suffix(".json.saving")
            saved.write_text(text)
            saved.replace(manifest)

        for name in cases:
            with self.subTest(manifest=name):
                save_manifest(valid)
                baseline = len(self.launches())
                process = self.start_dev()
                log = self.dev_log
                try:
                    self.wait_for(lambda: len(self.launches()) == baseline + 1 or process.poll() is not None)
                    self.assertIsNone(process.poll(), log.read_text())
                    current = self.launches()
                    first = current[-1]
                    archive = self.workspace / "runtime/browser/omni.ja"
                    previous = archive.read_bytes()
                    save_manifest(json.dumps(variants[name]))
                    self.wait_for(lambda: process.poll() is not None or
                                  "Waiting for a valid save:" in log.read_text())
                    self.assertIsNone(process.poll(), log.read_text())
                    self.assertEqual(self.launches(), current, "An invalid save must not restart the browser")
                    os.kill(first["pid"], 0)
                    self.assertEqual(archive.read_bytes(), previous)
                    marker = f"--dev-recovered-{name}: yes"
                    css.write_text(css.read_text() + f"\n:root {{ {marker}; }}\n")
                    save_manifest(valid)
                    self.wait_for(lambda: len(self.launches()) == baseline + 2 or process.poll() is not None)
                    self.assertIsNone(process.poll(), log.read_text())
                    self.assertEqual(len(self.launches()), baseline + 2)
                    self.assertNotEqual(self.launches()[-1]["pid"], first["pid"])
                    with self.assertRaises(ProcessLookupError):
                        os.kill(first["pid"], 0)
                    with zipfile.ZipFile(archive) as synchronized:
                        self.assertIn(marker.encode(), synchronized.read("chrome/browser/content/browser/argon/argon.css"))
                finally:
                    self.stop_dev(process)

    def test_only_one_development_loop_can_own_the_workspace(self):
        dev = self.subject()
        self.workspace.mkdir(parents=True)
        with dev.DevLock(self.workspace):
            with self.assertRaises(dev.DevError):
                with dev.DevLock(self.workspace):
                    self.fail("A second loop must not acquire the same profile")

    def test_symlinked_runtime_directory_cannot_modify_the_base_application(self):
        dev = self.subject()
        runtime = dev.prepare_runtime(self.binary, self.workspace)
        original = self.archive.read_bytes()
        shutil.rmtree(runtime / "browser")
        (runtime / "browser").symlink_to(self.base / "browser", target_is_directory=True)
        with self.assertRaises(dev.DevError):
            dev.sync_resources(self.repo, self.base, runtime)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_symlinked_profile_is_rejected_before_launch(self):
        self.fake_browser()
        self.workspace.mkdir(parents=True)
        personal = self.root / "not-a-development-profile"
        personal.mkdir()
        (self.workspace / "profile").symlink_to(personal, target_is_directory=True)
        process = self.start_dev("--no-watch", "--", "--fixture-exit")
        self.assertEqual(process.wait(timeout=10), 1)
        self.assertFalse((personal / "launches.jsonl").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
