use crate::{
    shell::{Scanner, cargo_action_compiles, working_dir},
    yaml::{Node, field, get, parse_with_merges, scalar, workflow_paths},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

const WORKFLOW: &str = "codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@";
const STRICT: &str = "codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@";
const SETUP: &str = "codeandsolder/ci-workflows/.github/actions/setup-sccache@";
const FINALIZE: &str = "codeandsolder/ci-workflows/.github/actions/finalize-sccache@";

fn external_ref<'a>(uses: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = uses.strip_prefix(prefix)?;
    Some(
        rest.split_once(" #")
            .map_or(rest, |(value, _)| value)
            .trim(),
    )
}

fn full_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn pinned(uses: &str, prefix: &str) -> bool {
    external_ref(uses, prefix).is_some_and(full_sha)
}

fn reusable_violation(uses: &str, strict_ref: Option<&str>) -> Option<String> {
    if uses.starts_with(WORKFLOW) && !pinned(uses, WORKFLOW) {
        return Some("shared Rust CI ref must be a full commit SHA".into());
    }
    if let Some(reference) = external_ref(uses, STRICT) {
        if !full_sha(reference) {
            return Some("strict Rust workflow ref must be a full commit SHA".into());
        }
        if let Some(expected) = strict_ref
            && reference != expected
        {
            let actual_short = reference.chars().take(12).collect::<String>();
            let expected_short = expected.chars().take(12).collect::<String>();
            return Some(format!(
                "strict Rust workflow uses {actual_short}, but the executing gate is {expected_short}"
            ));
        }
    }
    None
}

fn action_compiles(step: &Node<'_>) -> bool {
    let Some(uses) = field(step, "uses") else {
        return false;
    };
    let lower = uses.to_ascii_lowercase();
    if uses.starts_with("./") {
        return ["rust-strict", "cargo-build", "cargo-test", "clippy"]
            .iter()
            .any(|token| lower.contains(token));
    }
    if lower.starts_with("actions-rs/cargo@") {
        let args = get(step, "with");
        let command = args
            .and_then(|args| field(args, "command"))
            .unwrap_or_default();
        let flags = args
            .and_then(|args| field(args, "args"))
            .unwrap_or_default();
        return cargo_action_compiles(command, flags);
    }
    lower.starts_with("houseabsolute/actions-rust-cross@")
}

fn inspect_step(
    scanner: &Scanner,
    root: &Path,
    job: &Node<'_>,
    step: &Node<'_>,
) -> (bool, BTreeSet<String>) {
    let mut compiles = action_compiles(step);
    let Some(run) = field(step, "run") else {
        return (compiles, BTreeSet::new());
    };
    let default_dir = get(job, "defaults")
        .and_then(|defaults| get(defaults, "run"))
        .and_then(|run| get(run, "working-directory"));
    let cwd = get(step, "working-directory").or(default_dir).map_or_else(
        || Some(root.to_owned()),
        |value| scalar(value).and_then(|path| working_dir(root, path)),
    );
    // Even if the working directory is dynamic, still recognize inline
    // compiler commands, but cannot follow repository-relative scripts.
    let findings = scanner.inspect(run, root, cwd.as_deref());
    compiles |= findings.compiles;
    let unknown = if cwd.is_some() {
        findings.unresolved
    } else if !findings.unresolved.is_empty() || run.contains("./") || run.contains(".sh") {
        BTreeSet::from(["dynamic working-directory for shell script invocation".into()])
    } else {
        BTreeSet::new()
    };
    (compiles, unknown)
}

#[derive(Default)]
struct Lifecycle {
    first_rust: Option<usize>,
    last_rust: Option<usize>,
    first_setup: Option<usize>,
    finalizers: Vec<(usize, bool)>,
    unresolved: BTreeMap<usize, BTreeSet<String>>,
    legacy_cache: usize,
}

impl Lifecycle {
    fn record_step(
        &mut self,
        index: usize,
        step: &Node<'_>,
        compiles: bool,
        unknown: BTreeSet<String>,
    ) {
        if compiles || !unknown.is_empty() {
            self.first_rust.get_or_insert(index);
            self.last_rust = Some(index);
        }
        if !unknown.is_empty() {
            self.unresolved.insert(index, unknown);
        }
        if let Some(uses) = field(step, "uses") {
            if pinned(uses, SETUP) {
                self.first_setup.get_or_insert(index);
            }
            if pinned(uses, FINALIZE) {
                self.finalizers.push((
                    index,
                    field(step, "if").is_some_and(|value| value.trim() == "always()"),
                ));
            }
            self.legacy_cache += usize::from(
                uses.to_ascii_lowercase()
                    .starts_with("swatinem/rust-cache@"),
            );
        }
    }

