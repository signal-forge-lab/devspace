use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::mem::{size_of, size_of_val};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        },
        SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
        Threading::{
            OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            PROCESS_VM_READ,
        },
    },
};

const MEMORY_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const MEMORY_LOG_INTERVAL: Duration = Duration::from_secs(30);
const MEMORY_LOG_RETENTION_DAYS: i64 = 30;
const MEMORY_LOG_SCHEMA: &str = "workbridge.monitor.memory.v1";
const TAURI_FRAMEWORK_VERSION: &str = "2.11.5";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct MonitorState {
    project_root: PathBuf,
    monitor_url: String,
    memory: Mutex<MemoryState>,
    operation: Mutex<OperationState>,
    last_runtime_status: Mutex<Option<Value>>,
    managed_pid: Mutex<Option<u32>>,
}

impl MonitorState {
    pub fn new(project_root: PathBuf, monitor_url: String) -> Self {
        Self {
            project_root,
            monitor_url,
            memory: Mutex::new(MemoryState::new()),
            operation: Mutex::new(OperationState::default()),
            last_runtime_status: Mutex::new(None),
            managed_pid: Mutex::new(None),
        }
    }

    pub fn monitor_url(&self) -> &str {
        &self.monitor_url
    }

    fn remember_runtime(&self, runtime_status: Option<Value>) -> Result<Option<Value>, String> {
        let mut stored = self
            .last_runtime_status
            .lock()
            .map_err(|_| "Monitor runtime state lock failed.".to_string())?;
        if runtime_status.is_some() {
            *stored = runtime_status;
        }
        Ok(stored.clone())
    }

    fn status(&self, runtime_status: Option<Value>) -> Result<Value, String> {
        let runtime = self.remember_runtime(runtime_status)?;
        let configured = configured_startup_config();
        let environment = environment_startup_config();
        let effective = merge_startup_configs(&configured, &environment);
        let sources = merge_sources(
            startup_config_sources(&configured, "config.jsonc"),
            startup_config_sources(&environment, "environment"),
        );
        let server = runtime.as_ref().and_then(|value| value.get("server"));
        let server_reachable = server.is_some_and(Value::is_object);
        let startup_complete = startup_config_complete(&effective);
        let control_token_present = supervisor_control_token_present();
        let controllable = server_reachable
            && server
                .and_then(|value| value.get("controlEnabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && control_token_present;
        let runtime_pid = server
            .and_then(|value| value.get("pid"))
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok());
        let residual_process = {
            let mut managed_pid = self
                .managed_pid
                .lock()
                .map_err(|_| "Monitor managed process state lock failed.".to_string())?;
            if controllable {
                if let Some(pid) = runtime_pid {
                    *managed_pid = Some(pid);
                }
                false
            } else if server_reachable {
                false
            } else if managed_pid.is_some_and(process_exists) {
                true
            } else {
                *managed_pid = None;
                false
            }
        };
        let managed_pid = *self
            .managed_pid
            .lock()
            .map_err(|_| "Monitor managed process state lock failed.".to_string())?;
        let paused = runtime
            .as_ref()
            .and_then(|value| value.get("softPause"))
            .is_some_and(|value| !value.is_null() && value != &Value::Bool(false));
        let active_config = server.and_then(|value| value.get("startupConfig"));
        let config_matches = active_config
            .map(|active| startup_configs_equal(&effective, active))
            .unwrap_or(false);
        let state_dir = effective
            .get("stateDir")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let desktop_memory = {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| "Monitor memory state lock failed.".to_string())?;
            memory.refresh_if_due(state_dir.as_deref(), runtime.as_ref())?
        };
        let memory_log = self
            .memory
            .lock()
            .map_err(|_| "Monitor memory state lock failed.".to_string())?
            .logger
            .status_json();
        let operation = self
            .operation
            .lock()
            .map_err(|_| "Monitor operation state lock failed.".to_string())?;
        let operation_value = operation.current.clone().unwrap_or(Value::Null);
        let last_result = operation.last_result.clone().unwrap_or(Value::Null);
        let state = operation
            .current
            .as_ref()
            .and_then(|value| value.get("action"))
            .and_then(Value::as_str)
            .map(operation_state)
            .unwrap_or(if residual_process {
                "residual_process"
            } else if server_reachable {
                "running"
            } else {
                "stopped"
            });

        Ok(json!({
            "version": 1,
            "projectRoot": self.project_root,
            "state": state,
            "ownership": if residual_process { "managed" } else if server_reachable { if controllable { "managed" } else { "external" } } else { "none" },
            "serverReachable": server_reachable,
            "managedPid": managed_pid,
            "residualProcess": residual_process,
            "stateDir": state_dir,
            "desktopMemory": desktop_memory,
            "memoryLog": memory_log,
            "configuredStartupConfig": configured,
            "startupConfig": effective,
            "startupConfigSources": sources,
            "startupConfigComplete": startup_complete,
            "startupConfigMatchesRuntime": config_matches,
            "operation": operation_value,
            "lastResult": last_result,
            "capabilities": {
                "start": !server_reachable && !residual_process && startup_complete,
                "stop": controllable || residual_process,
                "restart": startup_complete && (controllable || residual_process),
                "build": true,
                "buildRestart": startup_complete && (!server_reachable || controllable || residual_process),
                "pause": !paused,
                "resume": paused,
            }
        }))
    }

