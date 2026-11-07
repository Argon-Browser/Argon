"""Offline stdlib tests for the isolated Argon build workflow."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/argon.py"


class DoctorTests(unittest.TestCase):
    def doctor(self, *extra):
        with tempfile.TemporaryDirectory(prefix="argon-doctor-") as tmp:
            workspace = Path(tmp) / "workspace"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), *extra, "doctor"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(workspace.exists(), "doctor must not create the workspace")
            return json.loads(result.stdout)

    def test_doctor_defaults_to_a_full_build_with_the_argon_identity(self):
        report = self.doctor()
        self.assertEqual(report["build_mode"], "source")
        self.assertTrue(report["native_identity_rebranded"])
        self.assertEqual(report["app_name"], "argon")
        self.assertTrue(report["mozconfig_present"])
        self.assertIn("python3", report["tools"])
        self.assertIn("rustc", report["tools"])

    def test_doctor_is_explicit_that_artifact_builds_keep_firefox_identity(self):
        report = self.doctor("--artifact")
        self.assertEqual(report["build_mode"], "artifact")
        self.assertFalse(report["native_identity_rebranded"])
        self.assertTrue(any("native identity" in w for w in report["warnings"]))


class DefaultWorkspaceTests(unittest.TestCase):
    def test_default_workspace_is_outside_the_repository_and_ascii_safe(self):
        ff = load_tool()
        env = {k: v for k, v in os.environ.items() if k not in ("ARGON_WORKSPACE", "XDG_CACHE_HOME")}
        with mock.patch.dict(os.environ, env, clear=True):
            path = ff.default_workspace()
        self.assertEqual(path, Path.home() / ".cache" / "argon-build")
        self.assertNotIn(REPO, [path, *path.parents])
        # The repository lives under a path with spaces; the default must be
        # accepted by the workspace guard regardless.
        ff.Workspace(REPO, path)

    def test_argon_workspace_overrides_the_default(self):
        ff = load_tool()
        with mock.patch.dict(os.environ, {"ARGON_WORKSPACE": "/srv/argon"}):
            self.assertEqual(ff.default_workspace(), Path("/srv/argon"))


def load_tool():
    spec = importlib.util.spec_from_file_location("argon_build", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkspaceTests(unittest.TestCase):
    def test_workspace_rejects_unsafe_roots_and_symlink_components(self):
        ff = load_tool()
        with tempfile.TemporaryDirectory(prefix="argon-safety-") as tmp:
            parent = Path(tmp)
            actual = parent / "actual"
            actual.mkdir()
            link = parent / "link"
            link.symlink_to(actual, target_is_directory=True)
            unsafe = [Path.home(), Path("/"), REPO, parent / "has spaces",
                      parent / "$(touch-pwned)", parent / ".." / "outside", link / "child"]
            for path in unsafe:
                with self.subTest(path=path), self.assertRaises(ff.BuildError):
                    ff.Workspace(REPO, path).claim()
            self.assertFalse((actual / "child").exists())

    def test_workspace_claim_is_idempotent_but_refuses_unowned_content(self):
        ff = load_tool()
        self.assertTrue(hasattr(ff, "Workspace"), "Workspace ownership is missing")
        with tempfile.TemporaryDirectory(prefix="argon-workspace-") as tmp:
            path = Path(tmp) / "isolated"
            ws = ff.Workspace(REPO, path)
            ws.claim()
            original = (path / ".argon-workspace.json").read_bytes()
            ws.claim()
            self.assertEqual((path / ".argon-workspace.json").read_bytes(), original)
            other = Path(tmp) / "unowned"
            other.mkdir()
            sentinel = other / "do-not-touch"
            sentinel.write_text("mine")
            with self.assertRaisesRegex(ff.BuildError, "unowned"):
                ff.Workspace(REPO, other).claim()
            self.assertEqual(sentinel.read_text(), "mine")
            self.assertFalse((other / ".argon-workspace.json").exists())


if __name__ == "__main__":
    unittest.main()
