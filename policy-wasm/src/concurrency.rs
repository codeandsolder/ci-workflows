use crate::yaml::{Node, field, fields, get, parse, scalar};
use caseless::default_case_fold_str;
use regex::Regex;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const PR_EVENTS: [&str; 2] = ["pull_request", "pull_request_target"];
const COMMENT_EVENTS: [&str; 2] = ["issue_comment", "pull_request_review_comment"];
const FALLBACK: [&str; 4] = [
    "github.ref",
    "github.ref_name",
    "github.sha",
    "github.run_id",
];
const COMMENT_IDENTITIES: [&str; 3] = [
    "github.event.issue.number",
    "github.event.pull_request.number",
    "github.run_id",
];

struct Patterns {
    expression: Regex,
    quoted: Regex,
    reference: Regex,
    ref_name_condition: Regex,
    global_snapshot: Regex,
    host_identity: Regex,
    host_input: Regex,
    matrix: Regex,
}

impl Patterns {
    fn new() -> Result<Self, regex::Error> {
        Ok(Self {
            expression: Regex::new(r"(?s)\$\{\{\s*(.*?)\s*\}\}")?,
            quoted: Regex::new(r#"'[^']*'|"[^"]*""#)?,
            reference: Regex::new(r"github\.[A-Za-z_][A-Za-z0-9_.]*")?,
            ref_name_condition: Regex::new(r#"^github\.ref_name *!= *['"][^'"]+['"]$"#)?,
            global_snapshot: Regex::new(
                r"(?m)^# ci-workflow-supersession: global-snapshot; [^\r\n]{25,}\r?\nconcurrency:[ \t]*\r?$",
            )?,
            host_identity: Regex::new(r"(?i)acer|asus")?,
            host_input: Regex::new(r"/(?:home/jan|srv/ci/toolchains|srv/scratch)(?:/|\b)")?,
            matrix: Regex::new(r"\bmatrix\.([A-Za-z_][A-Za-z0-9_-]*)")?,
        })
    }

    fn references(&self, group: &str) -> BTreeSet<String> {
        let mut refs = BTreeSet::new();
        for body in self
            .expression
            .captures_iter(group)
            .filter_map(|m| m.get(1))
        {
            // Quoted contexts are not live identifiers. Preserve separators
            // to avoid joining tokens across string literals.
            let unquoted = self.quoted.replace_all(body.as_str(), " ");
            for reference in self.reference.find_iter(&unquoted) {
                if left_boundary(&unquoted, reference.start(), reference_char) {
                    refs.insert(reference.as_str().to_owned());
                }
            }
        }
        refs
    }

    fn physical_host(&self, selector: &str) -> bool {
        self.host_identity.find_iter(selector).any(|m| {
            left_boundary(selector, m.start(), label_char)
                && selector
                    .as_bytes()
                    .get(m.end())
                    .is_none_or(|&byte| !label_char(byte))
        })
    }

    fn local_path(&self, text: &str) -> bool {
        self.host_input
            .find_iter(text)
            .any(|m| left_boundary(text, m.start(), label_char))
    }

    fn cancels_all_prs(&self, value: Option<&str>, events: &BTreeSet<&str>) -> bool {
        let Some(value) = value else { return false };
        if value == "true" {
            return true;
        }
        let Some(expression) = value
            .trim()
            .strip_prefix("${{")
            .and_then(|s| s.strip_suffix("}}"))
        else {
            return false;
        };
        let expression = expression.trim();
        let expression = expression
            .strip_prefix('(')
            .and_then(|s| s.strip_suffix(')'))
            .map_or(expression, str::trim);
        let clauses: BTreeSet<_> = expression
            .split("||")
            .map(|clause| {
                clause
                    .trim()
                    .trim_matches(['(', ')', ' '])
                    .replace('"', "'")
            })
            .collect();
        let expected: BTreeSet<_> = events
            .iter()
            .map(|event| format!("github.event_name == '{event}'"))
            .collect();
        clauses == expected
            || (events.len() == 1
                && events.contains("pull_request")
                && self.ref_name_condition.is_match(expression))
    }
}

const fn reference_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.')
}
const fn label_char(byte: u8) -> bool {
    reference_char(byte) || byte == b'-'
}

fn left_boundary(text: &str, start: usize, predicate: impl Fn(u8) -> bool) -> bool {
    start
        .checked_sub(1)
        .and_then(|i| text.as_bytes().get(i))
        .is_none_or(|&byte| !predicate(byte))
}

fn triggers<'node, 'source>(
    doc: &'node Node<'source>,
) -> BTreeMap<&'node str, Option<&'node Node<'source>>> {
    let Some(value) = get(doc, "on") else {
        return BTreeMap::new();
    };
    if let Some(event) = scalar(value) {
        return BTreeMap::from([(event, None)]);
    }
    match value {
        Node::Sequence(events) => events
            .iter()
            .filter_map(scalar)
            .map(|name| (name, None))
            .collect(),
        Node::Mapping(events) => events
            .iter()
            .filter_map(|(event, settings)| scalar(event).map(|name| (name, Some(settings))))
            .collect(),
        _ => BTreeMap::new(),
    }
}

