"""Offline tests for `scripts/argon.py fetch`.

The real download path is exercised against a loopback HTTP server and a real
gzipped tarball; only the URL comes from a temporary lock file.
"""
import hashlib
import http.server
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

import support


class LoopbackArchive:
    """Serves a real tarball over HTTP and counts the requests it receives."""

    def __init__(self, path):
        self.path = path
        self._requests = 0

        class Handler(http.server.SimpleHTTPRequestHandler):
            def do_GET(handler_self):  # noqa: N805
                self._requests += 1
                handler_self.send_response(200)
                handler_self.send_header("Content-Type", "application/x-gzip")
                handler_self.send_header(
                    "Content-Length", str(self.path.stat().st_size)
                )
                handler_self.end_headers()
                handler_self.wfile.write(self.path.read_bytes())

            def log_message(handler_self, *args):  # silence stderr noise
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/source.tar.gz"

    @property
    def requests(self):
        return self._requests

    def __enter__(self):
        self._requests = 0
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class FetchTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="argon-fetch-")
        self.tmp = Path(self._tmp.name)
        self.workspace = self.tmp / "workspace"

    def tearDown(self):
        self._tmp.cleanup()

    def test_fetch_downloads_verifies_and_extracts_pinned_archive(self):
        archive = support.make_archive(self.tmp / "source.tar.gz")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        lock = support.write_lock(
            self.tmp / "firefox.lock.json",
            archive_url="http://placeholder.invalid/source.tar.gz",
            archive_sha256=digest,
        )
        with LoopbackArchive(archive) as srv:
            support.write_lock(lock, archive_url=srv.url, archive_sha256=digest)
            result = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        source = self.workspace / "source"
        self.assertTrue((source / "mach").is_file())
        self.assertEqual((source / "mach").stat().st_mode & 0o777, 0o755)
        self.assertTrue((source / "browser/base/jar.mn").is_file())

        # The cached archive is kept so re-runs never hit the network again.
        self.assertTrue((self.workspace / "cache" / "source.tar.gz").is_file())

        info = json.loads((self.workspace / "source-info.json").read_text())
        self.assertEqual(info["revision"], support.REVISION)
        self.assertEqual(info["archive_sha256"], digest)
        self.assertEqual(info["archive_root"], support.ARCHIVE_ROOT)

        # The extracted hook files must match the hashes recorded in the lock.
        for rel, expected in json.loads(support.REAL_LOCK.read_text())["hooks"].items():
            self.assertEqual(info["hook_sha256"][rel], expected, rel)

    def test_fetch_is_idempotent_and_does_not_redownload(self):
        archive = support.make_archive(self.tmp / "source.tar.gz")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        lock = self.tmp / "firefox.lock.json"
        with LoopbackArchive(archive) as srv:
            support.write_lock(lock, archive_url=srv.url, archive_sha256=digest)
            first = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            served_after_first = srv.requests
            second = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertEqual(srv.requests, served_after_first)
            report = json.loads(second.stdout)
            self.assertTrue(report["already_present"])

    def test_fetch_rejects_checksum_mismatch(self):
        archive = support.make_archive(self.tmp / "source.tar.gz")
        lock = support.write_lock(
            self.tmp / "firefox.lock.json",
            archive_url="http://placeholder.invalid/source.tar.gz",
            archive_sha256="f" * 64,
        )
        with LoopbackArchive(archive) as server:
            support.write_lock(lock, archive_url=server.url, archive_sha256="f" * 64)
            result = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum", (result.stdout + result.stderr).lower())
        self.assertFalse((self.workspace / "source").exists())
        self.assertFalse((self.workspace / "source-info.json").exists())
        # A rejected download must not be left behind as if it were verified.
        self.assertFalse((self.workspace / "cache" / "source.tar.gz").exists())

    def test_fetch_rejects_unexpected_archive_root(self):
        archive = support.make_archive(self.tmp / "source.tar.gz", root="wrong-root")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        lock = self.tmp / "firefox.lock.json"
        with LoopbackArchive(archive) as server:
            support.write_lock(lock, archive_url=server.url, archive_sha256=digest)
            result = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive_root", result.stdout + result.stderr)
        self.assertFalse((self.workspace / "source").exists())

    def test_fetch_refuses_unowned_existing_source_directory(self):
        archive = support.make_archive(self.tmp / "source.tar.gz")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        lock = self.tmp / "firefox.lock.json"
        source = self.workspace / "source"
        source.mkdir(parents=True)
        (source / "do-not-touch").write_text("mine")
        with LoopbackArchive(archive) as server:
            support.write_lock(lock, archive_url=server.url, archive_sha256=digest)
            result = support.run_cli(["fetch"], workspace=self.workspace, lock=lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unowned", result.stdout + result.stderr)
        self.assertEqual((source / "do-not-touch").read_text(), "mine")
        self.assertFalse((source / "mach").exists())


if __name__ == "__main__":
    unittest.main()
