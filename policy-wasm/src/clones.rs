//! Classify base-relative scanner groups using centrally owned thresholds.
//! Preserve the scanner's report schema and all fields not owned by policy.
use crate::{
    rust_tests,
    workspace::{Kind, resolve},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct Acceptance {
    fingerprint: String,
    reason: String,
}

#[derive(Deserialize)]
struct Config {
    #[serde(default)]
    accept: Vec<Acceptance>,
}

#[derive(Deserialize, Serialize)]
struct Occurrence {
    file: String,
    start_line: usize,
    end_line: usize,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Deserialize, Serialize)]
struct Group {
    tokens: usize,
    fingerprint: String,
    occurrences: Vec<Occurrence>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
struct Report {
    new: Vec<Group>,
    smaller: Vec<Group>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Tier {
    Test,
    Production,
}

#[derive(Serialize)]
struct ClassifiedGroup {
    #[serde(flatten)]
    group: Group,
    policy_tier: Tier,
    policy_blocking_tokens: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    accept_reason: Option<Value>,
}

#[derive(Serialize)]
struct PolicySummary {
    production_blocking_tokens: usize,
    test_blocking_tokens: usize,
    blocking: usize,
    advisory: usize,
    accepted: usize,
}

#[derive(Serialize)]
struct ClassifiedReport {
    new: Vec<ClassifiedGroup>,
    smaller: Vec<ClassifiedGroup>,
    accepted: Vec<ClassifiedGroup>,
    policy: PolicySummary,
    note: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy)]
struct Thresholds {
    production: usize,
    testing: usize,
}

impl Thresholds {
    const fn new(production: usize, testing: usize) -> Result<Self, &'static str> {
        if production == 0 || testing < production {
            return Err("test blocking threshold must be >= production threshold > 0");
        }
        Ok(Self {
            production,
            testing,
        })
    }
}

fn parse_accepts(source: &str) -> Result<BTreeMap<String, String>, Box<dyn Error>> {
    let config = toml::from_str::<Config>(source)?;
    let mut result = BTreeMap::new();
    for entry in config.accept {
        if entry.fingerprint.len() != 12
            || !entry
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("accepted fingerprint must be the 12-digit scanner hex ID".into());
        }
        let reason = entry.reason.trim();
        if reason.chars().count() < 12 {
            return Err(format!(
                "accepted clone {} requires a meaningful reason",
                entry.fingerprint
            )
            .into());
        }
        if result
            .insert(entry.fingerprint.to_ascii_lowercase(), reason.to_owned())
            .is_some()
        {
            return Err(format!("duplicate accepted fingerprint {}", entry.fingerprint).into());
        }
    }
    Ok(result)
}

fn accepted_fingerprints(root: &Path) -> Result<BTreeMap<String, String>, Box<dyn Error>> {
    let file =
        resolve(root, Some(root), ".doppelscan.toml").ok_or("invalid .doppelscan.toml path")?;
    if file.kind != Kind::File {
        return Ok(BTreeMap::new());
    }
    parse_accepts(&fs::read_to_string(file.path)?)
}

fn test_file(relative: &str) -> bool {
    let path = Path::new(relative);
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if path.parent().is_some_and(|parent| {
        parent.components().any(|part| {
            part.as_os_str().to_str().is_some_and(|name| {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "test" | "tests" | "__tests__" | "spec" | "specs"
                )
            })
        })
    }) {
        return true;
    }
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "tests.rs" | "test.rs" | "conftest.py")
        || ["test_", "test-", "smoke-", "spec_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || [
            "_test.rs",
            "_test.py",
            ".test.js",
            ".test.ts",
            ".test.jsx",
            ".test.tsx",
            ".spec.js",
            ".spec.ts",
            ".spec.jsx",
            ".spec.tsx",
            ".spec.py",
            ".spec.sh",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

struct Classifier<'a> {
    root: &'a Path,
    scan_root: &'a Path,
    thresholds: Thresholds,
    accepts: BTreeMap<String, String>,
    rust_cache: BTreeMap<PathBuf, Vec<(usize, usize)>>,
}