    fn refresh_memory_background(&self) -> Result<(), String> {
        let configured = configured_startup_config();
        let environment = environment_startup_config();
        let effective = merge_startup_configs(&configured, &environment);
        let state_dir = effective.get("stateDir").and_then(Value::as_str);
        let runtime = self.remember_runtime(None)?;
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Monitor memory state lock failed.".to_string())?;
        memory.refresh_if_due(state_dir, runtime.as_ref())?;
        Ok(())
    }

    fn begin_operation(&self, action: &str) -> Result<Instant, String> {
        let mut operation = self
            .operation
            .lock()
            .map_err(|_| "Monitor operation state lock failed.".to_string())?;
        if let Some(active) = &operation.current {
            let active_action = active
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(format!(
                "Another operation is already running: {active_action}"
            ));
        }
        let started = Instant::now();
        operation.current = Some(json!({
            "active": true,
            "action": action,
            "phase": operation_state(action),
            "startedAt": Utc::now().timestamp_millis(),
            "line": operation_line(action),
        }));
        operation.last_result = None;
        Ok(started)
    }

    fn finish_operation(&self, action: &str, started: Instant, result: &Result<(), String>) {
        if let Ok(mut operation) = self.operation.lock() {
            operation.current = None;
            operation.last_result = Some(json!({
                "action": action,
                "ok": result.is_ok(),
                "completedAt": Utc::now().timestamp_millis(),
                "durationMs": started.elapsed().as_millis() as u64,
                "error": result.as_ref().err(),
                "line": if result.is_ok() { operation_line(action) } else { "" },
            }));
        }
    }

    fn residual_managed_pid(&self) -> Result<Option<u32>, String> {
        let runtime_reachable = self
            .last_runtime_status
            .lock()
            .map_err(|_| "Monitor runtime state lock failed.".to_string())?
            .as_ref()
            .and_then(|value| value.get("server"))
            .is_some_and(Value::is_object);
        if runtime_reachable {
            return Ok(None);
        }
        let mut managed_pid = self
            .managed_pid
            .lock()
            .map_err(|_| "Monitor managed process state lock failed.".to_string())?;
        if managed_pid.is_some_and(process_exists) {
            Ok(*managed_pid)
        } else {
            *managed_pid = None;
            Ok(None)
        }
    }

    fn note_helper_result(&self, action: &str, result: &Value) -> Result<(), String> {
        let mut managed_pid = self
            .managed_pid
            .lock()
            .map_err(|_| "Monitor managed process state lock failed.".to_string())?;
        match action {
            "start" | "restart" | "build-restart" => {
                *managed_pid = result
                    .get("managedPid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| u32::try_from(pid).ok());
            }
            "stop" => *managed_pid = None,
            _ => {}
        }
        Ok(())
    }

    fn clear_managed_pid(&self) {
        if let Ok(mut managed_pid) = self.managed_pid.lock() {
            *managed_pid = None;
        }
    }
}

pub fn start_memory_sampler(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("workbridge-monitor-memory".to_string())
        .spawn(move || loop {
            {
                let state = app.state::<MonitorState>();
                let _ = state.refresh_memory_background();
            }
            thread::sleep(MEMORY_SAMPLE_INTERVAL);
        });
}

#[derive(Default)]
struct OperationState {
    current: Option<Value>,
    last_result: Option<Value>,
}

struct MemoryState {
    last_sample_at: Option<Instant>,
    desktop_memory: Option<Value>,
    peak_working_set_bytes: u64,
    logger: MemoryLogger,
}

impl MemoryState {
    fn new() -> Self {
        Self {
            last_sample_at: None,
            desktop_memory: None,
            peak_working_set_bytes: 0,
            logger: MemoryLogger::new(),
        }
    }

    fn refresh_if_due(
        &mut self,
        state_dir: Option<&str>,
        runtime_status: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        self.logger.set_state_dir(state_dir);
        let due = self
            .last_sample_at
            .is_none_or(|last| last.elapsed() >= MEMORY_SAMPLE_INTERVAL);
        if due {
            let sample = desktop_memory_snapshot(std::process::id(), self.peak_working_set_bytes)?;
            if let Some(total) = sample.get("workingSetBytes").and_then(Value::as_u64) {
                self.peak_working_set_bytes = self.peak_working_set_bytes.max(total);
            }
            let mut sample = sample;
            if let Some(object) = sample.as_object_mut() {
                object.insert(
                    "peakWorkingSetBytes".to_string(),
                    Value::from(self.peak_working_set_bytes),
                );
            }
            self.last_sample_at = Some(Instant::now());
            self.logger.record(&sample, runtime_status);
            self.desktop_memory = Some(sample);
        }
        Ok(self.desktop_memory.clone())
    }
}

struct MemoryLogger {
    directory: Option<PathBuf>,
    last_attempt_at: Option<Instant>,
    last_written_at: Option<String>,
    last_error: Option<String>,
    last_cleanup_date: Option<String>,
}

impl MemoryLogger {
    fn new() -> Self {
        Self {
            directory: None,
            last_attempt_at: None,
            last_written_at: None,
            last_error: None,
            last_cleanup_date: None,
        }
    }

    fn set_state_dir(&mut self, state_dir: Option<&str>) {
        let next = state_dir
            .and_then(expand_home_path)
            .map(|path| path.join("monitor-memory").join("tauri"));
        if self.directory != next {
            self.directory = next;
            self.last_attempt_at = None;
            self.last_cleanup_date = None;
        }
    }

