#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Run a private prebuilt Argon with synchronized frontend resources."""
import argparse
import configparser
import hashlib
import importlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

REPO = Path(__file__).resolve().parents[1]
WINDOW = "chrome/browser/content/browser/browser.xhtml"
DEFAULTS = "defaults/preferences/firefox.js"


class DevError(Exception):
    """An invalid development input; never patch an installed application."""


def repo_file(repo, relative):
    path = (repo / relative).resolve()
    if not path.is_relative_to(repo.resolve()) or not path.is_file():
        raise DevError(f"Missing or out-of-repository resource: {relative}")
    return path


def prepare_runtime(binary, workspace):
    """Copy the engine once, without hardlinks or symlinks back to its source."""
    binary = Path(binary).resolve()
    workspace = Path(workspace).absolute()
    if any(path.is_symlink() for path in (workspace, *workspace.parents)):
        raise DevError("The development workspace must not use symlinked directories")
    base = binary.parent
    if base.is_relative_to(workspace) or workspace.is_relative_to(base):
        raise DevError("The prebuilt application and development workspace must be separate")
    archive = base / "browser/omni.ja"
    identity_file = base / "application.ini"
    if not binary.is_file() or not archive.is_file() or not identity_file.is_file():
        raise DevError("Use a packaged Argon binary with application.ini and browser/omni.ja")
    config = configparser.ConfigParser()
    config.read(identity_file, encoding="utf-8")
    if config.get("App", "Name", fallback="") != "Argon":
        raise DevError("The development runtime must be a precompiled Argon, not stock Firefox")
    identity = {"binary": str(binary), "binary_mtime": binary.stat().st_mtime_ns,
                "archive_mtime": archive.stat().st_mtime_ns, "archive_size": archive.stat().st_size,
                "application": hashlib.sha256(identity_file.read_bytes()).hexdigest()}
    workspace.mkdir(parents=True, exist_ok=True)
    runtime = workspace / "runtime"
    state = workspace / "engine.json"
    if runtime.is_symlink() or state.is_symlink():
        raise DevError("The private runtime must not be a symlink")
    if state.is_file() and json.loads(state.read_text()) == identity and (runtime / binary.name).is_file():
        return runtime
    staging = Path(tempfile.mkdtemp(prefix=".engine-", dir=workspace))
    try:
        shutil.copytree(base, staging, dirs_exist_ok=True, symlinks=False)
        if runtime.exists():
            shutil.rmtree(runtime)
        staging.replace(runtime)
        state.write_text(json.dumps(identity, indent=2) + "\n")
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return runtime


class DevLock:
    """An OS-released lock prevents two watchers from sharing one profile."""
    def __init__(self, workspace):
        self.workspace = Path(workspace).absolute()

    def __enter__(self):
        if any(path.is_symlink() for path in (self.workspace, *self.workspace.parents)):
            raise DevError("The development workspace must not use symlinked directories")
        self.workspace.mkdir(parents=True, exist_ok=True)
        lock = self.workspace / "dev.lock"
        if lock.is_symlink():
            raise DevError("The development lock must not be a symlink")
        self.handle = lock.open("a+b")
        try:
            locker = importlib.import_module("fcntl")
            locker.flock(self.handle.fileno(), locker.LOCK_EX | locker.LOCK_NB)
        except OSError as error:
            self.handle.close()
            raise DevError("Another npm run dev is already using this workspace") from error
        return self

    def __exit__(self, *_):
        self.handle.close()


