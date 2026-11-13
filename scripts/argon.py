#!/usr/bin/env python3
"""Build the Argon browser from a pinned Firefox source snapshot.

Argon is a fork: this tool takes an immutable upstream Firefox revision,
applies Argon's changes to it (chrome, branding, application identity,
preference defaults), and builds a separate product with its own binary name,
profile directory, remoting name, and vendor.

Commands are deliberately small and fail closed:

    doctor     report the toolchain, the build mode, and known blockers
    fetch      download the pinned archive, verify it, extract it
    apply      apply the Argon changes to the checkout (all-or-nothing)
    bootstrap  let mach install the compilers and toolchains it needs
    build      ./mach build; a full source build with the Argon identity by
               default, or --artifact for a front-end-only loop
    run        launch the built browser with an isolated development profile
    package      ./mach package, producing the distributable archive
    flatpak      package a built Argon archive or runtime into an io.github.argon_browser.Argon.flatpak bundle
    flatpak-repo build a static Flatpak OSTree repository and .flatpakrepo file from .flatpak bundles
    verify-flatpak  validate Flatpak metadata and verify a built .flatpak bundle in isolation

Every write is confined to a dedicated ASCII workspace owned by this tool, and
nothing claims that a build succeeded unless ./mach actually did.
"""
import argparse
import base64
import configparser
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parents[1]
LOCK = REPO / "config" / "firefox.lock.json"
OVERLAY = REPO / "config" / "overlay.json"
MOZCONFIG = REPO / "config" / "mozconfig"
FLATPAK_DIR = REPO / "packaging" / "flatpak"

APP_NAME = "argon"
FLATPAK_APP_ID = "io.github.argon_browser.Argon"
FLATPAK_RUNTIME = "org.freedesktop.Platform"
FLATPAK_SDK = "org.freedesktop.Sdk"
FLATPAK_RUNTIME_VERSION = "26.08"
FLATPAK_ARCH = "x86_64"
FLATPAK_RUNTIME_REPO = "https://dl.flathub.org/repo/flathub.flatpakrepo"
FLATPAK_REPO_NAME = "argon"
FLATPAK_PAGES_URL = "https://argon-browser.github.io/Argon"
FLATPAK_REPO_URL = f"{FLATPAK_PAGES_URL}/repo"
FLATPAK_REPO_FILE_URL = f"{FLATPAK_PAGES_URL}/argon.flatpakrepo"
FLATPAK_HOMEPAGE_URL = "https://argon-browser.github.io/"
FLATPAK_ICON_URL = f"{FLATPAK_PAGES_URL}/icon.svg"
FLATPAK_FINISH_ARGS = (
    "--share=ipc",
    "--share=network",
    "--socket=wayland",
    "--socket=fallback-x11",
    "--socket=pulseaudio",
    "--socket=pcsc",
    "--socket=cups",
    "--device=dri",
    "--filesystem=xdg-download:rw",
    "--filesystem=xdg-run/pipewire-0:ro",
    "--persist=.argon",
    "--env=GTK_USE_PORTAL=1",
    "--env=MOZ_APP_REMOTINGNAME=argon",
    "--own-name=org.mozilla.argon.*",
    "--own-name=org.argon.argon.*",
    "--own-name=org.mpris.MediaPlayer2.argon.*",
    "--talk-name=org.freedesktop.FileManager1",
    "--talk-name=org.freedesktop.Notifications",
    "--talk-name=org.freedesktop.ScreenSaver",
    "--talk-name=org.freedesktop.secrets",
    "--system-talk-name=org.freedesktop.NetworkManager",
)
WORKSPACE_OWNER = "argon-build"

BEGIN = "BEGIN Argon overlay"
END = "END Argon overlay"


def default_workspace():
    """Outside the repository: its path has spaces, and an objdir needs ~30 GB."""
    if os.environ.get("ARGON_WORKSPACE"):
        return Path(os.environ["ARGON_WORKSPACE"])
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return cache / "argon-build"


class BuildError(Exception):
    """A failed prerequisite or an unsafe operation; never silently continue."""


def no_symlinks(path):
    path = Path(path).absolute()
    if ".." in path.parts or any(p.is_symlink() for p in [path, *path.parents]):
        raise BuildError(f"Unsafe path (traversal or symlink): {path}")
    return path


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Workspace:
    def __init__(self, repo, path):
        self.repo = no_symlinks(repo)
        self.path = no_symlinks(path)
        if (self.path in [Path("/"), Path.home(), self.repo]
                or self.path in self.repo.parents
                or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(self.path))):
            raise BuildError("Workspace requires a dedicated ASCII path without spaces or shell metacharacters")
        self.source = self.path / "source"
        self.obj = self.path / "obj"
        self.cache = self.path / "cache"
        self.profile = self.path / "profile"

    def claim(self):
        marker = self.path / ".argon-workspace.json"
        identity = {"schema": 1, "owner": WORKSPACE_OWNER, "repository": str(self.repo)}
        if marker.exists():
            if json.loads(marker.read_text()) != identity:
                raise BuildError("Workspace belongs to another repository")
        else:
            if self.path.exists() and any(self.path.iterdir()):
                raise BuildError("Refusing unowned nonempty workspace")
            self.path.mkdir(parents=True, exist_ok=True)
            marker.write_text(json.dumps(identity, indent=2) + "\n")
        return self


def load_json(path, label):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise BuildError(f"Missing {label}: {path}") from None
    except json.JSONDecodeError as exc:
        raise BuildError(f"Invalid {label} {path}: {exc}") from None


def download(url, destination):
    """Download to a temporary file; the caller verifies before publishing."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "ArgonBrowser-Build/0.1"})
    handle, temp_name = tempfile.mkstemp(dir=destination.parent, prefix=".download-")
    os.close(handle)
    temp = Path(temp_name)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temp.open("wb") as out:
            shutil.copyfileobj(response, out)
    except (urllib.error.URLError, OSError) as exc:
        temp.unlink(missing_ok=True)
        raise BuildError(f"Download failed for {url}: {exc}") from None
    return temp


def safe_extract(archive, destination, expected_root):
    """Extract a pinned tarball, refusing absolute paths, links, or a moved root."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=destination.parent, prefix=".extract-"))
    try:
        with tarfile.open(archive, "r:*") as tar:
            roots = set()
            for member in tar.getmembers():
                name = member.name
                if name.startswith(("/", "\\")) or ".." in Path(name).parts:
                    raise BuildError(f"Archive contains an unsafe path: {name}")
                if member.issym() or member.islnk():
                    raise BuildError(f"Archive contains a link, refusing to extract: {name}")
                roots.add(Path(name).parts[0])
            if roots != {expected_root}:
                raise BuildError(
                    f"archive_root mismatch: expected {expected_root}, found {sorted(roots)}"
                )
            tar.extractall(staging)
        extracted = staging / expected_root
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(extracted), str(destination))
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    mach = destination / "mach"
    if mach.is_file():
        mach.chmod(mach.stat().st_mode | 0o111)
    return destination


