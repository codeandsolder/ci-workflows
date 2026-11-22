//! Static shell-command discovery; never executes scripts.
use regex::Regex;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

const INTERPRETERS: &[&str] = &["bash", "sh", "dash", "zsh", "ksh"];
const PREFIXES: &[&str] = &[
    "if", "then", "do", "while", "until", "!", "command", "exec", "time", "nohup",
];
const PROBES: &[&str] = &["--help", "-h", "--version", "-V", "-vV"];
const NON_COMPILING: &[&str] = &[
    "add",
    "audit",
    "clean",
    "deny",
    "fetch",
    "fmt",
    "generate-lockfile",
    "info",
    "init",
    "locate-project",
    "login",
    "logout",
    "machete",
    "metadata",
    "new",
    "owner",
    "pkgid",
    "read-manifest",
    "remove",
    "report",
    "search",
    "tree",
    "update",
    "vendor",
    "verify-project",
    "yank",
];

pub struct Scanner {
    assignment: Regex,
    continuation: Regex,
    heredoc: Regex,
    case_start: Regex,
    case_arm: Regex,
    array_start: Regex,
    malformed_compile: Regex,
    shebang: Regex,
}

#[derive(Default)]
pub struct Findings {
    pub compiles: bool,
    pub unresolved: BTreeSet<String>,
}
impl Findings {
    fn absorb(&mut self, other: Self) {
        self.compiles |= other.compiles;
        self.unresolved.extend(other.unresolved);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Quote {
    Unquoted,
    Single,
    Double,
}
enum Segment {
    Command(Vec<String>),
    Inline(String),
    MalformedCompiler,
}

enum Token {
    Word(String),
    Boundary,
}

fn flush_word(word: &mut String, started: &mut bool, tokens: &mut Vec<Token>) {
    if *started {
        tokens.push(Token::Word(std::mem::take(word)));
        *started = false;
    }
}

// Lex quotes, escapes and separators without executing shell expansions.
fn tokenize(line: &str, comments: bool, operators: bool) -> Option<Vec<Token>> {
    let mut chars = line.chars();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = Quote::Unquoted;
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::Unquoted,
            (Quote::Unquoted, '\'') => {
                started = true;
                quote = Quote::Single;
            }
            (Quote::Unquoted, '"') => {
                started = true;
                quote = Quote::Double;
            }
            (Quote::Unquoted | Quote::Double, '\\') => {
                let next = chars.next()?;
                if quote == Quote::Double && !matches!(next, '\\' | '"') {
                    word.push('\\');
                }
                word.push(next);
                started = true;
            }
            (Quote::Unquoted, '#') if comments => break,
            (Quote::Unquoted, ' ' | '\t' | '\r' | '\n') => {
                flush_word(&mut word, &mut started, &mut tokens);
            }
            (Quote::Unquoted, ';' | '&' | '|') if operators => {
                flush_word(&mut word, &mut started, &mut tokens);
                tokens.push(Token::Boundary);
            }
            _ => {
                word.push(ch);
                started = true;
            }
        }
    }
    if quote != Quote::Unquoted {
        return None;
    }
    flush_word(&mut word, &mut started, &mut tokens);
    Some(tokens)
}

fn cargo_compiles(mut tokens: &[String]) -> bool {
    while let Some((first, rest)) = tokens.split_first() {
        if !first.starts_with('+') {
            return !(PROBES.contains(&first.as_str())
                || NON_COMPILING.contains(&first.as_str())
                || (matches!(first.as_str(), "package" | "publish")
                    && rest.iter().any(|arg| arg == "--no-verify")));
        }
        tokens = rest;
    }
    false
}

pub fn cargo_action_compiles(command: &str, args: &str) -> bool {
    if command.is_empty() {
        return false;
    }
    let Some(args) = tokenize(args, false, false) else {
        return true;
    };
    let mut tokens = vec![command.to_owned()];
    tokens.extend(args.into_iter().filter_map(|token| match token {
        Token::Word(word) => Some(word),
        Token::Boundary => None,
    }));
    cargo_compiles(&tokens)
}

