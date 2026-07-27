use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::workbench_root_path;

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
  pub updated_at_ms: u64,
  pub current_phase_id: Option<String>,
  pub phases: Vec<MissionPhase>,
  pub progress_excerpt: Option<String>,
}

pub fn get_missions_snapshot() -> Result<Vec<MissionSummary>, String> {
  let missions_dir = workbench_root_path().join("missions");
  if !missions_dir.is_dir() {
    return Ok(vec![]);
  }
  let mut out = vec![];
  for entry in fs::read_dir(&missions_dir).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    if !entry.path().is_dir() {
      continue;
    }
    if let Some(summary) = parse_mission_dir(&entry.path()) {
      out.push(summary);
    }
  }
  out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms).then_with(|| b.id.cmp(&a.id)));
  Ok(out)
}

fn parse_mission_dir(dir: &Path) -> Option<MissionSummary> {
  let mission_yaml = dir.join("mission.yaml");
  if !mission_yaml.is_file() {
    return None;
  }
  let text = fs::read_to_string(&mission_yaml).ok()?;
  let id = yaml_field(&text, "id").unwrap_or_else(|| {
    dir.file_name()
      .and_then(|n| n.to_str())
      .unwrap_or("mission")
      .to_string()
  });
  let title = yaml_field(&text, "title").unwrap_or_else(|| id.clone());
  let status = yaml_field(&text, "status").unwrap_or_else(|| "ACTIVE".to_string());
  let provider = yaml_field(&text, "provider").unwrap_or_else(|| "cursor_composer".to_string());
  let updated_at_ms = fs::metadata(&mission_yaml)
    .and_then(|metadata| metadata.modified())
    .ok()
    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0);
  let phases = parse_phases(&text);
  let current_phase_id = phases
    .iter()
    .find(|p| p.status == "in_progress")
    .map(|p| p.id.clone())
    .or_else(|| phases.first().map(|p| p.id.clone()));

  let progress = dir.join("progress.md");
  let progress_excerpt = if progress.is_file() {
    let content = fs::read_to_string(&progress).ok()?;
    Some(content.chars().take(1200).collect())
  } else {
    None
  };

  Some(MissionSummary {
    id,
    title,
    status,
    provider,
    updated_at_ms,
    current_phase_id,
    phases,
    progress_excerpt,
  })
}

fn yaml_field(text: &str, key: &str) -> Option<String> {
  let prefix = format!("{key}:");
  for line in text.lines() {
    let trimmed = line.trim();
    if let Some(value) = trimmed.strip_prefix(&prefix) {
      return Some(
        value
          .trim()
          .trim_matches('"')
          .trim_matches('\'')
          .to_string(),
      );
    }
  }
  None
}

fn parse_phases(text: &str) -> Vec<MissionPhase> {
  let mut phases = vec![];
  let mut in_phases = false;
  let mut current: Option<MissionPhase> = None;

  let flush = |phases: &mut Vec<MissionPhase>, current: &mut Option<MissionPhase>| {
    if let Some(p) = current.take() {
      phases.push(p);
    }
  };

  for line in text.lines() {
    if line.trim() == "phases:" {
      in_phases = true;
      continue;
    }
    if !in_phases {
      continue;
    }
    if line.starts_with("  - id:") {
      flush(&mut phases, &mut current);
      current = Some(MissionPhase {
        id: line.split(':').nth(1).unwrap_or("").trim().to_string(),
        goal: String::new(),
        status: "queued".to_string(),
      });
      continue;
    }
    if let Some(ref mut p) = current {
      if let Some(value) = line.trim_start().strip_prefix("goal:") {
        p.goal = value.trim().trim_matches('"').to_string();
      }
      if let Some(value) = line.trim_start().strip_prefix("status:") {
        p.status = value.trim().trim_matches('"').to_string();
      }
    }
  }
  flush(&mut phases, &mut current);
  phases
}
