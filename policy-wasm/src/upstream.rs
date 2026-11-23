//! Resolve the strict Rust gate from the reviewed target-branch workflow files.
//! The upstream candidate never chooses the policy revision or its inputs.
use crate::yaml::{Node, field, get, parse_with_merges, scalar};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const STRICT_WORKFLOW: &str = "codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Gate {
    workflow: String,
    job: String,
    cargo_args: String,
    working_directory: String,
    rust_toolchain: String,
    rust_targets: String,
    apt_packages: String,
    checkout_submodules: String,
    python_ci_paths: String,
    ban_python_outside_ci: String,
    allow_test_panics: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    ref_sha: String,
    jobs: Vec<Gate>,
}

fn option(job: &Node<'_>, key: &str, default: &str) -> Result<String, String> {
    let Some(with) = get(job, "with") else {
        return Ok(default.to_owned());
    };
    let Some(value) = get(with, key) else {
        return Ok(default.to_owned());
    };
    let value = scalar(value).ok_or_else(|| format!("strict {key} must be a scalar"))?;
    // Runner expressions must be resolved by the reviewed caller itself, not
    // guessed in a detached upstream candidate.
    if value.contains('$') {
        return Err(format!(
            "dynamic strict {key} is not valid for automatic upstream promotion"
        ));
    }
    Ok(value.to_owned())
}

fn bool_option(job: &Node<'_>, key: &str, default: &str) -> Result<String, String> {
    let value = option(job, key, default)?;
    if value != "true" && value != "false" {
        return Err(format!("strict {key} must be true or false"));
    }
    Ok(value)
}

fn gate(workflow: &str, name: &str, job: &Node<'_>) -> Result<Gate, String> {
    let allowed = [
        "cargo-args",
        "working-directory",
        "rust-toolchain",
        "rust-targets",
        "apt-packages",
        "checkout-submodules",
        "python-ci-paths",
        "ban-python-outside-ci",
        "allow-test-panics",
    ];
    if let Some(with) = get(job, "with") {
        let entries = with.as_mapping().ok_or("strict with must be a mapping")?;
        for (key, _) in entries {
            let name = scalar(key).ok_or("strict input name must be a scalar")?;
            if !allowed.contains(&name) {
                return Err(format!(
                    "unknown strict Rust input {workflow}:{name}; extend the reviewed-policy runner"
                ));
            }
        }
    }
    let checkout_submodules = option(job, "checkout-submodules", "false")?;
    if !["false", "true", "recursive"].contains(&checkout_submodules.as_str()) {
        return Err("strict checkout-submodules must be false, true, or recursive".into());
    }
    Ok(Gate {
        workflow: workflow.to_owned(),
        job: name.to_owned(),
        cargo_args: option(job, "cargo-args", "--locked --workspace --all-targets")?,
        working_directory: option(job, "working-directory", ".")?,
        rust_toolchain: option(job, "rust-toolchain", "")?,
        rust_targets: option(job, "rust-targets", "")?,
        apt_packages: option(job, "apt-packages", "")?,
        checkout_submodules,
        python_ci_paths: option(job, "python-ci-paths", "")?,
        ban_python_outside_ci: bool_option(job, "ban-python-outside-ci", "true")?,
        allow_test_panics: bool_option(job, "allow-test-panics", "false")?,
    })
}