    fn status_json(&self) -> Value {
        json!({
            "enabled": self.directory.is_some(),
            "intervalMs": MEMORY_LOG_INTERVAL.as_millis() as u64,
            "retentionDays": MEMORY_LOG_RETENTION_DAYS,
            "directory": self.directory,
            "lastWrittenAt": self.last_written_at,
            "lastError": self.last_error,
        })
    }

    fn record(&mut self, desktop_memory: &Value, runtime_status: Option<&Value>) {
        let Some(directory) = self.directory.clone() else {
            return;
        };
        if self
            .last_attempt_at
            .is_some_and(|last| last.elapsed() < MEMORY_LOG_INTERVAL)
        {
            return;
        }
        self.last_attempt_at = Some(Instant::now());
        let now = Utc::now();
        let date = now.format("%Y-%m-%d").to_string();
        let cleanup_error = self.cleanup_if_due(&directory, &date);
        let record = memory_log_record(
            desktop_memory,
            runtime_status,
            &now.to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        let result = (|| -> Result<(), String> {
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let file = directory.join(format!("{date}.jsonl"));
            let mut output = OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)
                .map_err(|error| error.to_string())?;
            writeln!(output, "{}", record).map_err(|error| error.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.last_written_at = record
                    .get("capturedAt")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                self.last_error = cleanup_error;
            }
            Err(error) => self.last_error = Some(format!("append: {error}")),
        }
    }

    fn cleanup_if_due(&mut self, directory: &Path, today: &str) -> Option<String> {
        if self.last_cleanup_date.as_deref() == Some(today) {
            return None;
        }
        self.last_cleanup_date = Some(today.to_string());
        let result = (|| -> Result<(), String> {
            fs::create_dir_all(directory).map_err(|error| error.to_string())?;
            let cutoff = (Utc::now().date_naive()
                - ChronoDuration::days(MEMORY_LOG_RETENTION_DAYS - 1))
            .format("%Y-%m-%d")
            .to_string();
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_file()
                {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if daily_memory_file(&name) && &name[..10] < cutoff.as_str() {
                    fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
                }
            }
            Ok(())
        })();
        result.err().map(|error| format!("cleanup: {error}"))
    }
}

pub fn host_init_script(project_root: &Path, monitor_url: &str) -> String {
    let metadata = json!({
        "kind": "tauri",
        "projectRoot": project_root,
        "monitorUrl": monitor_url,
        "readOnly": false,
    });
    format!(
        "(()=>{{const invoke=(command,args)=>window.__TAURI__.core.invoke(command,args);const api=Object.freeze({{getStatus:(runtimeStatus)=>invoke('monitor_status',{{runtimeStatus:runtimeStatus??{{}}}}),isReachable:()=>invoke('monitor_reachable'),onStatus:()=>()=>{{}},runAction:(action)=>invoke('run_monitor_action',{{action}}),saveStartupConfig:(config)=>invoke('save_startup_config',{{config}})}});const host=Object.freeze(Object.assign({metadata},{{api}}));Object.defineProperty(window,'workbridgeMonitorHost',{{value:host,writable:false,configurable:false}});}})();"
    )
}

#[tauri::command]
pub fn monitor_status(
    state: State<'_, MonitorState>,
    runtime_status: Option<Value>,
) -> Result<Value, String> {
    state.status(runtime_status)
}

#[tauri::command]
pub async fn run_monitor_action(
    state: State<'_, MonitorState>,
    action: String,
) -> Result<Value, String> {
    if !supported_action(&action) {
        return Err("Unsupported Workbridge monitor action.".to_string());
    }
    let started = state.begin_operation(&action)?;
    let residual_pid = state.residual_managed_pid()?;
    if action == "start" && residual_pid.is_some() {
        let error = "A residual managed Workbridge process is still running. Use Restart to replace it safely.".to_string();
        let result = Err(error.clone());
        state.finish_operation(&action, started, &result);
        return Err(error);
    }
    if let Some(pid) =
        residual_pid.filter(|_| matches!(action.as_str(), "stop" | "restart" | "build-restart"))
    {
        let result = terminate_managed_process(pid);
        if result.is_err() {
            state.finish_operation(&action, started, &result);
            return result.map(|_| Value::Null);
        }
        state.clear_managed_pid();
        if action == "stop" {
            state.finish_operation(&action, started, &result);
            return state.status(None);
        }
    }
    let project_root = state.project_root.clone();
    let monitor_url = state.monitor_url.clone();
    let helper_action = action.clone();
    let task = match tauri::async_runtime::spawn_blocking(move || {
        run_control_helper(&project_root, &monitor_url, &helper_action, None)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("Monitor control task failed: {error}")),
    };
    let operation_result = task.as_ref().map(|_| ()).map_err(Clone::clone);
    state.finish_operation(&action, started, &operation_result);
    let helper_result = task?;
    state.note_helper_result(&action, &helper_result)?;
    state.status(None)
}

#[tauri::command]
pub async fn save_startup_config(
    state: State<'_, MonitorState>,
    config: Value,
) -> Result<Value, String> {
    if !config.is_object() {
        return Err("Startup Config must be an object.".to_string());
    }
    let started = state.begin_operation("save-config")?;
    let project_root = state.project_root.clone();
    let monitor_url = state.monitor_url.clone();
    let payload = config.clone();
    let task = match tauri::async_runtime::spawn_blocking(move || {
        run_control_helper(&project_root, &monitor_url, "save-config", Some(&payload))
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("Startup Config task failed: {error}")),
    };
    let operation_result = task.as_ref().map(|_| ()).map_err(Clone::clone);
    state.finish_operation("save-config", started, &operation_result);
    task?;
    state.status(None)
}

fn run_control_helper(
    project_root: &Path,
    monitor_url: &str,
    action: &str,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let helper = project_root
        .join("desktop")
        .join("monitor-tauri")
        .join("tauri-control.cjs");
    if !helper.is_file() {
        return Err(format!(
            "Workbridge Tauri control helper is missing: {}",
            helper.display()
        ));
    }
    let mut command = Command::new("node");
    command
        .arg(&helper)
        .arg(action)
        .current_dir(project_root)
        .env("WORKBRIDGE_PROJECT_ROOT", project_root)
        .env("WORKBRIDGE_MONITOR_URL", monitor_url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if payload.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start Workbridge monitor helper: {error}"))?;
    if let Some(payload) = payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Unable to open Workbridge monitor helper input.".to_string())?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| format!("Unable to write Startup Config: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Workbridge monitor helper failed: {error}"))?;
    if output.status.success() {
        return parse_helper_output(&output.stdout);
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() {
        format!("Workbridge monitor helper exited with {}.", output.status)
    } else {
        error
            .chars()
            .rev()
            .take(500)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    })
}

fn parse_helper_output(stdout: &[u8]) -> Result<Value, String> {
    let output = String::from_utf8_lossy(stdout);
    let line = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "Workbridge monitor helper returned no result.".to_string())?;
    serde_json::from_str(line.trim())
        .map_err(|_| "Workbridge monitor helper returned an invalid result.".to_string())
}

fn supported_action(action: &str) -> bool {
    matches!(
        action,
        "start" | "stop" | "restart" | "build" | "build-restart" | "pause" | "resume"
    )
}

fn operation_state(action: &str) -> &'static str {
    match action {
        "start" => "starting",
        "stop" => "stopping",
        "restart" | "build-restart" => "restarting",
        "build" => "building",
        "pause" => "pausing",
        "resume" => "resuming",
        _ => "working",
    }
}

fn operation_line(action: &str) -> &'static str {
    match action {
        "start" => "Starting Workbridge…",
        "stop" => "Stopping Workbridge…",
        "restart" => "Restarting Workbridge…",
        "build" => "Running npm run build…",
        "build-restart" => "Building and restarting Workbridge…",
        "pause" => "Pausing Workbridge…",
        "resume" => "Resuming Workbridge…",
        "save-config" => "Saving Startup Config…",
        _ => "Working…",
    }
}

