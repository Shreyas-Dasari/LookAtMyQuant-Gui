use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub model_dir: String,
    pub selected_model: Option<String>,
    pub selected_drafter: Option<String>,
    pub port: u16,
    pub auto_update: bool,
    #[serde(default = "default_true")]
    pub auto_update_deps: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub name: String,
    pub path: String,
    pub is_drafter: bool,
    pub format: String,
    pub size_gb: f64,
    pub est_ram_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelEntry {
    pub id: String,
    pub name: String,
    pub size_gb: f64,
    pub est_ram_gb: f64,
    pub is_drafter: bool,
    pub downloads: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_percent: f64,
    pub thermal_state: String,
    pub chip_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsUpdateCheck {
    pub up_to_date: bool,
    pub installed_commit: Option<String>,
    pub latest_commit: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLogEvent {
    pub ts: Option<String>,
    pub level: Option<String>,
    pub tone: String,
    pub msg: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusPayload {
    pub status: String, // "stopped" | "starting" | "running" | "stopping"
    pub port: u16,
    pub model: Option<String>,
    pub drafter: Option<String>,
    pub started_at_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub ready: bool,
    pub python_path: Option<String>,
    pub target_venv: String,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsProgressEvent {
    pub percent: u8,
    pub stage: String,
    pub log_line: String,
    pub done: bool,
    pub error: Option<String>,
}

struct InnerServer {
    child: Option<Child>,
    pid: Option<u32>,
    status: String,
    port: u16,
    model: Option<String>,
    drafter: Option<String>,
    started_at_ms: Option<u64>,
}

impl Default for InnerServer {
    fn default() -> Self {
        Self {
            child: None,
            pid: None,
            status: "stopped".to_string(),
            port: 8080,
            model: None,
            drafter: None,
            started_at_ms: None,
        }
    }
}

struct AppState {
    server: Arc<Mutex<InnerServer>>,
    sys: Mutex<System>,
    installing_deps: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_model_dir() -> String {
    let dev_models = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("models"));
    if let Some(p) = dev_models {
        if p.is_dir() {
            return p.to_string_lossy().to_string();
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let fallback = PathBuf::from(home).join("LookAtMyQuant").join("models");
        return fallback.to_string_lossy().to_string();
    }
    "models".to_string()
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn enriched_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        parts.push(format!("{home}/.local/bin"));
        parts.push(format!("{home}/.cargo/bin"));
    }
    parts.push("/opt/homebrew/bin".to_string());
    parts.push("/usr/local/bin".to_string());
    parts.push("/Library/Frameworks/Python.framework/Versions/3.12/bin".to_string());
    parts.push("/Library/Frameworks/Python.framework/Versions/3.13/bin".to_string());
    parts.push("/Library/Frameworks/Python.framework/Versions/3.14/bin".to_string());
    if let Ok(cur) = std::env::var("PATH") {
        if !cur.is_empty() {
            parts.push(cur);
        }
    }
    parts.join(":")
}

fn find_executable(name: &str) -> Option<PathBuf> {
    for dir in enriched_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn dev_project_root() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.to_path_buf();
    if p.join("package.json").is_file() {
        Some(p)
    } else {
        None
    }
}

fn target_venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dev_root) = dev_project_root() {
        return Ok(dev_root.join(".venv"));
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir.join(".venv"))
}

fn python_candidates(app: &AppHandle, model_dir: Option<&str>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_py) = std::env::var("LAMQ_PYTHON") {
        if !env_py.trim().is_empty() {
            candidates.push(PathBuf::from(env_py));
        }
    }
    if let Some(parent) = dev_project_root() {
        candidates.push(parent.join(".venv/bin/python"));
        candidates.push(parent.join(".venv/bin/python3"));
    }
    if let Some(md) = model_dir {
        if let Some(parent) = Path::new(md).parent() {
            candidates.push(parent.join(".venv/bin/python"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(".venv/bin/python"));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join(".venv/bin/python"));
        candidates.push(data_dir.join(".venv/bin/python3"));
    }
    if let Ok(cfg_dir) = app.path().app_config_dir() {
        candidates.push(cfg_dir.join(".venv/bin/python"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join("LookAtMyQuant/.venv/bin/python"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(brew_prefix) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            candidates.push(brew_prefix.join("libexec/.venv/bin/python"));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/opt/lookatmyquant-gui/libexec/.venv/bin/python"));
    candidates.push(PathBuf::from("/usr/local/opt/lookatmyquant-gui/libexec/.venv/bin/python"));
    candidates
}

fn python_missing_deps(python: &Path) -> Vec<String> {
    let script = r#"
import json
missing = []
for mod, pkg in [
    ("mlx.core", "mlx"),
    ("mlx_lm", "mlx-lm"),
    ("huggingface_hub", "huggingface-hub"),
    ("runtime_mlx", "lookatmyquant"),
]:
    try:
        __import__(mod)
    except Exception:
        missing.append(pkg)
print(json.dumps(missing))
"#;
    match Command::new(python)
        .args(["-c", script])
        .env("PATH", enriched_path())
        .output()
    {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str::<Vec<String>>(stdout.trim()).unwrap_or_else(|_| {
                vec![
                    "mlx".into(),
                    "mlx-lm".into(),
                    "huggingface-hub".into(),
                    "lookatmyquant".into(),
                ]
            })
        }
        _ => vec![
            "mlx".into(),
            "mlx-lm".into(),
            "huggingface-hub".into(),
            "lookatmyquant".into(),
        ],
    }
}

fn resolve_python(app: &AppHandle, model_dir: Option<&str>) -> String {
    for c in python_candidates(app, model_dir) {
        if c.exists() {
            return c.to_string_lossy().to_string();
        }
    }
    find_executable("python3")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "python3".to_string())
}

fn resolve_server_py(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(parent) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        let dev_script = parent.join("sidecar/server.py");
        if dev_script.exists() {
            return Ok(dev_script);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let res_script = res.join("sidecar/server.py");
        if res_script.exists() {
            return Ok(res_script);
        }
    }
    Err("Could not locate sidecar/server.py".to_string())
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total = total.saturating_add(dir_size_bytes(&p));
            } else if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn detect_model_meta(folder: &Path) -> Option<(bool, String)> {
    let artifact = folder.join("artifact.json");
    let manifest = folder.join("manifest.json");
    let lamq = folder.join("lamq.json");

    let format = if artifact.exists() {
        "opgraph-packed-1".to_string()
    } else if manifest.exists() {
        "inkling2-packed".to_string()
    } else if lamq.exists() {
        "lamq".to_string()
    } else {
        return None;
    };

    let mut is_drafter = false;
    let cfg_path = folder.join("config.json");
    if let Ok(raw) = fs::read_to_string(cfg_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(archs) = v.get("architectures").and_then(|a| a.as_array()) {
                for a in archs {
                    if let Some(s) = a.as_str() {
                        if s.contains("Draft") || s.contains("DSpine") || s.contains("DSpark") {
                            is_drafter = true;
                        }
                    }
                }
            }
        }
    }
    Some((is_drafter, format))
}

fn parse_log_line(raw: &str) -> ServerLogEvent {
    let line = raw.trim_end_matches(&['\r', '\n'][..]);
    // Format from server.py: "HH:MM:SS INFO message" or "HH:MM:SS HTTP GET ..."
    let parts: Vec<&str> = line.splitn(3, ' ').collect();
    if parts.len() == 3 && parts[0].len() == 8 && parts[0].chars().nth(2) == Some(':') {
        let ts = parts[0].to_string();
        let lvl = parts[1];
        let msg = parts[2].to_string();
        if lvl == "INFO" || lvl == "HTTP" {
            let tone = if msg.starts_with("Listening on")
                || msg.starts_with("Model loaded")
                || msg.starts_with("Model and drafter loaded")
            {
                "success".to_string()
            } else {
                "default".to_string()
            };
            return ServerLogEvent {
                ts: Some(ts),
                level: Some(lvl.to_string()),
                tone,
                msg,
            };
        }
    }
    ServerLogEvent {
        ts: None,
        level: None,
        tone: "default".to_string(),
        msg: line.to_string(),
    }
}

fn status_payload(s: &InnerServer, error: Option<String>) -> ServerStatusPayload {
    ServerStatusPayload {
        status: s.status.clone(),
        port: s.port,
        model: s.model.clone(),
        drafter: s.drafter.clone(),
        started_at_ms: s.started_at_ms,
        error,
    }
}

fn terminate_server(server: &Arc<Mutex<InnerServer>>) {
    let pid_opt = {
        let mut guard = match server.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.status = "stopping".to_string();
        guard.pid
    };

    if let Some(pid) = pid_opt {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();

        for _ in 0..30 {
            let still_alive = {
                let mut guard = match server.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if let Some(child) = guard.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            guard.child = None;
                            guard.pid = None;
                            false
                        }
                        Ok(None) => true,
                        Err(_) => false,
                    }
                } else {
                    false
                }
            };
            if !still_alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if let Ok(mut guard) = server.lock() {
            if let Some(mut child) = guard.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            guard.pid = None;
            guard.started_at_ms = None;
            guard.status = "stopped".to_string();
        }
    }
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_file_path(&app)?;
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                return Ok(cfg);
            }
        }
    }
    let cfg = AppConfig {
        model_dir: default_model_dir(),
        selected_model: None,
        selected_drafter: None,
        port: 8080,
        auto_update: true,
        auto_update_deps: true,
    };
    let _ = fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap_or_default());
    Ok(cfg)
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_file_path(&app)?;
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn estimate_ram_gb(size_gb: f64, is_drafter: bool) -> f64 {
    let raw = if is_drafter {
        size_gb + 0.3
    } else {
        size_gb * 1.15 + 0.8
    };
    (raw * 10.0).round() / 10.0
}

