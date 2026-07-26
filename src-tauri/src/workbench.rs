use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::workbench_root_path;

const DAILY_EXCERPT_CHARS: usize = 4_000;
const MAX_QUEUE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STATE_BYTES: usize = 256 * 1024;
const MAX_DAILY_BYTES: usize = 256 * 1024;
const MAX_RUN_MINUTES: u64 = 240;
const MAX_REVISION_ATTEMPTS: u64 = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ControlFileIdentity {
    volume: u64,
    file_index: u64,
    links: u64,
    size: u64,
    modified: u128,
    changed: u128,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct WindowsFileTime {
    low: u32,
    high: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct WindowsFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsFileInformation,
    ) -> i32;
}

#[derive(Clone, Debug, Serialize)]
pub struct QueueItemSnapshot {
    id: String,
    horizon: String,
    kind: String,
    prompt: String,
    provider: Option<String>,
    max_minutes: Option<u64>,
    mission_id: Option<String>,
    phase_id: Option<String>,
    workflow_id: Option<String>,
    experiment_id: Option<String>,
    experiment_arm: Option<String>,
    experiment_episode: Option<u64>,
    source_phase_id: Option<String>,
    experiment_fixture_sha256: Option<String>,
    experiment_prompt_sha256: Option<String>,
    revision_of: Option<String>,
    revision_attempt: Option<u64>,
    status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSnapshot {
    status: String,
    blocked_reason: Option<String>,
    evidence_reason: Option<String>,
    updated_at: Option<String>,
    pid: Option<u32>,
    last_exit: Option<i64>,
    last_detail: Option<String>,
    receipt_state: Option<String>,
    artifacts_ready: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkbenchDaemonsSnapshot {
    juno: DaemonSnapshot,
    agi: DaemonSnapshot,
    book: DaemonSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
    source: &'static str,
    error: Option<String>,
    root_configured: bool,
    root_path: Option<String>,
    queue: Vec<QueueItemSnapshot>,
    daily_excerpt: Option<String>,
    daily_title: Option<String>,
    active_run_id: Option<String>,
    active_run_status: String,
    daemons: WorkbenchDaemonsSnapshot,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueDocument {
    updated: Option<String>,
    now: QueueSection,
    backlog: QueueSection,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum QueueSection {
    Items(Vec<QueueFileItem>),
    Empty(()),
}

impl QueueSection {
    fn into_items(self) -> Vec<QueueFileItem> {
        match self {
            Self::Items(items) => items,
            Self::Empty(()) => vec![],
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueFileItem {
    id: String,
    horizon: Option<String>,
    kind: Option<String>,
    run_kind: Option<String>,
    repo_target: Option<String>,
    mission_id: Option<String>,
    phase_id: Option<String>,
    prompt: Option<String>,
    provider: Option<String>,
    max_minutes: Option<u64>,
    success_criteria: Option<String>,
    workflow_id: Option<String>,
    eval_profile: Option<String>,
    depends_on: Option<String>,
    model: Option<String>,
    allowed_tools: Option<Vec<String>>,
    experiment_id: Option<String>,
    experiment_arm: Option<String>,
    experiment_episode: Option<u64>,
    source_phase_id: Option<String>,
    experiment_fixture_sha256: Option<String>,
    experiment_prompt_sha256: Option<String>,
    revision_of: Option<String>,
    revision_attempt: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestratorFile {
    active_run_id: Option<String>,
    #[serde(default = "idle_status")]
    active_run_status: String,
    last_run_id: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonFile {
    status: Option<String>,
    blocked_reason: Option<String>,
    evidence_reason: Option<String>,
    updated_at: Option<String>,
    pid: Option<u32>,
    #[serde(alias = "lastExitCode")]
    last_exit: Option<i64>,
    last_cap_detail: Option<String>,
    receipt_state: Option<String>,
    artifacts_ready: Option<bool>,
}

struct ParsedQueue {
    now: Vec<QueueItemSnapshot>,
    updated_at: Option<String>,
}

fn idle_status() -> String {
    "idle".to_string()
}

fn unavailable_daemon() -> DaemonSnapshot {
    DaemonSnapshot {
        status: "unavailable".to_string(),
        blocked_reason: None,
        evidence_reason: None,
        updated_at: None,
        pid: None,
        last_exit: None,
        last_detail: None,
        receipt_state: None,
        artifacts_ready: None,
    }
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn validate_direct_child_directory(
    canonical_root: &Path,
    name: &str,
    label: &str,
) -> Result<Option<PathBuf>, String> {
    let lexical = canonical_root.join(name);
    let metadata = match fs::symlink_metadata(&lexical) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "{label} is unavailable ({}): {error}",
                lexical.display()
            ))
        }
    };
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "{label} must be a direct non-link directory: {}",
            lexical.display()
        ));
    }
    let canonical = fs::canonicalize(&lexical).map_err(|error| {
        format!(
            "{label} cannot be canonicalized ({}): {error}",
            lexical.display()
        )
    })?;
    if !same_path(&canonical, &lexical)
        || canonical
            .parent()
            .map(|parent| same_path(parent, canonical_root))
            != Some(true)
    {
        return Err(format!(
            "{label} escapes the canonical Workbench: {}",
            lexical.display()
        ));
    }
    Ok(Some(canonical))
}

fn assert_direct_child_unchanged(
    canonical_root: &Path,
    name: &str,
    label: &str,
    expected: &Option<PathBuf>,
) -> Result<(), String> {
    let observed = validate_direct_child_directory(canonical_root, name, label)?;
    let unchanged = match (expected.as_deref(), observed.as_deref()) {
        (None, None) => true,
        (Some(expected), Some(observed)) => same_path(expected, observed),
        _ => false,
    };
    if !unchanged {
        return Err(format!(
            "{label} changed while taking the Workbench snapshot"
        ));
    }
    Ok(())
}

fn assert_stable_parent(path: &Path, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory: {}", path.display()))?;
    let canonical = fs::canonicalize(parent).map_err(|error| {
        format!(
            "{label} parent is unavailable ({}): {error}",
            parent.display()
        )
    })?;
    if !same_path(&canonical, parent) {
        return Err(format!(
            "{label} parent changed containment: {}",
            parent.display()
        ));
    }
    Ok(())
}

fn path_entry_exists(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "{label} availability cannot be determined ({}): {error}",
            path.display()
        )),
    }
}

