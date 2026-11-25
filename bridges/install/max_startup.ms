(
    local root = getFilenamePath (getSourceFileName())
    local script = pathConfig.appendPath root "nexus_assets_start.py"
    local result = python.ExecuteFile script throwOnError:false clearUndoBuffer:false
    if result != #success do format "Nexus Assets: 3ds Max bridge could not start: %\n" (python.GetLastError())
)
