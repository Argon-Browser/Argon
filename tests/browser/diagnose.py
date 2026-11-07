"""Diagnostic: compare a clean Firefox profile against an injected Argon profile.

Prints DOM facts (nav-bar children, URL bar state, sidebar geometry, vertical
tab state) and saves screenshots under artifacts/chrome-smoke/ so the two runs
can be compared pixel by pixel.
"""
import gc
import os
import shutil
import socket
import tempfile
from pathlib import Path
from unittest.mock import patch

from marionette_driver.marionette import Marionette

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts" / "chrome-smoke"
WORKSPACE = ROOT / ".cache" / "browser-tests"

FACTS = """
const out = {};
out.navBarChildren = [...document.getElementById("nav-bar").children].map(
  el => el.id || el.tagName);
out.urlbarVisible = (() => {
  const u = document.getElementById("urlbar");
  if (!u) return "missing";
  const r = u.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height,
           hidden: u.hidden, collapsed: u.collapsed };
})();
out.sidebarBox = (() => {
  const s = document.getElementById("sidebar-box");
  if (!s) return "missing";
  const r = s.getBoundingClientRect();
  return { x: r.x, w: r.width, h: r.height, hidden: s.hidden };
})();
out.verticalTabsPref = (() => {
  try { return Services.prefs.getBoolPref("sidebar.verticalTabs"); }
  catch (e) { return "unset"; }
})();
out.revampPref = (() => {
  try { return Services.prefs.getBoolPref("sidebar.revamp"); }
  catch (e) { return "unset"; }
})();
out.tabStripParent = (() => {
  const t = document.getElementById("tabbrowser-tabs");
  return t ? t.parentElement.id || t.parentElement.tagName : "missing";
})();
out.tabbrowserArrow = !!document.getElementById("tabbrowser-arrowscrollbox");
out.selectedTab = (() => {
  const t = gBrowser.selectedTab;
  const r = t.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, label: t.label };
})();
out.argonButton = (() => {
  const b = document.getElementById("argon-appearance-button");
  if (!b) return "missing";
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, hidden: b.hidden,
           parentOverflow: !!b.closest("#widget-overflow") };
})();
return out;
"""


def launch(name):
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    resources = Path(tempfile.mkdtemp(prefix=f"argon-{name}-", dir=WORKSPACE))
    for source in [
        ROOT / "argon/preferences/appearance.mjs",
        ROOT / "browser/base/content/argon-controller.mjs",
        ROOT / "argon/design-system/tokens.css",
        ROOT / "browser/themes/shared/argon.css",
    ]:
        if source.exists():
            shutil.copy2(source, resources / source.name)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with patch.dict(os.environ, {"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}):
        browser = Marionette(
            bin=os.environ.get("ARGON_TEST_BINARY", "/usr/lib/firefox/firefox"),
            port=port,
            workspace=str(WORKSPACE),
            headless=True,
            gecko_log=str(ARTIFACTS / f"{name}.log"),
            startup_timeout=90,
            prefs={"browser.shell.checkDefaultBrowser": False},
        )
    try:
        browser.start_session()
        browser.set_context("chrome")
        browser.set_window_rect(width=1280, height=900)
    except Exception:
        # Never leave a half-started browser behind when setup fails.
        browser.cleanup()
        shutil.rmtree(resources, ignore_errors=True)
        raise
    return browser, resources


def main():
    results = {}
    for name, inject in [("control", False), ("injected", True)]:
        browser, resources = launch(name)
        try:
            if inject:
                browser.execute_script("""
                    const handler = Services.io.getProtocolHandler("resource")
                        .QueryInterface(Ci.nsIResProtocolHandler);
                    handler.setSubstitution("argon-test", Services.io.newURI(arguments[0]));
                    const { installArgonAppearance } =
                        ChromeUtils.importESModule("resource://argon-test/argon-controller.mjs");
                    installArgonAppearance(window, Services.prefs);
                    for (const url of arguments[1]) {
                      const link = document.createElementNS(
                        "http://www.w3.org/1999/xhtml", "link");
                      link.rel = "stylesheet";
                      link.href = url;
                      document.head.append(link);
                    }
                """, [resources.as_uri() + "/",
                      ["resource://argon-test/" + n for n in ["tokens.css", "argon.css"]]],
                     sandbox=None)
                browser.execute_script("window.ArgonAppearance.setLayout('vertical');",
                                       sandbox=None)
            facts = browser.execute_script(FACTS, sandbox=None)
            (ARTIFACTS / f"{name}-vertical.png").write_bytes(
                browser.screenshot(format="binary"))
            browser.execute_script(
                "window.ArgonAppearance?.setLayout('horizontal');", sandbox=None)
            (ARTIFACTS / f"{name}-horizontal.png").write_bytes(
                browser.screenshot(format="binary"))
            results[name] = facts
        finally:
            browser.cleanup()
            browser.instance.close(clean=True)
            del browser
            gc.collect()
            shutil.rmtree(resources)
    for name, facts in results.items():
        print(f"=== {name} ===")
        for key, value in facts.items():
            print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
