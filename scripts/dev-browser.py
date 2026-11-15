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
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib

REPO = Path(__file__).resolve().parents[1]
WINDOW = "chrome/browser/content/browser/browser.xhtml"
DEFAULTS = "defaults/preferences/firefox.js"
_MAX_FILE_CACHE = 1024
_FILE_CACHE = {}
_OVERLAY_CACHE = {}
_HOOK_HASH_CACHE = {}
_ZIP_LOCAL_SIG = b"PK\x03\x04"
_ZIP_CENTRAL_SIG = b"PK\x01\x02"
_ZIP_EOCD_SIG = b"PK\x05\x06"


def _stat_sig(path):
    st = path.stat()
    return (st.st_mtime_ns, st.st_size, st.st_ctime_ns, st.st_ino)


def _read_cached_file(path):
    key = str(path)
    sig = _stat_sig(path)
    cached = _FILE_CACHE.get(key)
    if cached is not None and cached[0] == sig:
        return cached[1], cached[2]
    data = path.read_bytes()
    digest = hashlib.sha256(data).digest()
    if len(_FILE_CACHE) >= _MAX_FILE_CACHE:
        _FILE_CACHE.clear()
    _FILE_CACHE[key] = (sig, data, digest)
    return data, digest


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
    overlay_path = repo_file(repo, "config/overlay.json")
    cache_key = str(overlay_path)
    sig = _stat_sig(overlay_path)
    cached = _OVERLAY_CACHE.get(cache_key)
    if cached is not None and cached[0] == sig:
        return cached[1]

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

    raw_bytes, _ = _read_cached_file(overlay_path)
    overlay = require(json.loads(raw_bytes.decode("utf-8")), dict, "manifest")
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
    if len(_OVERLAY_CACHE) >= 32:
        _OVERLAY_CACHE.clear()
    _OVERLAY_CACHE[cache_key] = (sig, overlay)
    return overlay


def _resolve_repo_file(repo_root, relative):
    path = (repo_root / relative).resolve()
    if not path.is_relative_to(repo_root) or not path.is_file():
        raise DevError(f"Missing or out-of-repository resource: {relative}")
    return path


def _collect_resource_updates(repo):
    repo_root = Path(repo).resolve()
    overlay = read_overlay(repo_root)
    copied = {entry["to"]: _resolve_repo_file(repo_root, entry["from"]) for entry in overlay["files"]}
    jar = next(hook for hook in overlay["hooks"] if hook["path"] == "browser/base/jar.mn")
    updates = {}
    digests = {}
    for entry in jar["entries"]:
        destination = PurePosixPath(entry["destination"])
        if destination.is_absolute() or ".." in destination.parts:
            raise DevError("Invalid jar resource destination")
        source = copied.get("browser/base/" + entry["source"])
        if source is None:
            raise DevError(f"Jar resource is not copied by the overlay: {entry['source']}")
        data, file_digest = _read_cached_file(source)
        target = "chrome/browser/" + destination.as_posix()
        updates[target] = data
        digests[target] = file_digest
    branding = overlay["branding"]["from"] + "/content/"
    branding_jar_bytes, _ = _read_cached_file(_resolve_repo_file(repo_root, branding + "jar.mn"))
    for line in branding_jar_bytes.decode("utf-8").splitlines():
        if not line.strip().startswith("content/branding/"):
            continue
        match = re.fullmatch(r"\s*(content/branding/[\w.@-]+)\s+\(([^)]+)\)\s*", line)
        if not match:
            raise DevError(f"Unsupported branding jar entry: {line}")
        data, file_digest = _read_cached_file(_resolve_repo_file(repo_root, branding + match[2]))
        target = "chrome/browser/" + match[1]
        updates[target] = data
        digests[target] = file_digest
    hooks = {hook["path"]: hook for hook in overlay["hooks"]}
    window_path = _resolve_repo_file(repo_root, hooks["browser/base/content/browser.xhtml"]["include"])
    window_bytes, _ = _read_cached_file(window_path)
    fragment = []
    for line in window_bytes.decode("utf-8").splitlines():
        if line.lstrip().startswith("#"):
            if re.match(r"\s*#(?:if|else|elif|endif|include|define|undef|expand|filter)\b", line):
                raise DevError("Conditional/preprocessed window hooks require a frontend build")
            continue
        fragment.append(line)
    window_out = "\n".join(fragment).encode()
    updates[WINDOW] = window_out
    digests[WINDOW] = hashlib.sha256(window_out).digest()
    defaults_path = _resolve_repo_file(repo_root, hooks["browser/app/profile/firefox.js"]["include"])
    defaults_bytes, defaults_digest = _read_cached_file(defaults_path)
    updates[DEFAULTS] = defaults_bytes
    digests[DEFAULTS] = defaults_digest
    return updates, digests


