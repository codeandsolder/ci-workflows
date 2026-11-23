use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    io::{self, Read},
};

#[derive(Deserialize)]
struct Metadata {
    workspace_root: String,
    workspace_members: Vec<String>,
    packages: Vec<Package>,
}

#[derive(Deserialize)]
struct Package {
    id: String,
    name: String,
    manifest_path: String,
    dependencies: Vec<Dependency>,
}

#[derive(Deserialize)]
struct Dependency {
    path: Option<String>,
}

#[derive(Deserialize)]
struct Policy {
    #[serde(default)]
    full_paths: Vec<String>,
    #[serde(default)]
    full_prefixes: Vec<String>,
    #[serde(default)]
    ignored_paths: Vec<String>,
    #[serde(default)]
    ignored_prefixes: Vec<String>,
    #[serde(default)]
    triggers: Vec<Trigger>,
    matrices: Matrices,
}

#[derive(Deserialize)]
struct Trigger {
    flag: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    packages: Vec<String>,
}

#[derive(Deserialize)]
struct Matrices {
    full: Value,
    partial: Value,
}

#[derive(Deserialize)]
struct PlanInput {
    event: String,
    changed: Vec<String>,
    metadata: Metadata,
    policy: Policy,
}

#[derive(Serialize, Debug, PartialEq)]
struct Plan {
    affected_packages: Vec<String>,
    has_code: bool,
    run_full: bool,
    extra_flags: BTreeMap<String, bool>,
    test_matrix: Value,
    reason: String,
}

#[derive(Deserialize)]
struct CommandInput {
    packages: Vec<String>,
    command: Vec<String>,
}

fn normalized(raw: &str) -> Result<String, Box<dyn Error>> {
    if raw.contains('\0') {
        return Err("path contains NUL".into());
    }
    let raw = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("path escapes root: {raw}").into());
                }
            }
            other => parts.push(other),
        }
    }
    Ok(parts.join("/"))
}

