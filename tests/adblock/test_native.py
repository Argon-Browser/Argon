"""Exercise the native C ABI with the actual Rust library."""
import ctypes
import json
from pathlib import Path
import unittest

class NativeEngine(unittest.TestCase):
    def test_native_request_and_exception(self):
        path = Path(__file__).resolve().parents[2] / 'argon/adblock/libargon_adblock.so'
        self.assertTrue(path.is_file(), 'Native engine library must be built')
        lib = ctypes.CDLL(str(path))
        call = lib.execute_json
        call.argtypes = [ctypes.c_char_p]
        call.restype = ctypes.c_char_p
        def invoke(value): return json.loads(call(json.dumps(value).encode()))
        invoke({'op':'load','lists':['||ads.test^\n@@||ads.test/allowed']})
        self.assertTrue(invoke({'op':'check','url':'https://ads.test/ad','source':'https://page.test','type':'script'})['matched'])
        self.assertFalse(invoke({'op':'check','url':'https://ads.test/allowed','source':'https://page.test','type':'script'})['matched'])

if __name__ == '__main__': unittest.main()
