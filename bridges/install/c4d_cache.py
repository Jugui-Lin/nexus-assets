"""Resolve and lease the cache used by the Cinema 4D import bridge."""

import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time


_PREFERENCES = "c4d-import-preferences.json"
_WORKSPACES = "c4d-import-workspaces"
_WORKSPACE_KEY = re.compile(r"(?:personal|team)-[0-9a-f]{32}")
_LEASE = ".nexus-cache-lease"
_HASH_CACHE = re.compile(r"(?:zip|texture|sbsar)-[0-9a-f]{64}")
_CONVERSION_CACHE = re.compile(r"(?:scene-fbx|max-decode)-[a-z0-9_]{8}")
_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & _REPARSE)


def _plain_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and not _is_link(info)


def _plain_directory(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(info.st_mode) and not _is_link(info)


def read_preferences(app_root):
    """Return recognized settings, using the original defaults when unavailable."""
    path = Path(app_root) / _PREFERENCES
    try:
        if not _plain_file(path):
            return {}
        with path.open(encoding="utf-8") as stream:
            values = json.loads(stream.read(32769))
        if not isinstance(values, dict):
            return {}
    except (OSError, ValueError):
        return {}
    return _checked_preferences(values)


def _checked_preferences(values):
    preferences = {}
    for key in ("directory", "blenderExecutable", "maxBatchExecutable"):
        value = values.get(key)
        if isinstance(value, str) and value.strip() and len(value) <= 4096 and "\x00" not in value:
            preferences[key] = value.strip()
    if values.get("maxMode") in ("direct", "application"):
        preferences["maxMode"] = values["maxMode"]
    if values.get("maxMaterialRenderer") in ("octane", "standard", "auto"):
        preferences["maxMaterialRenderer"] = values["maxMaterialRenderer"]
    preferences["cleanupOnStartup"] = values.get("cleanupOnStartup") is True
    return preferences


def job_preferences(snapshot):
    key, settings = snapshot.get("workspaceKey"), snapshot.get("settings")
    if key is not None and (not isinstance(key, str) or not _WORKSPACE_KEY.fullmatch(key)):
        raise ValueError("C4D 导入设置所属资产库无效")
    if not isinstance(settings, dict):
        raise ValueError("无法读取任务的 C4D 导入设置")
    return key, _checked_preferences(settings)


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class _Overlapped(ctypes.Structure):
        _fields_ = [
            ("internal", ctypes.c_size_t),
            ("internal_high", ctypes.c_size_t),
            ("offset", wintypes.DWORD),
            ("offset_high", wintypes.DWORD),
            ("event", wintypes.HANDLE),
        ]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _create = _kernel.CreateFileW
    _create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    _create.restype = wintypes.HANDLE
    _close = _kernel.CloseHandle
    _close.argtypes = (wintypes.HANDLE,)
    _close.restype = wintypes.BOOL
    _lock = _kernel.LockFileEx
    _lock.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                      wintypes.DWORD, ctypes.POINTER(_Overlapped))
    _lock.restype = wintypes.BOOL
    _unlock = _kernel.UnlockFileEx
    _unlock.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                        ctypes.POINTER(_Overlapped))
    _unlock.restype = wintypes.BOOL

    def _lease_fd(path):
        generic_read_write = 0xC0000000
        share_read_write = 3
        open_always = 4
        open_reparse_point = 0x00200000
        handle = _create(str(path), generic_read_write, share_read_write, None, open_always,
                         open_reparse_point, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        except OSError:
            _close(handle)
            raise

    def _try_lock(lease, exclusive):
        fail_fast = 1
        lock_exclusive = 2
        flags = fail_fast | (lock_exclusive if exclusive else 0)
        if _lock(msvcrt.get_osfhandle(lease.fileno()), flags, 0, 1, 0, ctypes.byref(_Overlapped())):
            return True
        error = ctypes.get_last_error()
        if error == 33:
            return False
        raise ctypes.WinError(error)

    def _release_lock(lease):
        if not _unlock(msvcrt.get_osfhandle(lease.fileno()), 0, 1, 0, ctypes.byref(_Overlapped())):
            raise ctypes.WinError(ctypes.get_last_error())
else:
    import fcntl

    def _lease_fd(path):
        return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)

    def _try_lock(lease, exclusive):
        flag = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(lease.fileno(), flag | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False

    def _release_lock(lease):
        fcntl.flock(lease.fileno(), fcntl.LOCK_UN)


def _open_lease(cache):
    path = cache / _LEASE
    try:
        if _is_link(path.lstat()):
            raise OSError("Invalid lease file")
    except FileNotFoundError:
        pass
    lease = os.fdopen(_lease_fd(path), "r+b")
    try:
        info, entry = os.fstat(lease.fileno()), path.lstat()
        if (not stat.S_ISREG(info.st_mode) or _is_link(info) or _is_link(entry)
                or info.st_nlink != 1 or not os.path.samestat(info, entry)):
            raise OSError("Invalid lease file")
        return lease
    except OSError:
        lease.close()
        raise


def _managed_directory(parent, name):
    directory = parent / name
    directory.mkdir(exist_ok=True)
    if not _plain_directory(directory) or directory.resolve(strict=True) != directory:
        raise OSError("Unusable cache directory")
    return directory


def _safe_tree(directory):
    pending = [directory]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if _is_link(info):
                    return False
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)
                elif not stat.S_ISREG(info.st_mode):
                    return False
    return True