def command_fetch(workspace, lock_path):
    lock = load_json(lock_path, "lock file")
    source = lock["source"]
    workspace.claim()
    info_path = workspace.path / "source-info.json"

    if workspace.source.exists() and info_path.is_file():
        info = load_json(info_path, "source info")
        if info.get("revision") == source["revision"] and (workspace.source / "mach").is_file():
            return {"already_present": True, "source": str(workspace.source), **info}
        raise BuildError("Existing source tree does not match the pinned revision; remove it to refetch")

    if workspace.source.exists():
        raise BuildError(
            f"Refusing to touch an unowned source directory: {workspace.source} "
            "(no source-info.json)"
        )

    archive = workspace.cache / "source.tar.gz"
    if archive.is_file() and sha256_file(archive) == source["archive_sha256"]:
        used_cache = True
    else:
        used_cache = False
        archive.unlink(missing_ok=True)
        temp = download(source["archive_url"], archive)
        digest = sha256_file(temp)
        if digest != source["archive_sha256"]:
            temp.unlink(missing_ok=True)
            raise BuildError(
                f"Checksum mismatch for {source['archive_url']}: "
                f"expected {source['archive_sha256']}, got {digest}"
            )
        temp.replace(archive)

    safe_extract(archive, workspace.source, source["archive_root"])

    info = {
        "revision": source["revision"],
        "archive_url": source["archive_url"],
        "archive_sha256": source["archive_sha256"],
        "archive_root": source["archive_root"],
        # Pinned expectations; `apply` verifies the checkout against them so
        # upstream drift fails closed instead of being patched blindly.
        "hook_sha256": dict(lock.get("hooks", {})),
        "used_cached_archive": used_cache,
    }
    info_path.write_text(json.dumps(info, indent=2) + "\n")
    return {"already_present": False, "source": str(workspace.source), **info}


def block_markers(prefix, suffix=""):
    """Markers must be valid in the host file's syntax.

    A file with a comment suffix (XHTML) needs the suffix on *both* markers:
    an unterminated ``<!--`` would swallow the directive that follows it.
    """
    begin = f"{prefix} {BEGIN}"
    end = f"{prefix} {END}"
    if suffix:
        begin = f"{begin} {suffix}"
        end = f"{end} {suffix}"
    return begin, end


def replace_block(text, begin, end, block):
    """Insert or replace a marked block idempotently."""
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip().startswith(begin))
        stop = next(i for i, line in enumerate(lines) if line.strip().startswith(end))
    except StopIteration:
        return None
    if stop < start:
        raise BuildError("Malformed overlay block: end marker precedes begin marker")
    return "\n".join(lines[:start] + block.splitlines() + lines[stop + 1:]) + "\n"


def render_hook(workspace, hook, begin, end):
    """Return (block, extra_copy) for one hook; extra_copy is (src, dst) or None."""
    if hook.get("replace_line"):
        # The upstream line stays visible as a comment so the diff explains
        # itself and the original value is recoverable.
        lines = [begin, f"{hook['comment_prefix']} upstream: {hook['replace_line']}",
                 *hook.get("lines", []), end]
        return "\n".join(lines), None
    if hook.get("include"):
        include_source = REPO / hook["include"]
        if not include_source.is_file():
            raise BuildError(f"Include source is missing: {hook['include']}")
        if hook.get("insert_at_end"):
            # The host file has no preprocessor (a prefs file), so the
            # content is inlined; an #include there would be a syntax error.
            body = include_source.read_text(encoding="utf-8").strip("\n")
            return f"{begin}\n{body}\n{end}", None
        # The host file is preprocessed (browser.xhtml), so copy the fragment
        # next to it and emit a real directive.
        include_target = workspace.source / hook["include"]
        return f"{begin}\n#include {include_target.name}\n{end}", (include_source, include_target)
    template = hook.get("entry_template", "        {destination}  ({source})")
    lines = [template.format(destination=item["destination"], source=item["source"])
             for item in hook.get("entries", [])]
    return f"{begin}\n" + "\n".join(lines) + f"\n{end}", None


def apply_replacements(relative, target, original, hook, expected_sha256):
    """Apply exact-text replacements without the marked-block machinery.

    Some upstream modules express a change in several unrelated places in one
    file. A marked block cannot cover those safely, so each replacement is an
    exact snippet that must occur once. The operation is idempotent: a tree in
    which every replacement is already present is left untouched, while a tree
    with only some of them is rejected rather than repaired silently.
    """
    replacements = hook.get("replacements")
    if not isinstance(replacements, list) or not replacements:
        raise BuildError(f"Replacements hook {relative} has no replacements")
    checked = []
    for item in replacements:
        if not isinstance(item, dict):
            raise BuildError(f"Replacements hook {relative} has a non-object entry")
        old = item.get("old")
        new = item.get("new")
        if not isinstance(old, str) or not old or not isinstance(new, str) or not new:
            raise BuildError(f"Replacements hook {relative} needs non-empty old/new strings")
        if new in old:
            raise BuildError(f"Replacements hook {relative} replaces a snippet with itself")
        checked.append((old, new))

    previous = hook.get("previous_replacements", [])
    if previous and not all(new in original for _, new in checked) and all(item["new"] in original for item in previous):
        for item in reversed(previous):
            original = original.replace(item["new"], item["old"], 1)

    applied = [new in original for _, new in checked]
    if all(applied):
        return original, "unchanged"
    if any(applied):
        raise BuildError(
            f"Partially applied Argon replacements in {relative}; "
            "restore the checkout before applying again"
        )

    if expected_sha256:
        actual = hashlib.sha256(original.encode("utf-8")).hexdigest()
        if actual != expected_sha256:
            raise BuildError(
                f"Upstream hook drift in {relative}: expected {expected_sha256}, "
                f"found {actual}. Update the overlay and the lock deliberately."
            )

    updated = original
    for old, new in checked:
        if updated.count(old) != 1:
            raise BuildError(
                f"Expected exactly one replacement anchor in {relative}: {old.splitlines()[0]!r}"
            )
        updated = updated.replace(old, new, 1)
    return updated, "patched"


def insert_block(relative, original, hook, block):
    if hook.get("replace_line"):
        anchor = hook["replace_line"]
        lines = original.splitlines()
        matches = [i for i, line in enumerate(lines) if line == anchor]
        if len(matches) != 1:
            raise BuildError(f"Expected exactly one line to replace in {relative}: {anchor}")
        index = matches[0]
        return "\n".join(lines[:index] + block.splitlines() + lines[index + 1:]) + "\n"
    if hook.get("insert_at_end"):
        return original.rstrip("\n") + "\n\n" + block + "\n"
    if hook.get("insert_after"):
        anchor = hook["insert_after"]
        if anchor not in original:
            raise BuildError(f"Anchor not found in {relative}: {anchor}")
        return original.replace(anchor, f"{anchor}\n{block}", 1)
    if hook.get("insert_before"):
        anchor = hook["insert_before"]
        if anchor not in original:
            raise BuildError(f"Anchor not found in {relative}: {anchor}")
        return original.replace(anchor, f"{block}\n{anchor}", 1)
    raise BuildError(f"Hook {relative} has no insertion point")


