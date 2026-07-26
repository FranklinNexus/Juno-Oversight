mod missions;
mod orchestrator;
mod promote;
mod workbench;

use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::Manager;
use tauri::State;

use orchestrator::{OrchestratorRuntime, SchedulerDaemon};

fn dotenv_value_at(project_root: &Path, key: &str) -> Option<String> {
  for name in [".env.local", ".env"] {
    let Ok(content) = fs::read_to_string(project_root.join(name)) else {
      continue;
    };
    for line in content.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() || trimmed.starts_with('#') {
        continue;
      }
      let Some((candidate_key, raw_value)) = trimmed.split_once('=') else {
        continue;
      };
      if candidate_key.trim() != key {
        continue;
      }
      let mut value = raw_value.trim();
      if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
          || (value.starts_with('\'') && value.ends_with('\'')))
      {
        value = &value[1..value.len() - 1];
      }
      if !value.trim().is_empty() {
        return Some(value.to_string());
      }
    }
  }
  None
}

fn resolve_workbench_root(environment_override: Option<&str>, project_root: &Path) -> PathBuf {
  if let Some(from_env) = environment_override.filter(|value| !value.trim().is_empty()) {
    return PathBuf::from(from_env.trim());
  }
  dotenv_value_at(project_root, "AGENT_WORKBENCH_ROOT")
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from(r"E:\AgentWorkbench"))
}

pub fn workbench_root_path() -> PathBuf {
  let environment_override = std::env::var("AGENT_WORKBENCH_ROOT").ok();
  resolve_workbench_root(environment_override.as_deref(), &orchestrator::juno_project_root())
}