def read_overlay(repo):
    """Validate the manifest fields consumed by the no-compile launcher."""
    def require(value, expected, location):
        if not isinstance(value, expected):
            raise DevError(f"Invalid config/overlay.json: {location} must be {expected.__name__}")
        return value

    def entries(value, fields, location):
        require(value, list, location)
        for index, entry in enumerate(value):
            require(entry, dict, f"{location}[{index}]")
            for field in fields:
                require(entry.get(field), str, f"{location}[{index}].{field}")

    overlay = require(json.loads(repo_file(repo, "config/overlay.json").read_text()), dict, "manifest")
    entries(overlay.get("files"), ("from", "to"), "files")
    entries(overlay.get("hooks"), ("path",), "hooks")
    branding = require(overlay.get("branding"), dict, "branding")
    require(branding.get("from"), str, "branding.from")
    hooks = {hook["path"]: hook for hook in overlay["hooks"]}
    for path in ("browser/base/jar.mn", "browser/base/content/browser.xhtml", "browser/app/profile/firefox.js"):
        require(hooks.get(path), dict, f"hooks[{path}]")
    resources = set()
    for hook in overlay["hooks"]:
        path = hook["path"]
        if "resource" in hook:
            resource = require(hook["resource"], str, f"hooks[{path}].resource")
            destination = PurePosixPath(resource)
            if not resource or destination.is_absolute() or ".." in destination.parts or resource in resources:
                raise DevError(f"Invalid config/overlay.json: unsafe or duplicate resource for {path}")
            resources.add(resource)
            entries(hook.get("replacements"), ("old", "new"), f"hooks[{path}].replacements")
            if not hook["replacements"] or any(
                not item["old"] or not item["new"] or item["new"] in item["old"]
                for item in hook["replacements"]
            ):
                raise DevError(f"Invalid config/overlay.json: invalid replacements for {path}")
        if path == "browser/base/jar.mn":
            entries(hook.get("entries"), ("destination", "source"), f"hooks[{path}].entries")
        elif path in {"browser/base/content/browser.xhtml", "browser/app/profile/firefox.js"}:
            require(hook.get("include"), str, f"hooks[{path}].include")
    return overlay


def resource_updates(repo):
    overlay = read_overlay(repo)
    copied = {entry["to"]: repo_file(repo, entry["from"]) for entry in overlay["files"]}
    jar = next(hook for hook in overlay["hooks"] if hook["path"] == "browser/base/jar.mn")
    updates = {}
    for entry in jar["entries"]:
        destination = PurePosixPath(entry["destination"])
        if destination.is_absolute() or ".." in destination.parts:
            raise DevError("Invalid jar resource destination")
        source = copied.get("browser/base/" + entry["source"])
        if source is None:
            raise DevError(f"Jar resource is not copied by the overlay: {entry['source']}")
        updates["chrome/browser/" + destination.as_posix()] = source.read_bytes()
    branding = overlay["branding"]["from"] + "/content/"
    for line in repo_file(repo, branding + "jar.mn").read_text().splitlines():
        if not line.strip().startswith("content/branding/"):
            continue
        match = re.fullmatch(r"\s*(content/branding/[\w.@-]+)\s+\(([^)]+)\)\s*", line)
        if not match:
            raise DevError(f"Unsupported branding jar entry: {line}")
        updates["chrome/browser/" + match[1]] = repo_file(repo, branding + match[2]).read_bytes()
    hooks = {hook["path"]: hook for hook in overlay["hooks"]}
    window = repo_file(repo, hooks["browser/base/content/browser.xhtml"]["include"])
    fragment = []
    for line in window.read_text().splitlines():
        if line.lstrip().startswith("#"):
            if re.match(r"\s*#(?:if|else|elif|endif|include|define|undef|expand|filter)\b", line):
                raise DevError("Conditional/preprocessed window hooks require a frontend build")
            continue
        fragment.append(line)
    updates[WINDOW] = "\n".join(fragment).encode()
    updates[DEFAULTS] = repo_file(repo, hooks["browser/app/profile/firefox.js"]["include"]).read_bytes()
    return updates


def read_hook_hashes(repo):
    lock = json.loads(repo_file(repo, "config/firefox.lock.json").read_text())
    hashes = lock.get("hooks") if isinstance(lock, dict) else None
    if not isinstance(hashes, dict) or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
        for value in hashes.values()
    ):
        raise DevError("Invalid config/firefox.lock.json: expected pinned SHA-256 hook hashes")
    return hashes


def source_snapshot(repo):
    repo = Path(repo)
    digest = hashlib.sha256(repo_file(repo, "config/overlay.json").read_bytes())
    read_hook_hashes(repo)
    digest.update(repo_file(repo, "config/firefox.lock.json").read_bytes())
    for name, data in sorted(resource_updates(repo).items()):
        digest.update(name.encode())
        digest.update(hashlib.sha256(data).digest())
    for optional in (
        "settings/librewolf.cfg",
        "settings/defaults/pref/local-settings.js",
        "settings/distribution/policies.json",
    ):
        candidate = repo / optional
        if candidate.is_file():
            digest.update(optional.encode())
            digest.update(hashlib.sha256(candidate.read_bytes()).digest())
    return digest.hexdigest()


