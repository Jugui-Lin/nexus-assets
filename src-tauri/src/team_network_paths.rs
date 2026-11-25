use nexus_core::team::relative_path;
use reqwest::Url;
use std::path::Path;

const MAX_UNC_LENGTH: usize = 4096;

#[derive(Clone, Debug)]
pub(super) struct UncDirectory {
    host: String,
    components: Vec<String>,
}

impl UncDirectory {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        if raw.len() > MAX_UNC_LENGTH {
            return None;
        }
        let path = raw.replace('/', "\\");
        let rest = if path
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\"))
        {
            &path[8..]
        } else {
            path.strip_prefix("\\\\")?
        };
        let (host, tail) = rest.split_once('\\')?;
        if host.is_empty()
            || host == "."
            || host == ".."
            || host.len() > 253
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return None;
        }
        let logical = tail.trim_end_matches('\\').replace('\\', "/");
        relative_path(&logical)?;
        let components = logical.split('/').map(str::to_owned).collect::<Vec<_>>();
        let share = components.first()?;
        let drive_share =
            share.len() == 2 && share.as_bytes()[0].is_ascii_alphabetic() && share.ends_with('$');
        if components.iter().any(|part| part.starts_with('.'))
            || drive_share
            || ["ADMIN$", "IPC$", "PRINT$"]
                .iter()
                .any(|name| share.eq_ignore_ascii_case(name))
        {
            return None;
        }
        Some(Self {
            host: host.to_owned(),
            components,
        })
    }

    pub(super) fn relative_to(&self, root: &Self) -> Option<String> {
        if !self.host.eq_ignore_ascii_case(&root.host)
            || self.components.len() < root.components.len()
            || !self
                .components
                .iter()
                .zip(&root.components)
                .all(|(left, right)| left.to_lowercase() == right.to_lowercase())
        {
            return None;
        }
        Some(self.components[root.components.len()..].join("/"))
    }

    pub(super) fn text(&self) -> String {
        format!("\\\\{}\\{}", self.host, self.components.join("\\"))
    }

    pub(super) fn trusted(
        &self,
        url: &str,
        manual_mounts: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> bool {
        let endpoint = Url::parse(url).ok();
        endpoint
            .as_ref()
            .and_then(Url::host_str)
            .is_some_and(|host| host.eq_ignore_ascii_case(&self.host))
            || manual_mounts
                .into_iter()
                .filter_map(|mount| Self::parse(mount.as_ref()))
                .any(|mount| mount.host.eq_ignore_ascii_case(&self.host))
    }
}

pub(super) fn folder_unc(path: &Path) -> Option<UncDirectory> {
    UncDirectory::parse(path.to_str()?).or_else(|| mapped_drive_unc(path))
}

#[cfg(windows)]
fn mapped_drive_unc(path: &Path) -> Option<UncDirectory> {
    use std::path::{Component, Prefix};
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS},
            NetworkManagement::WNet::WNetGetConnectionW,
        },
    };

    if !path.is_absolute() {
        return None;
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return None;
    };
    let drive = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        _ => return None,
    };
    if components.next() != Some(Component::RootDir) {
        return None;
    }
    let local = [u16::from(drive), u16::from(b':'), 0];
    let mut result = vec![0; 1024];
    let remote = loop {
        let mut size = result.len() as u32;
        // The remote buffer is valid and writable for the requested UTF-16 length.
        let status = unsafe {
            WNetGetConnectionW(
                PCWSTR(local.as_ptr()),
                Some(PWSTR(result.as_mut_ptr())),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => {
                let end = result.iter().position(|ch| *ch == 0)?;
                break String::from_utf16(&result[..end]).ok()?;
            }
            ERROR_MORE_DATA if size as usize > result.len() && size as usize <= MAX_UNC_LENGTH => {
                result.resize(size as usize, 0)
            }
            _ => return None,
        }
    };
    let mut unc = UncDirectory::parse(&remote)?.text();
    for part in components {
        let Component::Normal(part) = part else {
            return None;
        };
        unc.push('\\');
        unc.push_str(part.to_str()?);
    }
    UncDirectory::parse(&unc)
}

#[cfg(not(windows))]
fn mapped_drive_unc(_path: &Path) -> Option<UncDirectory> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_ordinary_unc_ancestry_and_explicit_nas_host_trust() {
        let root = UncDirectory::parse(r"\\192.0.2.10\StudioShare\Assets").unwrap();
        let child =
            UncDirectory::parse(r"\\?\UNC\192.0.2.10\studioshare\assets\预览图").unwrap();
        assert_eq!(child.relative_to(&root).as_deref(), Some("预览图"));
        assert!(child.trusted("http://192.0.2.10:47822", std::iter::empty::<&str>()));
        assert!(child.trusted("https://workspace.example", [root.text()]));
        assert!(!child.trusted("https://workspace.example", [r"\\192.168.0.107\team"]));
        assert!(UncDirectory::parse(r"\\192.0.2.10\StudioShare\..\private").is_none());
        assert!(UncDirectory::parse(r"\\192.0.2.10\ADMIN$\config").is_none());
        assert!(UncDirectory::parse(r"\\192.0.2.10\StudioShare\.nexus").is_none());
    }
}