fn configured_startup_config() -> Value {
    startup_config_file()
        .and_then(|file| fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| normalize_startup_config(&value))
        .unwrap_or_else(|| json!({}))
}

fn environment_startup_config() -> Value {
    let mut config = Map::new();
    insert_environment_string(&mut config, "publicBaseUrl", "DEVSPACE_PUBLIC_BASE_URL");
    insert_environment_list(&mut config, "allowedRoots", "DEVSPACE_ALLOWED_ROOTS");
    insert_environment_list(&mut config, "auxiliaryRoots", "WORKBRIDGE_AUXILIARY_ROOTS");
    insert_environment_string(&mut config, "worktreeRoot", "DEVSPACE_WORKTREE_ROOT");
    insert_environment_string(&mut config, "stateDir", "DEVSPACE_STATE_DIR");
    if let Ok(value) = env::var("DEVSPACE_TRUST_PROXY") {
        if let Some(value) = parse_bool(&value) {
            config.insert("trustProxy".to_string(), Value::Bool(value));
        }
    }
    Value::Object(config)
}

fn startup_config_file() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("DEVSPACE_CONFIG_DIR") {
        let value = dir.to_string_lossy().trim().to_string();
        if !value.is_empty() {
            return expand_home_path(&value).map(|path| path.join("config.jsonc"));
        }
    }
    home_dir().map(|home| home.join(".devspace").join("config.jsonc"))
}

fn normalize_startup_config(value: &Value) -> Value {
    let server = value.get("server").unwrap_or(value);
    let workspaces = value.get("workspaces").unwrap_or(value);
    let storage = value.get("storage").unwrap_or(value);
    let mut config = Map::new();
    for (key, source) in [
        ("publicBaseUrl", server),
        ("worktreeRoot", workspaces),
        ("stateDir", storage),
    ] {
        if let Some(text) = source
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            config.insert(
                key.to_string(),
                Value::String(if key == "publicBaseUrl" {
                    text.trim_end_matches('/').to_string()
                } else {
                    text.to_string()
                }),
            );
        }
    }
    for key in ["allowedRoots", "auxiliaryRoots"] {
        if let Some(list) = normalize_string_list(workspaces.get(key)) {
            config.insert(key.to_string(), list);
        }
    }
    if let Some(value) = server.get("trustProxy") {
        let parsed = value
            .as_bool()
            .or_else(|| value.as_str().and_then(parse_bool));
        if let Some(parsed) = parsed {
            config.insert("trustProxy".to_string(), Value::Bool(parsed));
        }
    }
    Value::Object(config)
}

