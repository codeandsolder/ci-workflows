//! Cargo release-age policy, independent of Git, network and host clocks.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
struct Package {
    name: String,
    version: String,
    source: String,
}

#[derive(Deserialize)]
struct LockPackage {
    name: String,
    version: String,
    source: Option<String>,
}

#[derive(Deserialize)]
struct Lock {
    #[serde(default)]
    package: Vec<LockPackage>,
}

#[derive(Deserialize)]
struct RemovedManifest {
    manifest: String,
    workspace_lock: Option<String>,
    members: Vec<String>,
}

#[derive(Deserialize)]
struct Diff {
    selector: String,
    before: BTreeMap<String, String>,
    after: BTreeMap<String, String>,
    removed_manifests: BTreeMap<String, RemovedManifest>,
}

impl Diff {
    fn introduced(self) -> Result<Vec<Package>, Box<dyn std::error::Error>> {
        for removed in self
            .before
            .keys()
            .filter(|path| !self.after.contains_key(*path))
        {
            if self.selector != "auto" {
                return Err(format!(
                    "explicitly selected lockfile {removed} was removed from this revision"
                )
                .into());
            }
            if let Some(entry) = self.removed_manifests.get(removed)
                && !(entry
                    .workspace_lock
                    .as_ref()
                    .is_some_and(|lock| self.after.contains_key(lock))
                    && entry.members.contains(&entry.manifest))
            {
                return Err(format!("tracked lockfile {removed} was removed but workspace manifest {} still exists; restore the lockfile or remove the workspace explicitly, or integrate it into a workspace with a tracked lockfile", entry.manifest).into());
            }
        }
        let before = registry_packages(&self.before)?;
        let after = registry_packages(&self.after)?;
        Ok(after.difference(&before).cloned().collect())
    }
}