def resource_updates(repo):
    updates, _ = _collect_resource_updates(repo)
    return updates


def read_hook_hashes(repo):
    lock_path = repo_file(repo, "config/firefox.lock.json")
    cache_key = str(lock_path)
    sig = _stat_sig(lock_path)
    cached = _HOOK_HASH_CACHE.get(cache_key)
    if cached is not None and cached[0] == sig:
        return cached[1]
    raw_bytes, _ = _read_cached_file(lock_path)
    lock = json.loads(raw_bytes.decode("utf-8"))
    hashes = lock.get("hooks") if isinstance(lock, dict) else None
    if not isinstance(hashes, dict) or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
        for value in hashes.values()
    ):
        raise DevError("Invalid config/firefox.lock.json: expected pinned SHA-256 hook hashes")
    if len(_HOOK_HASH_CACHE) >= 32:
        _HOOK_HASH_CACHE.clear()
    _HOOK_HASH_CACHE[cache_key] = (sig, hashes)
    return hashes


def source_snapshot(repo):
    repo = Path(repo)
    _, overlay_digest = _read_cached_file(repo_file(repo, "config/overlay.json"))
    digest = hashlib.sha256(overlay_digest)
    read_hook_hashes(repo)
    _, lock_digest = _read_cached_file(repo_file(repo, "config/firefox.lock.json"))
    digest.update(lock_digest)
    _, update_digests = _collect_resource_updates(repo)
    for name, file_digest in sorted(update_digests.items()):
        digest.update(name.encode())
        digest.update(file_digest)
    for optional in (
        "settings/librewolf.cfg",
        "settings/defaults/pref/local-settings.js",
        "settings/distribution/policies.json",
    ):
        candidate = repo / optional
        if candidate.is_file():
            _, opt_digest = _read_cached_file(candidate)
            digest.update(optional.encode())
            digest.update(opt_digest)
    return digest.hexdigest()


def replace_section(text, begin, end, content, append=False):
    if begin not in text and end not in text and append:
        return text + "\n" + begin + "\n" + content + "\n" + end + "\n"
    if text.count(begin) != 1 or text.count(end) != 1 or text.index(end) < text.index(begin):
        raise DevError("The prebuilt browser is missing a unique Argon window hook")
    first = text.index(begin) + len(begin)
    last = text.index(end)
    return text[:first] + "\n" + content + "\n" + text[last:]


def _encode_zip_name(filename, flag_bits=0):
    if (flag_bits & 0x0800) or not filename.isascii():
        return filename.encode("utf-8"), 0x0800
    try:
        return filename.encode("cp437"), 0
    except UnicodeEncodeError:
        return filename.encode("utf-8"), 0x0800


