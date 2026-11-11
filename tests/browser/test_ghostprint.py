"""Shipping Gecko, early page-realm GhostPrint hooks (no injected test hooks)."""
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parents[2]
class GhostPrint(unittest.TestCase):
    def test_early_hooks_and_controls(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                script = """window.early = {hc:navigator.hardwareConcurrency, plugins:navigator.plugins.length, native:Function.prototype.toString.call(CanvasRenderingContext2D.prototype.getImageData).includes('[native code]')};
const c=document.createElement('canvas'); c.width=c.height=64; const x=c.getContext('2d'); x.fillStyle='rgb(100,100,100)'; x.fillRect(0,0,64,64); const a=x.getImageData(0,0,64,64).data; early.canvas=Array.from(a).filter((v,i)=>i%4!==3&&v!==100).length; early.alpha=Array.from(a).filter((v,i)=>i%4===3&&v!==255).length; early.pixels=Array.from(a).join(','); early.repeat=early.pixels===Array.from(x.getImageData(0,0,64,64).data).join(','); const b=new AudioBuffer({length:2048,sampleRate:44100,numberOfChannels:1}); early.audio=Array.from(b.getChannelData(0)).filter(v=>v!==0).length; early.privileged=typeof Components==='object' && !!Components.classes; const gl=document.createElement('canvas').getContext('webgl'); early.webgl=gl ? {vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),synthetic:gl.getSupportedExtensions().some(e=>/^EXT_(surface|raster|frame|pixel|shader|buffer|vector)_/.test(e))} : null;
"""
                import hashlib, base64
                token=base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
                body = ('<!doctype html><script>'+script+'</script><h1>probe</h1>'+ (f'<iframe src="http://localhost:{self.server.server_port}/frame"></iframe>' if self.path=='/' else '')).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Content-Security-Policy', f"script-src 'sha256-{token}'; object-src 'none'")
                self.end_headers(); self.wfile.write(body)
            def log_message(self, *_): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
        os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS']='1'
        browser=Marionette(bin=os.environ.get('ARGON_TEST_BINARY',str(ROOT/'.cache/argon-dev/runtime/argon')),port=port,headless=True,workspace=str(ROOT/'.cache/browser-tests'),gecko_log=str(ROOT/'artifacts/ghostprint-gecko.log'),prefs={'argon.onboarding.completed':True,'privacy.resistFingerprinting':False,'privacy.resistFingerprinting.pbmode':False,'browser.privatebrowsing.autostart':False,'privacy.fingerprintingProtection':False,'privacy.fingerprintingProtection.pbmode':False})
        try:
            browser.start_session(); browser.set_window_rect(width=1200,height=740); browser.set_context('chrome')
            available=browser.execute_async_script('''const done=arguments[arguments.length-1]; const {ArgonGhostPrint:g}=ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs'); g.ready.then(()=>done(true),e=>done(String(e)));''',sandbox=None)
            # Test-only opt-out after Firefox startup reapplies FPP defaults; production never changes these.
            browser.execute_script("for (const p of ['privacy.resistFingerprinting','privacy.resistFingerprinting.pbmode','privacy.fingerprintingProtection','privacy.fingerprintingProtection.pbmode']) Services.prefs.setBoolPref(p,false)",sandbox=None)
            self.assertIs(available,True)
            browser.set_context('content'); browser.navigate(f'http://127.0.0.1:{server.server_port}/')
            browser.set_context('chrome')
            print('EARLY STATUS',browser.execute_async_script("const done=arguments[arguments.length-1]; gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status').then(done);",sandbox=None))
            browser.set_context('content')
            print('PROBE',browser.execute_script("const e=window.wrappedJSObject.early;return {canvas:e.canvas,audio:e.audio,plugins:e.plugins,native:e.native,source:window.wrappedJSObject.CanvasRenderingContext2D.prototype.getImageData.toString()}"))
            # Gecko hides source for chrome-URL subscripts even in a content realm;
            # observable pixels/samples, not Function.toString, prove installation.
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.plugins'),1)
            first=browser.execute_script('return window.wrappedJSObject.early')
            self.assertGreater(first['canvas'],0); self.assertGreater(first['audio'],0)
            self.assertEqual(first['alpha'],0); self.assertTrue(first['repeat']); self.assertFalse(first['privileged'])
            self.assertIn(first['hc'],[2,4,6,8,12,16])
            print('REAL WEBGL',first['webgl'])
            if first['webgl'] is not None:
                self.assertEqual(first['webgl']['vendor'],'Mozilla'); self.assertEqual(first['webgl']['renderer'],'Mozilla'); self.assertTrue(first['webgl']['synthetic'])
            from marionette_driver.by import By
            browser.switch_to_frame(browser.find_element(By.TAG_NAME,'iframe'))
            frame=browser.execute_script('return window.wrappedJSObject.early')
            browser.set_context('chrome')
            print('FRAME STATUS',browser.execute_async_script("const done=arguments[arguments.length-1]; gBrowser.selectedBrowser.browsingContext.children[0].currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status').then(done);",sandbox=None))
            browser.set_context('content')
            self.assertGreater(frame['canvas'],0)
            self.assertEqual(frame['pixels'],first['pixels'])
            browser.switch_to_default_content()
            browser.navigate(f'http://localhost:{server.server_port}/other')
            other=browser.execute_script('return window.wrappedJSObject.early')
            self.assertGreater(other['canvas'],0); self.assertNotEqual(other['pixels'],first['pixels'])
            browser.navigate(f'http://127.0.0.1:{server.server_port}/')
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.pixels'),first['pixels'])
            browser.set_context('chrome')
            status=browser.execute_async_script('''const done=arguments[arguments.length-1]; gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status').then(done);''',sandbox=None)
            self.assertEqual(status['surfaces']['canvas'],'installed')
            # A page cannot acquire chrome authority through a hook's constructor.
            browser.set_context('content')
            self.assertEqual(browser.execute_script("try { window.wrappedJSObject.CanvasRenderingContext2D.prototype.getImageData.constructor('return typeof ChromeUtils')(); return 'CSP bypass'; } catch(e) { return e.name; }"),'EvalError')
            browser.set_context('chrome')
            from marionette_driver.by import By
            from marionette_driver.wait import Wait
            browser.find_element(By.ID,'argon-adblock-button').click()
            Wait(browser).until(lambda b: b.execute_script("return document.getElementById('argon-adblock-panel').state==='open'",sandbox=None))
            Wait(browser).until(lambda b:b.execute_script("return document.getElementById('argon-adblock-ghost-status').textContent.includes('Hooks')",sandbox=None))
            browser.execute_script("document.getElementById('argon-adblock-middle').scrollTop=0",sandbox=None)
            self.assertTrue(browser.find_element(By.ID,'argon-adblock-ghost-site').is_displayed())
            self.assertTrue(browser.execute_script("const s=document.getElementById('argon-adblock-ghost-status').getBoundingClientRect(),m=document.getElementById('argon-adblock-middle').getBoundingClientRect();return s.top>=m.top&&s.bottom<=m.bottom",sandbox=None))
            self.assertEqual(browser.execute_script("return document.getElementById('argon-adblock-ghost-site').getAttribute('role')",sandbox=None),'switch')
            browser.execute_script("document.getElementById('argon-adblock-ghost-site').scrollIntoView({block:'nearest'})",sandbox=None)
            x,y=browser.execute_script("const r=document.getElementById('argon-adblock-ghost-site').getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]",sandbox=None)
            browser.actions.sequence('pointer','mouse').pointer_move(int(x),int(y)).pointer_down().pointer_up().perform()
            Wait(browser).until(lambda b:b.execute_script("return document.getElementById('argon-adblock-ghost-site').getAttribute('aria-checked')==='false'",sandbox=None))
            browser.execute_script("document.getElementById('argon-adblock-panel').hidePopup()",sandbox=None)
            browser.set_context('content'); browser.refresh()
            self.assertTrue(browser.execute_script('return window.wrappedJSObject.early.native'))
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.canvas'),0)
            browser.switch_to_frame(browser.find_element(By.TAG_NAME,'iframe'))
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.canvas'),0)
            browser.switch_to_default_content()
            browser.set_context('chrome')
            browser.execute_script("ChromeUtils.importESModule('chrome://browser/content/argon/adblock/ghostprint.sys.mjs').ArgonGhostPrint.setSite(gBrowser.currentURI.spec,true,false)",sandbox=None)
            def click_panel(id):
                browser.execute_script("document.getElementById(arguments[0]).scrollIntoView({block:'nearest'})",[id],sandbox=None)
                x,y=browser.execute_script("const r=document.getElementById(arguments[0]).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]",[id],sandbox=None)
                browser.actions.sequence('pointer','mouse').pointer_move(int(x),int(y)).pointer_down().pointer_up().perform()
            browser.find_element(By.ID,'argon-adblock-button').click(); click_panel('argon-adblock-settings')
            click_panel('argon-adblock-ghost-canvas')
            self.assertFalse(browser.execute_script("return Services.prefs.getBoolPref('argon.ghostprint.canvas')",sandbox=None))
            click_panel('argon-adblock-close'); browser.set_context('content'); browser.refresh()
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.canvas'),0)
            self.assertGreater(browser.execute_script('return window.wrappedJSObject.early.audio'),0)
            browser.set_context('chrome'); browser.find_element(By.ID,'argon-adblock-button').click(); click_panel('argon-adblock-settings')
            click_panel('argon-adblock-ghost-canvas'); click_panel('argon-adblock-ghost-global')
            self.assertTrue(browser.execute_script("return Services.prefs.getBoolPref('argon.adblock.enabled',true)",sandbox=None))
            click_panel('argon-adblock-close'); browser.set_context('content'); browser.refresh()
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.canvas'),0)
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.audio'),0)
            browser.set_context('chrome'); browser.find_element(By.ID,'argon-adblock-button').click(); click_panel('argon-adblock-settings')
            click_panel('argon-adblock-ghost-global'); click_panel('argon-adblock-close')
            # Private realm has a distinct seed, and exceptions never enter persistent prefs.
            normal_handle=browser.current_window_handle
            browser.execute_script('OpenBrowserWindow({private:true})',sandbox=None)
            Wait(browser).until(lambda b:len(b.window_handles)>1)
            private_handle=next(h for h in browser.window_handles if h!=normal_handle)
            browser.switch_to_window(private_handle)
            browser.set_context('content'); browser.navigate(f'http://127.0.0.1:{server.server_port}/')
            private=browser.execute_script('return window.wrappedJSObject.early')
            self.assertGreater(private['canvas'],0); self.assertNotEqual(private['pixels'],first['pixels'])
            browser.set_context('chrome')
            browser.find_element(By.ID,'argon-adblock-button').click(); click_panel('argon-adblock-ghost-site'); click_panel('argon-adblock-close')
            self.assertNotIn('127.0.0.1',browser.execute_script("return Services.prefs.getStringPref('argon.ghostprint.sites','[]')",sandbox=None))
            browser.set_context('content'); browser.refresh()
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.canvas'),0)
            browser.close(); browser.switch_to_window(normal_handle); browser.set_context('content'); browser.refresh()
            self.assertEqual(browser.execute_script('return window.wrappedJSObject.early.pixels'),first['pixels'])
            browser.set_context('chrome')
            browser.execute_script("Services.prefs.setBoolPref('privacy.resistFingerprinting',true)",sandbox=None)
            browser.set_context('content'); browser.refresh(); browser.set_context('chrome')
            conflict=browser.execute_async_script("const done=arguments[arguments.length-1];gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor('ArgonGhostPrint').sendQuery('status').then(done)",sandbox=None)
            self.assertEqual(conflict['state'],'installed')
            self.assertTrue(browser.execute_script("return Services.prefs.getBoolPref('privacy.resistFingerprinting')",sandbox=None))
        finally:
            browser.cleanup(); server.shutdown(); server.server_close()
if __name__=='__main__': unittest.main()
