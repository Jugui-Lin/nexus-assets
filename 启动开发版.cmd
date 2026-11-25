@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\nexus-assets.exe" (
  start "" "src-tauri\target\release\nexus-assets.exe"
  exit /b
)
if exist "src-tauri\target\debug\nexus-assets.exe" (
  start "" "src-tauri\target\debug\nexus-assets.exe"
  exit /b
)
"%USERPROFILE%\.cargo\bin\cargo.exe" run --manifest-path src-tauri\Cargo.toml
pause