#[tauri::command]
fn scan_models(dir: String) -> Result<Vec<ModelEntry>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let rd = fs::read_dir(root).map_err(|e| e.to_string())?;
    for item in rd.flatten() {
        let path = item.path();
        if !path.is_dir() {
            continue;
        }
        if let Some((is_drafter, format)) = detect_model_meta(&path) {
            let name = item.file_name().to_string_lossy().to_string();
            let bytes = dir_size_bytes(&path);
            let size_gb = (bytes as f64) / 1_000_000_000.0;
            let est_ram_gb = estimate_ram_gb(size_gb, is_drafter);
            entries.push(ModelEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_drafter,
                format,
                size_gb,
                est_ram_gb,
            });
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
async fn pick_model_dir() -> Result<Option<String>, String> {
    let out = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"Select LookAtMyQuant Models Folder\")",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_end_matches('/')
        .to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

fn detect_chip_name() -> String {
    static CHIP: OnceLock<String> = OnceLock::new();
    CHIP.get_or_init(|| {
        if let Ok(out) = Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
        {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let cleaned = raw.strip_prefix("Apple ").unwrap_or(&raw).trim();
                if !cleaned.is_empty() {
                    return cleaned.to_string();
                }
            }
        }
        "Apple Silicon".to_string()
    })
    .clone()
}

#[tauri::command]
fn get_system_info(state: State<'_, AppState>) -> SystemInfo {
    let (ram_used_gb, ram_total_gb, ram_percent) = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_memory();
        let total = sys.total_memory() as f64;
        let used = sys.used_memory() as f64;
        let gb = 1024.0 * 1024.0 * 1024.0;
        let pct = if total > 0.0 {
            (used / total) * 100.0
        } else {
            0.0
        };
        (used / gb, total / gb, pct)
    };

    let thermal_state = match Command::new("pmset").args(["-g", "therm"]).output() {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            if s.contains("No thermal warning") {
                "Normal".to_string()
            } else if s.contains("CPU_Speed_Limit") {
                "Throttling".to_string()
            } else {
                "Normal".to_string()
            }
        }
        Err(_) => "Normal".to_string(),
    };

    SystemInfo {
        ram_used_gb,
        ram_total_gb,
        ram_percent,
        thermal_state,
        chip_name: detect_chip_name(),
    }
}

