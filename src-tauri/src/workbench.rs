use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::workbench_root_path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
  id: String,
  horizon: String,
  kind: String,
  prompt: String,
  provider: Option<String>,
  max_minutes: Option<u64>,
  mission_id: Option<String>,
  phase_id: Option<String>,
  status: Option<String>,
}

impl QueueItem {
  fn new(id: String) -> Self {
    Self {
      id,
      horizon: "day".to_string(),
      kind: "task".to_string(),
      prompt: "executor_generic".to_string(),
      provider: None,
      max_minutes: None,
      mission_id: None,
      phase_id: None,
      status: Some("queued".to_string()),
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
  root_configured: bool,
  root_path: Option<String>,
  queue: Vec<QueueItem>,
  daily_excerpt: Option<String>,
  daily_title: Option<String>,
  active_run_id: Option<String>,
  active_run_status: String,
  updated_at: String,
}

pub fn get_workbench_snapshot() -> Result<WorkbenchSnapshot, String> {
  let root = workbench_root_path();
  let root_configured = root.is_dir();
  let root_path = Some(root.to_string_lossy().to_string());

  if !root_configured {
    return Ok(WorkbenchSnapshot {
      root_configured,
      root_path,
      queue: vec![],
      daily_excerpt: None,
      daily_title: None,
      active_run_id: None,
      active_run_status: "idle".to_string(),
      updated_at: String::new(),
    });
  }

  let queue = read_queue(&root.join("queue").join("now.yaml"))?;
  let (daily_title, daily_excerpt) = read_latest_daily(&root.join("daily"));
  let (active_run_id, active_run_status, updated_at) =
    read_orchestrator_state(&root.join("state").join("orchestrator.json"));

  Ok(WorkbenchSnapshot {
    root_configured,
    root_path,
    queue,
    daily_excerpt,
    daily_title,
    active_run_id,
    active_run_status,
    updated_at,
  })
}

fn clean_yaml_value(value: &str) -> String {
  value
    .trim()
    .trim_matches('"')
    .trim_matches('\'')
    .to_string()
}

fn read_queue(path: &Path) -> Result<Vec<QueueItem>, String> {
  if !path.is_file() {
    return Ok(vec![]);
  }
  let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
  Ok(parse_now_queue(&text))
}

fn parse_now_queue(text: &str) -> Vec<QueueItem> {
  let mut items = Vec::new();
  let mut current: Option<QueueItem> = None;
  let mut in_now = false;

  let flush = |items: &mut Vec<QueueItem>, current: &mut Option<QueueItem>| {
    if let Some(item) = current.take() {
      items.push(item);
    }
  };

  for line in text.lines() {
    if line.trim() == "now:" {
      in_now = true;
      continue;
    }
    if line.trim() == "backlog:" {
      flush(&mut items, &mut current);
      break;
    }
    if !in_now {
      continue;
    }
    if let Some(value) = line.trim_start().strip_prefix("- id:") {
      flush(&mut items, &mut current);
      current = Some(QueueItem::new(clean_yaml_value(value)));
      continue;
    }
    let Some(item) = current.as_mut() else {
      continue;
    };
    let trimmed = line.trim();
    let Some((key, value)) = trimmed.split_once(':') else {
      continue;
    };
    let value = clean_yaml_value(value);
    match key {
      "horizon" => item.horizon = value,
      "kind" => item.kind = value,
      "prompt" => item.prompt = value,
      "provider" => item.provider = Some(value),
      "max_minutes" => item.max_minutes = value.parse::<u64>().ok(),
      "mission_id" => item.mission_id = Some(value),
      "phase_id" => item.phase_id = Some(value),
      "status" => item.status = Some(value),
      _ => {}
    }
  }
  flush(&mut items, &mut current);
  items
}

fn read_latest_daily(dir: &Path) -> (Option<String>, Option<String>) {
  let Ok(entries) = fs::read_dir(dir) else {
    return (None, None);
  };
  let latest = entries
    .filter_map(Result::ok)
    .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("md"))
    .max_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
  let Some(entry) = latest else {
    return (None, None);
  };
  let path = entry.path();
  let title = path
    .file_stem()
    .and_then(|name| name.to_str())
    .map(|name| format!("工作摘要 · {name}"));
  let excerpt = fs::read_to_string(path)
    .ok()
    .map(|text| text.chars().take(4000).collect::<String>());
  (title, excerpt)
}

fn read_orchestrator_state(path: &Path) -> (Option<String>, String, String) {
  let Ok(text) = fs::read_to_string(path) else {
    return (None, "idle".to_string(), String::new());
  };
  let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
    return (None, "idle".to_string(), String::new());
  };
  let active_run_id = value
    .get("activeRunId")
    .and_then(|value| value.as_str())
    .filter(|value| !value.is_empty())
    .map(str::to_string);
  let status = value
    .get("activeRunStatus")
    .and_then(|value| value.as_str())
    .unwrap_or("idle")
    .to_string();
  let updated_at = value
    .get("updatedAt")
    .and_then(|value| value.as_str())
    .unwrap_or("")
    .to_string();
  (active_run_id, status, updated_at)
}

#[cfg(test)]
mod tests {
  use super::parse_now_queue;

  #[test]
  fn reads_only_the_active_queue() {
    let queue = parse_now_queue(
      "updated: now\nnow:\n  - id: task-1\n    horizon: mission\n    kind: implement\n    mission_id: mission-1\n    phase_id: p01\n    prompt: executor_implement\n    max_minutes: 40\nbacklog:\n  - id: later\n",
    );
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, "task-1");
    assert_eq!(queue[0].mission_id.as_deref(), Some("mission-1"));
    assert_eq!(queue[0].max_minutes, Some(40));
  }
}