fn normalize_string_list(value: Option<&Value>) -> Option<Value> {
    let values = match value? {
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        Value::String(value) => value
            .split([',', '\r', '\n'])
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        _ => return None,
    };
    let mut seen = HashSet::new();
    let values = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .map(Value::String)
        .collect::<Vec<_>>();
    Some(Value::Array(values))
}

fn insert_environment_string(config: &mut Map<String, Value>, key: &str, variable: &str) {
    if let Ok(value) = env::var(variable) {
        let value = value.trim();
        if !value.is_empty() {
            config.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
}

fn insert_environment_list(config: &mut Map<String, Value>, key: &str, variable: &str) {
    if let Ok(value) = env::var(variable) {
        if let Some(value) = normalize_string_list(Some(&Value::String(value))) {
            config.insert(key.to_string(), value);
        }
    }
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn merge_startup_configs(configured: &Value, environment: &Value) -> Value {
    let mut merged = configured.as_object().cloned().unwrap_or_default();
    if let Some(overrides) = environment.as_object() {
        for (key, value) in overrides {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn startup_config_sources(config: &Value, source: &str) -> Value {
    let mut sources = Map::new();
    if let Some(config) = config.as_object() {
        for key in config.keys() {
            sources.insert(key.clone(), Value::String(source.to_string()));
        }
    }
    Value::Object(sources)
}

fn merge_sources(left: Value, right: Value) -> Value {
    merge_startup_configs(&left, &right)
}

fn startup_config_complete(config: &Value) -> bool {
    config
        .get("publicBaseUrl")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
        && config
            .get("allowedRoots")
            .and_then(Value::as_array)
            .is_some_and(|roots| !roots.is_empty())
        && config
            .get("stateDir")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
        && config.get("trustProxy").and_then(Value::as_bool).is_some()
}

fn startup_configs_equal(left: &Value, right: &Value) -> bool {
    if !startup_config_complete(left) || !startup_config_complete(right) {
        return false;
    }
    left.get("publicBaseUrl") == right.get("publicBaseUrl")
        && startup_path_values_equal(left.get("stateDir"), right.get("stateDir"))
        && left.get("trustProxy") == right.get("trustProxy")
        && startup_path_arrays_equal(left.get("allowedRoots"), right.get("allowedRoots"))
        && startup_path_arrays_equal(left.get("auxiliaryRoots"), right.get("auxiliaryRoots"))
        && startup_path_values_equal(left.get("worktreeRoot"), right.get("worktreeRoot"))
}

fn startup_path_values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left.and_then(Value::as_str), right.and_then(Value::as_str)) {
        (Some(left), Some(right)) => path_identity(left) == path_identity(right),
        (None, None) => true,
        _ => false,
    }
}

fn startup_path_arrays_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (
        left.and_then(Value::as_array),
        right.and_then(Value::as_array),
    ) {
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| startup_path_values_equal(Some(left), Some(right)))
        }
        (None, None) => true,
        _ => false,
    }
}

fn path_identity(value: &str) -> Option<String> {
    let expanded = expand_home_path(value)?;
    let normalized = expanded.components().collect::<PathBuf>();
    let mut text = normalized.to_string_lossy().to_string();
    if cfg!(windows) {
        text = text.replace('/', "\\");
        while text.ends_with('\\') && Path::new(&text).parent().is_some() {
            text.pop();
        }
        text = text.to_lowercase();
    } else {
        while text.ends_with('/') && Path::new(&text).parent().is_some() {
            text.pop();
        }
    }
    Some(text)
}

fn expand_home_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home_dir().map(|home| home.join(rest));
    }
    Some(PathBuf::from(value))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn supervisor_control_token_present() -> bool {
    let Some(app_data) = env::var_os("APPDATA") else {
        return false;
    };
    let file = PathBuf::from(app_data)
        .join("@workbridge")
        .join("session-monitor-desktop")
        .join("supervisor-state.json");
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("controlToken")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|token| !token.is_empty())
}