#[tauri::command]
fn get_server_status(state: State<'_, AppState>) -> ServerStatusPayload {
    let guard = state.server.lock().unwrap();
    status_payload(&guard, None)
}

#[tauri::command]
async fn start_server(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
    drafter_path: Option<String>,
    port: u16,
) -> Result<ServerStatusPayload, String> {
    {
        let guard = state.server.lock().unwrap();
        if guard.status == "running" || guard.status == "starting" {
            return Err("Server is already running or starting".to_string());
        }
    }

    let model_pb = PathBuf::from(&model_path);
    if !model_pb.is_dir() {
        return Err(format!("Model folder not found: {}", model_path));
    }
    let drafter_clean = drafter_path.filter(|d| !d.is_empty() && Path::new(d).is_dir());
    let model_dir_hint = model_pb
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let python = resolve_python(&app, model_dir_hint.as_deref());
    let server_py = resolve_server_py(&app)?;

    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&server_py)
        .arg(&model_path)
        .arg("--port")
        .arg(port.to_string())
        .arg("--max-tokens")
        .arg("2048")
        .arg("--context")
        .arg("32768")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    if let Some(ref d) = drafter_clean {
        cmd.arg("--drafter").arg(d);
    }

    let mut child = cmd
        .env("PATH", enriched_path())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python ({python}): {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let model_name = model_pb
        .file_name()
        .map(|s| s.to_string_lossy().to_string());
    let drafter_name = drafter_clean
        .as_ref()
        .and_then(|d| Path::new(d).file_name())
        .map(|s| s.to_string_lossy().to_string());

    let payload = {
        let mut guard = state.server.lock().unwrap();
        guard.child = Some(child);
        guard.pid = Some(pid);
        guard.status = "starting".to_string();
        guard.port = port;
        guard.model = model_name.clone();
        guard.drafter = drafter_name.clone();
        guard.started_at_ms = None;
        status_payload(&guard, None)
    };
    let _ = app.emit("server-status", payload.clone());

    if let Some(out) = stdout {
        let app_c = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let ev = parse_log_line(&line);
                let _ = app_c.emit("server-log", ev);
            }
        });
    }

    if let Some(err) = stderr {
        let app_c = app.clone();
        let srv = Arc::clone(&state.server);
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let ev = parse_log_line(&line);
                let is_ready = ev.msg.starts_with("Listening on ");
                let _ = app_c.emit("server-log", ev);
                if is_ready {
                    let p = {
                        let mut guard = srv.lock().unwrap();
                        if guard.pid == Some(pid) {
                            guard.status = "running".to_string();
                            guard.started_at_ms = Some(now_ms());
                        }
                        status_payload(&guard, None)
                    };
                    let _ = app_c.emit("server-status", p);
                }
            }
        });
    }

    // Watch child exit so UI updates if process exits unexpectedly or cleanly
    let app_w = app.clone();
    let srv_w = Arc::clone(&state.server);
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let exited = {
            let mut guard = match srv_w.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            if guard.pid != Some(pid) {
                break;
            }
            match guard.child.as_mut() {
                Some(ch) => match ch.try_wait() {
                    Ok(Some(status)) => {
                        guard.child = None;
                        guard.pid = None;
                        guard.started_at_ms = None;
                        guard.status = "stopped".to_string();
                        let err = if !status.success() {
                            Some(format!("Server exited with status {}", status))
                        } else {
                            None
                        };
                        Some(status_payload(&guard, err))
                    }
                    Ok(None) => None,
                    Err(_) => None,
                },
                None => break,
            }
        };
        if let Some(p) = exited {
            let _ = app_w.emit("server-status", p);
            break;
        }
    });

    Ok(payload)
}