#[cfg(unix)]
fn control_file_identity(file: &fs::File) -> io::Result<ControlFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(ControlFileIdentity {
        volume: metadata.dev(),
        file_index: metadata.ino(),
        links: metadata.nlink(),
        size: metadata.size(),
        modified: ((metadata.mtime() as i128 as u128) << 32) | metadata.mtime_nsec() as u128,
        changed: ((metadata.ctime() as i128 as u128) << 32) | metadata.ctime_nsec() as u128,
    })
}

#[cfg(target_os = "windows")]
fn control_file_identity(file: &fs::File) -> io::Result<ControlFileIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    let mut information = MaybeUninit::<WindowsFileInformation>::uninit();
    let result = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let combine = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    Ok(ControlFileIdentity {
        volume: u64::from(information.volume_serial_number),
        file_index: combine(information.file_index_high, information.file_index_low),
        links: u64::from(information.number_of_links),
        size: combine(information.file_size_high, information.file_size_low),
        modified: u128::from(combine(
            information.last_write_time.high,
            information.last_write_time.low,
        )),
        changed: u128::from(combine(
            information.creation_time.high,
            information.creation_time.low,
        )),
    })
}

fn read_regular_utf8_with_hook<F>(
    path: &Path,
    label: &str,
    max_bytes: usize,
    after_open: F,
) -> Result<String, String>
where
    F: FnOnce(),
{
    let before = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} is unavailable ({}): {error}", path.display()))?;
    if !before.file_type().is_file() || before.file_type().is_symlink() {
        return Err(format!(
            "{label} must be a regular file: {}",
            path.display()
        ));
    }
    if before.len() > max_bytes as u64 {
        return Err(format!(
            "{label} exceeds the {max_bytes}-byte limit: {}",
            path.display()
        ));
    }
    assert_stable_parent(path, label)?;

    let mut file = fs::File::open(path)
        .map_err(|error| format!("{label} is unavailable ({}): {error}", path.display()))?;
    let opened = control_file_identity(&file).map_err(|error| {
        format!(
            "{label} identity is unavailable ({}): {error}",
            path.display()
        )
    })?;
    if opened.links != 1 {
        return Err(format!(
            "{label} must be an exclusive regular file: {}",
            path.display()
        ));
    }
    if opened.size > max_bytes as u64 {
        return Err(format!(
            "{label} exceeds the {max_bytes}-byte limit: {}",
            path.display()
        ));
    }

    after_open();
    let mut bytes = Vec::with_capacity(opened.size.min(max_bytes as u64) as usize);
    file.by_ref()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{label} cannot be read ({}): {error}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "{label} exceeds the {max_bytes}-byte limit: {}",
            path.display()
        ));
    }

    let after_handle = control_file_identity(&file).map_err(|error| {
        format!(
            "{label} identity is unavailable ({}): {error}",
            path.display()
        )
    })?;
    let after_path = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "{label} changed while reading ({}): {error}",
            path.display()
        )
    })?;
    if !after_path.file_type().is_file() || after_path.file_type().is_symlink() {
        return Err(format!("{label} changed while reading: {}", path.display()));
    }
    assert_stable_parent(path, label)?;
    let verifier = fs::File::open(path).map_err(|error| {
        format!(
            "{label} changed while reading ({}): {error}",
            path.display()
        )
    })?;
    let after_name = control_file_identity(&verifier).map_err(|error| {
        format!(
            "{label} identity is unavailable ({}): {error}",
            path.display()
        )
    })?;
    let final_path = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "{label} changed while reading ({}): {error}",
            path.display()
        )
    })?;
    if !final_path.file_type().is_file() || final_path.file_type().is_symlink() {
        return Err(format!("{label} changed while reading: {}", path.display()));
    }
    assert_stable_parent(path, label)?;
    if opened != after_handle
        || after_handle != after_name
        || after_handle.links != 1
        || after_handle.size != bytes.len() as u64
        || after_path.len() != bytes.len() as u64
        || final_path.len() != bytes.len() as u64
    {
        return Err(format!("{label} changed while reading: {}", path.display()));
    }

    String::from_utf8(bytes).map_err(|error| {
        format!(
            "{label} is not readable UTF-8 ({}): {error}",
            path.display()
        )
    })
}