    fn violations(self, label: &str, out: &mut Vec<String>) {
        for _ in 0..self.legacy_cache {
            out.push(format!(
                "{label}: Swatinem/rust-cache is forbidden; use canonical sccache"
            ));
        }
        if self.first_setup.is_none() {
            for (index, unknowns) in self.unresolved {
                for reason in unknowns {
                    out.push(format!(
                        "{label}: step {index}: {reason}; canonical sccache required"
                    ));
                }
            }
        }
        let (Some(first), Some(last)) = (self.first_rust, self.last_rust) else {
            return;
        };
        match self.first_setup {
            None => out.push(format!(
                "{label}: Rust job is missing canonical setup-sccache"
            )),
            Some(setup) if setup > first => {
                out.push(format!("{label}: setup-sccache runs after Rust tooling"));
            }
            Some(_) => (),
        }
        match self.finalizers.last() {
            None => out.push(format!(
                "{label}: Rust job is missing canonical finalize-sccache"
            )),
            Some((index, _)) if *index < last => out.push(format!(
                "{label}: finalize-sccache runs before the last Rust tooling step"
            )),
            Some(_) => {
                for (_, always) in self.finalizers {
                    if !always {
                        out.push(format!("{label}: finalize-sccache must use if: always()"));
                    }
                }
            }
        }
    }
}

fn inspect_job(
    scanner: &Scanner,
    root: &Path,
    label: &str,
    job: &Node<'_>,
    strict_ref: Option<&str>,
    out: &mut Vec<String>,
) {
    if let Some(uses) = field(job, "uses") {
        if let Some(problem) = reusable_violation(uses, strict_ref) {
            out.push(format!("{label}: {problem}"));
        }
        return;
    }
    let Some(steps) = get(job, "steps").and_then(Node::as_vec) else {
        return;
    };
    let mut lifecycle = Lifecycle::default();
    for (index, step) in steps.iter().enumerate() {
        if step.as_mapping().is_some() {
            let (compiles, unknown) = inspect_step(scanner, root, job, step);
            lifecycle.record_step(index, step, compiles, unknown);
        }
    }
    lifecycle.violations(label, out);
}

pub fn inspect(
    root: &Path,
    strict_ref: Option<&str>,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let scanner = Scanner::new()?;
    let mut violations = Vec::new();
    for path in workflow_paths(root)? {
        let relative = path.strip_prefix(root)?.display();
        let source = fs::read_to_string(&path)?;
        let doc = match parse_with_merges(&source) {
            Ok(doc) => doc,
            Err(error) => {
                violations.push(format!("{relative}: invalid YAML: {error}"));
                continue;
            }
        };
        let Some(jobs) = get(&doc, "jobs").and_then(Node::as_mapping) else {
            continue;
        };
        for (name, job) in jobs {
            if let Some(name) = scalar(name)
                && job.as_mapping().is_some()
            {
                inspect_job(
                    &scanner,
                    root,
                    &format!("{relative}:{name}"),
                    job,
                    strict_ref,
                    &mut violations,
                );
            }
        }
    }
    Ok(violations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_refs() {
        assert!(full_sha(&"a".repeat(40)));
        assert!(!full_sha(&"A".repeat(40)));
        assert!(
            reusable_violation(
                &format!("{STRICT}{}", "a".repeat(40)),
                Some(&"b".repeat(40))
            )
            .is_some()
        );
        assert_eq!(
            reusable_violation(&format!("{WORKFLOW}{}", "a".repeat(40)), None),
            None
        );
    }

    #[test]
    fn command_discovery() -> Result<(), regex::Error> {
        let scanner = Scanner::new()?;
        let root = Path::new("/workspace");
        assert!(
            scanner
                .inspect("env MODE=build cargo +nightly test", root, Some(root))
                .compiles
        );
        assert!(
            !scanner
                .inspect("cargo fmt; cargo metadata", root, Some(root))
                .compiles
        );
        assert!(
            scanner
                .inspect("bash <<'EOF'\ncargo build\nEOF", root, Some(root))
                .compiles
        );
        assert!(
            !scanner
                .inspect("cat <<'EOF'\ncargo build\nEOF", root, Some(root))
                .compiles
        );
        Ok(())
    }
}
