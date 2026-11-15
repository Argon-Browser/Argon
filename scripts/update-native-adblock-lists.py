#!/usr/bin/env python3
"""Explicit maintainer command: snapshot the enabled uBO catalog, never silently drop a list."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import os
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def _https_urls_for(entry):
    urls = entry['contentURL']
    raw_urls = ([urls] if isinstance(urls, str) else list(urls)) + list(entry.get('cdnURLs', []))
    return list(dict.fromkeys(u for u in raw_urls if isinstance(u, str) and u.startswith('https://')))


def _build_result(key, entry, https_urls, url, resolved):
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


def build_batch_items(enabled):
    items = []
    meta_by_id = {}
    for key, entry in enabled:
        https_urls = _https_urls_for(entry)
        items.append({'id': key, 'urls': https_urls})
        meta_by_id[key] = (entry, https_urls)
    return items, meta_by_id


def download(item):
    """Resolve and format a single enabled list entry using fallback HTTPS URLs."""
    key, entry = item
    https_urls = _https_urls_for(entry)
    if not https_urls:
        raise ValueError(f'No HTTPS URLs configured for list {key}')
    resolver = str(ROOT / 'scripts/resolve-native-adblock-list.mjs')
    last_error = None
    for url in https_urls:
        try:
            completed = subprocess.run(
                ['node', resolver, url],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            return _build_result(key, entry, https_urls, url, json.loads(completed.stdout))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as err:
            last_error = err
    raise last_error


def download_batch(enabled):
    items, meta_by_id = build_batch_items(enabled)
    completed = subprocess.run(
        ['node', str(ROOT / 'scripts/resolve-native-adblock-list.mjs'), '--batch'],
        input=json.dumps(items),
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    resolved_items = json.loads(completed.stdout)
    results = []
    for item in resolved_items:
        key = item['id']
        entry, https_urls = meta_by_id[key]
        results.append(_build_result(key, entry, https_urls, item['url'], item['resolved']))
    return results

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
    results = download_batch(enabled)
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