fn read_regular_utf8(path: &Path, label: &str, max_bytes: usize) -> Result<String, String> {
    read_regular_utf8_with_hook(path, label, max_bytes, || {})
}

fn non_empty(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} must be a non-empty string"));
    }
    Ok(())
}

fn optional_non_empty(value: &Option<String>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        non_empty(value, label)?;
    }
    Ok(())
}

fn safe_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn require_allowed(value: &str, allowed: &[&str], label: &str) -> Result<(), String> {
    if !allowed.contains(&value) {
        return Err(format!("{label} must be one of: {}", allowed.join(", ")));
    }
    Ok(())
}

fn revision_fix_run_id(parent_run_id: &str, attempt: u64) -> String {
    let digest = Sha256::digest(parent_run_id.as_bytes());
    let parent_hash = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("revision-{parent_hash}-{attempt}")
}

fn validate_queue_item(item: &QueueFileItem, label: &str) -> Result<(), String> {
    if !safe_run_id(&item.id) {
        return Err(format!("{label}.id is not a safe run id: {}", item.id));
    }
    if let Some(value) = item.horizon.as_deref() {
        require_allowed(value, &["day", "mission"], &format!("{label}.horizon"))?;
    }
    if let Some(value) = item.run_kind.as_deref() {
        require_allowed(
            value,
            &["implement", "review", "verify", "debate", "vote"],
            &format!("{label}.run_kind"),
        )?;
    }
    if let Some(value) = item.repo_target.as_deref() {
        require_allowed(
            value,
            &["workbench", "juno-overseer"],
            &format!("{label}.repo_target"),
        )?;
    }
    if let Some(value) = item.provider.as_deref() {
        require_allowed(
            value,
            &["api_token", "cursor_composer", "openai_codex"],
            &format!("{label}.provider"),
        )?;
    }
    if let Some(value) = item.eval_profile.as_deref() {
        require_allowed(
            value,
            &["code", "ui", "literature", "orchestrator"],
            &format!("{label}.eval_profile"),
        )?;
    }
    if let Some(value) = item.max_minutes {
        if value == 0 || value > MAX_RUN_MINUTES {
            return Err(format!(
                "{label}.max_minutes must be an integer between 1 and {MAX_RUN_MINUTES}"
            ));
        }
    }
    optional_non_empty(&item.kind, &format!("{label}.kind"))?;
    optional_non_empty(&item.mission_id, &format!("{label}.mission_id"))?;
    optional_non_empty(&item.phase_id, &format!("{label}.phase_id"))?;
    optional_non_empty(&item.prompt, &format!("{label}.prompt"))?;
    optional_non_empty(&item.success_criteria, &format!("{label}.success_criteria"))?;
    optional_non_empty(&item.workflow_id, &format!("{label}.workflow_id"))?;
    optional_non_empty(&item.depends_on, &format!("{label}.depends_on"))?;
    optional_non_empty(&item.model, &format!("{label}.model"))?;
    optional_non_empty(&item.experiment_id, &format!("{label}.experiment_id"))?;
    optional_non_empty(&item.source_phase_id, &format!("{label}.source_phase_id"))?;
    optional_non_empty(
        &item.experiment_fixture_sha256,
        &format!("{label}.experiment_fixture_sha256"),
    )?;
    if let Some(digest) = item.experiment_fixture_sha256.as_deref() {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!(
                "{label}.experiment_fixture_sha256 must be lowercase SHA-256"
            ));
        }
    }
    optional_non_empty(
        &item.experiment_prompt_sha256,
        &format!("{label}.experiment_prompt_sha256"),
    )?;
    if let Some(digest) = item.experiment_prompt_sha256.as_deref() {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!(
                "{label}.experiment_prompt_sha256 must be lowercase SHA-256"
            ));
        }
    }
    optional_non_empty(&item.revision_of, &format!("{label}.revision_of"))?;
    if let Some(parent) = item.revision_of.as_deref() {
        if !safe_run_id(parent) {
            return Err(format!("{label}.revision_of must be a safe run id"));
        }
    }
    if let Some(attempt) = item.revision_attempt {
        if attempt == 0 || attempt > MAX_REVISION_ATTEMPTS {
            return Err(format!(
                "{label}.revision_attempt must be between 1 and {MAX_REVISION_ATTEMPTS}"
            ));
        }
    }
    if item.revision_of.is_some() != item.revision_attempt.is_some() {
        return Err(format!(
            "{label}.revision_of and revision_attempt must be provided together"
        ));
    }
    if let (Some(parent), Some(attempt)) = (item.revision_of.as_deref(), item.revision_attempt) {
        if item.run_kind.as_deref() != Some("implement") {
            return Err(format!(
                "{label} revision lineage requires run_kind=implement"
            ));
        }
        if item.id != revision_fix_run_id(parent, attempt) {
            return Err(format!("{label}.id does not match its revision lineage"));
        }
    }
    if let Some(value) = item.experiment_arm.as_deref() {
        require_allowed(
            value,
            &["baseline", "candidate"],
            &format!("{label}.experiment_arm"),
        )?;
    }
    if let Some(value) = item.experiment_episode {
        if value == 0 || value > 99 {
            return Err(format!(
                "{label}.experiment_episode must be an integer between 1 and 99"
            ));
        }
    }
    let experiment_field_count = [
        item.experiment_id.is_some(),
        item.experiment_arm.is_some(),
        item.experiment_episode.is_some(),
        item.source_phase_id.is_some(),
        item.experiment_fixture_sha256.is_some(),
        item.experiment_prompt_sha256.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    if experiment_field_count > 0
        && (experiment_field_count != 6
            || item.workflow_id.is_none()
            || item.mission_id.is_none()
            || item.phase_id.is_none()
            || item.run_kind.is_none()
            || item.eval_profile.is_none()
            || item.repo_target.as_deref() != Some("workbench")
            || item.provider.as_deref() != Some("openai_codex"))
    {
        return Err(format!(
      "{label} experiment metadata requires complete bindings, explicit run_kind/eval_profile, repo_target=workbench, and provider=openai_codex"
    ));
    }
    if let Some(tools) = &item.allowed_tools {
        let mut seen = HashSet::new();
        for tool in tools {
            non_empty(tool, &format!("{label}.allowed_tools[]"))?;
            if !seen.insert(tool) {
                return Err(format!("{label}.allowed_tools contains duplicates"));
            }
        }
    }
    Ok(())
}