fn within(prefix: &str, path: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn relative(root: &str, path: &str) -> Result<String, Box<dyn Error>> {
    let root = normalized(root)?;
    let path = normalized(path)?;
    if path == root {
        return Ok(String::new());
    }
    Ok(path
        .strip_prefix(&format!("{root}/"))
        .ok_or_else(|| format!("Cargo metadata path outside workspace: {path}"))?
        .to_owned())
}

fn path_match(path: &str, files: &[String], prefixes: &[String]) -> Result<bool, Box<dyn Error>> {
    for file in files {
        if path == normalized(file)? {
            return Ok(true);
        }
    }
    for prefix in prefixes {
        let prefix = normalized(prefix)?;
        if within(&prefix, path) {
            return Ok(true);
        }
    }
    Ok(false)
}

type Reverse = BTreeMap<String, BTreeSet<String>>;
type Roots = Vec<(String, String)>;

fn graph(meta: &Metadata) -> Result<(Roots, Reverse), Box<dyn Error>> {
    let members: BTreeSet<_> = meta.workspace_members.iter().collect();
    let mut roots = Vec::new();
    let mut named = BTreeMap::new();
    let mut reverse = Reverse::new();
    for pkg in meta.packages.iter().filter(|pkg| members.contains(&pkg.id)) {
        let path = relative(&meta.workspace_root, &pkg.manifest_path)?;
        let directory = path
            .strip_suffix("/Cargo.toml")
            .or_else(|| (path == "Cargo.toml").then_some(""))
            .ok_or_else(|| format!("not a Cargo.toml manifest: {path}"))?;
        if named
            .insert(
                normalized(&pkg.manifest_path)?
                    .trim_end_matches("/Cargo.toml")
                    .to_owned(),
                pkg.name.clone(),
            )
            .is_some()
        {
            return Err(format!("duplicate manifest: {}", pkg.manifest_path).into());
        }
        if reverse.insert(pkg.name.clone(), BTreeSet::new()).is_some() {
            return Err(format!("duplicate workspace package: {}", pkg.name).into());
        }
        roots.push((directory.to_owned(), pkg.name.clone()));
    }
    if roots.len() != members.len() {
        return Err("cargo metadata did not include every workspace member".into());
    }
    for pkg in meta.packages.iter().filter(|pkg| members.contains(&pkg.id)) {
        for dep in &pkg.dependencies {
            if let Some(root) = &dep.path
                && let Some(name) = named.get(&normalized(root)?)
            {
                reverse
                    .get_mut(name)
                    .ok_or("missing workspace dependency")?
                    .insert(pkg.name.clone());
            }
        }
    }
    // Prefer the deepest matching workspace member (nested crates).
    roots.sort_by_key(|left| std::cmp::Reverse(left.0.len()));
    Ok((roots, reverse))
}

fn dependents(
    mut selected: BTreeSet<String>,
    graph: &Reverse,
) -> Result<Vec<String>, Box<dyn Error>> {
    let mut pending: Vec<_> = selected.iter().cloned().collect();
    while let Some(name) = pending.pop() {
        for downstream in graph
            .get(&name)
            .ok_or_else(|| format!("unknown affected package: {name}"))?
        {
            if selected.insert(downstream.clone()) {
                pending.push(downstream.clone());
            }
        }
    }
    Ok(selected.into_iter().collect())
}

fn plan(input: PlanInput) -> Result<Plan, Box<dyn Error>> {
    let (roots, graph) = graph(&input.metadata)?;
    let all: Vec<_> = graph.keys().cloned().collect();
    let mut flags = BTreeMap::new();
    for trigger in &input.policy.triggers {
        if flags
            .insert(trigger.flag.clone(), input.event != "pull_request")
            .is_some()
        {
            return Err(format!("duplicate trigger flag: {}", trigger.flag).into());
        }
        for name in &trigger.packages {
            if !graph.contains_key(name) {
                return Err(
                    format!("trigger {} refers to unknown package {name}", trigger.flag).into(),
                );
            }
        }
    }

    if input.event != "pull_request" {
        return Ok(Plan {
            affected_packages: all.clone(),
            has_code: !all.is_empty(),
            run_full: true,
            extra_flags: flags,
            test_matrix: input.policy.matrices.full,
            reason: format!("Triggered by {}", input.event.replace('_', " ")),
        });
    }

    let mut selected = BTreeSet::new();
    let mut full_reason = None;
    for raw in &input.changed {
        // Git -z paths use forward slashes on every host. On Unix a
        // backslash may be part of a literal filename, not a separator.
        if raw.contains('\\') {
            full_reason.get_or_insert_with(|| format!("Non-portable Git path changed: {raw}"));
            continue;
        }
        let path = normalized(raw)?;
        if path_match(&path, &input.policy.full_paths, &input.policy.full_prefixes)? {
            full_reason = Some(format!("Workspace file changed: {path}"));
        }
        let mut mapped = if let Some((_, name)) = roots
            .iter()
            .find(|(root, _)| root.is_empty() || within(root, &path))
        {
            selected.insert(name.clone());
            true
        } else {
            false
        };
        for trigger in &input.policy.triggers {
            if path_match(&path, &trigger.paths, &trigger.prefixes)? {
                flags.insert(trigger.flag.clone(), true);
                selected.extend(trigger.packages.iter().cloned());
                mapped = true;
            }
        }
        if !mapped
            && !path_match(
                &path,
                &input.policy.ignored_paths,
                &input.policy.ignored_prefixes,
            )?
            && full_reason.is_none()
        {
            // Unknown shared inputs may affect build scripts or include_*.
            full_reason = Some(format!("Unmapped file changed: {path}"));
        }
    }
    let run_full = full_reason.is_some();
    let affected_packages = if run_full {
        all
    } else {
        dependents(selected, &graph)?
    };
    let has_code = !affected_packages.is_empty();
    Ok(Plan {
        affected_packages,
        has_code,
        run_full,
        extra_flags: flags,
        test_matrix: if run_full {
            input.policy.matrices.full
        } else {
            input.policy.matrices.partial
        },
        reason: full_reason.unwrap_or_else(|| "Changed packages and their dependents".to_owned()),
    })
}

fn command(input: CommandInput) -> Result<Vec<String>, Box<dyn Error>> {
    if input.packages.is_empty() {
        return Err("affected package list must not be empty".into());
    }
    for name in &input.packages {
        if name.starts_with('-')
            || name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(format!("invalid Cargo package name: {name}").into());
        }
    }
    if input.command.first().is_none_or(|first| first != "cargo") {
        return Err("affected commands must start with cargo".into());
    }
    let insert = match input.command.get(1).map(String::as_str) {
        Some("build" | "check" | "clippy" | "test") => 2,
        Some("nextest") if input.command.get(2).is_some_and(|s| s == "run") => 3,
        Some("ndk") => input
            .command
            .iter()
            .enumerate()
            .skip(2)
            .find(|(_, item)| *item == "build")
            .map(|(index, _)| index + 1)
            .ok_or("cargo ndk requires a build subcommand")?,
        _ => return Err("unsupported Cargo command".into()),
    };
    let mut args = input.command;
    let packages: Vec<_> = input
        .packages
        .into_iter()
        .flat_map(|pkg| ["-p".to_owned(), pkg])
        .collect();
    args.splice(insert..insert, packages);
    Ok(args)
}

