mod cache;
mod concurrency;
mod shell;
mod yaml;

use std::{env, error::Error, path::Path, process::ExitCode};

fn run() -> Result<ExitCode, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let (Some(policy), Some(root)) = (args.next(), args.next()) else {
        return Err("usage: ci-policy concurrency|sccache ROOT [STRICT_REF]".into());
    };
    let strict_ref = args.next();
    if args.next().is_some() || (policy == "concurrency" && strict_ref.is_some()) {
        return Err("unexpected policy argument".into());
    }
    let root = Path::new(&root);
    let (problems, success, failure) = match policy.as_str() {
        "concurrency" => (
            concurrency::inspect(root)?,
            "Shared CI: workflows satisfy cancellation and portable runner policy",
            "Shared CI: workflow policy failures:",
        ),
        "sccache" => (
            cache::inspect(
                root,
                strict_ref.as_deref().filter(|value| !value.is_empty()),
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