def _dos_time_date(date_time):
    year, month, day, hour, minute, second = date_time
    mod_time = (hour << 11) | (minute << 5) | (second // 2)
    mod_date = ((max(year, 1980) - 1980) << 9) | (month << 5) | day
    return mod_time, mod_date


def _deflate_raw(data):
    compressor = zlib.compressobj(zlib.Z_DEFAULT_COMPRESSION, zlib.DEFLATED, -15)
    return compressor.compress(data) + compressor.flush()


def _write_repacked_zip_raw(base_archive_path, original, temporary_path, updates):
    """Repack omni.ja copying untouched compressed payloads without recompressing."""
    infolist = original.infolist()
    pending = dict(updates)
    total_count = len(infolist) + sum(1 for k in pending if k not in {i.filename for i in infolist})
    if total_count >= 0xFFFF:
        return False

    central_records = []
    local_offset = 0
    with open(base_archive_path, "rb") as orig_fp, open(temporary_path, "wb") as out_fp:
        for info in infolist:
            if info.file_size >= 0xFFFFFFFF or info.compress_size >= 0xFFFFFFFF:
                return False
            if local_offset >= 0xFFFFFFFF:
                return False

            if info.filename in pending:
                raw_data = pending.pop(info.filename)
                method = info.compress_type if info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) else zipfile.ZIP_DEFLATED
                crc = zlib.crc32(raw_data) & 0xFFFFFFFF
                uncomp_size = len(raw_data)
                if uncomp_size >= 0xFFFFFFFF:
                    return False
                payload = _deflate_raw(raw_data) if method == zipfile.ZIP_DEFLATED else raw_data
                comp_size = len(payload)
                if comp_size >= 0xFFFFFFFF:
                    return False
                name_bytes, utf8_flag = _encode_zip_name(info.filename, info.flag_bits)
                flags = (info.flag_bits & ~0x0008) | utf8_flag
                mod_time, mod_date = _dos_time_date(info.date_time)
            else:
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    return False
                orig_fp.seek(info.header_offset)
                orig_lfh = orig_fp.read(30)
                if len(orig_lfh) != 30 or orig_lfh[:4] != _ZIP_LOCAL_SIG:
                    return False
                lfh_fields = struct.unpack("<4s5H3I2H", orig_lfh)
                lfh_name_len, lfh_extra_len = lfh_fields[-2], lfh_fields[-1]
                orig_fp.seek(info.header_offset + 30 + lfh_name_len + lfh_extra_len)
                payload = orig_fp.read(info.compress_size)
                if len(payload) != info.compress_size:
                    return False
                method = info.compress_type
                crc = info.CRC & 0xFFFFFFFF
                comp_size = info.compress_size
                uncomp_size = info.file_size
                name_bytes, utf8_flag = _encode_zip_name(info.filename, info.flag_bits)
                flags = (info.flag_bits & ~0x0008) | utf8_flag
                mod_time, mod_date = _dos_time_date(info.date_time)

            extract_ver = max(20, info.extract_version)
            create_by = ((info.create_system & 0xFF) << 8) | (max(20, info.create_version) & 0xFF)
            lfh = struct.pack(
                "<4s5H3I2H",
                _ZIP_LOCAL_SIG,
                extract_ver,
                flags,
                method,
                mod_time,
                mod_date,
                crc,
                comp_size,
                uncomp_size,
                len(name_bytes),
                0,
            )
            out_fp.write(lfh)
            out_fp.write(name_bytes)
            out_fp.write(payload)

            cdh = struct.pack(
                "<4s6H3I5H2I",
                _ZIP_CENTRAL_SIG,
                create_by,
                extract_ver,
                flags,
                method,
                mod_time,
                mod_date,
                crc,
                comp_size,
                uncomp_size,
                len(name_bytes),
                0,
                0,
                0,
                info.internal_attr,
                info.external_attr,
                local_offset,
            )
            central_records.append(cdh + name_bytes)
            local_offset += len(lfh) + len(name_bytes) + comp_size

        now_tuple = time.localtime()[:6]
        new_time, new_date = _dos_time_date(now_tuple)
        for name, raw_data in pending.items():
            if local_offset >= 0xFFFFFFFF or len(raw_data) >= 0xFFFFFFFF:
                return False
            payload = _deflate_raw(raw_data)
            if len(payload) >= 0xFFFFFFFF:
                return False
            crc = zlib.crc32(raw_data) & 0xFFFFFFFF
            name_bytes, utf8_flag = _encode_zip_name(name, 0x0800)
            lfh = struct.pack(
                "<4s5H3I2H",
                _ZIP_LOCAL_SIG,
                20,
                utf8_flag,
                zipfile.ZIP_DEFLATED,
                new_time,
                new_date,
                crc,
                len(payload),
                len(raw_data),
                len(name_bytes),
                0,
            )
            out_fp.write(lfh)
            out_fp.write(name_bytes)
            out_fp.write(payload)
            cdh = struct.pack(
                "<4s6H3I5H2I",
                _ZIP_CENTRAL_SIG,
                (3 << 8) | 20,
                20,
                utf8_flag,
                zipfile.ZIP_DEFLATED,
                new_time,
                new_date,
                crc,
                len(payload),
                len(raw_data),
                len(name_bytes),
                0,
                0,
                0,
                0,
                0o644 << 16,
                local_offset,
            )
            central_records.append(cdh + name_bytes)
            local_offset += len(lfh) + len(name_bytes) + len(payload)

        if local_offset >= 0xFFFFFFFF:
            return False
        cd_data = b"".join(central_records)
        if len(cd_data) >= 0xFFFFFFFF:
            return False
        eocd = struct.pack(
            "<4s4H2IH",
            _ZIP_EOCD_SIG,
            0,
            0,
            len(central_records),
            len(central_records),
            len(cd_data),
            local_offset,
            0,
        )
        out_fp.write(cd_data)
        out_fp.write(eocd)
    return True


