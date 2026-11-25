use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

pub(crate) fn workspace_data_directory(
    root: &Path,
    components: &[&str],
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let path_error = |error| format!("无法访问工作空间数据目录：{error}");
    let root = fs::canonicalize(root).map_err(path_error)?;
    let mut directory = root.clone();
    for component in components {
        let path = Path::new(component);
        let mut parts = path.components();
        if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
            return Err("工作空间数据目录名称无效".into());
        }
        directory.push(path);
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                match fs::create_dir(&directory) {
                    Ok(()) => (),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
                    Err(error) => return Err(path_error(error)),
                }
                fs::symlink_metadata(&directory).map_err(path_error)?
            }
            Err(error) => return Err(path_error(error)),
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("工作空间数据目录不能通过链接指向其他位置".into());
            }
        }
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("工作空间数据位置必须是实际目录".into());
        }
        directory = fs::canonicalize(&directory).map_err(path_error)?;
        if directory == root || !directory.starts_with(&root) {
            return Err("目标位置超出工作空间的数据目录".into());
        }
    }
    Ok(Some(directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_data_directory_is_created_only_for_writes_and_rejects_conflicts() {
        let mount = tempfile::tempdir().unwrap();
        let components = [".nexus", "thumbnail-cache", "team-library"];
        let resolve = |create| workspace_data_directory(mount.path(), &components, create);
        assert!(resolve(false).unwrap().is_none());
        assert!(!mount.path().join(".nexus").exists());
        assert!(workspace_data_directory(mount.path(), &[".."], true).is_err());

        let conflict = mount.path().join(".nexus");
        fs::write(&conflict, b"existing file").unwrap();
        assert!(resolve(true).is_err());
        assert_eq!(fs::read(&conflict).unwrap(), b"existing file");
        fs::remove_file(&conflict).unwrap();

        let created = resolve(true).unwrap().unwrap();
        assert!(created.starts_with(fs::canonicalize(mount.path()).unwrap()));
        assert_eq!(resolve(false).unwrap(), Some(created));
    }
}