fn registry_packages(
    files: &BTreeMap<String, String>,
) -> Result<BTreeSet<Package>, Box<dyn std::error::Error>> {
    let mut result = BTreeSet::new();
    for (path, content) in files {
        let lock: Lock =
            toml::from_str(content).map_err(|error| format!("invalid lockfile {path}: {error}"))?;
        for pkg in lock.package {
            if let Some(source) = pkg.source
                && source.starts_with("registry+")
                && (source.contains("crates.io-index") || source.contains("index.crates.io"))
            {
                result.insert(Package {
                    name: pkg.name,
                    version: pkg.version,
                    source,
                });
            }
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Publication {
    Found { time_ms: i64, timestamp: String },
    Missing,
    Failed { message: String },
}

#[derive(Deserialize)]
struct Age {
    now_ms: i64,
    hours: u64,
    packages: Vec<Package>,
    publications: BTreeMap<String, BTreeMap<String, Publication>>,
}

impl Age {
    fn issues(&self) -> Vec<String> {
        let cutoff = i128::from(self.now_ms) - i128::from(self.hours) * 3_600_000;
        self.packages
            .iter()
            .filter_map(|pkg| {
                let publication = self
                    .publications
                    .get(&pkg.name)
                    .and_then(|versions| versions.get(&pkg.version));
                let reason = match publication {
                    Some(Publication::Found { time_ms, .. }) if i128::from(*time_ms) <= cutoff => {
                        return None;
                    }
                    Some(Publication::Found { timestamp, .. }) => {
                        format!("published {timestamp}, younger than {}h", self.hours)
                    }
                    Some(Publication::Failed { message }) => {
                        format!("crates.io lookup failed: {message}")
                    }
                    None | Some(Publication::Missing) => {
                        "missing authoritative crates.io publication time".into()
                    }
                };
                Some(format!("{} {}: {reason}", pkg.name, pkg.version))
            })
            .collect()
    }
}

pub fn diff() -> Result<(), Box<dyn std::error::Error>> {
    let input: Diff = serde_json::from_reader(std::io::stdin().lock())?;
    serde_json::to_writer(std::io::stdout().lock(), &input.introduced()?)?;
    Ok(())
}

pub fn age() -> Result<(), Box<dyn std::error::Error>> {
    let input: Age = serde_json::from_reader(std::io::stdin().lock())?;
    serde_json::to_writer(std::io::stdout().lock(), &input.issues())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock(name: &str, version: &str, source: &str) -> String {
        format!("[[package]]\nname = {name:?}\nversion = {version:?}\nsource = {source:?}\n")
    }

    #[test]
    fn registry_union_ignores_moved_crates_and_git_revisions()
    -> Result<(), Box<dyn std::error::Error>> {
        let registry = "registry+https://github.com/rust-lang/crates.io-index";
        let before = BTreeMap::from([("old/Cargo.lock".into(), lock("serde", "1.0.0", registry))]);
        let after = BTreeMap::from([(
            "new/Cargo.lock".into(),
            lock("serde", "1.0.0", registry)
                + &lock("external", "2.0.0", registry)
                + &lock(
                    "own",
                    "1.0.0",
                    "git+https://github.com/codeandsolder/own#revision",
                ),
        )]);
        let introduced = Diff {
            selector: "auto".into(),
            before,
            after,
            removed_manifests: BTreeMap::new(),
        }
        .introduced()?;
        assert_eq!(
            introduced
                .iter()
                .map(|pkg| pkg.name.as_str())
                .collect::<Vec<_>>(),
            ["external"]
        );
        Ok(())
    }

    #[test]
    fn exact_age_boundary_and_failed_metadata() -> Result<(), serde_json::Error> {
        let age: Age = serde_json::from_value(serde_json::json!({
            "now_ms": 259_200_001, "hours": 72,
            "packages": [
                {"name": "old", "version": "1", "source": "registry+index.crates.io"},
                {"name": "young", "version": "1", "source": "registry+index.crates.io"},
                {"name": "missing", "version": "1", "source": "registry+index.crates.io"},
                {"name": "failed", "version": "1", "source": "registry+index.crates.io"}
            ],
            "publications": {
                "old": {"1": {"kind": "found", "time_ms": 1, "timestamp": "old"}},
                "young": {"1": {"kind": "found", "time_ms": 2, "timestamp": "recent"}},
                "failed": {"1": {"kind": "failed", "message": "unreachable"}}
            }
        }))?;
        assert_eq!(
            age.issues(),
            [
                "young 1: published recent, younger than 72h",
                "missing 1: missing authoritative crates.io publication time",
                "failed 1: crates.io lookup failed: unreachable"
            ]
        );
        Ok(())
    }
    #[test]
    fn workspace_consolidation_requires_a_tracked_member_lock()
    -> Result<(), Box<dyn std::error::Error>> {
        let registry = "registry+https://github.com/rust-lang/crates.io-index";
        let before = BTreeMap::from([(
            "package/Cargo.lock".into(),
            lock("serde", "1.0.0", registry),
        )]);
        let after = BTreeMap::from([("Cargo.lock".into(), lock("serde", "1.0.0", registry))]);
        let manifests = |members: Vec<String>, workspace_lock: Option<String>| {
            BTreeMap::from([(
                "package/Cargo.lock".into(),
                RemovedManifest {
                    manifest: "package/Cargo.toml".into(),
                    workspace_lock,
                    members,
                },
            )])
        };
        assert_eq!(
            Diff {
                selector: "auto".into(),
                before: before.clone(),
                after: after.clone(),
                removed_manifests: manifests(
                    vec!["package/Cargo.toml".into()],
                    Some("Cargo.lock".into())
                ),
            }
            .introduced()?,
            Vec::<Package>::new()
        );
        for (members, workspace_lock) in [
            (vec![], Some("Cargo.lock".into())),
            (
                vec!["package/Cargo.toml".into()],
                Some("untracked/Cargo.lock".into()),
            ),
            (
                vec!["unrelated/Cargo.toml".into()],
                Some("Cargo.lock".into()),
            ),
        ] {
            let rejected = Diff {
                selector: "auto".into(),
                before: before.clone(),
                after: after.clone(),
                removed_manifests: manifests(members, workspace_lock),
            }
            .introduced();
            assert!(
                rejected
                    .err()
                    .is_some_and(|error| error.to_string().contains("still exists"))
            );
        }
        let explicit = Diff {
            selector: "package/Cargo.lock".into(),
            before: before.clone(),
            after: BTreeMap::new(),
            removed_manifests: BTreeMap::new(),
        }
        .introduced();
        assert!(
            explicit
                .err()
                .is_some_and(|error| error.to_string().contains("explicitly selected"))
        );
        assert_eq!(
            Diff {
                selector: "auto".into(),
                before,
                after: BTreeMap::new(),
                removed_manifests: BTreeMap::new(),
            }
            .introduced()?,
            Vec::<Package>::new()
        );
        Ok(())
    }

    #[test]
    fn external_registry_versions_remain_quarantined_across_first_party_updates()
    -> Result<(), Box<dyn std::error::Error>> {
        let index = "registry+https://index.crates.io/";
        let git_old = "git+https://github.com/codeandsolder/own#old";
        let git_new = "git+https://github.com/codeandsolder/own#new";
        let prior = lock("serde", "1.0.0", index) + &lock("own", "0.1.0", git_old);
        let current = prior.replace(git_old, git_new)
            + &lock("serde", "1.0.1", index)
            + &lock(
                "other",
                "1.0.0",
                "registry+https://example.invalid/third-party",
            );
        let introduced = Diff {
            selector: "auto".into(),
            before: BTreeMap::from([("a/Cargo.lock".into(), prior)]),
            after: BTreeMap::from([("b/Cargo.lock".into(), current)]),
            removed_manifests: BTreeMap::new(),
        }
        .introduced()?;
        assert_eq!(
            introduced
                .iter()
                .map(|pkg| (pkg.name.as_str(), pkg.version.as_str()))
                .collect::<Vec<_>>(),
            [("serde", "1.0.1")],
        );
        Ok(())
    }
}