def _clean_children(parent, pattern, markers):
    ignored = 0
    for entry in parent.iterdir():
        if not pattern.fullmatch(entry.name):
            continue
        try:
            if (_plain_directory(entry) and entry.resolve(strict=True).parent == parent
                    and all(_plain_file(entry / marker) for marker in markers)
                    and _safe_tree(entry)):
                shutil.rmtree(entry)
        except OSError:
            ignored += 1
    return ignored


def _clean_cache(cache):
    skipped = _clean_children(cache, _HASH_CACHE, (".nexus-ready",))
    converted = cache / "converted"
    if _plain_directory(converted) and converted.resolve(strict=True).parent == cache:
        skipped += _clean_children(converted, _CONVERSION_CACHE, ("scene.fbx", "converter.log"))
    return skipped


def _leased_cache(cache, cleanup):
    lease = _open_lease(cache)
    warning = None
    try:
        if cleanup:
            if _try_lock(lease, exclusive=True):
                try:
                    if _clean_cache(cache):
                        warning = "部分 Cinema 4D 导入缓存无法清理，已保留。"
                except OSError:
                    warning = "无法完整清理 Cinema 4D 导入缓存。"
                finally:
                    _release_lock(lease)
            else:
                warning = "另一个 Cinema 4D 实例正在使用导入缓存，已跳过启动清理。"
        for _ in range(25):
            if _try_lock(lease, exclusive=False):
                return lease, warning
            time.sleep(0.04)
        raise OSError("Cache still locked")
    except OSError:
        lease.close()
        raise


def open_cache(app_root, workspace_key=None, preferences=None):
    """Return the cache, its lifetime lease, and any nonfatal startup warning."""
    if preferences is None:
        preferences = read_preferences(app_root)
    cleanup = preferences.get("cleanupOnStartup") is True
    notice = None
    try:
        app_root = Path(app_root).resolve()
        custom_name = "Nexus-C4D-Import-Cache"
        if workspace_key is not None:
            if not isinstance(workspace_key, str) or not _WORKSPACE_KEY.fullmatch(workspace_key):
                raise ValueError("Invalid workspace key")
            app_root = _managed_directory(_managed_directory(app_root, _WORKSPACES), workspace_key)
            custom_name += "-" + workspace_key
        directory = preferences.get("directory")
        if directory:
            try:
                parent = Path(directory)
                if not parent.is_absolute() or not _plain_directory(parent):
                    raise OSError("Unusable cache parent")
                cache = _managed_directory(parent.resolve(strict=True), custom_name)
            except (OSError, ValueError):
                cache = _managed_directory(app_root, "c4d-import-cache")
                cleanup = False
                notice = "无法使用设置的导入临时目录，本次使用 Nexus 默认目录。"
        else:
            cache = _managed_directory(app_root, "c4d-import-cache")
        lease, warning = _leased_cache(cache, cleanup)
        return cache, lease, notice or warning
    except (OSError, ValueError):
        return (Path(tempfile.mkdtemp(prefix="nexus-c4d-import-")), None,
                "无法锁定或访问共享的导入缓存目录，本次使用独立目录。")
