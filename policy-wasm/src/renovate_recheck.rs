//! Strictly read-only decisions for the Renovate expired-quarantine retry
//! controller. GitHub API inventory and the rerun mutation remain native.
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, Read},
};

const HEADER: &str = "Cargo release-age quarantine is still active:";

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Input {
    Hold {
        log: String,
    },
    Job {
        job: Value,
        pr_head: String,
    },
    Checks {
        checks: Vec<Value>,
    },
    Eligibility {
        hold: Value,
        now_ms: i64,
        grace_ms: i64,
    },
}

fn no_hold(reason: &str) -> Value {
    json!({"eligible":false,"reason":reason})
}

fn decimal(capture: &regex::Captures<'_>, index: usize) -> Result<i64, Box<dyn Error>> {
    Ok(capture
        .get(index)
        .ok_or("missing timestamp field")?
        .as_str()
        .parse()?)
}

// Convert an exact RFC3339 timestamp to the *earliest safe integral ms*.
// Round sub-millisecond publication fractions upward to never release early.
fn timestamp_ms(input: &str) -> Result<i64, Box<dyn Error>> {
    let pattern = Regex::new(
        r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$",
    )?;
    let caps = pattern
        .captures(input)
        .ok_or("invalid RFC3339 publication timestamp")?;
    let y = decimal(&caps, 1)?;
    let m = decimal(&caps, 2)?;
    let d = decimal(&caps, 3)?;
    let hour = decimal(&caps, 4)?;
    let minute = decimal(&caps, 5)?;
    let second = decimal(&caps, 6)?;
    if y < 1 || !(1..=12).contains(&m) || hour > 23 || minute > 59 || second > 59 {
        return Err("invalid publication calendar fields".into());
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days_in_month = [
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
    if !(1..=days_in_month[usize::try_from(m - 1)?]).contains(&d) {
        return Err("invalid publication calendar date".into());
    }

    // Howard Hinnant's civil-to-days Gregorian calendar conversion.
    let year = y - i64::from(m <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = m + if m > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + d - 1;
    let year_day = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + year_day - 719_468;

    let offset = caps.get(8).ok_or("missing timezone offset")?.as_str();
    let offset_seconds = if offset == "Z" {
        0
    } else {
        let offset_hours: i64 = offset[1..3].parse()?;
        let offset_minutes: i64 = offset[4..6].parse()?;
        if offset_hours > 23 || offset_minutes > 59 {
            return Err("invalid publication timezone offset".into());
        }
        let seconds = offset_hours * 3600 + offset_minutes * 60;
        if offset.starts_with('-') {
            -seconds
        } else {
            seconds
        }
    };
    let seconds = days_since_epoch * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds;
    let ms = if let Some(fraction) = caps.get(7) {
        let digits = fraction.as_str();
        let whole: i64 = digits[..digits.len().min(3)].parse()?;
        let mut milli = whole * 10_i64.pow(3 - u32::try_from(digits.len().min(3))?);
        if digits.len() > 3 && digits[3..].bytes().any(|b| b != b'0') {
            milli += 1;
        }
        milli
    } else {
        0
    };
    seconds
        .checked_mul(1000)
        .and_then(|t| t.checked_add(ms))
        .ok_or_else(|| "publication timestamp out of supported range".into())
}

fn hold(log: &str) -> Result<Value, Box<dyn Error>> {
    let ansi = Regex::new(r"\x1b\[[0-9;]*m")?;
    let prefix = Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T\S+?\s+")?;
    let line =
        Regex::new(r"^-\s+([a-zA-Z0-9_-]+)\s+(\S+): published (\S+), younger than ([0-9]+)h$")?;
    let clean = ansi.replace_all(log, "");
    let lines: Vec<&str> = clean.lines().collect();
    let mut markers = 0;
    let mut blocks = Vec::new();
    let mut eligible_at: Option<i64> = None;
    for (i, current) in lines.iter().enumerate() {
        if !current.contains(HEADER) {
            continue;
        }
        markers += 1;
        let mut entries = 0;
        for follow in lines.iter().skip(i + 1) {
            let body = prefix.replace(follow, "");
            let text = body.trim();
            if !text.starts_with("- ") {
                break;
            }
            let Some(captures) = line.captures(text) else {
                return Ok(no_hold("unknown-quarantine-reason"));
            };
            let name = captures.get(1).ok_or("missing crate name")?.as_str();
            let version = captures.get(2).ok_or("missing crate version")?.as_str();
            let published_at = captures.get(3).ok_or("missing publication time")?.as_str();
            let hours: u64 = captures
                .get(4)
                .ok_or("missing age threshold")?
                .as_str()
                .parse()?;
            let Ok(published_ms) = timestamp_ms(published_at) else {
                return Ok(no_hold("invalid-age-metadata"));
            };
            let Some(eligible) = i128::from(hours)
                .checked_mul(3_600_000)
                .and_then(|age| i128::from(published_ms).checked_add(age))
                .and_then(|value| i64::try_from(value).ok())
            else {
                return Ok(no_hold("invalid-age-metadata"));
            };
            if hours < 72 {
                return Ok(no_hold("invalid-age-metadata"));
            }
            blocks.push(json!({
                "name":name,"version":version,"publishedAt":published_at,
                "eligibleAt":eligible,"hours":hours
            }));
            eligible_at = Some(eligible_at.map_or(eligible, |old| old.max(eligible)));
            entries += 1;
        }
        if entries == 0 {
            return Ok(no_hold("no-crates"));
        }
    }
    if markers == 0 {
        return Ok(no_hold("not-a-quarantine-hold"));
    }
    let Some(eligible_at) = eligible_at else {
        return Ok(no_hold("invalid-eligibility"));
    };
    Ok(json!({"eligible":true,"blockers":blocks,"eligibleAt":eligible_at}))
}

fn inspect_job(job: &Value, pr_head: &str) -> Value {
    if job.get("status").and_then(Value::as_str) != Some("completed")
        || job.get("conclusion").and_then(Value::as_str) != Some("failure")
        || job.get("head_sha").and_then(Value::as_str) != Some(pr_head)
    {
        return json!("stale-or-not-failed");
    }
    if job.get("run_attempt").and_then(Value::as_u64) != Some(1) {
        return json!("already-retried");
    }
    let failures = job
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|step| step.get("conclusion").and_then(Value::as_str) == Some("failure"));
    let mut any = false;
    for step in failures {
        any = true;
        let label = step.get("name").and_then(Value::as_str).unwrap_or("");
        let label = label.to_ascii_lowercase();
        if !label.contains("quarantine")
            && !label.contains("release.age")
            && !label.contains("release-age")
        {
            return json!("other-job-failure");
        }
    }
    if any {
        Value::Null
    } else {
        json!("other-job-failure")
    }
}

fn checks(checks: &[Value]) -> Value {
    if checks
        .iter()
        .any(|c| c.get("status").and_then(Value::as_str) != Some("completed"))
    {
        return Value::Null;
    }
    let failures: Vec<&Value> = checks
        .iter()
        .filter(|c| {
            !matches!(
                c.get("conclusion").and_then(Value::as_str),
                Some("success" | "skipped" | "neutral")
            )
        })
        .collect();
    if failures.is_empty()
        || failures.iter().any(|c| {
            c.get("app")
                .and_then(|app| app.get("slug"))
                .and_then(Value::as_str)
                != Some("github-actions")
                || c.get("conclusion").and_then(Value::as_str) != Some("failure")
        })
    {
        return Value::Null;
    }
    json!(failures)
}

fn eligibility(hold: &Value, now: i64, grace: i64) -> Value {
    if hold.get("eligible").and_then(Value::as_bool) != Some(true) {
        return json!(
            hold.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("invalid-quarantine-hold")
        );
    }
    let Some(at) = hold.get("eligibleAt").and_then(Value::as_i64) else {
        return json!("invalid-age-metadata");
    };
    if grace < 0 {
        return json!("invalid-age-metadata");
    }
    if i128::from(now) >= i128::from(at) + i128::from(grace) {
        Value::Null
    } else {
        json!("release-too-young")
    }
}

fn evaluate(input: Input) -> Result<Value, Box<dyn Error>> {
    match input {
        Input::Hold { log } => hold(&log),
        Input::Job { job, pr_head } => Ok(inspect_job(&job, &pr_head)),
        Input::Checks { checks: array } => Ok(checks(&array)),
        Input::Eligibility {
            hold,
            now_ms,
            grace_ms,
        } => Ok(eligibility(&hold, now_ms, grace_ms)),
    }
}

pub fn execute() -> Result<(), Box<dyn Error>> {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text)?;
    let input = serde_json::from_str(&text)?;
    let result = evaluate(input)?;
    serde_json::to_writer(io::stdout().lock(), &result)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{checks, eligibility, hold, inspect_job, timestamp_ms};
    use serde_json::{Value, json};

    #[test]
    fn date_parse_tz_gregorian_fraction_and_bounds() -> Result<(), Box<dyn std::error::Error>> {
        let utc = timestamp_ms("2026-11-11T21:56:00Z")?;
        assert_eq!(timestamp_ms("2026-11-11T22:56:00+01:00").ok(), Some(utc));
        assert_eq!(timestamp_ms("2026-11-11T19:56:00-02:00").ok(), Some(utc));
        assert_eq!(
            timestamp_ms("2026-11-11T21:56:00.123Z").ok(),
            Some(utc + 123)
        );
        assert_eq!(
            timestamp_ms("2026-11-11T21:56:00.123456Z").ok(),
            Some(utc + 124)
        );
        assert!(timestamp_ms("2024-02-29T00:00:00Z").is_ok());
        for bad in [
            "2100-02-29T00:00:00Z",
            "2026-02-31T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-11-11T24:00:00Z",
            "2026-11-11T21:60:00Z",
            "2026-11-11T21:00:61Z",
            "2026-11-11T21:00:00+25:00",
            "2026-11-11T21:00:00",
        ] {
            assert!(timestamp_ms(bad).is_err(), "{bad}");
        }
        Ok(())
    }

    #[test]
    fn all_crates_mature_with_exact_grace() -> Result<(), Box<dyn std::error::Error>> {
        let log = "2026-11-12T01:00:00Z Cargo release-age quarantine is still active:\n\
2026-11-12T01:00:01Z - abc 1.2.3: published 2026-11-11T21:56:00+00:00, younger than 72h\n\
2026-11-12T01:00:01Z - def 0.2.4: published 2026-11-11T21:57:08.123456+00:00, younger than 72h\n";
        let result = hold(log)?;
        assert_eq!(result.get("eligible"), Some(&json!(true)));
        assert_eq!(result["blockers"].as_array().map(Vec::len), Some(2));
        let deadline = result["eligibleAt"].as_i64().ok_or("missing eligibleAt")?;
        assert_eq!(
            eligibility(&result, deadline + 15 * 60_000 - 1, 15 * 60_000),
            json!("release-too-young")
        );
        assert_eq!(
            eligibility(&result, deadline + 15 * 60_000, 15 * 60_000),
            Value::Null
        );
        Ok(())
    }

    #[test]
    fn invalid_log_fail_closed() -> Result<(), Box<dyn std::error::Error>> {
        for (log, expected) in [
            ("error: build failed", "not-a-quarantine-hold"),
            (
                "Cargo release-age quarantine is still active:\n",
                "no-crates",
            ),
            (
                "Cargo release-age quarantine is still active:\n- x 1.0: missing authoritative crates.io publication time\n",
                "unknown-quarantine-reason",
            ),
            (
                "Cargo release-age quarantine is still active:\n- x 1.0: published 2026-11-11T21:00:00Z, younger than 12h\n",
                "invalid-age-metadata",
            ),
            (
                "Cargo release-age quarantine is still active:\n- x 1.0: published 2026-02-31T21:00:00Z, younger than 72h\n",
                "invalid-age-metadata",
            ),
        ] {
            assert_eq!(hold(log)?["reason"], expected);
        }
        Ok(())
    }

    #[test]
    fn only_first_attempt_with_exclusive_quarantine_errors() {
        let j = json!({
            "status":"completed","conclusion":"failure","head_sha":"abc","run_attempt":1,
            "steps":[{"name":"Quarantine newly introduced crates.io versions across all workspaces","conclusion":"failure"}]
        });
        assert_eq!(inspect_job(&j, "abc"), Value::Null);
        assert_eq!(inspect_job(&j, "def"), json!("stale-or-not-failed"));
        let mut second = j.clone();
        second["run_attempt"] = json!(2);
        assert_eq!(inspect_job(&second, "abc"), json!("already-retried"));
        let mut other = j;
        other["steps"] = json!([{"name":"compile","conclusion":"failure"}]);
        assert_eq!(inspect_job(&other, "abc"), json!("other-job-failure"));
    }

    #[test]
    fn mixed_check_gate_fails_closed() {
        let held = json!({"status":"completed","conclusion":"failure","app":{"slug":"github-actions"},"id":1});
        assert_eq!(checks(std::slice::from_ref(&held)), json!([held]));
        assert_eq!(
            checks(&[held.clone(), json!({"status":"in_progress"})]),
            Value::Null
        );
        assert_eq!(
            checks(&[
                held.clone(),
                json!({"status":"completed","conclusion":"cancelled"})
            ]),
            Value::Null
        );
        assert_eq!(
            checks(&[
                held,
                json!({"status":"completed","conclusion":"failure","app":{"slug":"else"}})
            ]),
            Value::Null
        );
    }
}
