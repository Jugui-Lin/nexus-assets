$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$cargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
& $cargo build --release --bins --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
Write-Output 'Built: src-tauri/target/release/nexus-assets.exe, src-tauri/target/release/nexus-team.exe'