fn needs_pr_cancellation(event: &str, settings: Option<&Node<'_>>) -> bool {
    if !PR_EVENTS.contains(&event) {
        return false;
    }
    let Some(types) = settings
        .and_then(|settings| get(settings, "types"))
        .and_then(Node::as_vec)
    else {
        return true;
    };
    // Repeated opened/closed entries are still one-shot; other and non-scalar
    // event entries cannot establish the exception.
    !["opened", "closed"].iter().any(|one_shot| {
        !types.is_empty() && types.iter().all(|node| scalar(node) == Some(one_shot))
    })
}

fn event_fallbacks(
    path: &str,
    events: &BTreeMap<&str, Option<&Node<'_>>>,
    refs: &BTreeSet<String>,
    problems: &mut Vec<String>,
) {
    let non_pr = events.keys().filter(|event| !PR_EVENTS.contains(event));
    if non_pr.clone().any(|event| !COMMENT_EVENTS.contains(event))
        && !FALLBACK.iter().any(|reference| refs.contains(*reference))
    {
        problems.push(format!(
            "{path}: mixed-event group requires non-PR fallback"
        ));
    }
    if non_pr.clone().any(|event| COMMENT_EVENTS.contains(event))
        && !COMMENT_IDENTITIES
            .iter()
            .any(|reference| refs.contains(*reference))
    {
        problems.push(format!(
            "{path}: comment-triggered group lacks issue/PR identity"
        ));
    }
}

fn validate_group(
    path: &str,
    group: Option<&str>,
    events: &BTreeMap<&str, Option<&Node<'_>>>,
    relevant: &BTreeSet<&str>,
    patterns: &Patterns,
    problems: &mut Vec<String>,
) {
    let Some(group) = group.filter(|group| !group.trim().is_empty()) else {
        problems.push(format!("{path}: concurrency.group must be nonempty"));
        return;
    };
    let refs = patterns.references(group);
    let has_number = refs.contains("github.event.pull_request.number");
    let has_pr_ref = refs.contains("github.ref") || refs.contains("github.ref_name");
    if relevant.contains("pull_request_target") && !has_number {
        problems.push(format!("{path}: pull_request_target group must include github.event.pull_request.number (github.ref names the target branch)"));
    } else if !has_number && !has_pr_ref {
        problems.push(format!("{path}: concurrency.group lacks a PR-unique key"));
    }
    if relevant.len() > 1 && !refs.contains("github.event_name") {
        problems.push(format!(
            "{path}: PR and PR-target events need separate event-specific groups"
        ));
    }
    event_fallbacks(path, events, &refs, problems);
}

fn validate_global(
    path: &str,
    concurrency: &Node<'_>,
    events: &BTreeMap<&str, Option<&Node<'_>>>,
    problems: &mut Vec<String>,
) {
    if events.contains_key("workflow_call") {
        problems.push(format!(
            "{path}: global-snapshot cannot be combined with workflow_call"
        ));
    }
    if field(concurrency, "group") != Some("${{ github.workflow }}") {
        problems.push(format!(
            "{path}: global-snapshot requires github.workflow group"
        ));
    }
    if field(concurrency, "cancel-in-progress") != Some("true") {
        problems.push(format!(
            "{path}: global-snapshot requires unconditional cancellation"
        ));
    }
}

fn validate_cancel<'node>(
    path: &str,
    doc: &'node Node<'_>,
    source: &str,
    patterns: &Patterns,
    problems: &mut Vec<String>,
) -> Option<&'node str> {
    let events = triggers(doc);
    let relevant: BTreeSet<_> = events
        .iter()
        .filter(|(name, settings)| needs_pr_cancellation(name, **settings))
        .map(|(&name, _)| name)
        .collect();
    if relevant.is_empty() {
        return None;
    }
    let Some(concurrency) = get(doc, "concurrency").filter(|node| node.as_mapping().is_some())
    else {
        problems.push(format!(
            "{path}: PR-triggered workflow requires top-level concurrency"
        ));
        return None;
    };
    let group = field(concurrency, "group");
    if patterns.global_snapshot.is_match(source) {
        validate_global(path, concurrency, &events, problems);
        return group;
    }
    validate_group(path, group, &events, &relevant, patterns, problems);
    if !patterns.cancels_all_prs(field(concurrency, "cancel-in-progress"), &relevant) {
        problems.push(format!("{path}: cancel-in-progress must cancel every PR revision (true or event-name PR-only condition)"));
    }
    if events.contains_key("workflow_call") {
        problems.push(format!("{path}: workflow_call mixed with PR triggers risks cancelling its caller; split reusable and event-triggered workflows"));
    }
    group
}

