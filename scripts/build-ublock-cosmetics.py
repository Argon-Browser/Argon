#!/usr/bin/env python3
"""Generate the content-realm adapter, verifying the pinned source hashes first."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'argon/adblock'
provenance = json.loads((BASE / 'ublock/provenance.json').read_text())
for path, expected in provenance['files'].items():
    actual = hashlib.sha256((BASE / 'ublock' / path).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'uBO source drift: {path}')
template = (BASE / 'procedural-bootstrap.js').read_text()
assert template.count('/* UBO_SOURCE */') == 1
source = (BASE / 'ublock/src/js/contentscript-extra.js').read_text()
(BASE / 'procedural.js').write_text(template.replace('/* UBO_SOURCE */', source))
print('Generated browser-owned uBO procedural interpreter:', provenance['commit'])
