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

from support import REPO, load_tool


class FlatpakPackagingContractTests(unittest.TestCase):
    def setUp(self):
        self.tool = load_tool()
        self.flatpak_dir = REPO / "packaging" / "flatpak"

    def test_manifest_desktop_and_metainfo_files_exist_and_match_app_id(self):
        app_id = self.tool.FLATPAK_APP_ID
        self.assertEqual(app_id, "org.argon.browser")

        manifest = (self.flatpak_dir / f"{app_id}.yml").read_text(encoding="utf-8")
        self.assertIn(f"app-id: {app_id}", manifest)
        self.assertIn(f"runtime: {self.tool.FLATPAK_RUNTIME}", manifest)
        self.assertIn(f'runtime-version: "{self.tool.FLATPAK_RUNTIME_VERSION}"', manifest)
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
        self.assertEqual(colors, {"light": "#FBF8F4", "dark": "#1E1E1E"})

        policies = json.loads((self.flatpak_dir / "policies.json").read_text(encoding="utf-8"))
        self.assertTrue(policies["policies"]["DisableAppUpdate"])

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

    def test_command_flatpak_packages_verified_argon_archive(self):
        with tempfile.TemporaryDirectory(prefix="argon-flatpak-") as tmp:
            root = Path(tmp)
            ws = self.tool.Workspace(REPO, root / "ws")
            archive = root / "argon-162.0a1.en-US.linux-x86_64.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                self._add_text(tf, "argon/argon", "#!/bin/sh\necho Argon 162.0a1\n")
                self._add_text(
                    tf,
                    "argon/application.ini",
                    "[App]\nVendor=Argon\nName=Argon\nRemotingName=argon\nProfile=argon\nVersion=162.0a1\n",
                )

            if shutil.which("flatpak"):
                report = self.tool.command_flatpak(ws, archive=archive)
                self.assertTrue(report["succeeded"])
                self.assertEqual(report["app_id"], "org.argon.browser")
                bundle = Path(report["bundle"])
                self.assertEqual(bundle.name, "argon-162.0a1.en-US.linux-x86_64.flatpak")
                self.assertTrue(bundle.is_file())
                self.assertGreater(bundle.stat().st_size, 0)
            else:
                def fake_run(cmd, **_kwargs):
                    if "build-bundle" in cmd:
                        Path(cmd[3]).write_bytes(b"fake-flatpak-bundle")
                    return mock.Mock(returncode=0, stdout="", stderr="")

                with mock.patch("shutil.which", return_value="/usr/bin/flatpak"), \
                     mock.patch("subprocess.run", side_effect=fake_run):
                    report = self.tool.command_flatpak(ws, archive=archive)
                    self.assertTrue(report["succeeded"])
                    self.assertTrue(Path(report["bundle"]).is_file())

    @staticmethod
    def _add_text(tf, name, text):
        data = text.encode("utf-8")
        info = tarfile.TarInfo(name=name)
        info.size = len(data)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(data))


if __name__ == "__main__":
    unittest.main()
