"""Export native Blender and 3ds Max scenes as FBX for Cinema 4D."""

import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


_TIMEOUT_SECONDS = 180
_SOURCE = "NEXUS_C4D_CONVERSION_SOURCE"
_OUTPUT = "NEXUS_C4D_CONVERSION_OUTPUT"
_FBX_HEADER = b"Kaydara FBX Binary  \x00\x1a\x00"
_FBX_FINAL_MAGIC = bytes.fromhex("f85a8c6adef5d97eece90ce3758f290b")
_MAX_SAFE_MARKER = b"NEXUS_MAX_SAFE_SCENE_REQUIRED"
_MAX_SAFE_VERIFIED = b"NEXUS_MAX_SAFE_SCENE_VERIFIED"
_MAX_FINISH_MARKER = b"NEXUS_MAX_STAGE finish"
_MAX_MISSING = re.compile(rb"NEXUS_MAX_MISSING (\d{1,9}) (\d{1,9}) (\d{1,9})\b")
_MAX_LOG_ERRORS = re.compile(rb"(?m)^\d{4}/\d{2}/\d{2} [\d:]+ (?:ERR|FTL): [^\r\n]+")
_MAX_LOG_VALIDATION_BYTES = 1024 * 1024
_MAX_SAFETY_ERROR = "请在 3ds Max 的安全首选项中启用安全场景执行，阻止嵌入式 Python、.NET 和 MAXScript 系统命令，并取消排除脚本资源"
_MAX_STAGE_NAMES = (
    (b"NEXUS_MAX_STAGE security", "检查安全场景设置"),
    (b"NEXUS_MAX_STAGE load", "读取 MAX 场景"),
    (b"NEXUS_MAX_STAGE configure-fbx", "初始化 FBX 导出器"),
    (b"NEXUS_MAX_STAGE export-fbx", "写入 FBX 和贴图"),
    (_MAX_FINISH_MARKER, "结束 3ds Max Batch"),
)

_BLENDER_EXPORT = """
import os
import bpy

result = bpy.ops.export_scene.fbx(
    filepath=os.environ['NEXUS_C4D_CONVERSION_OUTPUT'],
    path_mode='COPY',
    embed_textures=True,
    use_selection=False,
)
if 'FINISHED' not in result:
    raise RuntimeError('FBX export did not finish')
"""

_MAX_EXPORT = r"""
(
    fn requireSafeScene = (
        local security = SceneScriptSecurityManager
        if not ((security.IsSafeSceneScriptExecutionEnabled #Current) and
                (security.IsSceneScriptExecutionBlocked #Python #Current) and
                (security.IsSceneScriptExecutionBlocked #DotNet #Current) and
                (security.IsSceneScriptExecutionBlocked #MAXScriptSystemCommands #Current) and
                security.IsSafeScriptAssetExecutionEnabled()) do
            throw "NEXUS_MAX_SAFE_SCENE_REQUIRED"
    )
    logsystem.logEntry "NEXUS_MAX_STAGE security" broadcast:true
    requireSafeScene()

    local source = systemTools.getEnvVariable "NEXUS_C4D_CONVERSION_SOURCE"
    local output = systemTools.getEnvVariable "NEXUS_C4D_CONVERSION_OUTPUT"
    local missingFiles = #()
    local missingPlugins = #()
    local missingReferences = #()
    logsystem.logEntry "NEXUS_MAX_STAGE load" broadcast:true
    local loaded = loadMaxFile source useFileUnits:true quiet:true allowPrompts:false \
        missingExtFilesAction:#logmsg missingExtFilesList:&missingFiles \
        missingDLLsAction:#logmsg missingDLLsList:&missingPlugins \
        missingXRefsAction:#logmsg missingXRefsList:&missingReferences
    if not loaded do
        throw "Unable to load the 3ds Max scene"
    requireSafeScene()
    logsystem.logEntry "NEXUS_MAX_SAFE_SCENE_VERIFIED" broadcast:true
    format "NEXUS_MAX_MISSING % % %\n" missingFiles.count missingPlugins.count missingReferences.count
    logsystem.logEntry "NEXUS_MAX_STAGE configure-fbx" broadcast:true
    pluginManager.loadClass FbxExporter
    FBXExporterSetParam "ASCII" false
    FBXExporterSetParam "EmbedTextures" true
    FBXExporterSetParam "Cameras" true
    FBXExporterSetParam "Lights" true
    if (FBXExporterGetParam "ASCII") != false do throw "FBX binary export unavailable"
    if (FBXExporterGetParam "EmbedTextures") != true do throw "FBX texture export unavailable"
    if (FBXExporterGetParam "Cameras") != true do throw "FBX camera export unavailable"
    if (FBXExporterGetParam "Lights") != true do throw "FBX light export unavailable"
    logsystem.logEntry "NEXUS_MAX_STAGE export-fbx" broadcast:true
    if not (exportFile output #noPrompt selectedOnly:false using:FBXEXP) do
        throw "Unable to export the 3ds Max scene to FBX"
    logsystem.logEntry "NEXUS_MAX_STAGE finish" broadcast:true
)
"""


