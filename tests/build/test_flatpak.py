"""Tests for Argon's Flatpak manifest, metadata, and bundle builder."""
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import zipfile

from support import REPO, load_tool


class FlatpakPackagingContractTests(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool()
        self.flatpak_dir = REPO / "packaging" / "flatpak"

    def test_manifest_desktop_and_metainfo_files_exist_and_match_app_id(self):
        app_id = self.tool.FLATPAK_APP_ID
        self.assertEqual(app_id, "io.github.argon_browser.Argon")

        manifest = (self.flatpak_dir / f"{app_id}.yml").read_text(encoding="utf-8")
        self.assertIn(f"app-id: {app_id}", manifest)
        self.assertIn(f"runtime: {self.tool.FLATPAK_RUNTIME}", manifest)
        self.assertIn(f'runtime-version: "{self.tool.FLATPAK_RUNTIME_VERSION}"', manifest)
        self.assertIn("base: org.mozilla.firefox.BaseApp", manifest)
        self.assertIn("librewolf.cfg", manifest)
        self.assertIn("local-settings.js", manifest)
        self.assertIn("LICENSE", manifest)
        for arg in self.tool.FLATPAK_FINISH_ARGS:
            self.assertIn(f"- {arg}", manifest)

        desktop = (self.flatpak_dir / f"{app_id}.desktop").read_text(encoding="utf-8")
        self.assertIn("Name=Argon", desktop)
        self.assertIn("Exec=argon %u", desktop)
        self.assertIn(f"Icon={app_id}", desktop)
        self.assertIn("StartupWMClass=argon", desktop)

        metainfo_path = self.flatpak_dir / f"{app_id}.metainfo.xml"
        root = ET.parse(metainfo_path).getroot()
        self.assertEqual(root.findtext("id"), app_id)
        self.assertEqual(root.findtext("name"), "Argon")
        self.assertEqual(root.findtext("launchable"), f"{app_id}.desktop")
        colors = {c.attrib.get("scheme_preference"): c.text for c in root.findall("./branding/color")}
        self.assertEqual(colors, {"light": "#6478F5", "dark": "#2E3B8F"})
        screenshots = [img.text for img in root.findall("./screenshots/screenshot/image") if img.text]
        self.assertGreaterEqual(len(screenshots), 1)
        for url in screenshots:
            self.assertTrue(url.startswith("https://"))
            self.assertNotIn("/main/", url)
        release = root.find("./releases/release")
        self.assertIsNotNone(release)
        self.assertEqual(release.attrib.get("version"), "0.1.0")
        self.assertNotEqual(release.attrib.get("type"), "development")

        flatpak_policies = json.loads((self.flatpak_dir / "policies.json").read_text(encoding="utf-8"))
        canonical_policies = json.loads(
            (REPO / "settings" / "distribution" / "policies.json").read_text(encoding="utf-8")
        )
        self.assertEqual(flatpak_policies, canonical_policies)
        self.assertTrue(flatpak_policies["policies"]["DisableAppUpdate"])
        self.assertTrue(flatpak_policies["policies"]["DisableTelemetry"])
        self.assertNotIn(
            "uBlock0@raymondhill.net",
            flatpak_policies["policies"].get("ExtensionSettings", {}),
        )

        metadata_report = self.tool.validate_flatpak_metadata()
        self.assertIn("desktop", metadata_report)
        self.assertIn("metainfo", metadata_report)

    def test_command_flatpak_rejects_archive_without_argon_identity(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            archive = root / "argon-fake.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                self._add_text(tf, "argon/argon", "#!/bin/sh\n")
                self._add_text(tf, "argon/application.ini", "[App]\nName=Firefox\nVendor=Mozilla\n")

            with mock.patch("shutil.which", return_value="/usr/bin/flatpak"):
                with self.assertRaisesRegex(self.tool.BuildError, "application.ini identity"):
                    self.tool.command_flatpak(ws, archive=archive, output=root / "out.flatpak")

    def test_command_flatpak_rejects_invalid_runtime_or_conflicting_flags(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "argon").write_text("#!/bin/sh\n", encoding="utf-8")
            (runtime / "application.ini").write_text("[App]\nName=Argon\nVendor=Argon\n", encoding="utf-8")

            with mock.patch("shutil.which", return_value="/usr/bin/flatpak"):
                with self.assertRaisesRegex(self.tool.BuildError, "not both"):
                    self.tool.command_flatpak(ws, archive=root / "a.tar.gz", runtime=runtime)

                with self.assertRaisesRegex(self.tool.BuildError, "missing browser/omni.ja"):
                    self.tool.command_flatpak(ws, runtime=runtime)

                (runtime / "browser").mkdir()
                (runtime / "browser" / "omni.ja").write_bytes(b"placeholder")
                (runtime / "application.ini").write_text("[App]\nName=Firefox\nVendor=Mozilla\n", encoding="utf-8")
                with self.assertRaisesRegex(self.tool.BuildError, "application.ini identity"):
                    self.tool.command_flatpak(ws, runtime=runtime)

    def test_command_flatpak_packages_verified_argon_archive(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            archive = root / "argon-0.1.0.en-US.linux-x86_64.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                self._add_text(tf, "argon/argon", "#!/bin/sh\necho Argon 0.1.0\n")
                self._add_text(
                    tf,
                    "argon/application.ini",
                    "[App]\nVendor=Argon\nName=Argon\nRemotingName=argon\nProfile=argon\nVersion=0.1.0\n",
                )
                self._add_text(
                    tf,
                    "argon/distribution/policies.json",
                    json.dumps({"policies": {"DisableAppUpdate": True}}),
                )

            if shutil.which("flatpak"):
                report = self.tool.command_flatpak(ws, archive=archive)
                self.assertTrue(report["succeeded"])
                self.assertEqual(report["app_id"], "io.github.argon_browser.Argon")
                bundle = Path(report["bundle"])
                self.assertEqual(bundle.name, "argon-0.1.0.en-US.linux-x86_64.flatpak")
                self.assertTrue(bundle.is_file())
                self.assertGreater(bundle.stat().st_size, 0)

                verify_report = self.tool.command_verify_flatpak(ws, bundle=bundle, require_full_omni=False)
                self.assertTrue(verify_report["succeeded"])
                self.assertTrue(verify_report["bundle_verified"])
                self.assertFalse(verify_report["omni_checked"])
                with self.assertRaisesRegex(self.tool.BuildError, "missing browser/omni.ja"):
                    self.tool.command_verify_flatpak(ws, bundle=bundle, require_full_omni=True)
            else:
                def fake_run(cmd, **_kwargs):
                    if "build-bundle" in cmd:
                        Path(cmd[cmd.index(self.tool.FLATPAK_APP_ID) - 1]).write_bytes(b"fake-flatpak-bundle")
                    return mock.Mock(returncode=0, stdout="", stderr="")

                with mock.patch("shutil.which", return_value="/usr/bin/flatpak"), \
                     mock.patch("subprocess.run", side_effect=fake_run):
                    report = self.tool.command_flatpak(ws, archive=archive)
                    self.assertTrue(report["succeeded"])
                    self.assertTrue(Path(report["bundle"]).is_file())

    def test_command_flatpak_runtime_mode_and_verify_full_omni(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-rt-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            runtime = root / "runtime"
            (runtime / "browser").mkdir(parents=True)
            argon_bin = runtime / "argon"
            argon_bin.write_text("#!/bin/sh\necho Argon 162.0a1\n", encoding="utf-8")
            argon_bin.chmod(0o755)
            (runtime / "application.ini").write_text(
                "[App]\nVendor=Argon\nName=Argon\nRemotingName=argon\nProfile=argon\nVersion=162.0a1\n",
                encoding="utf-8",
            )
            omni_path = runtime / "browser" / "omni.ja"
            with zipfile.ZipFile(omni_path, "w") as zf:
                for entry in self.tool.REQUIRED_OMNI_ENTRIES:
                    zf.writestr(entry, f"/* {entry} */\n")

            bundle_out = root / "argon-beta.flatpak"
            if shutil.which("flatpak"):
                report = self.tool.command_flatpak(ws, runtime=runtime, output=bundle_out)
                self.assertTrue(report["succeeded"])
                self.assertEqual(report["source_mode"], "runtime")
                self.assertTrue(bundle_out.is_file())

                verify = self.tool.command_verify_flatpak(ws, bundle=bundle_out, require_full_omni=True)
                self.assertTrue(verify["succeeded"])
                self.assertTrue(verify["bundle_verified"])
                self.assertTrue(verify["omni_checked"])

                # Drop one required omni entry and make sure verify-flatpak fails closed.
                with zipfile.ZipFile(omni_path, "w") as zf:
                    for entry in self.tool.REQUIRED_OMNI_ENTRIES[:-1]:
                        zf.writestr(entry, "/* partial */\n")
                partial_bundle = root / "argon-partial.flatpak"
                self.tool.command_flatpak(ws, runtime=runtime, output=partial_bundle)
                with self.assertRaisesRegex(self.tool.BuildError, "missing Argon entries"):
                    self.tool.command_verify_flatpak(ws, bundle=partial_bundle, require_full_omni=True)
            else:
                def fake_run(cmd, **_kwargs):
                    if "build-bundle" in cmd:
                        bundle_out.write_bytes(b"fake-runtime-bundle")
                    return mock.Mock(returncode=0, stdout="", stderr="")

                with mock.patch("shutil.which", return_value="/usr/bin/flatpak"), \
                     mock.patch("subprocess.run", side_effect=fake_run):
                    report = self.tool.command_flatpak(ws, runtime=runtime, output=bundle_out)
                    self.assertEqual(report["source_mode"], "runtime")
                    self.assertTrue(bundle_out.is_file())

    def test_command_flatpak_passes_gpg_sign_flags(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-gpg-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            archive = root / "argon-162.0a1.en-US.linux-x86_64.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                self._add_text(tf, "argon/argon", "#!/bin/sh\n")
                self._add_text(
                    tf,
                    "argon/application.ini",
                    "[App]\nVendor=Argon\nName=Argon\nRemotingName=argon\nProfile=argon\nVersion=162.0a1\n",
                )

            recorded = []
            out = root / "signed.flatpak"

            def fake_run(cmd, **_kwargs):
                recorded.append(cmd)
                if "build-bundle" in cmd:
                    out.write_bytes(b"signed-bundle")
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch("shutil.which", return_value="/usr/bin/flatpak"), \
                 mock.patch("subprocess.run", side_effect=fake_run):
                report = self.tool.command_flatpak(
                    ws,
                    archive=archive,
                    output=out,
                    gpg_sign="DEADBEEF",
                    gpg_homedir=root / "gpghome",
                )
            self.assertTrue(report["signed"])
            export_cmd = next(c for c in recorded if "build-export" in c)
            bundle_cmd = next(c for c in recorded if "build-bundle" in c)
            self.assertIn("--gpg-sign=DEADBEEF", export_cmd)
            self.assertIn(f"--gpg-homedir={root / 'gpghome'}", export_cmd)
            self.assertIn("--gpg-sign=DEADBEEF", bundle_cmd)
            self.assertIn(f"--gpg-homedir={root / 'gpghome'}", bundle_cmd)

    def test_command_verify_flatpak_fails_on_missing_or_corrupt_bundle(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-bad-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            with self.assertRaisesRegex(self.tool.BuildError, "missing or empty"):
                self.tool.command_verify_flatpak(ws, bundle=root / "does-not-exist.flatpak")

            empty_bundle = root / "empty.flatpak"
            empty_bundle.write_bytes(b"")
            with self.assertRaisesRegex(self.tool.BuildError, "missing or empty"):
                self.tool.command_verify_flatpak(ws, bundle=empty_bundle)

            if shutil.which("flatpak"):
                corrupt = root / "corrupt.flatpak"
                corrupt.write_bytes(b"not-an-ostree-bundle")
                with self.assertRaisesRegex(self.tool.BuildError, "isolated install verification"):
                    self.tool.command_verify_flatpak(ws, bundle=corrupt)

    def test_command_flatpak_repo_rejects_missing_bundles(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-repo-bad-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            with mock.patch("shutil.which", return_value="/usr/bin/flatpak"):
                with self.assertRaisesRegex(self.tool.BuildError, "No .flatpak bundles"):
                    self.tool.command_flatpak_repo(ws, output_dir=root / "pages")
                with self.assertRaisesRegex(self.tool.BuildError, "missing or empty"):
                    self.tool.command_flatpak_repo(ws, bundles=[root / "missing.flatpak"], output_dir=root / "pages")

    def test_command_flatpak_repo_builds_ostree_repo_and_descriptors(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-repo-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            archive = root / "argon-0.1.0.en-US.linux-x86_64.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                self._add_text(tf, "argon/argon", "#!/bin/sh\necho Argon 0.1.0\n")
                self._add_text(
                    tf,
                    "argon/application.ini",
                    "[App]\nVendor=Argon\nName=Argon\nRemotingName=argon\nProfile=argon\nVersion=0.1.0\n",
                )

            pages_dir = root / "pages"
            if shutil.which("flatpak"):
                bundle = Path(self.tool.command_flatpak(ws, archive=archive)["bundle"])
                report = self.tool.command_flatpak_repo(ws, bundles=[bundle], output_dir=pages_dir)
                self.assertTrue(report["succeeded"])
                self.assertFalse(report["signed"])
                self.assertTrue((pages_dir / "repo" / "config").is_file())
                self.assertTrue(
                    (pages_dir / "repo" / "summary").is_file()
                    or (pages_dir / "repo" / "summary.idx").is_file()
                )
            else:
                bundle = root / "argon-0.1.0.en-US.linux-x86_64.flatpak"
                bundle.write_bytes(b"fake-bundle")
                with mock.patch("shutil.which", side_effect=lambda name: "/usr/bin/flatpak" if name == "flatpak" else None), \
                     mock.patch("subprocess.run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
                    report = self.tool.command_flatpak_repo(ws, bundles=[bundle], output_dir=pages_dir)
                self.assertTrue(report["succeeded"])

            repo_desc = (pages_dir / "argon.flatpakrepo").read_text(encoding="utf-8")
            self.assertIn("[Flatpak Repo]", repo_desc)
            self.assertIn("Url=https://argon-browser.github.io/Argon/repo", repo_desc)
            self.assertIn("DefaultBranch=stable", repo_desc)
            self.assertIn("GPGVerify=false", repo_desc)

            ref_desc = (pages_dir / "argon.flatpakref").read_text(encoding="utf-8")
            self.assertIn("[Flatpak Ref]", ref_desc)
            self.assertIn("Name=io.github.argon_browser.Argon", ref_desc)
            self.assertIn("SuggestRemoteName=argon", ref_desc)
            self.assertIn("GPGVerify=false", ref_desc)

            self.assertTrue((pages_dir / ".nojekyll").is_file())
            self.assertTrue((pages_dir / "icon.svg").is_file())
            index_html = (pages_dir / "index.html").read_text(encoding="utf-8")
            self.assertIn("https://argon-browser.github.io/Argon/argon.flatpakrepo", index_html)
            self.assertIn("flatpak update --user io.github.argon_browser.Argon", index_html)

    def test_command_flatpak_repo_passes_gpg_flags_and_embeds_gpg_key(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-repo-gpg-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            bundle = root / "argon.flatpak"
            bundle.write_bytes(b"fake-bundle")
            pages_dir = root / "pages"
            gpg_home = root / "gpghome"
            recorded = []

            def fake_run(cmd, **_kwargs):
                recorded.append(cmd)
                if cmd[0].endswith(("gpg", "gpg2")):
                    return mock.Mock(returncode=0, stdout=b"FAKEPUBKEYDATA", stderr=b"")
                return mock.Mock(returncode=0, stdout="", stderr="")

            with mock.patch("shutil.which", side_effect=lambda name: f"/usr/bin/{name}" if name in ("flatpak", "gpg") else None), \
                 mock.patch("subprocess.run", side_effect=fake_run):
                report = self.tool.command_flatpak_repo(
                    ws,
                    bundles=[bundle],
                    output_dir=pages_dir,
                    gpg_sign="DEADBEEF",
                    gpg_homedir=gpg_home,
                )

            self.assertTrue(report["signed"])
            import_cmd = next(c for c in recorded if "build-import-bundle" in c)
            update_cmd = next(c for c in recorded if "build-update-repo" in c)
            self.assertIn("--gpg-sign=DEADBEEF", import_cmd)
            self.assertIn(f"--gpg-homedir={gpg_home}", import_cmd)
            self.assertIn("--gpg-sign=DEADBEEF", update_cmd)
            self.assertIn(f"--gpg-homedir={gpg_home}", update_cmd)
            self.assertTrue(any(arg.startswith("--gpg-import=") for arg in update_cmd))

            repo_desc = (pages_dir / "argon.flatpakrepo").read_text(encoding="utf-8")
            self.assertIn("GPGKey=RkFLRVBVQktFWURBVEE=", repo_desc)
            self.assertNotIn("GPGVerify=false", repo_desc)

    @staticmethod
    def _add_text(tf, name, text):
        data = text.encode("utf-8")
        info = tarfile.TarInfo(name=name)
        info.size = len(data)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(data))


if __name__ == "__main__":
    unittest.main()

