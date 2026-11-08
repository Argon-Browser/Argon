"""Capture actual native popup pixels on DISPLAY, never a DOM reconstruction.

Run using the browser-test venv; system python3 needs Pillow and an X11 display.
Uses a temporary Marionette profile and a local HTTP page. No user profile.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from marionette_driver.marionette import Marionette
from marionette_driver.by import By
from marionette_driver.wait import Wait

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/adblock-native'
OUT.mkdir(parents=True, exist_ok=True)

class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<!doctype html><title>Argon local protection test</title><h1>Local protection test</h1>')
    def log_message(self, *_): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'] = '1'
browser = Marionette(bin=str(ROOT / '.cache/argon-dev/runtime/argon'), port=port,
    headless=False, workspace=str(ROOT / '.cache/browser-tests'),
    gecko_log=str(OUT / 'gecko.log'), prefs={'argon.onboarding.completed': True,
    'extensions.update.enabled': False, 'extensions.update.autoUpdateDefault': False,
    'argon.theme': 'dark'})

def click(id):
    x, y = browser.execute_script("const r=document.getElementById(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]", [id], sandbox=None)
    browser.actions.sequence('pointer', 'mouse').pointer_move(int(x), int(y)).pointer_down().pointer_up().perform()

try:
    browser.start_session()
    browser.set_window_rect(x=0, y=0, width=1200, height=740)
    browser.navigate(f'http://127.0.0.1:{server.server_port}/')
    browser.set_context('chrome')
    browser.execute_async_script("const done=arguments[arguments.length-1]; ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.ready.then(()=>done(true));", sandbox=None)
    browser.find_element(By.ID, 'argon-adblock-button').click()
    Wait(browser).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-panel').state === 'open'", sandbox=None))
    records = []
    for name, theme, target in [('home-dark', 'dark', None), ('lists-dark', 'dark', 'argon-adblock-lists-toggle'), ('settings-light', 'light', 'argon-adblock-settings')]:
        browser.execute_script("Services.prefs.setStringPref('argon.theme', arguments[0]);", [theme], sandbox=None)
        if target: click(target)
        time.sleep(.5)
        geometry = browser.execute_script("""
          const ids=['header','middle','footer','scope'];
          return Object.fromEntries(ids.map(id=>{const e=document.getElementById('argon-adblock-'+id),r=e.getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}]}));
        """, sandbox=None)
        assert geometry['footer']['y'] >= geometry['middle']['y'] + geometry['middle']['height'] - 1
        assert geometry['footer']['height'] > 100
        if target: assert geometry['middle']['scrollHeight'] > geometry['middle']['clientHeight']
        crop = browser.execute_script("const r=document.querySelector('.argon-adblock-body').getBoundingClientRect(); return [window.mozInnerScreenX+r.left,window.mozInnerScreenY+r.top,window.mozInnerScreenX+r.right,window.mozInnerScreenY+r.bottom]", sandbox=None)
        subprocess.run(['python3', '-c', 'from PIL import ImageGrab; import sys,json; ImageGrab.grab().crop(tuple(round(v) for v in json.loads(sys.argv[2]))).save(sys.argv[1])', str(OUT / f'{name}.png'), json.dumps(crop)], check=True)
        records.append({'capture': name, 'geometry': geometry, 'source': 'X11 desktop pixels, real native popup'})
    (OUT / 'geometry.json').write_text(json.dumps(records, indent=2))
    print(json.dumps(records, indent=2))
finally:
    browser.cleanup()
    server.shutdown()
    server.server_close()
