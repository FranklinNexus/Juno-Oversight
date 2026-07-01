use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::workbench_root_path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRunResult {
  pub run_id: String,
  pub pid: u32,
  pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsResult {
  pub run_id: String,
  pub lines: Vec<String>,
}

#[derive(Deserialize)]
struct RunManifestMeta {
  #[serde(rename = "runId")]
  run_id: String,
  #[serde(rename = "maxMinutes", default = "default_max_minutes")]
  max_minutes: u64,
}

fn default_max_minutes() -> u64 {
  25
}

pub struct OrchestratorRuntime {
  child: Mutex<Option<Child>>,
  active_run_id: Mutex<Option<String>>,
  started_at: Mutex<Option<SystemTime>>,
  manifest_path: Mutex<Option<PathBuf>>,
}

impl OrchestratorRuntime {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
      active_run_id: Mutex::new(None),
      started_at: Mutex::new(None),
      manifest_path: Mutex::new(None),
    }
  }

  fn is_running(&self) -> bool {
    let mut guard = self.child.lock().expect("child lock");
    if let Some(child) = guard.as_mut() {
      if let Ok(Some(_)) = child.try_wait() {
        *guard = None;
        return false;
      }
      return true;
    }
    false
  }
}

fn juno_project_root() -> PathBuf {
  if let Ok(from_env) = std::env::var("JUNO_OVERSIGHT_ROOT") {
    return PathBuf::from(from_env);
  }
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("project root")
    .to_path_buf()
}

fn spawn_script_path() -> PathBuf {
  juno_project_root().join("orchestrator/dist/spawn-run.js")
}

fn dotenv_value(key: &str) -> Option<String> {
  if let Ok(from_env) = std::env::var(key) {
    if !from_env.trim().is_empty() {
      return Some(from_env);
    }
  }
  let root = juno_project_root();
  for name in [".env.local", ".env"] {
    let path = root.join(name);
    let Ok(content) = fs::read_to_string(&path) else {
      continue;
    };
    for line in content.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() || trimmed.starts_with('#') {
        continue;
      }
      let Some((k, v)) = trimmed.split_once('=') else {
        continue;
      };
      if k.trim() != key {
        continue;
      }
      let mut value = v.trim().to_string();
      if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
      {
        value = value[1..value.len() - 1].to_string();
      }
      if !value.is_empty() {
        return Some(value);
      }
    }
  }
  None
}

fn apply_project_env(cmd: &mut Command) {
  let project_root = juno_project_root();
  cmd.env("JUNO_OVERSIGHT_ROOT", &project_root);
  if let Some(workbench) = dotenv_value("AGENT_WORKBENCH_ROOT") {
    cmd.env("AGENT_WORKBENCH_ROOT", workbench);
  }
  if let Some(api_key) = dotenv_value("CURSOR_API_KEY") {
    cmd.env("CURSOR_API_KEY", api_key);
  }
  if let Some(openai) = dotenv_value("OPENAI_API_KEY") {
    cmd.env("OPENAI_API_KEY", openai);
  }
}

