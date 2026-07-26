use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

use crate::workbench_root_path;

const PROGRESS_EXCERPT_CHARS: usize = 1_200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionPhase {
  pub id: String,
  pub goal: String,
  pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionSummary {
  pub id: String,
  pub title: String,
  pub status: String,
  pub provider: String,
  pub current_phase_id: Option<String>,
  pub phases: Vec<MissionPhase>,
  pub progress_excerpt: Option<String>,
  pub blocked_reason: Option<String>,
}

#[derive(Deserialize)]
struct MissionDocument {
  id: Option<String>,
  title: Option<String>,
  status: Option<String>,
  provider: Option<String>,
  #[serde(default)]
  phases: Vec<MissionPhaseDocument>,
}

#[derive(Deserialize)]
struct MissionPhaseDocument {
  id: String,
  #[serde(default)]
  goal: String,
  #[serde(default = "queued_status")]
  status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissionRuntimeFile {
  status: Option<String>,
  blocked_reason: Option<String>,
}

fn queued_status() -> String {
  "queued".to_string()
}

fn read_optional_regular(path: &Path, label: &str) -> Result<Option<String>, String> {
  if !path.exists() {
    return Ok(None);
  }
  let metadata = fs::symlink_metadata(path)
    .map_err(|error| format!("{label} is unavailable ({}): {error}", path.display()))?;
  if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
    return Err(format!("{label} must be a regular file: {}", path.display()));
  }
  fs::read_to_string(path)
    .map(Some)
    .map_err(|error| format!("{label} is not readable UTF-8 ({}): {error}", path.display()))
}

fn normalize_mission_status(raw: &str) -> String {
  let normalized = raw.trim().to_ascii_uppercase();
  match normalized.as_str() {
    "COMPLETE" | "COMPLETED" | "DONE" => "UNVERIFIED_COMPLETE".to_string(),
    "TERMINAL_BLOCKED" => "BLOCKED".to_string(),
    "" => "UNKNOWN".to_string(),
    _ => normalized,
  }
}

fn explicit_status(text: &str) -> Option<String> {
  text.lines().find_map(|line| {
    let trimmed = line.trim().trim_matches('*').trim();
    let (key, value) = trimmed.split_once(':')?;
    if !key.trim().eq_ignore_ascii_case("status") {
      return None;
    }
    let token = value
      .split_whitespace()
      .next()
      .unwrap_or_default()
      .trim_matches('*');
    Some(normalize_mission_status(token))
  })
}

fn first_heading(text: &str) -> Option<String> {
  text
    .lines()
    .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
    .filter(|heading| !heading.is_empty())
    .map(str::to_string)
}

fn truncate(text: &str) -> String {
  text.chars().take(PROGRESS_EXCERPT_CHARS).collect()
}

fn runtime_file_for_mission(mission_id: &str) -> Option<&'static str> {
  match mission_id {
    "juno-agi-literature-2026" => Some("agi-daemon.json"),
    "juno-axiom-book-2026" => Some("book-daemon.json"),
    _ => None,
  }
}

fn read_mission_runtime(root: &Path, mission_id: &str) -> Result<Option<MissionRuntimeFile>, String> {
  let Some(file_name) = runtime_file_for_mission(mission_id) else {
    return Ok(None);
  };
  let path = root.join("state").join(file_name);
  let Some(text) = read_optional_regular(&path, "Mission daemon state")? else {
    return Ok(None);
  };
  serde_json::from_str(&text)
    .map(Some)
    .map_err(|error| format!("Mission daemon state is invalid ({}): {error}", path.display()))
}

fn conservative_status(
  declared: Option<&str>,
  checkpoint: Option<&str>,
  progress: Option<&str>,
  runtime: Option<&MissionRuntimeFile>,
) -> String {
  let mut status = declared
    .map(normalize_mission_status)
    .or_else(|| checkpoint.and_then(explicit_status))
    .or_else(|| progress.and_then(explicit_status))
    .unwrap_or_else(|| "UNKNOWN".to_string());

  if checkpoint.and_then(explicit_status).as_deref() == Some("BLOCKED")
    || progress.and_then(explicit_status).as_deref() == Some("BLOCKED")
    || runtime
      .and_then(|state| state.status.as_deref())
      .map(|value| value.to_ascii_lowercase().contains("blocked"))
      .unwrap_or(false)
  {
    status = "BLOCKED".to_string();
  }
  status
}