#[tauri::command]
async fn stop_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ServerStatusPayload, String> {
    let srv = Arc::clone(&state.server);
    let app_c = app.clone();
    tokio_less_stop(srv, app_c).await
}

async fn tokio_less_stop(
    srv: Arc<Mutex<InnerServer>>,
    app: AppHandle,
) -> Result<ServerStatusPayload, String> {
    {
        let mut guard = srv.lock().unwrap();
        if guard.status == "stopped" {
            return Ok(status_payload(&guard, None));
        }
        guard.status = "stopping".to_string();
        let _ = app.emit("server-status", status_payload(&guard, None));
    }

    tauri::async_runtime::spawn_blocking(move || {
        terminate_server(&srv);
        let guard = srv.lock().unwrap();
        let p = status_payload(&guard, None);
        let _ = app.emit("server-status", p.clone());
        p
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_model(
    app: AppHandle,
    repo_id: String,
    model_dir: String,
) -> Result<String, String> {
    let repo = repo_id.trim().to_string();
    if repo.is_empty() || !repo.contains('/') {
        return Err("Enter a Hugging Face repo ID like shinmegamiboson/Qwen3.5-4B-LookAtMyQuant-1.2GB".to_string());
    }
    let folder_name = repo.split('/').last().unwrap_or(&repo).to_string();
    let target = PathBuf::from(&model_dir).join(&folder_name);
    fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let python = resolve_python(&app, Some(&model_dir));
    let target_str = target.to_string_lossy().to_string();

    let script = r#"
import os, sys
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
from huggingface_hub import snapshot_download
repo_id, local_dir = sys.argv[1], sys.argv[2]
print(f"Downloading {repo_id} -> {local_dir} ...", flush=True)
path = snapshot_download(repo_id, local_dir=local_dir)
print(f"Downloaded: {path}", flush=True)
"#;

    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&python)
            .args(["-u", "-c", script, &repo, &target_str])
            .env("PATH", enriched_path())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to start download: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Download failed: {}", stderr.trim()));
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn list_hf_models(
    app: AppHandle,
    model_dir: String,
) -> Result<Vec<HfModelEntry>, String> {
    let python = resolve_python(&app, Some(&model_dir));
    let model_dir_c = model_dir.clone();

    let script = r#"
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
from huggingface_hub import HfApi

model_dir = sys.argv[1]
api = HfApi()
items = list(api.list_models(author="shinmegamiboson"))

def inspect(m):
    info = api.model_info(m.id, files_metadata=True)
    sibs = info.siblings or []
    total_bytes = sum((s.size or 0) for s in sibs)
    size_gb = round(total_bytes / 1e9, 2)
    tags = list(info.tags or [])
    name = m.id.split("/")[-1]
    is_drafter = ("speculative-decoding" in tags) or ("drafter" in name.lower())
    est_ram_gb = round((size_gb + 0.3) if is_drafter else (size_gb * 1.15 + 0.8), 1)
    installed = os.path.isdir(os.path.join(model_dir, name))
    return {
        "id": m.id,
        "name": name,
        "sizeGb": size_gb,
        "estRamGb": est_ram_gb,
        "isDrafter": is_drafter,
        "downloads": int(getattr(info, "downloads", 0) or 0),
        "installed": installed,
    }

with ThreadPoolExecutor(max_workers=6) as ex:
    out = list(ex.map(inspect, items))

out.sort(key=lambda x: (x["isDrafter"], x["sizeGb"], x["name"].lower()))
print(json.dumps(out))
"#;

    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&python)
            .args(["-u", "-c", script, &model_dir_c])
            .env("PATH", enriched_path())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to fetch Hugging Face models: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("HF list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<Vec<HfModelEntry>>(stdout.trim())
        .map_err(|e| format!("Failed to parse HF response: {e}"))
}

fn extract_pip_stage(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("+ ") {
        let pkg = rest.split_whitespace().next().unwrap_or(rest);
        return Some(format!("pip install {pkg}"));
    }
    if let Some(rest) = trimmed.strip_prefix("Collecting ") {
        let pkg = rest.split_whitespace().next().unwrap_or(rest);
        return Some(format!("pip install {pkg}"));
    }
    if let Some(rest) = trimmed.strip_prefix("Downloading ") {
        let raw = rest.split_whitespace().next().unwrap_or(rest);
        let name = raw.rsplit('/').next().unwrap_or(raw);
        let pkg = name.split('-').next().unwrap_or(name);
        return Some(format!("pip install {pkg} (downloading)"));
    }
    if let Some(rest) = trimmed.strip_prefix("Building wheel for ") {
        let pkg = rest.split_whitespace().next().unwrap_or(rest);
        return Some(format!("pip install {pkg} (building)"));
    }
    if trimmed.starts_with("Cloning ") || trimmed.starts_with("Updating ") || trimmed.starts_with("Updated ") {
        return Some("pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git".to_string());
    }
    if trimmed.starts_with("Installing collected packages:") {
        return Some("pip install: writing packages to .venv".to_string());
    }
    if trimmed.starts_with("Resolved ") || trimmed.starts_with("Prepared ") || trimmed.starts_with("Installed ") {
        return Some(format!("pip install: {}", trimmed.to_lowercase()));
    }
    None
}

fn find_system_python_310_plus() -> Option<PathBuf> {
    let names = ["python3.12", "python3.13", "python3.14", "python3.11", "python3.10", "python3"];
    for name in names {
        for dir in enriched_path().split(':') {
            if dir.is_empty() {
                continue;
            }
            let cand = Path::new(dir).join(name);
            if !cand.is_file() {
                continue;
            }
            if let Ok(out) = Command::new(&cand)
                .args(["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"])
                .output()
            {
                if out.status.success() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

fn emit_deps_progress(
    app: &AppHandle,
    percent: u8,
    stage: &str,
    log_line: &str,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "deps-progress",
        DepsProgressEvent {
            percent,
            stage: stage.to_string(),
            log_line: log_line.to_string(),
            done,
            error,
        },
    );
}

fn run_streaming_install_cmd(
    app: &AppHandle,
    program: &Path,
    args: &[&str],
    initial_stage: &str,
    start_pct: u8,
    end_pct: u8,
) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", enriched_path())
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", program.display()))?;

    let pct_state = Arc::new(Mutex::new(start_pct));
    let stage_state = Arc::new(Mutex::new(initial_stage.to_string()));
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));

    let spawn_reader = |stream: Box<dyn std::io::Read + Send>,
                          app_c: AppHandle,
                          pct_c: Arc<Mutex<u8>>,
                          stage_c: Arc<Mutex<String>>,
                          tail_c: Arc<Mutex<Vec<String>>>| {
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                let clean = line.trim().to_string();
                if clean.is_empty() {
                    continue;
                }
                if let Ok(mut t) = tail_c.lock() {
                    t.push(clean.clone());
                    if t.len() > 20 {
                        t.remove(0);
                    }
                }
                let next_stage = extract_pip_stage(&clean);
                let mut cur_stage = stage_c.lock().unwrap();
                if let Some(ref s) = next_stage {
                    *cur_stage = s.clone();
                }
                let mut p = pct_c.lock().unwrap();
                if *p < end_pct {
                    *p = (*p + 2).min(end_pct);
                }
                emit_deps_progress(&app_c, *p, &cur_stage, &clean, false, None);
            }
        })
    };

    let h1 = child.stdout.take().map(|s| {
        spawn_reader(
            Box::new(s),
            app.clone(),
            Arc::clone(&pct_state),
            Arc::clone(&stage_state),
            Arc::clone(&stderr_tail),
        )
    });
    let h2 = child.stderr.take().map(|s| {
        spawn_reader(
            Box::new(s),
            app.clone(),
            Arc::clone(&pct_state),
            Arc::clone(&stage_state),
            Arc::clone(&stderr_tail),
        )
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for {}: {e}", program.display()))?;
    if let Some(h) = h1 {
        let _ = h.join();
    }
    if let Some(h) = h2 {
        let _ = h.join();
    }

    if !status.success() {
        let tail = stderr_tail
            .lock()
            .map(|v| v.join("\n"))
            .unwrap_or_default();
        return Err(format!(
            "Command `{}` failed ({}):\n{}",
            program.display(),
            status,
            tail.trim()
        ));
    }
    Ok(())
}

struct AtomicFlagReset(Arc<AtomicBool>);
impl Drop for AtomicFlagReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn check_dependencies(
    app: AppHandle,
    model_dir: Option<String>,
) -> Result<DependencyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target_venv = target_venv_dir(&app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".venv".to_string());
        for cand in python_candidates(&app, model_dir.as_deref()) {
            if cand.exists() {
                let missing = python_missing_deps(&cand);
                if missing.is_empty() {
                    return DependencyStatus {
                        ready: true,
                        python_path: Some(cand.to_string_lossy().to_string()),
                        target_venv,
                        missing: Vec::new(),
                    };
                }
            }
        }
        DependencyStatus {
            ready: false,
            python_path: None,
            target_venv,
            missing: vec![
                "mlx".to_string(),
                "mlx-lm".to_string(),
                "huggingface-hub".to_string(),
                "lookatmyquant".to_string(),
            ],
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_dependencies(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DependencyStatus, String> {
    if state
        .installing_deps
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Dependency installation is already in progress.".to_string());
    }
    let flag = Arc::clone(&state.installing_deps);
    let app_c = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _reset = AtomicFlagReset(flag);
        let venv_dir = target_venv_dir(&app_c)?;
        let venv_str = venv_dir.to_string_lossy().to_string();
        let venv_py = venv_dir.join("bin/python");
        let venv_py_str = venv_py.to_string_lossy().to_string();

        emit_deps_progress(
            &app_c,
            5,
            "Creating Python virtual environment (.venv)...",
            &format!("Target environment: {venv_str}"),
            false,
            None,
        );

        let uv_bin = find_executable("uv");
        if let Some(ref uv) = uv_bin {
            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                uv,
                &["venv", "--python", "3.12", "--seed", "--clear", &venv_str],
                "Creating Python 3.12 virtual environment...",
                6,
                16,
            ) {
                emit_deps_progress(&app_c, 0, "Setup failed", &e, false, Some(e.clone()));
                return Err(e);
            }

            emit_deps_progress(
                &app_c,
                18,
                "pip install mlx mlx-lm numpy huggingface-hub",
                "pip install mlx mlx-lm numpy huggingface-hub",
                false,
                None,
            );
            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                uv,
                &[
                    "pip",
                    "install",
                    "--python",
                    &venv_py_str,
                    "mlx",
                    "mlx-lm",
                    "numpy",
                    "huggingface-hub",
                ],
                "pip install mlx mlx-lm numpy huggingface-hub",
                20,
                58,
            ) {
                emit_deps_progress(&app_c, 0, "Install failed", &e, false, Some(e.clone()));
                return Err(e);
            }

            emit_deps_progress(
                &app_c,
                60,
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                false,
                None,
            );
            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                uv,
                &[
                    "pip",
                    "install",
                    "--python",
                    &venv_py_str,
                    "git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                ],
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                62,
                94,
            ) {
                emit_deps_progress(&app_c, 0, "Install failed", &e, false, Some(e.clone()));
                return Err(e);
            }
        } else {
            let sys_py = find_system_python_310_plus().ok_or_else(|| {
                let msg = "No Python 3.10+ or `uv` found. Install via `brew install uv` or `brew install python@3.12` and retry.".to_string();
                emit_deps_progress(&app_c, 0, "Python missing", &msg, false, Some(msg.clone()));
                msg
            })?;

            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                &sys_py,
                &["-m", "venv", "--clear", &venv_str],
                "Creating Python virtual environment...",
                6,
                14,
            ) {
                emit_deps_progress(&app_c, 0, "Setup failed", &e, false, Some(e.clone()));
                return Err(e);
            }

            let _ = run_streaming_install_cmd(
                &app_c,
                &venv_py,
                &["-m", "pip", "install", "--upgrade", "pip"],
                "pip install --upgrade pip",
                15,
                20,
            );

            emit_deps_progress(
                &app_c,
                22,
                "pip install mlx mlx-lm numpy huggingface-hub",
                "pip install mlx mlx-lm numpy huggingface-hub",
                false,
                None,
            );
            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                &venv_py,
                &[
                    "-m",
                    "pip",
                    "install",
                    "--progress-bar",
                    "off",
                    "mlx",
                    "mlx-lm",
                    "numpy",
                    "huggingface-hub",
                ],
                "pip install mlx mlx-lm numpy huggingface-hub",
                24,
                60,
            ) {
                emit_deps_progress(&app_c, 0, "Install failed", &e, false, Some(e.clone()));
                return Err(e);
            }

            emit_deps_progress(
                &app_c,
                62,
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                false,
                None,
            );
            if let Err(e) = run_streaming_install_cmd(
                &app_c,
                &venv_py,
                &[
                    "-m",
                    "pip",
                    "install",
                    "--progress-bar",
                    "off",
                    "git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                ],
                "pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                64,
                94,
            ) {
                emit_deps_progress(&app_c, 0, "Install failed", &e, false, Some(e.clone()));
                return Err(e);
            }
        }

        emit_deps_progress(
            &app_c,
            96,
            "Verifying runtime_mlx, mlx, mlx_lm, huggingface_hub...",
            "Checking Python imports...",
            false,
            None,
        );
        let missing = python_missing_deps(&venv_py);
        if !missing.is_empty() {
            let msg = format!("Verification failed; missing: {}", missing.join(", "));
            emit_deps_progress(&app_c, 0, "Verification failed", &msg, false, Some(msg.clone()));
            return Err(msg);
        }

        emit_deps_progress(
            &app_c,
            100,
            "Dependencies installed!",
            "All dependencies installed and verified.",
            true,
            None,
        );

        Ok(DependencyStatus {
            ready: true,
            python_path: Some(venv_py_str),
            target_venv: venv_str,
            missing: Vec::new(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn installed_lookatmyquant_commit(python: &str) -> Option<String> {
    let script = r#"
import importlib.metadata, json
try:
    dist = importlib.metadata.distribution("lookatmyquant")
    raw = dist.read_text("direct_url.json")
    if raw:
        data = json.loads(raw)
        cid = (data.get("vcs_info") or {}).get("commit_id")
        if cid:
            print(cid)
except Exception:
    pass
"#;
    let out = Command::new(python)
        .args(["-c", script])
        .env("PATH", enriched_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn latest_lookatmyquant_commit() -> Result<String, String> {
    let git = find_executable("git").unwrap_or_else(|| PathBuf::from("git"));
    let out = Command::new(git)
        .args([
            "ls-remote",
            "https://github.com/ShinMegamiBoson/lookatmyquant.git",
            "HEAD",
        ])
        .env("PATH", enriched_path())
        .output()
        .map_err(|e| format!("Failed to run git ls-remote: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Failed to check upstream repository".to_string()
        } else {
            err
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .split_whitespace()
        .next()
        .map(|s| s.to_string())
        .ok_or_else(|| "Empty git ls-remote output".to_string())
}

#[tauri::command]
async fn check_deps_updates(
    app: AppHandle,
    model_dir: Option<String>,
) -> Result<DepsUpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let py = resolve_python(&app, model_dir.as_deref());
        let installed = installed_lookatmyquant_commit(&py);
        let latest = latest_lookatmyquant_commit()?;
        let latest_short = &latest[..latest.len().min(7)];

        match installed {
            Some(ref inst) if inst == &latest => Ok(DepsUpdateCheck {
                up_to_date: true,
                installed_commit: Some(inst.clone()),
                latest_commit: Some(latest.clone()),
                message: format!("lookatmyquant @ {latest_short} — up to date"),
            }),
            Some(ref inst) => {
                let inst_short = &inst[..inst.len().min(7)];
                Ok(DepsUpdateCheck {
                    up_to_date: false,
                    installed_commit: Some(inst.clone()),
                    latest_commit: Some(latest.clone()),
                    message: format!("Update available: {inst_short} → {latest_short}"),
                })
            }
            None => Ok(DepsUpdateCheck {
                up_to_date: false,
                installed_commit: None,
                latest_commit: Some(latest.clone()),
                message: format!("Upstream @ {latest_short} — click Update to sync"),
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn update_dependencies(
    app: AppHandle,
    state: State<'_, AppState>,
    model_dir: Option<String>,
) -> Result<DepsUpdateCheck, String> {
    {
        let guard = state.server.lock().unwrap();
        if guard.status != "stopped" {
            return Err("Stop the server before updating dependencies.".to_string());
        }
    }
    if state
        .installing_deps
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Dependency operation already in progress.".to_string());
    }
    let flag = Arc::clone(&state.installing_deps);
    let app_c = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _reset = AtomicFlagReset(flag);
        let py = resolve_python(&app_c, model_dir.as_deref());
        let uv_bin = find_executable("uv");

        if let Some(ref uv) = uv_bin {
            run_streaming_install_cmd(
                &app_c,
                uv,
                &[
                    "pip",
                    "install",
                    "--python",
                    &py,
                    "--upgrade",
                    "mlx",
                    "mlx-lm",
                    "numpy",
                    "huggingface-hub",
                ],
                "pip install --upgrade mlx mlx-lm numpy huggingface-hub",
                10,
                55,
            )?;
            run_streaming_install_cmd(
                &app_c,
                uv,
                &[
                    "pip",
                    "install",
                    "--python",
                    &py,
                    "--upgrade",
                    "--reinstall-package",
                    "lookatmyquant",
                    "git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                ],
                "pip install --upgrade git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                55,
                95,
            )?;
        } else {
            let py_pb = PathBuf::from(&py);
            run_streaming_install_cmd(
                &app_c,
                &py_pb,
                &[
                    "-m",
                    "pip",
                    "install",
                    "--progress-bar",
                    "off",
                    "--upgrade",
                    "mlx",
                    "mlx-lm",
                    "numpy",
                    "huggingface-hub",
                ],
                "pip install --upgrade mlx mlx-lm numpy huggingface-hub",
                10,
                55,
            )?;
            run_streaming_install_cmd(
                &app_c,
                &py_pb,
                &[
                    "-m",
                    "pip",
                    "install",
                    "--progress-bar",
                    "off",
                    "--upgrade",
                    "--force-reinstall",
                    "--no-deps",
                    "git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                ],
                "pip install --upgrade git+https://github.com/ShinMegamiBoson/lookatmyquant.git",
                55,
                95,
            )?;
        }

        let installed = installed_lookatmyquant_commit(&py);
        let short = installed
            .as_deref()
            .map(|s| &s[..s.len().min(7)])
            .unwrap_or("latest");
        let message = format!("Updated dependencies ({short})");
        Ok(DepsUpdateCheck {
            up_to_date: true,
            installed_commit: installed,
            latest_commit: None,
            message,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon() {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let bytes: &[u8] = include_bytes!("../icons/icon.png");
    if let Some(mtm) = MainThreadMarker::new() {
        let data = NSData::with_bytes(bytes);
        if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
            let app = NSApplication::sharedApplication(mtm);
            unsafe {
                app.setApplicationIconImage(Some(&img));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server = Arc::new(Mutex::new(InnerServer::default()));
    let server_for_exit = Arc::clone(&server);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_dock_icon();
            Ok(())
        })
        .manage(AppState {
            server,
            sys: Mutex::new(System::new_all()),
            installing_deps: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            scan_models,
            pick_model_dir,
            get_system_info,
            get_server_status,
            start_server,
            stop_server,
            download_model,
            list_hf_models,
            check_dependencies,
            install_dependencies,
            check_deps_updates,
            update_dependencies,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            terminate_server(&server_for_exit);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_real_qwen35_models_and_drafter() {
        let dir = default_model_dir();
        let list = scan_models(dir).expect("scan_models failed");
        let main = list
            .iter()
            .find(|m| m.name == "Qwen3.5-4B-LookAtMyQuant-1.2GB")
            .expect("missing Qwen3.5-4B main model");
        assert!(!main.is_drafter);
        assert_eq!(main.format, "opgraph-packed-1");
        assert!(main.size_gb > 0.5);

        let drafter = list
            .iter()
            .find(|m| m.name == "Qwen3.5-4B-LookAtMyQuant-1.2GB-drafter")
            .expect("missing Qwen3.5-4B drafter");
        assert!(drafter.is_drafter);
        assert_eq!(drafter.format, "opgraph-packed-1");
    }

    #[test]
    fn parses_info_http_and_success_logs() {
        let e1 = parse_log_line("23:14:37 INFO Listening on http://127.0.0.1:8080");
        assert_eq!(e1.ts.as_deref(), Some("23:14:37"));
        assert_eq!(e1.level.as_deref(), Some("INFO"));
        assert_eq!(e1.tone, "success");

        let e2 = parse_log_line("23:14:56 HTTP POST /v1/chat/completions  200 OK");
        assert_eq!(e2.level.as_deref(), Some("HTTP"));
        assert_eq!(e2.tone, "default");
    }

    #[test]
    fn parses_pip_and_uv_install_stages() {
        assert_eq!(
            extract_pip_stage("Collecting mlx-lm>=0.20.0").as_deref(),
            Some("pip install mlx-lm>=0.20.0")
        );
        assert_eq!(
            extract_pip_stage(" + lookatmyquant==0.3.0").as_deref(),
            Some("pip install lookatmyquant==0.3.0")
        );
        assert_eq!(
            extract_pip_stage("Cloning https://github.com/ShinMegamiBoson/lookatmyquant.git").as_deref(),
            Some("pip install git+https://github.com/ShinMegamiBoson/lookatmyquant.git")
        );
    }
}
