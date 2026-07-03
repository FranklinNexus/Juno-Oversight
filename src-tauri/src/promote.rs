use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::workbench_root_path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingEntry {
  pub relative_path: String,
  pub size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteRule {
  pub id: String,
  pub from_glob: String,
  pub to_path: String,
  pub require_confirm: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteResult {
  pub ok: bool,
  pub copied_to: String,
  pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotePreview {
  pub source_path: String,
  pub dest_path: String,
  pub action: String,
  pub source_bytes: u64,
  pub dest_bytes: Option<u64>,
  pub source_lines: u32,
  pub dest_lines: Option<u32>,
  pub lines_added: u32,
  pub lines_removed: u32,
  pub will_add_frontmatter: bool,
  pub diff_lines: Vec<String>,
  pub summary: String,
}

struct PromotePlan {
  source: PathBuf,
  dest: PathBuf,
  relative_path: String,
  outgoing: String,
  will_add_frontmatter: bool,
}

fn default_promote_rules() -> Vec<PromoteRule> {
  vec![
    PromoteRule {
      id: "jinstone-devlog".to_string(),
      from_glob: "staging/jinstone/**".to_string(),
      to_path: "E:/Obsidian Vault/20_Projects/支线_开发日志/".to_string(),
      require_confirm: false,
    },
    PromoteRule {
      id: "jinstone-research".to_string(),
      from_glob: "staging/jinstone/research/**".to_string(),
      to_path: "E:/Obsidian Vault/30_Library/Jinstone/".to_string(),
      require_confirm: false,
    },
    PromoteRule {
      id: "n1-staging".to_string(),
      from_glob: "staging/n1/**".to_string(),
      to_path: "E:/Obsidian Vault/30_Library/N1/".to_string(),
      require_confirm: true,
    },
  ]
}

fn promote_log_path() -> PathBuf {
  workbench_root_path().join("state/promote.log")
}

fn chrono_lite_now() -> String {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs().to_string())
    .unwrap_or_else(|_| "0".to_string())
}

fn resolve_rule(rule_id: &str) -> Result<PromoteRule, String> {
  default_promote_rules()
    .into_iter()
    .find(|r| r.id == rule_id)
    .ok_or_else(|| format!("unknown promote rule: {rule_id}"))
}

fn prepare_promote_plan(rule_id: &str, relative_path: &str) -> Result<PromotePlan, String> {
  let _rule = resolve_rule(rule_id)?;
  let workbench = workbench_root_path();
  let normalized = relative_path.replace('\\', "/");
  let source = workbench.join(normalized.replace('/', "\\"));
  if !source.is_file() {
    return Err(format!("staging file not found: {relative_path}"));
  }

  let file_name = source
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| "invalid file name".to_string())?;

  let dest_dir = PathBuf::from(_rule.to_path.replace('/', "\\"));
  let dest = dest_dir.join(file_name);

  let raw = fs::read_to_string(&source).map_err(|e| e.to_string())?;
  let will_add_frontmatter = !raw.starts_with("---");
  let outgoing = if will_add_frontmatter {
    format!(
      "---\npromoted_from: {normalized}\npromoted_at: {}\n---\n{raw}",
      chrono_lite_now()
    )
  } else {
    raw
  };

  Ok(PromotePlan {
    source,
    dest,
    relative_path: normalized,
    outgoing,
    will_add_frontmatter,
  })
}

fn count_lines(text: &str) -> u32 {
  if text.is_empty() {
    return 0;
  }
  text.lines().count() as u32
}

fn diff_lines(old: &str, new: &str, max_lines: usize) -> (Vec<String>, u32, u32) {
  let old_lines: Vec<&str> = old.lines().collect();
  let new_lines: Vec<&str> = new.lines().collect();
  let mut out = vec![];
  let mut added = 0u32;
  let mut removed = 0u32;
  let max = old_lines.len().max(new_lines.len());

  for i in 0..max {
    if out.len() >= max_lines {
      out.push(format!("… (+{} more)", max.saturating_sub(i)));
      break;
    }
    match (old_lines.get(i), new_lines.get(i)) {
      (Some(o), Some(n)) if o != n => {
        out.push(format!("- {o}"));
        out.push(format!("+ {n}"));
      }
      (None, Some(n)) => {
        added += 1;
        out.push(format!("+ {n}"));
      }
      (Some(o), None) => {
        removed += 1;
        out.push(format!("- {o}"));
      }
      _ => {}
    }
  }

  (out, added, removed)
}

pub fn preview_promote_to_vault(rule_id: String, relative_path: String) -> Result<PromotePreview, String> {
  let plan = prepare_promote_plan(&rule_id, &relative_path)?;
  let source_bytes = fs::metadata(&plan.source).map_err(|e| e.to_string())?.len();
  let source_lines = count_lines(&plan.outgoing);

  let dest_exists = plan.dest.is_file();
  let (existing, dest_bytes, dest_lines) = if dest_exists {
    let text = fs::read_to_string(&plan.dest).map_err(|e| e.to_string())?;
    let lines = count_lines(&text);
    let bytes = fs::metadata(&plan.dest).map_err(|e| e.to_string())?.len();
    (text, Some(bytes), Some(lines))
  } else {
    (String::new(), None, None)
  };

  let action = if !dest_exists {
    "create".to_string()
  } else if existing == plan.outgoing {
    "unchanged".to_string()
  } else {
    "update".to_string()
  };

  let (diff_lines, lines_added, lines_removed) = if action == "unchanged" {
    (vec!["(no changes)".to_string()], 0, 0)
  } else {
    diff_lines(&existing, &plan.outgoing, 80)
  };

  let summary = match action.as_str() {
    "create" => format!(
      "new file → {} ({} lines, {} bytes)",
      plan.dest.display(),
      source_lines,
      source_bytes
    ),
    "update" => format!(
      "update {} → {} (+{} −{} lines)",
      plan.relative_path,
      plan.dest.display(),
      lines_added,
      lines_removed
    ),
    _ => format!("unchanged at {}", plan.dest.display()),
  };

  append_promote_log(&format!(
    "PREVIEW rule={rule_id} src={} dest={} action={action}",
    plan.relative_path,
    plan.dest.display()
  ))?;

  Ok(PromotePreview {
    source_path: plan.source.to_string_lossy().to_string(),
    dest_path: plan.dest.to_string_lossy().to_string(),
    action,
    source_bytes,
    dest_bytes,
    source_lines,
    dest_lines,
    lines_added,
    lines_removed,
    will_add_frontmatter: plan.will_add_frontmatter,
    diff_lines,
    summary,
  })
}

pub fn append_promote_log(line: &str) -> Result<(), String> {
  let log_path = promote_log_path();
  if let Some(parent) = log_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|e| e.to_string())?;
  writeln!(file, "[{}] {line}", chrono_lite_now()).map_err(|e| e.to_string())
}