enum Script<'a> {
    None,
    Path(&'a str),
    Inline(&'a str),
}

fn script_target<'a>(command: &'a str, args: &'a [String]) -> Script<'a> {
    if INTERPRETERS.contains(&command) {
        if args.iter().any(|arg| arg.starts_with("<<")) {
            return Script::None;
        }
        let mut rest = args;
        let mut stdin = false;
        while let Some((arg, tail)) = rest.split_first() {
            let short = arg.strip_prefix('-').filter(|s| !s.starts_with('-'));
            if arg == "--" {
                rest = tail;
                break;
            }
            if short.is_some_and(|flags| flags.contains('c')) {
                return Script::Inline(tail.first().map_or("", String::as_str));
            }
            if matches!(arg.as_str(), "-o" | "-O" | "--rcfile" | "--init-file")
                || short.is_some_and(|flags| flags.contains('o'))
            {
                rest = tail.get(1..).unwrap_or_default();
            } else if arg.starts_with('-') {
                stdin |= short.is_some_and(|flags| flags.contains('s'));
                rest = tail;
            } else {
                break;
            }
        }
        return if stdin {
            Script::None
        } else {
            rest.first().map_or(Script::None, |s| Script::Path(s))
        };
    }
    if matches!(command, "source" | ".") {
        return args.first().map_or(Script::None, |s| Script::Path(s));
    }
    let is_path = command.starts_with("./")
        || command.starts_with("../")
        || command.starts_with('/')
        || Path::new(command)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sh") || ext.eq_ignore_ascii_case("bash"))
        || (command.contains('/')
            && !command.contains([':', '*', '?', '[', ']', '(', ')', '=', '$'])
            && !command.chars().any(char::is_whitespace));
    if is_path {
        Script::Path(command)
    } else {
        Script::None
    }
}

fn dynamic_path(value: &str) -> bool {
    value.is_empty() || value.starts_with('~') || value.contains(['$', '*', '?', '\x60'])
}

// Resolve path components and symlinks inside the guest preopen. WASI
// does not offer a portable host realpath operation.
fn repo_path(root: &Path, cwd: Option<&Path>, value: &str) -> Option<PathBuf> {
    if dynamic_path(value) {
        return None;
    }
    let value = Path::new(value);
    let absolute = if value.is_absolute() {
        value.to_owned()
    } else {
        cwd?.join(value)
    };
    let relative = absolute.strip_prefix(root).ok()?;
    let mut current = root.to_owned();
    let mut pending: Vec<_> = relative
        .components()
        .map(|c| c.as_os_str().to_owned())
        .rev()
        .collect();
    let mut links = 0;
    while let Some(part) = pending.pop() {
        match Path::new(&part).components().next()? {
            Component::CurDir => (),
            Component::ParentDir => {
                if current == root || !current.pop() {
                    return None;
                }
            }
            Component::Normal(name) => {
                let next = current.join(name);
                if let Ok(target) = fs::read_link(&next) {
                    links += 1;
                    if links > 40 {
                        return None;
                    }
                    let target = if target.is_absolute() {
                        root.clone_into(&mut current);
                        target.strip_prefix(root).ok()?.to_owned()
                    } else {
                        target
                    };
                    pending.extend(target.components().rev().map(|c| c.as_os_str().to_owned()));
                } else {
                    if fs::symlink_metadata(&next)
                        .is_ok_and(|metadata| metadata.file_type().is_symlink())
                    {
                        return None;
                    }
                    current = next;
                }
            }
            _ => return None,
        }
    }
    Some(current)
}

pub fn working_dir(root: &Path, path: &str) -> Option<PathBuf> {
    repo_path(root, Some(root), path)
}

impl Scanner {
    pub fn new() -> Result<Self, regex::Error> {
        Ok(Self {
            continuation: Regex::new(r"\\\r?\n")?,
            assignment: Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")?,
            heredoc: Regex::new(r#"<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?"#)?,
            case_start: Regex::new(r"^case\s+.+\s+in$")?,
            case_arm: Regex::new(r"^[^()]*\)\s*(.*)$")?,
            array_start: Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=\(\s*$")?,
            malformed_compile: Regex::new(
                r"(?:^|[;&|]\s*)(?:cargo|rustc|rustdoc|clippy-driver)(?:\s|\+)",
            )?,
            shebang: Regex::new(r"(?i)^#!.*(?:/| )(?:bash|sh|dash|zsh|ksh)(?:\s|$)")?,
        })
    }

    fn normalized<'a>(&self, mut tokens: &'a [String]) -> &'a [String] {
        while let Some((first, rest)) = tokens.split_first() {
            if PREFIXES.contains(&first.as_str()) || self.assignment.is_match(first) {
                tokens = rest;
                continue;
            }
            if first == "env" {
                tokens = rest;
                while let Some((arg, tail)) = tokens.split_first() {
                    if matches!(arg.as_str(), "-u" | "--unset") && !tail.is_empty() {
                        tokens = &tail[1..];
                    } else if arg.starts_with('-') || self.assignment.is_match(arg) {
                        tokens = tail;
                    } else {
                        break;
                    }
                }
                continue;
            }
            if first == "sudo" {
                tokens = rest;
                while let Some((arg, tail)) = tokens.split_first() {
                    if !arg.starts_with('-') {
                        break;
                    }
                    tokens = tail;
                }
                continue;
            }
            break;
        }
        tokens
    }

    fn compiles(mut tokens: &[String]) -> bool {
        if let [rustup, run, _, rest @ ..] = tokens
            && rustup == "rustup"
            && run == "run"
        {
            tokens = rest;
        }
        let Some((command, args)) = tokens.split_first() else {
            return false;
        };
        match command.as_str() {
            "cargo" => cargo_compiles(args),
            "rustc" | "rustdoc" | "clippy-driver" => args
                .first()
                .is_some_and(|arg| !PROBES.contains(&arg.as_str())),
            _ => false,
        }
    }

    fn is_shell(&self, path: &Path, bytes: &[u8]) -> bool {
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "sh" | "bash"))
        {
            return true;
        }
        let first_line = bytes.split(|&b| b == b'\n').next().unwrap_or_default();
        self.shebang.is_match(&String::from_utf8_lossy(first_line))
    }

    fn commands(&self, source: &str) -> Vec<Segment> {
        let source = self.continuation.replace_all(source, "");
        let mut commands = Vec::new();
        let mut terminator: Option<&str> = None;
        let mut stdin = Vec::new();
        let mut shell_stdin = false;
        let mut array_assignment = false;
        let mut case_depth = 0usize;
        for raw in source.lines() {
            let mut line = raw.trim();
            if let Some(end) = terminator {
                if line == end {
                    if shell_stdin {
                        commands.push(Segment::Inline(stdin.join("\n")));
                    }
                    terminator = None;
                    stdin.clear();
                    shell_stdin = false;
                } else if shell_stdin {
                    stdin.push(raw);
                }
                continue;
            }
            if array_assignment {
                array_assignment = !line.starts_with(')');
                continue;
            }
            if self.array_start.is_match(line) {
                array_assignment = true;
                continue;
            }
            if self.case_start.is_match(line) {
                case_depth += 1;
                continue;
            }
            if case_depth > 0 {
                if line == "esac" {
                    case_depth -= 1;
                    continue;
                }
                if let Some(arm) = self.case_arm.captures(line).and_then(|m| m.get(1)) {
                    line = arm.as_str().trim();
                }
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some(tokens) = tokenize(line, true, true) else {
                if self.malformed_compile.is_match(line) {
                    commands.push(Segment::MalformedCompiler);
                }
                continue;
            };
            if let Some(end) = self.heredoc.captures(line).and_then(|m| m.get(1)) {
                terminator = Some(end.as_str());
                shell_stdin = matches!(tokens.first(), Some(Token::Word(command)) if INTERPRETERS.contains(&command.as_str()));
            }
            let mut segment = Vec::new();
            for token in tokens {
                match token {
                    Token::Boundary if !segment.is_empty() => {
                        commands.push(Segment::Command(std::mem::take(&mut segment)));
                    }
                    Token::Boundary => (),
                    Token::Word(word) => segment.push(word),
                }
            }
            if !segment.is_empty() {
                commands.push(Segment::Command(segment));
            }
        }
        commands
    }

    pub fn inspect(&self, source: &str, root: &Path, cwd: Option<&Path>) -> Findings {
        self.inspect_inner(source, root, cwd, &mut BTreeSet::new(), 0)
    }

    fn inspect_inner(
        &self,
        source: &str,
        root: &Path,
        initial_cwd: Option<&Path>,
        visited: &mut BTreeSet<(PathBuf, Option<PathBuf>)>,
        depth: usize,
    ) -> Findings {
        let mut findings = Findings::default();
        if depth >= 128 {
            findings
                .unresolved
                .insert("shell analysis nesting limit exceeded".into());
            return findings;
        }
        let mut cwd = initial_cwd.map(Path::to_owned);
        for segment in self.commands(source) {
            let words = match segment {
                Segment::Inline(program) => {
                    findings.absorb(self.inspect_inner(
                        &program,
                        root,
                        cwd.as_deref(),
                        visited,
                        depth + 1,
                    ));
                    continue;
                }
                Segment::MalformedCompiler => {
                    findings.compiles = true;
                    continue;
                }
                Segment::Command(words) => words,
            };
            let tokens = self.normalized(&words);
            let Some((command, args)) = tokens.split_first() else {
                continue;
            };
            if Self::compiles(tokens) {
                findings.compiles = true;
                continue;
            }
            if command == "cd" {
                if let Some(destination) = args.first() {
                    cwd = repo_path(root, cwd.as_deref(), destination).filter(|path| path.is_dir());
                }
                continue;
            }
            let script = match script_target(command, args) {
                Script::None => continue,
                Script::Inline(program) => {
                    if program.trim_start().starts_with('$') || program.contains('\x60') {
                        findings
                            .unresolved
                            .insert("unresolved dynamic shell -c program".into());
                    }
                    findings.absorb(self.inspect_inner(
                        program,
                        root,
                        cwd.as_deref(),
                        visited,
                        depth + 1,
                    ));
                    continue;
                }
                Script::Path(path) => path,
            };
            let Some(path) = repo_path(root, cwd.as_deref(), script).filter(|path| path.is_file())
            else {
                findings
                    .unresolved
                    .insert(format!("unresolved local shell script: {script}"));
                continue;
            };
            let Ok(bytes) = fs::read(&path) else {
                findings
                    .unresolved
                    .insert(format!("unreadable local shell script: {script}"));
                continue;
            };
            if !matches!(command.as_str(), "source" | ".") && !self.is_shell(&path, &bytes) {
                continue;
            }
            let key = (path, cwd.clone());
            if visited.insert(key) {
                findings.absorb(self.inspect_inner(
                    &String::from_utf8_lossy(&bytes),
                    root,
                    cwd.as_deref(),
                    visited,
                    depth + 1,
                ));
            }
        }
        findings
    }
}
