use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::State;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(HudSystemState(Mutex::new(System::new())))
    .invoke_handler(tauri::generate_handler![get_hud_system_snapshot, get_jupiter_telemetry])
    .setup(|app| {
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