fn runner_selectors<'node>(job: &'node Node<'_>, patterns: &Patterns) -> Vec<&'node str> {
    let mut values = Vec::new();
    fields(job, &["runs-on"], &mut values);
    if let Some(inputs) = get(job, "with") {
        fields(inputs, &["runner"], &mut values);
    }
    let referenced: BTreeSet<_> = values
        .iter()
        .copied()
        .flat_map(|value| {
            patterns
                .matrix
                .captures_iter(value)
                .filter_map(|m| m.get(1))
                .map(|m| m.as_str())
        })
        .collect();
    let Some(matrix) = get(job, "strategy").and_then(|strategy| get(strategy, "matrix")) else {
        return values;
    };
    // The references borrow YAML input, not the temporary vector holding them.
    for key in referenced {
        fields(matrix, &[key], &mut values);
        for collection in ["include", "exclude"] {
            if let Some(entries) = get(matrix, collection).and_then(Node::as_vec) {
                for entry in entries {
                    fields(entry, &[key], &mut values);
                }
            }
        }
    }
    values
}

fn validate_portability(
    path: &str,
    doc: &Node<'_>,
    patterns: &Patterns,
    problems: &mut Vec<String>,
) {
    let Some(jobs) = get(doc, "jobs").and_then(Node::as_mapping) else {
        return;
    };
    for (job_name, job) in jobs {
        let Some(name) = scalar(job_name) else {
            continue;
        };
        if job.as_mapping().is_none() {
            continue;
        }
        if runner_selectors(job, patterns)
            .iter()
            .any(|value| patterns.physical_host(value))
        {
            problems.push(format!("{path}: job {name}: physical host selector; use a declared runner capability instead"));
        }
        let mut paths = Vec::new();
        fields(doc, &["env"], &mut paths);
        fields(job, &["env", "defaults"], &mut paths);
        if let Some(steps) = get(job, "steps").and_then(Node::as_vec) {
            for step in steps {
                fields(step, &["env", "run", "with"], &mut paths);
            }
        }
        if paths.iter().any(|value| patterns.local_path(value)) {
            problems.push(format!("{path}: job {name}: host-local build path; use runner temporary storage or a verified artifact"));
        }
    }
}

pub fn inspect(
    root: &Path,
    paths: Vec<PathBuf>,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let patterns = Patterns::new()?;
    let mut problems = Vec::new();
    let mut groups = BTreeMap::<String, String>::new();
    for path in paths {
        let relative = path.strip_prefix(root)?.display().to_string();
        let source = fs::read_to_string(&path)?;
        let doc = match parse(&source) {
            Ok(doc) => doc,
            Err(error) => {
                problems.push(format!("{relative}: invalid YAML: {error}"));
                continue;
            }
        };
        if doc.as_mapping().is_none() {
            problems.push(format!("{relative}: expected YAML mapping"));
            continue;
        }
        validate_portability(&relative, &doc, &patterns, &mut problems);
        if let Some(group) = validate_cancel(&relative, &doc, &source, &patterns, &mut problems) {
            let name = field(&doc, "name")
                .filter(|name| !name.is_empty())
                .or_else(|| path.file_stem().and_then(|stem| stem.to_str()))
                .unwrap_or_default();
            let name = default_case_fold_str(name);
            let template =
                default_case_fold_str(group.trim()).replace("${{ github.workflow }}", &name);
            if let Some(previous) = groups.get(&template) {
                problems.push(format!(
                    "{relative}: concurrency.group collides with {previous}"
                ));
            } else {
                groups.insert(template, relative);
            }
        }
    }
    Ok(problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_references_exclude_literals_and_prefixes() -> Result<(), regex::Error> {
        let patterns = Patterns::new()?;
        let refs = patterns.references("${{ github.ref || 'github.sha' || other.github.run_id }}");
        assert_eq!(refs, BTreeSet::from(["github.ref".to_owned()]));
        Ok(())
    }

    #[test]
    fn label_boundaries() -> Result<(), regex::Error> {
        let patterns = Patterns::new()?;
        assert!(patterns.physical_host("[self-hosted, Asus]"));
        assert!(!patterns.physical_host("capability-asus"));
        assert!(patterns.local_path("cd /home/jan/project"));
        assert!(!patterns.local_path("cd /home/january/project"));
        Ok(())
    }
}
