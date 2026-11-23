mod cache;
mod cargo_affected;
mod checklist_labels;
mod clones;
mod concurrency;
mod quarantine;
mod rust_tests;
mod shell;
mod workspace;
mod yaml;

use std::{
    env,
    error::Error,
    path::{Path, PathBuf},
    process::ExitCode,
};

fn run() -> Result<ExitCode, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let (Some(policy), Some(root)) = (args.next(), args.next()) else {
        return Err("usage: ci-policy concurrency|sccache ROOT [STRICT_REF]".into());
    };
    let root = Path::new(&root);
    match policy.as_str() {
        "cargo-affected-plan" | "cargo-affected-args" => {
            cargo_affected::decide(&policy)?;
            return Ok(ExitCode::SUCCESS);
        }
        "quarantine-diff" => {
            quarantine::diff()?;
            return Ok(ExitCode::SUCCESS);
        }
        "quarantine-age" => {
            quarantine::age()?;
            return Ok(ExitCode::SUCCESS);
        }
        _ => {}
    }
    if policy == "checklist-labels" {
        let (Some(template), Some(workflow), Some(heading), Some(key), None) = (
            args.next(),
            args.next(),
            args.next(),
            args.next(),
            args.next(),
        ) else {
            return Err(
                "usage: ci-policy checklist-labels ROOT TEMPLATE WORKFLOW HEADING ENV_KEY".into(),
            );
        };
        let issues = checklist_labels::inspect(root, &template, &workflow, &heading, &key)?;
        if issues.is_empty() {
            println!("Shared CI: checklist labels match the PR template");
            return Ok(ExitCode::SUCCESS);
        }
        for issue in issues {
            eprintln!("ci-policy: {issue}");
        }
        return Ok(ExitCode::from(1));
    }
    if policy == "clones" {
        let (Some(scan), Some(production), Some(testing), None) =
            (args.next(), args.next(), args.next(), args.next())
        else {
            return Err("usage: ci-policy clones ROOT SCAN_ROOT PROD_TOKENS TEST_TOKENS".into());
        };
        clones::classify(
            root,
            Path::new(&scan),
            production.parse()?,
            testing.parse()?,
        )?;
        return Ok(ExitCode::SUCCESS);
    }
    let strict_ref = if policy == "sccache" {
        args.next()
    } else {
        None
    };
    let paths = args.map(PathBuf::from).collect();
    let (problems, success, failure) = match policy.as_str() {
        "concurrency" => (
            concurrency::inspect(root, paths)?,
            "Shared CI: workflows satisfy cancellation and portable runner policy",
            "Shared CI: workflow policy failures:",
        ),
        "sccache" => (
            cache::inspect(
                root,
                strict_ref.as_deref().filter(|value| !value.is_empty()),
                paths,
            )?,
            "ci-workflows: every detected Rust CI job uses canonical sccache",
            "ci-workflows: Rust CI sccache policy violations:",
        ),
        _ => return Err(format!("unknown policy: {policy}").into()),
    };
    if problems.is_empty() {
        println!("{success}");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("{failure}");
        for problem in problems {
            println!("- {problem}");
        }
        Ok(ExitCode::from(1))
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("ci-policy: {error}");
            ExitCode::from(2)
        }
    }
}