pub fn read_promote_log(max_lines: Option<u32>) -> Result<Vec<String>, String> {
  let log_path = promote_log_path();
  if !log_path.is_file() {
    return Ok(vec![]);
  }
  let content = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
  let limit = max_lines.unwrap_or(40).clamp(1, 200) as usize;
  let mut lines: Vec<&str> = content.lines().collect();
  if lines.len() > limit {
    lines = lines.split_off(lines.len() - limit);
  }
  Ok(lines.into_iter().map(str::to_string).collect())
}

pub fn list_staging_entries() -> Result<Vec<StagingEntry>, String> {
  let workbench = workbench_root_path();
  let staging = workbench.join("staging");
  if !staging.is_dir() {
    return Ok(vec![]);
  }
  let mut out = vec![];
  walk_staging(&workbench, &staging, &mut out)?;
  out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
  Ok(out)
}

fn walk_staging(workbench: &Path, dir: &Path, out: &mut Vec<StagingEntry>) -> Result<(), String> {
  for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.is_dir() {
      walk_staging(workbench, &path, out)?;
      continue;
    }
    let rel = path
      .strip_prefix(workbench)
      .map_err(|e| e.to_string())?
      .to_string_lossy()
      .replace('\\', "/");
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    out.push(StagingEntry {
      relative_path: rel,
      size_bytes: size,
    });
  }
  Ok(())
}

pub fn list_promote_rules() -> Vec<PromoteRule> {
  default_promote_rules()
}

pub fn promote_to_vault(rule_id: String, relative_path: String) -> Result<PromoteResult, String> {
  let plan = prepare_promote_plan(&rule_id, &relative_path)?;
  if let Some(parent) = plan.dest.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&plan.dest, &plan.outgoing).map_err(|e| e.to_string())?;

  let message = format!("Promoted to {}", plan.dest.display());
  append_promote_log(&format!(
    "PROMOTE rule={rule_id} src={} dest={} ok=true",
    plan.relative_path,
    plan.dest.display()
  ))?;

  Ok(PromoteResult {
    ok: true,
    copied_to: plan.dest.to_string_lossy().to_string(),
    message,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn diff_lines_counts_additions() {
    let (lines, added, removed) = diff_lines("", "a\nb\n", 10);
    assert_eq!(added, 2);
    assert_eq!(removed, 0);
    assert_eq!(lines.len(), 2);
  }

  #[test]
  fn diff_lines_detects_unchanged() {
    let (lines, added, removed) = diff_lines("same", "same", 10);
    assert_eq!(added, 0);
    assert_eq!(removed, 0);
    assert!(lines.is_empty());
  }
}