def _version(executable):
    return tuple(int(part) for part in re.findall(r"\d+", executable.parent.name))


def _find_executable(ext, executable_path=None):
    blender = ext == ".blend"
    label = "Blender" if blender else "3ds Max Batch"
    if not blender and os.name != "nt":
        raise RuntimeError("转换 .max 需要安装 3ds Max Batch 的 Windows 电脑")

    setting = "NEXUS_BLENDER_EXECUTABLE" if blender else "NEXUS_3DSMAX_BATCH_EXECUTABLE"
    configured = executable_path or os.environ.get(setting)
    if configured:
        executable = Path(configured).expanduser()
        if executable.is_absolute() and executable.is_file():
            return executable
        raise RuntimeError(f"{label} 的可执行文件路径无效")

    if os.name == "nt":
        program_files = {os.environ.get("ProgramW6432"), os.environ.get("ProgramFiles")}
        pattern = "Blender Foundation/Blender */blender.exe" if blender else "Autodesk/3ds Max */3dsmaxbatch.exe"
        installed = [file for root in program_files if root for file in Path(root).glob(pattern) if file.is_file()]
        if installed:
            return max(installed, key=_version)
    elif blender:
        for root in (Path("/Applications"), Path.home() / "Applications"):
            executable = root / "Blender.app/Contents/MacOS/Blender"
            if executable.is_file():
                return executable

    executable_name = "blender" if blender else "3dsmaxbatch"
    if os.name == "nt":
        executable_name += ".exe"
    for entry in os.get_exec_path():
        folder = Path(entry.strip('"'))
        executable = folder / executable_name
        if folder.is_absolute() and executable.is_file() and os.access(executable, os.X_OK):
            return executable
    raise RuntimeError(f"未找到 {label}。请安装 {label}，或先将源文件导出为 FBX")


def _command(ext, executable, source, directory):
    if ext == ".blend":
        return [*_blender_command(executable), str(source),
                "--python-exit-code", "10", "--python-expr", _BLENDER_EXPORT]

    script = directory / "export-scene.ms"
    script.write_text(_MAX_EXPORT, encoding="ascii")
    return [str(executable), str(script), "-safescene", "ON", "-dm", "on",
            "-listenerlog", str(directory / "listener.log"), "-log", str(directory / "max.log")]