fn reviewed_provider_default(
    provider_workflow: &str,
    provider_toolchain: &str,
) -> Result<(String, String), String> {
    // The provider's pinned strict workflow is the source of the default gate
    // revision. Its dynamic job inputs are irrelevant: this default uses the
    // canonical strict policy and a reviewed provider-native dated nightly.
    let doc = parse_with_merges(provider_workflow)
        .map_err(|error| format!("provider strict workflow: {error}"))?;
    let jobs = get(&doc, "jobs")
        .and_then(Node::as_mapping)
        .ok_or("provider strict workflow has no jobs")?;
    let mut refs = BTreeSet::new();
    for (_, job) in jobs {
        let Some(reference) =
            field(job, "uses").and_then(|uses| uses.strip_prefix(STRICT_WORKFLOW))
        else {
            continue;
        };
        if reference.len() != 40
            || !reference
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("provider strict gate must use an immutable commit SHA".into());
        }
        refs.insert(reference.to_owned());
    }
    let [ref_sha] = <[_; 1]>::try_from(refs.into_iter().collect::<Vec<_>>())
        .map_err(|_| "exactly one provider strict gate revision is required".to_owned())?;
    let manifest: toml::Value = toml::from_str(provider_toolchain)
        .map_err(|error| format!("provider toolchain: {error}"))?;
    let channel = manifest
        .get("toolchain")
        .and_then(|node| node.get("channel"))
        .and_then(toml::Value::as_str)
        .ok_or("provider toolchain has no channel")?;
    let parts = channel
        .strip_prefix("nightly-")
        .map(|date| date.split('-').collect::<Vec<_>>())
        .ok_or("provider strict toolchain is not a dated nightly")?;
    if parts.len() != 3
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || parts
            .iter()
            .any(|part| !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("provider strict toolchain is not a dated nightly".into());
    }
    Ok((ref_sha, channel.to_owned()))
}

fn provider_default_job(toolchain: String) -> Gate {
    Gate {
        workflow: "reviewed-provider-default".into(),
        job: "strict-rust".into(),
        cargo_args: "--locked --workspace --all-targets".into(),
        working_directory: ".".into(),
        rust_toolchain: toolchain,
        rust_targets: String::new(),
        apt_packages: String::new(),
        checkout_submodules: "false".into(),
        python_ci_paths: String::new(),
        ban_python_outside_ci: "true".into(),
        allow_test_panics: "false".into(),
    }
}

fn inspect<'a>(
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    provider: Option<(&str, &str)>,
) -> Result<Plan, String> {
    let mut refs = BTreeSet::new();
    let mut jobs = Vec::new();
    for (workflow, source) in sources {
        let doc = parse_with_merges(source).map_err(|error| format!("{workflow}: {error}"))?;
        let Some(items) = get(&doc, "jobs").and_then(Node::as_mapping) else {
            continue;
        };
        for (job_name, job) in items {
            let Some(reference) =
                field(job, "uses").and_then(|uses| uses.strip_prefix(STRICT_WORKFLOW))
            else {
                continue;
            };
            if reference.len() != 40
                || !reference
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(format!(
                    "{workflow}: strict gate must use an immutable commit SHA"
                ));
            }
            let job_name = scalar(job_name).ok_or("strict job name is not a scalar")?;
            refs.insert(reference.to_owned());
            jobs.push(gate(workflow, job_name, job)?);
        }
    }
    if jobs.is_empty() {
        let (workflow, toolchain) =
            provider.ok_or("no reviewed strict job and no provider-owned default")?;
        let (revision, nightly) = reviewed_provider_default(workflow, toolchain)?;
        refs.insert(revision);
        jobs.push(provider_default_job(nightly));
    }
    let [ref_sha] = <[_; 1]>::try_from(refs.into_iter().collect::<Vec<_>>())
        .map_err(|_| "exactly one reviewed rust-skills2 gate revision is required".to_owned())?;
    jobs.sort_by(|a, b| a.workflow.cmp(&b.workflow).then(a.job.cmp(&b.job)));
    Ok(Plan { ref_sha, jobs })
}

