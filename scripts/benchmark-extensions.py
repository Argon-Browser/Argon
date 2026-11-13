#!/usr/bin/env python3
"""Exercise signed AMO extensions in isolated packaged Argon profiles.

Installation/startup evidence is not a full compatibility verdict. Never changes
signing preferences, installs temporarily, or uses an existing user profile.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import urllib.request
from unittest.mock import patch

from marionette_driver.marionette import Marionette
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[1]

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><html><head><title>Extension fixture</title><style>body { background: white; color: black; }</style></head><body><h1>Argon extension benchmark</h1><p>Local functional probe.</p></body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass


def download(url):
    if not url.startswith('https://'):
        raise ValueError('Only HTTPS downloads are accepted')
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read(64 * 1024 * 1024 + 1)


def extension_page(browser, guid, path):
    browser.set_context('chrome')
    url = browser.execute_script("return WebExtensionPolicy.getByID(arguments[0]).getURL(arguments[1]);", [guid, path])
    browser.set_context('content')
    browser.navigate(url)


def extension_call(browser, script, args=()):
    result = browser.execute_async_script(
        "const done = arguments[arguments.length - 1]; (async () => {" + script +
        "})().then(value => done({value}), error => done({error: String(error)}));",
        list(args), sandbox=None)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result['value']


def functional_probe(browser, slug, guid, fixture_url, result):
    browser.set_context('content')
    browser.navigate(fixture_url)
    if slug == 'styl-us':
        assert browser.execute_script('return getComputedStyle(document.body).backgroundColor;') == 'rgb(255, 255, 255)'
        extension_page(browser, guid, 'manage.html')
        saved = extension_call(browser, """
            return browser.runtime.sendMessage({data: {method: 'invokeAPI', path: 'styles.editSave', args: [{
                name: 'Argon benchmark style', enabled: true,
                sections: [{code: 'body { background-color: rgb(12, 34, 56) !important; }',
                    urls: [arguments[0]], urlPrefixes: [], domains: [], regexps: []}]
            }]}, TDM: 1});
        """, [fixture_url])
        if not saved or saved.get('error') or not saved.get('data', {}).get('id'):
            raise RuntimeError('Stylus did not save the style: ' + str(saved))
        style_id = saved['data']['id']
        browser.navigate(fixture_url)
        Wait(browser, timeout=30).until(lambda _: browser.execute_script(
            "return getComputedStyle(document.body).backgroundColor === 'rgb(12, 34, 56)';"))
        result['checks']['stylusAppliedStyle'] = True
        result['stylusStyleId'] = style_id
        browser.navigate(fixture_url + 'outside-scope')
        assert browser.execute_script('return getComputedStyle(document.body).backgroundColor;') == 'rgb(255, 255, 255)'
        result['checks']['stylusRespectedUrlScope'] = True
        extension_page(browser, guid, 'manage.html')
        extension_call(browser, "return browser.runtime.sendMessage({data: {method: 'invokeAPI', path: 'styles.toggle', args: [arguments[0], false]}, TDM: 1});", [style_id])
        browser.navigate(fixture_url)
        Wait(browser, timeout=30).until(lambda _: browser.execute_script(
            "return getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)';"))
        result['checks']['stylusDisableRestoredPage'] = True
    elif slug == 'cookie-editor':
        browser.execute_script("document.cookie = 'argon_probe=before; Path=/; SameSite=Lax'; document.cookie = 'argon_control=unchanged; Path=/; SameSite=Lax';")
        extension_page(browser, guid, 'interface/options/options.html')
        observed = extension_call(browser, """
            const {GenericCookieHandler} = await import('/interface/lib/genericCookieHandler.js');
            const {BrowserDetector} = await import('/interface/lib/browserDetector.js');
            const handler = new GenericCookieHandler(new BrowserDetector());
            handler.currentTab = {url: arguments[0], cookieStoreId: 'firefox-default'};
            const cookies = await new Promise(resolve => handler.getAllCookies(resolve));
            const cookie = cookies.find(c => c.name === 'argon_probe');
            if (!cookie || cookie.value !== 'before') throw new Error('Cookie-Editor did not read the fixture cookie');
            const saved = await new Promise((resolve, reject) => handler.saveCookie(
                {...cookie, value: 'after'}, arguments[0], (error, value) => error ? reject(error) : resolve(value)));
            return {readValue: cookie.value, savedValue: saved.value};
        """, [fixture_url])
        assert observed == {'readValue': 'before', 'savedValue': 'after'}, observed
        result['checks']['cookieEditorReadCookie'] = True
        browser.navigate(fixture_url)
        cookies = browser.execute_script('return document.cookie;')
        assert 'argon_probe=after' in cookies and 'argon_control=unchanged' in cookies, cookies
        result['checks']['cookieEditorEditVisibleToPage'] = True
        result['checks']['cookieEditorPreservedOtherCookie'] = True
        result['cookieObservation'] = observed


def run(slug, binary, output, fixture_url):
    result = {'id': slug, 'distribution': 'native-amo', 'compatibility': 'NOT_ASSESSED', 'checks': {}}
    browser = None
    with tempfile.TemporaryDirectory(prefix='argon-extension-benchmark-') as workspace:
        try:
            metadata = json.loads(download(f'https://addons.mozilla.org/api/v5/addons/addon/{slug}/'))
            version = metadata['current_version']
            package = version['file']
            content = download(package['url'])
            if len(content) > 64 * 1024 * 1024:
                raise ValueError('Package exceeds 64 MiB')
            digest = hashlib.sha256(content).hexdigest()
            if package['hash'] != 'sha256:' + digest:
                raise ValueError('AMO package hash mismatch')
            xpi = Path(workspace) / 'extension.xpi'
            xpi.write_bytes(content)
            result.update(version=version['version'], guid=metadata['guid'], packageUrl=package['url'], sha256=digest)
            result['checks']['packageIntegrity'] = True
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            browser = Marionette(bin=str(binary), port=port, workspace=workspace,
                headless=True, startup_timeout=90, gecko_log=str(output / (slug + '.log')),
                prefs={'argon.onboarding.completed': True, 'browser.shell.checkDefaultBrowser': False})
            with patch.dict(os.environ, {'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1', 'MOZ_PURGE_CACHES': '1'}):
                browser.start_session()
            browser.set_context('chrome')
            result['application'] = browser.execute_script('return {name: Services.appinfo.name, version: Services.appinfo.version, buildID: Services.appinfo.appBuildID};')
            if result['application']['name'] != 'Argon':
                raise RuntimeError('Benchmark requires an Argon application, not stock Firefox')
            browser.timeout.script = 90
            installation = browser.execute_async_script('''
                const done = arguments[arguments.length - 1];
                (async () => {
                    const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
                    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
                    file.initWithPath(arguments[0]);
                    const install = await AddonManager.getInstallForFile(file);
                    await install.install();
                    const addon = install.addon;
                    return {id: addon.id, isActive: addon.isActive, signedState: addon.signedState,
                        appDisabled: addon.appDisabled, userDisabled: addon.userDisabled};
                })().then(done, e => done({error: String(e)}));
            ''', [str(xpi)])
            result['installation'] = installation
            result['checks']['installedActive'] = installation.get('isActive') is True
            if not result['checks']['installedActive']:
                raise RuntimeError('Extension did not install as active: ' + str(installation))
            # This checks real content-script behavior, not only AddonManager state.
            if slug == 'darkreader':
                browser.set_context('content')
                browser.navigate(fixture_url)
                Wait(browser, timeout=30).until(lambda _: browser.execute_script(
                    "return !!document.querySelector('style.darkreader') && getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)';"))
                result['checks']['darkenedLocalPage'] = True
                result['observedBackground'] = browser.execute_script('return getComputedStyle(document.body).backgroundColor;')
            if slug in ('styl-us', 'cookie-editor'):
                functional_probe(browser, slug, metadata['guid'], fixture_url, result)
            browser.set_context('chrome')
            browser.restart(in_app=True)
            browser.set_context('chrome')
            restored = browser.execute_async_script('''
                const done = arguments[arguments.length - 1];
                const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
                AddonManager.getAddonByID(arguments[0]).then(a => done(a ? {
                    isActive: a.isActive, signedState: a.signedState
                } : null), e => done({error: String(e)}));
            ''', [metadata['guid']])
            result['afterRestart'] = restored
            result['checks']['activeAfterRestart'] = bool(restored and restored.get('isActive'))
            if not result['checks']['activeAfterRestart']:
                raise RuntimeError('Extension is not active after restart')
            result['outcome'] = 'SMOKE_PASSED'
        except Exception as error:
            result['outcome'] = 'SMOKE_FAILED'
            result['error'] = str(error)
        finally:
            if browser:
                browser.cleanup()
                if browser.instance:
                    browser.instance.close(clean=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ids', nargs='+', default=['darkreader'])
    parser.add_argument('--binary', type=Path, default=ROOT / '.cache/argon-dev/runtime/argon')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/extension-benchmark')
    args = parser.parse_args()
    registry = json.loads((ROOT / 'argon/extensions/benchmark-registry.json').read_text())
    candidates = {entry['id'] for entry in registry['extensions']}
    if any(slug not in candidates for slug in args.ids):
        parser.error('Every id must be in the benchmark registry')
    if not args.binary.is_file():
        parser.error('A packaged Argon binary is required')
    args.output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'schemaVersion': 1, 'recordedAt': datetime.now(timezone.utc).isoformat(),
        'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'binary': str(args.binary.resolve()), 'scope': 'SIGNED_NATIVE_AMO_SMOKE',
        'limitations': ['No Chromium bridge verdict', 'No full feature coverage', 'No update coverage'], 'results': []}
    try:
        for slug in args.ids:
            print(f'Testing {slug}...', flush=True)
            result = run(slug, args.binary.resolve(), args.output, f'http://127.0.0.1:{server.server_port}/')
            report['results'].append(result)
            (args.output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
            print(result['outcome'] + ': ' + result.get('error', slug), flush=True)
    finally:
        server.shutdown()
        server.server_close()
    return int(any(r['outcome'] != 'SMOKE_PASSED' for r in report['results']))

if __name__ == '__main__':
    raise SystemExit(main())