def _worker_threads():
    return max(1, min(4, (os.cpu_count() or 2) // 2))


def _blender_command(executable):
    return [str(executable), "--background", "--factory-startup", "--disable-autoexec",
            "--threads", str(_worker_threads())]


def _max_log_tail(directory):
    parts = []
    for name in ("converter.log", "listener.log", "max.log"):
        try:
            with (directory / name).open("rb") as log:
                log.seek(max(0, log.seek(0, os.SEEK_END) - 65536))
                parts.append(log.read())
        except OSError:
            continue
    return b"\n".join(parts).replace(b"\0", b"")


def _missing_max_resources(logs):
    counts = _MAX_MISSING.findall(logs)
    if not counts:
        return ""
    labels = ("外部文件", "插件", "外部引用")
    return "、".join(f"{count} 项{label}" for label, count in zip(labels, map(int, counts[-1])) if count)


def max_export_warning(output):
    logs = _max_log_tail(Path(output).parent)
    missing = _missing_max_resources(logs)
    warnings = [f"MAX 场景缺少 {missing}"] if missing else []
    if any(_blocked_scene_error(line) for line in _MAX_LOG_ERRORS.findall(logs)):
        warnings.append("3ds Max 安全设置已拦截场景中的嵌入式脚本")
    return " · ".join(warnings)


def _blocked_scene_error(line):
    return (b"Security Exception:" in line and b"embedded in the current scene" in line
            and b"has been blocked for the current 3ds Max session" in line)


def _max_export_with_blocked_scripts(returncode, output, logs):
    # Max Batch may report command failure even after export if Safe Scene blocked a scene script.
    if returncode not in {-130, 4294967166} or not _MAX_MISSING.search(logs):
        return False
    try:
        with output.with_name("max.log").open("rb") as log:
            full_log = log.read(_MAX_LOG_VALIDATION_BYTES + 1)
    except OSError:
        return False
    if len(full_log) > _MAX_LOG_VALIDATION_BYTES:
        return False
    full_log = full_log.replace(b"\0", b"")
    if _MAX_SAFE_MARKER in full_log or _MAX_SAFE_VERIFIED not in full_log or _MAX_FINISH_MARKER not in full_log:
        return False
    errors = _MAX_LOG_ERRORS.findall(full_log)
    return bool(errors and all(map(_blocked_scene_error, errors)) and _complete_binary_fbx(output))


def _max_failure(logs, reason):
    if _MAX_SAFE_MARKER in logs:
        return _MAX_SAFETY_ERROR
    stage = next((label for marker, label in reversed(_MAX_STAGE_NAMES) if marker in logs), "启动 3ds Max Batch")
    missing = _missing_max_resources(logs)
    return f"3ds Max Batch 在「{stage}」阶段{reason}" + (f"，缺少{missing}" if missing else "")


def _save_max_failure(directory, source, started, timeout, logs, message):
    try:
        summary = directory / "failure.log"
        details = (f"Source: {source.name}\nElapsed seconds: {time.monotonic() - started:.1f}\n"
                   f"Budget seconds: {timeout}\n{message}\n\n")
        summary.write_bytes(details.encode("utf-8") + logs)
        os.replace(summary, directory.parent / "max-batch-last-failure.log")
    except OSError:
        pass


def _max_timeout(size):
    chunk = 128 * 1024 * 1024
    return min(720, 180 + 120 * (max(0, size - 1) // chunk))


def _is_fbx(output):
    try:
        with output.open("rb") as file:
            return file.read(len(_FBX_HEADER)) == _FBX_HEADER and output.stat().st_size > 27
    except OSError:
        return False


def _complete_binary_fbx(output):
    try:
        with output.open("rb") as file:
            if file.read(len(_FBX_HEADER)) != _FBX_HEADER:
                return False
            version_bytes = file.read(4)
            version = int.from_bytes(version_bytes, "little")
            if version < 6000:
                return False
            offset_size = 8 if version >= 7500 else 4
            first_node_min_end = file.tell() + 3 * offset_size + 1
            first_node_end = int.from_bytes(file.read(offset_size), "little")
            footer = version_bytes + bytes(120) + _FBX_FINAL_MAGIC
            footer_start = file.seek(-len(footer), os.SEEK_END)
            return first_node_min_end < first_node_end < footer_start and file.read() == footer
    except OSError:
        return False


def _terminate_converter(process):
    if os.name == "nt" and process.poll() is None:
        # 3dsmaxbatch owns a separate 3dsmax process, so stop its descendants too.
        system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
        try:
            subprocess.run([str(system), "/PID", str(process.pid), "/T", "/F"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                           timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.kill()


def _check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise RuntimeError("模型转换已取消。")


def _run_converter(command, directory, environment, log, cancel=None, *, timeout=None):
    _check_cancelled(cancel)
    timeout = _TIMEOUT_SECONDS if timeout is None else timeout
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == "nt" else 0
    environment.setdefault("OMP_NUM_THREADS", str(_worker_threads()))
    with subprocess.Popen(command, cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                          stdout=log, stderr=subprocess.STDOUT, creationflags=flags) as process:
        deadline = time.monotonic() + timeout
        try:
            if cancel is None:
                return process.wait(timeout=timeout)
            while True:
                _check_cancelled(cancel)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    return process.wait(timeout=min(remaining, 0.25))
                except subprocess.TimeoutExpired:
                    continue
        except (RuntimeError, subprocess.TimeoutExpired):
            _terminate_converter(process)
            raise


def convert(path, cache_root, executable_path=None, cancel=None):
    """Return a local FBX path for a native scene; pass through other formats."""
    source = Path(path)
    ext = source.suffix.lower()
    if ext not in {".blend", ".max"}:
        return str(source)

    label = "Blender" if ext == ".blend" else "3ds Max Batch"
    executable = _find_executable(ext, executable_path)
    directory = None
    succeeded = False
    try:
        source = source.resolve(strict=True)
        if not source.is_file():
            raise RuntimeError("源场景文件不可读取")
        cache = Path(cache_root).expanduser().resolve()
        cache.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="scene-fbx-", dir=cache))
        output = directory / "scene.fbx"
        command = _command(ext, executable, source, directory)
        environment = {**os.environ, _SOURCE: str(source), _OUTPUT: str(output)}
        timeout = _max_timeout(source.stat().st_size) if ext == ".max" else None
        started = time.monotonic()
        with (directory / "converter.log").open("wb") as log:
            returncode = _run_converter(command, directory, environment, log, cancel, timeout=timeout)
        logs = _max_log_tail(directory) if ext == ".max" else b""
        valid = not returncode and _is_fbx(output)
        if ext == ".max" and returncode:
            valid = _max_export_with_blocked_scripts(returncode, output, logs)
        if _MAX_SAFE_MARKER in logs or not valid:
            if ext == ".max":
                message = _max_failure(logs, f"未生成有效 FBX（退出代码 {returncode}）")
                _save_max_failure(directory, source, started, timeout, logs, message)
                raise RuntimeError(message)
            raise RuntimeError(f"{label} 未生成有效 FBX（退出代码 {returncode}），请检查源文件、外部资源和导出组件")
        succeeded = True
        return str(output)
    except FileNotFoundError as error:
        raise RuntimeError("找不到源场景文件或转换程序") from error
    except subprocess.TimeoutExpired as error:
        if ext == ".max":
            logs = _max_log_tail(directory)
            message = _max_failure(logs, f"超时（{int(error.timeout)} 秒）")
            _save_max_failure(directory, source, started, timeout, logs, message)
            raise RuntimeError(message) from error
        raise RuntimeError(f"{label} 转换超时，请检查场景大小、缺失资源或许可状态") from error
    except OSError as error:
        raise RuntimeError(f"无法运行 {label} 转换或写入本地缓存") from error
    finally:
        if directory and not succeeded and directory.resolve().parent == cache:
            shutil.rmtree(directory, ignore_errors=True)
