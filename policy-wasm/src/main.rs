mod concurrency;
mod yaml;

use std::{env, error::Error, path::PathBuf, process::ExitCode};

fn run() -> Result<ExitCode, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let (Some(policy), Some(root), None) = (args.next(), args.next(), args.next()) else {
        return Err("usage: ci-policy concurrency ROOT".into());
    };
    if policy != "concurrency" {
        return Err(format!("unknown policy: {policy}").into());
    }
    let problems = concurrency::inspect(&PathBuf::from(root))?;
    if problems.is_empty() {
        println!("Shared CI: workflows satisfy cancellation and portable runner policy");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("Shared CI: workflow policy failures:");
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
