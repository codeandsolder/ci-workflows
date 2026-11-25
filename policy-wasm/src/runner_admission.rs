//! Runner capacity decisions are portable policy, not GitHub transport.
//! The host batches all jobs and obtains actual runner registrations via the
//! GitHub API only when the portable policy encounters a custom selector.
use std::{
    error::Error,
    io::{self, Read},
    sync::OnceLock,
};

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Require,
    Audit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: Mode,
    requests: Vec<Vec<String>>,
    runners: Vec<Runner>,
}

#[derive(Deserialize)]
struct Runner {
    name: String,
    status: String,
    busy: Option<bool>,
    labels: Vec<RunnerLabel>,
}

#[derive(Deserialize)]
struct RunnerLabel {
    name: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Unregistered,
    Offline,
    Busy,
    Available,
    NotSelfHosted,
    Unresolved,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct Decision {
    status: Status,
    matching: Vec<String>,
    online: Vec<String>,
    idle: Vec<String>,
}

impl Decision {
    const fn empty(status: Status) -> Self {
        Self {
            status,
            matching: Vec::new(),
            online: Vec::new(),
            idle: Vec::new(),
        }
    }
}

fn is_standard_hosted(labels: &[String]) -> Result<bool, Box<dyn Error>> {
    static HOSTED: OnceLock<Result<Regex, regex::Error>> = OnceLock::new();
    let pattern = HOSTED.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:ubuntu-(?:latest|slim|[0-9]+[.][0-9]+)(?:-arm)?|windows-(?:latest|[0-9]+)(?:-arm)?|macos-(?:latest|[0-9]+)(?:-large|-xlarge|-intel)?|ubuntu-latest-m|macos-latest-xlarge)$",
        )
    }).as_ref().map_err(|err| format!("invalid static hosted runner selector: {err}"))?;
    Ok(labels.len() == 1 && pattern.is_match(&labels[0]))
}

fn classified(input: &Input) -> Result<Vec<Decision>, Box<dyn Error>> {
    let mut decisions = Vec::with_capacity(input.requests.len());
    for labels in &input.requests {
        if labels.is_empty() {
            match input.mode {
                Mode::Audit => {
                    decisions.push(Decision::empty(Status::Unresolved));
                    continue;
                }
                Mode::Require => return Err("runner selector must not be empty".into()),
            }
        }
        if labels.iter().any(|label| label.trim().is_empty()) {
            return Err("runner selector contains an empty label".into());
        }

        if matches!(input.mode, Mode::Audit) && is_standard_hosted(labels)? {
            decisions.push(Decision::empty(Status::NotSelfHosted));
            continue;
        }

        let required: Vec<String> = labels.iter().map(|label| label.to_lowercase()).collect();
        let mut matching = Vec::new();
        let mut online = Vec::new();
        let mut idle = Vec::new();
        for runner in &input.runners {
            let actual: Vec<String> = runner
                .labels
                .iter()
                .map(|label| label.name.to_lowercase())
                .collect();
            if !required.iter().all(|label| actual.contains(label)) {
                continue;
            }
            matching.push(runner.name.clone());
            if runner.status == "online" {
                online.push(runner.name.clone());
                if runner.busy == Some(false) {
                    idle.push(runner.name.clone());
                }
            }
        }
        let status = if matching.is_empty() {
            Status::Unregistered
        } else if online.is_empty() {
            Status::Offline
        } else if idle.is_empty() {
            Status::Busy
        } else {
            Status::Available
        };
        decisions.push(Decision {
            status,
            matching,
            online,
            idle,
        });
    }
    Ok(decisions)
}