fn queue_status(item_id: &str, orchestrator: &OrchestratorFile) -> String {
    if orchestrator.active_run_id.as_deref() != Some(item_id) {
        return "queued".to_string();
    }
    match orchestrator.active_run_status.as_str() {
        "running" => "running",
        "done" => "done",
        "blocked" => "blocked",
        "stall" | "failed" => "failed",
        _ => "queued",
    }
    .to_string()
}

fn normalize_queue_item(
    item: QueueFileItem,
    label: &str,
    orchestrator: &OrchestratorFile,
) -> Result<QueueItemSnapshot, String> {
    validate_queue_item(&item, label)?;
    Ok(QueueItemSnapshot {
        status: queue_status(&item.id, orchestrator),
        id: item.id,
        horizon: item.horizon.unwrap_or_else(|| "day".to_string()),
        kind: item.kind.unwrap_or_else(|| "task".to_string()),
        prompt: item
            .prompt
            .unwrap_or_else(|| "executor_generic".to_string()),
        provider: item.provider,
        max_minutes: item.max_minutes,
        mission_id: item.mission_id,
        phase_id: item.phase_id,
        workflow_id: item.workflow_id,
        experiment_id: item.experiment_id,
        experiment_arm: item.experiment_arm,
        experiment_episode: item.experiment_episode,
        source_phase_id: item.source_phase_id,
        experiment_fixture_sha256: item.experiment_fixture_sha256,
        experiment_prompt_sha256: item.experiment_prompt_sha256,
        revision_of: item.revision_of,
        revision_attempt: item.revision_attempt,
    })
}

fn read_queue(
    queue_root: Option<&Path>,
    orchestrator: &OrchestratorFile,
) -> Result<ParsedQueue, String> {
    let Some(queue_root) = queue_root else {
        return Ok(ParsedQueue {
            now: vec![],
            updated_at: None,
        });
    };
    let path = queue_root.join("now.yaml");
    if !path_entry_exists(&path, "Workbench queue")? {
        return Ok(ParsedQueue {
            now: vec![],
            updated_at: None,
        });
    }
    let text = read_regular_utf8(&path, "Workbench queue", MAX_QUEUE_BYTES)?;
    let document: QueueDocument = serde_yaml::from_str(&text)
        .map_err(|error| format!("Workbench queue is invalid ({}): {error}", path.display()))?;
    let mut ids = HashSet::new();
    let mut now = vec![];
    for (index, item) in document.now.into_items().into_iter().enumerate() {
        let normalized = normalize_queue_item(item, &format!("now[{index}]"), orchestrator)?;
        if !ids.insert(normalized.id.clone()) {
            return Err(format!(
                "Workbench queue contains duplicate id: {}",
                normalized.id
            ));
        }
        now.push(normalized);
    }
    for (index, item) in document.backlog.into_items().into_iter().enumerate() {
        let normalized = normalize_queue_item(item, &format!("backlog[{index}]"), orchestrator)?;
        if !ids.insert(normalized.id.clone()) {
            return Err(format!(
                "Workbench queue contains duplicate id: {}",
                normalized.id
            ));
        }
    }
    Ok(ParsedQueue {
        now,
        updated_at: document.updated,
    })
}