def command_apply(workspace, lock_path, overlay_path):
    """Apply every Argon change, or none of them.

    All hooks are validated and rendered in memory first; files are written
    only once every hook has passed its drift check, so an upstream change can
    never leave the checkout half-patched.
    """
    lock = load_json(lock_path, "lock file")
    overlay = load_json(overlay_path, "overlay description")
    if not workspace.source.is_dir():
        raise BuildError("No source checkout; run fetch first")

    for entry in overlay.get("files", []):
        if not (REPO / entry["from"]).is_file():
            raise BuildError(f"Overlay source is missing: {entry['from']}")
    branding = overlay.get("branding")
    if branding and not (REPO / branding["from"]).is_dir():
        raise BuildError(f"Branding directory is missing: {branding['from']}")

    planned = []
    for hook in overlay.get("hooks", []):
        relative = hook["path"]
        target = workspace.source / relative
        if not target.is_file():
            raise BuildError(f"Hook file is missing from the checkout: {relative}")
        begin, end = block_markers(hook.get("comment_prefix", "#"), hook.get("comment_suffix", ""))
        original = target.read_text(encoding="utf-8")
        if hook.get("replacements"):
            expected = lock.get("hooks", {}).get(relative)
            updated, action = apply_replacements(relative, target, original, hook, expected)
            planned.append((relative, target, updated, None, action))
            continue
        block, extra = render_hook(workspace, hook, begin, end)

        updated = replace_block(original, begin, end, block)
        action = "replaced"
        if updated is None:
            expected = lock.get("hooks", {}).get(relative)
            if expected and sha256_file(target) != expected:
                raise BuildError(
                    f"Upstream hook drift in {relative}: expected {expected}, "
                    f"found {sha256_file(target)}. Update the overlay and the lock deliberately."
                )
            updated = insert_block(relative, original, hook, block)
            action = "inserted"
        planned.append((relative, target, updated, extra, action))

    copied = []
    for entry in overlay.get("files", []):
        target = workspace.source / entry["to"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / entry["from"], target)
        copied.append(entry["to"])
    if branding:
        target = workspace.source / branding["to"]
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(REPO / branding["from"], target)
        copied.append(branding["to"] + "/")

    hooks = []
    for relative, target, updated, extra, action in planned:
        if extra:
            extra[1].parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(*extra)
        target.write_text(updated, encoding="utf-8")
        hooks.append({"path": relative, "action": action})

    return {"source": str(workspace.source), "copied": copied, "hooks": hooks}


def mozconfig_lines(workspace, lock, artifact=False, mozconfig_path=MOZCONFIG):
    """The workspace mozconfig: the tracked Argon identity plus local paths.

    Full builds (the default) compile Gecko and produce a binary that is Argon
    end to end: dist/bin/argon, its own profile directory, remoting name, and
    vendor. Artifact builds reuse Mozilla's pre-built binaries, which carry
    Firefox's native identity, so they keep only the branding and serve as a
    fast loop for front-end (CSS/JS/XHTML/FTL) work.
    """
    lines = [
        "# Generated by scripts/argon.py; do not edit by hand.",
        f"# Edit {mozconfig_path.relative_to(REPO) if mozconfig_path.is_relative_to(REPO) else mozconfig_path} instead.",
    ]
    if artifact:
        lines += [
            "# Artifact mode: front-end loop only. The downloaded binaries keep",
            "# Firefox's native identity; this is not a distributable Argon build.",
            "ac_add_options --enable-application=browser",
            "ac_add_options --enable-artifact-builds",
            "ac_add_options --with-branding=browser/branding/argon",
        ]
        # mach's artifact resolver requires an hg or git checkout to map the
        # tree to a Mozilla task (Artifacts.__init__ raises without one). A
        # GitHub tarball has no VCS metadata, so artifact builds need a
        # git-cinnabar clone; the revision below pins the artifacts for it.
        artifacts = lock.get("artifacts") or {}
        if artifacts.get("hg_revision"):
            lines.append(f"export MOZ_ARTIFACT_REVISION={artifacts['hg_revision']}")
    else:
        if not mozconfig_path.is_file():
            raise BuildError(f"Missing Argon mozconfig: {mozconfig_path}")
        lines.append(mozconfig_path.read_text(encoding="utf-8").rstrip("\n"))
    lines.append(f"mk_add_options MOZ_OBJDIR={workspace.obj}")
    return lines


def write_mozconfig(workspace, lock, artifact=False):
    workspace.path.mkdir(parents=True, exist_ok=True)
    path = workspace.path / "mozconfig"
    path.write_text("\n".join(mozconfig_lines(workspace, lock, artifact)) + "\n")
    return path


def detect_vcs(source):
    if (source / ".hg").is_dir():
        return "hg"
    if (source / ".git").exists():
        return "git"
    return None


def mach_env(mozconfig):
    env = dict(os.environ)
    env["MOZCONFIG"] = str(mozconfig)
    env["MOZ_BUILD_APP"] = "browser"
    cargo_home = Path(env.get("CARGO_HOME") or Path.home() / ".cargo")
    cargo_bin = cargo_home / "bin"
    if cargo_bin.is_dir():
        path_entries = env.get("PATH", "").split(os.pathsep) if env.get("PATH") else []
        if str(cargo_bin) not in path_entries:
            env["PATH"] = os.pathsep.join([str(cargo_bin), *path_entries])
    return env


def require_mach(workspace, hint):
    mach = workspace.source / "mach"
    if not mach.is_file():
        raise BuildError(f"No source checkout; {hint}")
    return mach


def command_bootstrap(workspace, lock_path):
    """Install compilers and toolchains (clang, rustc, cbindgen, node) via mach."""
    lock = load_json(lock_path, "lock file")
    mach = require_mach(workspace, "run fetch and apply first")
    mozconfig = write_mozconfig(workspace, lock)
    command = [
        str(mach),
        "--no-interactive",
        "bootstrap",
        "--application-choice",
        "browser",
        "--no-agentic-tools",
    ]
    completed = subprocess.run(command, cwd=workspace.source, env=mach_env(mozconfig), check=False)
    return {"command": command, "exit_code": completed.returncode,
            "succeeded": completed.returncode == 0}


def command_build(workspace, lock_path, jobs=2, artifact=False):
    lock = load_json(lock_path, "lock file")
    mach = require_mach(workspace, "run fetch and apply first")
    workspace.obj.mkdir(parents=True, exist_ok=True)
    mozconfig = write_mozconfig(workspace, lock, artifact)
    command = [str(mach), "build", "--jobs", str(jobs)]
    completed = subprocess.run(command, cwd=workspace.source, env=mach_env(mozconfig), check=False)
    return {
        "mode": "artifact" if artifact else "source",
        "command": command,
        "mozconfig": str(mozconfig),
        "binary": str(workspace.obj / "dist" / "bin" / (("firefox" if artifact else APP_NAME))),
        "exit_code": completed.returncode,
        "succeeded": completed.returncode == 0,
    }


def built_binary(workspace):
    for name in (APP_NAME, "firefox"):
        candidate = workspace.obj / "dist" / "bin" / name
        if candidate.is_file():
            return candidate
    return None


