import runpy

try:
    runpy.run_path(__NEXUS_RUNTIME_PATH__)["connect"]("max")
except Exception as error:
    print("Nexus Assets: 3ds Max bridge could not start:", error)