fn read_orchestrator(state_root: Option<&Path>) -> Result<OrchestratorFile, String> {
    let Some(state_root) = state_root else {
        return Ok(OrchestratorFile::default());
    };
    let path = state_root.join("orchestrator.json");
    if !path_entry_exists(&path, "Orchestrator state")? {
        return Ok(OrchestratorFile::default());
    }
    let text = read_regular_utf8(&path, "Orchestrator state", MAX_STATE_BYTES)?;
    let state: OrchestratorFile = serde_json::from_str(&text).map_err(|error| {
        format!(
            "Orchestrator state is invalid ({}): {error}",
            path.display()
        )
    })?;
    require_allowed(
        &state.active_run_status,
        &["idle", "running", "stall", "done", "failed", "blocked"],
        "activeRunStatus",
    )?;
    if let Some(run_id) = state.active_run_id.as_deref() {
        if !safe_run_id(run_id) {
            return Err(format!("activeRunId is not a safe run id: {run_id}"));
        }
    }
    if let Some(run_id) = state.last_run_id.as_deref() {
        if !safe_run_id(run_id) {
            return Err(format!("lastRunId is not a safe run id: {run_id}"));
        }
    }
    Ok(state)
}

fn read_daemon(
    state_root: Option<&Path>,
    file_name: &str,
    label: &str,
) -> Result<DaemonSnapshot, String> {
    let Some(state_root) = state_root else {
        return Ok(unavailable_daemon());
    };
    let path = state_root.join(file_name);
    if !path_entry_exists(&path, label)? {
        return Ok(unavailable_daemon());
    }
    let text = read_regular_utf8(&path, label, MAX_STATE_BYTES)?;
    let state: DaemonFile = serde_json::from_str(&text)
        .map_err(|error| format!("{label} is invalid ({}): {error}", path.display()))?;
    let status = state.status.unwrap_or_else(|| "unknown".to_string());
    non_empty(&status, &format!("{label}.status"))?;
    optional_non_empty(&state.blocked_reason, &format!("{label}.blockedReason"))?;
    optional_non_empty(&state.evidence_reason, &format!("{label}.evidenceReason"))?;
    Ok(DaemonSnapshot {
        status,
        blocked_reason: state.blocked_reason,
        evidence_reason: state.evidence_reason,
        updated_at: state.updated_at,
        pid: state.pid,
        last_exit: state.last_exit,
        last_detail: state.last_cap_detail,
        receipt_state: state.receipt_state,
        artifacts_ready: state.artifacts_ready,
    })
}

fn daily_file_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let bytes = name.as_bytes();
    bytes.len() == 13
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && &bytes[10..] == b".md"
        && bytes[..10]
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn read_latest_daily(daily_dir: Option<&Path>) -> Result<(Option<String>, Option<String>), String> {
    let Some(daily_dir) = daily_dir else {
        return Ok((None, None));
    };
    let mut candidates: Vec<PathBuf> = fs::read_dir(&daily_dir)
        .map_err(|error| {
            format!(
                "Daily directory is unavailable ({}): {error}",
                daily_dir.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| daily_file_name(path))
        .collect();
    candidates.sort();
    let Some(path) = candidates.pop() else {
        return Ok((None, None));
    };
    let text = read_regular_utf8(&path, "Latest daily digest", MAX_DAILY_BYTES)?;
    let title = text
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let excerpt: String = text.chars().take(DAILY_EXCERPT_CHARS).collect();
    Ok((Some(excerpt), title))
}

fn get_workbench_snapshot_at(root: &Path) -> Result<WorkbenchSnapshot, String> {
    if !root.is_dir() {
        return Ok(WorkbenchSnapshot {
            source: "tauri",
            error: None,
            root_configured: false,
            root_path: Some(root.to_string_lossy().to_string()),
            queue: vec![],
            daily_excerpt: None,
            daily_title: None,
            active_run_id: None,
            active_run_status: "idle".to_string(),
            daemons: WorkbenchDaemonsSnapshot {
                juno: unavailable_daemon(),
                agi: unavailable_daemon(),
                book: unavailable_daemon(),
            },
            updated_at: unix_timestamp(),
        });
    }

    let canonical_root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Workbench root cannot be canonicalized ({}): {error}",
            root.display()
        )
    })?;
    let queue_root =
        validate_direct_child_directory(&canonical_root, "queue", "Workbench queue root")?;
    let state_root =
        validate_direct_child_directory(&canonical_root, "state", "Workbench state root")?;
    let daily_root =
        validate_direct_child_directory(&canonical_root, "daily", "Workbench daily root")?;

    let orchestrator = read_orchestrator(state_root.as_deref())?;
    let queue = read_queue(queue_root.as_deref(), &orchestrator)?;
    let (daily_excerpt, daily_title) = read_latest_daily(daily_root.as_deref())?;
    let daemons = WorkbenchDaemonsSnapshot {
        juno: read_daemon(
            state_root.as_deref(),
            "juno-daemon.json",
            "Juno daemon state",
        )?,
        agi: read_daemon(state_root.as_deref(), "agi-daemon.json", "AGI daemon state")?,
        book: read_daemon(
            state_root.as_deref(),
            "book-daemon.json",
            "Book daemon state",
        )?,
    };
    assert_direct_child_unchanged(
        &canonical_root,
        "queue",
        "Workbench queue root",
        &queue_root,
    )?;
    assert_direct_child_unchanged(
        &canonical_root,
        "state",
        "Workbench state root",
        &state_root,
    )?;
    assert_direct_child_unchanged(
        &canonical_root,
        "daily",
        "Workbench daily root",
        &daily_root,
    )?;
    let updated_at = orchestrator
        .updated_at
        .clone()
        .or(queue.updated_at)
        .unwrap_or_else(unix_timestamp);

    Ok(WorkbenchSnapshot {
        source: "tauri",
        error: None,
        root_configured: true,
        root_path: Some(root.to_string_lossy().to_string()),
        queue: queue.now,
        daily_excerpt,
        daily_title,
        active_run_id: orchestrator.active_run_id,
        active_run_status: orchestrator.active_run_status,
        daemons,
        updated_at,
    })
}

