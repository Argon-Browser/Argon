#!/usr/bin/env python3

import datetime
import json
import os
import pathlib
import shutil
import sys

start_time = datetime.datetime.now()

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


#
# Helper functions
#

def mkdirp(path):
    os.makedirs(path, exist_ok=True)


def cp(src, dst):
    shutil.copy(src, dst)


def rm(path):
    if os.path.exists(path):
        os.remove(path)


def rmdir(path):
    if os.path.exists(path):
        shutil.rmtree(path)


def exec(cmd):
    if cmd != "":
        print("-> {}".format(cmd))
        retval = os.system(cmd)
        if retval != 0:
            print("fatal error: command '{}' failed (retval={})".format(cmd, retval))
            sys.exit(1)


def patch(patchfile):
    cmd = "patch -p1 -i ../{}".format(patchfile)
    print("\n*** -> {}".format(cmd))
    retval = os.system(cmd)
    if retval != 0:
        print("fatal error: patch '{}' failed".format(patchfile))
        sys.exit(1)


#
# Process CLI arguments
#

args = sys.argv[1:]
no_execute = False
create_mozconfig = True
while len(args) > 0:
    if args[0] == "--no-execute":
        no_execute = True
        args.pop(0)
    elif args[0] == "--no-mozconfig":
        create_mozconfig = False
        args.pop(0)
    else:
        break

if len(args) != 2:
    sys.stderr.write("error: please specify version and release of Argon source\n")
    sys.exit(1)

version = args[0]
release = args[1]

srcdir = "argon-{}-{}".format(version, release)
if not os.path.exists(srcdir + "/configure.py") and os.path.exists("librewolf-{}-{}/configure.py".format(version, release)):
    srcdir = "librewolf-{}-{}".format(version, release)
if not os.path.exists(srcdir + "/configure.py"):
    print("fatal error: '{}' directory not found.".format(srcdir))
    sys.exit(1)


def apply_argon_overlay():
    """Apply the Argon branding, design system tokens, UI controller, and preferences."""
    overlay_path = REPO_ROOT / "config" / "overlay.json"
    if not overlay_path.is_file():
        return
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))

    branding = overlay.get("branding")
    if branding:
        src_branding = REPO_ROOT / branding["from"]
        dst_branding = pathlib.Path(branding["to"])
        if dst_branding.exists():
            shutil.rmtree(dst_branding)
        dst_branding.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src_branding, dst_branding)

    for entry in overlay.get("files", []):
        src_file = REPO_ROOT / entry["from"]
        dst_file = pathlib.Path(entry["to"])
        dst_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dst_file)

    hooks_inc = REPO_ROOT / "browser" / "base" / "content" / "argon-window-hooks.inc.xhtml"
    if hooks_inc.is_file():
        dst_inc = pathlib.Path("browser/base/content/argon-window-hooks.inc.xhtml")
        dst_inc.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(hooks_inc, dst_inc)

    for hook in overlay.get("hooks", []):
        target = pathlib.Path(hook["path"])
        if not target.is_file():
            continue
        text = target.read_text(encoding="utf-8")

        if "entries" in hook:
            begin, end = "# BEGIN Argon overlay", "# END Argon overlay"
            lines = [begin]
            for item in hook["entries"]:
                lines.append(f"  {item['destination']} ({item['source']})")
            lines.append(end)
            block = "\n".join(lines)
            anchor = hook["anchor"]
            if begin not in text and anchor in text:
                text = text.replace(anchor, f"{block}\n{anchor}", 1)
                target.write_text(text, encoding="utf-8")

        elif hook.get("path", "").endswith(".xhtml") and "include" in hook:
            begin, end = "<!-- BEGIN Argon overlay -->", "<!-- END Argon overlay -->"
            block = f"{begin}\n#include {hook['include']}\n{end}"
            anchor = hook["anchor"]
            if begin not in text and anchor in text:
                text = text.replace(anchor, f"{anchor}\n{block}", 1)
                target.write_text(text, encoding="utf-8")

        elif hook.get("path", "").endswith(".js") and "include" in hook:
            begin, end = "// BEGIN Argon overlay", "// END Argon overlay"
            prefs_file = REPO_ROOT / "argon" / "preferences" / hook["include"]
            if begin not in text and prefs_file.is_file():
                body = prefs_file.read_text(encoding="utf-8").strip()
                text = f"{text.rstrip()}\n\n{begin}\n{body}\n{end}\n"
                target.write_text(text, encoding="utf-8")

        elif "replace_line" in hook:
            begin, end = "# BEGIN Argon overlay", "# END Argon overlay"
            needle = hook["replace_line"]
            body = "\n".join([f"# upstream: {needle}", *hook["lines"]])
            block = f"{begin}\n{body}\n{end}"
            if begin not in text and needle in text:
                text = text.replace(needle, block, 1)
                target.write_text(text, encoding="utf-8")

        elif "replacements" in hook:
            updated = text
            for item in hook["replacements"]:
                if item["old"] in updated and item["new"] not in updated:
                    updated = updated.replace(item["old"], item["new"], 1)
            if updated != text:
                target.write_text(updated, encoding="utf-8")