def replace_section(text, begin, end, content, append=False):
    if begin not in text and end not in text and append:
        return text + "\n" + begin + "\n" + content + "\n" + end + "\n"
    if text.count(begin) != 1 or text.count(end) != 1 or text.index(end) < text.index(begin):
        raise DevError("The prebuilt browser is missing a unique Argon window hook")
    first = text.index(begin) + len(begin)
    last = text.index(end)
    return text[:first] + "\n" + content + "\n" + text[last:]


def sync_resources(repo, base, runtime):
    """Repack only the private archive, always starting with the pristine base."""
    updates = resource_updates(Path(repo))
    destination = Path(runtime) / "browser/omni.ja"
    if (Path(base).resolve() == Path(runtime).resolve()
            or any(path.is_symlink() for path in (destination, destination.parent, Path(runtime)))):
        raise DevError("Refusing to overwrite the prebuilt application")
    handle, temporary = tempfile.mkstemp(prefix=".argon-ui-", dir=destination.parent)
    os.close(handle)
    temporary = Path(temporary)
    try:
        with zipfile.ZipFile(Path(base) / "browser/omni.ja") as original, zipfile.ZipFile(temporary, "w") as output:
            updates[WINDOW] = replace_section(
                original.read(WINDOW).decode(), "<!-- BEGIN Argon overlay -->", "<!-- END Argon overlay -->",
                updates[WINDOW].decode()).encode()
            updates[DEFAULTS] = replace_section(
                original.read(DEFAULTS).decode(), "// BEGIN Argon development defaults",
                "// END Argon development defaults", updates[DEFAULTS].decode(), append=True).encode()
            hashes = read_hook_hashes(Path(repo))
            for hook in read_overlay(Path(repo))["hooks"]:
                if "resource" not in hook:
                    continue
                resource = hook["resource"]
                if resource not in original.namelist():
                    raise DevError(f"Missing packaged overlay resource: {resource}")
                data = original.read(resource)
                text = data.decode()
                replacements = hook["replacements"]
                applied = [item["new"] in text for item in replacements]
                if all(applied):
                    continue
                if any(applied):
                    raise DevError(f"Partially applied packaged replacements: {resource}")
                expected = hashes.get(hook["path"])
                if not expected or hashlib.sha256(data).hexdigest() != expected:
                    raise DevError(f"Upstream hook drift in packaged resource: {resource}")
                for item in replacements:
                    if text.count(item["old"]) != 1:
                        raise DevError(f"Expected one replacement anchor in {resource}")
                    text = text.replace(item["old"], item["new"], 1)
                updates[resource] = text.encode()
            for info in original.infolist():
                data = updates.pop(info.filename) if info.filename in updates else original.read(info)
                output.writestr(info, data)
            for name, data in updates.items():
                output.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
        temporary.replace(destination)
        repo_path = Path(repo)
        runtime_path = Path(runtime)
        for src_rel, dst_rel in (
            ("settings/librewolf.cfg", "librewolf.cfg"),
            ("settings/defaults/pref/local-settings.js", "defaults/pref/local-settings.js"),
            ("settings/distribution/policies.json", "distribution/policies.json"),
        ):
            src_file = repo_path / src_rel
            if src_file.is_file():
                dst_file = runtime_path / dst_rel
                if any(p.is_symlink() for p in (dst_file, dst_file.parent)):
                    raise DevError("Refusing to write through a symlink in runtime")
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)
    finally:
        temporary.unlink(missing_ok=True)


def find_binary(repo, supplied=None):
    explicit = supplied or os.environ.get("ARGON_DEV_BINARY")
    if explicit:
        binary = Path(explicit).expanduser().resolve()
        if not binary.is_file():
            raise DevError(f"Prebuilt Argon binary does not exist: {binary}")
        return binary
    for relative in ("artifacts/layout-fix/argon/argon", ".cache/prebuilt/argon/argon"):
        local = repo / relative
        if local.is_file():
            return local.resolve()
    if shutil.which("flatpak"):
        result = subprocess.run(["flatpak", "info", "--show-location", "org.argon.browser"],
                                capture_output=True, text=True, timeout=10, check=False)
        if result.returncode == 0:
            installed = Path(result.stdout.strip()) / "files/lib/argon/argon"
            if installed.is_file():
                return installed.resolve()
    raise DevError("No prebuilt Argon found. Extract an Actions artifact and pass "
                   "--binary /path/to/argon, or set ARGON_DEV_BINARY. Nothing was compiled or downloaded.")