pub fn decide(mode: &str) -> Result<(), Box<dyn Error>> {
    let mut json = String::new();
    io::stdin().read_to_string(&mut json)?;
    match mode {
        "cargo-affected-plan" => {
            let output = plan(serde_json::from_str(&json)?)?;
            serde_json::to_writer(io::stdout().lock(), &output)?;
        }
        "cargo-affected-args" => {
            let output = command(serde_json::from_str(&json)?)?;
            serde_json::to_writer(io::stdout().lock(), &output)?;
        }
        _ => return Err("unknown Cargo affected operation".into()),
    }
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CommandInput, PlanInput, command, plan};
    use serde_json::json;
    use std::error::Error;

    fn fixture(event: &str, changed: &[&str]) -> Result<PlanInput, serde_json::Error> {
        serde_json::from_value(json!({
            "event": event,
            "changed": changed,
            "metadata": {
                "workspace_root": "/repo",
                "workspace_members": ["a", "b", "c"],
                "packages": [
                    {"id": "a", "name": "alpha", "manifest_path": "/repo/crates/alpha/Cargo.toml", "dependencies": []},
                    {"id": "b", "name": "beta", "manifest_path": "/repo/crates/beta/Cargo.toml", "dependencies": [{"path": "/repo/crates/alpha"}]},
                    {"id": "c", "name": "gamma", "manifest_path": "/repo/crates/gamma/Cargo.toml", "dependencies": [{"path": "/repo/crates/beta"}]}
                ]
            },
            "policy": {
                "full_paths": ["Cargo.toml", "Cargo.lock"],
                "full_prefixes": [".cargo"],
                "ignored_paths": ["README.md"],
                "ignored_prefixes": ["docs"],
                "triggers": [{
                    "flag": "check_schema",
                    "prefixes": ["schema"],
                    "packages": ["beta"]
                }],
                "matrices": {
                    "full": {"include": [{"os": "all"}]},
                    "partial": {"include": [{"os": "linux"}]}
                }
            }
        }))
    }

    #[test]
    fn dependency_closure_and_precise_selection() -> Result<(), Box<dyn Error>> {
        let decision = plan(fixture("pull_request", &["crates/alpha/src/lib.rs"])?)?;
        assert_eq!(decision.affected_packages, ["alpha", "beta", "gamma"]);
        assert!(!decision.run_full);
        assert!(!decision.extra_flags["check_schema"]);
        Ok(())
    }

    #[test]
    fn trigger_does_not_force_unrelated_workspace() -> Result<(), Box<dyn Error>> {
        let result = plan(fixture("pull_request", &["schema/v1.wit"])?)?;
        assert_eq!(result.affected_packages, ["beta", "gamma"]);
        assert!(!result.run_full);
        assert!(result.extra_flags["check_schema"]);
        Ok(())
    }

    #[test]
    fn ignore_only_skips_jobs() -> Result<(), Box<dyn Error>> {
        let result = plan(fixture("pull_request", &["docs/foo.md", "README.md"])?)?;
        assert!(!result.has_code);
        assert_eq!(result.affected_packages, Vec::<String>::new());
        Ok(())
    }

    #[test]
    fn unknown_or_global_inputs_fail_closed() -> Result<(), Box<dyn Error>> {
        for path in [
            "build.rs",
            ".cargo/config.toml",
            "Cargo.lock",
            r"README.md\..\crates/alpha/src/lib.rs",
        ] {
            let result = plan(fixture("pull_request", &[path])?)?;
            assert!(result.run_full, "{path}");
            assert_eq!(result.affected_packages.len(), 3);
        }
        Ok(())
    }

    #[test]
    fn non_pr_runs_all_and_enables_triggers() -> Result<(), Box<dyn Error>> {
        let result = plan(fixture("workflow_dispatch", &[])?)?;
        assert!(result.run_full);
        assert!(result.extra_flags["check_schema"]);
        assert_eq!(result.test_matrix, json!({"include":[{"os":"all"}]}));
        Ok(())
    }

    #[test]
    fn windows_paths_and_prefix_boundaries() -> Result<(), Box<dyn Error>> {
        let mut fixture = fixture("pull_request", &["crates/alphabeta/src/lib.rs"])?;
        fixture.metadata.workspace_root = r"C:\ci\repo".to_owned();
        for pkg in &mut fixture.metadata.packages {
            pkg.manifest_path = pkg.manifest_path.replace("/repo/", r"C:\ci\repo\");
            for dep in &mut pkg.dependencies {
                dep.path = dep
                    .path
                    .as_ref()
                    .map(|p| p.replace("/repo/", r"C:\ci\repo\"));
            }
        }
        assert!(plan(fixture)?.run_full);
        Ok(())
    }

    #[test]
    fn cargo_command_selection_and_injection_rejection() -> Result<(), Box<dyn Error>> {
        let cases: &[(&[&str], usize)] = &[
            (&["cargo", "clippy", "--all-targets"], 2),
            (&["cargo", "nextest", "run", "--verbose"], 3),
            (&["cargo", "ndk", "-t", "arm64-v8a", "build", "--locked"], 5),
        ];
        for (args, at) in cases {
            let result = command(CommandInput {
                packages: vec!["alpha".to_owned(), "beta".to_owned()],
                command: args.iter().map(|s| (*s).to_owned()).collect(),
            })?;
            assert_eq!(&result[*at..*at + 4], ["-p", "alpha", "-p", "beta"]);
        }
        assert!(
            command(CommandInput {
                packages: vec!["--workspace".to_owned()],
                command: vec!["cargo".to_owned(), "test".to_owned()],
            })
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn rejects_workspace_members_omitted_from_metadata() -> Result<(), Box<dyn Error>> {
        // Build an invalid fixture without relying on serde Serialize for input types.
        let data = json!({
            "event": "pull_request", "changed": [],
            "metadata": {
                "workspace_root": "/repo", "workspace_members": ["a"],
                "packages": []
            },
            "policy": {
                "matrices": {"full": {}, "partial": {}}
            }
        });
        assert!(plan(serde_json::from_value(data)?).is_err());
        Ok(())
    }
}
