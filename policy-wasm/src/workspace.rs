//! Portable workspace metadata boundary. Guest paths are normalized to the
//! checkout mounted at /workspace; the host alone resolves host filesystem
//! identities. No policy decisions are made in the adapter.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
    Missing,
    Other,
}

#[derive(Debug)]
pub struct Resolved {
    pub path: PathBuf,
    pub kind: Kind,
}

#[cfg(target_os = "wasi")]
mod host {
    #[link(wasm_import_module = "ci_workspace")]
    unsafe extern "C" {
        fn resolve_path(
            path: *const u8,
            path_len: usize,
            output: *mut u8,
            output_len: usize,
        ) -> i32;
    }

    pub fn lookup(path: &str) -> Option<Vec<u8>> {
        // SAFETY: The input points to a live immutable string. The empty
        // output buffer (zero length) requests only the required size.
        let size = unsafe { resolve_path(path.as_ptr(), path.len(), std::ptr::null_mut(), 0) };
        let size = usize::try_from(size).ok()?;
        if size == 0 {
            return None;
        }
        let mut result = vec![0; size];
        // SAFETY: Both buffers are valid for the declared lengths and do
        // not alias. The host import checks the guest memory bounds.
        let written =
            unsafe { resolve_path(path.as_ptr(), path.len(), result.as_mut_ptr(), result.len()) };
        (usize::try_from(written).ok() == Some(size)).then_some(result)
    }
}

#[cfg(target_os = "wasi")]
fn lookup(root: &Path, candidate: &Path) -> Option<Resolved> {
    let bytes = host::lookup(candidate.to_str()?)?;
    let (&kind, path) = bytes.split_first()?;
    let kind = match kind {
        b'f' => Kind::File,
        b'd' => Kind::Directory,
        b'm' => Kind::Missing,
        b'o' => Kind::Other,
        _ => return None,
    };
    let path = PathBuf::from(std::str::from_utf8(path).ok()?);
    path.starts_with(root).then_some(Resolved { path, kind })
}

#[cfg(not(target_os = "wasi"))]
fn lookup(root: &Path, candidate: &Path) -> Option<Resolved> {
    use std::{fs, path::Component};

    let relative = candidate.strip_prefix(root).ok()?;
    let mut current = root.to_owned();
    let mut pending: Vec<_> = relative
        .components()
        .map(|component| component.as_os_str().to_owned())
        .rev()
        .collect();
    let mut links = 0;
    while let Some(part) = pending.pop() {
        match Path::new(&part).components().next()? {
            Component::CurDir => (),
            Component::ParentDir => {
                if current == root || !current.pop() {
                    return None;
                }
            }
            Component::Normal(name) => {
                let next = current.join(name);
                if let Ok(target) = fs::read_link(&next) {
                    links += 1;
                    if links > 40 {
                        return None;
                    }
                    let target = if target.is_absolute() {
                        root.clone_into(&mut current);
                        target.strip_prefix(root).ok()?.to_owned()
                    } else {
                        target
                    };
                    pending.extend(target.components().rev().map(|c| c.as_os_str().to_owned()));
                } else {
                    if fs::symlink_metadata(&next)
                        .is_ok_and(|metadata| metadata.file_type().is_symlink())
                    {
                        return None;
                    }
                    current = next;
                }
            }
            _ => return None,
        }
    }
    let kind = match current.metadata() {
        Ok(metadata) if metadata.is_file() => Kind::File,
        Ok(metadata) if metadata.is_dir() => Kind::Directory,
        Ok(_) => Kind::Other,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Kind::Missing,
        Err(_) => return None,
    };
    Some(Resolved {
        path: current,
        kind,
    })
}

pub fn resolve(root: &Path, cwd: Option<&Path>, value: &str) -> Option<Resolved> {
    let path = Path::new(value);
    let candidate = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd?.join(path)
    };
    lookup(root, &candidate)
}