def command_run(workspace, binary=None, extra_args=(), dry_run=False):
    """Launch the built browser with a development profile kept in the workspace."""
    binary = Path(binary) if binary else built_binary(workspace)
    if binary is None or not binary.is_file():
        raise BuildError(
            f"No built browser in {workspace.obj / 'dist' / 'bin'}; run build first "
            "(or pass --binary)"
        )
    command = [str(binary), "--profile", str(workspace.profile), "--no-remote", *extra_args]
    report = {"command": command, "profile": str(workspace.profile),
              "identity": "argon" if binary.name == APP_NAME else "firefox (artifact build)"}
    if dry_run:
        return report
    workspace.claim()
    workspace.profile.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(command, check=False)
    report["exit_code"] = completed.returncode
    return report


def command_package(workspace, lock_path):
    lock = load_json(lock_path, "lock file")
    mach = require_mach(workspace, "run fetch, apply and build first")
    if not (workspace.obj / "dist" / "bin" / APP_NAME).is_file():
        raise BuildError("No full Argon build to package; artifact builds are not distributable")
    mozconfig = write_mozconfig(workspace, lock)
    command = [str(mach), "package"]
    completed = subprocess.run(command, cwd=workspace.source, env=mach_env(mozconfig), check=False)
    dist = workspace.obj / "dist"
    archives = sorted(
        str(p) for p in dist.glob(f"{APP_NAME}-*")
        if p.is_file() and any(p.name.endswith(ext) for ext in (".tar.xz", ".tar.bz2", ".tar.zst", ".tar.gz"))
    ) if dist.is_dir() else []
    return {"command": command, "output_dir": str(dist), "archives": archives,
            "exit_code": completed.returncode, "succeeded": completed.returncode == 0}


def default_flatpak_output(archive_path):
    name = archive_path.name
    for ext in (".tar.xz", ".tar.zst", ".tar.bz2", ".tar.gz"):
        if name.endswith(ext):
            return archive_path.with_name(name[:-len(ext)] + ".flatpak")
    return archive_path.with_suffix(".flatpak")


def canonical_policies_source():
    preferred = REPO / "settings" / "distribution" / "policies.json"
    if preferred.is_file():
        return preferred
    fallback = FLATPAK_DIR / "policies.json"
    if fallback.is_file():
        return fallback
    raise BuildError("Missing distribution policies.json")


def read_application_ini(app_ini_path):
    parser = configparser.ConfigParser()
    parser.read(app_ini_path, encoding="utf-8")
    name = parser.get("App", "Name", fallback="")
    vendor = parser.get("App", "Vendor", fallback="")
    if name != "Argon" or vendor != "Argon":
        raise BuildError(f"{app_ini_path} does not have Argon application.ini identity")
    return parser


def command_flatpak(workspace, archive=None, output=None, runtime=None, gpg_sign=None, gpg_homedir=None):
    flatpak_bin = shutil.which("flatpak")
    if not flatpak_bin:
        raise BuildError("flatpak is not installed; install the flatpak package to build a bundle")

    if archive is not None and runtime is not None:
        raise BuildError("Pass either --archive or --runtime to flatpak, not both")

    gpg_sign = gpg_sign or os.environ.get("ARGON_GPG_SIGN") or None
    gpg_homedir = gpg_homedir or os.environ.get("ARGON_GPG_HOMEDIR") or None

    runtime_path = None
    archive_path = None
    if runtime is not None:
        runtime_path = no_symlinks(runtime)
        if not runtime_path.is_dir():
            raise BuildError(f"Argon runtime directory not found: {runtime_path}")
        if not (runtime_path / APP_NAME).is_file() or not (runtime_path / "application.ini").is_file():
            raise BuildError(f"Runtime {runtime_path} is missing {APP_NAME} or application.ini")
        if not (runtime_path / "browser" / "omni.ja").is_file():
            raise BuildError(f"Runtime {runtime_path} is missing browser/omni.ja")
        ini = read_application_ini(runtime_path / "application.ini")
        app_version = ini.get("App", "Version", fallback="0.1.0") or "0.1.0"
        default_output = workspace.obj / "dist" / f"{APP_NAME}-{app_version}.en-US.linux-{FLATPAK_ARCH}.flatpak"
        output_path = Path(output).resolve() if output is not None else default_output.resolve()
    else:
        if archive is not None:
            archive_path = Path(archive).resolve()
        else:
            dist = workspace.obj / "dist"
            candidates = sorted(
                p for p in dist.glob(f"{APP_NAME}-*")
                if p.is_file() and any(p.name.endswith(ext) for ext in (".tar.xz", ".tar.zst", ".tar.bz2", ".tar.gz"))
            ) if dist.is_dir() else []
            if not candidates:
                raise BuildError(
                    "No packaged Argon archive found; run `python3 scripts/argon.py package` "
                    "first or pass --archive or --runtime"
                )
            archive_path = candidates[0].resolve()

        if not archive_path.is_file():
            raise BuildError(f"Packaged Argon archive not found: {archive_path}")

        output_path = Path(output).resolve() if output is not None else default_flatpak_output(archive_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    staging = Path(tempfile.mkdtemp(dir=output_path.parent, prefix=".flatpak-build-"))
    try:
        build_dir = staging / "build"
        repo_dir = staging / "repo"
        files_dir = build_dir / "files"
        app_lib = files_dir / "lib" / APP_NAME
        (build_dir / "var").mkdir(parents=True, exist_ok=True)

        if runtime_path is not None:
            shutil.copytree(runtime_path, app_lib, symlinks=False, dirs_exist_ok=True)
        else:
            safe_extract(archive_path, app_lib, APP_NAME)

        binary = app_lib / APP_NAME
        app_ini = app_lib / "application.ini"
        if not binary.is_file() or not app_ini.is_file():
            source_desc = runtime_path or archive_path
            raise BuildError(f"Source {source_desc} is missing {APP_NAME} or application.ini")
        read_application_ini(app_ini)

        for exe_name in (APP_NAME, f"{APP_NAME}-bin", "pingsender", "gfxtest"):
            exe_path = app_lib / exe_name
            if exe_path.is_file():
                exe_path.chmod(exe_path.stat().st_mode | 0o755)

        dist_dir = app_lib / "distribution"
        dist_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(canonical_policies_source(), dist_dir / "policies.json")

        lw_cfg = REPO / "settings" / "librewolf.cfg"
        if lw_cfg.is_file():
            shutil.copy2(lw_cfg, app_lib / "librewolf.cfg")
        local_settings = REPO / "settings" / "defaults" / "pref" / "local-settings.js"
        if local_settings.is_file():
            pref_dir = app_lib / "defaults" / "pref"
            pref_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(local_settings, pref_dir / "local-settings.js")

        bin_dir = files_dir / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        launcher = bin_dir / APP_NAME
        shutil.copy2(FLATPAK_DIR / "argon-launcher.sh", launcher)
        launcher.chmod(0o755)

        apps_dir = files_dir / "share" / "applications"
        apps_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            FLATPAK_DIR / f"{FLATPAK_APP_ID}.desktop",
            apps_dir / f"{FLATPAK_APP_ID}.desktop",
        )

        metainfo_dir = files_dir / "share" / "metainfo"
        metainfo_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            FLATPAK_DIR / f"{FLATPAK_APP_ID}.metainfo.xml",
            metainfo_dir / f"{FLATPAK_APP_ID}.metainfo.xml",
        )

        licenses_dir = files_dir / "share" / "licenses" / FLATPAK_APP_ID
        licenses_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / "LICENSE", licenses_dir / "LICENSE")

        branding_dir = REPO / "browser" / "branding" / "argon"
        for size in (16, 32, 48, 64, 128, 256):
            icon_dir = files_dir / "share" / "icons" / "hicolor" / f"{size}x{size}" / "apps"
            icon_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(branding_dir / f"default{size}.png", icon_dir / f"{FLATPAK_APP_ID}.png")

        icon_512_dir = files_dir / "share" / "icons" / "hicolor" / "512x512" / "apps"
        icon_512_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            REPO / "brand-kit" / "mark-primary-512.png",
            icon_512_dir / f"{FLATPAK_APP_ID}.png",
        )

        scalable_dir = files_dir / "share" / "icons" / "hicolor" / "scalable" / "apps"
        scalable_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            REPO / "brand-kit" / "mark-primary.svg",
            scalable_dir / f"{FLATPAK_APP_ID}.svg",
        )

        runtime_ref = f"{FLATPAK_RUNTIME}/{FLATPAK_ARCH}/{FLATPAK_RUNTIME_VERSION}"
        sdk_ref = f"{FLATPAK_SDK}/{FLATPAK_ARCH}/{FLATPAK_RUNTIME_VERSION}"
        (build_dir / "metadata").write_text(
            f"[Application]\nname={FLATPAK_APP_ID}\nruntime={runtime_ref}\nsdk={sdk_ref}\n",
            encoding="utf-8",
        )

        gpg_args = []
        if gpg_sign:
            gpg_args.append(f"--gpg-sign={gpg_sign}")
            if gpg_homedir:
                gpg_args.append(f"--gpg-homedir={gpg_homedir}")

        steps = [
            [flatpak_bin, "build-finish", str(build_dir), f"--command={APP_NAME}", *FLATPAK_FINISH_ARGS],
            [flatpak_bin, "build-export", "--disable-sandbox", *gpg_args, str(repo_dir), str(build_dir), "stable"],
            [
                flatpak_bin,
                "build-bundle",
                *gpg_args,
                str(repo_dir),
                str(output_path),
                FLATPAK_APP_ID,
                "stable",
                f"--runtime-repo={FLATPAK_RUNTIME_REPO}",
            ],
        ]
        for cmd in steps:
            completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "").strip()
                raise BuildError(f"Flatpak command failed ({' '.join(cmd[:2])}): {detail}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    report = {
        "app_id": FLATPAK_APP_ID,
        "runtime": runtime_ref,
        "source_mode": "runtime" if runtime_path is not None else "archive",
        "bundle": str(output_path),
        "bundle_sha256": sha256_file(output_path),
        "bundle_size": output_path.stat().st_size,
        "signed": bool(gpg_sign),
        "exit_code": 0,
        "succeeded": True,
    }
    if archive_path is not None:
        report["archive"] = str(archive_path)
    if runtime_path is not None:
        report["runtime_dir"] = str(runtime_path)
    return report