fn memory_log_record(desktop: &Value, runtime_status: Option<&Value>, captured_at: &str) -> Value {
    let server = runtime_status.and_then(|value| value.get("server"));
    let server_memory = server.and_then(|value| value.get("memory"));
    let build = server.and_then(|value| value.get("buildIdentity"));
    let legacy = runtime_status.and_then(|value| value.pointer("/mcpSessions/stats"));
    let modern = runtime_status.and_then(|value| value.get("modernMcpRequests"));
    let modern_stats = modern.and_then(|value| value.get("stats"));
    let modern_timings = modern.and_then(|value| value.get("phaseTimings"));
    let node_saturation = runtime_status.and_then(|value| value.get("nodeSaturation"));
    let processes = desktop
        .get("processes")
        .and_then(Value::as_array)
        .map(|processes| {
            processes
                .iter()
                .map(|process| {
                    let role = match process.get("type").and_then(Value::as_str) {
                        Some("Tauri Host") => "tauri-host",
                        Some("WebView2") => "webview2",
                        _ => "unknown",
                    };
                    json!({
                        "pid": process.get("pid").cloned().unwrap_or(Value::Null),
                        "role": role,
                        "workingSetBytes": process.get("workingSetBytes").cloned().unwrap_or(Value::Null),
                        "privateBytes": process.get("privateBytes").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let system = desktop.get("system").cloned().unwrap_or_else(|| json!({}));
    json!({
        "schema": MEMORY_LOG_SCHEMA,
        "capturedAt": captured_at,
        "runtime": {
            "shell": "tauri",
            "monitorVersion": env!("CARGO_PKG_VERSION"),
            "frameworkVersion": TAURI_FRAMEWORK_VERSION,
            "webRuntimeVersion": Value::Null,
            "platform": env::consts::OS,
            "arch": env::consts::ARCH,
            "hostPid": std::process::id(),
        },
        "desktop": {
            "workingSetBytes": desktop.get("workingSetBytes").cloned().unwrap_or(Value::Null),
            "privateBytes": desktop.get("privateBytes").cloned().unwrap_or(Value::Null),
            "peakWorkingSetBytes": desktop.get("peakWorkingSetBytes").cloned().unwrap_or(Value::Null),
            "processes": processes,
        },
        "server": {
            "pid": server.and_then(|value| value.get("pid")).cloned().unwrap_or(Value::Null),
            "rssBytes": server_memory.and_then(|value| value.get("rssBytes")).cloned().unwrap_or(Value::Null),
            "heapUsedBytes": server_memory.and_then(|value| value.get("heapUsedBytes")).cloned().unwrap_or(Value::Null),
        },
        "system": {
            "totalBytes": system.get("totalBytes").cloned().unwrap_or(Value::Null),
            "freeBytes": system.get("freeBytes").cloned().unwrap_or(Value::Null),
            "usedBytes": system.get("usedBytes").cloned().unwrap_or(Value::Null),
        },
        "workload": {
            "branch": build.and_then(|value| value.get("branch")).cloned().unwrap_or(Value::Null),
            "commit": build.and_then(|value| value.get("commit")).cloned().unwrap_or(Value::Null),
            "dirty": build.and_then(|value| value.get("dirty")).cloned().unwrap_or(Value::Null),
            "modernMcpRequests": modern_stats.and_then(|value| value.get("requests")).and_then(Value::as_u64).unwrap_or(0),
            "activeRequests": legacy.and_then(|value| value.get("activeRequests")).and_then(Value::as_u64).unwrap_or(0)
                + modern_stats.and_then(|value| value.get("active")).and_then(Value::as_u64).unwrap_or(0),
        },
        "modernMcp": {
            "requests": modern_stats.and_then(|value| value.get("requests")).and_then(Value::as_u64).unwrap_or(0),
            "active": modern_stats.and_then(|value| value.get("active")).and_then(Value::as_u64).unwrap_or(0),
            "peakActiveRequests": modern_stats.and_then(|value| value.get("peakActiveRequests")).and_then(Value::as_u64).unwrap_or(0),
            "registrationMs": timing_summary(modern_timings.and_then(|value| value.get("registrationMs"))),
            "handlerMs": timing_summary(modern_timings.and_then(|value| value.get("handlerMs"))),
            "totalMs": timing_summary(modern_timings.and_then(|value| value.get("totalMs"))),
        },
        "nodeSaturation": {
            "eventLoopUtilization": metric_value(node_saturation.and_then(|value| value.get("eventLoopUtilization"))),
            "eventLoopDelayP50Ms": metric_value(node_saturation.and_then(|value| value.get("eventLoopDelayP50Ms"))),
            "eventLoopDelayP95Ms": metric_value(node_saturation.and_then(|value| value.get("eventLoopDelayP95Ms"))),
            "eventLoopDelayP99Ms": metric_value(node_saturation.and_then(|value| value.get("eventLoopDelayP99Ms"))),
            "sampleWindowMs": metric_value(node_saturation.and_then(|value| value.get("sampleWindowMs"))),
        },
        "quality": {
            "desktopComplete": desktop.get("complete").and_then(Value::as_bool).unwrap_or(false),
            "serverReachable": server.is_some(),
        },
    })
}

fn timing_summary(value: Option<&Value>) -> Value {
    json!({
        "count": value.and_then(|value| value.get("count")).and_then(Value::as_u64).unwrap_or(0),
        "p50": metric_value(value.and_then(|value| value.get("p50"))),
        "p95": metric_value(value.and_then(|value| value.get("p95"))),
        "p99": metric_value(value.and_then(|value| value.get("p99"))),
    })
}

fn metric_value(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn daily_memory_file(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 16
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && &name[10..] == ".jsonl"
        && bytes[..10]
            .iter()
            .enumerate()
            .all(|(index, value)| matches!(index, 4 | 7) || value.is_ascii_digit())
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let _ = CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
fn process_exists(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
fn terminate_managed_process(pid: u32) -> Result<(), String> {
    if !process_exists(pid) {
        return Ok(());
    }
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!("Unable to open residual Workbridge process {pid}."));
        }
        let terminated = TerminateProcess(handle, 1) != 0;
        let _ = CloseHandle(handle);
        if !terminated {
            return Err(format!(
                "Unable to terminate residual Workbridge process {pid}."
            ));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while process_exists(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if process_exists(pid) {
        Err(format!("Residual Workbridge process {pid} did not exit."))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn terminate_managed_process(_pid: u32) -> Result<(), String> {
    Err("Residual process recovery is supported on Windows only.".to_string())
}

#[cfg(windows)]
fn desktop_memory_snapshot(host_pid: u32, previous_peak: u64) -> Result<Value, String> {
    let entries = process_entries()?;
    let mut selected = HashSet::from([host_pid]);
    let mut changed = true;
    while changed {
        changed = false;
        for entry in &entries {
            if selected.contains(&entry.parent_pid)
                && entry.exe.eq_ignore_ascii_case("msedgewebview2.exe")
                && selected.insert(entry.pid)
            {
                changed = true;
            }
        }
    }
    let expected = selected.len();
    let mut processes = Vec::new();
    let mut total_working_set = 0u64;
    let mut total_private = 0u64;
    for pid in selected {
        if let Some((working_set, private_bytes)) = process_memory(pid) {
            total_working_set = total_working_set.saturating_add(working_set);
            total_private = total_private.saturating_add(private_bytes);
            processes.push(json!({
                "pid": pid,
                "type": if pid == host_pid { "Tauri Host" } else { "WebView2" },
                "workingSetBytes": working_set,
                "privateBytes": private_bytes,
            }));
        }
    }
    processes.sort_by_key(|value| value.get("pid").and_then(Value::as_u64).unwrap_or(0));
    let system = system_memory()?;
    let complete = processes.len() == expected;
    Ok(json!({
        "workingSetBytes": total_working_set,
        "privateBytes": total_private,
        "peakWorkingSetBytes": previous_peak.max(total_working_set),
        "processes": processes,
        "system": system,
        "complete": complete,
    }))
}

#[cfg(not(windows))]
fn desktop_memory_snapshot(_host_pid: u32, _previous_peak: u64) -> Result<Value, String> {
    Err("Tauri Monitor memory sampling is supported on Windows only.".to_string())
}

#[cfg(windows)]
struct ProcessEntry {
    pid: u32,
    parent_pid: u32,
    exe: String,
}

#[cfg(windows)]
fn process_entries() -> Result<Vec<ProcessEntry>, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Unable to enumerate Tauri process tree.".to_string());
        }
        let mut entries = Vec::new();
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|value| *value == 0)
                    .unwrap_or(entry.szExeFile.len());
                entries.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    exe: String::from_utf16_lossy(&entry.szExeFile[..end]),
                });
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        Ok(entries)
    }
}

#[cfg(windows)]
fn process_memory(pid: u32) -> Option<(u64, u64)> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = GetProcessMemoryInfo(
            handle,
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            size_of_val(&counters) as u32,
        );
        let _ = CloseHandle(handle);
        (ok != 0).then_some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
    }
}

#[cfg(windows)]
fn system_memory() -> Result<Value, String> {
    unsafe {
        let mut status = MEMORYSTATUSEX::default();
        status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return Err("Unable to read system memory status.".to_string());
        }
        Ok(json!({
            "totalBytes": status.ullTotalPhys,
            "freeBytes": status.ullAvailPhys,
            "usedBytes": status.ullTotalPhys.saturating_sub(status.ullAvailPhys),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        env::temp_dir().join(format!("workbridge-tauri-{label}-{unique}"))
    }

    #[test]
    fn host_script_exposes_only_bounded_monitor_api() {
        let script = host_init_script(Path::new(r"C:\workbridge"), "http://127.0.0.1:7677/monitor");
        assert!(script.contains("workbridgeMonitorHost"));
        assert!(script.contains("monitor_status"));
        assert!(script.contains("monitor_reachable"));
        assert!(script.contains("run_monitor_action"));
        assert!(script.contains("save_startup_config"));
        assert!(script.contains("runtimeStatus??{}"));
        assert!(script.contains("\"readOnly\":false"));
        assert!(!script.contains("controlToken"));
        assert!(!script.contains("shell"));
    }

    #[test]
    fn startup_path_comparison_handles_home_and_windows_forms() {
        let Some(home) = home_dir() else {
            return;
        };
        let absolute = home.join("Documents").join("Workbridge");
        let absolute_text = absolute.to_string_lossy().to_string();
        let equivalent = if cfg!(windows) {
            absolute_text.replace('\\', "/").to_uppercase() + "/"
        } else {
            absolute_text.clone() + "/"
        };
        assert_eq!(
            path_identity("~/Documents/Workbridge"),
            path_identity(&equivalent)
        );
        assert_ne!(
            path_identity("~/Documents/Workbridge"),
            path_identity("~/Documents/Other")
        );
    }

    #[test]
    fn startup_config_normalizes_versioned_jsonc_shape() {
        let normalized = normalize_startup_config(&json!({
            "server": {
                "publicBaseUrl": "https://example.test/",
                "trustProxy": true
            },
            "workspaces": {
                "allowedRoots": ["~/projects"],
                "auxiliaryRoots": ["~/.codex", "~/.agents"],
                "worktreeRoot": "~/projects/.workbridge/worktrees"
            },
            "storage": { "stateDir": "~/.workbridge-state" }
        }));

        assert_eq!(normalized["publicBaseUrl"], "https://example.test");
        assert_eq!(normalized["allowedRoots"], json!(["~/projects"]));
        assert_eq!(normalized["auxiliaryRoots"], json!(["~/.codex", "~/.agents"]));
        assert_eq!(normalized["worktreeRoot"], "~/projects/.workbridge/worktrees");
        assert_eq!(normalized["stateDir"], "~/.workbridge-state");
        assert_eq!(normalized["trustProxy"], true);
    }

    #[test]
    fn daily_log_name_is_bounded() {
        assert!(daily_memory_file("2026-08-27.jsonl"));
        assert!(!daily_memory_file("monitor.jsonl"));
        assert!(!daily_memory_file("2026-08-27.json"));
    }

    #[test]
    fn helper_output_and_managed_pid_tracking_are_bounded() {
        let helper =
            parse_helper_output(br#"{"ok":true,"managedPid":4321}"#).expect("helper result");
        assert_eq!(helper.get("managedPid").and_then(Value::as_u64), Some(4321));
        assert!(parse_helper_output(b"not-json\n").is_err());

        let state = MonitorState::new(
            PathBuf::from(r"C:\workbridge"),
            "http://127.0.0.1:9/monitor".to_string(),
        );
        state
            .note_helper_result("start", &json!({ "managedPid": std::process::id() }))
            .expect("track managed pid");
        assert_eq!(
            state.residual_managed_pid().expect("residual pid"),
            Some(std::process::id())
        );
        state
            .remember_runtime(Some(json!({ "server": { "pid": std::process::id() } })))
            .expect("runtime");
        assert_eq!(state.residual_managed_pid().expect("reachable pid"), None);
        state.clear_managed_pid();
    }

    #[test]
    fn memory_log_is_throttled_rotated_and_content_bounded() {
        let root = test_path("memory-log");
        let state_dir = root.to_string_lossy().to_string();
        let directory = root.join("monitor-memory").join("tauri");
        fs::create_dir_all(&directory).expect("memory directory");
        fs::write(directory.join("2000-01-01.jsonl"), "old\n").expect("old log");
        let mut logger = MemoryLogger::new();
        logger.set_state_dir(Some(&state_dir));
        let desktop = json!({
            "workingSetBytes": 100,
            "privateBytes": 80,
            "peakWorkingSetBytes": 120,
            "processes": [{
                "pid": 10,
                "type": "Tauri Host",
                "workingSetBytes": 100,
                "privateBytes": 80
            }],
            "system": { "totalBytes": 1000, "freeBytes": 400, "usedBytes": 600 },
            "complete": true
        });
        let runtime = json!({
            "server": {
                "pid": 20,
                "memory": { "rssBytes": 200, "heapUsedBytes": 50 },
                "buildIdentity": { "branch": "test", "commit": "abc123", "dirty": false }
            },
            "mcpSessions": { "stats": { "activeRequests": 1 } },
            "modernMcpRequests": {
                "stats": { "requests": 2, "active": 1, "peakActiveRequests": 4 },
                "phaseTimings": {
                    "registrationMs": { "count": 2, "p50": 2.1, "p95": 3.2, "p99": 4.3 },
                    "handlerMs": { "count": 2, "p50": 20.1, "p95": 30.2, "p99": 40.3 },
                    "totalMs": { "count": 2, "p50": 22.1, "p95": 33.2, "p99": 44.3 }
                },
                "recent": [{ "requestId": "must-not-persist", "tool": "must-not-persist" }]
            },
            "nodeSaturation": {
                "eventLoopUtilization": 0.42,
                "eventLoopDelayP50Ms": 10.1,
                "eventLoopDelayP95Ms": 20.2,
                "eventLoopDelayP99Ms": 30.3,
                "sampleWindowMs": 1000,
                "debug": "must-not-persist"
            },
            "prompt": "must-not-persist",
            "controlToken": "must-not-persist"
        });
        logger.record(&desktop, Some(&runtime));
        logger.record(&desktop, Some(&runtime));
        let current = directory.join(format!("{}.jsonl", Utc::now().format("%Y-%m-%d")));
        let text = fs::read_to_string(current).expect("current memory log");
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains(MEMORY_LOG_SCHEMA));
        assert!(text.contains("\"shell\":\"tauri\""));
        assert!(text.contains("\"peakActiveRequests\":4"));
        assert!(
            text.contains("\"registrationMs\":{\"count\":2,\"p50\":2.1,\"p95\":3.2,\"p99\":4.3}")
        );
        assert!(text.contains("\"eventLoopUtilization\":0.42"));
        assert!(!text.contains("must-not-persist"));
        assert!(!directory.join("2000-01-01.jsonl").exists());
        assert!(logger.last_error.is_none());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn memory_log_failure_is_non_fatal_and_reported() {
        let blocker = test_path("memory-error");
        fs::write(&blocker, "not a directory").expect("blocker");
        let mut logger = MemoryLogger::new();
        logger.set_state_dir(Some(blocker.to_string_lossy().as_ref()));
        logger.record(
            &json!({
                "workingSetBytes": 1,
                "privateBytes": 1,
                "peakWorkingSetBytes": 1,
                "processes": [],
                "system": { "totalBytes": 1, "freeBytes": 1, "usedBytes": 0 },
                "complete": false
            }),
            None,
        );
        assert!(logger
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("append:")));
        fs::remove_file(blocker).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn native_memory_sample_contains_the_tauri_host_only_from_its_tree() {
        let sample = desktop_memory_snapshot(std::process::id(), 0).expect("memory sample");
        let processes = sample
            .get("processes")
            .and_then(Value::as_array)
            .expect("processes");
        assert!(processes.iter().any(|process| {
            process.get("pid").and_then(Value::as_u64) == Some(std::process::id() as u64)
                && process.get("type").and_then(Value::as_str) == Some("Tauri Host")
        }));
        assert!(sample
            .pointer("/system/totalBytes")
            .and_then(Value::as_u64)
            .is_some_and(|v| v > 0));
    }
}
