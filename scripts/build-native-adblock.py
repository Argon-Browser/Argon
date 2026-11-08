#!/usr/bin/env python3
"""Build the pinned real Rust engine for Linux and its portable WASM test ABI."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main():
    if platform.system() != 'Linux':
        raise SystemExit('Only Linux packaging is currently supported; do not remove the uBlock fallback.')
    cargo = shutil.which('cargo') or str(Path.home() / '.cargo/bin/cargo')
    target = ROOT / '.cache/adblock-target'
    env = dict(os.environ, CARGO_TARGET_DIR=str(target))
    base = [cargo, 'build', '--locked', '--release', '--manifest-path', str(ROOT / 'native/adblock/Cargo.toml')]
    subprocess.run(base, env=env, check=True)
    subprocess.run(base + ['--target', 'wasm32-unknown-unknown'], env=env, check=True)
    destination = ROOT / 'argon/adblock'
    outputs = {'libargon_adblock.so': target / 'release/libargon_adblock.so',
               'engine.wasm': target / 'wasm32-unknown-unknown/release/argon_adblock.wasm'}
    for name, source in outputs.items():
        shutil.copy2(source, destination / name)
    provenance = {'adblock': '0.13.5', 'target': platform.machine() + '-unknown-linux-gnu',
        'rustc': subprocess.check_output([str(Path(cargo).parent / 'rustc'), '--version'], text=True).strip(),
        'cargoLockSha256': hashlib.sha256((ROOT / 'native/adblock/Cargo.lock').read_bytes()).hexdigest(),
        'files': {name: hashlib.sha256((destination / name).read_bytes()).hexdigest() for name in outputs}}
    (destination / 'build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    metadata = json.loads(subprocess.check_output([cargo, 'metadata', '--locked', '--format-version', '1', '--manifest-path', str(ROOT / 'native/adblock/Cargo.toml')], env=env, text=True))
    notices = ['Third-party Rust dependencies; original source is available from crates.io.\n']
    for package in sorted(metadata['packages'], key=lambda p: p['name']):
        notices.append(f"\n=== {package['name']} {package['version']} ({package.get('license', '')}) ===\n{package.get('repository') or ''}\n")
        directory = Path(package['manifest_path']).parent
        for file in sorted(directory.iterdir()):
            if file.is_file() and file.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
                notices.append(file.name + '\n' + file.read_text(errors='replace') + '\n')
    (destination / 'THIRD-PARTY-NOTICES.txt').write_text('\n'.join(notices))
    print(json.dumps(provenance, indent=2))

if __name__ == '__main__': main()