impl Classifier<'_> {
    fn test_occurrence(&mut self, item: &Occurrence) -> bool {
        let Some(file) = resolve(self.root, Some(self.scan_root), &item.file)
            .filter(|file| file.kind == Kind::File && file.path.starts_with(self.scan_root))
        else {
            return false;
        };
        if test_file(&item.file) {
            return true;
        }
        if Path::new(&item.file)
            .extension()
            .is_none_or(|ext| ext != "rs")
        {
            return false;
        }
        let ranges = self.rust_cache.entry(file.path).or_insert_with_key(|path| {
            fs::read_to_string(path)
                .map_or_else(|_| Vec::new(), |source| rust_tests::test_ranges(&source))
        });
        rust_tests::contains(ranges, item.start_line, item.end_line)
    }

    fn apply(&mut self, report: Report) -> ClassifiedReport {
        let Report {
            new,
            smaller,
            mut extra,
        } = report;
        let mut blocked = Vec::new();
        let mut advisory = Vec::new();
        let mut accepted = Vec::new();
        for mut group in new.into_iter().chain(smaller) {
            let (tier, threshold) = if !group.occurrences.is_empty()
                && group
                    .occurrences
                    .iter()
                    .all(|item| self.test_occurrence(item))
            {
                (Tier::Test, self.thresholds.testing)
            } else {
                (Tier::Production, self.thresholds.production)
            };
            group.extra.remove("policy_tier");
            group.extra.remove("policy_blocking_tokens");
            let mut classified = ClassifiedGroup {
                accept_reason: group.extra.remove("accept_reason"),
                group,
                policy_tier: tier,
                policy_blocking_tokens: threshold,
            };
            if let Some(reason) = self
                .accepts
                .get(&classified.group.fingerprint.to_ascii_lowercase())
            {
                classified.accept_reason = Some(Value::String(reason.clone()));
                accepted.push(classified);
            } else if classified.group.tokens >= threshold {
                blocked.push(classified);
            } else {
                advisory.push(classified);
            }
        }
        for field in ["policy", "note", "accepted"] {
            extra.remove(field);
        }
        let policy = PolicySummary {
            production_blocking_tokens: self.thresholds.production,
            test_blocking_tokens: self.thresholds.testing,
            blocking: blocked.len(),
            advisory: advisory.len(),
            accepted: accepted.len(),
        };
        let note = format!(
            "{} new clone groups remain advisory under their {}-token production / {}-token test thresholds; {} explicitly accepted by documented fingerprint.",
            advisory.len(),
            self.thresholds.production,
            self.thresholds.testing,
            accepted.len()
        );
        ClassifiedReport {
            new: blocked,
            smaller: advisory,
            accepted,
            policy,
            note,
            extra,
        }
    }
}

pub fn classify(
    root: &Path,
    scan_root: &Path,
    production: usize,
    testing: usize,
) -> Result<(), Box<dyn Error>> {
    let thresholds = Thresholds::new(production, testing)?;
    let scan_path = scan_root.to_str().ok_or("scan root is not UTF-8")?;
    let scan = resolve(root, Some(root), scan_path)
        .filter(|file| file.kind == Kind::Directory && file.path.starts_with(root))
        .ok_or("scan root must be a checkout directory")?;
    let mut classifier = Classifier {
        root,
        scan_root: &scan.path,
        thresholds,
        accepts: accepted_fingerprints(root)?,
        rust_cache: BTreeMap::new(),
    };
    let report = serde_json::from_reader(io::stdin().lock())?;
    let result = classifier.apply(report);
    let mut output = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer_pretty(&mut output, &result)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_validate_ids_reasons_and_duplicates() -> Result<(), Box<dyn Error>> {
        let valid =
            "[[accept]]\nfingerprint = \"ABCDEF123456\"\nreason = \"A meaningful reason\"\n";
        assert_eq!(
            parse_accepts(valid)?
                .get("abcdef123456")
                .map(String::as_str),
            Some("A meaningful reason")
        );
        assert!(parse_accepts(&valid.repeat(2)).is_err());
        assert!(parse_accepts(&valid.replace("ABCDEF123456", "bad")).is_err());
        assert!(parse_accepts(&valid.replace("A meaningful reason", "bad")).is_err());
        Ok(())
    }

    #[test]
    fn filename_rules() {
        for file in [
            "src/math.spec.ts",
            "tests/unusual-code.rs",
            "src/test_oracle.py",
            "runtime/smoke-real.sh",
        ] {
            assert!(test_file(file));
        }
        assert!(!test_file("src/math.rs"));
        assert!(Thresholds::new(100, 99).is_err());
    }
}