fn read_manifest_meta(path: &Path) -> Result<RunManifestMeta, String> {
  let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
  serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_orchestrator_status(root: &Path, run_id: &str, status: &str) -> Result<(), String> {
  let state_path = root.join("state/orchestrator.json");
  let mut state: serde_json::Value = if state_path.is_file() {
    let content = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
  } else {
    serde_json::json!({})
  };

  if let Some(obj) = state.as_object_mut() {
    obj.insert(
      "activeRunId".to_string(),
      serde_json::Value::String(run_id.to_string()),
    );
    obj.insert(
      "activeRunStatus".to_string(),
      serde_json::Value::String(status.to_string()),
    );
    obj.insert(
      "lastRunId".to_string(),
      serde_json::Value::String(run_id.to_string()),
    );
    obj.insert(
      "updatedAt".to_string(),
      serde_json::Value::String(iso_now()),
    );
  }

  fs::write(
    &state_path,
    serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())
}

fn iso_now() -> String {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  format!("{secs}")
}

fn tail_lines(path: &Path, max_lines: usize) -> Result<Vec<String>, String> {
  if !path.is_file() {
    return Ok(vec![]);
  }
  let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
  let mut lines: Vec<&str> = content.lines().collect();
  if lines.len() > max_lines {
    lines = lines.split_off(lines.len() - max_lines);
  }
  Ok(lines.into_iter().map(str::to_string).collect())
}

fn heartbeat_stale(run_dir: &Path, stale_secs: u64) -> bool {
  let heartbeat = run_dir.join("heartbeat.json");
  if !heartbeat.is_file() {
    return true;
  }
  let Ok(meta) = fs::metadata(&heartbeat) else {
    return true;
  };
  let Ok(modified) = meta.modified() else {
    return true;
  };
  modified
    .elapsed()
    .map(|d| d > Duration::from_secs(stale_secs))
    .unwrap_or(true)
}

fn kill_active_child(runtime: &OrchestratorRuntime) -> Result<(), String> {
  let mut guard = runtime.child.lock().expect("child lock");
  if let Some(mut child) = guard.take() {
    let _ = child.kill();
    let _ = child.wait();
  }
  *runtime.active_run_id.lock().expect("run id lock") = None;
  *runtime.started_at.lock().expect("started lock") = None;
  *runtime.manifest_path.lock().expect("manifest lock") = None;
  Ok(())
}

fn node_binary() -> PathBuf {
  if let Ok(from_env) = std::env::var("JUNO_NODE_PATH") {
    return PathBuf::from(from_env);
  }
  let nvm_node = PathBuf::from(r"C:\nvm4w\nodejs\node.exe");
  if nvm_node.is_file() {
    return nvm_node;
  }
  PathBuf::from("node")
}

fn node_binary() -> PathBuf {
  if let Ok(from_env) = std::env::var("JUNO_NODE_PATH") {
    return PathBuf::from(from_env);
  }
  let nvm_node = PathBuf::from(r"C:\nvm4w\nodejs\node.exe");
  if nvm_node.is_file() {
    return nvm_node;
  }
  PathBuf::from("node")
}

fn scheduler_daemon_script() -> PathBuf {
  juno_project_root().join("orchestrator/dist/scheduler-daemon.js")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
  pub running: bool,
  pub pid: Option<u32>,
  pub enabled: bool,
  pub runs_today: u64,
  pub last_action: Option<String>,
  pub last_tick_at: Option<String>,
  pub daemon_started_at: Option<String>,
}

pub struct SchedulerDaemon {
  child: Mutex<Option<Child>>,
}

impl SchedulerDaemon {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
    }
  }

  pub fn is_running(&self) -> bool {
    let mut guard = self.child.lock().expect("scheduler lock");
    if let Some(child) = guard.as_mut() {
      if let Ok(Some(_)) = child.try_wait() {
        *guard = None;
        return false;
      }
      return true;
    }
    false
  }
}

