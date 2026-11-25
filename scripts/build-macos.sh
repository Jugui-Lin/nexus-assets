#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Run on macOS with Xcode Command Line Tools and Rust installed.
cargo install tauri-cli --version '^2' --locked
cd src-tauri
cargo tauri build --bundles app,dmg
