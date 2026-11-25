import runpy

import hou

if hou.isUIAvailable():
    try:
        runpy.run_path(__NEXUS_RUNTIME_PATH__)["connect"]("houdini")
    except Exception as error:
        print("Nexus Assets: Houdini bridge could not start:", error)