struct HudSystemState(Mutex<System>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HudSystemSnapshot {
  cpu_pct: u8,
  ram_mb: u64,
  ram_total_mb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JupiterTelemetry {
  node: String,
  ssh_connected: bool,
  thermal_c: u8,
  npu_pct: u8,
  latency_ms: u16,
}

#[tauri::command]
fn get_hud_system_snapshot(state: State<'_, HudSystemState>) -> HudSystemSnapshot {
  let mut system = state.0.lock().expect("system lock");
  system.refresh_cpu();
  system.refresh_memory();

  let ram_used_mb = system.used_memory() / 1024 / 1024;
  let ram_total_mb = system.total_memory() / 1024 / 1024;
  let cpu = system
    .global_cpu_info()
    .cpu_usage()
    .round()
    .clamp(0.0, 100.0) as u8;

  HudSystemSnapshot {
    cpu_pct: cpu,
    ram_mb: ram_used_mb,
    ram_total_mb,
  }
}

#[tauri::command]
fn get_jupiter_telemetry() -> JupiterTelemetry {
  let tick = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);

  let wave = (tick % 20) as f32 / 20.0;
  let thermal = (48.0 + wave * 24.0).round() as u8;
  let npu = (30.0 + ((tick % 17) as f32 / 17.0) * 60.0).round() as u8;

  JupiterTelemetry {
    node: "JUPITER-EDGE-01".to_string(),
    ssh_connected: true,
    thermal_c: thermal,
    npu_pct: npu,
    latency_ms: (20 + (tick % 35)) as u16,
  }
}

#[tauri::command]
fn list_staging_entries() -> Result<Vec<promote::StagingEntry>, String> {
  promote::list_staging_entries()
}

#[tauri::command]
fn list_promote_rules() -> Vec<promote::PromoteRule> {
  promote::list_promote_rules()
}

#[tauri::command]
fn preview_promote_to_vault(
  rule_id: String,
  relative_path: String,
) -> Result<promote::PromotePreview, String> {
  promote::preview_promote_to_vault(rule_id, relative_path)
}

#[tauri::command]
fn promote_to_vault(
  rule_id: String,
  relative_path: String,
  confirmed: Option<bool>,
) -> Result<promote::PromoteResult, String> {
  promote::promote_to_vault(rule_id, relative_path, confirmed)
}

#[tauri::command]
fn read_promote_log(max_lines: Option<u32>) -> Result<Vec<String>, String> {
  promote::read_promote_log(max_lines)
}

#[tauri::command]
fn spawn_agent_run(
  runtime: State<'_, OrchestratorRuntime>,
  manifest_path: String,
  dry_run: Option<bool>,
) -> Result<orchestrator::SpawnRunResult, String> {
  orchestrator::spawn_agent_run(&runtime, manifest_path, dry_run)
}

#[tauri::command]
fn kill_agent_run(runtime: State<'_, OrchestratorRuntime>) -> Result<(), String> {
  orchestrator::kill_agent_run(&runtime)
}

#[tauri::command]
fn read_run_events(
  run_id: String,
  max_lines: Option<u32>,
) -> Result<orchestrator::RunEventsResult, String> {
  orchestrator::read_run_events(run_id, max_lines)
}

#[tauri::command]
fn get_scheduler_status() -> Result<orchestrator::SchedulerStatus, String> {
  orchestrator::get_scheduler_status()
}

#[tauri::command]
fn start_scheduler_daemon(
  daemon: State<'_, SchedulerDaemon>,
) -> Result<orchestrator::SchedulerStatus, String> {
  orchestrator::start_scheduler_daemon(&daemon)
}

#[tauri::command]
fn stop_scheduler_daemon(daemon: State<'_, SchedulerDaemon>) -> Result<(), String> {
  orchestrator::stop_scheduler_daemon(&daemon)
}

#[tauri::command]
fn get_missions_snapshot() -> Result<Vec<missions::MissionSummary>, String> {
  missions::get_missions_snapshot()
}

#[tauri::command]
fn get_workbench_snapshot() -> Result<workbench::WorkbenchSnapshot, String> {
  workbench::get_workbench_snapshot()
}

#[tauri::command]
fn inspect_operator_recovery() -> Result<orchestrator::OperatorRecoveryInventory, String> {
  orchestrator::inspect_operator_recovery()
}

#[tauri::command]
fn apply_operator_recovery(
  request: orchestrator::OperatorRecoveryApplyRequest,
) -> Result<orchestrator::OperatorRecoveryApplyResult, String> {
  orchestrator::apply_operator_recovery(request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(HudSystemState(Mutex::new(System::new())))
    .manage(OrchestratorRuntime::new())
    .manage(SchedulerDaemon::new())
    .invoke_handler(tauri::generate_handler![
      get_hud_system_snapshot,
      get_jupiter_telemetry,
      list_staging_entries,
      list_promote_rules,
      preview_promote_to_vault,
      promote_to_vault,
      read_promote_log,
      spawn_agent_run,
      kill_agent_run,
      read_run_events,
      get_scheduler_status,
      start_scheduler_daemon,
      stop_scheduler_daemon,
      get_missions_snapshot,
      get_workbench_snapshot,
      inspect_operator_recovery,
      apply_operator_recovery,
    ])
    .setup(|app| {
      if !cfg!(debug_assertions) {
        let resource_dir = app.path().resource_dir()?;
        orchestrator::configure_bundled_runtime(&resource_dir).map_err(io::Error::other)?;
      }
      let handle = app.handle().clone();
      std::thread::spawn(move || {
        loop {
          std::thread::sleep(Duration::from_secs(15));
          if let Some(runtime) = handle.try_state::<OrchestratorRuntime>() {
            let _ = orchestrator::watchdog_tick(&runtime);
          }
        }
      });

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::resolve_workbench_root;
  use std::fs;
  use std::path::PathBuf;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("juno-settings-{label}-{}-{nonce}", std::process::id()))
  }

  #[test]
  fn dotenv_configures_a_non_default_workbench_without_process_env() {
    let project = temp_root("dotenv-workbench");
    let expected = project.join("custom-workbench");
    fs::create_dir_all(&project).expect("create project");
    fs::write(
      project.join(".env.local"),
      format!("AGENT_WORKBENCH_ROOT=\"{}\"\n", expected.display()),
    )
    .expect("write dotenv");

    assert_eq!(resolve_workbench_root(None, &project), expected);
    fs::remove_dir_all(project).expect("remove project");
  }

  #[test]
  fn process_environment_overrides_project_dotenv() {
    let project = temp_root("env-precedence");
    fs::create_dir_all(&project).expect("create project");
    fs::write(project.join(".env.local"), "AGENT_WORKBENCH_ROOT=dotenv-root\n")
      .expect("write dotenv");

    assert_eq!(
      resolve_workbench_root(Some("explicit-root"), &project),
      PathBuf::from("explicit-root")
    );
    fs::remove_dir_all(project).expect("remove project");
  }
}
