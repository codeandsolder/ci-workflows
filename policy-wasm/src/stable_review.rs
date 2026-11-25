//! Stable Rust release issue decisions. Transport stays native; every
//! release-version, date, immutable marker, and deduplication rule lives in WASI.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    error::Error,
    io::{self, Read},
};

#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Release {
    version: String,
    date: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    manifest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    release: Release,
    issues: Vec<Vec<Value>>,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ReviewDecision {
    Existing { number: u64 },
    Create { title: String, body: String },
}

fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = date[..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = date[5..7].parse::<usize>() else {
        return false;
    };
    let Ok(day) = date[8..].parse::<usize>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=days[month - 1]).contains(&day)
}

fn validated_version(value: &str) -> Result<String, Box<dyn Error>> {
    let (version, description) = value
        .split_once(char::is_whitespace)
        .map_or((value, ""), |(version, desc)| (version, desc.trim_start()));
    let chunks: Vec<_> = version.split('.').collect();
    if chunks.len() != 3
        || chunks
            .iter()
            .any(|chunk| chunk.is_empty() || !chunk.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("invalid stable Rust version".into());
    }
    if !description.is_empty() && description.chars().any(char::is_control) {
        return Err("invalid stable Rust version suffix".into());
    }
    Ok(version.to_owned())
}

fn parse_manifest(source: &str) -> Result<Release, Box<dyn Error>> {
    let parsed: toml::Value = toml::from_str(source)?;
    let date = parsed
        .get("date")
        .and_then(toml::Value::as_str)
        .ok_or("missing top-level Rust channel date")?;
    let version = parsed
        .get("pkg")
        .and_then(|pkg| pkg.get("rust"))
        .and_then(|rust| rust.get("version"))
        .and_then(toml::Value::as_str)
        .ok_or("missing pkg.rust version")?;
    let release = Release {
        version: validated_version(version)?,
        date: date.to_owned(),
    };
    validate(&release)?;
    Ok(release)
}

fn validate(release: &Release) -> Result<(), Box<dyn Error>> {
    if !valid_date(&release.date) {
        return Err("invalid stable Rust release date".into());
    }
    if validated_version(&release.version)? != release.version {
        return Err("stable Rust version must be an exact MAJOR.MINOR.PATCH".into());
    }
    Ok(())
}

fn review_body(version: &str) -> String {
    [
        format!("<!-- rust-stable-{version} -->"),
        "<!-- automation-queue:rust-release -->".to_owned(),
        String::new(),
        format!("Rust **{version}** is now the stable toolchain."),
        String::new(),
        "Do a complete repository refresh against this release, not merely a version-string update:".to_owned(),
        String::new(),
        format!("- Read the official Rust {version} announcement and detailed release notes/changelog."),
        "- Review language, standard-library, rustc, Cargo, Clippy, rustfmt, platform and tooling changes.".to_owned(),
        "- Review Rust code, manifests, lockfiles, CI, build/release tooling, skills, policy checks, documentation, examples and tests where present.".to_owned(),
        "- Adopt useful newly-stable features and best practices; remove obsolete workarounds.".to_owned(),
        "- Preserve the repository toolchain policy (including shared quarantined nightly and any intentional MSRV/release exceptions). Let the canonical toolchain update mechanism own pins.".to_owned(),
        "- Run the relevant CI-equivalent checks and fix fallout.".to_owned(),
        "- If no changes are justified, document what was reviewed and close this issue as a no-op.".to_owned(),
        String::new(),
        "This issue is generated automatically. A ChatGPT maintenance automation is expected to implement it.".to_owned(),
    ].join("\n")
}

fn decision(input: PlanInput) -> Result<ReviewDecision, Box<dyn Error>> {
    validate(&input.release)?;
    let version = &input.release.version;
    let marker = format!("<!-- rust-stable-{version} -->");
    for page in input.issues {
        for item in page {
            let issue = item.as_object().ok_or("malformed issue inventory item")?;
            let number = issue
                .get("number")
                .and_then(Value::as_u64)
                .ok_or("issue missing numeric id")?;
            let body = issue.get("body").ok_or("issue body field missing")?;
            if !body.is_null() && !body.is_string() {
                return Err("issue body must be text or null".into());
            }
            if !issue.contains_key("pull_request")
                && body.as_str().is_some_and(|body| body.contains(&marker))
            {
                return Ok(ReviewDecision::Existing { number });
            }
        }
    }
    Ok(ReviewDecision::Create {
        title: format!("Rust {version}: full best-practices refresh"),
        body: review_body(version),
    })
}