def stop_browser(browser):
    if browser is not None and browser.poll() is None:
        browser.terminate()
        try:
            browser.wait(timeout=10)
        except subprocess.TimeoutExpired:
            browser.kill()
            browser.wait()


def launch_browser(binary, profile, arguments):
    # Native cache invalidation makes edited chrome modules visible at restart.
    environment = dict(os.environ, MOZ_PURGE_CACHES="1")
    startup_cache = Path(profile) / "startupCache"
    if startup_cache.exists():
        shutil.rmtree(startup_cache, ignore_errors=True)
    return subprocess.Popen([str(binary), "--no-remote", "--new-instance", "--profile", str(profile),
                             *arguments, "about:home"], env=environment)


def run_dev(repo, binary, watch=True, sync_only=False, arguments=(), reset_profile=False):
    workspace = repo / ".cache/argon-dev"
    browser = None
    with DevLock(workspace):
        runtime = prepare_runtime(binary, workspace)
        sync_resources(repo, binary.parent, runtime)
        print(f"[argon dev] Frontend synchronized: {runtime}", flush=True)
        profile = workspace / "profile"
        if profile.is_symlink():
            raise DevError("The development profile must not be a symlink")
        if reset_profile and profile.exists():
            shutil.rmtree(profile)
            print(f"[argon dev] Reset development profile: {profile}", flush=True)
        profile.mkdir(exist_ok=True)
        if sync_only:
            return 0
        print(f"[argon dev] Isolated profile: {profile}", flush=True)
        previous = source_snapshot(repo)
        pending_at = None
        last_error = None
        try:
            browser = launch_browser(runtime / binary.name, profile, arguments)
            if watch:
                print("[argon dev] Watching UI resources; save to restart. Ctrl+C stops this instance.", flush=True)
            while browser.poll() is None:
                time.sleep(0.2)
                if not watch:
                    continue
                try:
                    current = source_snapshot(repo)
                except (DevError, OSError, ValueError, KeyError, StopIteration) as error:
                    if str(error) != last_error:
                        print(f"[argon dev] Waiting for a valid save: {error}", flush=True)
                        last_error = str(error)
                    continue
                last_error = None
                if current != previous:
                    previous = current
                    pending_at = time.monotonic()
                if pending_at is None or time.monotonic() - pending_at < 0.4:
                    continue
                print("[argon dev] Frontend changed; synchronizing and restarting...", flush=True)
                stop_browser(browser)
                try:
                    sync_resources(repo, binary.parent, runtime)
                except (DevError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
                    print(f"[argon dev] Keeping the last working frontend: {error}", flush=True)
                browser = launch_browser(runtime / binary.name, profile, arguments)
                pending_at = None
            return browser.returncode
        finally:
            stop_browser(browser)


def main(argv=None, repo=REPO):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", help="Prebuilt packaged Argon binary; never modified")
    parser.add_argument("--sync-only", action="store_true", help="Update the private runtime without launching")
    parser.add_argument("--no-watch", action="store_true", help="Sync and launch once, without automatic restarts")
    parser.add_argument("--reset-profile", action="store_true", help="Delete and recreate the development profile before launching")
    parser.add_argument("browser_args", nargs=argparse.REMAINDER, help="Browser arguments after --")
    args = parser.parse_args(argv)
    arguments = args.browser_args[1:] if args.browser_args[:1] == ["--"] else args.browser_args
    # These could escape the isolated profile or attach to an existing browser.
    for argument in arguments:
        option = argument.split("=", 1)[0].lower().lstrip("-")
        if option in {"profile", "p", "profilemanager", "createprofile", "migration", "remote", "new-instance", "no-remote"}:
            parser.error("Profile and remoting arguments are managed by the development launcher")
    previous_handler = signal.getsignal(signal.SIGTERM)
    def interrupted(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return run_dev(Path(repo), find_binary(Path(repo), args.binary), not args.no_watch, args.sync_only, arguments, args.reset_profile)
    except KeyboardInterrupt:
        print("\n[argon dev] Stopped.", flush=True)
        return 0
    except (DevError, OSError, ValueError, KeyError, StopIteration, zipfile.BadZipFile) as error:
        print(f"[argon dev] Error: {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    raise SystemExit(main())