def sync_resources(repo, base, runtime):
    """Repack only the private archive, always starting with the pristine base."""
    repo_path = Path(repo)
    base_path = Path(base)
    runtime_path = Path(runtime)
    updates, update_digests = _collect_resource_updates(repo_path)
    base_archive = base_path / "browser/omni.ja"
    destination = runtime_path / "browser/omni.ja"
    sync_state_file = destination.with_name(".omni-sync.json")
    if (base_path.resolve() == runtime_path.resolve()
            or any(path.is_symlink() for path in (destination, destination.parent, runtime_path, sync_state_file))):
        raise DevError("Refusing to overwrite the prebuilt application")

    base_sig = list(_stat_sig(base_archive))
    overlay_sig = list(_stat_sig(repo_file(repo_path, "config/overlay.json")))
    lock_sig = list(_stat_sig(repo_file(repo_path, "config/firefox.lock.json")))
    digest_map = {name: digest.hex() for name, digest in sorted(update_digests.items())}

    omni_up_to_date = False
    if destination.is_file() and sync_state_file.is_file():
        try:
            saved_state = json.loads(sync_state_file.read_text(encoding="utf-8"))
            if (
                isinstance(saved_state, dict)
                and saved_state.get("base_sig") == base_sig
                and saved_state.get("dest_sig") == list(_stat_sig(destination))
                and saved_state.get("overlay_sig") == overlay_sig
                and saved_state.get("lock_sig") == lock_sig
                and saved_state.get("updates") == digest_map
            ):
                omni_up_to_date = True
        except (OSError, ValueError):
            omni_up_to_date = False

    if not omni_up_to_date:
        handle, temporary = tempfile.mkstemp(prefix=".argon-ui-", dir=destination.parent)
        os.close(handle)
        temporary = Path(temporary)
        try:
            with zipfile.ZipFile(base_archive) as original:
                updates[WINDOW] = replace_section(
                    original.read(WINDOW).decode(), "<!-- BEGIN Argon overlay -->", "<!-- END Argon overlay -->",
                    updates[WINDOW].decode()).encode()
                updates[DEFAULTS] = replace_section(
                    original.read(DEFAULTS).decode(), "// BEGIN Argon development defaults",
                    "// END Argon development defaults", updates[DEFAULTS].decode(), append=True).encode()
                hashes = read_hook_hashes(repo_path)
                for hook in read_overlay(repo_path)["hooks"]:
                    if "resource" not in hook:
                        continue
                    resource = hook["resource"]
                    if resource not in original.namelist():
                        raise DevError(f"Missing packaged overlay resource: {resource}")
                    data = original.read(resource)
                    text = data.decode()
                    replacements = hook["replacements"]
                    previous = hook.get("previous_replacements", [])
                    if previous and not all(item["new"] in text for item in replacements) and all(item["new"] in text for item in previous):
                        # Restore a known prior overlay to the hash-verified upstream input.
                        for item in reversed(previous):
                            text = text.replace(item["new"], item["old"], 1)
                        data = text.encode()
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
                if not _write_repacked_zip_raw(base_archive, original, temporary, updates):
                    remaining = dict(updates)
                    with zipfile.ZipFile(temporary, "w") as output:
                        for info in original.infolist():
                            data = remaining.pop(info.filename) if info.filename in remaining else original.read(info)
                            output.writestr(info, data)
                        for name, data in remaining.items():
                            output.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
            temporary.replace(destination)
            sync_state_file.write_text(json.dumps({
                "base_sig": base_sig,
                "dest_sig": list(_stat_sig(destination)),
                "overlay_sig": overlay_sig,
                "lock_sig": lock_sig,
                "updates": digest_map,
            }))
        finally:
            temporary.unlink(missing_ok=True)

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
            if dst_file.is_file():
                _, src_digest = _read_cached_file(src_file)
                _, dst_digest = _read_cached_file(dst_file)
                if src_digest == dst_digest:
                    continue
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, dst_file)


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
        result = subprocess.run(["flatpak", "info", "--show-location", "io.github.argon_browser.Argon"],
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


def launch_browser(binary, profile, arguments, purge_caches=True):
    # Native cache invalidation makes edited chrome modules visible at restart unless --no-purge is set.
    environment = dict(os.environ)
    if purge_caches:
        environment["MOZ_PURGE_CACHES"] = "1"
        startup_cache = Path(profile) / "startupCache"
        if startup_cache.exists():
            shutil.rmtree(startup_cache, ignore_errors=True)
    else:
        environment.pop("MOZ_PURGE_CACHES", None)
    return subprocess.Popen([str(binary), "--no-remote", "--new-instance", "--profile", str(profile),
                             *arguments, "about:home"], env=environment)


def run_dev(repo, binary, watch=True, sync_only=False, arguments=(), reset_profile=False, purge_caches=True):
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
            browser = launch_browser(runtime / binary.name, profile, arguments, purge_caches=purge_caches)
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
                browser = launch_browser(runtime / binary.name, profile, arguments, purge_caches=purge_caches)
                pending_at = None
            return browser.returncode
        finally:
            stop_browser(browser)


def main(argv=None, repo=REPO):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", help="Prebuilt packaged Argon binary; never modified")
    parser.add_argument("--sync-only", action="store_true", help="Update the private runtime without launching")
    parser.add_argument("--no-watch", action="store_true", help="Sync and launch once, without automatic restarts")
    parser.add_argument("--no-purge", action="store_true", help="Keep Firefox startupCache instead of setting MOZ_PURGE_CACHES=1")
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
        return run_dev(
            Path(repo),
            find_binary(Path(repo), args.binary),
            not args.no_watch,
            args.sync_only,
            arguments,
            args.reset_profile,
            purge_caches=not args.no_purge,
        )
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
