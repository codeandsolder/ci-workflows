use crate::{
    workspace::{Kind, resolve},
    yaml::{Node, field, parse},
};
use serde::Deserialize;
use std::{collections::BTreeSet, error::Error, fs, path::Path};

#[derive(Deserialize)]
struct Mapping {
    text: String,
    label: String,
    color: String,
}

fn boxes(source: &str, heading: &str) -> Result<BTreeSet<String>, String> {
    if heading.is_empty() {
        return Err("empty checklist heading".into());
    }
    let mut found = false;
    let mut inside = false;
    let mut fenced = false;
    let mut items = BTreeSet::new();
    for line in source.lines() {
        let line = line.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.starts_with("~~~") || trimmed.as_bytes().starts_with(&[96, 96, 96]) {
            if inside {
                return Err("fences are invalid in a checklist section".into());
            }
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if let Some(title) = line.strip_prefix("## ") {
            if title.trim() == heading {
                if found {
                    return Err("duplicate heading".into());
                }
                found = true;
                inside = true;
            } else if inside {
                inside = false;
            }
            continue;
        }
        if line.starts_with("# ") && inside {
            inside = false;
            continue;
        }
        if !inside || trimmed.is_empty() {
            continue;
        }
        let text = line
            .strip_prefix("- [ ] ")
            .or_else(|| line.strip_prefix("- [x] "))
            .or_else(|| line.strip_prefix("- [X] "))
            .ok_or_else(|| format!("unsupported checklist syntax: {line}"))?
            .trim();
        if text.is_empty() || !items.insert(text.to_owned()) {
            return Err(format!("empty or duplicate checklist item: {text}"));
        }
    }
    if !found || items.is_empty() {
        return Err("missing or empty checklist section".into());
    }
    Ok(items)
}

fn find_scripts(node: &Node<'_>, marker: &str, values: &mut Vec<String>) {
    if let Some(mapping) = node.as_mapping() {
        if let Some(text) = field(node, "script")
            && text.contains(marker)
        {
            values.push(text.to_owned());
        }
        for child in mapping.values() {
            find_scripts(child, marker, values);
        }
    } else if let Some(sequence) = node.as_vec() {
        for child in sequence {
            find_scripts(child, marker, values);
        }
    }
}

fn labels(source: &str, key: &str) -> Result<BTreeSet<String>, String> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("invalid mapping constant name".into());
    }
    let yaml = parse(source)?;
    let marker = format!("const {key} =");
    let mut values = Vec::new();
    find_scripts(&yaml, &marker, &mut values);
    let [script] = values.as_slice() else {
        return Err(format!(
            "expected one script with {marker}; found {}",
            values.len()
        ));
    };
    let (_, following) = script.split_once(&marker).ok_or("missing label map")?;
    if following.contains(&marker) {
        return Err(format!("multiple {marker} declarations"));
    }
    let json = following.trim_start();
    let mut reader = serde_json::Deserializer::from_str(json).into_iter::<Vec<Mapping>>();
    let entries = reader
        .next()
        .ok_or("empty JavaScript JSON array")?
        .map_err(|error| format!("invalid {key} JSON: {error}"))?;
    if !json[reader.byte_offset()..].trim_start().starts_with(';') {
        return Err(format!("{key} JSON literal must end with a semicolon"));
    }
    if entries.is_empty() {
        return Err("empty label map".into());
    }
    let mut names = BTreeSet::new();
    let mut texts = BTreeSet::new();
    for entry in entries {
        if entry.text.is_empty()
            || entry.text.trim() != entry.text
            || entry.label.is_empty()
            || entry.label.trim() != entry.label
            || entry.color.len() != 6
            || !entry.color.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("invalid label mapping entry".into());
        }
        if !texts.insert(entry.text) || !names.insert(entry.label.to_lowercase()) {
            return Err("duplicate mapping text or label".into());
        }
    }
    Ok(texts)
}

fn compare(
    template: &str,
    workflow: &str,
    heading: &str,
    key: &str,
) -> Result<Vec<String>, String> {
    let wanted = boxes(template, heading)?;
    let actual = labels(workflow, key)?;
    Ok(wanted
        .difference(&actual)
        .map(|v| format!("checkbox {v:?} has no label"))
        .chain(
            actual
                .difference(&wanted)
                .map(|v| format!("mapping {v:?} is not a checkbox")),
        )
        .collect())
}

fn read(root: &Path, path: &str) -> Result<String, Box<dyn Error>> {
    let resolved = resolve(root, Some(root), path).ok_or("path escapes checkout")?;
    if resolved.kind != Kind::File {
        return Err("expected a checkout file".into());
    }
    Ok(fs::read_to_string(resolved.path)?)
}

pub fn inspect(
    root: &Path,
    template: &str,
    workflow: &str,
    heading: &str,
    key: &str,
) -> Result<Vec<String>, Box<dyn Error>> {
    Ok(compare(
        &read(root, template)?,
        &read(root, workflow)?,
        heading,
        key,
    )?)
}

#[cfg(test)]
mod tests {
    use super::compare;
    use std::error::Error;

    const TEMPLATE: &str = "## Type of change\n\n- [ ] Bug fix\n- [ ] New feature\n\n## Summary\n";
    const WORKFLOW: &str = r#"
jobs:
  label:
    steps:
      - uses: actions/github-script@v9
        with:
          script: |
            const TYPE_LABELS = [
              {"text":"Bug fix","label":"bug","color":"d73a4a"},
              {"text":"New feature","label":"enhancement","color":"a2eeef"}
            ];
"#;

    #[test]
    fn exact_mapping() -> Result<(), Box<dyn Error>> {
        assert_eq!(
            compare(TEMPLATE, WORKFLOW, "Type of change", "TYPE_LABELS")?,
            Vec::<String>::new()
        );
        Ok(())
    }

    #[test]
    fn mismatch_reports_both_sides() -> Result<(), Box<dyn Error>> {
        let source = WORKFLOW.replace("New feature", "Breaking change");
        let problems = compare(TEMPLATE, &source, "Type of change", "TYPE_LABELS")?;
        assert_eq!(problems.len(), 2);
        Ok(())
    }

    #[test]
    fn malformed_mapping_fails_closed() {
        for changed in [
            WORKFLOW.replace("d73a4a", "invalid"),
            WORKFLOW.replace("enhancement", "bug"),
            WORKFLOW.replace("enhancement", "BUG"),
            WORKFLOW.replace("New feature", "Bug fix"),
            WORKFLOW.replace("TYPE_LABELS", "RENAMED"),
        ] {
            assert!(compare(TEMPLATE, &changed, "Type of change", "TYPE_LABELS").is_err());
        }
    }

    #[test]
    fn malformed_template_fails_closed() {
        for changed in [
            TEMPLATE.replace("- [ ] New feature", "- [ ] Bug fix"),
            TEMPLATE.replace("- [ ] New feature", "- other text"),
            TEMPLATE.replace("## Type of change", "## Other"),
        ] {
            assert!(compare(&changed, WORKFLOW, "Type of change", "TYPE_LABELS").is_err());
        }
    }
}
