use serde::Serialize;
use std::fs;
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

fn vault_path_from_config(root: &Path) -> String {
  let cfg = root.join("config.yaml");
  if let Ok(text) = fs::read_to_string(&cfg) {
    if let Some(m) = text
      .lines()
      .find(|l| l.trim_start().starts_with("vault_path:"))
    {
      let val = m.split(':').nth(1).unwrap_or("").trim();
      return val.trim_matches('"').trim_matches('\'').to_string();
    }
  }
  "E:/Obsidian Vault".to_string()
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
  let rules = default_promote_rules();
  let rule = rules
    .iter()
    .find(|r| r.id == rule_id)
    .ok_or_else(|| format!("unknown promote rule: {rule_id}"))?;

  let workbench = workbench_root_path();
  let source = workbench.join(relative_path.replace('/', "\\"));
  if !source.is_file() {
    return Err(format!("staging file not found: {relative_path}"));
  }

  let file_name = source
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| "invalid file name".to_string())?;

  let dest_dir = PathBuf::from(rule.to_path.replace('/', "\\"));
  fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
  let dest = dest_dir.join(file_name);

  let promoted_from = relative_path.replace('\\', "/");
  let promoted_at = chrono_lite_now();
  let mut content = fs::read_to_string(&source).map_err(|e| e.to_string())?;
  if !content.starts_with("---") {
    content = format!(
      "---\npromoted_from: {promoted_from}\npromoted_at: {promoted_at}\n---\n{content}"
    );
  }

  fs::write(&dest, content).map_err(|e| e.to_string())?;

  Ok(PromoteResult {
    ok: true,
    copied_to: dest.to_string_lossy().to_string(),
    message: format!("Promoted to {}", dest.display()),
  })
}

fn chrono_lite_now() -> String {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs().to_string())
    .unwrap_or_else(|_| "0".to_string())
}

#[allow(dead_code)]
fn _vault() -> String {
  vault_path_from_config(&workbench_root_path())
}