#
# Main function
#

def librewolf_patches():
    print("Entering '{}'...".format(srcdir))
    os.chdir(srcdir)

    # Create the right mozconfig file
    if create_mozconfig:
        cp("../assets/mozconfig.new", "mozconfig")

    # Copy rows ofpatches.txt into array
    with open("../assets/patches.txt") as f:
        patch_files = [line.rstrip() for line in f]

    # Copy theme files and Argon branding
    exec("cp -r ../themes/browser .")
    exec("mkdir -p browser/branding && cp -r ../browser/branding/argon browser/branding/argon")

    # Apply patches inside patches.txt
    for patch_file in patch_files:
        if not patch_file.startswith("#"):
            patch(patch_file)

    # Copy settings directory
    exec("cp -vr ../settings .")

    # Provide build ID based on release timestamp
    with open("../release-timestamp", "r") as file:
        timestamp = int(file.read().strip())
        timestamp_str = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
        with open("build-id", "w") as f:
            print("build-id: {}".format(timestamp_str))
            f.write(timestamp_str + "\n")

    # Check if version contains 'rc'
    if "rc" in version:
        # Remove the 'rc*' part from version
        clean_version = version.split("rc")[0]
        version_display = "{}-{}\n".format(clean_version, release)
    else:
        version_display = "{}-{}\n".format(version, release)

    with open("config/version_display.txt", "w") as f:
        print("version_display.txt: {}".format(version_display.strip()))
        f.write(version_display)

    # Patch the manual configuration on standard pane
    mkdirp("browser/themes/shared/preferences")
    cp("../patches/pref-pane/category-librewolf.svg", "browser/themes/shared/preferences/category-librewolf.svg")
    cp("../patches/pref-pane/librewolf.css", "browser/themes/shared/preferences/librewolf.css")
    mkdirp("browser/components/preferences")
    cp("../patches/pref-pane/librewolf.inc.xhtml", "browser/components/preferences/librewolf.inc.xhtml")
    cp("../patches/pref-pane/librewolf.js", "browser/components/preferences/librewolf.js")

    exec("""

    cat ../l10n/en-US/browser/browser/preferences/preferences.inc.ftl >> browser/locales/en-US/browser/preferences/preferences.ftl
    cat ../l10n/en-US/browser/browser/preferences/permissions.inc.ftl >> browser/locales/en-US/browser/preferences/permissions.ftl
    cat ../l10n/en-US/browser/browser/aboutDialog.inc.ftl >> browser/locales/en-US/browser/aboutDialog.ftl
    cat ../l10n/en-US/browser/browser/browser.inc.ftl >> browser/locales/en-US/browser/browser.ftl
    cat ../l10n/en-US/browser/browser/translations.inc.ftl >> browser/locales/en-US/browser/translations.ftl
    cat ../l10n/en-US/browser/chrome/browser/sitePermissions.inc.properties >> browser/locales/en-US/chrome/browser/sitePermissions.properties
    cat ../l10n/en-US/browser/chrome/browser/browser.inc.properties >> browser/locales/en-US/chrome/browser/browser.properties
    cat ../l10n/en-US/toolkit/toolkit/pictureinpicture/pictureinpicture.inc.ftl >> toolkit/locales/en-US/toolkit/pictureinpicture/pictureinpicture.ftl
    cat ../l10n/en-US/browser/browser/newtab/newtab.inc.ftl >> browser/locales/en-US/browser/newtab/newtab.ftl
    cp ../l10n/en-US/toolkit/toolkit/branding/brandings.ftl toolkit/locales/en-US/toolkit/branding/brandings.ftl
    cat ../l10n/en-US/browser/browser/customkeys.inc.ftl >> browser/locales/en-US/browser/customkeys.ftl

    sed -i 's/Firefox/Argon/g' browser/locales/en-US/chrome/browser/appstrings.properties

    echo "" >> browser/locales/en-US/browser/aboutDialog.ftl
    echo "bottomLinks-license = Licensing Information" >> browser/locales/en-US/browser/aboutDialog.ftl
    echo "bottomLinks-rights = End-User Rights" >> browser/locales/en-US/browser/aboutDialog.ftl
    echo "bottomLinks-privacy = Privacy Policy" >> browser/locales/en-US/browser/aboutDialog.ftl

    """)

    # Apply Argon UI overlay, tokens, appearance controller, and preferences
    apply_argon_overlay()

    # Copy search-config.json
    cp("../assets/search-config.json", "services/settings/dumps/main/search-config-v2.json")

    # Apply the most recent uBO assets cleanly
    cp("../assets/uBOAssets.json", "settings/uBOAssets.json")

    print("Leaving '{}'...".format(srcdir))
    os.chdir("..")


if not no_execute:
    librewolf_patches()

    # Record elapsed time
    elapsed_time = datetime.datetime.now() - start_time
    elapsed_seconds = elapsed_time.total_seconds()
    minutes = int(elapsed_seconds // 60)
    seconds = int(elapsed_seconds % 60)
    microseconds = elapsed_time.microseconds
    print("-> Elapsed time: {:02d}:{:02d}.{:02d}".format(minutes, seconds, microseconds))
