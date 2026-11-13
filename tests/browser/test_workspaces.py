"""Real container storage isolation in packaged Argon; temporary profile only.

Every assertion runs against the packaged browser: the workspace controller
must hand Gecko a container before the first request, keep cookies and
localStorage apart between workspaces, survive a restart, keep private windows
separate from normal ones, and reopen a tab inside the destination workspace
instead of moving its session.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from marionette_driver.errors import JavascriptException
from marionette_driver.wait import Wait
from test_settings import SettingsSmoke

NAVIGABLE_MANAGER = """
    const nav = ChromeUtils.importESModule(
        'chrome://remote/content/shared/NavigableManager.sys.mjs').NavigableManager;
"""


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<!doctype html><title>Workspace isolation</title><p>Storage fixture</p>')

    def log_message(self, *_):
        pass


def window_picker(private):
    """JavaScript that resolves the normal or the private browser window."""
    test = (
        "PrivateBrowsingUtils.isWindowPrivate(w)"
        if private
        else "!PrivateBrowsingUtils.isWindowPrivate(w)"
    )
    return (
        "[...Services.wm.getEnumerator('navigator:browser')]"
        f".find(w => {test})"
    )


class WorkspaceIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SettingsSmoke.setUpClass.__func__(cls)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Page)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        SettingsSmoke.tearDownClass.__func__(cls)

    # -- helpers ---------------------------------------------------------
    def chrome(self, script, args=()):
        """Run a chrome script in the current browser window."""
        self.browser.set_context('chrome')
        return self.browser.execute_script(script, args, sandbox=None)

    def chrome_in(self, private, script, args=()):
        """Run a chrome script against the normal or the private window."""
        self.browser.set_context('chrome')
        prelude = (
            f"const win = {window_picker(private)};\n"
            "if (!win) { throw new Error('browser window not found'); }\n"
        )
        return self.browser.execute_script(prelude + script, args, sandbox=None)

    def focus_window(self, private=False):
        """Point the chrome context at the normal or the private window."""
        handle = self.chrome_in(private, NAVIGABLE_MANAGER + """
            return nav.getIdForBrowsingContext(win.browsingContext);
        """)
        self.browser.set_context('chrome')
        self.browser.switch_to_window(handle)
        return handle

    def select_tab(self, private=False):
        """Point the content context at the selected tab of a window."""
        handle = self.chrome_in(private, NAVIGABLE_MANAGER + """
            return nav.getIdForBrowser(win.gBrowser.selectedBrowser);
        """)
        self.browser.set_context('content')
        self.browser.switch_to_window(handle)
        return handle

    def storage(self, private=False):
        """Load the fixture in the selected tab and read its stored state."""
        self.select_tab(private)
        self.browser.navigate(self.url)
        return self.browser.execute_script(
            'return {cookie: document.cookie, local: localStorage.getItem("workspace")};'
        )

    def write(self, value):
        self.browser.execute_script(
            'document.cookie = "workspace=" + arguments[0] + "; Path=/";'
            ' localStorage.setItem("workspace", arguments[0]);',
            [value],
        )

    def containers(self, private=False):
        return self.chrome_in(private, """
            return JSON.parse(Services.prefs.getStringPref('argon.workspaces.containers'));
        """)

    # -- tests ------------------------------------------------------------
    def test_01_storage_and_pin_isolation(self):
        Wait(self.browser, timeout=30).until(
            lambda _: self.chrome('return !!window.ArgonWorkspaces;')
        )
        state = self.chrome('return window.ArgonWorkspaces.getState();')
        self.assertTrue(state['isolated'])
        self.chrome(
            "window.ArgonWorkspaces.setActiveWorkspace('general');"
            " window.__generalTab = gBrowser.selectedTab;"
        )
        self.assertEqual(self.storage(), {'cookie': '', 'local': None})
        self.write('general')
        self.chrome(
            "gBrowser.pinTab(window.__generalTab);"
            " window.ArgonWorkspaces.setActiveWorkspace('work');"
            " window.__workTab = gBrowser.selectedTab;"
        )
        self.assertTrue(self.chrome('return window.__generalTab.hidden;'))
        self.assertGreater(self.chrome('return gBrowser.selectedTab.userContextId;'), 0)
        self.assertEqual(self.storage(), {'cookie': '', 'local': None})
        self.write('work')
        self.chrome("window.ArgonWorkspaces.setActiveWorkspace('personal');")
        self.assertEqual(self.storage(), {'cookie': '', 'local': None})
        self.write('personal')
        self.chrome("window.ArgonWorkspaces.setActiveWorkspace('work');")
        self.assertEqual(self.storage(), {'cookie': 'workspace=work', 'local': 'work'})
        # A normal new tab must receive the context before its first request.
        self.chrome(
            "gBrowser.selectedTab = gBrowser.addTrustedTab(arguments[0]);", [self.url]
        )
        self.assertEqual(self.storage(), {'cookie': 'workspace=work', 'local': 'work'})
        self.chrome("window.ArgonWorkspaces.setActiveWorkspace('general');")
        self.assertEqual(self.storage(), {'cookie': 'workspace=general', 'local': 'general'})
        self.assertFalse(self.chrome('return window.__generalTab.hidden;'))
        mapping = self.chrome(
            'return Services.prefs.getStringPref("argon.workspaces.containers");'
        )
        self.browser.restart(in_app=True)
        Wait(self.browser, timeout=30).until(
            lambda _: self.chrome('return !!window.ArgonWorkspaces;')
        )
        self.assertEqual(
            self.chrome('return Services.prefs.getStringPref("argon.workspaces.containers");'),
            mapping,
        )
        self.chrome("window.ArgonWorkspaces.setActiveWorkspace('work');")
        # Argon's default shutdown sanitization must remain effective.
        self.assertEqual(self.storage()['local'], None)
        self.write('work')
        self.chrome("window.ArgonWorkspaces.setActiveWorkspace('personal');")
        self.assertEqual(self.storage()['local'], None)
        self.write('personal')

    def test_02_private_window_keeps_its_own_sessions(self):
        # Marionette only opens windows for a Firefox branded build, so open the
        # private window through the helper the browser itself uses.
        self.browser.set_context('chrome')
        self.browser.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            const {URILoadingHelper} = ChromeUtils.importESModule(
                'resource:///modules/URILoadingHelper.sys.mjs');
            URILoadingHelper.openTrustedLinkIn(window, 'about:blank', 'window', {
                private: true,
                resolveOnContentBrowserCreated: () => done(true),
            });
            """,
            sandbox=None,
        )
        Wait(self.browser, timeout=30).until(
            lambda _: self.chrome_in(True, 'return !!win.ArgonWorkspaces;')
        )
        self.focus_window(False)
        state = self.chrome_in(True, 'return win.ArgonWorkspaces.getState();')
        self.assertTrue(state['isolated'])
        self.assertTrue(state['privateWindow'])
        # The private window reuses the containers of the normal profile.
        self.assertEqual(self.containers(True), self.containers(False))
        self.chrome_in(True, "win.ArgonWorkspaces.setActiveWorkspace('work');")
        self.assertEqual(self.storage(True), {'cookie': '', 'local': None})
        self.write('private-work')
        self.chrome_in(True, "win.ArgonWorkspaces.setActiveWorkspace('personal');")
        self.assertEqual(self.storage(True), {'cookie': '', 'local': None})
        self.write('private-personal')
        self.chrome_in(True, "win.ArgonWorkspaces.setActiveWorkspace('work');")
        self.assertEqual(
            self.storage(True), {'cookie': 'workspace=private-work', 'local': 'private-work'}
        )
        # The normal window keeps its own session for the same container.
        self.chrome_in(False, "win.ArgonWorkspaces.setActiveWorkspace('work');")
        self.assertEqual(self.storage(False), {'cookie': 'workspace=work', 'local': 'work'})
        self.chrome_in(True, 'win.close();')
        self.focus_window(False)

    def test_03_tab_reopens_inside_the_destination_workspace(self):
        self.chrome_in(False, "win.ArgonWorkspaces.setActiveWorkspace('work');")
        self.chrome_in(
            False,
            """
            win.__movedTab = win.gBrowser.addTrustedTab(arguments[0]);
            win.gBrowser.selectedTab = win.__movedTab;
            return true;
            """,
            [self.url],
        )
        Wait(self.browser, timeout=30).until(
            lambda _: self.chrome_in(
                False, 'return win.gBrowser.selectedTab.linkedBrowser.currentURI.spec === arguments[0];',
                [self.url],
            )
        )
        before = self.chrome_in(False, 'return win.gBrowser.tabs.length;')
        source = self.chrome_in(
            False,
            """
            win.gBrowser.selectedTab.setAttribute('data-argon-test-source', 'yes');
            return {
                userContextId: win.gBrowser.selectedTab.userContextId,
                marker: win.gBrowser.selectedTab.getAttribute('data-argon-test-source'),
            };
            """,
        )
        destination = self.containers(False)['personal']
        moved = self.chrome_in(
            False,
            """
            const tab = win.ArgonWorkspaces.assignTabToWorkspace(
                win.gBrowser.selectedTab, 'personal');
            return {
                userContextId: tab ? tab.userContextId : null,
                url: tab ? tab.linkedBrowser.currentURI.spec : null,
                selected: win.gBrowser.selectedTab === tab,
                workspace: win.ArgonWorkspaces.getTabWorkspace(tab),
                tabs: win.gBrowser.tabs.length,
                marker: tab ? tab.getAttribute('data-argon-test-source') : null,
                sourceStillOpen: win.gBrowser.tabs.includes(win.__movedTab),
            };
            """,
        )
        self.assertEqual(source['marker'], 'yes')
        self.assertIsNone(moved['marker'])
        self.assertEqual(moved['userContextId'], destination)
        self.assertEqual(moved['workspace'], 'personal')
        self.assertTrue(moved['selected'])
        self.assertFalse(moved['sourceStillOpen'])
        self.assertEqual(moved['tabs'], before)
        # The reopened tab loads the same address inside the new container.
        Wait(self.browser, timeout=30).until(
            lambda _: self.chrome_in(
                False,
                'return win.gBrowser.selectedTab.linkedBrowser.currentURI.spec === arguments[0];',
                [self.url],
            )
        )
        # The reopened tab joins the destination session and loses the old one.
        self.assertEqual(
            self.storage(False), {'cookie': 'workspace=personal', 'local': 'personal'}
        )
        self.chrome_in(False, "win.ArgonWorkspaces.setActiveWorkspace('work');")
        self.assertEqual(self.storage(False), {'cookie': 'workspace=work', 'local': 'work'})

    def test_04_workspace_deletion_needs_an_empty_workspace(self):
        created = self.chrome_in(False, "return win.ArgonWorkspaces.createWorkspace({name: 'Scratch'});")
        scratch = created['id']
        self.assertIn(scratch, self.containers(False))
        self.chrome_in(False, f"win.ArgonWorkspaces.setActiveWorkspace('{scratch}');")
        with self.assertRaises(JavascriptException) as ctx:
            self.chrome_in(False, f"win.ArgonWorkspaces.deleteWorkspace('{scratch}');")
        self.assertIn('Move or close', str(ctx.exception))
        with self.assertRaises(JavascriptException) as ctx:
            self.chrome_in(False, "win.ArgonWorkspaces.deleteWorkspace('general');")
        self.assertIn('default storage workspace', str(ctx.exception))
        # Closing the tab releases the workspace and its container.
        scratch_container = self.containers(False)[scratch]
        self.chrome_in(
            False,
            """
            win.ArgonWorkspaces.assignTabToWorkspace(win.gBrowser.selectedTab, 'general');
            return true;
            """,
        )
        state = self.chrome_in(
            False, f"win.ArgonWorkspaces.deleteWorkspace('{scratch}'); return win.ArgonWorkspaces.getState();"
        )
        self.assertNotIn(scratch, [ws['id'] for ws in state['workspaces']])
        self.assertNotIn(scratch, self.containers(False))
        self.assertIsNone(
            self.chrome_in(
                False,
                """
                const service = ChromeUtils.importESModule(
                    'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs'
                ).ContextualIdentityService;
                try {
                    return service.getPublicIdentityFromId(arguments[0]) ? 'present' : null;
                } catch (error) {
                    return null;
                }
                """,
                [scratch_container],
            )
        )


if __name__ == '__main__':
    unittest.main(defaultTest='WorkspaceIsolation')
