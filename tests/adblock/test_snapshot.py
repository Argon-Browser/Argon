"""Maintainer snapshot publication rolls back all files on write failure."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('snapshot', ROOT / 'scripts/update-native-adblock-lists.py')
assert spec is not None and spec.loader is not None
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)

class SnapshotPublication(unittest.TestCase):
    def test_failed_publication_preserves_previous_snapshot(self):
        self.assertTrue(hasattr(snapshot, 'publish'), 'snapshot publication must be transactional')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'lists').mkdir()
            (root / 'lists/one.txt').write_bytes(b'old-one')
            (root / 'lists/two.txt').write_bytes(b'old-two')
            (root / 'lists.json').write_bytes(b'old-manifest')
            replace = snapshot.os.replace
            def fail_manifest(source, destination):
                if Path(destination) == root / 'lists.json':
                    raise OSError('disk fault')
                return replace(source, destination)
            with patch.object(snapshot.os, 'replace', side_effect=fail_manifest):
                with self.assertRaises(OSError):
                    snapshot.publish(root, [({'id': 'one'}, b'new-one'), ({'id': 'two'}, b'new-two')], b'new-manifest')
            self.assertEqual((root / 'lists/one.txt').read_bytes(), b'old-one')
            self.assertEqual((root / 'lists/two.txt').read_bytes(), b'old-two')
            self.assertEqual((root / 'lists.json').read_bytes(), b'old-manifest')

if __name__ == '__main__': unittest.main()