fn parse_mission_dir(root: &Path, dir: &Path) -> Result<MissionSummary, String> {
  let directory_id = dir
    .file_name()
    .and_then(|name| name.to_str())
    .filter(|value| !value.is_empty())
    .ok_or_else(|| format!("Mission directory has no valid UTF-8 id: {}", dir.display()))?
    .to_string();
  let mission_text = read_optional_regular(&dir.join("mission.yaml"), "Mission manifest")?;
  let checkpoint = read_optional_regular(&dir.join("checkpoint.md"), "Mission checkpoint")?;
  let progress = read_optional_regular(&dir.join("progress.md"), "Mission progress")?;
  let north_star = read_optional_regular(&dir.join("north-star.md"), "Mission north star")?;

  let document = mission_text
    .as_deref()
    .map(|text| {
      serde_yaml::from_str::<MissionDocument>(text)
        .map_err(|error| format!("Mission manifest is invalid ({}): {error}", dir.display()))
    })
    .transpose()?;
  let id = document
    .as_ref()
    .and_then(|value| value.id.clone())
    .unwrap_or(directory_id);
  let runtime = read_mission_runtime(root, &id)?;
  let title = document
    .as_ref()
    .and_then(|value| value.title.clone())
    .or_else(|| north_star.as_deref().and_then(first_heading))
    .unwrap_or_else(|| id.clone());
  let status = conservative_status(
    document.as_ref().and_then(|value| value.status.as_deref()),
    checkpoint.as_deref(),
    progress.as_deref(),
    runtime.as_ref(),
  );
  let provider = document
    .as_ref()
    .and_then(|value| value.provider.clone())
    .unwrap_or_else(|| "unknown".to_string());
  let phases: Vec<MissionPhase> = document
    .map(|value| {
      value
        .phases
        .into_iter()
        .map(|phase| MissionPhase {
          id: phase.id,
          goal: phase.goal,
          status: phase.status,
        })
        .collect()
    })
    .unwrap_or_default();
  let current_phase_id = phases
    .iter()
    .find(|phase| phase.status == "in_progress")
    .or_else(|| phases.iter().find(|phase| phase.status.contains("blocked")))
    .or_else(|| phases.iter().find(|phase| phase.status == "queued"))
    .map(|phase| phase.id.clone());
  let progress_excerpt = progress
    .as_deref()
    .or(checkpoint.as_deref())
    .map(truncate);
  let blocked_reason = runtime
    .and_then(|state| state.blocked_reason)
    .filter(|reason| !reason.is_empty());

  Ok(MissionSummary {
    id,
    title,
    status,
    provider,
    current_phase_id,
    phases,
    progress_excerpt,
    blocked_reason,
  })
}

fn get_missions_snapshot_at(root: &Path) -> Result<Vec<MissionSummary>, String> {
  let missions_dir = root.join("missions");
  if !missions_dir.is_dir() {
    return Ok(vec![]);
  }
  let mut out = vec![];
  for entry in fs::read_dir(&missions_dir).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let file_type = entry.file_type().map_err(|error| error.to_string())?;
    if !file_type.is_dir() || file_type.is_symlink() {
      continue;
    }
    out.push(parse_mission_dir(root, &entry.path())?);
  }
  out.sort_by(|left, right| left.id.cmp(&right.id));
  Ok(out)
}

pub fn get_missions_snapshot() -> Result<Vec<MissionSummary>, String> {
  get_missions_snapshot_at(&workbench_root_path())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("clock")
      .as_nanos();
    std::env::temp_dir().join(format!("juno-missions-{label}-{}-{nonce}", std::process::id()))
  }

  fn write_fixture(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    fs::write(path, text).expect("write fixture");
  }

  #[test]
  fn mission_without_manifest_is_visible_and_blocked() {
    let root = temp_root("no-manifest");
    write_fixture(
      &root,
      "missions/juno-agi-literature-2026/checkpoint.md",
      "# Checkpoint\n\nSTATUS: BLOCKED\n",
    );
    write_fixture(
      &root,
      "missions/juno-agi-literature-2026/progress.md",
      "# Mission Progress\n\nDuplicate evidence blocks batch 03.\n",
    );
    write_fixture(
      &root,
      "state/agi-daemon.json",
      r#"{"status":"terminal_blocked","blockedReason":"duplicate evidence"}"#,
    );

    let missions = get_missions_snapshot_at(&root).expect("missions");
    assert_eq!(missions.len(), 1);
    assert_eq!(missions[0].id, "juno-agi-literature-2026");
    assert_eq!(missions[0].status, "BLOCKED");
    assert_eq!(missions[0].blocked_reason.as_deref(), Some("duplicate evidence"));
    fs::remove_dir_all(root).expect("remove fixture");
  }

  #[test]
  fn complete_without_receipt_is_never_reported_as_complete() {
    let root = temp_root("unverified-complete");
    write_fixture(
      &root,
      "missions/example/mission.yaml",
      "id: example\ntitle: Example\nstatus: COMPLETE\nprovider: openai_codex\nphases: []\n",
    );

    let missions = get_missions_snapshot_at(&root).expect("missions");
    assert_eq!(missions[0].status, "UNVERIFIED_COMPLETE");
    fs::remove_dir_all(root).expect("remove fixture");
  }

  #[test]
  fn manifestless_complete_checkpoint_is_never_reported_as_complete() {
    let root = temp_root("manifestless-unverified-complete");
    write_fixture(
      &root,
      "missions/example/checkpoint.md",
      "# Checkpoint\n\nSTATUS: COMPLETE\n",
    );

    let missions = get_missions_snapshot_at(&root).expect("missions");
    assert_eq!(missions[0].id, "example");
    assert_eq!(missions[0].status, "UNVERIFIED_COMPLETE");
    assert!(missions[0].phases.is_empty());
    fs::remove_dir_all(root).expect("remove fixture");
  }

  #[test]
  #[ignore = "requires a configured external AgentWorkbench"]
  fn configured_missions_snapshot_smoke() {
    let root = workbench_root_path();
    let missions = get_missions_snapshot_at(&root).expect("configured mission snapshot");
    assert!(!missions.is_empty(), "No missions found under {}", root.display());
  }
}
