use serde::{Deserialize, Serialize};
use std::fs;

use crate::workbench_root_path;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEffectMetrics {
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub ticks: u64,
    #[serde(default)]
    pub cap_filled: bool,
    #[serde(default)]
    pub escalations: u64,
    #[serde(default)]
    pub strategy: String,
    #[serde(default)]
    pub top_mission: String,
    #[serde(default)]
    pub queue_head: bool,
    #[serde(default)]
    pub idle_action: String,
    #[serde(default)]
    pub mission_done: u64,
    #[serde(default)]
    pub verify_pass: u64,
    #[serde(default)]
    pub review_rework: u64,
    #[serde(default)]
    pub review_block: u64,
    #[serde(default)]
    pub verify_pass_rate: Option<f64>,
    #[serde(default)]
    pub rework_rate: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkflowEffectSnapshot {
    #[serde(default)]
    version: u8,
    #[serde(default)]
    generated_at: Option<String>,
    #[serde(default)]
    latest: Option<WorkflowEffectMetrics>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEffectSnapshot {
    pub available: bool,
    pub version: u8,
    pub generated_at: Option<String>,
    pub latest: Option<WorkflowEffectMetrics>,
}

fn parse_snapshot(text: &str) -> Result<WorkflowEffectSnapshot, String> {
    let stored: StoredWorkflowEffectSnapshot =
        serde_json::from_str(text).map_err(|error| format!("invalid KPI snapshot: {error}"))?;
    Ok(WorkflowEffectSnapshot {
        available: stored.latest.is_some(),
        version: stored.version,
        generated_at: stored.generated_at,
        latest: stored.latest,
    })
}

pub fn get_workflow_effect_snapshot() -> Result<WorkflowEffectSnapshot, String> {
    let file_path = workbench_root_path().join("state").join("kpi-latest.json");
    if !file_path.is_file() {
        return Ok(WorkflowEffectSnapshot {
            version: 1,
            ..WorkflowEffectSnapshot::default()
        });
    }
    let text = fs::read_to_string(&file_path)
        .map_err(|error| format!("failed to read {}: {error}", file_path.display()))?;
    parse_snapshot(&text)
}

#[cfg(test)]
mod tests {
    use super::parse_snapshot;

    #[test]
    fn parses_machine_readable_effect_snapshot() {
        let snapshot = parse_snapshot(
      r#"{"version":1,"generatedAt":"2026-07-27T00:00:00Z","latest":{"date":"2026-07-27","missionDone":2,"verifyPass":3,"verifyPassRate":1.0,"reworkRate":0.25}}"#,
    )
    .expect("valid snapshot");

        assert!(snapshot.available);
        assert_eq!(snapshot.latest.expect("latest metrics").mission_done, 2);
    }
}