pub fn execute() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let payload: Input = serde_json::from_str(&input)?;
    serde_json::to_writer(io::stdout().lock(), &classified(&payload)?)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Decision, Input, Status, classified};
    use serde_json::{from_value, json};
    use std::error::Error;

    fn classify(
        mode: &str,
        requests: &serde_json::Value,
        runners: &serde_json::Value,
    ) -> Result<Vec<Decision>, Box<dyn Error>> {
        let input: Input = from_value(json!({
            "mode": mode,
            "requests": requests,
            "runners": runners,
        }))?;
        classified(&input)
    }

    #[test]
    fn registered_offline_busy_and_available() -> Result<(), Box<dyn Error>> {
        let labels = json!([["SELF-HOSTED", "Linux", "X64", "local-ci"]]);
        let acer = json!({"name":"acer", "status":"online", "busy":true,
            "labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"x64"},{"name":"local-ci"}]});
        let asus = json!({"name":"asus", "status":"online", "busy":false,
            "labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"x64"},{"name":"local-ci"}]});
        assert_eq!(
            classify("require", &labels, &json!([]))?[0].status,
            Status::Unregistered
        );
        assert_eq!(classify("require", &labels, &json!([{
            "name":"acer", "status":"offline", "busy":false,
            "labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"x64"},{"name":"local-ci"}]
        }]))?[0].status,Status::Offline);
        assert_eq!(
            classify("require", &labels, &json!([acer]))?[0].status,
            Status::Busy
        );
        let result = classify("require", &labels, &json!([acer, asus]))?;
        assert_eq!(result[0].status, Status::Available);
        assert_eq!(result[0].matching, vec!["acer", "asus"]);
        assert_eq!(result[0].online, vec!["acer", "asus"]);
        assert_eq!(result[0].idle, vec!["asus"]);
        Ok(())
    }

    #[test]
    fn hosted_exact_label_semantics() -> Result<(), Box<dyn Error>> {
        let hosted = [
            "ubuntu-latest",
            "ubuntu-26.04",
            "ubuntu-24.04-arm",
            "ubuntu-slim",
            "windows-2025",
            "windows-latest-arm",
            "macos-15",
            "macos-latest-xlarge",
            "macos-15-intel",
            "macos-15-large",
            "UBUNTU-LATEST-M",
        ];
        let customs = [
            "self-hosted",
            "ubuntu-25",
            "ubuntu-latest-custom",
            "windows-2025-custom",
            "macos-15-arm",
            "macos-slim",
            "ubuntu-latest ",
        ];
        let mut requests: Vec<Vec<String>> = hosted.iter().map(|&v| vec![v.into()]).collect();
        requests.extend(customs.iter().map(|&v| vec![v.into()]));
        let result = classify("audit", &json!(requests), &json!([]))?;
        for d in result.iter().take(hosted.len()) {
            assert_eq!(d.status, Status::NotSelfHosted);
        }
        for d in result.iter().skip(hosted.len()) {
            assert_eq!(d.status, Status::Unregistered);
        }
        Ok(())
    }

    #[test]
    fn empty_selectors_audit_unresolved_require_rejected() -> Result<(), Box<dyn Error>> {
        let inputs = json!([[], ["ubuntu-latest"]]);
        assert_eq!(
            classify("audit", &inputs, &json!([]))?[0].status,
            Status::Unresolved
        );
        assert!(classify("require", &inputs, &json!([])).is_err());
        assert!(classify("audit", &json!([[""]]), &json!([])).is_err());
        assert!(classify("require", &json!([["  "]]), &json!([])).is_err());
        Ok(())
    }

    #[test]
    fn lack_of_busy_field_does_not_claim_idle() -> Result<(), Box<dyn Error>> {
        let result = classify(
            "require",
            &json!([["bench"]]),
            &json!([
                {"name":"compute","status":"online","labels":[{"name":"bench"}]}
            ]),
        )?;
        assert_eq!(result[0].status, Status::Busy);
        assert_eq!(result[0].idle, Vec::<String>::new());
        Ok(())
    }

    #[test]
    fn malformed_api_payload_fails_closed() {
        for runners in [
            json!([{"name":1,"status":"online","busy":false,"labels":[]}]),
            json!([{"name":"compute","status":"online","busy":"false","labels":[]}]),
            json!([{"name":"compute","status":"online","busy":false,"labels":[1]}]),
        ] {
            assert!(classify("audit", &json!([["self-hosted"]]), &runners).is_err());
        }
    }

    #[test]
    fn multi_job_output_preserves_input_order() -> Result<(), Box<dyn Error>> {
        let res = classify(
            "audit",
            &json!([["self-hosted"], ["ubuntu-latest"], [], ["custom"]]),
            &json!([
                {"name":"compute","status":"online","busy":false,
                 "labels":[{"name":"self-hosted"}]}
            ]),
        )?;
        assert_eq!(
            res.iter().map(|d| &d.status).collect::<Vec<_>>(),
            vec![
                &Status::Available,
                &Status::NotSelfHosted,
                &Status::Unresolved,
                &Status::Unregistered
            ]
        );
        Ok(())
    }
}