REQUIRED_OMNI_ENTRIES = (
    "chrome/browser/content/browser/argon/argon.css",
    "chrome/browser/content/browser/argon/argon-controller.mjs",
    "chrome/browser/content/browser/argon/adblock/service.sys.mjs",
    "chrome/browser/content/browser/argon/adblock/ublock-engine.sys.mjs",
    "chrome/browser/content/browser/argon/newtab.html",
    "chrome/browser/content/browser/argon/settings.html",
    "chrome/browser/content/browser/argon/onboarding.html",
    "chrome/browser/content/browser/argon/workspaces.mjs",
    "chrome/browser/content/browser/argon/shortcuts.mjs",
)


def validate_flatpak_metadata():
    desktop_path = FLATPAK_DIR / f"{FLATPAK_APP_ID}.desktop"
    metainfo_path = FLATPAK_DIR / f"{FLATPAK_APP_ID}.metainfo.xml"
    if not desktop_path.is_file() or not metainfo_path.is_file():
        raise BuildError("Missing Flatpak .desktop or .metainfo.xml file")

    desktop_validator = shutil.which("desktop-file-validate")
    if desktop_validator:
        res = subprocess.run([desktop_validator, str(desktop_path)], capture_output=True, text=True, check=False)
        if res.returncode != 0:
            raise BuildError(f"desktop-file-validate failed: {(res.stderr or res.stdout).strip()}")

    try:
        root = ET.parse(metainfo_path).getroot()
    except ET.ParseError as exc:
        raise BuildError(f"Invalid metainfo XML {metainfo_path}: {exc}") from None
    if root.findtext("id") != FLATPAK_APP_ID or root.findtext("name") != "Argon":
        raise BuildError("Metainfo XML id/name mismatch")

    appstreamcli = shutil.which("appstreamcli")
    if appstreamcli:
        res = subprocess.run(
            [appstreamcli, "validate", "--no-net", "--strict", str(metainfo_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode != 0:
            raise BuildError(f"appstreamcli validate failed: {(res.stderr or res.stdout).strip()}")

    return {"desktop": bool(desktop_validator), "metainfo": bool(appstreamcli)}


def command_verify_flatpak(workspace, bundle=None, require_full_omni=False):
    metadata_checks = validate_flatpak_metadata()

    if bundle is not None:
        bundle_path = Path(bundle).resolve()
    else:
        dist = workspace.obj / "dist"
        candidates = sorted(p for p in dist.glob("*.flatpak") if p.is_file()) if dist.is_dir() else []
        if not candidates:
            raise BuildError(
                "No .flatpak bundle found; pass --bundle or run `python3 scripts/argon.py flatpak` first"
            )
        bundle_path = candidates[0].resolve()

    if not bundle_path.is_file() or bundle_path.stat().st_size == 0:
        raise BuildError(f"Flatpak bundle is missing or empty: {bundle_path}")

    flatpak_bin = shutil.which("flatpak")
    if not flatpak_bin:
        raise BuildError("flatpak is not installed; cannot verify bundle")

    omni_checked = False
    with tempfile.TemporaryDirectory(prefix="argon-flatpak-verify-") as tmp:
        root = Path(tmp)
        fp_user = root / "flatpak-user"
        home_dir = root / "home"
        home_dir.mkdir(parents=True, exist_ok=True)
        env = dict(
            os.environ,
            FLATPAK_USER_DIR=str(fp_user),
            HOME=str(home_dir),
            XDG_DATA_HOME=str(root / "xdg-data"),
        )
        completed = subprocess.run(
            [flatpak_bin, "--user", "install", "--no-deps", "--no-pull", "--no-related", "-y", str(bundle_path)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise BuildError(f"Flatpak bundle failed isolated install verification: {detail}")

        deployed = fp_user / "app" / FLATPAK_APP_ID / FLATPAK_ARCH / "stable" / "active"
        if not deployed.is_dir():
            raise BuildError("Deployed Flatpak verification directory missing")

        meta_file = deployed / "metadata"
        meta_text = meta_file.read_text(encoding="utf-8", errors="replace") if meta_file.is_file() else ""
        for needle in (
            f"name={FLATPAK_APP_ID}",
            f"runtime={FLATPAK_RUNTIME}/{FLATPAK_ARCH}/{FLATPAK_RUNTIME_VERSION}",
            f"command={APP_NAME}",
            "persistent=.argon;",
            "MOZ_APP_REMOTINGNAME=argon",
        ):
            if needle not in meta_text:
                raise BuildError(f"Verified Flatpak metadata missing {needle!r}")

        required_files = [
            deployed / "files" / "bin" / APP_NAME,
            deployed / "files" / "lib" / APP_NAME / APP_NAME,
            deployed / "files" / "lib" / APP_NAME / "application.ini",
            deployed / "files" / "lib" / APP_NAME / "distribution" / "policies.json",
            deployed / "files" / "lib" / APP_NAME / "librewolf.cfg",
            deployed / "files" / "lib" / APP_NAME / "defaults" / "pref" / "local-settings.js",
            deployed / "export" / "bin" / FLATPAK_APP_ID,
            deployed / "export" / "share" / "applications" / f"{FLATPAK_APP_ID}.desktop",
            deployed / "export" / "share" / "metainfo" / f"{FLATPAK_APP_ID}.metainfo.xml",
            deployed / "files" / "share" / "licenses" / FLATPAK_APP_ID / "LICENSE",
            deployed / "export" / "share" / "icons" / "hicolor" / "scalable" / "apps" / f"{FLATPAK_APP_ID}.svg",
        ]
        for size in (16, 32, 48, 64, 128, 256, 512):
            required_files.append(
                deployed / "export" / "share" / "icons" / "hicolor" / f"{size}x{size}" / "apps" / f"{FLATPAK_APP_ID}.png"
            )
        for path in required_files:
            if not path.is_file():
                raise BuildError(f"Verified Flatpak bundle missing expected file: {path.relative_to(deployed)}")

        ini = read_application_ini(deployed / "files" / "lib" / APP_NAME / "application.ini")
        if ini.get("App", "Profile", fallback="") != "argon" or ini.get("App", "RemotingName", fallback="") != "argon":
            raise BuildError("Verified Flatpak application.ini is missing Profile=argon or RemotingName=argon")

        for exe in (deployed / "files" / "bin" / APP_NAME, deployed / "files" / "lib" / APP_NAME / APP_NAME):
            if not os.access(exe, os.X_OK):
                raise BuildError(f"Verified Flatpak executable lacks +x permission: {exe.relative_to(deployed)}")

        expected_policies = json.loads(canonical_policies_source().read_text(encoding="utf-8"))
        actual_policies = json.loads(
            (deployed / "files" / "lib" / APP_NAME / "distribution" / "policies.json").read_text(encoding="utf-8")
        )
        if actual_policies != expected_policies:
            raise BuildError("Verified Flatpak policies.json diverges from canonical Argon policies")

        omni_path = deployed / "files" / "lib" / APP_NAME / "browser" / "omni.ja"
        if require_full_omni or omni_path.is_file():
            if not omni_path.is_file():
                raise BuildError("Verified Flatpak bundle is missing browser/omni.ja")
            with zipfile.ZipFile(omni_path) as zf:
                names = set(zf.namelist())
            missing_entries = [entry for entry in REQUIRED_OMNI_ENTRIES if entry not in names]
            if missing_entries:
                raise BuildError(
                    "Verified Flatpak browser/omni.ja missing Argon entries: " + ", ".join(missing_entries)
                )
            omni_checked = True

    return {
        "app_id": FLATPAK_APP_ID,
        "bundle": str(bundle_path),
        "bundle_sha256": sha256_file(bundle_path),
        "bundle_size": bundle_path.stat().st_size,
        "desktop_validated": metadata_checks["desktop"],
        "metainfo_validated": metadata_checks["metainfo"],
        "bundle_verified": True,
        "omni_checked": omni_checked,
        "exit_code": 0,
        "succeeded": True,
    }


def _init_ostree_repo(repo_dir):
    if (repo_dir / "config").is_file():
        return
    ostree_bin = shutil.which("ostree")
    if ostree_bin:
        repo_dir.parent.mkdir(parents=True, exist_ok=True)
        res = subprocess.run(
            [ostree_bin, "init", f"--repo={repo_dir}", "--mode=archive-z2"],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode != 0:
            detail = (res.stderr or res.stdout or "").strip()
            raise BuildError(f"ostree init failed: {detail}")
        return

    for sub in ("objects", "refs/heads", "refs/remotes", "tmp", "state", "extensions"):
        (repo_dir / sub).mkdir(parents=True, exist_ok=True)
    (repo_dir / "config").write_text("[core]\nrepo_version=1\nmode=archive-z2\n", encoding="utf-8")


def _export_gpg_public_key(gpg_sign, gpg_homedir, dest_path):
    gpg_bin = shutil.which("gpg") or shutil.which("gpg2")
    if not gpg_bin:
        raise BuildError("gpg is required to export public key when --gpg-sign is set")
    cmd = [gpg_bin, "--batch", "--no-tty"]
    if gpg_homedir:
        cmd.extend(["--homedir", str(gpg_homedir)])
    cmd.extend(["--export", str(gpg_sign)])
    res = subprocess.run(cmd, capture_output=True, check=False)
    if res.returncode != 0 or not res.stdout:
        detail = res.stderr.decode("utf-8", errors="replace").strip()
        raise BuildError(f"Failed to export GPG public key {gpg_sign}: {detail}")
    dest_path.write_bytes(res.stdout)
    return base64.b64encode(res.stdout).decode("ascii")


def command_flatpak_repo(
    workspace,
    bundles=None,
    output_dir=None,
    repo_url=None,
    gpg_sign=None,
    gpg_homedir=None,
    prune=True,
):
    flatpak_bin = shutil.which("flatpak")
    if not flatpak_bin:
        raise BuildError("flatpak is not installed; install the flatpak package to build a repository")

    gpg_sign = gpg_sign or os.environ.get("ARGON_GPG_SIGN") or None
    gpg_homedir = gpg_homedir or os.environ.get("ARGON_GPG_HOMEDIR") or None

    if bundles:
        bundle_paths = [Path(b).resolve() for b in bundles]
    else:
        dist = workspace.obj / "dist"
        bundle_paths = sorted(p.resolve() for p in dist.glob("*.flatpak") if p.is_file()) if dist.is_dir() else []

    if not bundle_paths:
        raise BuildError("No .flatpak bundles found; pass --bundle or build a bundle first")
    for bundle_path in bundle_paths:
        if not bundle_path.is_file() or bundle_path.stat().st_size == 0:
            raise BuildError(f"Flatpak bundle is missing or empty: {bundle_path}")

    out_dir = Path(output_dir).resolve() if output_dir is not None else (workspace.obj / "dist" / "flatpak-pages").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    repo_dir = out_dir / "repo"
    _init_ostree_repo(repo_dir)

    repo_url = (repo_url or FLATPAK_REPO_URL).rstrip("/")
    pages_base_url = repo_url[: -len("/repo")] if repo_url.endswith("/repo") else FLATPAK_PAGES_URL.rstrip("/")
    flatpakrepo_url = f"{pages_base_url}/argon.flatpakrepo"
    icon_url = f"{pages_base_url}/icon.svg"

    gpg_args = []
    if gpg_sign:
        gpg_args.append(f"--gpg-sign={gpg_sign}")
        if gpg_homedir:
            gpg_args.append(f"--gpg-homedir={gpg_homedir}")

    gpg_key_b64 = None
    with tempfile.TemporaryDirectory(prefix="argon-flatpak-repo-") as tmp:
        pubkey_file = Path(tmp) / "gpg-public.key"
        if gpg_sign:
            gpg_key_b64 = _export_gpg_public_key(gpg_sign, gpg_homedir, pubkey_file)

        for bundle_path in bundle_paths:
            import_cmd = [
                flatpak_bin,
                "build-import-bundle",
                "--no-update-summary",
                *gpg_args,
                str(repo_dir),
                str(bundle_path),
            ]
            completed = subprocess.run(import_cmd, capture_output=True, text=True, check=False)
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "").strip()
                raise BuildError(f"Flatpak command failed (flatpak build-import-bundle): {detail}")

        update_cmd = [
            flatpak_bin,
            "build-update-repo",
            "--generate-static-deltas",
            "--title=Argon Browser",
            "--comment=Argon Browser Flatpak repository",
            "--description=Official Flatpak repository for Argon Browser",
            f"--homepage={FLATPAK_HOMEPAGE_URL}",
            f"--icon={icon_url}",
            "--default-branch=stable",
        ]
        if prune:
            update_cmd.append("--prune")
        if gpg_sign:
            update_cmd.append(f"--gpg-import={pubkey_file}")
            update_cmd.extend(gpg_args)
        update_cmd.append(str(repo_dir))

        completed = subprocess.run(update_cmd, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise BuildError(f"Flatpak command failed (flatpak build-update-repo): {detail}")

    icon_svg_src = REPO / "brand-kit" / "mark-primary.svg"
    if icon_svg_src.is_file():
        shutil.copy2(icon_svg_src, out_dir / "icon.svg")
    icon_png_src = REPO / "brand-kit" / "mark-primary-512.png"
    if icon_png_src.is_file():
        shutil.copy2(icon_png_src, out_dir / "icon.png")

    gpg_line = f"GPGKey={gpg_key_b64}" if gpg_key_b64 else "GPGVerify=false"

    flatpakrepo_path = out_dir / "argon.flatpakrepo"
    flatpakrepo_path.write_text(
        "\n".join(
            [
                "[Flatpak Repo]",
                "Title=Argon Browser",
                f"Url={repo_url}",
                f"Homepage={FLATPAK_HOMEPAGE_URL}",
                f"Icon={icon_url}",
                "Description=Official Flatpak repository for Argon Browser",
                "DefaultBranch=stable",
                gpg_line,
                "",
            ]
        ),
        encoding="utf-8",
    )

    flatpakref_path = out_dir / "argon.flatpakref"
    flatpakref_path.write_text(
        "\n".join(
            [
                "[Flatpak Ref]",
                f"Name={FLATPAK_APP_ID}",
                "Branch=stable",
                "Title=Argon Browser",
                "IsRuntime=false",
                f"Url={repo_url}",
                f"RuntimeRepo={FLATPAK_RUNTIME_REPO}",
                f"Homepage={FLATPAK_HOMEPAGE_URL}",
                f"Icon={icon_url}",
                f"SuggestRemoteName={FLATPAK_REPO_NAME}",
                gpg_line,
                "",
            ]
        ),
        encoding="utf-8",
    )

    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    escaped_repo_url = html.escape(flatpakrepo_url, quote=True)
    escaped_ref_url = html.escape(f"{pages_base_url}/argon.flatpakref", quote=True)
    escaped_home = html.escape(FLATPAK_HOMEPAGE_URL, quote=True)
    (out_dir / "index.html").write_text(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Argon Browser Flatpak Repository</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; line-height: 1.6; color: #181a1f; }}
    pre {{ background: #f3f5f8; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }}
    code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }}
    a {{ color: #3650d8; }}
  </style>
</head>
<body>
  <h1>Argon Browser Flatpak Repository</h1>
  <p>Add the Argon Flatpak repository so <code>flatpak update</code> upgrades Argon automatically when a new release ships.</p>
  <pre><code>flatpak remote-add --if-not-exists --user flathub {html.escape(FLATPAK_RUNTIME_REPO)}
flatpak remote-add --if-not-exists --user {FLATPAK_REPO_NAME} {escaped_repo_url}
flatpak install --user -y {FLATPAK_REPO_NAME} {FLATPAK_APP_ID}</code></pre>
  <p>Update and launch:</p>
  <pre><code>flatpak update --user {FLATPAK_APP_ID}
flatpak run {FLATPAK_APP_ID}</code></pre>
  <p>Files: <a href="./argon.flatpakrepo">argon.flatpakrepo</a> · <a href="./argon.flatpakref">argon.flatpakref</a> · <a href="{escaped_home}">Argon homepage</a></p>
</body>
</html>
""",
        encoding="utf-8",
    )

    return {
        "app_id": FLATPAK_APP_ID,
        "repo_name": FLATPAK_REPO_NAME,
        "repo_url": repo_url,
        "flatpakrepo_url": flatpakrepo_url,
        "output_dir": str(out_dir),
        "repo_dir": str(repo_dir),
        "flatpakrepo": str(flatpakrepo_path),
        "flatpakref": str(flatpakref_path),
        "bundles": [str(p) for p in bundle_paths],
        "signed": bool(gpg_sign),
        "pruned": bool(prune),
        "exit_code": 0,
        "succeeded": True,
    }


def memory_gib():
    try:
        with open("/proc/meminfo") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / 1024 / 1024, 2)
    except OSError:
        pass
    return None


def command_doctor(workspace, lock_path, overlay_path, artifact=False):
    vcs = detect_vcs(workspace.source) if workspace.source.is_dir() else None
    tools = {name: shutil.which(name) for name in
             ["python3", "node", "git", "make", "clang", "rustc", "cargo", "cbindgen"]}
    mozbuild = Path(os.environ.get("MOZBUILD_STATE_PATH") or Path.home() / ".mozbuild")
    memory = memory_gib()
    probe = workspace.path if workspace.path.exists() else workspace.path.parent
    while not probe.exists():
        probe = probe.parent
    free_gib = round(shutil.disk_usage(probe).free / 1024 ** 3, 1)

    warnings = []
    if artifact:
        warnings.append("Artifact builds keep Firefox's native identity (dist/bin/firefox); "
                        "use a full build for a distributable Argon.")
        if workspace.source.is_dir() and vcs is None:
            warnings.append(
                "The source checkout has no hg/git metadata, so mach cannot resolve "
                "artifacts (ValueError: Must provide path to exactly one of hg and git). "
                "Git artifact builds require a git-cinnabar clone."
            )
    else:
        if not (tools["clang"] and tools["rustc"]) and not mozbuild.is_dir():
            warnings.append("No clang/rustc and no ~/.mozbuild toolchains: run "
                            "`python3 scripts/argon.py bootstrap` before building.")
        if memory is not None and memory < 8:
            warnings.append(f"{memory} GiB RAM: Mozilla recommends 8 GB or more for a full "
                            "build. Use --jobs 1, add swap, or build on CI.")
        if free_gib < 40:
            warnings.append(f"{free_gib} GiB free at the workspace: a full build needs about 40 GB.")

    return {
        "build_mode": "artifact" if artifact else "source",
        "native_identity_rebranded": not artifact,
        "app_name": None if artifact else APP_NAME,
        "workspace": str(workspace.path),
        "lock": str(lock_path),
        "lock_present": Path(lock_path).is_file(),
        "overlay_present": Path(overlay_path).is_file(),
        "mozconfig_present": MOZCONFIG.is_file(),
        "source_present": workspace.source.is_dir(),
        "source_vcs": vcs,
        "memory_gib": memory,
        "free_disk_gib": free_gib,
        "mozbuild_state": str(mozbuild) if mozbuild.is_dir() else None,
        "tools": tools,
        "warnings": warnings,
    }


def _extract_flag(extra, name):
    if name in extra and extra.index(name) + 1 < len(extra):
        idx = extra.index(name)
        return Path(extra[idx + 1])
    return None


def _extract_str_flag(extra, name):
    if name in extra and extra.index(name) + 1 < len(extra):
        idx = extra.index(name)
        return extra[idx + 1]
    return None


def _extract_multi_flag(extra, name):
    values = []
    i = 0
    while i < len(extra):
        if extra[i] == name:
            j = i + 1
            while j < len(extra) and not extra[j].startswith("--"):
                values.append(Path(extra[j]))
                j += 1
            i = j
        else:
            i += 1
    return values


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workspace", type=Path, default=None,
                        help="build workspace (default $ARGON_WORKSPACE or ~/.cache/argon-build)")
    parser.add_argument("--lock", type=Path, default=LOCK)
    parser.add_argument("--overlay", type=Path, default=OVERLAY)
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--artifact", action="store_true",
                        help="front-end-only artifact build (keeps Firefox's native identity)")
    parser.add_argument("--binary", help="run: browser binary to launch instead of the build")
    parser.add_argument("--dry-run", action="store_true", help="run: print the command only")
    parser.add_argument("--archive", type=Path, default=None,
                        help="flatpak: packaged argon-*.tar.* archive to bundle")
    parser.add_argument("--runtime", type=Path, default=None,
                        help="flatpak: synchronized Argon runtime directory to bundle")
    parser.add_argument("--output", type=Path, default=None,
                        help="flatpak / flatpak-repo: output .flatpak bundle or pages directory")
    parser.add_argument("--bundle", type=Path, action="append", default=None,
                        help="verify-flatpak / flatpak-repo: .flatpak bundle path(s)")
    parser.add_argument("--repo-url", default=None,
                        help="flatpak-repo: public OSTree repository URL")
    parser.add_argument("--no-prune", action="store_true",
                        help="flatpak-repo: do not prune unreferenced objects")
    parser.add_argument("--require-full-omni", action="store_true",
                        help="verify-flatpak: require Argon overlay modules inside browser/omni.ja")
    parser.add_argument("--gpg-sign", default=None,
                        help="flatpak: GPG key ID to sign the OSTree commit and bundle")
    parser.add_argument("--gpg-homedir", type=Path, default=None,
                        help="flatpak: GPG homedir for signing keys")
    parser.add_argument("command", choices=["doctor", "fetch", "apply", "bootstrap", "build",
                                            "run", "package", "flatpak", "flatpak-repo",
                                            "verify-flatpak"])
    parser.add_argument("extra", nargs=argparse.REMAINDER,
                        help="run: arguments passed through to the browser")
    args = parser.parse_args(argv)
    workspace_path = args.workspace or default_workspace()

    try:
        workspace = Workspace(REPO, workspace_path)
        if args.command == "doctor":
            report = command_doctor(workspace, args.lock, args.overlay, args.artifact)
        elif args.command == "fetch":
            report = command_fetch(workspace, args.lock)
        elif args.command == "apply":
            report = command_apply(workspace, args.lock, args.overlay)
        elif args.command == "bootstrap":
            report = command_bootstrap(workspace, args.lock)
        elif args.command == "build":
            report = command_build(workspace, args.lock, args.jobs, args.artifact)
        elif args.command == "package":
            report = command_package(workspace, args.lock)
        elif args.command == "flatpak":
            extra = list(args.extra)
            archive = _extract_flag(extra, "--archive") or args.archive
            runtime = _extract_flag(extra, "--runtime") or args.runtime
            output = _extract_flag(extra, "--output") or args.output
            gpg_homedir = _extract_flag(extra, "--gpg-homedir") or args.gpg_homedir
            gpg_sign = _extract_str_flag(extra, "--gpg-sign") or args.gpg_sign
            report = command_flatpak(workspace, archive, output, runtime=runtime,
                                     gpg_sign=gpg_sign, gpg_homedir=gpg_homedir)
        elif args.command == "flatpak-repo":
            extra = list(args.extra)
            bundles = _extract_multi_flag(extra, "--bundle") or (args.bundle or [])
            output = _extract_flag(extra, "--output") or args.output
            repo_url = _extract_str_flag(extra, "--repo-url") or args.repo_url
            gpg_homedir = _extract_flag(extra, "--gpg-homedir") or args.gpg_homedir
            gpg_sign = _extract_str_flag(extra, "--gpg-sign") or args.gpg_sign
            prune = not (args.no_prune or "--no-prune" in extra)
            report = command_flatpak_repo(
                workspace,
                bundles=bundles or None,
                output_dir=output,
                repo_url=repo_url,
                gpg_sign=gpg_sign,
                gpg_homedir=gpg_homedir,
                prune=prune,
            )
        elif args.command == "verify-flatpak":
            extra = list(args.extra)
            bundle = _extract_flag(extra, "--bundle") or (args.bundle[0] if args.bundle else None)
            require_full_omni = args.require_full_omni or "--require-full-omni" in extra
            report = command_verify_flatpak(workspace, bundle=bundle, require_full_omni=require_full_omni)
        else:
            # Accept run's own flags after the command too (`run --dry-run`);
            # everything after `--` goes to the browser untouched.
            extra = list(args.extra)
            passthrough = []
            if "--" in extra:
                index = extra.index("--")
                extra, passthrough = extra[:index], extra[index + 1:]
            dry_run = args.dry_run or "--dry-run" in extra
            binary = args.binary
            if "--binary" in extra and extra.index("--binary") + 1 < len(extra):
                binary = extra[extra.index("--binary") + 1]
                del extra[extra.index("--binary"):extra.index("--binary") + 2]
            extra = [a for a in extra if a != "--dry-run"] + passthrough
            report = command_run(workspace, binary, extra, dry_run)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(report, indent=2))
    if isinstance(report, dict) and report.get("exit_code") not in (None, 0):
        return report["exit_code"]
    return 0


if __name__ == "__main__":
    sys.exit(main())