pub fn get_scheduler_status() -> Result<SchedulerStatus, String> {
  let state_path = workbench_root_path().join("state/scheduler.json");
  let mut status = SchedulerStatus {
    running: false,
    pid: None,
    enabled: false,
    runs_today: 0,
    last_action: None,
    last_tick_at: None,
    daemon_started_at: None,
  };

  if state_path.is_file() {
    let content = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
      status.enabled = json.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
      status.runs_today = json
        .get("runsToday")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
      status.last_action = json
        .get("lastAction")
        .and_then(|v| v.as_str())
        .map(str::to_string);
      status.last_tick_at = json
        .get("lastTickAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
      status.daemon_started_at = json
        .get("daemonStartedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    }
  }

  let pid_path = workbench_root_path().join("state/daemon.pid");
  if pid_path.is_file() {
    if let Ok(text) = fs::read_to_string(&pid_path) {
      if let Ok(pid) = text.trim().parse::<u32>() {
        status.pid = Some(pid);
        status.running = true;
      }
    }
  }

  Ok(status)
}

pub fn start_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<SchedulerStatus, String> {
  if daemon.is_running() {
    return get_scheduler_status();
  }

  let script = scheduler_daemon_script();
  if !script.is_file() {
    return Err(format!(
      "scheduler not built; run `pnpm orchestrator:build` ({})",
      script.display()
    ));
  }

  let mut cmd = Command::new(node_binary());
  cmd.arg(&script);
  apply_project_env(&mut cmd);
  cmd.env("AGENT_WORKBENCH_ROOT", workbench_root_path());

  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to start scheduler daemon: {e}"))?;

  *daemon.child.lock().expect("scheduler lock") = Some(child);
  std::thread::sleep(Duration::from_secs(1));
  get_scheduler_status()
}

pub fn stop_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<(), String> {
  let mut guard = daemon.child.lock().expect("scheduler lock");
  if let Some(mut child) = guard.take() {
    let _ = child.kill();
    let _ = child.wait();
  }

  let state_path = workbench_root_path().join("state/scheduler.json");
  if state_path.is_file() {
    let content = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    let mut json: serde_json::Value =
      serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    if let Some(obj) = json.as_object_mut() {
      obj.insert("enabled".to_string(), serde_json::Value::Bool(false));
      obj.insert("updatedAt".to_string(), serde_json::Value::String(iso_now()));
    }
    fs::write(
      &state_path,
      serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
  }

  let pid_path = workbench_root_path().join("state/daemon.pid");
  let _ = fs::remove_file(pid_path);
  Ok(())
}

fn scheduler_daemon_script() -> PathBuf {
  juno_project_root().join("orchestrator/dist/scheduler-daemon.js")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
  pub running: bool,
  pub pid: Option<u32>,
  pub enabled: bool,
  pub runs_today: u64,
  pub last_action: Option<String>,
  pub last_tick_at: Option<String>,
  pub daemon_started_at: Option<String>,
}

pub struct SchedulerDaemon {
  child: Mutex<Option<Child>>,
}

impl SchedulerDaemon {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
    }
  }

  pub fn is_running(&self) -> bool {
    let mut guard = self.child.lock().expect("scheduler lock");
    if let Some(child) = guard.as_mut() {
      if let Ok(Some(_)) = child.try_wait() {
        *guard = None;
        return false;
      }
      return true;
    }
    false
  }
}

pub fn get_scheduler_status() -> Result<SchedulerStatus, String> {
  let state_path = workbench_root_path().join("state/scheduler.json");
  let mut status = SchedulerStatus {
    running: false,
    pid: None,
    enabled: false,
    runs_today: 0,
    last_action: None,
    last_tick_at: None,
    daemon_started_at: None,
  };

  if state_path.is_file() {
    let content = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
      status.enabled = json.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
      status.runs_today = json
        .get("runsToday")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
      status.last_action = json
        .get("lastAction")
        .and_then(|v| v.as_str())
        .map(str::to_string);
      status.last_tick_at = json
        .get("lastTickAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
      status.daemon_started_at = json
        .get("daemonStartedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    }
  }

  let pid_path = workbench_root_path().join("state/daemon.pid");
  if pid_path.is_file() {
    if let Ok(text) = fs::read_to_string(&pid_path) {
      if let Ok(pid) = text.trim().parse::<u32>() {
        status.pid = Some(pid);
        status.running = true;
      }
    }
  }

  Ok(status)
}

pub fn start_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<SchedulerStatus, String> {
  if daemon.is_running() {
    return get_scheduler_status();
  }

  let script = scheduler_daemon_script();
  if !script.is_file() {
    return Err(format!(
      "scheduler not built; run `pnpm orchestrator:build` ({})",
      script.display()
    ));
  }

  let mut cmd = Command::new(node_binary());
  cmd.arg(&script);
  apply_project_env(&mut cmd);
  cmd.env("AGENT_WORKBENCH_ROOT", workbench_root_path());

  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to start scheduler daemon: {e}"))?;

  *daemon.child.lock().expect("scheduler lock") = Some(child);
  std::thread::sleep(Duration::from_secs(1));
  get_scheduler_status()
}

pub fn stop_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<(), String> {
  let mut guard = daemon.child.lock().expect("scheduler lock");
  if let Some(mut child) = guard.take() {
    let _ = child.kill();
    let _ = child.wait();
  }

  let state_path = workbench_root_path().join("state/scheduler.json");
  if state_path.is_file() {
    let content = fs::read_to_string(&state_path).map_err(|e| e.to_string())?;
    let mut json: serde_json::Value =
      serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    if let Some(obj) = json.as_object_mut() {
      obj.insert("enabled".to_string(), serde_json::Value::Bool(false));
      obj.insert("updatedAt".to_string(), serde_json::Value::String(iso_now()));
    }
    fs::write(
      &state_path,
      serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
  }

  let pid_path = workbench_root_path().join("state/daemon.pid");
  let _ = fs::remove_file(pid_path);
  Ok(())
}

pub fn spawn_agent_run(
  runtime: &OrchestratorRuntime,
  manifest_path: String,
  dry_run: Option<bool>,
) -> Result<SpawnRunResult, String> {
  if runtime.is_running() {
    return Err("A run is already active".to_string());
  }

  let manifest = PathBuf::from(&manifest_path);
  if !manifest.is_file() {
    return Err(format!("manifest not found: {manifest_path}"));
  }

  let script = spawn_script_path();
  if !script.is_file() {
    return Err(format!(
      "orchestrator not built; run `pnpm orchestrator:build` ({})",
      script.display()
    ));
  }

  let meta = read_manifest_meta(&manifest)?;
  let workbench = workbench_root_path();

  let mut cmd = Command::new(node_binary());
  cmd
    .arg(&script)
    .arg("--manifest")
    .arg(&manifest);
  apply_project_env(&mut cmd);
  cmd.env("AGENT_WORKBENCH_ROOT", &workbench);
  if dry_run.unwrap_or(false) {
    cmd.arg("--dry-run");
  }

  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to spawn orchestrator: {e}"))?;

  let pid = child.id();
  *runtime.child.lock().expect("child lock") = Some(child);
  *runtime
    .active_run_id
    .lock()
    .expect("run id lock") = Some(meta.run_id.clone());
  *runtime.started_at.lock().expect("started lock") = Some(SystemTime::now());
  *runtime
    .manifest_path
    .lock()
    .expect("manifest lock") = Some(manifest);

  write_orchestrator_status(&workbench, &meta.run_id, "running")?;

  Ok(SpawnRunResult {
    run_id: meta.run_id,
    pid,
    status: "running".to_string(),
  })
}

pub fn kill_agent_run(runtime: &OrchestratorRuntime) -> Result<(), String> {
  let run_id = runtime
    .active_run_id
    .lock()
    .expect("run id lock")
    .clone();
  kill_active_child(runtime)?;
  if let Some(run_id) = run_id {
    write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
  }
  Ok(())
}

pub fn read_run_events(run_id: String, max_lines: Option<u32>) -> Result<RunEventsResult, String> {
  let limit = max_lines.unwrap_or(50).clamp(1, 500) as usize;
  let events_path = workbench_root_path().join("runs").join(&run_id).join("events.jsonl");
  let lines = tail_lines(&events_path, limit)?;
  Ok(RunEventsResult { run_id, lines })
}

pub fn watchdog_tick(runtime: &OrchestratorRuntime) -> Result<(), String> {
  let mut guard = runtime.child.lock().expect("child lock");
  let Some(child) = guard.as_mut() else {
    return Ok(());
  };

  if let Ok(Some(status)) = child.try_wait() {
    let run_id = runtime
      .active_run_id
      .lock()
      .expect("run id lock")
      .clone()
      .unwrap_or_default();
    let final_status = if status.success() {
      "done"
    } else {
      "failed"
    };
    if !run_id.is_empty() {
      write_orchestrator_status(&workbench_root_path(), &run_id, final_status)?;
    }
    *guard = None;
    *runtime.active_run_id.lock().expect("run id lock") = None;
    *runtime.started_at.lock().expect("started lock") = None;
    *runtime.manifest_path.lock().expect("manifest lock") = None;
    return Ok(());
  }

  let manifest_path = runtime
    .manifest_path
    .lock()
    .expect("manifest lock")
    .clone();
  let run_id = runtime
    .active_run_id
    .lock()
    .expect("run id lock")
    .clone()
    .unwrap_or_default();

  let Some(manifest_path) = manifest_path else {
    return Ok(());
  };

  let meta = read_manifest_meta(&manifest_path)?;
  let run_dir = manifest_path
    .parent()
    .map(Path::to_path_buf)
    .unwrap_or_else(|| workbench_root_path().join("runs").join(&run_id));

  if heartbeat_stale(&run_dir, 300) {
    write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
    let _ = child.kill();
    let _ = child.wait();
    *guard = None;
    *runtime.active_run_id.lock().expect("run id lock") = None;
    return Ok(());
  }

  let started = runtime.started_at.lock().expect("started lock");
  if let Some(started_at) = *started {
    if started_at.elapsed().unwrap_or(Duration::ZERO)
      > Duration::from_secs(meta.max_minutes.saturating_mul(60))
    {
      write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
      let _ = child.kill();
      let _ = child.wait();
      *guard = None;
      *runtime.active_run_id.lock().expect("run id lock") = None;
    }
  }

  Ok(())
}