pub fn execute(mode: &str) -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    match mode {
        "stable-release-parse" => serde_json::to_writer(
            io::stdout().lock(),
            &parse_manifest(&serde_json::from_str::<RawManifest>(&input)?.manifest)?,
        )?,
        "stable-release-plan" => serde_json::to_writer(
            io::stdout().lock(),
            &decision(serde_json::from_str::<PlanInput>(&input)?)?,
        )?,
        _ => return Err("unknown stable release policy operation".into()),
    }
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{PlanInput, Release, ReviewDecision, decision, parse_manifest};
    use serde_json::json;
    use std::error::Error;

    const MANIFEST: &str = "manifest-version = \"2\"\ndate = \"2026-11-12\"\n[pkg.cargo]\nversion = \"0.101.0\"\n[pkg.rust]\nversion = \"1.100.0 (abcdef 2026-11-10)\"\n[pkg.rust.target.x86_64-unknown-linux-gnu]\nversion = \"9.9.9\"\n";
    #[test]
    fn official_manifest_fields() -> Result<(), Box<dyn Error>> {
        let expected = Release {
            version: "1.100.0".into(),
            date: "2026-11-12".into(),
        };
        assert_eq!(parse_manifest(MANIFEST)?, expected);
        assert_eq!(parse_manifest(&MANIFEST.replace('\n', "\r\n"))?, expected);
        Ok(())
    }
    #[test]
    fn reject_invalid_or_ambiguous_manifests() {
        for bad in [
            MANIFEST.replace("2026-11-12", "2026-02-31"),
            MANIFEST.replace("1.100.0", "nightly"),
            MANIFEST.replace("[pkg.rust]", "[pkg.other]"),
            format!("{MANIFEST}\n[pkg.rust]\nversion = \"1.101.0\"\n"),
            format!("date = \"2026-11-12\"\n{MANIFEST}"),
            MANIFEST.replace("2026-11-12", "2026-00-12"),
            MANIFEST.replace("2026-11-12", "2026-13-12"),
        ] {
            assert!(parse_manifest(&bad).is_err());
        }
    }
    #[test]
    fn leap_year_and_release_suffix_validation() {
        assert!(parse_manifest(&MANIFEST.replace("2026-11-12", "2024-02-29")).is_ok());
        assert!(parse_manifest(&MANIFEST.replace("2026-11-12", "2100-02-29")).is_err());
        assert!(parse_manifest(&MANIFEST.replace("2026-11-12", "2000-02-29")).is_ok());
        assert!(parse_manifest(&MANIFEST.replace("1.100.0", "1.100.0-preview")).is_err());
    }
    #[test]
    fn exact_existing_issue_marker_over_all_pages() -> Result<(), Box<dyn Error>> {
        let release = Release {
            version: "1.100.0".into(),
            date: "2026-11-12".into(),
        };
        let input: PlanInput = serde_json::from_value(json!({
            "release":release, "issues":[[
                {"number":1,"body":null},
                {"number":2,"body":"<!-- rust-stable-1.100.0 -->","pull_request":{}},
                {"number":3,"body":"<!-- rust-stable-1.100.01 -->"}
            ],[
                {"number":4,"body":"<!-- rust-stable-1.100.0 -->"}
            ]]
        }))?;
        assert!(matches!(
            decision(input)?,
            ReviewDecision::Existing { number: 4 }
        ));
        Ok(())
    }
    #[test]
    fn new_release_preserves_full_immutable_issue_template() -> Result<(), Box<dyn Error>> {
        let input: PlanInput = serde_json::from_value(json!({
            "release":{"version":"1.100.0","date":"2026-11-12"},
            "issues":[[]]
        }))?;
        let ReviewDecision::Create { title, body } = decision(input)? else {
            return Err("expected new issue".into());
        };
        assert_eq!(title, "Rust 1.100.0: full best-practices refresh");
        assert!(body.contains("<!-- rust-stable-1.100.0 -->"));
        assert!(body.contains("automation-queue:rust-release"));
        assert!(body.contains("quarantined nightly"));
        Ok(())
    }
    #[test]
    fn malformed_issue_inventory_cannot_create_an_issue() -> Result<(), Box<dyn Error>> {
        for issue in [
            json!(null),
            json!({"number":"1","body":""}),
            json!({"number":1,"body":4}),
            json!({"number":1}),
        ] {
            let input: PlanInput = serde_json::from_value(json!({
                "release":{"version":"1.100.0","date":"2026-11-12"},
                "issues":[[issue]]
            }))?;
            assert!(decision(input).is_err());
        }
        Ok(())
    }
}