pub fn get_workbench_snapshot() -> Result<WorkbenchSnapshot, String> {
    get_workbench_snapshot_at(&workbench_root_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "juno-workbench-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_fixture(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
        fs::write(path, text).expect("write fixture");
    }

    fn write_fixture_bytes(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
        fs::write(path, bytes).expect("write fixture bytes");
    }

    #[cfg(target_os = "windows")]
    fn link_directory(source: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(target)
            .arg(source)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("launch junction helper");
        assert!(status.success(), "create directory junction");
    }

    #[cfg(unix)]
    fn link_directory(source: &Path, target: &Path) {
        std::os::unix::fs::symlink(source, target).expect("create directory link");
    }

    #[cfg(target_os = "windows")]
    fn remove_directory_link(target: &Path) {
        fs::remove_dir(target).expect("remove directory link");
    }

    #[cfg(unix)]
    fn remove_directory_link(target: &Path) {
        fs::remove_file(target).expect("remove directory link");
    }

    #[test]
    fn snapshot_reads_authoritative_queue_daily_and_blocked_daemons() {
        let root = temp_root("truth");
        write_fixture(
      &root,
      "queue/now.yaml",
      "updated: 2026-07-12T00:00:00Z\nnow:\n  - id: run-1\n    horizon: mission\n    kind: verify\n    prompt: executor_generic\n    provider: openai_codex\n    mission_id: mission-1\n    phase_id: verify\n    max_minutes: 25\nbacklog: []\n",
    );
        write_fixture(
            &root,
            "state/orchestrator.json",
            r#"{"activeRunId":"run-1","activeRunStatus":"blocked","lastRunId":"run-1","updatedAt":"2026-07-12T00:01:00Z"}"#,
        );
        write_fixture(
            &root,
            "state/juno-daemon.json",
            r#"{"status":"stopped","updatedAt":"2026-07-12T00:00:00Z","lastExit":4,"lastCapDetail":"daily cap"}"#,
        );
        write_fixture(
            &root,
            "state/agi-daemon.json",
            r#"{"status":"terminal_blocked","blockedReason":"duplicate evidence","evidenceReason":"batch-03","lastExitCode":7,"receiptState":"missing","artifactsReady":false}"#,
        );
        write_fixture(
            &root,
            "state/book-daemon.json",
            r#"{"status":"terminal_blocked","blockedReason":"chapter mismatch"}"#,
        );
        write_fixture(&root, "daily/2026-07-12.md", "# Daily Truth\n\n- blocked\n");

        let snapshot = get_workbench_snapshot_at(&root).expect("snapshot");
        assert!(snapshot.root_configured);
        assert_eq!(snapshot.queue.len(), 1);
        assert_eq!(snapshot.queue[0].status, "blocked");
        assert_eq!(snapshot.daily_title.as_deref(), Some("Daily Truth"));
        assert_eq!(snapshot.daemons.agi.status, "terminal_blocked");
        assert_eq!(
            snapshot.daemons.agi.blocked_reason.as_deref(),
            Some("duplicate evidence")
        );
        assert_eq!(
            snapshot.daemons.agi.receipt_state.as_deref(),
            Some("missing")
        );
        assert_eq!(snapshot.daemons.agi.last_exit, Some(7));
        assert_eq!(snapshot.active_run_status, "blocked");
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn malformed_existing_queue_fails_closed() {
        let root = temp_root("bad-queue");
        write_fixture(
            &root,
            "queue/now.yaml",
            "now:\n  - id: run-1\n    unknown: value\nbacklog: []\n",
        );
        let error = get_workbench_snapshot_at(&root).expect_err("invalid queue must fail");
        assert!(error.contains("Workbench queue is invalid"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn bounded_control_reader_rejects_oversized_invalid_and_hardlinked_queue_files() {
        let oversized_root = temp_root("oversized-queue");
        write_fixture_bytes(
            &oversized_root,
            "queue/now.yaml",
            &vec![b'x'; MAX_QUEUE_BYTES + 1],
        );
        let error =
            get_workbench_snapshot_at(&oversized_root).expect_err("oversized queue must fail");
        assert!(error.contains("2097152-byte limit"));
        fs::remove_dir_all(oversized_root).expect("remove oversized fixture");

        let invalid_root = temp_root("invalid-utf8-queue");
        write_fixture_bytes(
            &invalid_root,
            "queue/now.yaml",
            &[b'n', b'o', b'w', b':', b' ', 0xff],
        );
        let error = get_workbench_snapshot_at(&invalid_root).expect_err("invalid UTF-8 must fail");
        assert!(error.contains("not readable UTF-8"));
        fs::remove_dir_all(invalid_root).expect("remove invalid UTF-8 fixture");

        let hardlink_root = temp_root("hardlink-queue");
        let source = hardlink_root.join("queue-source.yaml");
        fs::create_dir_all(hardlink_root.join("queue")).expect("create queue root");
        fs::write(&source, "now: []\nbacklog: []\n").expect("write hardlink source");
        fs::hard_link(&source, hardlink_root.join("queue/now.yaml"))
            .expect("create queue hardlink");
        let error =
            get_workbench_snapshot_at(&hardlink_root).expect_err("hardlinked queue must fail");
        assert!(error.contains("exclusive regular file"));
        assert_eq!(
            fs::read_to_string(&source).expect("source remains readable"),
            "now: []\nbacklog: []\n"
        );
        fs::remove_dir_all(hardlink_root).expect("remove hardlink fixture");
    }

    #[test]
    fn bounded_control_reader_rejects_mutation_after_open() {
        let root = temp_root("read-drift");
        write_fixture(
            &root,
            "state/orchestrator.json",
            r#"{"activeRunStatus":"idle"}"#,
        );
        let path = fs::canonicalize(&root)
            .expect("canonical fixture root")
            .join("state/orchestrator.json");
        let result = read_regular_utf8_with_hook(
            &path,
            "Drifting orchestrator state",
            MAX_STATE_BYTES,
            || {
                fs::write(
                    &path,
                    r#"{"activeRunStatus":"running","activeRunId":"changed"}"#,
                )
                .expect("mutate opened control file");
            },
        );
        let error = result.expect_err("read drift must fail");
        assert!(
            error.contains("changed while reading"),
            "unexpected error: {error}"
        );
        fs::remove_dir_all(root).expect("remove drift fixture");
    }

    #[test]
    fn control_roots_must_be_direct_non_link_workbench_children() {
        for root_name in ["queue", "state", "daily"] {
            let root = temp_root(&format!("linked-{root_name}"));
            let outside = temp_root(&format!("outside-{root_name}"));
            fs::create_dir_all(&root).expect("create Workbench root");
            fs::create_dir_all(&outside).expect("create outside root");
            let link = root.join(root_name);
            link_directory(&outside, &link);

            let error =
                get_workbench_snapshot_at(&root).expect_err("linked control root must fail");
            assert!(error.contains("direct non-link directory"));

            remove_directory_link(&link);
            fs::remove_dir_all(root).expect("remove linked Workbench fixture");
            fs::remove_dir_all(outside).expect("remove outside fixture");
        }
    }

    #[test]
    fn complete_experiment_metadata_is_preserved_in_snapshot() {
        let root = temp_root("experiment");
        write_fixture(
      &root,
      "queue/now.yaml",
      "now:\n  - id: canary-candidate-01\n    horizon: mission\n    kind: verify\n    run_kind: verify\n    repo_target: workbench\n    prompt: executor_generic\n    provider: openai_codex\n    eval_profile: literature\n    mission_id: mission-1\n    phase_id: canary-candidate-01\n    workflow_id: workflow-candidate\n    experiment_id: experiment-1\n    experiment_arm: candidate\n    experiment_episode: 1\n    source_phase_id: verify-source\n    experiment_fixture_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    experiment_prompt_sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbacklog: []\n",
    );

        let snapshot = get_workbench_snapshot_at(&root).expect("experiment queue");
        let item = &snapshot.queue[0];
        assert_eq!(item.workflow_id.as_deref(), Some("workflow-candidate"));
        assert_eq!(item.experiment_id.as_deref(), Some("experiment-1"));
        assert_eq!(item.experiment_arm.as_deref(), Some("candidate"));
        assert_eq!(item.experiment_episode, Some(1));
        assert_eq!(item.source_phase_id.as_deref(), Some("verify-source"));
        assert_eq!(
            item.experiment_fixture_sha256.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            item.experiment_prompt_sha256.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        let serialized = serde_json::to_value(item).expect("serialize queue snapshot");
        assert_eq!(
            serialized["experiment_prompt_sha256"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn experiment_metadata_requires_the_same_execution_controls_as_node() {
        let root = temp_root("experiment-controls");
        write_fixture(
      &root,
      "queue/now.yaml",
      "now:\n  - id: canary-candidate-01\n    mission_id: mission-1\n    phase_id: canary-candidate-01\n    workflow_id: workflow-candidate\n    experiment_id: experiment-1\n    experiment_arm: candidate\n    experiment_episode: 1\n    source_phase_id: verify-source\n    experiment_fixture_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    experiment_prompt_sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbacklog: []\n",
    );

        let error =
            get_workbench_snapshot_at(&root).expect_err("missing experiment controls must fail");
        assert!(error.contains("explicit run_kind/eval_profile"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn revision_lineage_is_preserved_and_partial_lineage_fails_closed() {
        let root = temp_root("revision-lineage");
        let revision_id = revision_fix_run_id("review-parent", 1);
        write_fixture(
      &root,
      "queue/now.yaml",
      &format!(
        "now:\n  - id: {revision_id}\n    kind: implement\n    run_kind: implement\n    revision_of: review-parent\n    revision_attempt: 1\nbacklog: []\n"
      ),
    );
        let snapshot = get_workbench_snapshot_at(&root).expect("revision queue");
        assert_eq!(
            snapshot.queue[0].revision_of.as_deref(),
            Some("review-parent")
        );
        assert_eq!(snapshot.queue[0].revision_attempt, Some(1));

        write_fixture(
      &root,
      "queue/now.yaml",
      &format!(
        "now:\n  - id: {revision_id}\n    kind: implement\n    run_kind: implement\n    revision_of: review-parent\nbacklog: []\n"
      ),
    );
        let error = get_workbench_snapshot_at(&root).expect_err("partial lineage must fail");
        assert!(error.contains("provided together"));

        write_fixture(
      &root,
      "queue/now.yaml",
      "now:\n  - id: revision-forged-1\n    kind: implement\n    run_kind: implement\n    revision_of: review-parent\n    revision_attempt: 1\nbacklog: []\n",
    );
        let error = get_workbench_snapshot_at(&root).expect_err("forged lineage must fail");
        assert!(error.contains("does not match its revision lineage"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn partial_experiment_metadata_fails_closed() {
        let root = temp_root("partial-experiment");
        write_fixture(
      &root,
      "queue/now.yaml",
      "now:\n  - id: canary-candidate-01\n    mission_id: mission-1\n    phase_id: canary-candidate-01\n    workflow_id: workflow-candidate\n    experiment_id: experiment-1\n    experiment_arm: candidate\n    experiment_episode: 1\n    source_phase_id: verify-source\n    experiment_fixture_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbacklog: []\n",
    );

        let error = get_workbench_snapshot_at(&root).expect_err("partial experiment must fail");
        assert!(error.contains("experiment metadata requires"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn malformed_experiment_prompt_digest_fails_closed() {
        let root = temp_root("malformed-experiment-prompt");
        write_fixture(
      &root,
      "queue/now.yaml",
      "now:\n  - id: canary-candidate-01\n    mission_id: mission-1\n    phase_id: canary-candidate-01\n    workflow_id: workflow-candidate\n    experiment_id: experiment-1\n    experiment_arm: candidate\n    experiment_episode: 1\n    source_phase_id: verify-source\n    experiment_fixture_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    experiment_prompt_sha256: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nbacklog: []\n",
    );

        let error = get_workbench_snapshot_at(&root).expect_err("invalid prompt digest must fail");
        assert!(error.contains("experiment_prompt_sha256 must be lowercase SHA-256"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn malformed_existing_orchestrator_state_fails_closed() {
        let root = temp_root("bad-state");
        write_fixture(&root, "queue/now.yaml", "now: []\nbacklog: []\n");
        write_fixture(
            &root,
            "state/orchestrator.json",
            r#"{"activeRunId":null,"activeRunStatus":"complete"}"#,
        );
        let error = get_workbench_snapshot_at(&root).expect_err("unknown status must fail");
        assert!(error.contains("activeRunStatus must be one of"));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    #[ignore = "requires a configured external AgentWorkbench"]
    fn configured_workbench_snapshot_smoke() {
        let root = workbench_root_path();
        let snapshot = get_workbench_snapshot_at(&root).expect("configured Workbench snapshot");
        assert!(
            snapshot.root_configured,
            "Workbench root is missing: {}",
            root.display()
        );
    }
}
