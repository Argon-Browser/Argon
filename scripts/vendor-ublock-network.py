#!/usr/bin/env python3
"""Vendor the pinned upstream network-engine module graph, without rewriting it."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.cache/ublock-source'
DEST = ROOT / 'argon/adblock/ublock'
COMMIT = '3762a26fd65df422080c116e6a70d13bc8d57d62'
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != COMMIT:
    raise SystemExit('The source checkout must match the pinned commit')
imports = re.compile(r'''(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]''')
pending = [
    'src/js/static-net-filtering.js',
    'src/js/static-filtering-io.js',
    'src/js/text-utils.js',
    'src/js/hnswitches.js',
    'src/js/url-net-filtering.js',
]
files = {}
while pending:
    relative = pending.pop()
    if relative in files:
        continue
    path = (SOURCE / relative).resolve()
    relative = str(path.relative_to(SOURCE.resolve()))
    data = subprocess.check_output(['git', '-C', str(SOURCE), 'show', f'{COMMIT}:{relative}'])
    target = DEST / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    files[relative] = hashlib.sha256(data).hexdigest()
    for ref in imports.findall(data.decode()):
        dependency = str((path.parent / ref).resolve().relative_to(SOURCE.resolve()))
        if dependency not in files:
            pending.append(dependency)
p = DEST / 'provenance.json'
manifest = json.loads(p.read_text())
manifest['files'].update(files)
p.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Vendored {len(files)} unmodified modules at {COMMIT}')
