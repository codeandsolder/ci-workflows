use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::process::Command;
use std::time::Duration;

const LISTEN_ADDR: &str = "100.65.0.2:3903";
const REQUIRED_TAG: &str = "tag:sccache-worker";
const GARAGE_BIN: &str = "/srv/scratch/garage-jlc/bin/garage";
const GARAGE_CONFIG: &str = "/srv/scratch/garage-jlc/garage.toml";
const GARAGE_KEY_NAME: &str = "github-actions-sccache";
const SCCACHE_CLIENT_CONFIG: &str = "/etc/sccache/config";

fn http_response(stream: &mut TcpStream, status: &str, body: &str, content_type: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn tailscale_peer_has_tag(ip: IpAddr) -> Result<bool, String> {
    let output = Command::new("/usr/bin/tailscale")
        .args(["whois", &ip.to_string()])
        .output()
        .map_err(|error| format!("failed to run tailscale whois: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "tailscale whois failed with status {}",
            output.status
        ));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("tailscale whois returned invalid UTF-8: {error}"))?;

    Ok(stdout.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed
            .strip_prefix("Tags:")
            .is_some_and(|tags| tags.split_whitespace().any(|tag| tag == REQUIRED_TAG))
    }))
}

fn garage_credentials() -> Result<(String, String), String> {
    let output = Command::new(GARAGE_BIN)
        .args([
            "-c",
            GARAGE_CONFIG,
            "key",
            "info",
            "--show-secret",
            GARAGE_KEY_NAME,
        ])
        .output()
        .map_err(|error| format!("failed to run Garage CLI: {error}"))?;

    if !output.status.success() {
        return Err(format!("Garage CLI failed with status {}", output.status));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("Garage CLI returned invalid UTF-8: {error}"))?;

    let access_key = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Key ID:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Garage output did not contain a key ID".to_owned())?;

    let secret_key = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Secret key:"))
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "(redacted)")
        .ok_or_else(|| "Garage output did not contain a secret key".to_owned())?;

    Ok((access_key.to_owned(), secret_key.to_owned()))
}

fn scheduler_credentials() -> Result<(String, String), String> {
    let config = std::fs::read_to_string(SCCACHE_CLIENT_CONFIG)
        .map_err(|error| format!("failed to read sccache client config: {error}"))?;

    let mut section = "";
    let mut scheduler_url = None;
    let mut token = None;

    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = raw_value.trim().trim_matches('"');

        match (section, key) {
            ("dist", "scheduler_url") if !value.is_empty() => {
                scheduler_url = Some(value.to_owned());
            }
            ("dist.auth", "token") if !value.is_empty() => {
                token = Some(value.to_owned());
            }
            _ => {}
        }
    }

    let scheduler_url = scheduler_url
        .ok_or_else(|| "sccache config did not contain dist.scheduler_url".to_owned())?;
    let token = token.ok_or_else(|| "sccache config did not contain dist.auth.token".to_owned())?;

    Ok((scheduler_url, token))
}

fn json_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", c as u32);
            }
            c => output.push(c),
        }
    }
    output
}

fn handle_connection(mut stream: TcpStream) {
    if stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .is_err()
    {
        return;
    }
    let peer_ip = match stream.peer_addr() {
        Ok(address) => address.ip(),
        Err(_) => return,
    };

    let mut buffer = [0_u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(0) | Err(_) => return,
        Ok(bytes_read) => bytes_read,
    };
    let Ok(request) = std::str::from_utf8(&buffer[..bytes_read]) else {
        http_response(
            &mut stream,
            "400 Bad Request",
            "invalid request\n",
            "text/plain",
        );
        return;
    };

    let request_line = request.lines().next().unwrap_or_default();
    if request_line == "GET /health HTTP/1.1" {
        http_response(&mut stream, "200 OK", "ok\n", "text/plain");
        return;
    }

    if request_line != "GET /v1/sccache-credentials HTTP/1.1" {
        http_response(&mut stream, "404 Not Found", "not found\n", "text/plain");
        return;
    }

    match tailscale_peer_has_tag(peer_ip) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("denied credentials request from untagged peer {peer_ip}");
            http_response(&mut stream, "403 Forbidden", "forbidden\n", "text/plain");
            return;
        }
        Err(error) => {
            eprintln!("peer identity lookup failed for {peer_ip}: {error}");
            http_response(
                &mut stream,
                "503 Service Unavailable",
                "identity lookup failed\n",
                "text/plain",
            );
            return;
        }
    }

    let (access_key, secret_key) = match garage_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            eprintln!("Garage credential lookup failed: {error}");
            http_response(
                &mut stream,
                "503 Service Unavailable",
                "credential lookup failed\n",
                "text/plain",
            );
            return;
        }
    };

    let (scheduler_url, scheduler_token) = match scheduler_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            eprintln!("scheduler credential lookup failed: {error}");
            http_response(
                &mut stream,
                "503 Service Unavailable",
                "scheduler credential lookup failed\n",
                "text/plain",
            );
            return;
        }
    };

    let body = format!(
        "{{\"access_key_id\":\"{}\",\"secret_access_key\":\"{}\",\"endpoint\":\"http://100.65.0.2:3902\",\"bucket\":\"sccache\",\"region\":\"garage-jlc\",\"key_prefix\":\"rust/\",\"scheduler_url\":\"{}\",\"scheduler_token\":\"{}\"}}\n",
        json_escape(&access_key),
        json_escape(&secret_key),
        json_escape(&scheduler_url),
        json_escape(&scheduler_token)
    );
    http_response(&mut stream, "200 OK", &body, "application/json");
    eprintln!("issued sccache credentials to tagged peer {peer_ip}");
}

fn run() -> Result<(), String> {
    let listener = TcpListener::bind(LISTEN_ADDR)
        .map_err(|error| format!("failed to bind {LISTEN_ADDR}: {error}"))?;

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle_connection(stream),
            Err(error) => eprintln!("accept failed: {error}"),
        }
    }

    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
