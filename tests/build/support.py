"""Shared helpers for the offline Argon build tooling tests."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "argon.py"
REFERENCE = REPO / "config" / "source-reference"
REAL_LOCK = REPO / "config" / "firefox.lock.json"
NEWTAB_PREFERENCES = "browser/extensions/newtab/lib/AboutPreferences.sys.mjs"
HOOK_PATHS = [
    "browser/base/content/browser.xhtml",
    "browser/base/jar.mn",
    "browser/app/profile/firefox.js",
    NEWTAB_PREFERENCES,
    "browser/moz.configure",
]
REVISION = "d9bd6be9a67efb1c2667ef91a89856f35eb7cf5e"
ARCHIVE_ROOT = f"firefox-{REVISION}"
# Upstream defaults these Nova UI flags to true in browser/app/profile/firefox.js;
# Argon overrides them to false in argon/preferences/argon-prefs.js.
NOVA_PREFS = [
    "browser.nova.enabled",
    "browser.newtabpage.activity-stream.nova.enabled",
    "browser.aboutaddons.novaThemesPickerEnabled",
]
# Every preference that can make the New Tab page request or render a
# sponsored shortcut. Argon defaults all of them to false.
SPONSORED_SHORTCUT_PREFS = [
    "browser.newtabpage.activity-stream.showSponsoredTopSites",
    "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
    "browser.topsites.contile.enabled",
    "browser.newtabpage.activity-stream.unifiedAds.tiles.enabled",
    "browser.urlbar.sponsoredTopSites",
]
# New Tab widgets and recommended stories default to disabled in Argon while
# staying user-toggleable from New Tab and about:preferences#home.
NEWTAB_WIDGET_PREFS = [
    "browser.newtabpage.activity-stream.widgets.enabled",
    "browser.newtabpage.activity-stream.showWeather",
    "browser.newtabpage.activity-stream.widgets.weather.enabled",
    "browser.newtabpage.activity-stream.widgets.weatherForecast.enabled",
    "browser.newtabpage.activity-stream.widgets.pictureOfTheDay.enabled",
    "browser.newtabpage.activity-stream.widgets.clocks.enabled",
    "browser.newtabpage.activity-stream.widgets.lists.enabled",
    "browser.newtabpage.activity-stream.widgets.focusTimer.enabled",
    "browser.newtabpage.activity-stream.widgets.privacy.enabled",
    "browser.newtabpage.activity-stream.widgets.crossword.enabled",
    "browser.newtabpage.activity-stream.widgets.stocks.enabled",
    "browser.newtabpage.activity-stream.widgets.recentSearches.enabled",
    "browser.newtabpage.activity-stream.widgets.horoscopes.enabled",
    "browser.newtabpage.activity-stream.widgets.travel.enabled",
    "browser.newtabpage.activity-stream.widgets.solitaire.enabled",
    "browser.newtabpage.activity-stream.widgets.wrexhamAFC.enabled",
]
NEWTAB_STORIES_PREFS = [
    "browser.newtabpage.activity-stream.feeds.section.topstories",
]


def load_tool():
    spec = importlib.util.spec_from_file_location("argon_build", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_lock(path, *, archive_url, archive_sha256, archive_root=ARCHIVE_ROOT):
    """A copy of the real lock with a redirected source archive (tests stay offline)."""
    data = json.loads(REAL_LOCK.read_text())
    data["source"]["archive_url"] = archive_url
    data["source"]["archive_sha256"] = archive_sha256
    data["source"]["archive_root"] = archive_root
    path.write_text(json.dumps(data, indent=2) + "\n")
    return path


def make_source_tree(root):
    """A stand-in upstream checkout whose hook files match the pinned hashes."""
    for rel in HOOK_PATHS:
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REFERENCE / rel, dest)
    mach = root / "mach"
    mach.write_text("#!/bin/sh\nexit 0\n")
    mach.chmod(0o755)
    return root


def write_source_info(workspace, **overrides):
    info = {
        "revision": REVISION,
        "archive_url": "https://example.invalid/source.tar.gz",
        "archive_sha256": "0" * 64,
        "archive_root": ARCHIVE_ROOT,
        "hook_sha256": {rel: None for rel in HOOK_PATHS},
    }
    info.update(overrides)
    path = workspace / "source-info.json"
    path.write_text(json.dumps(info, indent=2) + "\n")
    return path


def make_archive(path, root=ARCHIVE_ROOT, files=None):
    """Build a gzipped tarball with the pinned archive root directory."""
    files = files or {
        "mach": "#!/bin/sh\nexit 0\n",
        "browser/base/jar.mn": "browser.jar:\n",
        "configure": "#!/bin/sh\nexit 0\n",
    }
    with tarfile.open(path, "w:gz") as tar:
        for name, text in files.items():
            member = tarfile.TarInfo(f"{root}/{name}")
            payload = text.encode()
            member.size = len(payload)
            member.mode = 0o755 if name in ("mach", "configure") else 0o644
            import io

            tar.addfile(member, io.BytesIO(payload))
    return path


def run_cli(args, *, workspace, lock=None, env=None):
    argv = [sys.executable, str(SCRIPT), "--workspace", str(workspace)]
    if lock is not None:
        argv += ["--lock", str(lock)]
    argv += list(args)
    return subprocess.run(argv, capture_output=True, text=True, check=False, env=env)


def workspace_dir(tmp, name="workspace"):
    return Path(tmp) / name
