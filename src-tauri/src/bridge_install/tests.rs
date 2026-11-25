use super::*;

#[test]
fn managed_files_are_updated_only_if_previous_bytes_are_recognized() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("host-plugin");
    let runtime = directory.path().join("runtime");
    fs::create_dir_all(&root).unwrap();
    let plugin = root.join("bridge.py");
    let package = root.join("package.json");
    let target = InstallTarget::new(
        "max",
        "2026",
        &root,
        vec![
            InstallFile::managed("bridge.py", &b"# release one\n"[..]),
            InstallFile::managed("package.json", &b"{}\n"[..]),
        ],
        "restart",
    );
    let mut receipts = Receipts::new();

    fs::write(&package, b"unrelated plugin package").unwrap();
    assert!(install_target(&target, &mut receipts, &runtime).is_err());
    assert!(!plugin.exists());
    assert_eq!(fs::read(&package).unwrap(), b"unrelated plugin package");

    fs::write(&package, b"{}\n").unwrap();
    install_target(&target, &mut receipts, &runtime).unwrap();
    assert_eq!(read_receipts(&runtime).unwrap(), receipts);
    assert!(plan(&target, &receipts)
        .unwrap()
        .iter()
        .all(|change| change.before.as_ref() == Some(&change.after)));

    let update = InstallTarget::new(
        "max",
        "2026",
        &root,
        vec![InstallFile::managed("bridge.py", &b"# release two\n"[..])],
        "restart",
    );
    install_target(&update, &mut receipts, &runtime).unwrap();
    assert_eq!(fs::read(&plugin).unwrap(), b"# release two\n");
    assert_eq!(read_receipts(&runtime).unwrap(), receipts);

    fs::write(&plugin, b"externally modified").unwrap();
    assert!(install_target(&update, &mut receipts, &runtime).is_err());
    assert_eq!(fs::read(&plugin).unwrap(), b"externally modified");
}

#[test]
fn maya_block_preserves_unrelated_bytes_and_line_endings() {
    let original = b"# coding: latin-1\r\nlabel = 'caf\xe9'\r\n";
    let body = b"import os\nprint('plugin')\n";
    let first = startup_bytes(original, body).unwrap();
    assert!(first.starts_with(original));
    assert!(first
        .windows(b"import os\r\nprint('plugin')\r\n".len())
        .any(|window| window == b"import os\r\nprint('plugin')\r\n"));
    let suffix = b"# custom tool after the plugin\r\n";
    let with_suffix = [first.as_slice(), suffix].concat();
    assert_eq!(startup_bytes(&with_suffix, body).unwrap(), with_suffix);

    let changed = startup_bytes(&with_suffix, b"print('updated')\n").unwrap();
    assert!(changed.starts_with(original));
    assert!(changed.ends_with(suffix));
    assert_eq!(
        changed
            .windows(BLOCK_START.len())
            .filter(|window| *window == BLOCK_START)
            .count(),
        1
    );
}

#[test]
fn malformed_maya_markers_and_utf16_startup_are_rejected() {
    let duplicate = [BLOCK_START, b"\n", BLOCK_START, b"\n", BLOCK_END, b"\n"].concat();
    let incomplete = [BLOCK_START, b"\n", b"third_party()\n"].concat();
    let reversed = [BLOCK_END, b"\n", BLOCK_START, b"\n"].concat();
    for invalid in [
        duplicate.as_slice(),
        incomplete.as_slice(),
        reversed.as_slice(),
        b"\xff\xfeX\0",
    ] {
        assert!(startup_bytes(invalid, b"start_bridge()\n").is_err());
    }
}

#[test]
fn generated_python_path_literal_escapes_windows_and_unicode() {
    let path = Path::new(r#"C:\Users\资产📦\Connector "extra".py"#);
    let literal = python_literal(path);
    assert!(literal.is_ascii());
    assert_eq!(
        literal,
        r#""C:\\Users\\\U00008d44\U00004ea7\U0001f4e6\\Connector \"extra\".py""#
    );
}
