mod missions;
mod orchestrator;
mod promote;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::Manager;
use tauri::State;

use orchestrator::{OrchestratorRuntime, SchedulerDaemon};

pub fn workbench_root_path() -> PathBuf {
  if let Ok(from_env) = std::env::var("AGENT_WORKBENCH_ROOT") {
    if !from_env.trim().is_empty() {
      return PathBuf::from(from_env);
    }
  }
  PathBuf::from(r"E:\AgentWorkbench")
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
) -> Result<promote::PromoteResult, String> {
  promote::promote_to_vault(rule_id, relative_path)
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
    ])
    .setup(|app| {
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
