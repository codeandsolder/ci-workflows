//! Prove that a Git patch changes only existing Rust `#[must_use]` explanations.
//!
//! The clone scanner tokenizes attributes. Changing explanation strings can
//! therefore rename fingerprints of code that was already duplicated. This
//! check is intentionally exact: every changed line must be a matching
//! `#[must_use]` attribute before and after the edit.

use regex::Regex;
use serde::Serialize;
use std::{
    error::Error,
    io::{self, Read, Write},
    path::Path,
    sync::LazyLock,
};

static MUST_USE: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(r#"^([ \t]*)#\[\s*must_use(?:\s*=\s*"(?:[^"\\]|\\.)*")?\s*\][ \t]*$"#)
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct AnnotationProof {
    annotation_only: bool,
    changed_attributes: usize,
}

fn matched_indentation(line: &str) -> Option<&str> {
    MUST_USE
        .as_ref()
        .ok()?
        .captures(line)
        .and_then(|groups| groups.get(1).map(|value| value.as_str()))
}

fn finish_hunk(removed: &mut Vec<String>, added: &mut Vec<String>) -> Option<usize> {
    let count = removed.len();
    if count == 0 || count != added.len() {
        return None;
    }
    let valid = removed.iter().zip(added.iter()).all(|(before, after)| {
        matches!(
            (matched_indentation(before), matched_indentation(after)),
            (Some(before_indent), Some(after_indent)) if before_indent == after_indent && before != after
        )
    });
    removed.clear();
    added.clear();
    valid.then_some(count)
}

const fn invalid_proof() -> AnnotationProof {
    AnnotationProof {
        annotation_only: false,
        changed_attributes: 0,
    }
}

fn inspect_patch(patch: &str) -> AnnotationProof {
    let mut file_seen = false;
    let mut old_path = false;
    let mut new_path = false;
    let mut hunk_seen = false;
    let mut inside_hunk = false;
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let mut total = 0_usize;

    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            if inside_hunk {
                let Some(count) = finish_hunk(&mut removed, &mut added) else {
                    return invalid_proof();
                };
                total += count;
            }
            if file_seen && (!old_path || !new_path || !hunk_seen) {
                return invalid_proof();
            }
            if !line.starts_with("diff --git a/") {
                return invalid_proof();
            }
            file_seen = true;
            old_path = false;
            new_path = false;
            hunk_seen = false;
            inside_hunk = false;
        } else if line.starts_with("@@ ") {
            if !file_seen || !old_path || !new_path {
                return invalid_proof();
            }
            if inside_hunk {
                let Some(count) = finish_hunk(&mut removed, &mut added) else {
                    return invalid_proof();
                };
                total += count;
            }
            hunk_seen = true;
            inside_hunk = true;
        } else if inside_hunk {
            if let Some(value) = line.strip_prefix('-') {
                removed.push(value.to_owned());
            } else if let Some(value) = line.strip_prefix('+') {
                added.push(value.to_owned());
            } else {
                return invalid_proof();
            }
        } else if let Some(value) = line.strip_prefix("--- ") {
            old_path = value.starts_with("a/")
                && Path::new(value).extension().is_some_and(|ext| ext == "rs");
            if !old_path {
                return invalid_proof();
            }
        } else if let Some(value) = line.strip_prefix("+++ ") {
            new_path = value.starts_with("b/")
                && Path::new(value).extension().is_some_and(|ext| ext == "rs");
            if !new_path {
                return invalid_proof();
            }
        } else if !(line.starts_with("index ") || line.is_empty()) {
            return invalid_proof();
        }
    }

    if inside_hunk {
        let Some(count) = finish_hunk(&mut removed, &mut added) else {
            return invalid_proof();
        };
        total += count;
    }
    AnnotationProof {
        annotation_only: file_seen && old_path && new_path && hunk_seen && total > 0,
        changed_attributes: total,
    }
}

/// Inspect a unified Git patch from stdin and output an exact metadata-only proof.
pub fn emit_proof() -> Result<(), Box<dyn Error>> {
    let mut patch = String::new();
    io::stdin().read_to_string(&mut patch)?;
    let result = inspect_patch(&patch);
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &result)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(before: &str, after: &str) -> String {
        format!(
            "diff --git a/src/api.rs b/src/api.rs\nindex 1234567..9876543 100644\n--- a/src/api.rs\n+++ b/src/api.rs\n@@ -10 +10 @@\n-{before}\n+{after}\n"
        )
    }

    #[test]
    fn existing_reason_changes_are_metadata_only() {
        let before = "    #[must_use]";
        let after = "    #[must_use = \"The returned curve is a distinct value.\"]";
        assert_eq!(
            inspect_patch(&diff(before, after)),
            AnnotationProof {
                annotation_only: true,
                changed_attributes: 1
            }
        );
        assert!(
            inspect_patch(&diff(after, "    #[must_use = \"Another reason.\"]")).annotation_only
        );
        assert!(inspect_patch(&diff(before, "    #[ must_use = \"A reason.\"]")).annotation_only);
    }

    #[test]
    fn rejects_executable_code_changes_and_new_attributes() {
        for patch in [
            diff("    fn x() {}", "    fn y() {}"),
            diff(
                "    #[must_use]",
                "    #[must_use = \"x\"]\n+    fn new_code() {}",
            ),
            diff("    #[must_use]", "    #[derive(Debug)]"),
            diff("    #[must_use]", "        #[must_use = \"x\"]"),
            diff("    #[must_use]", "    #[must_use = \"not terminated]"),
            diff("    #[must_use]", "    #[must_use = \"x\"] // inline"),
        ] {
            assert!(!inspect_patch(&patch).annotation_only, "{patch}");
        }
        assert!(!inspect_patch("").annotation_only);
        assert!(!inspect_patch(&diff("    #[must_use]", "    #[must_use]")).annotation_only);
    }

    #[test]
    fn checks_each_hunk_and_rejects_other_files() {
        let initial = diff("#[must_use]", "#[must_use = \"Reason.\"]");
        let double = format!("{initial}@@ -30 +30 @@\n-#[must_use]\n+#[must_use = \"Another.\"]\n");
        assert_eq!(inspect_patch(&double).changed_attributes, 2);
        assert!(
            !inspect_patch(&format!(
                "{initial}@@ -30 +30 @@\n-let x = 1;\n+let x = 2;\n"
            ))
            .annotation_only
        );
        assert!(!inspect_patch(&initial.replace("api.rs", "api.md")).annotation_only);
        assert!(!inspect_patch(&format!("{initial}diff --git a/README.md b/README.md\nindex 1..2 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n")).annotation_only);
        assert!(
            !inspect_patch(
                &initial.replace("index 1234567..9876543 100644", "new file mode 100644")
            )
            .annotation_only
        );
    }
}
