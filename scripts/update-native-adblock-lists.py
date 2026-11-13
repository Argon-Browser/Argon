#!/usr/bin/env python3
"""Explicit maintainer command: snapshot the enabled uBO catalog, never silently drop a list."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import os
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def download(item):
    key, entry = item
    urls = entry['contentURL']
    raw_urls = ([urls] if isinstance(urls, str) else list(urls)) + list(entry.get('cdnURLs', []))
    https_urls = list(dict.fromkeys(u for u in raw_urls if isinstance(u, str) and u.startswith('https://')))
    errors = []
    for url in https_urls:
        try:
            completed = subprocess.run(['node', str(ROOT / 'scripts/resolve-native-adblock-list.mjs'), url],
                                       check=True, capture_output=True, text=True, timeout=150)
            resolved = json.loads(completed.stdout)
            data = resolved['text'].encode('utf-8')
            fallback_urls = [u for u in https_urls if u != url]
            manifest_entry = {'id': key, 'title': entry['title'], 'url': url}
            if fallback_urls:
                manifest_entry['fallbackUrls'] = fallback_urls
            manifest_entry.update({
                'updateAfter': entry.get('updateAfter', 7),
                'sha256': hashlib.sha256(data).hexdigest(),
                'sources': resolved['sources'],
                'pipelineVersion': resolved['pipelineVersion'],
                'capabilities': resolved['capabilities'],
            })
            return manifest_entry, data
        except Exception as error:
            errors.append(f'{url}: {error}')
    raise RuntimeError(f'{key}: {errors}')

def publish(destination, results, manifest):
    """Stage everything before touching the checkout; roll back I/O failures.

    Runtime caches use a single atomic JSON replacement. This maintainer-only
    multi-file checkout publication is not crash-atomic: do not package/sync it
    concurrently. Manifest hashes detect an interrupted or mixed checkout.
    """
    (destination / 'lists').mkdir(parents=True, exist_ok=True)
    payloads = [(Path('lists') / (entry['id'] + '.txt'), data) for entry, data in results]
    payloads.append((Path('lists.json'), manifest))
    with tempfile.TemporaryDirectory(dir=destination, prefix='.snapshot-') as temp:
        staging = Path(temp)
        previous = {}
        for relative, data in payloads:
            target = destination / relative
            previous[relative] = target.read_bytes() if target.exists() else None
            staged = staging / relative
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(data)
        installed = []
        try:
            for relative, _ in payloads:
                os.replace(staging / relative, destination / relative)
                installed.append(relative)
        except BaseException:
            for relative in reversed(installed):
                target = destination / relative
                if previous[relative] is None:
                    target.unlink()
                else:
                    target.write_bytes(previous[relative])
            raise

def main():
    catalog = json.loads((ROOT / 'assets/uBOAssets.json').read_text())
    enabled = [(key, entry) for key, entry in catalog.items()
               if entry.get('content') == 'filters' and not entry.get('off', False)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(download, enabled))
    destination = ROOT / 'argon/adblock'
    manifest = (json.dumps({
        'schema': 1, 'pipelineVersion': results[0][0]['pipelineVersion'],
        'capabilities': results[0][0]['capabilities'],
        'retrieved': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'lists': [entry for entry, _ in results]}, indent=2) + '\n').encode('utf-8')
    publish(destination, results, manifest)
    print(f'Snapshotted {len(results)} enabled filter lists.')

if __name__ == '__main__':
    main()
