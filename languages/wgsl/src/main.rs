use naga::valid::{Capabilities, ValidationFlags, Validator};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path};
use std::process::ExitCode;

#[derive(Deserialize)]
struct Manifest {
    format: u32,
    wgsl: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Composition {
    format: u32,
    modules: Vec<Module>,
    negative_tests: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Module {
    name: String,
    sources: Vec<String>,
}

fn source_file(root: &Path, path: &str) -> Result<String, String> {
    let part = Path::new(path);
    if part.is_absolute()
        || !part
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe WGSL manifest path: {path}"));
    }
    let actual = root
        .join(part)
        .canonicalize()
        .map_err(|error| format!("{path}: {error}"))?;
    if !actual.starts_with(root) || !actual.is_file() {
        return Err(format!("WGSL source outside caller checkout: {path}"));
    }
    fs::read_to_string(actual).map_err(|error| format!("{path}: {error}"))
}

fn check_shader(source: &str) -> Result<(), String> {
    let module =
        naga::front::wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
    Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|error| error.emit_to_string(source))?;
    Ok(())
}

fn validate(root: &Path, manifest: &Manifest) -> Result<usize, String> {
    if manifest.format != 1 {
        return Err("unsupported source inventory format".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("invalid caller root: {error}"))?;
    let known = manifest.wgsl.iter().collect::<HashSet<_>>();
    if known.len() != manifest.wgsl.len() {
        return Err("duplicated WGSL file in source inventory".into());
    }

    let configuration = root.join(".github/wgsl-quality.json");
    let config = if configuration.exists() {
        let source = fs::read_to_string(configuration).map_err(|error| error.to_string())?;
        let parsed: Composition =
            serde_json::from_str(&source).map_err(|error| error.to_string())?;
        if parsed.format != 1 {
            return Err("unsupported WGSL composition format".into());
        }
        parsed
    } else {
        Composition {
            format: 1,
            modules: Vec::new(),
            negative_tests: Vec::new(),
        }
    };

    let mut covered = HashSet::new();
    let mut failures = 0;
    let mut validated = 0;
    for group in config.modules {
        if group.name.is_empty() || group.sources.is_empty() {
            return Err("WGSL module needs a non-empty name and sources".into());
        }
        let mut source = String::new();
        for path in group.sources {
            if !known.contains(&path) {
                return Err(format!(
                    "{} references untracked WGSL file: {path}",
                    group.name
                ));
            }
            source.push_str(&source_file(&root, &path)?);
            covered.insert(path);
        }
        if let Err(error) = check_shader(&source) {
            failures += 1;
            eprintln!("WGSL module {}:\n{error}", group.name);
        } else {
            validated += 1;
        }
    }
    for path in config.negative_tests {
        if !known.contains(&path) || !covered.insert(path.clone()) {
            return Err(format!(
                "negative WGSL fixture must be tracked and not grouped: {path}"
            ));
        }
        let source = source_file(&root, &path)?;
        if check_shader(&source).is_ok() {
            failures += 1;
            eprintln!("{path}: expected invalid WGSL fixture unexpectedly validated");
        } else {
            println!("{path}: expected-invalid WGSL fixture rejected");
        }
    }
    for path in &manifest.wgsl {
        if !covered.contains(path) {
            let source = source_file(&root, path)?;
            if let Err(error) = check_shader(&source) {
                failures += 1;
                eprintln!("{path}:\n{error}");
            } else {
                validated += 1;
            }
        }
    }
    if failures > 0 {
        Err(format!("{failures} WGSL module(s) failed validation"))
    } else {
        Ok(validated)
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let result = (|| {
        let root = args
            .next()
            .ok_or("usage: shared-ci-wgsl-quality ROOT MANIFEST")?;
        let manifest_path = args.next().ok_or("missing WGSL source manifest")?;
        if args.next().is_some() {
            return Err("unexpected WGSL validator argument".into());
        }
        let content = fs::read_to_string(manifest_path).map_err(|error| error.to_string())?;
        let manifest: Manifest =
            serde_json::from_str(&content).map_err(|error| error.to_string())?;
        let count = validate(Path::new(&root), &manifest)?;
        println!("Validated {count} WGSL shader module(s) with Naga 30.0.2");
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_compute_shader() {
        assert!(check_shader("@compute @workgroup_size(1) fn main() {}").is_ok());
    }

    #[test]
    fn rejects_invalid_shader_source() {
        assert!(check_shader("@compute fn main( {").is_err());
    }

    #[test]
    fn rejects_invalid_manifest_format() {
        let manifest = Manifest {
            format: 3,
            wgsl: Vec::new(),
        };
        assert!(validate(Path::new("."), &manifest).is_err());
    }

    #[test]
    fn rejects_traversal() {
        assert!(source_file(Path::new("/tmp"), "../outside.wgsl").is_err());
    }
}