pub fn print_plan(root: &Path, paths: &[PathBuf]) -> Result<(), String> {
    let contents = paths
        .iter()
        .map(|path| {
            let source =
                fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
            Ok((path.to_string_lossy().into_owned(), source))
        })
        .collect::<Result<Vec<_>, String>>()?;
    // These files are copied from the immutable provider revision into the
    // reviewed target-base scratch directory. If the target already declares
    // strict jobs, its own reviewed settings take precedence.
    let provider_workflow = fs::read_to_string(root.join(".ci-provider-strict.yml")).ok();
    let provider_toolchain = fs::read_to_string(root.join(".ci-provider-toolchain.toml")).ok();
    let provider = provider_workflow
        .as_deref()
        .zip(provider_toolchain.as_deref());
    let plan = inspect(
        contents
            .iter()
            .map(|(path, source)| (path.as_str(), source.as_str())),
        provider,
    )?;
    println!(
        "{}",
        serde_json::to_string(&plan).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "e007c336924c41b4d8931aabd60fa1614967657c";

    #[test]
    fn reviewed_inputs_and_multiple_jobs() -> Result<(), String> {
        let document = format!(
            "jobs:\n  full:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      cargo-args: '--locked --workspace --all-targets'\n      allow-test-panics: true\n  tools:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      working-directory: tools\n      python-ci-paths: |\n        tools/ci\n        custom/ci\n"
        );
        let p = inspect([("strict.yml", document.as_str())], None)?;
        assert_eq!(p.ref_sha, HASH);
        assert_eq!(p.jobs.len(), 2);
        assert_eq!(p.jobs[0].allow_test_panics, "true");
        assert_eq!(p.jobs[1].working_directory, "tools");
        assert!(p.jobs[1].python_ci_paths.contains("custom/ci"));
        Ok(())
    }

    #[test]
    fn provider_owned_default_for_upstream_consumers_without_local_strict() -> Result<(), String> {
        let provider_workflow = format!(
            "jobs:\n  checked:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      rust-toolchain: __DOLLAR__{{{{ needs.pin.outputs.channel }}}}\n  other:\n    uses: {STRICT_WORKFLOW}{HASH}\n"
        ).replace("__DOLLAR__", "$");
        let provider_toolchain = "[toolchain]\nchannel = \"nightly-2026-11-19\"\n";
        let actual = inspect(
            [("consumer.yml", "jobs: {track: {runs-on: ubuntu-24.04}}")],
            Some((&provider_workflow, provider_toolchain)),
        )?;
        assert_eq!(actual.ref_sha, HASH);
        assert_eq!(actual.jobs.len(), 1);
        assert_eq!(
            actual.jobs[0].cargo_args,
            "--locked --workspace --all-targets"
        );
        assert_eq!(actual.jobs[0].rust_toolchain, "nightly-2026-11-19");
        assert_eq!(actual.jobs[0].ban_python_outside_ci, "true");
        assert_eq!(actual.jobs[0].workflow, "reviewed-provider-default");

        let invalid_provider = provider_workflow.replace(HASH, "main");
        assert!(
            inspect(
                [("consumer.yml", "jobs: {track: {runs-on: ubuntu-24.04}}")],
                Some((&invalid_provider, provider_toolchain)),
            )
            .is_err()
        );
        assert!(
            inspect(
                [("consumer.yml", "jobs: {track: {runs-on: ubuntu-24.04}}")],
                Some((&provider_workflow, "[toolchain]\nchannel = \"stable\"\n")),
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn cannot_omit_or_mutate_trust_root() {
        assert!(
            inspect(
                [("empty.yml", "jobs: {abc: {runs-on: ubuntu-latest}}")],
                None
            )
            .is_err()
        );
        let source = format!("jobs:\n  strict:\n    uses: {STRICT_WORKFLOW}main\n");
        assert!(inspect([("strict.yml", source.as_str())], None).is_err());
        let source = format!(
            "jobs:\n  strict:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      allow-test-panics: \"sometimes\"\n"
        );
        assert!(inspect([("strict.yml", source.as_str())], None).is_err());
    }

    #[test]
    fn do_not_guess_dynamic_settings_or_silently_ignore_inputs() {
        let expression = format!("{}{{{{ matrix.package }}}}", char::from(36));
        let source = format!(
            "jobs:\n  strict:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      cargo-args: \"{expression}\"\n"
        );
        assert!(inspect([("strict.yml", source.as_str())], None).is_err());
        let source = format!(
            "jobs:\n  strict:\n    uses: {STRICT_WORKFLOW}{HASH}\n    with:\n      unknown-parameter: hello\n"
        );
        assert!(inspect([("strict.yml", source.as_str())], None).is_err());
    }
}
