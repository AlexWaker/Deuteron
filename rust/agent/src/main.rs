use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const KEYCHAIN_SERVICE: &str = "dev.solgent.wallet.secret";

#[derive(Debug, Deserialize)]
struct AgentRequest {
    action: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct AgentError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Serialize)]
struct AgentResponse {
    ok: bool,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AgentError>,
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() == 1 {
        print_help();
        return;
    }

    match args[1].as_str() {
        "daemon" => {
            let socket_path = flag_value(&args, "--socket").unwrap_or_else(|| "./agent.sock".to_string());
            let pid_file = flag_value(&args, "--pid-file");

            if let Err(error) = run_daemon(&socket_path, pid_file.as_deref()) {
                eprintln!("solgent-agent failed: {error}");
                process::exit(1);
            }
        }
        "version" | "--version" | "-v" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
        "help" | "--help" | "-h" => {
            print_help();
        }
        other => {
            eprintln!("unknown command: {other}");
            process::exit(1);
        }
    }
}

fn run_daemon(socket_path: &str, pid_file: Option<&str>) -> io::Result<()> {
    if let Some(parent) = Path::new(socket_path).parent() {
        fs::create_dir_all(parent)?;
    }

    if Path::new(socket_path).exists() {
        fs::remove_file(socket_path)?;
    }

    let listener = UnixListener::bind(socket_path)?;
    fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600))?;

    if let Some(pid_path) = pid_file {
        if let Some(parent) = Path::new(pid_path).parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(pid_path, format!("{}\n", process::id()))?;
    }

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let running = Arc::new(AtomicBool::new(true));

    listener.set_nonblocking(true)?;

    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                handle_client(stream, started_at, socket_path, running.clone())?;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                cleanup(socket_path, pid_file)?;
                return Err(error);
            }
        }
    }

    cleanup(socket_path, pid_file)
}

fn handle_client(
    mut stream: UnixStream,
    started_at: u64,
    socket_path: &str,
    running: Arc<AtomicBool>,
) -> io::Result<()> {
    let mut request = String::new();
    let mut reader = BufReader::new(stream.try_clone()?);
    reader.read_line(&mut request)?;

    let payload = match parse_request(request.trim()) {
        Ok(agent_request) => respond(agent_request, started_at, socket_path, running),
        Err(error) => error_response("agent.invalid_request", error, None),
    };

    let payload = serde_json::to_string(&payload)
        .unwrap_or_else(|_| String::from("{\"ok\":false,\"code\":\"agent.serialize_failed\",\"error\":{\"message\":\"Failed to serialize response\"}}"));
    stream.write_all(payload.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn cleanup(socket_path: &str, pid_file: Option<&str>) -> io::Result<()> {
    if Path::new(socket_path).exists() {
        fs::remove_file(socket_path)?;
    }

    if let Some(pid_path) = pid_file {
        if Path::new(pid_path).exists() {
            fs::remove_file(pid_path)?;
        }
    }

    Ok(())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

fn parse_request(raw: &str) -> Result<AgentRequest, String> {
    if raw.is_empty() {
        return Err(String::from("Request payload is empty"));
    }

    if raw.starts_with('{') {
        serde_json::from_str(raw).map_err(|error| format!("Invalid JSON request: {error}"))
    } else {
        Ok(AgentRequest {
            action: raw.to_string(),
            params: None,
        })
    }
}

fn respond(
    request: AgentRequest,
    started_at: u64,
    socket_path: &str,
    running: Arc<AtomicBool>,
) -> AgentResponse {
    match request.action.as_str() {
        "ping" => success_response(
            "agent.pong",
            json!({
                "reply": "pong",
                "pid": process::id(),
                "version": env!("CARGO_PKG_VERSION"),
                "started_at": started_at,
                "socket": socket_path,
            }),
        ),
        "status" => success_response(
            "agent.running",
            json!({
                "reply": "running",
                "pid": process::id(),
                "version": env!("CARGO_PKG_VERSION"),
                "started_at": started_at,
                "socket": socket_path,
            }),
        ),
        "stop" => {
            running.store(false, Ordering::SeqCst);
            success_response(
                "agent.stopping",
                json!({
                    "reply": "stopping",
                    "pid": process::id(),
                    "version": env!("CARGO_PKG_VERSION"),
                    "started_at": started_at,
                    "socket": socket_path,
                }),
            )
        }
        "store_secret" => match get_required_param(&request.params, "key")
            .and_then(|key| get_required_param(&request.params, "value").map(|value| (key, value)))
        {
            Ok((key, value)) => match set_secret(&key, &value) {
                Ok(()) => success_response("secret.stored", json!({ "key": key })),
                Err(error) => error_response("secret.store_failed", error, Some(json!({ "key": key }))),
            },
            Err(error) => error_response("secret.invalid_request", error, None),
        },
        "read_secret" => match get_required_param(&request.params, "key") {
            Ok(key) => match get_secret(&key) {
                Ok(secret) => success_response("secret.loaded", json!({ "key": key, "value": secret })),
                Err(error) => error_response("secret.read_failed", error, Some(json!({ "key": key }))),
            },
            Err(error) => error_response("secret.invalid_request", error, None),
        },
        "delete_secret" => match get_required_param(&request.params, "key") {
            Ok(key) => match delete_secret(&key) {
                Ok(found) => success_response(
                    if found { "secret.deleted" } else { "secret.missing" },
                    json!({ "key": key, "found": found }),
                ),
                Err(error) => error_response("secret.delete_failed", error, Some(json!({ "key": key }))),
            },
            Err(error) => error_response("secret.invalid_request", error, None),
        },
        other => error_response(
            "agent.unknown_action",
            format!("Unknown command: {other}"),
            Some(json!({ "action": other })),
        ),
    }
}

fn get_required_param(params: &Option<Value>, field: &str) -> Result<String, String> {
    let value = params
        .as_ref()
        .and_then(|payload| payload.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match value {
        Some(value) => Ok(value.to_string()),
        None => Err(format!("Missing required field: {field}")),
    }
}

fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())?;
    entry.set_password(value).map_err(|error| error.to_string())
}

fn get_secret(key: &str) -> Result<String, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())?;
    entry.get_password().map_err(|error| match error {
        KeyringError::NoEntry => format!("Secret not found: {key}"),
        other => other.to_string(),
    })
}

fn delete_secret(key: &str) -> Result<bool, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())?;

    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn success_response(code: &str, data: Value) -> AgentResponse {
    AgentResponse {
        ok: true,
        code: code.to_string(),
        data: Some(data),
        error: None,
    }
}

fn error_response(code: &str, message: String, details: Option<Value>) -> AgentResponse {
    AgentResponse {
        ok: false,
        code: code.to_string(),
        data: None,
        error: Some(AgentError { message, details }),
    }
}

fn print_help() {
    println!("Solgent native agent\n\nUsage:\n  solgent-agent daemon --socket <path> [--pid-file <path>]\n  solgent-agent version");
}