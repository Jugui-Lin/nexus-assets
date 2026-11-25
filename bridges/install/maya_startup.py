def _nexus_assets_start_maya():
    import runpy
    import maya.cmds

    if maya.cmds.about(batch=True):
        return
    try:
        runpy.run_path(__NEXUS_RUNTIME_PATH__)["connect"]("maya")
    except Exception as error:
        print("Nexus Assets: Maya bridge could not start:", error)


try:
    import maya.utils as _nexus_assets_maya_utils
    _nexus_assets_maya_utils.executeDeferred(_nexus_assets_start_maya)
except Exception as _nexus_assets_error:
    print("Nexus Assets: Unable to defer Maya bridge:", _nexus_assets_error)
