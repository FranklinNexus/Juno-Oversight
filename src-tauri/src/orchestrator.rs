use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, System};

use crate::workbench_root_path;

const MIN_NODE_MAJOR: u64 = 22;
const MIN_NODE_MINOR: u64 = 13;
const MAX_RUN_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_RUN_EVENTS_BYTES: usize = 4 * 1024 * 1024;
const MAX_RUN_MINUTES: u64 = 240;
const MAX_STATE_CONTROL_BYTES: usize = 256 * 1024;
const MAX_PID_CONTROL_BYTES: usize = 16 * 1024;
const MAX_DAEMON_LEASE_BYTES: usize = 16 * 1024;
const MAX_LIFECYCLE_LOCK_BYTES: usize = 16 * 1024;
const DAEMON_PROTOCOL_VERSION: u64 = 2;
const LIFECYCLE_LOCK_STALE_MS: u64 = 30_000;
const LIFECYCLE_LOCK_WAIT: Duration = Duration::from_secs(15);
const BUNDLED_RUNTIME_DIRECTORY: &str = "juno-runtime";
const REQUIRED_RUNTIME_ASSETS: &[&str] = &[
  "orchestrator/dist/spawn-run.js",
  "orchestrator/dist/manifest.js",
  "orchestrator/dist/codex-executor.js",
  "orchestrator/dist/verify-runner.js",
  "orchestrator/dist/execution-artifact.js",
  "orchestrator/dist/control-file.js",
  "orchestrator/dist/workflow-experiment.js",
  "orchestrator/dist/mission-completion.js",
  "orchestrator/dist/operator-recovery.js",
  "orchestrator/dist/operator-recovery-cli.js",
  "orchestrator/dist/queue-io.js",
  "orchestrator/dist/safety-verify.js",
  "orchestrator/dist/literature-verify.js",
  "orchestrator/dist/revision-lineage.js",
  "orchestrator/dist/run-slot-lock.js",
  "orchestrator/dist/bounded-autonomy.js",
  "orchestrator/dist/autonomy-lock.js",
  "orchestrator/dist/autonomy-day.js",
  "scripts/run-juno-daemon.mjs",
  "scripts/start-juno-login.mjs",
  "scripts/terminate-process-tree.ps1",
  "scripts/lib/daemon-control.mjs",
  "scripts/juno-autonomy-tick.mjs",
  "node_modules/@openai/codex-sdk/dist/index.js",
  "node_modules/yaml/dist/index.js",
];
static BUNDLED_RUNTIME_ROOT: OnceLock<PathBuf> = OnceLock::new();
static CONTROL_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
struct ControlFileIdentity {
  volume: u64,
  file_index: u64,
  links: u64,
  size: u64,
  modified: u128,
  changed: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ControlFileSnapshot {
  bytes: Vec<u8>,
  text: String,
  identity: ControlFileIdentity,
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
  fn OpenProcess(
    desired_access: u32,
    inherit_handle: i32,
    process_id: u32,
  ) -> *mut std::ffi::c_void;
  fn TerminateProcess(handle: *mut std::ffi::c_void, exit_code: u32) -> i32;
  fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
  fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeAssetManifest {
  version: u64,
  node: String,
  codex_cli: String,
  embedded_codex_platform_binary: bool,
  total_bytes: u64,
  assets: Vec<RuntimeAssetEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAssetEntry {
  path: String,
  bytes: u64,
  sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRunResult {
  pub run_id: String,
  pub pid: u32,
  pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsResult {
  pub run_id: String,
  pub lines: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperatorRecoveryAction {
  ResumeExactIntent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRecoveryApplyRequest {
  incident_id: String,
  action: OperatorRecoveryAction,
  precondition_sha256: String,
  reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryDomain {
  ControlPlane,
  Queue,
  WorkflowSelection,
  Completion,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryConfidence {
  Proven,
  Ambiguous,
  Invalid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryEntryKind {
  File,
  Directory,
  Symlink,
  Other,
  Missing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryArtifactValidation {
  StableFile,
  UnexpectedLinkCount,
  Oversized,
  NonFile,
  Unreadable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryFileIdentity {
  dev: String,
  ino: String,
  mode: String,
  nlink: String,
  size: String,
  mtime_ns: String,
  ctime_ns: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryArtifactSnapshot {
  relative_path: String,
  entry_kind: RecoveryEntryKind,
  identity: Option<RecoveryFileIdentity>,
  byte_length: Option<u64>,
  sha256: Option<String>,
  validation: RecoveryArtifactValidation,
  detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryExpectedReceipt {
  receipt_version: u64,
  mission_id: String,
  terminal_run_id: String,
  run_checkpoint_sha256: String,
  evidence_version: String,
  completed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryCompletionBinding {
  mission_id: String,
  terminal_run_id: String,
  expected_head_fingerprint: String,
  intent_sha256: String,
  expected_receipt: RecoveryExpectedReceipt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRecoveryIncident {
  incident_id: String,
  domain: RecoveryDomain,
  kind: String,
  blocking: bool,
  confidence: RecoveryConfidence,
  artifact: RecoveryArtifactSnapshot,
  detail: String,
  completion_binding: Option<RecoveryCompletionBinding>,
  allowed_actions: Vec<OperatorRecoveryAction>,
  precondition_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryControls {
  queue: Option<RecoveryArtifactSnapshot>,
  workflow_selection: Option<RecoveryArtifactSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRecoveryInventory {
  inventory_version: u64,
  observed_at: String,
  workbench: String,
  controls: RecoveryControls,
  incidents: Vec<OperatorRecoveryIncident>,
  inventory_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionRecoveryStatus {
  None,
  Recovered,
  Busy,
  Blocked,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionRecoveryMode {
  DequeuedHead,
  HeadAlreadyAbsent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveredCompletion {
  mission_id: String,
  terminal_run_id: String,
  mode: CompletionRecoveryMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionRecoveryResult {
  status: CompletionRecoveryStatus,
  recovered: Vec<RecoveredCompletion>,
  reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRecoveryApplyResult {
  operation_id: String,
  incident_id: String,
  action: OperatorRecoveryAction,
  reason: String,
  recovery: CompletionRecoveryResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorRecoveryOperationBinding<'a> {
  action: &'a OperatorRecoveryAction,
  incident_id: &'a str,
  journal_version: u64,
  precondition_sha256: &'a str,
  reason: &'a str,
}

const OPERATOR_RECOVERY_STDOUT_BYTES: usize = 4 * 1024 * 1024;
const OPERATOR_RECOVERY_STDERR_BYTES: usize = 64 * 1024;
const OPERATOR_RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct RunManifestMeta {
  #[serde(rename = "runId")]
  run_id: String,
  #[serde(rename = "maxMinutes", default = "default_max_minutes")]
  max_minutes: u64,
}

fn default_max_minutes() -> u64 {
  25
}

pub struct OrchestratorRuntime {
  child: Mutex<Option<Child>>,
  active_run_id: Mutex<Option<String>>,
  started_at: Mutex<Option<SystemTime>>,
  manifest_path: Mutex<Option<PathBuf>>,
}

impl OrchestratorRuntime {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
      active_run_id: Mutex::new(None),
      started_at: Mutex::new(None),
      manifest_path: Mutex::new(None),
    }
  }

}

fn acquire_run_spawn_slot(
  runtime: &OrchestratorRuntime,
) -> Result<MutexGuard<'_, Option<Child>>, String> {
  let mut guard = runtime.child.lock().expect("child lock");
  if let Some(child) = guard.as_mut() {
    match child.try_wait() {
      Ok(Some(status)) => {
        let run_id = runtime
          .active_run_id
          .lock()
          .expect("run id lock")
          .clone();
        if let Some(run_id) = run_id.as_deref() {
          write_orchestrator_status(
            &workbench_root_path(),
            run_id,
            if status.success() { "done" } else { "failed" },
          )?;
        }
        *guard = None;
        *runtime.active_run_id.lock().expect("run id lock") = None;
        *runtime.started_at.lock().expect("started lock") = None;
        *runtime.manifest_path.lock().expect("manifest lock") = None;
      }
      Ok(None) => return Err("A run is already active".to_string()),
      Err(error) => return Err(format!("failed to inspect active run: {error}")),
    }
  }
  Ok(guard)
}

fn resolve_project_root(
  environment_override: Option<&str>,
  bundled_root: Option<&Path>,
  cargo_manifest_dir: &Path,
) -> PathBuf {
  if let Some(from_env) = environment_override.filter(|value| !value.trim().is_empty()) {
    return PathBuf::from(from_env.trim());
  }
  if let Some(bundled) = bundled_root {
    return bundled.to_path_buf();
  }
  cargo_manifest_dir
    .parent()
    .expect("project root")
    .to_path_buf()
}

pub(crate) fn juno_project_root() -> PathBuf {
  let environment_override = env::var("JUNO_OVERSIGHT_ROOT").ok();
  resolve_project_root(
    environment_override.as_deref(),
    BUNDLED_RUNTIME_ROOT.get().map(PathBuf::as_path),
    Path::new(env!("CARGO_MANIFEST_DIR")),
  )
}

fn bundled_runtime_active(project_root: &Path) -> bool {
  BUNDLED_RUNTIME_ROOT.get().map(PathBuf::as_path) == Some(project_root)
}

fn collect_runtime_files(
  root: &Path,
  directory: &Path,
  files: &mut HashSet<String>,
) -> Result<(), String> {
  for entry in fs::read_dir(directory)
    .map_err(|error| format!("bundled runtime directory is unreadable ({}): {error}", directory.display()))?
  {
    let entry = entry.map_err(|error| format!("bundled runtime entry is unreadable: {error}"))?;
    let path = entry.path();
    let metadata = fs::symlink_metadata(&path)
      .map_err(|error| format!("bundled runtime entry is unavailable ({}): {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
      return Err(format!("bundled runtime must not contain symlinks: {}", path.display()));
    }
    if metadata.is_dir() {
      collect_runtime_files(root, &path, files)?;
    } else if metadata.is_file() {
      let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("bundled runtime file escapes its root: {}", path.display()))?
        .to_string_lossy()
        .replace('\\', "/");
      if relative != "runtime-manifest.json" && !files.insert(relative.clone()) {
        return Err(format!("bundled runtime contains a duplicate path: {relative}"));
      }
    } else {
      return Err(format!("bundled runtime contains an unsupported entry: {}", path.display()));
    }
  }
  Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
  let mut file = fs::File::open(path)
    .map_err(|error| format!("bundled runtime asset is unreadable ({}): {error}", path.display()))?;
  let mut hasher = Sha256::new();
  let mut buffer = [0_u8; 16 * 1024];
  loop {
    let read = file
      .read(&mut buffer)
      .map_err(|error| format!("bundled runtime asset read failed ({}): {error}", path.display()))?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn validate_runtime_asset_root(root: &Path) -> Result<(), String> {
  let root_metadata = fs::symlink_metadata(root)
    .map_err(|error| format!("bundled Juno runtime directory is unavailable ({}): {error}", root.display()))?;
  if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
    return Err(format!("bundled Juno runtime directory is unavailable: {}", root.display()));
  }
  let manifest_path = root.join("runtime-manifest.json");
  let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
    format!("bundled Juno runtime manifest is unavailable ({}): {error}", manifest_path.display())
  })?;
  if !manifest_metadata.is_file() || manifest_metadata.file_type().is_symlink() {
    return Err(format!(
      "bundled Juno runtime manifest must be a regular file: {}",
      manifest_path.display()
    ));
  }
  let manifest_text = fs::read_to_string(&manifest_path).map_err(|error| {
    format!("bundled Juno runtime manifest is unreadable ({}): {error}", manifest_path.display())
  })?;
  let manifest: RuntimeAssetManifest = serde_json::from_str(&manifest_text).map_err(|error| {
    format!("bundled Juno runtime manifest is invalid ({}): {error}", manifest_path.display())
  })?;
  if manifest.version != 1
    || manifest.node != ">=22.13.0"
    || manifest.codex_cli != "external-required"
    || manifest.embedded_codex_platform_binary
  {
    return Err("bundled Juno runtime requirements are unsupported".to_string());
  }

  let mut declared_files = HashSet::new();
  let mut total_bytes = 0_u64;
  for asset in &manifest.assets {
    let relative = Path::new(&asset.path);
    if asset.path.is_empty()
      || relative.is_absolute()
      || !relative
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
      || asset.sha256.len() != 64
      || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
      || !declared_files.insert(asset.path.clone())
    {
      return Err(format!("bundled Juno runtime manifest has an unsafe asset: {}", asset.path));
    }
    let target = root.join(relative);
    let metadata = fs::symlink_metadata(&target).map_err(|error| {
      format!("bundled Juno runtime asset is unavailable ({}): {error}", target.display())
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
      return Err(format!(
        "bundled Juno runtime asset must be a regular file: {}",
        target.display()
      ));
    }
    if metadata.len() != asset.bytes || sha256_file(&target)? != asset.sha256 {
      return Err(format!(
        "bundled Juno runtime asset failed size/SHA-256 validation: {}",
        asset.path
      ));
    }
    total_bytes = total_bytes
      .checked_add(asset.bytes)
      .ok_or_else(|| "bundled Juno runtime size overflow".to_string())?;
  }
  if total_bytes != manifest.total_bytes || total_bytes > 20 * 1024 * 1024 {
    return Err(format!("bundled Juno runtime size validation failed: {total_bytes} bytes"));
  }

  let mut actual_files = HashSet::new();
  collect_runtime_files(root, root, &mut actual_files)?;
  if actual_files != declared_files {
    let missing: Vec<_> = declared_files.difference(&actual_files).cloned().collect();
    let extra: Vec<_> = actual_files.difference(&declared_files).cloned().collect();
    return Err(format!(
      "bundled Juno runtime file set does not match its manifest (missing: {}; extra: {})",
      missing.join(", "),
      extra.join(", ")
    ));
  }

  for relative in REQUIRED_RUNTIME_ASSETS {
    if !declared_files.contains(*relative) {
      return Err(format!("bundled Juno runtime is missing required asset: {relative}"));
    }
  }
  Ok(())
}

pub(crate) fn configure_bundled_runtime(resource_dir: &Path) -> Result<(), String> {
  let runtime_root = resource_dir.join(BUNDLED_RUNTIME_DIRECTORY);
  validate_runtime_asset_root(&runtime_root)?;
  BUNDLED_RUNTIME_ROOT
    .set(runtime_root.clone())
    .map_err(|_| "bundled Juno runtime root was configured more than once".to_string())?;
  Ok(())
}

fn spawn_script_path() -> PathBuf {
  juno_project_root().join("orchestrator/dist/spawn-run.js")
}

fn apply_project_env(cmd: &mut Command, codex_path: Option<&Path>) {
  let project_root = juno_project_root();
  cmd.env("JUNO_OVERSIGHT_ROOT", &project_root);
  cmd.env("AGENT_WORKBENCH_ROOT", workbench_root_path());
  if bundled_runtime_active(&project_root) {
    cmd.env("JUNO_PACKAGED_RUNTIME", "1");
    cmd.env("JUNO_SKIP_ORCHESTRATOR_BUILD", "1");
  }
  if let Some(codex_path) = codex_path {
    cmd.env("JUNO_CODEX_PATH", codex_path);
  }
}

#[derive(Clone, Copy)]
enum OperatorRecoveryCliMode {
  Inspect,
  Apply,
}

impl OperatorRecoveryCliMode {
  fn argument(self) -> &'static str {
    match self {
      Self::Inspect => "inspect",
      Self::Apply => "apply",
    }
  }
}

fn operator_recovery_script_path() -> PathBuf {
  juno_project_root().join("orchestrator/dist/operator-recovery-cli.js")
}

fn is_lowercase_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn operator_recovery_operation_id(
  request: &OperatorRecoveryApplyRequest,
) -> Result<String, String> {
  // Field order mirrors the protocol's recursively sorted canonical JSON.
  let binding = OperatorRecoveryOperationBinding {
    action: &request.action,
    incident_id: &request.incident_id,
    journal_version: 1,
    precondition_sha256: &request.precondition_sha256,
    reason: &request.reason,
  };
  let canonical = serde_json::to_vec(&binding)
    .map_err(|error| format!("operator recovery operation binding is not serializable: {error}"))?;
  Ok(format!("{:x}", Sha256::digest(canonical)))
}

fn validate_operator_recovery_request(
  request: &OperatorRecoveryApplyRequest,
) -> Result<(), String> {
  if !is_lowercase_sha256(&request.incident_id)
    || !is_lowercase_sha256(&request.precondition_sha256)
  {
    return Err("operator recovery fingerprints must be lowercase SHA-256 values".to_string());
  }
  if request.reason.is_empty()
    || request.reason.encode_utf16().count() > 500
    || request.reason.trim() != request.reason
    || request
      .reason
      .chars()
      .any(|character| character <= '\u{1f}' || character == '\u{7f}')
  {
    return Err(
      "operator recovery reason must be trimmed, non-empty, and at most 500 characters"
        .to_string(),
    );
  }
  Ok(())
}

fn validate_operator_recovery_result(
  request: &OperatorRecoveryApplyRequest,
  result: &OperatorRecoveryApplyResult,
) -> Result<(), String> {
  let expected_operation_id = operator_recovery_operation_id(request)?;
  if !is_lowercase_sha256(&result.operation_id)
    || result.operation_id != expected_operation_id
    || result.incident_id != request.incident_id
    || result.action != request.action
    || result.reason != request.reason
  {
    return Err("operator recovery result does not match the apply request".to_string());
  }
  Ok(())
}

fn validate_recovery_artifact(artifact: &RecoveryArtifactSnapshot) -> Result<(), String> {
  if artifact.relative_path.is_empty()
    || Path::new(&artifact.relative_path).is_absolute()
    || Path::new(&artifact.relative_path)
      .components()
      .any(|component| matches!(component, std::path::Component::ParentDir))
  {
    return Err("operator recovery artifact path is invalid".to_string());
  }
  if artifact
    .sha256
    .as_deref()
    .is_some_and(|digest| !is_lowercase_sha256(digest))
  {
    return Err("operator recovery artifact digest is invalid".to_string());
  }
  Ok(())
}

fn validate_operator_recovery_inventory(
  inventory: &OperatorRecoveryInventory,
) -> Result<(), String> {
  if inventory.inventory_version != 1
    || inventory.workbench.is_empty()
    || !is_lowercase_sha256(&inventory.inventory_sha256)
  {
    return Err("operator recovery inventory header is invalid".to_string());
  }
  if let Some(queue) = inventory.controls.queue.as_ref() {
    validate_recovery_artifact(queue)?;
  }
  if let Some(selection) = inventory.controls.workflow_selection.as_ref() {
    validate_recovery_artifact(selection)?;
  }
  for incident in &inventory.incidents {
    if !incident.blocking
      || incident.kind.is_empty()
      || incident.detail.is_empty()
      || !is_lowercase_sha256(&incident.incident_id)
      || incident.precondition_sha256 != inventory.inventory_sha256
    {
      return Err("operator recovery incident binding is invalid".to_string());
    }
    validate_recovery_artifact(&incident.artifact)?;
    if let Some(binding) = incident.completion_binding.as_ref() {
      if binding.mission_id.is_empty()
        || binding.terminal_run_id.is_empty()
        || !is_lowercase_sha256(&binding.expected_head_fingerprint)
        || !is_lowercase_sha256(&binding.intent_sha256)
        || binding.expected_receipt.receipt_version != 1
        || binding.expected_receipt.mission_id != binding.mission_id
        || binding.expected_receipt.terminal_run_id != binding.terminal_run_id
        || !is_lowercase_sha256(&binding.expected_receipt.run_checkpoint_sha256)
        || binding.expected_receipt.evidence_version.is_empty()
        || binding.expected_receipt.completed_at.is_empty()
      {
        return Err("operator recovery completion binding is invalid".to_string());
      }
    }
  }
  Ok(())
}

fn read_bounded_child_stream<R: Read>(
  mut stream: R,
  limit: usize,
  label: &'static str,
) -> Result<Vec<u8>, String> {
  let mut output = Vec::new();
  let mut overflow = false;
  let mut buffer = [0_u8; 8 * 1024];
  loop {
    let count = stream
      .read(&mut buffer)
      .map_err(|error| format!("operator recovery {label} read failed: {error}"))?;
    if count == 0 {
      break;
    }
    if output.len().saturating_add(count) > limit {
      overflow = true;
    } else if !overflow {
      output.extend_from_slice(&buffer[..count]);
    }
  }
  if overflow {
    return Err(format!("operator recovery {label} exceeded {limit} bytes"));
  }
  Ok(output)
}

fn run_operator_recovery_cli<T: DeserializeOwned>(
  mode: OperatorRecoveryCliMode,
  input: Option<&OperatorRecoveryApplyRequest>,
) -> Result<T, String> {
  let project_root = juno_project_root();
  if bundled_runtime_active(&project_root) {
    validate_runtime_asset_root(&project_root)?;
  }
  let script = operator_recovery_script_path();
  let metadata = fs::symlink_metadata(&script).map_err(|error| {
    format!(
      "operator recovery CLI is unavailable ({}): {error}",
      script.display()
    )
  })?;
  if !metadata.is_file() || metadata.file_type().is_symlink() {
    return Err(format!(
      "operator recovery CLI must be a regular file: {}",
      script.display()
    ));
  }
  let payload = match (mode, input) {
    (OperatorRecoveryCliMode::Inspect, None) => None,
    (OperatorRecoveryCliMode::Apply, Some(request)) => {
      validate_operator_recovery_request(request)?;
      Some(serde_json::to_vec(request).map_err(|error| error.to_string())?)
    }
    _ => return Err("operator recovery command/input binding is invalid".to_string()),
  };

  let node = resolve_node_binary()?;
  let mut command = Command::new(&node);
  command
    .arg(&script)
    .arg(mode.argument())
    .current_dir(&project_root)
    .stdin(if payload.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  apply_project_env(&mut command, None);
  let mut child = command.spawn().map_err(|error| {
    format!(
      "failed to start operator recovery CLI with {}: {error}",
      node.display()
    )
  })?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "operator recovery stdout pipe is unavailable".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "operator recovery stderr pipe is unavailable".to_string())?;
  let stdout_reader = std::thread::spawn(move || {
    read_bounded_child_stream(stdout, OPERATOR_RECOVERY_STDOUT_BYTES, "stdout")
  });
  let stderr_reader = std::thread::spawn(move || {
    read_bounded_child_stream(stderr, OPERATOR_RECOVERY_STDERR_BYTES, "stderr")
  });

  if let Some(payload) = payload {
    let mut stdin = child
      .stdin
      .take()
      .ok_or_else(|| "operator recovery stdin pipe is unavailable".to_string())?;
    if let Err(error) = stdin.write_all(&payload) {
      let _ = child.kill();
      let _ = child.wait();
      return Err(format!("operator recovery stdin write failed: {error}"));
    }
  }

  let deadline = Instant::now() + OPERATOR_RECOVERY_TIMEOUT;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
      Ok(None) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
          "operator recovery {} timed out after {} seconds",
          mode.argument(),
          OPERATOR_RECOVERY_TIMEOUT.as_secs()
        ));
      }
      Err(error) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("operator recovery process wait failed: {error}"));
      }
    }
  };
  let stdout = stdout_reader
    .join()
    .map_err(|_| "operator recovery stdout reader panicked".to_string())??;
  let stderr = stderr_reader
    .join()
    .map_err(|_| "operator recovery stderr reader panicked".to_string())??;
  let stderr = String::from_utf8(stderr)
    .map_err(|_| "operator recovery stderr is not valid UTF-8".to_string())?;
  if !status.success() {
    let detail = stderr.trim();
    return Err(format!(
      "operator recovery {} failed with status {}{}",
      mode.argument(),
      status.code().map_or_else(|| "signal".to_string(), |code| code.to_string()),
      if detail.is_empty() {
        String::new()
      } else {
        format!(": {detail}")
      }
    ));
  }
  if !stderr.trim().is_empty() {
    return Err(format!(
      "operator recovery {} emitted unexpected stderr: {}",
      mode.argument(),
      stderr.trim()
    ));
  }
  serde_json::from_slice(&stdout).map_err(|error| {
    format!(
      "operator recovery {} returned invalid JSON: {error}",
      mode.argument()
    )
  })
}

pub fn inspect_operator_recovery() -> Result<OperatorRecoveryInventory, String> {
  let inventory: OperatorRecoveryInventory =
    run_operator_recovery_cli(OperatorRecoveryCliMode::Inspect, None)?;
  validate_operator_recovery_inventory(&inventory)?;
  Ok(inventory)
}

pub fn apply_operator_recovery(
  request: OperatorRecoveryApplyRequest,
) -> Result<OperatorRecoveryApplyResult, String> {
  validate_operator_recovery_request(&request)?;
  let result: OperatorRecoveryApplyResult =
    run_operator_recovery_cli(OperatorRecoveryCliMode::Apply, Some(&request))?;
  validate_operator_recovery_result(&request, &result)?;
  Ok(result)
}

fn same_path(left: &Path, right: &Path) -> bool {
  #[cfg(target_os = "windows")]
  {
    let normalize = |path: &Path| {
      let value = path.to_string_lossy().replace('/', "\\");
      let without_extended_prefix = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
      } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
      } else {
        value
      };
      without_extended_prefix.to_lowercase()
    };
    normalize(left) == normalize(right)
  }
  #[cfg(not(target_os = "windows"))]
  {
    left == right
  }
}

fn path_entry_exists(path: &Path, label: &str) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(_) => Ok(true),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(format!(
      "{label} availability cannot be determined ({}): {error}",
      path.display()
    )),
  }
}

fn validate_direct_workbench_root(
  workbench: &Path,
  name: &str,
  label: &str,
  create: bool,
) -> Result<(PathBuf, PathBuf), String> {
  let canonical_workbench = fs::canonicalize(workbench).map_err(|error| {
    format!(
      "Workbench root cannot be canonicalized ({}): {error}",
      workbench.display()
    )
  })?;
  let lexical = canonical_workbench.join(name);
  if create && !path_entry_exists(&lexical, label)? {
    match fs::create_dir(&lexical) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
      Err(error) => {
        return Err(format!(
          "{label} cannot be created ({}): {error}",
          lexical.display()
        ))
      }
    }
  }
  let metadata = fs::symlink_metadata(&lexical)
    .map_err(|error| format!("{label} is unavailable ({}): {error}", lexical.display()))?;
  if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
    return Err(format!(
      "{label} must be a direct non-link Workbench directory: {}",
      lexical.display()
    ));
  }
  let canonical = fs::canonicalize(&lexical)
    .map_err(|error| format!("{label} cannot be canonicalized ({}): {error}", lexical.display()))?;
  if !same_path(&canonical, &lexical)
    || canonical
      .parent()
      .map(|parent| same_path(parent, &canonical_workbench))
      != Some(true)
  {
    return Err(format!(
      "{label} escapes the canonical Workbench: {}",
      lexical.display()
    ));
  }
  Ok((canonical_workbench, canonical))
}

fn assert_direct_workbench_root_unchanged(
  canonical_workbench: &Path,
  expected_root: &Path,
  name: &str,
  label: &str,
) -> Result<(), String> {
  let (observed_workbench, observed_root) =
    validate_direct_workbench_root(canonical_workbench, name, label, false)?;
  if !same_path(&observed_workbench, canonical_workbench)
    || !same_path(&observed_root, expected_root)
  {
    return Err(format!("{label} changed during the control operation"));
  }
  Ok(())
}

fn assert_stable_parent(path: &Path, label: &str) -> Result<(), String> {
  let parent = path
    .parent()
    .ok_or_else(|| format!("{label} has no parent directory: {}", path.display()))?;
  let canonical = fs::canonicalize(parent)
    .map_err(|error| format!("{label} parent is unavailable ({}): {error}", parent.display()))?;
  if !same_path(&canonical, parent) {
    return Err(format!(
      "{label} parent changed containment: {}",
      parent.display()
    ));
  }
  Ok(())
}

#[cfg(unix)]
fn control_file_identity(file: &fs::File) -> std::io::Result<ControlFileIdentity> {
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
fn control_file_identity(file: &fs::File) -> std::io::Result<ControlFileIdentity> {
  use std::mem::MaybeUninit;
  use std::os::windows::io::AsRawHandle;

  let mut information = MaybeUninit::<WindowsFileInformation>::uninit();
  let result = unsafe {
    GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
  };
  if result == 0 {
    return Err(std::io::Error::last_os_error());
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

fn read_bounded_control_with_hook<F>(
  path: &Path,
  label: &str,
  max_bytes: usize,
  expected_links: u64,
  after_open: F,
) -> Result<ControlFileSnapshot, String>
where
  F: FnOnce(),
{
  let before = fs::symlink_metadata(path)
    .map_err(|error| format!("{label} is unavailable ({}): {error}", path.display()))?;
  if !before.file_type().is_file() || before.file_type().is_symlink() {
    return Err(format!("{label} must be a regular file: {}", path.display()));
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
  let opened = control_file_identity(&file)
    .map_err(|error| format!("{label} identity is unavailable ({}): {error}", path.display()))?;
  if opened.links != expected_links {
    if expected_links == 1 {
      return Err(format!(
        "{label} must be an exclusive regular file: {}",
        path.display()
      ));
    }
    return Err(format!(
      "{label} must have exactly {expected_links} filesystem link(s): {}",
      path.display(),
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
  Read::by_ref(&mut file)
    .take(max_bytes as u64 + 1)
    .read_to_end(&mut bytes)
    .map_err(|error| format!("{label} cannot be read ({}): {error}", path.display()))?;
  if bytes.len() > max_bytes {
    return Err(format!(
      "{label} exceeds the {max_bytes}-byte limit: {}",
      path.display()
    ));
  }

  let after_handle = control_file_identity(&file)
    .map_err(|error| format!("{label} identity is unavailable ({}): {error}", path.display()))?;
  let after_path = fs::symlink_metadata(path)
    .map_err(|error| format!("{label} changed while reading ({}): {error}", path.display()))?;
  if !after_path.file_type().is_file() || after_path.file_type().is_symlink() {
    return Err(format!("{label} changed while reading: {}", path.display()));
  }
  assert_stable_parent(path, label)?;
  let verifier = fs::File::open(path)
    .map_err(|error| format!("{label} changed while reading ({}): {error}", path.display()))?;
  let after_name = control_file_identity(&verifier)
    .map_err(|error| format!("{label} identity is unavailable ({}): {error}", path.display()))?;
  let final_path = fs::symlink_metadata(path)
    .map_err(|error| format!("{label} changed while reading ({}): {error}", path.display()))?;
  if !final_path.file_type().is_file() || final_path.file_type().is_symlink() {
    return Err(format!("{label} changed while reading: {}", path.display()));
  }
  assert_stable_parent(path, label)?;
  if opened != after_handle
    || after_handle != after_name
    || after_handle.links != expected_links
    || after_handle.size != bytes.len() as u64
    || after_path.len() != bytes.len() as u64
    || final_path.len() != bytes.len() as u64
  {
    return Err(format!("{label} changed while reading: {}", path.display()));
  }

  let text = String::from_utf8(bytes.clone())
    .map_err(|error| format!("{label} is not readable UTF-8 ({}): {error}", path.display()))?;
  Ok(ControlFileSnapshot {
    bytes,
    text,
    identity: after_handle,
  })
}

fn read_bounded_control(
  path: &Path,
  label: &str,
  max_bytes: usize,
) -> Result<ControlFileSnapshot, String> {
  read_bounded_control_with_hook(path, label, max_bytes, 1, || {}).map_err(|error| {
    if error.contains("must have exactly 1 filesystem link(s)") {
      format!("{label} must be an exclusive regular file: {}", path.display())
    } else {
      error
    }
  })
}

fn read_linked_control(
  path: &Path,
  label: &str,
  max_bytes: usize,
  expected_links: u64,
) -> Result<ControlFileSnapshot, String> {
  read_bounded_control_with_hook(path, label, max_bytes, expected_links, || {})
}

fn same_moved_control(left: &ControlFileSnapshot, right: &ControlFileSnapshot) -> bool {
  left.bytes == right.bytes
    && left.identity.volume == right.identity.volume
    && left.identity.file_index == right.identity.file_index
    && left.identity.size == right.identity.size
    && left.identity.modified == right.identity.modified
}

fn control_temp_suffix() -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  let sequence = CONTROL_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("{}-{nanos}-{sequence}", std::process::id())
}

fn assert_no_control_preimage(directory: &Path, file_name: &str, label: &str) -> Result<(), String> {
  let prefix = format!("{file_name}.preimage-");
  let mut artifacts = vec![];
  for entry in fs::read_dir(directory)
    .map_err(|error| format!("{label} directory is unreadable ({}): {error}", directory.display()))?
  {
    let entry = entry.map_err(|error| format!("{label} directory entry is unreadable: {error}"))?;
    if entry.file_name().to_string_lossy().starts_with(&prefix) {
      artifacts.push(entry.file_name().to_string_lossy().into_owned());
    }
  }
  if !artifacts.is_empty() {
    artifacts.sort();
    return Err(format!(
      "{label} has orphaned preimage state: {}",
      artifacts.join(", ")
    ));
  }
  Ok(())
}

fn restore_control_preimage(
  target: &Path,
  preimage: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
) -> Result<(), String> {
  if path_entry_exists(target, label)? {
    return Err(format!(
      "{label} target is occupied; exact preimage was retained at {}",
      preimage.display()
    ));
  }
  let live = read_bounded_control(preimage, &format!("{label} preimage"), max_bytes)?;
  if !same_moved_control(expected, &live) {
    return Err(format!("{label} preimage changed before recovery"));
  }
  fs::hard_link(preimage, target).map_err(|error| {
    format!(
      "{label} exact preimage restore failed ({}): {error}",
      target.display()
    )
  })?;
  let restored_link = read_linked_control(target, label, max_bytes, 2)?;
  if !same_moved_control(expected, &restored_link) {
    return Err(format!("{label} restored preimage identity does not match"));
  }
  fs::remove_file(preimage).map_err(|error| {
    format!(
      "{label} restored preimage cleanup failed ({}): {error}",
      preimage.display()
    )
  })?;
  let restored = read_bounded_control(target, label, max_bytes)?;
  if !same_moved_control(expected, &restored) {
    return Err(format!("{label} restored preimage does not match"));
  }
  Ok(())
}

fn read_control_with_one_or_two_links(
  path: &Path,
  label: &str,
  max_bytes: usize,
) -> Result<ControlFileSnapshot, String> {
  match read_bounded_control(path, label, max_bytes) {
    Ok(snapshot) => Ok(snapshot),
    Err(single_error) => read_linked_control(path, label, max_bytes, 2).map_err(|linked_error| {
      format!(
        "{single_error}; two-link recovery inspection also failed: {linked_error}"
      )
    }),
  }
}

fn remove_control_path_if_same(
  path: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
) -> Result<bool, String> {
  if !path_entry_exists(path, label)? {
    return Ok(true);
  }
  let live = read_control_with_one_or_two_links(path, label, max_bytes)?;
  if !same_moved_control(expected, &live) {
    return Ok(false);
  }
  fs::remove_file(path)
    .map_err(|error| format!("{label} cannot be unlinked ({}): {error}", path.display()))?;
  Ok(true)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CanonicalRemovalOutcome {
  RemovedExpected,
  Missing,
  ForeignRestored,
}

fn read_control_with_expected_links(
  path: &Path,
  label: &str,
  max_bytes: usize,
  expected_links: u64,
) -> Result<ControlFileSnapshot, String> {
  if expected_links == 1 {
    read_bounded_control(path, label, max_bytes)
  } else {
    read_linked_control(path, label, max_bytes, expected_links)
  }
}

fn restore_quarantined_control(
  target: &Path,
  quarantine: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
) -> Result<(), String> {
  if path_entry_exists(target, label)? {
    return Err(format!(
      "{label} foreign generation was retained at {} because the target is occupied",
      quarantine.display()
    ));
  }
  let live = read_control_with_expected_links(
    quarantine,
    &format!("{label} quarantine"),
    max_bytes,
    expected.identity.links,
  )?;
  if live != *expected {
    return Err(format!("{label} quarantine changed before restoration"));
  }
  fs::hard_link(quarantine, target).map_err(|error| {
    format!(
      "{label} foreign generation cannot be restored exclusively ({}): {error}",
      target.display()
    )
  })?;
  let linked_count = expected
    .identity
    .links
    .checked_add(1)
    .ok_or_else(|| format!("{label} link count overflow during restoration"))?;
  let restored_link = read_control_with_expected_links(target, label, max_bytes, linked_count)?;
  let quarantine_link = read_control_with_expected_links(
    quarantine,
    &format!("{label} quarantine"),
    max_bytes,
    linked_count,
  )?;
  if !same_moved_control(expected, &restored_link)
    || !same_moved_control(expected, &quarantine_link)
    || !same_moved_control(&restored_link, &quarantine_link)
  {
    return Err(format!("{label} foreign generation restore identity mismatch"));
  }
  fs::remove_file(quarantine).map_err(|error| {
    format!(
      "{label} quarantine cannot be released after restoration ({}): {error}",
      quarantine.display()
    )
  })?;
  let restored = read_control_with_expected_links(
    target,
    label,
    max_bytes,
    expected.identity.links,
  )?;
  if !same_moved_control(expected, &restored) {
    return Err(format!("{label} restored foreign generation changed"));
  }
  Ok(())
}

fn remove_canonical_control_preserving_replacement(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
) -> Result<CanonicalRemovalOutcome, String> {
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    control_root,
    "state",
    "Workbench state root",
  )?;
  let file_name = target
    .file_name()
    .and_then(OsStr::to_str)
    .ok_or_else(|| format!("{label} has an invalid filename"))?;
  let quarantine = control_root.join(format!(
    "{file_name}.preimage-{}-quarantine",
    control_temp_suffix()
  ));
  match fs::rename(target, &quarantine) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Ok(CanonicalRemovalOutcome::Missing)
    }
    Err(error) => {
      return Err(format!(
        "{label} cannot be moved to quarantine ({}): {error}",
        quarantine.display()
      ))
    }
  }

  let moved = read_control_with_one_or_two_links(
    &quarantine,
    &format!("{label} quarantine"),
    max_bytes,
  )
  .map_err(|error| {
    format!(
      "{label} quarantine was retained at {}: {error}",
      quarantine.display()
    )
  })?;
  if same_moved_control(expected, &moved) {
    fs::remove_file(&quarantine).map_err(|error| {
      format!(
        "{label} expected quarantine cannot be removed ({}): {error}",
        quarantine.display()
      )
    })?;
    return Ok(CanonicalRemovalOutcome::RemovedExpected);
  }

  restore_quarantined_control(target, &quarantine, label, max_bytes, &moved)?;
  Ok(CanonicalRemovalOutcome::ForeignRestored)
}

fn remove_control_snapshot_cas_with_hooks<F, G>(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
  after_precheck: F,
  before_final_remove: G,
) -> Result<(), String>
where
  F: FnOnce(),
  G: FnOnce(),
{
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    control_root,
    "state",
    "Workbench state root",
  )?;
  if !path_entry_exists(target, label)? {
    return Ok(());
  }
  let current = read_bounded_control(target, label, max_bytes)?;
  if current != *expected {
    return Err(format!("{label} changed before cleanup"));
  }
  after_precheck();

  let file_name = target
    .file_name()
    .and_then(OsStr::to_str)
    .ok_or_else(|| format!("{label} has an invalid filename"))?;
  let claim_path = control_root.join(format!(
    "{file_name}.preimage-{}-remove",
    control_temp_suffix()
  ));
  fs::hard_link(target, &claim_path).map_err(|error| {
    format!(
      "{label} cleanup claim cannot be created ({}): {error}",
      claim_path.display()
    )
  })?;

  let cleanup_claim = |claim_path: &Path| -> Result<(), String> {
    let observed = read_control_with_one_or_two_links(claim_path, label, max_bytes)?;
    if remove_control_path_if_same(claim_path, label, max_bytes, &observed)? {
      Ok(())
    } else {
      Err(format!(
        "{label} cleanup claim changed and was retained at {}",
        claim_path.display()
      ))
    }
  };
  if !path_entry_exists(target, label)? {
    cleanup_claim(&claim_path)?;
    return Ok(());
  }
  let linked_target = match read_linked_control(target, label, max_bytes, 2) {
    Ok(snapshot) => snapshot,
    Err(_error) if !path_entry_exists(target, label)? => {
      cleanup_claim(&claim_path)?;
      return Ok(());
    }
    Err(error) => {
      let _ = cleanup_claim(&claim_path);
      return Err(format!("{label} cleanup claim was contended: {error}"));
    }
  };
  let linked_claim = read_linked_control(&claim_path, label, max_bytes, 2)?;
  if !same_moved_control(expected, &linked_target)
    || !same_moved_control(expected, &linked_claim)
    || !same_moved_control(&linked_target, &linked_claim)
  {
    cleanup_claim(&claim_path)?;
    return Err(format!("{label} changed during cleanup claim"));
  }
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    control_root,
    "state",
    "Workbench state root",
  )?;
  let final_target = match read_linked_control(target, label, max_bytes, 2) {
    Ok(snapshot) => snapshot,
    Err(_error) if !path_entry_exists(target, label)? => {
      cleanup_claim(&claim_path)?;
      return Ok(());
    }
    Err(error) => {
      cleanup_claim(&claim_path)?;
      return Err(error);
    }
  };
  let final_claim = read_linked_control(&claim_path, label, max_bytes, 2)?;
  if !same_moved_control(expected, &final_target)
    || !same_moved_control(expected, &final_claim)
    || !same_moved_control(&final_target, &final_claim)
  {
    cleanup_claim(&claim_path)?;
    return Err(format!("{label} changed before cleanup unlink"));
  }

  before_final_remove();
  match remove_canonical_control_preserving_replacement(
    canonical_workbench,
    control_root,
    target,
    label,
    max_bytes,
    &final_target,
  )? {
    CanonicalRemovalOutcome::RemovedExpected | CanonicalRemovalOutcome::Missing => {}
    CanonicalRemovalOutcome::ForeignRestored => {
      cleanup_claim(&claim_path)?;
      return Err(format!(
        "{label} foreign replacement was preserved during cleanup"
      ));
    }
  }
  let single_claim = read_bounded_control(&claim_path, label, max_bytes)?;
  if !same_moved_control(expected, &single_claim) {
    return Err(format!(
      "{label} cleanup claim changed and was retained at {}",
      claim_path.display()
    ));
  }
  fs::remove_file(&claim_path)
    .map_err(|error| format!("{label} cleanup claim cannot be removed: {error}"))?;
  Ok(())
}

#[cfg(test)]
fn remove_control_snapshot_cas_with_hook<F>(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
  after_precheck: F,
) -> Result<(), String>
where
  F: FnOnce(),
{
  remove_control_snapshot_cas_with_hooks(
    canonical_workbench,
    control_root,
    target,
    label,
    max_bytes,
    expected,
    after_precheck,
    || {},
  )
}

fn remove_control_snapshot_cas(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: &ControlFileSnapshot,
) -> Result<(), String> {
  remove_control_snapshot_cas_with_hooks(
    canonical_workbench,
    control_root,
    target,
    label,
    max_bytes,
    expected,
    || {},
    || {},
  )
}

fn publish_control_bytes_with_hook<F>(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: Option<&ControlFileSnapshot>,
  bytes: &[u8],
  before_target_quarantine: F,
) -> Result<(), String>
where
  F: FnOnce(),
{
  if bytes.len() > max_bytes {
    return Err(format!(
      "{label} exceeds the {max_bytes}-byte limit: {}",
      target.display()
    ));
  }
  let file_name = target
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| format!("{label} has an invalid filename: {}", target.display()))?;
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    control_root,
    "state",
    "Workbench state root",
  )?;
  assert_no_control_preimage(control_root, file_name, label)?;

  let suffix = control_temp_suffix();
  let temp = control_root.join(format!(".{file_name}.{suffix}.tmp"));
  let mut preimage: Option<(PathBuf, ControlFileSnapshot)> = None;
  let mut installed = false;
  let mut installed_snapshot: Option<ControlFileSnapshot> = None;
  let mut temp_snapshot: Option<ControlFileSnapshot> = None;
  let operation = (|| -> Result<(), String> {
    assert_direct_workbench_root_unchanged(
      canonical_workbench,
      control_root,
      "state",
      "Workbench state root",
    )?;
    let current = if path_entry_exists(target, label)? {
      Some(read_bounded_control(target, label, max_bytes)?)
    } else {
      None
    };
    let expected_matches = match (expected, current.as_ref()) {
      (None, None) => true,
      (Some(expected), Some(current)) => expected == current,
      _ => false,
    };
    if !expected_matches {
      return Err(format!("{label} changed before commit"));
    }

    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temp)
      .map_err(|error| format!("{label} temp cannot be created ({}): {error}", temp.display()))?;
    file
      .write_all(bytes)
      .and_then(|_| file.sync_all())
      .map_err(|error| format!("{label} temp cannot be written ({}): {error}", temp.display()))?;
    drop(file);
    let verified_temp = read_bounded_control(&temp, &format!("{label} temp"), max_bytes)?;
    if verified_temp.bytes != bytes {
      return Err(format!("{label} temp verification failed"));
    }
    temp_snapshot = Some(verified_temp.clone());

    assert_direct_workbench_root_unchanged(
      canonical_workbench,
      control_root,
      "state",
      "Workbench state root",
    )?;
    if let Some(expected) = expected {
      let live = read_bounded_control(target, label, max_bytes)?;
      if live != *expected {
        return Err(format!("{label} changed before preimage commit"));
      }
      let preimage_path = control_root.join(format!("{file_name}.preimage-{suffix}"));
      fs::hard_link(target, &preimage_path).map_err(|error| {
        format!(
          "{label} preimage cannot be claimed exclusively ({}): {error}",
          preimage_path.display()
        )
      })?;
      let claim = (|| -> Result<(ControlFileSnapshot, ControlFileSnapshot), String> {
        let linked_target = read_linked_control(target, label, max_bytes, 2)?;
        let linked_preimage = read_linked_control(
          &preimage_path,
          &format!("{label} preimage"),
          max_bytes,
          2,
        )?;
        Ok((linked_target, linked_preimage))
      })();
      let (linked_target, linked_preimage) = match claim {
        Ok(claim) => claim,
        Err(error) => {
          let _ = fs::remove_file(&preimage_path);
          return Err(format!("{label} preimage claim was contended: {error}"));
        }
      };
      if !same_moved_control(expected, &linked_target)
        || !same_moved_control(expected, &linked_preimage)
        || !same_moved_control(&linked_target, &linked_preimage)
      {
        let _ = fs::remove_file(&preimage_path);
        return Err(format!("{label} changed during preimage claim"));
      }
      preimage = Some((preimage_path.clone(), linked_preimage));
      let final_target = read_linked_control(target, label, max_bytes, 2)?;
      let final_preimage = read_linked_control(
        &preimage_path,
        &format!("{label} preimage"),
        max_bytes,
        2,
      )?;
      if !same_moved_control(expected, &final_target)
        || !same_moved_control(expected, &final_preimage)
        || !same_moved_control(&final_target, &final_preimage)
      {
        return Err(format!("{label} changed before target quarantine"));
      }
      before_target_quarantine();
      match remove_canonical_control_preserving_replacement(
        canonical_workbench,
        control_root,
        target,
        label,
        max_bytes,
        &final_target,
      )? {
        CanonicalRemovalOutcome::RemovedExpected => {}
        CanonicalRemovalOutcome::Missing => {
          return Err(format!("{label} disappeared before target quarantine"))
        }
        CanonicalRemovalOutcome::ForeignRestored => {
          if remove_control_path_if_same(
            &preimage_path,
            &format!("{label} preimage"),
            max_bytes,
            &final_preimage,
          )? {
            preimage = None;
          }
          return Err(format!(
            "{label} foreign replacement was preserved before publish"
          ));
        }
      }
      let single_preimage = read_bounded_control(
        &preimage_path,
        &format!("{label} preimage"),
        max_bytes,
      )?;
      if !same_moved_control(expected, &single_preimage) {
        return Err(format!("{label} preimage changed after target quarantine"));
      }
      preimage = Some((preimage_path, single_preimage));
    }

    fs::hard_link(&temp, target).map_err(|error| {
      format!(
        "{label} exclusive install failed ({}): {error}",
        target.display()
      )
    })?;
    installed = true;
    let linked_target = read_linked_control(target, label, max_bytes, 2)?;
    let linked_temp = read_linked_control(&temp, &format!("{label} temp"), max_bytes, 2)?;
    if !same_moved_control(&verified_temp, &linked_target)
      || !same_moved_control(&verified_temp, &linked_temp)
      || !same_moved_control(&linked_target, &linked_temp)
    {
      return Err(format!("{label} temp identity changed during exclusive install"));
    }
    installed_snapshot = Some(linked_target);
    fs::remove_file(&temp)
      .map_err(|error| format!("{label} temp unlink failed ({}): {error}", temp.display()))?;
    let committed = read_bounded_control(target, label, max_bytes)?;
    if committed.bytes != bytes || !same_moved_control(&verified_temp, &committed) {
      return Err(format!("{label} commit verification failed"));
    }
    installed_snapshot = Some(committed);
    if let Some((preimage_path, expected_preimage)) = preimage.as_ref() {
      let live_preimage = read_bounded_control(
        preimage_path,
        &format!("{label} preimage"),
        max_bytes,
      )?;
      if !same_moved_control(expected_preimage, &live_preimage) {
        return Err(format!("{label} preimage changed before cleanup"));
      }
      fs::remove_file(preimage_path).map_err(|error| {
        format!(
          "{label} preimage cleanup failed ({}): {error}",
          preimage_path.display()
        )
      })?;
      preimage = None;
    }
    installed = false;
    installed_snapshot = None;
    temp_snapshot = None;
    Ok(())
  })();

  let result = if let Err(error) = operation {
    let mut recovery_errors = Vec::new();
    let mut foreign_preserved = false;
    if installed {
      if let Some(expected_install) = installed_snapshot.as_ref() {
        match remove_canonical_control_preserving_replacement(
          canonical_workbench,
          control_root,
          target,
          label,
          max_bytes,
          expected_install,
        ) {
          Ok(CanonicalRemovalOutcome::RemovedExpected | CanonicalRemovalOutcome::Missing) => {
            installed = false
          }
          Ok(CanonicalRemovalOutcome::ForeignRestored) => {
            installed = false;
            foreign_preserved = true;
            recovery_errors.push(
              "installed target changed after verification; foreign replacement was restored"
                .to_string(),
            );
          }
          Err(cause) => recovery_errors.push(cause),
        }
      } else {
        recovery_errors.push(
          "installed target could not be identity-verified; target and preimage were retained"
            .to_string(),
        );
      }
    }
    if let Some((moved_path, moved_snapshot)) = preimage.as_ref() {
      if foreign_preserved {
        match remove_control_path_if_same(
          moved_path,
          &format!("{label} preimage"),
          max_bytes,
          moved_snapshot,
        ) {
          Ok(true) => {}
          Ok(false) => recovery_errors.push(format!(
            "old preimage changed and was retained at {}",
            moved_path.display()
          )),
          Err(cause) => recovery_errors.push(cause),
        }
      } else if !installed && !path_entry_exists(target, label).unwrap_or(true) {
        if let Err(cause) = restore_control_preimage(
          target,
          moved_path,
          label,
          max_bytes,
          moved_snapshot,
        ) {
          recovery_errors.push(cause);
        }
      } else {
        recovery_errors.push(format!(
          "exact preimage retained at {} because the target is occupied",
          moved_path.display()
        ));
      }
    }
    if let Some(expected_temp) = temp_snapshot.as_ref() {
      match remove_control_path_if_same(
        &temp,
        &format!("{label} temp"),
        max_bytes,
        expected_temp,
      ) {
        Ok(true) => {}
        Ok(false) => recovery_errors.push(format!(
          "{label} temp changed and was retained at {}",
          temp.display()
        )),
        Err(cause) => recovery_errors.push(cause),
      }
    }
    if recovery_errors.is_empty() {
      Err(error)
    } else {
      Err(format!(
        "{error}; recovery requires attention: {}",
        recovery_errors.join("; ")
      ))
    }
  } else {
    Ok(())
  };
  result
}

fn publish_control_bytes(
  canonical_workbench: &Path,
  control_root: &Path,
  target: &Path,
  label: &str,
  max_bytes: usize,
  expected: Option<&ControlFileSnapshot>,
  bytes: &[u8],
) -> Result<(), String> {
  publish_control_bytes_with_hook(
    canonical_workbench,
    control_root,
    target,
    label,
    max_bytes,
    expected,
    bytes,
    || {},
  )
}

struct JsonControlDocument {
  canonical_workbench: PathBuf,
  state_root: PathBuf,
  target: PathBuf,
  snapshot: Option<ControlFileSnapshot>,
  object: serde_json::Map<String, serde_json::Value>,
}

fn load_json_control_with_limit(
  workbench: &Path,
  file_name: &str,
  label: &str,
  create_state: bool,
  create_document: bool,
  max_bytes: usize,
) -> Result<Option<JsonControlDocument>, String> {
  let (canonical_workbench, state_root) =
    validate_direct_workbench_root(workbench, "state", "Workbench state root", create_state)?;
  assert_no_control_preimage(&state_root, file_name, label)?;
  let target = state_root.join(file_name);
  let snapshot = if path_entry_exists(&target, label)? {
    Some(read_bounded_control(&target, label, max_bytes)?)
  } else if create_document {
    None
  } else {
    return Ok(None);
  };
  let value = match snapshot.as_ref() {
    Some(snapshot) => serde_json::from_str::<serde_json::Value>(&snapshot.text)
      .map_err(|error| format!("{label} is malformed ({}): {error}", target.display()))?,
    None => serde_json::Value::Object(serde_json::Map::new()),
  };
  let object = value
    .as_object()
    .cloned()
    .ok_or_else(|| format!("{label} must be a JSON object: {}", target.display()))?;
  Ok(Some(JsonControlDocument {
    canonical_workbench,
    state_root,
    target,
    snapshot,
    object,
  }))
}

fn load_json_control(
  workbench: &Path,
  file_name: &str,
  label: &str,
  create_state: bool,
  create_document: bool,
) -> Result<Option<JsonControlDocument>, String> {
  load_json_control_with_limit(
    workbench,
    file_name,
    label,
    create_state,
    create_document,
    MAX_STATE_CONTROL_BYTES,
  )
}

fn commit_json_control(
  document: JsonControlDocument,
  label: &str,
) -> Result<(), String> {
  let mut bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(document.object))
    .map_err(|error| format!("{label} cannot be serialized: {error}"))?;
  bytes.push(b'\n');
  publish_control_bytes(
    &document.canonical_workbench,
    &document.state_root,
    &document.target,
    label,
    MAX_STATE_CONTROL_BYTES,
    document.snapshot.as_ref(),
    &bytes,
  )
}

fn validate_orchestrator_state_object(
  object: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
  for key in ["activeRunId", "lastRunId"] {
    if let Some(value) = object.get(key) {
      if !value.is_null() && value.as_str().is_none() {
        return Err(format!("Orchestrator state {key} is invalid"));
      }
      if let Some(run_id) = value.as_str() {
        validate_run_id(run_id)?;
      }
    }
  }
  if let Some(value) = object.get("activeRunStatus") {
    if !value.is_null()
      && !matches!(
        value.as_str(),
        Some("idle" | "running" | "done" | "failed" | "blocked" | "stall")
      )
    {
      return Err("Orchestrator state activeRunStatus is invalid".to_string());
    }
  }
  if let Some(value) = object.get("updatedAt") {
    if value.as_str().is_none() {
      return Err("Orchestrator state updatedAt is invalid".to_string());
    }
  }
  Ok(())
}

fn read_manifest_meta(path: &Path) -> Result<RunManifestMeta, String> {
  read_manifest_document(path).map(|(meta, _)| meta)
}

fn read_manifest_document(
  path: &Path,
) -> Result<(RunManifestMeta, ControlFileSnapshot), String> {
  let snapshot = read_bounded_control(path, "Run manifest", MAX_RUN_MANIFEST_BYTES)?;
  let meta = serde_json::from_str(&snapshot.text)
    .map_err(|error| format!("Run manifest is invalid: {error}"))?;
  Ok((meta, snapshot))
}

fn write_orchestrator_status(root: &Path, run_id: &str, status: &str) -> Result<(), String> {
  validate_run_id(run_id)?;
  if !matches!(status, "idle" | "running" | "done" | "failed" | "blocked" | "stall") {
    return Err(format!("invalid orchestrator status: {status}"));
  }
  let mut document = load_json_control(
    root,
    "orchestrator.json",
    "Orchestrator state",
    true,
    true,
  )?
  .expect("create_document always returns a document");
  validate_orchestrator_state_object(&document.object)?;
  document.object.insert(
    "activeRunId".to_string(),
    serde_json::Value::String(run_id.to_string()),
  );
  document.object.insert(
    "activeRunStatus".to_string(),
    serde_json::Value::String(status.to_string()),
  );
  document.object.insert(
    "lastRunId".to_string(),
    serde_json::Value::String(run_id.to_string()),
  );
  document.object.insert(
    "updatedAt".to_string(),
    serde_json::Value::String(iso_now()),
  );
  commit_json_control(document, "Orchestrator state")
}

fn iso_from_unix(seconds: u64, milliseconds: u32) -> String {
  let seconds = seconds.min(i64::MAX as u64) as i64;
  let days = seconds / 86_400;
  let seconds_of_day = seconds % 86_400;
  let shifted = days + 719_468;
  let era = shifted / 146_097;
  let day_of_era = shifted - era * 146_097;
  let year_of_era =
    (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096)
      / 365;
  let mut year = year_of_era + era * 400;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_prime = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
  let month = month_prime + if month_prime < 10 { 3 } else { -9 };
  if month <= 2 {
    year += 1;
  }
  let hour = seconds_of_day / 3_600;
  let minute = (seconds_of_day % 3_600) / 60;
  let second = seconds_of_day % 60;
  format!(
    "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z"
  )
}

fn iso_now() -> String {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or(Duration::ZERO);
  iso_from_unix(now.as_secs(), now.subsec_millis())
}

fn tail_text_lines(content: &str, max_lines: usize) -> Vec<String> {
  let mut lines: Vec<&str> = content.lines().collect();
  if lines.len() > max_lines {
    lines = lines.split_off(lines.len() - max_lines);
  }
  lines.into_iter().map(str::to_string).collect()
}

fn heartbeat_stale(run_dir: &Path, stale_secs: u64) -> bool {
  let heartbeat = run_dir.join("heartbeat.json");
  if !heartbeat.is_file() {
    return true;
  }
  let Ok(meta) = fs::metadata(&heartbeat) else {
    return true;
  };
  let Ok(modified) = meta.modified() else {
    return true;
  };
  modified
    .elapsed()
    .map(|d| d > Duration::from_secs(stale_secs))
    .unwrap_or(true)
}

fn kill_active_child(runtime: &OrchestratorRuntime) -> Result<Option<String>, String> {
  let mut guard = runtime.child.lock().expect("child lock");
  let run_id = runtime
    .active_run_id
    .lock()
    .expect("run id lock")
    .clone();
  if let Some(mut child) = guard.take() {
    if let Err(error) = terminate_and_reap_child(&mut child) {
      *guard = Some(child);
      return Err(error);
    }
  }
  *runtime.active_run_id.lock().expect("run id lock") = None;
  *runtime.started_at.lock().expect("started lock") = None;
  *runtime.manifest_path.lock().expect("manifest lock") = None;
  Ok(run_id)
}

fn parse_node_version(raw: &str) -> Result<(u64, u64, u64), String> {
  let normalized = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
  let mut parts = normalized.split('.');
  let parse_part = |value: Option<&str>, label: &str| -> Result<u64, String> {
    let numeric = value
      .unwrap_or_default()
      .split(|character: char| !character.is_ascii_digit())
      .next()
      .unwrap_or_default();
    numeric
      .parse::<u64>()
      .map_err(|_| format!("invalid Node.js {label} version: {raw}"))
  };
  let major = parse_part(parts.next(), "major")?;
  let minor = parse_part(parts.next(), "minor")?;
  let patch = parse_part(parts.next(), "patch")?;
  Ok((major, minor, patch))
}

fn node_version_supported(version: (u64, u64, u64)) -> bool {
  version.0 > MIN_NODE_MAJOR || (version.0 == MIN_NODE_MAJOR && version.1 >= MIN_NODE_MINOR)
}

fn executable_names(name: &str) -> Vec<OsString> {
  #[cfg(target_os = "windows")]
  {
    vec![OsString::from(format!("{name}.exe")), OsString::from(name)]
  }
  #[cfg(not(target_os = "windows"))]
  {
    vec![OsString::from(name)]
  }
}

fn executable_candidates_on_path(name: &str, search_path: Option<&OsStr>) -> Vec<PathBuf> {
  let Some(search_path) = search_path else {
    return vec![];
  };
  let names = executable_names(name);
  let mut candidates = vec![];
  for directory in env::split_paths(search_path) {
    for file_name in &names {
      let candidate = directory.join(file_name);
      if candidate.is_file() && !candidates.contains(&candidate) {
        candidates.push(candidate);
      }
    }
  }
  candidates
}

fn configured_executable(variable: &str, label: &str) -> Result<Option<PathBuf>, String> {
  let Some(value) = env::var_os(variable) else {
    return Ok(None);
  };
  if value.to_string_lossy().trim().is_empty() {
    return Err(format!("{variable} is set but empty; configure an absolute {label} path"));
  }
  let path = PathBuf::from(value);
  if !path.is_file() {
    return Err(format!("{variable} does not point to a {label} executable: {}", path.display()));
  }
  Ok(Some(path))
}

fn inspect_node_binary(binary: &Path) -> Result<String, String> {
  let output = Command::new(binary)
    .arg("--version")
    .output()
    .map_err(|error| format!("could not execute {}: {error}", binary.display()))?;
  if !output.status.success() {
    return Err(format!(
      "{} --version exited with {}",
      binary.display(),
      output.status
    ));
  }
  let version_text = String::from_utf8(output.stdout)
    .map_err(|_| format!("{} returned a non-UTF-8 version", binary.display()))?;
  let version = parse_node_version(&version_text)?;
  if !node_version_supported(version) {
    return Err(format!(
      "Node.js {} is too old; Juno requires >= {MIN_NODE_MAJOR}.{MIN_NODE_MINOR}.0",
      version_text.trim()
    ));
  }
  Ok(version_text.trim().to_string())
}

fn resolve_node_binary() -> Result<PathBuf, String> {
  if let Some(configured) = configured_executable("JUNO_NODE_PATH", "Node.js")? {
    inspect_node_binary(&configured).map_err(|error| format!("JUNO_NODE_PATH is unusable: {error}"))?;
    return Ok(configured);
  }

  let mut candidates = vec![];
  #[cfg(target_os = "windows")]
  {
    candidates.push(PathBuf::from(r"C:\nvm4w\nodejs\node.exe"));
    candidates.push(PathBuf::from(r"D:\nvm\node.exe"));
  }
  candidates.extend(executable_candidates_on_path(
    "node",
    env::var_os("PATH").as_deref(),
  ));
  let mut failures = vec![];
  for candidate in candidates {
    if !candidate.is_file() {
      continue;
    }
    match inspect_node_binary(&candidate) {
      Ok(_) => return Ok(candidate),
      Err(error) => failures.push(error),
    }
  }
  let detail = if failures.is_empty() {
    "no node executable was found on PATH".to_string()
  } else {
    failures.join("; ")
  };
  Err(format!(
    "Juno requires Node.js >= {MIN_NODE_MAJOR}.{MIN_NODE_MINOR}.0. Install Node.js or set JUNO_NODE_PATH to node(.exe): {detail}"
  ))
}

fn inspect_codex_binary(binary: &Path) -> Result<String, String> {
  let output = Command::new(binary)
    .arg("--version")
    .output()
    .map_err(|error| format!("could not execute {}: {error}", binary.display()))?;
  if !output.status.success() {
    return Err(format!(
      "{} --version exited with {}",
      binary.display(),
      output.status
    ));
  }
  let version_text = String::from_utf8(output.stdout)
    .map_err(|_| format!("{} returned a non-UTF-8 version", binary.display()))?;
  if !version_text.trim().starts_with("codex-cli ") {
    return Err(format!(
      "{} did not identify itself as codex-cli: {}",
      binary.display(),
      version_text.trim()
    ));
  }
  Ok(version_text.trim().to_string())
}

fn known_codex_candidates() -> Vec<PathBuf> {
  let mut candidates = vec![];
  let codex_home = env::var_os("CODEX_HOME")
    .map(PathBuf::from)
    .or_else(|| env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".codex")))
    .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")));
  if let Some(codex_home) = codex_home {
    for file_name in executable_names("codex") {
      candidates.push(codex_home.join(".sandbox-bin").join(file_name));
    }
  }
  #[cfg(target_os = "windows")]
  if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
    let versions_root = PathBuf::from(local_app_data).join("OpenAI/Codex/bin");
    if let Ok(entries) = fs::read_dir(versions_root) {
      let mut version_directories: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|entry| entry.is_dir())
        .collect();
      version_directories.sort();
      version_directories.reverse();
      candidates.extend(
        version_directories
          .into_iter()
          .map(|directory| directory.join("codex.exe")),
      );
    }
  }
  candidates.extend(executable_candidates_on_path(
    "codex",
    env::var_os("PATH").as_deref(),
  ));
  candidates
}

fn resolve_codex_binary() -> Result<PathBuf, String> {
  if let Some(configured) = configured_executable("JUNO_CODEX_PATH", "Codex CLI")? {
    inspect_codex_binary(&configured)
      .map_err(|error| format!("JUNO_CODEX_PATH is unusable: {error}"))?;
    return Ok(configured);
  }

  let mut failures = vec![];
  let mut inspected = vec![];
  for candidate in known_codex_candidates() {
    if !candidate.is_file() || inspected.contains(&candidate) {
      continue;
    }
    inspected.push(candidate.clone());
    match inspect_codex_binary(&candidate) {
      Ok(_) => return Ok(candidate),
      Err(error) => failures.push(error),
    }
  }
  let detail = if failures.is_empty() {
    "no codex executable was found".to_string()
  } else {
    failures.join("; ")
  };
  Err(format!(
    "Juno requires an executable Codex CLI for live runs. Install Codex CLI or set JUNO_CODEX_PATH to codex(.exe): {detail}"
  ))
}

fn scheduler_daemon_script() -> PathBuf {
  juno_project_root().join("scripts/run-juno-daemon.mjs")
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
  let chars: Vec<char> = run_id.chars().collect();
  if chars.is_empty() || chars.len() > 128 {
    return Err("invalid run id".to_string());
  }
  if !chars[0].is_alphanumeric()
    || !chars[chars.len() - 1].is_alphanumeric()
    || !chars
      .iter()
      .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    || windows_reserved_run_id(run_id)
  {
    return Err("invalid run id".to_string());
  }
  Ok(())
}

fn windows_reserved_run_id(run_id: &str) -> bool {
  let stem = run_id.split('.').next().unwrap_or_default().to_lowercase();
  if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") {
    return true;
  }
  for prefix in ["com", "lpt"] {
    if let Some(suffix) = stem.strip_prefix(prefix) {
      return matches!(
        suffix,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "\u{b9}" | "\u{b2}" | "\u{b3}"
      );
    }
  }
  false
}

fn validate_direct_run_directory(
  canonical_workbench: &Path,
  runs_root: &Path,
  run_id: &str,
) -> Result<Option<PathBuf>, String> {
  validate_run_id(run_id)?;
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    runs_root,
    "runs",
    "Workbench runs root",
  )?;
  let lexical = runs_root.join(run_id);
  let metadata = match fs::symlink_metadata(&lexical) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      assert_direct_workbench_root_unchanged(
        canonical_workbench,
        runs_root,
        "runs",
        "Workbench runs root",
      )?;
      return Ok(None);
    }
    Err(error) => {
      return Err(format!(
        "run directory is unavailable ({}): {error}",
        lexical.display()
      ))
    }
  };
  if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
    return Err(format!(
      "run directory must be a direct non-link Workbench runs child: {}",
      lexical.display()
    ));
  }
  let canonical = fs::canonicalize(&lexical)
    .map_err(|error| format!("run directory cannot be canonicalized: {error}"))?;
  if !same_path(&canonical, &lexical)
    || canonical
      .parent()
      .map(|parent| same_path(parent, runs_root))
      != Some(true)
  {
    return Err(
      "run directory must be a direct child of the active Workbench runs directory".to_string(),
    );
  }
  assert_direct_workbench_root_unchanged(
    canonical_workbench,
    runs_root,
    "runs",
    "Workbench runs root",
  )?;
  Ok(Some(canonical))
}

fn validate_spawn_manifest_at(
  workbench: &Path,
  supplied: &Path,
) -> Result<(PathBuf, RunManifestMeta, ControlFileSnapshot), String> {
  if supplied.file_name() != Some(OsStr::new("manifest.json")) {
    return Err("run manifest basename must be exactly manifest.json".to_string());
  }
  let (canonical_workbench, runs_root) =
    validate_direct_workbench_root(workbench, "runs", "Workbench runs root", false)?;
  let supplied_parent = supplied
    .parent()
    .ok_or_else(|| format!("run manifest has no parent directory: {}", supplied.display()))?;
  let directory_run_id = supplied_parent
    .file_name()
    .and_then(OsStr::to_str)
    .ok_or_else(|| "run manifest directory name is invalid".to_string())?;
  let run_dir = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    directory_run_id,
  )?
  .ok_or_else(|| format!("manifest not found: {}", supplied.display()))?;
  let expected_manifest = run_dir.join("manifest.json");
  let absolute_supplied = if supplied.is_absolute() {
    supplied.to_path_buf()
  } else {
    env::current_dir()
      .map_err(|error| format!("current directory is unavailable: {error}"))?
      .join(supplied)
  };
  if !same_path(&absolute_supplied, &expected_manifest) {
    return Err(
      "manifest path must lexically equal the direct Workbench run manifest path".to_string(),
    );
  }

  let supplied_metadata = fs::symlink_metadata(supplied)
    .map_err(|error| format!("manifest not found ({}): {error}", supplied.display()))?;
  if !supplied_metadata.file_type().is_file() || supplied_metadata.file_type().is_symlink() {
    return Err(format!(
      "Run manifest must be a regular non-link file: {}",
      supplied.display()
    ));
  }
  let canonical_supplied = fs::canonicalize(supplied)
    .map_err(|error| format!("Run manifest cannot be canonicalized: {error}"))?;
  if !same_path(&canonical_supplied, &expected_manifest) {
    return Err("manifest must be the canonical manifest.json of a direct Workbench run".to_string());
  }

  let (meta, snapshot) = read_manifest_document(&expected_manifest)?;
  validate_run_id(&meta.run_id)?;
  if meta.run_id != directory_run_id {
    return Err("manifest runId must match its Workbench run directory".to_string());
  }
  if !(1..=MAX_RUN_MINUTES).contains(&meta.max_minutes) {
    return Err(format!(
      "Run manifest maxMinutes must be between 1 and {MAX_RUN_MINUTES}"
    ));
  }

  assert_direct_workbench_root_unchanged(
    &canonical_workbench,
    &runs_root,
    "runs",
    "Workbench runs root",
  )?;
  let observed_run = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    directory_run_id,
  )?
  .ok_or_else(|| "run directory changed while reading its manifest".to_string())?;
  if !same_path(&observed_run, &run_dir) {
    return Err("run directory changed while reading its manifest".to_string());
  }
  Ok((expected_manifest, meta, snapshot))
}

#[cfg(test)]
fn resolve_run_artifact_path(
  workbench: &Path,
  run_id: &str,
  artifact_name: &str,
) -> Result<PathBuf, String> {
  validate_run_id(run_id)?;
  let mut components = Path::new(artifact_name).components();
  let artifact_component = match (components.next(), components.next()) {
    (Some(std::path::Component::Normal(component)), None) => component,
    _ => return Err("run artifact name must be one normal path component".to_string()),
  };
  let (canonical_workbench, runs_root) =
    validate_direct_workbench_root(workbench, "runs", "Workbench runs root", false)?;
  let lexical_run_dir = runs_root.join(run_id);
  let Some(run_dir) = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    run_id,
  )? else {
    return Ok(lexical_run_dir.join(artifact_component));
  };

  let artifact = run_dir.join(artifact_component);
  let metadata = match fs::symlink_metadata(&artifact) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      let observed = validate_direct_run_directory(
        &canonical_workbench,
        &runs_root,
        run_id,
      )?
      .ok_or_else(|| "run directory changed while resolving its artifact".to_string())?;
      if !same_path(&observed, &run_dir) {
        return Err("run directory changed while resolving its artifact".to_string());
      }
      return Ok(artifact);
    }
    Err(error) => return Err(format!("run artifact is unavailable: {error}")),
  };
  if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
    return Err(format!(
      "run artifact must be a regular non-link file: {}",
      artifact.display()
    ));
  }
  let canonical_artifact = fs::canonicalize(&artifact).map_err(|error| error.to_string())?;
  if !same_path(&canonical_artifact, &artifact)
    || canonical_artifact
      .parent()
      .map(|parent| same_path(parent, &run_dir))
      != Some(true)
  {
    return Err("run artifact resolves outside its Workbench run directory".to_string());
  }
  let observed = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    run_id,
  )?
  .ok_or_else(|| "run directory changed while resolving its artifact".to_string())?;
  if !same_path(&observed, &run_dir) {
    return Err("run directory changed while resolving its artifact".to_string());
  }
  Ok(canonical_artifact)
}

fn read_run_event_tail_at_with_hook<F>(
  workbench: &Path,
  run_id: &str,
  max_lines: usize,
  after_open: F,
) -> Result<Vec<String>, String>
where
  F: FnOnce(),
{
  validate_run_id(run_id)?;
  let (canonical_workbench, runs_root) =
    validate_direct_workbench_root(workbench, "runs", "Workbench runs root", false)?;
  let Some(run_dir) = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    run_id,
  )? else {
    return Ok(vec![]);
  };
  let events_path = run_dir.join("events.jsonl");
  if !path_entry_exists(&events_path, "Run events")? {
    return Ok(vec![]);
  }
  let before = fs::symlink_metadata(&events_path)
    .map_err(|error| format!("Run events are unavailable ({}): {error}", events_path.display()))?;
  if !before.file_type().is_file() || before.file_type().is_symlink() {
    return Err(format!(
      "Run events must be a regular file: {}",
      events_path.display()
    ));
  }
  assert_stable_parent(&events_path, "Run events")?;

  let mut file = fs::File::open(&events_path)
    .map_err(|error| format!("Run events are unavailable ({}): {error}", events_path.display()))?;
  let opened = control_file_identity(&file).map_err(|error| {
    format!(
      "Run events identity is unavailable ({}): {error}",
      events_path.display()
    )
  })?;
  if opened.links != 1 {
    return Err(format!(
      "Run events must be an exclusive regular file: {}",
      events_path.display()
    ));
  }

  after_open();
  let window_start = opened.size.saturating_sub(MAX_RUN_EVENTS_BYTES as u64);
  let read_start = window_start.saturating_sub(1);
  let read_len = opened.size.saturating_sub(read_start);
  file
    .seek(SeekFrom::Start(read_start))
    .map_err(|error| format!("Run events cannot be seeked ({}): {error}", events_path.display()))?;
  let mut bytes = Vec::with_capacity(read_len as usize);
  Read::by_ref(&mut file)
    .take(read_len)
    .read_to_end(&mut bytes)
    .map_err(|error| format!("Run events cannot be read ({}): {error}", events_path.display()))?;
  if bytes.len() as u64 != read_len {
    return Err(format!(
      "Run events changed while reading: {}",
      events_path.display()
    ));
  }

  let after_handle = control_file_identity(&file).map_err(|error| {
    format!(
      "Run events identity is unavailable ({}): {error}",
      events_path.display()
    )
  })?;
  let after_path = fs::symlink_metadata(&events_path).map_err(|error| {
    format!(
      "Run events changed while reading ({}): {error}",
      events_path.display()
    )
  })?;
  if !after_path.file_type().is_file() || after_path.file_type().is_symlink() {
    return Err(format!(
      "Run events changed while reading: {}",
      events_path.display()
    ));
  }
  assert_stable_parent(&events_path, "Run events")?;
  let verifier = fs::File::open(&events_path).map_err(|error| {
    format!(
      "Run events changed while reading ({}): {error}",
      events_path.display()
    )
  })?;
  let after_name = control_file_identity(&verifier).map_err(|error| {
    format!(
      "Run events identity is unavailable ({}): {error}",
      events_path.display()
    )
  })?;
  let final_path = fs::symlink_metadata(&events_path).map_err(|error| {
    format!(
      "Run events changed while reading ({}): {error}",
      events_path.display()
    )
  })?;
  if !final_path.file_type().is_file() || final_path.file_type().is_symlink() {
    return Err(format!(
      "Run events changed while reading: {}",
      events_path.display()
    ));
  }
  assert_stable_parent(&events_path, "Run events")?;
  if opened != after_handle
    || after_handle != after_name
    || after_handle.links != 1
    || after_path.len() != opened.size
    || final_path.len() != opened.size
  {
    return Err(format!(
      "Run events changed while reading: {}",
      events_path.display()
    ));
  }

  let tail = if window_start == 0 {
    bytes.as_slice()
  } else if bytes.first() == Some(&b'\n') {
    &bytes[1..]
  } else {
    let newline = bytes.iter().skip(1).position(|byte| *byte == b'\n')
      .map(|offset| offset + 1)
      .ok_or_else(|| {
        format!(
          "Run events contain a line exceeding the {MAX_RUN_EVENTS_BYTES}-byte tail window"
        )
      })?;
    &bytes[newline + 1..]
  };
  let text = String::from_utf8(tail.to_vec()).map_err(|error| {
    format!(
      "Run events are not readable UTF-8 ({}): {error}",
      events_path.display()
    )
  })?;
  let observed_run = validate_direct_run_directory(
    &canonical_workbench,
    &runs_root,
    run_id,
  )?
  .ok_or_else(|| "run directory changed while reading events".to_string())?;
  if !same_path(&observed_run, &run_dir) {
    return Err("run directory changed while reading events".to_string());
  }
  Ok(tail_text_lines(&text, max_lines))
}

fn read_run_event_tail_at(
  workbench: &Path,
  run_id: &str,
  max_lines: usize,
) -> Result<Vec<String>, String> {
  read_run_event_tail_at_with_hook(workbench, run_id, max_lines, || {})
}

fn process_is_alive(pid: u32) -> bool {
  let mut system = System::new();
  system.refresh_processes();
  system.process(Pid::from_u32(pid)).is_some()
}

fn command_is_juno_daemon(
  args: &[String],
  cwd: Option<&Path>,
  expected_script: &Path,
) -> bool {
  let Some(script_arg) = args.get(1) else {
    return false;
  };
  let script_path = Path::new(script_arg);
  let candidate = if script_path.is_absolute() {
    script_path.to_path_buf()
  } else {
    let Some(cwd) = cwd else {
      return false;
    };
    cwd.join(script_path)
  };
  let Ok(canonical_candidate) = fs::canonicalize(candidate) else {
    return false;
  };
  let Ok(canonical_expected) = fs::canonicalize(expected_script) else {
    return false;
  };
  canonical_candidate == canonical_expected
}

fn process_is_juno_daemon(pid: u32) -> bool {
  let mut system = System::new();
  system.refresh_processes();
  system
    .process(Pid::from_u32(pid))
    .map(|process| {
      command_is_juno_daemon(
        process.cmd(),
        process.cwd(),
        &scheduler_daemon_script(),
      )
    })
    .unwrap_or(false)
}

#[cfg(test)]
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(test)]
const HELPER_REAP_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(test)]
fn wait_for_child_exit_bounded(
  child: &mut Child,
  timeout: Duration,
) -> Result<Option<ExitStatus>, String> {
  let started = Instant::now();
  loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      return Ok(Some(status));
    }

    let elapsed = started.elapsed();
    if elapsed >= timeout {
      return Ok(None);
    }
    std::thread::sleep(PROCESS_POLL_INTERVAL.min(timeout - elapsed));
  }
}

#[cfg(test)]
fn wait_for_helper_bounded(
  child: &mut Child,
  label: &str,
  timeout: Duration,
) -> Result<ExitStatus, String> {
  if let Some(status) = wait_for_child_exit_bounded(child, timeout)
    .map_err(|e| format!("failed to poll {label}: {e}"))?
  {
    return Ok(status);
  }

  let helper_pid = child.id();
  let kill_error = child.kill().err();
  let reaped = wait_for_child_exit_bounded(child, HELPER_REAP_TIMEOUT)
    .map_err(|e| format!("{label} timed out and helper pid={helper_pid} could not be polled: {e}"))?;
  if reaped.is_none() {
    let kill_context = kill_error
      .map(|e| format!("; helper kill also failed: {e}"))
      .unwrap_or_default();
    return Err(format!(
      "{label} timed out after {}ms and helper pid={helper_pid} was not reaped{kill_context}; target termination is unconfirmed",
      timeout.as_millis()
    ));
  }

  Err(format!(
    "{label} timed out after {}ms; target termination is unconfirmed",
    timeout.as_millis()
  ))
}

#[cfg(target_os = "windows")]
fn terminate_windows_process(pid: u32) -> Result<(), String> {
  const PROCESS_TERMINATE: u32 = 0x0001;
  const SYNCHRONIZE: u32 = 0x0010_0000;
  const WAIT_OBJECT_0: u32 = 0;
  let handle = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid) };
  if handle.is_null() {
    if !process_is_alive(pid) {
      return Ok(());
    }
    return Err(format!(
      "process pid={pid} cannot be opened for termination: {}",
      std::io::Error::last_os_error()
    ));
  }

  let terminated = unsafe { TerminateProcess(handle, 1) };
  let terminate_error = (terminated == 0).then(std::io::Error::last_os_error);
  let wait_result = unsafe { WaitForSingleObject(handle, 3_000) };
  unsafe {
    CloseHandle(handle);
  }
  if wait_result == WAIT_OBJECT_0 {
    return Ok(());
  }
  if let Some(error) = terminate_error {
    return Err(format!("failed to terminate process pid={pid}: {error}"));
  }
  Err(format!(
    "process termination was not confirmed for pid={pid}"
  ))
}

fn terminate_process_tree(pid: u32) -> Result<(), String> {
  let root_pid = Pid::from_u32(pid);
  let mut system = System::new();
  system.refresh_processes();
  if system.process(root_pid).is_none() {
    return Ok(());
  }

  let mut ordered = vec![root_pid];
  let mut cursor = 0;
  while cursor < ordered.len() {
    let parent = ordered[cursor];
    for (candidate_pid, process) in system.processes() {
      if process.parent() == Some(parent) && !ordered.contains(candidate_pid) {
        ordered.push(*candidate_pid);
      }
    }
    cursor += 1;
  }
  if ordered
    .iter()
    .any(|candidate| candidate.as_u32() == std::process::id())
  {
    return Err("refusing to terminate the current desktop process".to_string());
  }
  for candidate in ordered.into_iter().rev() {
    #[cfg(target_os = "windows")]
    terminate_windows_process(candidate.as_u32())?;
    #[cfg(not(target_os = "windows"))]
    if let Some(process) = system.process(candidate) {
      if !process.kill() && process_is_alive(candidate.as_u32()) {
        return Err(format!(
          "failed to stop process-tree member pid={}",
          candidate.as_u32()
        ));
      }
    }
  }

  #[cfg(target_os = "windows")]
  return Ok(());

  #[cfg(not(target_os = "windows"))]
  for _ in 0..30 {
    if !process_is_alive(pid) {
      return Ok(());
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  #[cfg(not(target_os = "windows"))]
  return Err(format!("process tree did not exit pid={pid}"));
}

fn terminate_and_reap_child_with<F>(child: &mut Child, terminate: F) -> Result<(), String>
where
  F: FnOnce(u32) -> Result<(), String>,
{
  if child.try_wait().map_err(|e| e.to_string())?.is_some() {
    return Ok(());
  }
  let pid = child.id();
  terminate(pid)?;
  for _ in 0..30 {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
      return Ok(());
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  Err(format!("terminated child was not reaped pid={pid}"))
}

fn terminate_and_reap_child(child: &mut Child) -> Result<(), String> {
  terminate_and_reap_child_with(child, terminate_process_tree)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
  pub running: bool,
  pub pid: Option<u32>,
  pub enabled: bool,
  pub runs_today: u64,
  pub last_action: Option<String>,
  pub last_tick_at: Option<String>,
  pub daemon_started_at: Option<String>,
}

pub struct SchedulerDaemon {
  child: Mutex<Option<Child>>,
  lifecycle: Mutex<()>,
}

impl SchedulerDaemon {
  pub fn new() -> Self {
    Self {
      child: Mutex::new(None),
      lifecycle: Mutex::new(()),
    }
  }

  pub fn is_running(&self) -> bool {
    let mut guard = self.child.lock().expect("scheduler lock");
    if let Some(child) = guard.as_mut() {
      if let Ok(Some(_)) = child.try_wait() {
        *guard = None;
        return false;
      }
      return true;
    }
    false
  }
}

fn optional_control_string(
  object: &serde_json::Map<String, serde_json::Value>,
  key: &str,
  label: &str,
) -> Result<Option<String>, String> {
  match object.get(key) {
    None | Some(serde_json::Value::Null) => Ok(None),
    Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
    Some(_) => Err(format!("{label} {key} must be a string or null")),
  }
}

fn scheduler_state_started_at(document: &JsonControlDocument) -> Result<Option<String>, String> {
  let started_at = optional_control_string(
    &document.object,
    "startedAt",
    "Scheduler daemon state",
  )?;
  if started_at.as_deref().is_some_and(|value| {
    value.is_empty() || value.trim() != value || value.chars().any(char::is_control)
  }) {
    return Err("Scheduler daemon state startedAt must be a non-empty trimmed string".to_string());
  }
  Ok(started_at)
}

fn daemon_protocol_version(
  object: &serde_json::Map<String, serde_json::Value>,
  label: &str,
) -> Result<Option<u64>, String> {
  match object.get("protocolVersion") {
    None => Ok(None),
    Some(value) => {
      let version = value
        .as_u64()
        .ok_or_else(|| format!("{label} protocolVersion must be an unsigned integer"))?;
      if version != DAEMON_PROTOCOL_VERSION {
        return Err(format!("{label} protocolVersion {version} is unsupported"));
      }
      Ok(Some(version))
    }
  }
}

fn required_control_u64(
  object: &serde_json::Map<String, serde_json::Value>,
  key: &str,
  label: &str,
) -> Result<u64, String> {
  object
    .get(key)
    .and_then(serde_json::Value::as_u64)
    .filter(|value| *value > 0)
    .ok_or_else(|| format!("{label} {key} must be a positive unsigned integer"))
}

fn valid_uuid(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 36
    && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
    && bytes.iter().enumerate().all(|(index, byte)| {
      [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()
    })
    && matches!(bytes[14], b'1'..=b'5')
    && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DaemonV2Identity {
  generation: String,
  pid: u32,
  process_started_at: u64,
  workbench_root: String,
}

fn daemon_v2_identity(
  object: &serde_json::Map<String, serde_json::Value>,
  label: &str,
) -> Result<DaemonV2Identity, String> {
  if daemon_protocol_version(object, label)? != Some(DAEMON_PROTOCOL_VERSION) {
    return Err(format!("{label} is not a v2 control"));
  }
  let generation = optional_control_string(object, "generation", label)?
    .ok_or_else(|| format!("{label} generation is required"))?;
  if !valid_uuid(&generation) {
    return Err(format!("{label} generation must be a UUID"));
  }
  let pid_value = required_control_u64(object, "pid", label)?;
  let pid = u32::try_from(pid_value).map_err(|_| format!("{label} pid is out of range"))?;
  let process_started_at = required_control_u64(object, "processStartedAt", label)?;
  let workbench_root = optional_control_string(object, "workbenchRoot", label)?
    .ok_or_else(|| format!("{label} workbenchRoot is required"))?;
  if workbench_root.is_empty()
    || workbench_root.trim() != workbench_root
    || workbench_root.chars().any(char::is_control)
  {
    return Err(format!("{label} workbenchRoot must be a non-empty canonical path"));
  }
  Ok(DaemonV2Identity {
    generation,
    pid,
    process_started_at,
    workbench_root,
  })
}

fn parse_scheduler_pid(snapshot: &ControlFileSnapshot) -> Result<u32, String> {
  let text = snapshot.text.trim();
  if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
    return Err("Scheduler daemon PID must contain one decimal PID".to_string());
  }
  let pid = text
    .parse::<u32>()
    .map_err(|error| format!("Scheduler daemon PID is invalid: {error}"))?;
  if pid == 0 {
    return Err("Scheduler daemon PID must be greater than zero".to_string());
  }
  Ok(pid)
}

fn scheduler_state_status(document: &JsonControlDocument) -> Result<String, String> {
  let status = optional_control_string(
    &document.object,
    "status",
    "Scheduler daemon state",
  )?
  .ok_or_else(|| "Scheduler daemon state status is required".to_string())?;
  if !matches!(
    status.as_str(),
    "running" | "degraded" | "blocked" | "waiting_midnight" | "stopped"
  ) {
    return Err(format!("Scheduler daemon state status is invalid: {status}"));
  }
  Ok(status)
}

struct SchedulerControlSet {
  state: Option<JsonControlDocument>,
  lease: Option<JsonControlDocument>,
  pid_snapshot: Option<ControlFileSnapshot>,
  identity: Option<DaemonV2Identity>,
  legacy: bool,
}

fn document_snapshot(document: Option<&JsonControlDocument>) -> Option<&ControlFileSnapshot> {
  document.and_then(|document| document.snapshot.as_ref())
}

fn read_scheduler_control_set(root: &Path) -> Result<SchedulerControlSet, String> {
  let (canonical_workbench, state_root) =
    validate_direct_workbench_root(root, "state", "Workbench state root", false)?;
  let state_first = load_json_control(
    &canonical_workbench,
    "juno-daemon.json",
    "Scheduler daemon state",
    false,
    false,
  )?;
  let lease = load_json_control_with_limit(
    &canonical_workbench,
    "juno-daemon.lease.json",
    "Scheduler daemon lease",
    false,
    false,
    MAX_DAEMON_LEASE_BYTES,
  )?;
  let pid_path = state_root.join("juno-daemon.pid");
  let pid_snapshot = if path_entry_exists(&pid_path, "Scheduler daemon PID")? {
    Some(read_bounded_control(
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
    )?)
  } else {
    None
  };
  let state_second = load_json_control(
    &canonical_workbench,
    "juno-daemon.json",
    "Scheduler daemon state",
    false,
    false,
  )?;
  if document_snapshot(state_first.as_ref()) != document_snapshot(state_second.as_ref()) {
    return Err("Scheduler daemon state changed during state/lease/PID/state read".to_string());
  }

  let Some(state) = state_second else {
    if lease.is_some() {
      return Err("Scheduler daemon v2 lease is present without daemon state".to_string());
    }
    if let Some(snapshot) = pid_snapshot.as_ref() {
      let _ = parse_scheduler_pid(snapshot)?;
    }
    return Ok(SchedulerControlSet {
      state: None,
      lease: None,
      pid_snapshot,
      identity: None,
      legacy: true,
    });
  };

  let status = scheduler_state_status(&state)?;
  if daemon_protocol_version(&state.object, "Scheduler daemon state")?.is_none() {
    if lease.is_some() {
      return Err("Scheduler daemon v2 lease cannot be paired with legacy state".to_string());
    }
    if let Some(snapshot) = pid_snapshot.as_ref() {
      let _ = parse_scheduler_pid(snapshot)?;
    }
    return Ok(SchedulerControlSet {
      state: Some(state),
      lease: None,
      pid_snapshot,
      identity: None,
      legacy: true,
    });
  }

  let identity = daemon_v2_identity(&state.object, "Scheduler daemon state")?;
  if !same_path(Path::new(&identity.workbench_root), &canonical_workbench) {
    return Err("Scheduler daemon state is bound to a different Workbench".to_string());
  }
  match (lease.as_ref(), pid_snapshot.as_ref()) {
    (None, None) if matches!(status.as_str(), "blocked" | "stopped") => {}
    (None, None) => return Err("Enabled scheduler daemon v2 state has no lease".to_string()),
    (None, Some(_)) => {
      return Err("Scheduler daemon v2 state has a PID shadow without a lease".to_string())
    }
    (Some(_), None) => return Err("Scheduler daemon v2 lease has no PID shadow".to_string()),
    (Some(lease_document), Some(pid_document)) => {
      let lease_identity =
        daemon_v2_identity(&lease_document.object, "Scheduler daemon lease")?;
      if lease_identity != identity {
        return Err("Scheduler daemon state and lease generations do not match".to_string());
      }
      if !same_path(Path::new(&lease_identity.workbench_root), &canonical_workbench) {
        return Err("Scheduler daemon lease is bound to a different Workbench".to_string());
      }
      if parse_scheduler_pid(pid_document)? != identity.pid {
        return Err("Scheduler daemon PID shadow does not match the v2 lease".to_string());
      }
    }
  }
  assert_direct_workbench_root_unchanged(
    &canonical_workbench,
    &state_root,
    "state",
    "Workbench state root",
  )?;
  Ok(SchedulerControlSet {
    state: Some(state),
    lease,
    pid_snapshot,
    identity: Some(identity),
    legacy: false,
  })
}

fn scheduler_control_sets_match(
  left: &SchedulerControlSet,
  right: &SchedulerControlSet,
) -> bool {
  document_snapshot(left.state.as_ref()) == document_snapshot(right.state.as_ref())
    && document_snapshot(left.lease.as_ref()) == document_snapshot(right.lease.as_ref())
    && left.pid_snapshot == right.pid_snapshot
    && left.identity == right.identity
    && left.legacy == right.legacy
}

fn process_matches_daemon_v2(identity: &DaemonV2Identity) -> Result<bool, String> {
  let mut system = System::new();
  system.refresh_processes();
  let Some(process) = system.process(Pid::from_u32(identity.pid)) else {
    return Ok(false);
  };
  let observed_started_at = process.start_time().saturating_mul(1000);
  let start_matches = observed_started_at.abs_diff(identity.process_started_at) <= 2_000;
  if !start_matches
    || !command_is_juno_daemon(process.cmd(), process.cwd(), &scheduler_daemon_script())
  {
    return Err(format!(
      "Scheduler daemon lease pid={} does not match its process identity",
      identity.pid
    ));
  }
  Ok(true)
}

fn bind_scheduler_process_status(
  status: &mut SchedulerStatus,
  pid: u32,
  is_juno_daemon: bool,
) -> Result<(), String> {
  if !is_juno_daemon {
    return Ok(());
  }
  if !status.enabled {
    return Err(format!(
      "Scheduler daemon PID {pid} is live while daemon state is not enabled"
    ));
  }
  status.pid = Some(pid);
  status.running = true;
  Ok(())
}

fn get_scheduler_status_at(root: &Path) -> Result<SchedulerStatus, String> {
  let mut status = SchedulerStatus {
    running: false,
    pid: None,
    enabled: false,
    runs_today: 0,
    last_action: None,
    last_tick_at: None,
    daemon_started_at: None,
  };
  let (canonical_workbench, state_root) =
    validate_direct_workbench_root(root, "state", "Workbench state root", false)?;
  let controls = read_scheduler_control_set(&canonical_workbench)?;

  if let Some(document) = controls.state.as_ref() {
    let daemon_status = scheduler_state_status(document)?;
    status.enabled = matches!(
      daemon_status.as_str(),
      "running" | "degraded" | "waiting_midnight"
    );
    status.last_tick_at = optional_control_string(
      &document.object,
      "heartbeatAt",
      "Scheduler daemon state",
    )?;
    status.daemon_started_at = scheduler_state_started_at(document)?;
  }

  if let Some(document) = load_json_control(
    &canonical_workbench,
    "bounded-autonomy.json",
    "Bounded autonomy state",
    false,
    false,
  )? {
    status.runs_today = match document.object.get("iterationsToday") {
      None => 0,
      Some(value) => value.as_u64().ok_or_else(|| {
        "Bounded autonomy state iterationsToday must be an unsigned integer".to_string()
      })?,
    };
    status.last_action = optional_control_string(
      &document.object,
      "lastAction",
      "Bounded autonomy state",
    )?;
  }

  if let Some(snapshot) = controls.pid_snapshot.as_ref() {
    let pid = parse_scheduler_pid(snapshot)?;
    let is_daemon = if let Some(identity) = controls.identity.as_ref() {
      process_matches_daemon_v2(identity)?
    } else {
      process_is_juno_daemon(pid)
    };
    bind_scheduler_process_status(&mut status, pid, is_daemon)?;
  }

  assert_direct_workbench_root_unchanged(
    &canonical_workbench,
    &state_root,
    "state",
    "Workbench state root",
  )?;
  Ok(status)
}

pub fn get_scheduler_status() -> Result<SchedulerStatus, String> {
  get_scheduler_status_at(&workbench_root_path())
}

fn unix_time_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or(Duration::ZERO)
    .as_millis()
    .try_into()
    .unwrap_or(u64::MAX)
}

fn process_started_at_ms(pid: u32) -> Option<u64> {
  let mut system = System::new();
  system.refresh_processes();
  system
    .process(Pid::from_u32(pid))
    .map(|process| process.start_time().saturating_mul(1000))
}

fn daemon_lifecycle_token() -> String {
  let sequence = CONTROL_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
  let digest = Sha256::digest(
    format!("{}:{}:{sequence}", std::process::id(), unix_time_ms()).as_bytes(),
  );
  let hex = digest
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>();
  format!(
    "{}-{}-4{}-8{}-{}",
    &hex[0..8],
    &hex[8..12],
    &hex[13..16],
    &hex[17..20],
    &hex[20..32]
  )
}

struct DaemonLifecycleLockGuard {
  canonical_workbench: PathBuf,
  state_root: PathBuf,
  target: PathBuf,
  snapshot: ControlFileSnapshot,
  token: String,
}

impl Drop for DaemonLifecycleLockGuard {
  fn drop(&mut self) {
    let _ = remove_control_snapshot_cas(
      &self.canonical_workbench,
      &self.state_root,
      &self.target,
      "Scheduler daemon lifecycle lock",
      MAX_LIFECYCLE_LOCK_BYTES,
      &self.snapshot,
    );
  }
}

fn parse_lifecycle_lock(
  snapshot: &ControlFileSnapshot,
) -> Result<(String, u32, u64), String> {
  let value: serde_json::Value = serde_json::from_str(&snapshot.text)
    .map_err(|error| format!("Scheduler daemon lifecycle lock is malformed: {error}"))?;
  let object = value
    .as_object()
    .ok_or_else(|| "Scheduler daemon lifecycle lock must be a JSON object".to_string())?;
  if daemon_protocol_version(object, "Scheduler daemon lifecycle lock")?
    != Some(DAEMON_PROTOCOL_VERSION)
  {
    return Err("Scheduler daemon lifecycle lock must use protocolVersion 2".to_string());
  }
  let token = optional_control_string(object, "token", "Scheduler daemon lifecycle lock")?
    .ok_or_else(|| "Scheduler daemon lifecycle lock token is required".to_string())?;
  if !valid_uuid(&token) {
    return Err("Scheduler daemon lifecycle lock token must be a UUID".to_string());
  }
  let owner_pid = u32::try_from(required_control_u64(
    object,
    "ownerPid",
    "Scheduler daemon lifecycle lock",
  )?)
  .map_err(|_| "Scheduler daemon lifecycle lock ownerPid is out of range".to_string())?;
  let acquired_at_ms = required_control_u64(
    object,
    "acquiredAtMs",
    "Scheduler daemon lifecycle lock",
  )?;
  let _ = required_control_u64(
    object,
    "processStartedAt",
    "Scheduler daemon lifecycle lock",
  )?;
  Ok((token, owner_pid, acquired_at_ms))
}

fn acquire_daemon_lifecycle_at_with_timeout(
  root: &Path,
  operation: &str,
  timeout: Duration,
) -> Result<DaemonLifecycleLockGuard, String> {
  let (canonical_workbench, state_root) =
    validate_direct_workbench_root(root, "state", "Workbench state root", false)?;
  let target = state_root.join("juno-daemon.lifecycle.lock.json");
  let token = daemon_lifecycle_token();
  let started = Instant::now();
  loop {
    match OpenOptions::new().write(true).create_new(true).open(&target) {
      Ok(mut file) => {
        let process_started_at = process_started_at_ms(std::process::id())
          .unwrap_or_else(unix_time_ms);
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
          "protocolVersion": DAEMON_PROTOCOL_VERSION,
          "token": token,
          "ownerPid": std::process::id(),
          "processStartedAt": process_started_at,
          "acquiredAtMs": unix_time_ms(),
          "operation": operation,
        }))
        .map_err(|error| format!("Scheduler daemon lifecycle lock cannot be serialized: {error}"))?;
        if bytes.len() + 1 > MAX_LIFECYCLE_LOCK_BYTES {
          return Err("Scheduler daemon lifecycle lock exceeds its byte limit".to_string());
        }
        file.write_all(&bytes)
          .and_then(|_| file.write_all(b"\n"))
          .and_then(|_| file.sync_all())
          .map_err(|error| format!("Scheduler daemon lifecycle lock cannot be written: {error}"))?;
        drop(file);
        let snapshot = read_bounded_control(
          &target,
          "Scheduler daemon lifecycle lock",
          MAX_LIFECYCLE_LOCK_BYTES,
        )?;
        let (observed_token, _, _) = parse_lifecycle_lock(&snapshot)?;
        if observed_token != token {
          return Err("Scheduler daemon lifecycle lock changed after creation".to_string());
        }
        return Ok(DaemonLifecycleLockGuard {
          canonical_workbench,
          state_root,
          target,
          snapshot,
          token,
        });
      }
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
        let observed = read_bounded_control(
          &target,
          "Scheduler daemon lifecycle lock",
          MAX_LIFECYCLE_LOCK_BYTES,
        )?;
        let (_, owner_pid, acquired_at_ms) = parse_lifecycle_lock(&observed)?;
        let stale = !process_is_alive(owner_pid)
          && unix_time_ms().saturating_sub(acquired_at_ms) > LIFECYCLE_LOCK_STALE_MS;
        if stale {
          match remove_control_snapshot_cas(
            &canonical_workbench,
            &state_root,
            &target,
            "Scheduler daemon lifecycle lock",
            MAX_LIFECYCLE_LOCK_BYTES,
            &observed,
          ) {
            Ok(()) => continue,
            Err(_) => {}
          }
        }
      }
      Err(error) => {
        return Err(format!(
          "Scheduler daemon lifecycle lock cannot be created ({}): {error}",
          target.display()
        ))
      }
    }
    if started.elapsed() >= timeout {
      return Err(format!(
        "Timed out acquiring scheduler daemon lifecycle lock for {operation}"
      ));
    }
    std::thread::sleep(Duration::from_millis(25));
  }
}

fn acquire_daemon_lifecycle_at(
  root: &Path,
  operation: &str,
) -> Result<DaemonLifecycleLockGuard, String> {
  acquire_daemon_lifecycle_at_with_timeout(root, operation, LIFECYCLE_LOCK_WAIT)
}

fn scheduler_start_exit_result(
  root: &Path,
  exit: ExitStatus,
) -> Result<SchedulerStatus, String> {
  let status = get_scheduler_status_at(root)?;
  scheduler_start_exit_decision(status, exit)
}

fn scheduler_start_exit_decision(
  status: SchedulerStatus,
  exit: ExitStatus,
) -> Result<SchedulerStatus, String> {
  if status.running {
    return Ok(status);
  }
  let code = exit.code().unwrap_or(1);
  if code == 5 {
    return Err(
      "Juno daemon exited with code 5; explicit recovery is required before restart".to_string(),
    );
  }
  Err(format!(
    "Juno daemon exited with code {code} before publishing a valid v2 generation"
  ))
}

pub fn start_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<SchedulerStatus, String> {
  let _lifecycle = daemon.lifecycle.lock().expect("scheduler lifecycle lock");
  let workbench = workbench_root_path();
  let shared_lifecycle = acquire_daemon_lifecycle_at(&workbench, "desktop-start")?;
  let current = get_scheduler_status_at(&workbench)?;
  if current.running {
    return Ok(current);
  }
  if daemon.is_running() {
    return get_scheduler_status_at(&workbench);
  }

  let script = scheduler_daemon_script();
  if !script.is_file() {
    return Err(format!(
      "Juno daemon script not found ({})",
      script.display()
    ));
  }

  let project_root = juno_project_root();
  if bundled_runtime_active(&project_root) {
    validate_runtime_asset_root(&project_root)?;
  }
  let node = resolve_node_binary()?;
  let codex = resolve_codex_binary()?;
  let mut cmd = Command::new(&node);
  cmd.arg(&script);
  apply_project_env(&mut cmd, Some(&codex));
  cmd.env(
    "JUNO_LIFECYCLE_HANDOFF_TOKEN",
    &shared_lifecycle.token,
  );

  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to start scheduler daemon with {}: {e}", node.display()))?;

  *daemon.child.lock().expect("scheduler lock") = Some(child);
  let mut last_status_error = None;
  for _ in 0..20 {
    std::thread::sleep(Duration::from_millis(500));
    match get_scheduler_status_at(&workbench) {
      Ok(status) if status.running => return Ok(status),
      Ok(_) => last_status_error = None,
      Err(error) => last_status_error = Some(error),
    }
    let exited = {
      let mut guard = daemon.child.lock().expect("scheduler lock");
      let exit = guard
        .as_mut()
        .map(|child| child.try_wait().map_err(|error| error.to_string()))
        .transpose()?
        .flatten();
      if exit.is_some() {
        *guard = None;
      }
      exit
    };
    if let Some(exit) = exited {
      return scheduler_start_exit_result(&workbench, exit);
    }
  }

  let mut child = daemon
    .child
    .lock()
    .expect("scheduler lock")
    .take();
  if let Some(child) = child.as_mut() {
    terminate_and_reap_child(child)?;
  }
  Err(format!(
    "Juno daemon did not publish a valid v2 generation before startup timeout{}",
    last_status_error
      .map(|error| format!(": {error}"))
      .unwrap_or_default()
  ))
}

fn terminate_juno_daemon_v2(identity: &DaemonV2Identity) -> Result<(), String> {
  if !process_matches_daemon_v2(identity)? {
    return Ok(());
  }
  terminate_process_tree(identity.pid)
}

fn stop_scheduler_daemon_at_with_hooks<F, G>(
  daemon: &SchedulerDaemon,
  root: &Path,
  before_termination: F,
  after_termination: G,
) -> Result<(), String>
where
  F: FnOnce(),
  G: FnOnce(),
{
  let _lifecycle = daemon.lifecycle.lock().expect("scheduler lifecycle lock");
  let _shared_lifecycle = acquire_daemon_lifecycle_at(root, "desktop-stop")?;
  let (canonical_workbench, state_root) =
    validate_direct_workbench_root(root, "state", "Workbench state root", false)?;
  let initial = read_scheduler_control_set(&canonical_workbench)?;
  let pid_path = state_root.join("juno-daemon.pid");
  let lease_path = state_root.join("juno-daemon.lease.json");
  let daemon_pid = initial
    .pid_snapshot
    .as_ref()
    .map(parse_scheduler_pid)
    .transpose()?;
  let owned_pid = daemon
    .child
    .lock()
    .expect("scheduler lock")
    .as_ref()
    .map(Child::id);
  if initial.legacy {
    if let Some(pid) = daemon_pid.filter(|pid| Some(*pid) != owned_pid) {
      if process_is_alive(pid) {
        return Err(format!(
          "Live external legacy scheduler PID {pid} cannot be safely terminated without a v2 lease"
        ));
      }
    }
  }

  before_termination();
  let pre_termination = read_scheduler_control_set(&canonical_workbench)?;
  if !scheduler_control_sets_match(&initial, &pre_termination) {
    return Err(
      "A new scheduler daemon state generation or lease/PID binding appeared before termination"
        .to_string(),
    );
  }

  let mut owned_child = daemon
    .child
    .lock()
    .expect("scheduler lock")
    .take();
  if let Some(child) = owned_child.as_mut() {
    if let Err(error) = terminate_and_reap_child(child) {
      *daemon.child.lock().expect("scheduler lock") = owned_child;
      return Err(error);
    }
  }
  if initial.lease.is_some() {
    if let Some(identity) = initial
      .identity
      .as_ref()
      .filter(|identity| Some(identity.pid) != owned_pid)
    {
      terminate_juno_daemon_v2(identity)?;
    }
  }
  after_termination();
  let mut current = read_scheduler_control_set(&canonical_workbench)?;
  if !scheduler_control_sets_match(&initial, &current) {
    return Err(
      "A new scheduler daemon state generation or lease/PID binding appeared during shutdown"
        .to_string(),
    );
  }

  if let Some(expected) = current.pid_snapshot.as_ref() {
    remove_control_snapshot_cas(
      &canonical_workbench,
      &state_root,
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
      expected,
    )?;
  }
  if let Some(expected) = document_snapshot(current.lease.as_ref()) {
    remove_control_snapshot_cas(
      &canonical_workbench,
      &state_root,
      &lease_path,
      "Scheduler daemon lease",
      MAX_DAEMON_LEASE_BYTES,
      expected,
    )?;
  }

  if let Some(mut document) = current.state.take() {
    if scheduler_state_status(&document)? == "blocked" {
      return Ok(());
    }
    document.object.insert(
      "status".to_string(),
      serde_json::Value::String("stopped".to_string()),
    );
    document.object.insert(
      "updatedAt".to_string(),
      serde_json::Value::String(iso_now()),
    );
    commit_json_control(document, "Scheduler daemon state")?;
  }
  Ok(())
}

#[cfg(test)]
fn stop_scheduler_daemon_at_with_hook<F>(
  daemon: &SchedulerDaemon,
  root: &Path,
  after_termination: F,
) -> Result<(), String>
where
  F: FnOnce(),
{
  stop_scheduler_daemon_at_with_hooks(daemon, root, || {}, after_termination)
}

fn stop_scheduler_daemon_at(daemon: &SchedulerDaemon, root: &Path) -> Result<(), String> {
  stop_scheduler_daemon_at_with_hooks(daemon, root, || {}, || {})
}

pub fn stop_scheduler_daemon(daemon: &SchedulerDaemon) -> Result<(), String> {
  stop_scheduler_daemon_at(daemon, &workbench_root_path())
}

pub fn spawn_agent_run(
  runtime: &OrchestratorRuntime,
  manifest_path: String,
  dry_run: Option<bool>,
) -> Result<SpawnRunResult, String> {
  let workbench = workbench_root_path();
  let manifest = PathBuf::from(&manifest_path);
  let (canonical_manifest, meta, manifest_snapshot) =
    validate_spawn_manifest_at(&workbench, &manifest)?;

  let script = spawn_script_path();
  if !script.is_file() {
    return Err(format!(
      "orchestrator not built; run `pnpm orchestrator:build` ({})",
      script.display()
    ));
  }

  let dry_run_requested = dry_run.unwrap_or(false);
  let project_root = juno_project_root();
  if bundled_runtime_active(&project_root) {
    validate_runtime_asset_root(&project_root)?;
  }
  let node = resolve_node_binary()?;
  let codex = if dry_run_requested {
    None
  } else {
    Some(resolve_codex_binary()?)
  };

  let mut cmd = Command::new(&node);
  cmd
    .arg(&script)
    .arg("--manifest")
    .arg(&canonical_manifest);
  apply_project_env(&mut cmd, codex.as_deref());
  if dry_run_requested {
    cmd.arg("--dry-run");
  }

  // Keep the run slot locked across the final check, process creation, and
  // Child registration so concurrent IPC calls cannot overwrite ownership.
  let mut child_guard = acquire_run_spawn_slot(runtime)?;
  let (spawn_manifest, spawn_meta, spawn_snapshot) =
    validate_spawn_manifest_at(&workbench, &canonical_manifest)?;
  if !same_path(&spawn_manifest, &canonical_manifest)
    || spawn_meta != meta
    || spawn_snapshot != manifest_snapshot
  {
    return Err("Run manifest changed before process creation".to_string());
  }
  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to spawn orchestrator with {}: {e}", node.display()))?;

  let pid = child.id();
  *child_guard = Some(child);
  *runtime
    .active_run_id
    .lock()
    .expect("run id lock") = Some(meta.run_id.clone());
  *runtime.started_at.lock().expect("started lock") = Some(SystemTime::now());
  *runtime
    .manifest_path
    .lock()
    .expect("manifest lock") = Some(canonical_manifest);

  if let Err(status_error) = write_orchestrator_status(&workbench, &meta.run_id, "running") {
    let termination_error = child_guard
      .as_mut()
      .and_then(|child| terminate_and_reap_child(child).err());
    if termination_error.is_none() {
      *child_guard = None;
    }
    *runtime.active_run_id.lock().expect("run id lock") = None;
    *runtime.started_at.lock().expect("started lock") = None;
    *runtime.manifest_path.lock().expect("manifest lock") = None;
    return Err(match termination_error {
      Some(error) => format!(
        "failed to persist running state: {status_error}; spawned process termination failed: {error}"
      ),
      None => format!("failed to persist running state: {status_error}"),
    });
  }

  Ok(SpawnRunResult {
    run_id: meta.run_id,
    pid,
    status: "running".to_string(),
  })
}

pub fn kill_agent_run(runtime: &OrchestratorRuntime) -> Result<(), String> {
  let run_id = kill_active_child(runtime)?;
  if let Some(run_id) = run_id {
    write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
  }
  Ok(())
}

pub fn read_run_events(run_id: String, max_lines: Option<u32>) -> Result<RunEventsResult, String> {
  let limit = max_lines.unwrap_or(50).clamp(1, 500) as usize;
  let lines = read_run_event_tail_at(&workbench_root_path(), &run_id, limit)?;
  Ok(RunEventsResult { run_id, lines })
}

pub fn watchdog_tick(runtime: &OrchestratorRuntime) -> Result<(), String> {
  let mut guard = runtime.child.lock().expect("child lock");
  let Some(child) = guard.as_mut() else {
    return Ok(());
  };

  if let Ok(Some(status)) = child.try_wait() {
    let run_id = runtime
      .active_run_id
      .lock()
      .expect("run id lock")
      .clone()
      .unwrap_or_default();
    let final_status = if status.success() {
      "done"
    } else {
      "failed"
    };
    if !run_id.is_empty() {
      write_orchestrator_status(&workbench_root_path(), &run_id, final_status)?;
    }
    *guard = None;
    *runtime.active_run_id.lock().expect("run id lock") = None;
    *runtime.started_at.lock().expect("started lock") = None;
    *runtime.manifest_path.lock().expect("manifest lock") = None;
    return Ok(());
  }

  let manifest_path = runtime
    .manifest_path
    .lock()
    .expect("manifest lock")
    .clone();
  let run_id = runtime
    .active_run_id
    .lock()
    .expect("run id lock")
    .clone()
    .unwrap_or_default();

  let Some(manifest_path) = manifest_path else {
    return Ok(());
  };

  let meta = read_manifest_meta(&manifest_path)?;
  let run_dir = manifest_path
    .parent()
    .map(Path::to_path_buf)
    .unwrap_or_else(|| workbench_root_path().join("runs").join(&run_id));

  if heartbeat_stale(&run_dir, 300) {
    write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
    terminate_and_reap_child(child)?;
    *guard = None;
    *runtime.active_run_id.lock().expect("run id lock") = None;
    *runtime.started_at.lock().expect("started lock") = None;
    *runtime.manifest_path.lock().expect("manifest lock") = None;
    return Ok(());
  }

  let timed_out = runtime
    .started_at
    .lock()
    .expect("started lock")
    .map(|started_at| {
      started_at.elapsed().unwrap_or(Duration::ZERO)
        > Duration::from_secs(meta.max_minutes.saturating_mul(60))
    })
    .unwrap_or(false);
  if timed_out {
    write_orchestrator_status(&workbench_root_path(), &run_id, "stall")?;
    terminate_and_reap_child(child)?;
    *guard = None;
    *runtime.active_run_id.lock().expect("run id lock") = None;
    *runtime.started_at.lock().expect("started lock") = None;
    *runtime.manifest_path.lock().expect("manifest lock") = None;
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{
    acquire_daemon_lifecycle_at_with_timeout, acquire_run_spawn_slot,
    bind_scheduler_process_status, command_is_juno_daemon,
    commit_json_control,
    executable_candidates_on_path, node_version_supported, parse_node_version,
    get_scheduler_status_at, iso_from_unix, juno_project_root, load_json_control,
    operator_recovery_operation_id, process_is_alive, publish_control_bytes_with_hook,
    read_bounded_control, read_run_event_tail_at, read_run_event_tail_at_with_hook,
    remove_control_snapshot_cas_with_hook, remove_control_snapshot_cas_with_hooks,
    process_started_at_ms, resolve_project_root, resolve_run_artifact_path,
    scheduler_daemon_script, scheduler_start_exit_decision,
    same_moved_control, sha256_file, stop_scheduler_daemon_at,
    stop_scheduler_daemon_at_with_hook, stop_scheduler_daemon_at_with_hooks,
    terminate_and_reap_child,
    terminate_and_reap_child_with, validate_operator_recovery_inventory,
    validate_operator_recovery_request, validate_operator_recovery_result, validate_run_id,
    validate_runtime_asset_root, validate_spawn_manifest_at, write_orchestrator_status,
    wait_for_helper_bounded, OperatorRecoveryApplyRequest, OperatorRecoveryApplyResult,
    OperatorRecoveryInventory, OrchestratorRuntime, SchedulerDaemon, SchedulerStatus,
    DAEMON_PROTOCOL_VERSION, MAX_PID_CONTROL_BYTES, MAX_RUN_EVENTS_BYTES,
    MAX_RUN_MANIFEST_BYTES, MAX_STATE_CONTROL_BYTES, REQUIRED_RUNTIME_ASSETS,
  };
  use std::env;
  use std::fs;
  use std::path::PathBuf;
  use std::process::{Child, Command, Stdio};
  use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
  use std::sync::{Arc, Barrier};
  use std::thread;
  use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time")
      .as_nanos();
    std::env::temp_dir().join(format!("juno-{label}-{}-{nonce}", std::process::id()))
  }

  #[cfg(target_os = "windows")]
  fn link_directory(source: &std::path::Path, target: &std::path::Path) {
    let status = Command::new("cmd.exe")
      .args(["/d", "/c", "mklink", "/J"])
      .arg(target)
      .arg(source)
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .expect("launch junction helper");
    assert!(status.success(), "create directory junction");
  }

  #[cfg(unix)]
  fn link_directory(source: &std::path::Path, target: &std::path::Path) {
    std::os::unix::fs::symlink(source, target).expect("create directory symlink");
  }

  #[cfg(target_os = "windows")]
  fn remove_directory_link(target: &std::path::Path) {
    fs::remove_dir(target).expect("remove directory junction");
  }

  #[cfg(unix)]
  fn remove_directory_link(target: &std::path::Path) {
    fs::remove_file(target).expect("remove directory symlink");
  }

  fn valid_operator_recovery_request_json() -> serde_json::Value {
    serde_json::json!({
      "incidentId": "a".repeat(64),
      "action": "resume_exact_intent",
      "preconditionSha256": "b".repeat(64),
      "reason": "Operator confirmed exact immutable intent",
    })
  }

  #[test]
  fn operator_recovery_apply_request_is_a_closed_validated_contract() {
    let request: OperatorRecoveryApplyRequest = serde_json::from_value(
      valid_operator_recovery_request_json(),
    )
    .expect("valid request");
    validate_operator_recovery_request(&request).expect("validated request");
    assert_eq!(
      operator_recovery_operation_id(&request).expect("operation id"),
      "74d5bd8c392d8bbac5d9c1473036f036258b47977ebbe1ca76913c003c4947ac",
    );

    for (field, value) in [
      ("path", serde_json::json!("E:/outside")),
      ("force", serde_json::json!(true)),
    ] {
      let mut candidate = valid_operator_recovery_request_json();
      candidate[field] = value;
      assert!(serde_json::from_value::<OperatorRecoveryApplyRequest>(candidate).is_err());
    }

    let mut unknown_action = valid_operator_recovery_request_json();
    unknown_action["action"] = serde_json::json!("delete_artifact");
    assert!(serde_json::from_value::<OperatorRecoveryApplyRequest>(unknown_action).is_err());

    for (field, value) in [
      ("incidentId", serde_json::json!("A".repeat(64))),
      ("preconditionSha256", serde_json::json!("not-a-digest")),
      ("reason", serde_json::json!(" untrimmed")),
      ("reason", serde_json::json!("line\nbreak")),
    ] {
      let mut candidate = valid_operator_recovery_request_json();
      candidate[field] = value;
      let parsed: OperatorRecoveryApplyRequest =
        serde_json::from_value(candidate).expect("shape remains valid");
      assert!(validate_operator_recovery_request(&parsed).is_err(), "{field}");
    }
  }

  #[test]
  fn operator_recovery_output_json_rejects_unknown_fields() {
    let inventory_json = serde_json::json!({
      "inventoryVersion": 1,
      "observedAt": "2026-07-15T12:00:00.000Z",
      "workbench": "E:/AgentWorkbench",
      "controls": { "queue": null, "workflowSelection": null },
      "incidents": [{
        "incidentId": "a".repeat(64),
        "domain": "completion",
        "kind": "completion_pending_intent",
        "blocking": true,
        "confidence": "proven",
        "artifact": {
          "relativePath": format!("state/mission-completion-transactions/{}.json", "d".repeat(64)),
          "entryKind": "file",
          "identity": null,
          "byteLength": 512,
          "sha256": "d".repeat(64),
          "validation": "stable_file",
        },
        "detail": "Strict immutable completion intent is pending reconciliation",
        "completionBinding": {
          "missionId": "mission-1",
          "terminalRunId": "run-1",
          "expectedHeadFingerprint": "e".repeat(64),
          "intentSha256": "d".repeat(64),
          "expectedReceipt": {
            "receiptVersion": 1,
            "missionId": "mission-1",
            "terminalRunId": "run-1",
            "runCheckpointSha256": "f".repeat(64),
            "evidenceVersion": "ordinary-verify-v1",
            "completedAt": "2026-07-15T11:59:00.000Z",
          },
        },
        "allowedActions": ["resume_exact_intent"],
        "preconditionSha256": "c".repeat(64),
      }],
      "inventorySha256": "c".repeat(64),
    });
    let inventory: OperatorRecoveryInventory =
      serde_json::from_value(inventory_json.clone()).expect("strict inventory");
    validate_operator_recovery_inventory(&inventory).expect("valid inventory");

    let mut extra_inventory = inventory_json.clone();
    extra_inventory["script"] = serde_json::json!("foreign.js");
    assert!(serde_json::from_value::<OperatorRecoveryInventory>(extra_inventory).is_err());

    let mut extra_receipt = inventory_json.clone();
    extra_receipt["incidents"][0]["completionBinding"]["expectedReceipt"]["path"] =
      serde_json::json!("E:/outside");
    assert!(serde_json::from_value::<OperatorRecoveryInventory>(extra_receipt).is_err());

    let mut mismatched_receipt = inventory_json.clone();
    mismatched_receipt["incidents"][0]["completionBinding"]["expectedReceipt"]["missionId"] =
      serde_json::json!("other-mission");
    let mismatched_receipt: OperatorRecoveryInventory =
      serde_json::from_value(mismatched_receipt).expect("valid inventory shape");
    assert!(validate_operator_recovery_inventory(&mismatched_receipt).is_err());

    let request: OperatorRecoveryApplyRequest =
      serde_json::from_value(valid_operator_recovery_request_json()).expect("valid request");
    let result_json = serde_json::json!({
      "operationId": operator_recovery_operation_id(&request).expect("operation id"),
      "incidentId": "a".repeat(64),
      "action": "resume_exact_intent",
      "reason": "Operator confirmed exact immutable intent",
      "recovery": { "status": "none", "recovered": [] },
    });
    let result: OperatorRecoveryApplyResult =
      serde_json::from_value(result_json.clone()).expect("strict apply result");
    validate_operator_recovery_result(&request, &result).expect("request-bound result");

    let mut mismatched_result = result_json.clone();
    mismatched_result["operationId"] = serde_json::json!("0".repeat(64));
    let mismatched_result: OperatorRecoveryApplyResult =
      serde_json::from_value(mismatched_result).expect("valid result shape");
    assert!(validate_operator_recovery_result(&request, &mismatched_result).is_err());

    let mut extra_result = result_json;
    extra_result["recovery"]["path"] = serde_json::json!("E:/outside");
    assert!(serde_json::from_value::<OperatorRecoveryApplyResult>(extra_result).is_err());
  }

  #[test]
  fn resolves_source_packaged_and_explicit_project_roots_in_order() {
    let manifest_dir = PathBuf::from("source/src-tauri");
    let bundled = PathBuf::from("installed/resources/juno-runtime");
    assert_eq!(
      resolve_project_root(Some("explicit/project"), Some(&bundled), &manifest_dir),
      PathBuf::from("explicit/project")
    );
    assert_eq!(
      resolve_project_root(None, Some(&bundled), &manifest_dir),
      bundled
    );
    assert_eq!(
      resolve_project_root(None, None, &manifest_dir),
      PathBuf::from("source")
    );
  }

  #[test]
  fn enforces_the_desktop_node_version_floor() {
    assert_eq!(parse_node_version("v22.13.1\n").expect("parse"), (22, 13, 1));
    assert!(node_version_supported((22, 13, 0)));
    assert!(node_version_supported((23, 0, 0)));
    assert!(!node_version_supported((22, 12, 9)));
    assert!(!node_version_supported((21, 99, 99)));
    assert!(parse_node_version("not-node").is_err());
  }

  #[test]
  fn emits_node_compatible_iso_timestamps() {
    assert_eq!(iso_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
      iso_from_unix(1_709_164_800, 123),
      "2024-02-29T00:00:00.123Z"
    );
  }

  #[test]
  fn executable_path_search_returns_an_absolute_runtime_candidate() {
    let root = temp_root("path-runtime");
    fs::create_dir_all(&root).expect("create path root");
    let file_name = if cfg!(target_os = "windows") {
      "juno-runtime-test.exe"
    } else {
      "juno-runtime-test"
    };
    let executable = root.join(file_name);
    fs::write(&executable, "fixture").expect("write executable fixture");
    let search_path = env::join_paths([&root]).expect("join search path");
    let candidates = executable_candidates_on_path("juno-runtime-test", Some(&search_path));
    assert_eq!(candidates, vec![executable]);
    fs::remove_dir_all(root).expect("remove path root");
  }

  #[test]
  fn bundled_runtime_manifest_detects_asset_tampering() {
    let root = temp_root("runtime-integrity");
    let required = REQUIRED_RUNTIME_ASSETS;
    let mut assets = vec![];
    let mut total_bytes = 0_u64;
    for (index, relative) in required.iter().enumerate() {
      let target = root.join(relative);
      fs::create_dir_all(target.parent().expect("asset parent")).expect("create asset parent");
      let content = format!("fixture-{index}\n");
      fs::write(&target, content.as_bytes()).expect("write asset");
      total_bytes += content.len() as u64;
      assets.push(serde_json::json!({
        "path": relative,
        "bytes": content.len(),
        "sha256": sha256_file(&target).expect("hash asset"),
      }));
    }
    fs::write(
      root.join("runtime-manifest.json"),
      serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "node": ">=22.13.0",
        "codexCli": "external-required",
        "embeddedCodexPlatformBinary": false,
        "totalBytes": total_bytes,
        "assets": assets,
      }))
      .expect("serialize manifest"),
    )
    .expect("write manifest");

    validate_runtime_asset_root(&root).expect("valid runtime fixture");
    fs::write(root.join(required[0]), "tampered\n").expect("tamper asset");
    let error = validate_runtime_asset_root(&root).expect_err("tampering must fail");
    assert!(error.contains("SHA-256"));
    fs::remove_dir_all(root).expect("remove runtime fixture");
  }

  #[cfg(target_os = "windows")]
  fn spawn_sleeper() -> Child {
    Command::new("ping.exe")
      .args(["-n", "30", "127.0.0.1"])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("spawn sleeper")
  }

  fn helper_exit_status(code: i32) -> std::process::ExitStatus {
    #[cfg(target_os = "windows")]
    let mut child = Command::new("cmd.exe")
      .args(["/d", "/c", &format!("exit {code}")])
      .spawn()
      .expect("spawn exit helper");
    #[cfg(not(target_os = "windows"))]
    let mut child = Command::new("sh")
      .args(["-c", &format!("exit {code}")])
      .spawn()
      .expect("spawn exit helper");
    child.wait().expect("wait for exit helper")
  }

  fn write_v2_scheduler_controls(
    root: &std::path::Path,
    pid: u32,
    generation: &str,
    status: &str,
    include_owner: bool,
  ) {
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create v2 scheduler state root");
    let canonical = fs::canonicalize(root)
      .expect("canonical v2 Workbench")
      .to_string_lossy()
      .to_string();
    let process_started_at = process_started_at_ms(pid).unwrap_or(1);
    let identity = serde_json::json!({
      "protocolVersion": DAEMON_PROTOCOL_VERSION,
      "generation": generation,
      "pid": pid,
      "processStartedAt": process_started_at,
      "workbenchRoot": canonical,
    });
    let mut state = identity.clone();
    state["status"] = serde_json::Value::String(status.to_string());
    state["startedAt"] = serde_json::Value::String("2026-07-20T00:00:00.000Z".to_string());
    state["heartbeatAt"] = serde_json::Value::String("2026-07-20T00:01:00.000Z".to_string());
    fs::write(
      state_dir.join("juno-daemon.json"),
      serde_json::to_vec_pretty(&state).expect("serialize v2 state"),
    )
    .expect("write v2 state");
    if include_owner {
      fs::write(
        state_dir.join("juno-daemon.lease.json"),
        serde_json::to_vec_pretty(&identity).expect("serialize v2 lease"),
      )
      .expect("write v2 lease");
      fs::write(state_dir.join("juno-daemon.pid"), format!("{pid}\n"))
        .expect("write v2 PID shadow");
    }
  }

  #[test]
  fn concurrent_run_slot_reservations_allow_exactly_one_owner() {
    let runtime = Arc::new(OrchestratorRuntime::new());
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();

    for _ in 0..2 {
      let runtime = Arc::clone(&runtime);
      let barrier = Arc::clone(&barrier);
      handles.push(thread::spawn(move || {
        barrier.wait();
        match acquire_run_spawn_slot(&runtime) {
          Ok(mut slot) => {
            *slot = Some(spawn_sleeper());
            true
          }
          Err(_) => false,
        }
      }));
    }

    barrier.wait();
    let owners = handles
      .into_iter()
      .map(|handle| handle.join().expect("reservation thread"))
      .filter(|owns_slot| *owns_slot)
      .count();
    assert_eq!(owners, 1);

    let mut guard = runtime.child.lock().expect("child lock");
    let mut child = guard.take().expect("reserved child");
    terminate_and_reap_child(&mut child).expect("cleanup reserved child");
  }

  #[cfg(not(target_os = "windows"))]
  fn spawn_sleeper() -> Child {
    Command::new("sleep")
      .arg("30")
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("spawn sleeper")
  }

  #[test]
  fn recognizes_absolute_and_relative_daemon_arguments() {
    let root = juno_project_root();
    let expected = scheduler_daemon_script();
    assert!(command_is_juno_daemon(
      &["node".to_string(), expected.to_string_lossy().into_owned()],
      Some(&root),
      &expected,
    ));
    assert!(command_is_juno_daemon(
      &[
        "node".to_string(),
        "scripts/run-juno-daemon.mjs".to_string(),
      ],
      Some(&root),
      &expected,
    ));
  }

  #[test]
  fn rejects_same_named_daemon_from_another_root() {
    let root = juno_project_root();
    let expected = scheduler_daemon_script();
    let other_root = temp_root("other-daemon");
    let other_script = other_root.join("scripts/run-juno-daemon.mjs");
    fs::create_dir_all(other_script.parent().expect("script parent")).expect("create other root");
    fs::write(&other_script, "// not Juno\n").expect("write lookalike");

    assert!(!command_is_juno_daemon(
      &[
        "node".to_string(),
        other_script.to_string_lossy().into_owned(),
      ],
      Some(&root),
      &expected,
    ));
    assert!(!command_is_juno_daemon(
      &[
        "node".to_string(),
        "--label".to_string(),
        expected.to_string_lossy().into_owned(),
      ],
      Some(&root),
      &expected,
    ));
    fs::remove_dir_all(other_root).expect("remove other root");
  }

  #[test]
  fn rejects_run_id_path_traversal() {
    assert!(validate_run_id("valid-run_2.0").is_ok());
    for invalid in [
      "",
      " ",
      ".",
      "..",
      "../outside",
      r"..\outside",
      "C:",
      "-leading-dash",
      ".hidden",
      "trailing-dot.",
      "CON",
      "com1.log",
      "LPT\u{b2}",
    ] {
      assert!(validate_run_id(invalid).is_err(), "accepted {invalid:?}");
    }
    assert!(validate_run_id("unicode-\u{4efb}\u{52a1}").is_ok());
  }

  #[test]
  fn orchestrator_state_publish_is_exclusive_bounded_and_cas_bound() {
    let normal_root = temp_root("normal-orchestrator-state");
    fs::create_dir_all(&normal_root).expect("create normal Workbench");
    write_orchestrator_status(&normal_root, "run-1", "running")
      .expect("write initial orchestrator state");
    let state_path = normal_root.join("state/orchestrator.json");
    let initial: serde_json::Value = serde_json::from_slice(
      &fs::read(&state_path).expect("read initial orchestrator state"),
    )
    .expect("parse initial orchestrator state");
    assert_eq!(initial["activeRunId"], "run-1");
    assert_eq!(initial["activeRunStatus"], "running");

    let mut winner = load_json_control(
      &normal_root,
      "orchestrator.json",
      "Orchestrator state",
      false,
      false,
    )
    .expect("load winner snapshot")
    .expect("winner document");
    let mut stale = load_json_control(
      &normal_root,
      "orchestrator.json",
      "Orchestrator state",
      false,
      false,
    )
    .expect("load stale snapshot")
    .expect("stale document");
    winner.object.insert(
      "activeRunStatus".to_string(),
      serde_json::Value::String("done".to_string()),
    );
    commit_json_control(winner, "Orchestrator state").expect("commit winning state");
    stale.object.insert(
      "activeRunStatus".to_string(),
      serde_json::Value::String("failed".to_string()),
    );
    let error = commit_json_control(stale, "Orchestrator state")
      .expect_err("stale state snapshot must not overwrite the winner");
    assert!(error.contains("changed before commit"));
    let final_state: serde_json::Value = serde_json::from_slice(
      &fs::read(&state_path).expect("read final orchestrator state"),
    )
    .expect("parse final orchestrator state");
    assert_eq!(final_state["activeRunStatus"], "done");
    fs::remove_dir_all(normal_root).expect("remove normal Workbench");

    let malformed_root = temp_root("malformed-orchestrator-state");
    fs::create_dir_all(malformed_root.join("state")).expect("create malformed state root");
    let malformed_path = malformed_root.join("state/orchestrator.json");
    let malformed = b"{ definitely-not-json\n";
    fs::write(&malformed_path, malformed).expect("write malformed state");
    let error = write_orchestrator_status(&malformed_root, "run-2", "running")
      .expect_err("malformed state must fail closed");
    assert!(error.contains("malformed"));
    assert_eq!(fs::read(&malformed_path).expect("read malformed state"), malformed);
    fs::remove_dir_all(malformed_root).expect("remove malformed Workbench");

    let hardlink_root = temp_root("hardlink-orchestrator-state");
    fs::create_dir_all(hardlink_root.join("state")).expect("create hardlink state root");
    let source = hardlink_root.join("orchestrator-source.json");
    let source_bytes = br#"{"activeRunStatus":"idle"}"#;
    fs::write(&source, source_bytes).expect("write hardlink source");
    fs::hard_link(&source, hardlink_root.join("state/orchestrator.json"))
      .expect("create orchestrator hardlink");
    let error = write_orchestrator_status(&hardlink_root, "run-3", "running")
      .expect_err("hardlinked state must fail closed");
    assert!(error.contains("exclusive regular file"));
    assert_eq!(fs::read(&source).expect("read hardlink source"), source_bytes);
    fs::remove_dir_all(hardlink_root).expect("remove hardlink Workbench");
  }

  #[test]
  fn publish_preserves_a_foreign_final_replacement() {
    let root = temp_root("publish-final-replacement");
    let state_root = root.join("state");
    fs::create_dir_all(&state_root).expect("create publish state root");
    let target = state_root.join("orchestrator.json");
    let replacement = state_root.join("replacement.json");
    let original = br#"{"activeRunId":"old","activeRunStatus":"running"}"#;
    let foreign = br#"{"activeRunId":"foreign","activeRunStatus":"running"}"#;
    let desired = br#"{"activeRunId":"desired","activeRunStatus":"done"}"#;
    fs::write(&target, original).expect("write original state");
    fs::write(&replacement, foreign).expect("write foreign state");
    let expected = read_bounded_control(
      &target,
      "Orchestrator state",
      MAX_STATE_CONTROL_BYTES,
    )
    .expect("read original state snapshot");
    let canonical_root = fs::canonicalize(&root).expect("canonical Workbench");
    let canonical_state = fs::canonicalize(&state_root).expect("canonical state root");

    let error = publish_control_bytes_with_hook(
      &canonical_root,
      &canonical_state,
      &target,
      "Orchestrator state",
      MAX_STATE_CONTROL_BYTES,
      Some(&expected),
      desired,
      || {
        fs::remove_file(&target).expect("remove expected target in race hook");
        fs::rename(&replacement, &target).expect("install foreign target in race hook");
      },
    )
    .expect_err("foreign final replacement must abort publish");
    assert!(error.contains("foreign replacement was preserved"));
    assert_eq!(fs::read(&target).expect("read foreign target"), foreign);
    read_bounded_control(
      &target,
      "Orchestrator state",
      MAX_STATE_CONTROL_BYTES,
    )
    .expect("foreign target remains exclusive");
    assert_eq!(
      fs::read_dir(&state_root)
        .expect("read publish state root")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("preimage"))
        .count(),
      0
    );
    fs::remove_dir_all(root).expect("remove publish replacement fixture");
  }

  #[test]
  fn state_directory_link_cannot_redirect_orchestrator_writes() {
    let root = temp_root("linked-state-workbench");
    let external = temp_root("linked-state-external");
    fs::create_dir_all(&root).expect("create linked-state Workbench");
    fs::create_dir_all(&external).expect("create linked-state external root");
    let external_state = external.join("orchestrator.json");
    let external_bytes = br#"{"activeRunStatus":"idle"}"#;
    fs::write(&external_state, external_bytes).expect("write external state");
    let linked_state = root.join("state");
    link_directory(&external, &linked_state);

    let error = write_orchestrator_status(&root, "run-linked", "running")
      .expect_err("linked state root must fail closed");
    assert!(error.contains("non-link") || error.contains("escapes"));
    assert_eq!(
      fs::read(&external_state).expect("read external state"),
      external_bytes
    );

    remove_directory_link(&linked_state);
    fs::remove_dir_all(root).expect("remove linked-state Workbench");
    fs::remove_dir_all(external).expect("remove linked-state external root");
  }

  #[test]
  fn spawn_manifest_requires_a_direct_exclusive_bounded_manifest() {
    let root = temp_root("secure-manifest");
    let valid_dir = root.join("runs/run-valid");
    fs::create_dir_all(&valid_dir).expect("create valid run directory");
    let valid_manifest = valid_dir.join("manifest.json");
    fs::write(
      &valid_manifest,
      br#"{"runId":"run-valid","maxMinutes":25}"#,
    )
    .expect("write valid manifest");
    let (resolved, meta, _) =
      validate_spawn_manifest_at(&root, &valid_manifest).expect("validate normal manifest");
    assert_eq!(resolved, fs::canonicalize(&valid_manifest).expect("canonical manifest"));
    assert_eq!(meta.run_id, "run-valid");
    assert_eq!(meta.max_minutes, 25);

    let wrong_name = valid_dir.join("Manifest.json");
    fs::write(
      &wrong_name,
      br#"{"runId":"run-valid","maxMinutes":25}"#,
    )
    .expect("write wrong-name manifest");
    let error = validate_spawn_manifest_at(&root, &wrong_name)
      .expect_err("manifest basename is case-sensitive");
    assert!(error.contains("exactly manifest.json"));

    let hardlink_dir = root.join("runs/run-hardlink");
    fs::create_dir_all(&hardlink_dir).expect("create hardlink run directory");
    let source = root.join("manifest-source.json");
    let source_bytes = br#"{"runId":"run-hardlink","maxMinutes":25}"#;
    fs::write(&source, source_bytes).expect("write manifest source");
    let hardlink_manifest = hardlink_dir.join("manifest.json");
    fs::hard_link(&source, &hardlink_manifest).expect("create manifest hardlink");
    let error = validate_spawn_manifest_at(&root, &hardlink_manifest)
      .expect_err("hardlinked manifest must fail closed");
    assert!(error.contains("exclusive regular file"));
    assert_eq!(fs::read(&source).expect("read manifest source"), source_bytes);

    let oversized_dir = root.join("runs/run-oversized");
    fs::create_dir_all(&oversized_dir).expect("create oversized run directory");
    let oversized_manifest = oversized_dir.join("manifest.json");
    fs::write(&oversized_manifest, vec![b'x'; MAX_RUN_MANIFEST_BYTES + 1])
      .expect("write oversized manifest");
    let error = validate_spawn_manifest_at(&root, &oversized_manifest)
      .expect_err("oversized manifest must fail closed");
    assert!(error.contains("byte limit") || error.contains("exceeds"));

    fs::remove_dir_all(root).expect("remove secure manifest Workbench");
  }

  #[test]
  fn linked_runs_roots_and_run_directories_cannot_spawn_or_read() {
    let linked_root = temp_root("linked-runs-workbench");
    let external_runs = temp_root("linked-runs-external");
    fs::create_dir_all(&linked_root).expect("create linked-runs Workbench");
    let external_run = external_runs.join("run-linked");
    fs::create_dir_all(&external_run).expect("create external run");
    let external_manifest = external_run.join("manifest.json");
    fs::write(
      &external_manifest,
      br#"{"runId":"run-linked","maxMinutes":25}"#,
    )
    .expect("write external manifest");
    let external_events = external_run.join("events.jsonl");
    fs::write(&external_events, b"{}\n").expect("write external events");
    let runs_link = linked_root.join("runs");
    link_directory(&external_runs, &runs_link);

    assert!(validate_spawn_manifest_at(
      &linked_root,
      &runs_link.join("run-linked/manifest.json"),
    )
    .is_err());
    assert!(resolve_run_artifact_path(&linked_root, "run-linked", "events.jsonl").is_err());
    assert_eq!(
      fs::read(&external_manifest).expect("read external manifest"),
      br#"{"runId":"run-linked","maxMinutes":25}"#
    );
    assert_eq!(fs::read(&external_events).expect("read external events"), b"{}\n");

    remove_directory_link(&runs_link);
    fs::remove_dir_all(linked_root).expect("remove linked-runs Workbench");
    fs::remove_dir_all(external_runs).expect("remove linked-runs external root");

    let child_link_root = temp_root("linked-run-child-workbench");
    let external_child = temp_root("linked-run-child-external");
    fs::create_dir_all(child_link_root.join("runs")).expect("create runs root");
    fs::create_dir_all(&external_child).expect("create external run child");
    fs::write(
      external_child.join("manifest.json"),
      br#"{"runId":"run-child","maxMinutes":25}"#,
    )
    .expect("write external child manifest");
    fs::write(external_child.join("events.jsonl"), b"{}\n")
      .expect("write external child events");
    let child_link = child_link_root.join("runs").join("run-child");
    link_directory(&external_child, &child_link);
    assert!(validate_spawn_manifest_at(
      &child_link_root,
      &child_link.join("manifest.json"),
    )
    .is_err());
    assert!(resolve_run_artifact_path(&child_link_root, "run-child", "events.jsonl").is_err());
    remove_directory_link(&child_link);
    fs::remove_dir_all(child_link_root).expect("remove linked child Workbench");
    fs::remove_dir_all(external_child).expect("remove linked child external root");
  }

  #[test]
  fn resolves_events_only_inside_the_named_run() {
    let root = temp_root("run-containment");
    let events = root.join("runs/valid-run/events.jsonl");
    fs::create_dir_all(events.parent().expect("events parent")).expect("create run");
    fs::write(&events, "{}\n").expect("write events");

    let resolved = resolve_run_artifact_path(&root, "valid-run", "events.jsonl")
      .expect("resolve contained artifact");
    assert_eq!(resolved, fs::canonicalize(&events).expect("canonical events"));
    assert!(resolve_run_artifact_path(&root, "..", "events.jsonl").is_err());
    assert!(resolve_run_artifact_path(&root, "C:", "events.jsonl").is_err());
    fs::remove_dir_all(root).expect("remove containment root");
  }

  #[test]
  fn run_event_tail_is_descriptor_bound_and_bounded() {
    let root = temp_root("secure-event-tail");
    let run_dir = root.join("runs/run-events");
    fs::create_dir_all(&run_dir).expect("create events run");
    let events = run_dir.join("events.jsonl");
    fs::write(&events, b"one\ntwo\nthree\n").expect("write normal events");
    assert_eq!(
      read_run_event_tail_at(&root, "run-events", 2).expect("read normal event tail"),
      vec!["two".to_string(), "three".to_string()]
    );

    let replacement = root.join("replacement-events.jsonl");
    let foreign = b"foreign\nreplacement\n";
    fs::write(&replacement, foreign).expect("write foreign event replacement");
    let error = read_run_event_tail_at_with_hook(&root, "run-events", 10, || {
      fs::remove_file(&events).expect("remove opened events path");
      fs::rename(&replacement, &events).expect("install replacement events path");
    })
    .expect_err("event path replacement after open must fail closed");
    assert!(error.contains("changed while reading"));
    assert_eq!(fs::read(&events).expect("read replacement events"), foreign);

    fs::remove_file(&events).expect("remove replacement events");
    let mut long_log = vec![b'x'; MAX_RUN_EVENTS_BYTES + 17];
    long_log.extend_from_slice(b"\nolder\nrecent-a\nrecent-b\n");
    fs::write(&events, long_log).expect("write long events log");
    assert_eq!(
      read_run_event_tail_at(&root, "run-events", 2).expect("tail a long events log"),
      vec!["recent-a".to_string(), "recent-b".to_string()]
    );

    fs::write(&events, vec![b'x'; MAX_RUN_EVENTS_BYTES + 1])
      .expect("write oversized event line");
    let error = read_run_event_tail_at(&root, "run-events", 10)
      .expect_err("a line larger than the bounded tail must fail closed");
    assert!(error.contains("line exceeding"));

    fs::remove_file(&events).expect("remove oversized event line");
    let hardlink_source = root.join("events-source.jsonl");
    fs::write(&hardlink_source, b"linked\n").expect("write events hardlink source");
    fs::hard_link(&hardlink_source, &events).expect("create events hardlink");
    let error = read_run_event_tail_at(&root, "run-events", 10)
      .expect_err("hardlinked events must fail closed");
    assert!(error.contains("exclusive regular file"));

    fs::remove_file(&events).expect("remove events hardlink");
    assert!(
      read_run_event_tail_at(&root, "run-events", 10)
        .expect("missing events are empty")
        .is_empty()
    );
    fs::remove_dir_all(root).expect("remove secure event tail fixture");
  }

  #[test]
  fn termination_failure_returns_without_waiting_for_child_exit() {
    let mut child = spawn_sleeper();
    let started = Instant::now();
    let error = terminate_and_reap_child_with(&mut child, |_| Err("synthetic failure".to_string()))
      .expect_err("termination should fail");
    assert!(error.contains("synthetic failure"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(child.try_wait().expect("child status").is_none());
    terminate_and_reap_child(&mut child).expect("cleanup sleeper");
  }

  #[test]
  fn helper_timeout_is_bounded_and_reaped() {
    let mut child = spawn_sleeper();
    let child_pid = child.id();
    let started = Instant::now();
    let error = wait_for_helper_bounded(
      &mut child,
      "synthetic helper",
      Duration::from_millis(25),
    )
    .expect_err("helper should time out");

    assert!(error.contains("timed out"));
    assert!(error.contains("termination is unconfirmed"));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(child.try_wait().expect("child status").is_some());
    assert!(!process_is_alive(child_pid));
  }

  #[test]
  fn scheduler_status_reads_all_controls_fail_closed() {
    let normal_root = temp_root("scheduler-status-normal");
    let normal_state = normal_root.join("state");
    fs::create_dir_all(&normal_state).expect("create normal scheduler state");
    fs::write(
      normal_state.join("juno-daemon.json"),
      br#"{"status":"running","startedAt":"2026-07-15T01:00:00.000Z","updatedAt":"2026-07-15T01:01:00.000Z"}"#,
    )
    .expect("write daemon status");
    fs::write(
      normal_state.join("bounded-autonomy.json"),
      br#"{"iterationsToday":7,"lastAction":"spawn"}"#,
    )
    .expect("write autonomy status");
    let status = get_scheduler_status_at(&normal_root).expect("read normal scheduler status");
    assert!(status.enabled);
    assert!(!status.running);
    assert_eq!(status.runs_today, 7);
    assert_eq!(status.last_action.as_deref(), Some("spawn"));
    assert_eq!(
      status.daemon_started_at.as_deref(),
      Some("2026-07-15T01:00:00.000Z")
    );

    let mut inconsistent = status;
    inconsistent.enabled = false;
    let error = bind_scheduler_process_status(&mut inconsistent, 4242, true)
      .expect_err("a live daemon cannot be hidden by non-enabled state");
    assert!(error.contains("live while daemon state is not enabled"));
    inconsistent.enabled = true;
    bind_scheduler_process_status(&mut inconsistent, 4242, true)
      .expect("enabled state binds the live daemon");
    assert!(inconsistent.running);
    assert_eq!(inconsistent.pid, Some(4242));

    fs::write(normal_state.join("juno-daemon.json"), b"{}\n")
      .expect("write status-less daemon state");
    let error = get_scheduler_status_at(&normal_root)
      .expect_err("daemon state without status must fail closed");
    assert!(error.contains("status is required"));
    fs::write(normal_state.join("juno-daemon.json"), b"{ malformed\n")
      .expect("write malformed daemon status");
    assert!(get_scheduler_status_at(&normal_root).is_err());
    fs::remove_dir_all(normal_root).expect("remove normal scheduler status root");

    let hardlink_root = temp_root("scheduler-status-hardlink");
    let hardlink_state = hardlink_root.join("state");
    fs::create_dir_all(&hardlink_state).expect("create hardlink scheduler state");
    let autonomy_source = hardlink_root.join("autonomy-source.json");
    fs::write(&autonomy_source, br#"{"iterationsToday":1}"#)
      .expect("write autonomy source");
    fs::hard_link(
      &autonomy_source,
      hardlink_state.join("bounded-autonomy.json"),
    )
    .expect("create autonomy hardlink");
    let error = get_scheduler_status_at(&hardlink_root)
      .expect_err("hardlinked autonomy state must fail closed");
    assert!(error.contains("exclusive regular file"));
    fs::remove_dir_all(hardlink_root).expect("remove hardlink scheduler status root");

    let oversized_root = temp_root("scheduler-status-oversized");
    let oversized_state = oversized_root.join("state");
    fs::create_dir_all(&oversized_state).expect("create oversized scheduler state");
    fs::write(
      oversized_state.join("juno-daemon.json"),
      vec![b'x'; MAX_STATE_CONTROL_BYTES + 1],
    )
    .expect("write oversized daemon state");
    let error = get_scheduler_status_at(&oversized_root)
      .expect_err("oversized daemon state must fail closed");
    assert!(error.contains("exceeds"));
    fs::remove_dir_all(oversized_root).expect("remove oversized scheduler status root");

    let pid_root = temp_root("scheduler-status-invalid-pid");
    let pid_state = pid_root.join("state");
    fs::create_dir_all(&pid_state).expect("create invalid PID state");
    fs::write(pid_state.join("juno-daemon.pid"), b"not-a-pid\n")
      .expect("write invalid PID");
    assert!(get_scheduler_status_at(&pid_root).is_err());
    fs::remove_dir_all(pid_root).expect("remove invalid PID status root");

    let linked_root = temp_root("scheduler-status-linked-root");
    let external = temp_root("scheduler-status-external");
    fs::create_dir_all(&linked_root).expect("create linked status Workbench");
    fs::create_dir_all(&external).expect("create linked status external root");
    let state_link = linked_root.join("state");
    link_directory(&external, &state_link);
    assert!(get_scheduler_status_at(&linked_root).is_err());
    remove_directory_link(&state_link);
    fs::remove_dir_all(linked_root).expect("remove linked status Workbench");
    fs::remove_dir_all(external).expect("remove linked status external root");
  }

  #[test]
  fn daemon_lifecycle_lock_serializes_process_owners() {
    let root = temp_root("daemon-lifecycle-lock");
    fs::create_dir_all(root.join("state")).expect("create lifecycle state root");
    let owner = acquire_daemon_lifecycle_at_with_timeout(
      &root,
      "first-owner",
      Duration::from_secs(1),
    )
    .expect("first lifecycle owner");
    let contender_root = root.clone();
    let contender = thread::spawn(move || {
      acquire_daemon_lifecycle_at_with_timeout(
        &contender_root,
        "second-owner",
        Duration::from_millis(100),
      )
      .is_ok()
    });
    assert!(!contender.join().expect("join lifecycle contender"));
    drop(owner);
    let successor = acquire_daemon_lifecycle_at_with_timeout(
      &root,
      "successor",
      Duration::from_secs(1),
    )
    .expect("successor acquires released lifecycle lock");
    drop(successor);
    assert!(!root.join("state/juno-daemon.lifecycle.lock.json").exists());
    fs::remove_dir_all(root).expect("remove lifecycle fixture");
  }

  #[test]
  fn scheduler_start_exit_requires_recovery_or_a_valid_running_winner() {
    let stopped = SchedulerStatus {
      running: false,
      pid: None,
      enabled: false,
      runs_today: 0,
      last_action: None,
      last_tick_at: None,
      daemon_started_at: None,
    };
    let recovery = scheduler_start_exit_decision(stopped, helper_exit_status(5))
      .expect_err("exit 5 must require recovery");
    assert!(recovery.contains("explicit recovery"));

    let winner = SchedulerStatus {
      running: true,
      pid: Some(42),
      enabled: true,
      runs_today: 0,
      last_action: None,
      last_tick_at: None,
      daemon_started_at: Some("2026-07-20T00:00:00.000Z".to_string()),
    };
    let resolved = scheduler_start_exit_decision(winner, helper_exit_status(1))
      .expect("a complete valid winner makes lock contention idempotent");
    assert!(resolved.running);
  }

  #[test]
  fn scheduler_status_rejects_a_torn_v2_state_and_lease_pair() {
    let root = temp_root("scheduler-torn-v2-status");
    write_v2_scheduler_controls(
      &root,
      u32::MAX,
      "11111111-1111-4111-8111-111111111111",
      "running",
      true,
    );
    let lease_path = root.join("state/juno-daemon.lease.json");
    let mut lease: serde_json::Value =
      serde_json::from_slice(&fs::read(&lease_path).expect("read lease"))
        .expect("parse lease");
    lease["generation"] =
      serde_json::Value::String("22222222-2222-4222-8222-222222222222".to_string());
    fs::write(
      &lease_path,
      serde_json::to_vec_pretty(&lease).expect("serialize torn lease"),
    )
    .expect("write torn lease");
    let error = get_scheduler_status_at(&root).expect_err("torn controls must fail closed");
    assert!(error.contains("state and lease generations"));
    fs::remove_dir_all(root).expect("remove torn status fixture");
  }

  #[test]
  fn scheduler_stop_revalidates_v2_lease_before_any_termination() {
    let root = temp_root("scheduler-prekill-lease-revalidation");
    let daemon = SchedulerDaemon::new();
    write_v2_scheduler_controls(
      &root,
      u32::MAX,
      "33333333-3333-4333-8333-333333333333",
      "running",
      true,
    );
    let lease_path = root.join("state/juno-daemon.lease.json");
    let termination_boundary_crossed = Arc::new(AtomicBool::new(false));
    let termination_marker = Arc::clone(&termination_boundary_crossed);
    let result = stop_scheduler_daemon_at_with_hooks(
      &daemon,
      &root,
      || {
        let mut lease: serde_json::Value =
          serde_json::from_slice(&fs::read(&lease_path).expect("read original lease"))
            .expect("parse original lease");
        lease["generation"] =
          serde_json::Value::String("44444444-4444-4444-8444-444444444444".to_string());
        fs::remove_file(&lease_path).expect("remove original lease");
        fs::write(
          &lease_path,
          serde_json::to_vec_pretty(&lease).expect("serialize replacement lease"),
        )
        .expect("install replacement lease");
      },
      move || termination_marker.store(true, AtomicOrdering::SeqCst),
    );
    let error = result.expect_err("lease generation drift must abort before termination");
    assert!(error.contains("generations") || error.contains("before termination"));
    assert!(!termination_boundary_crossed.load(AtomicOrdering::SeqCst));
    fs::remove_dir_all(root).expect("remove prekill fixture");
  }

  #[test]
  fn scheduler_stop_preserves_blocked_v2_latches_with_and_without_an_owner() {
    let no_owner_root = temp_root("blocked-v2-no-owner");
    write_v2_scheduler_controls(
      &no_owner_root,
      std::process::id(),
      "55555555-5555-4555-8555-555555555555",
      "blocked",
      false,
    );
    stop_scheduler_daemon_at(&SchedulerDaemon::new(), &no_owner_root)
      .expect("blocked state without PID is already stopped");
    let no_owner_state: serde_json::Value = serde_json::from_slice(
      &fs::read(no_owner_root.join("state/juno-daemon.json"))
        .expect("read blocked no-owner state"),
    )
    .expect("parse blocked no-owner state");
    assert_eq!(no_owner_state["status"], "blocked");
    fs::remove_dir_all(no_owner_root).expect("remove blocked no-owner fixture");

    let owner_root = temp_root("blocked-v2-owner");
    let daemon = SchedulerDaemon::new();
    write_v2_scheduler_controls(
      &owner_root,
      u32::MAX,
      "66666666-6666-4666-8666-666666666666",
      "blocked",
      true,
    );
    stop_scheduler_daemon_at(&daemon, &owner_root).expect("stop blocked stale owner");
    assert!(!owner_root.join("state/juno-daemon.pid").exists());
    assert!(!owner_root.join("state/juno-daemon.lease.json").exists());
    let owner_state: serde_json::Value = serde_json::from_slice(
      &fs::read(owner_root.join("state/juno-daemon.json"))
        .expect("read blocked owner state"),
    )
    .expect("parse blocked owner state");
    assert_eq!(owner_state["status"], "blocked");
    fs::remove_dir_all(owner_root).expect("remove blocked owner fixture");
  }

  #[test]
  fn legacy_decimal_pid_remains_read_only_compatible() {
    let root = temp_root("legacy-decimal-status");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create legacy state root");
    fs::write(
      state_dir.join("juno-daemon.json"),
      br#"{"status":"running","startedAt":"2026-07-20T00:00:00.000Z","heartbeatAt":"2026-07-20T00:01:00.000Z"}"#,
    )
    .expect("write legacy state");
    fs::write(state_dir.join("juno-daemon.pid"), format!("{}\n", u32::MAX))
      .expect("write legacy decimal PID");
    let status = get_scheduler_status_at(&root).expect("read legacy decimal controls");
    assert!(status.enabled);
    assert!(!status.running);
    assert_eq!(
      status.last_tick_at.as_deref(),
      Some("2026-07-20T00:01:00.000Z")
    );
    fs::remove_dir_all(root).expect("remove legacy status fixture");
  }

  #[test]
  fn malformed_scheduler_state_is_unchanged_and_blocks_termination() {
    let root = temp_root("malformed-daemon-state");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create state");
    let state_path = state_dir.join("juno-daemon.json");
    let malformed = b"{ not-daemon-json\n";
    fs::write(&state_path, malformed).expect("write malformed daemon state");

    let daemon = SchedulerDaemon::new();
    let child = spawn_sleeper();
    let child_pid = child.id();
    *daemon.child.lock().expect("scheduler lock") = Some(child);

    let result = stop_scheduler_daemon_at(&daemon, &root);
    let child_was_alive = process_is_alive(child_pid);
    let preserved_state = fs::read(&state_path).expect("read malformed daemon state");
    let mut child = daemon
      .child
      .lock()
      .expect("scheduler lock")
      .take()
      .expect("owned child remains registered");
    terminate_and_reap_child(&mut child).expect("cleanup daemon fixture");
    let error = result.expect_err("malformed daemon state must fail before termination");
    assert!(error.contains("malformed"), "unexpected error: {error}");
    assert!(child_was_alive);
    assert_eq!(preserved_state, malformed);
    fs::remove_dir_all(root).expect("remove malformed daemon root");
  }

  #[test]
  fn scheduler_stop_preserves_a_new_post_termination_generation() {
    let root = temp_root("scheduler-new-generation");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create scheduler state root");
    let state_path = state_dir.join("juno-daemon.json");
    let pid_path = state_dir.join("juno-daemon.pid");

    let daemon = SchedulerDaemon::new();
    let child = spawn_sleeper();
    let child_pid = child.id();
    let old_state = br#"{"status":"running","startedAt":"2026-07-15T01:00:00.000Z"}"#;
    fs::write(&state_path, old_state).expect("write old daemon state");
    fs::write(&pid_path, format!("{child_pid}\n")).expect("write old daemon PID");
    *daemon.child.lock().expect("scheduler lock") = Some(child);

    let foreign_state =
      br#"{"status":"running","startedAt":"2026-07-15T02:00:00.000Z"}"#.to_vec();
    let foreign_pid = format!("{}\n", std::process::id()).into_bytes();
    let replacement_state = state_dir.join("replacement-state.json");
    let replacement_pid = state_dir.join("replacement.pid");
    fs::write(&replacement_state, &foreign_state).expect("write foreign daemon state");
    fs::write(&replacement_pid, &foreign_pid).expect("write foreign daemon PID");

    let error = stop_scheduler_daemon_at_with_hook(&daemon, &root, || {
      fs::remove_file(&state_path).expect("remove old state after termination");
      fs::rename(&replacement_state, &state_path).expect("install foreign daemon state");
      fs::remove_file(&pid_path).expect("remove old PID after termination");
      fs::rename(&replacement_pid, &pid_path).expect("install foreign daemon PID");
    })
    .expect_err("new daemon generation must abort old stop commit");
    assert!(error.contains("new scheduler daemon state generation"));
    assert!(!process_is_alive(child_pid));
    assert!(daemon.child.lock().expect("scheduler lock").is_none());
    assert_eq!(fs::read(&state_path).expect("read foreign state"), foreign_state);
    assert_eq!(fs::read(&pid_path).expect("read foreign PID"), foreign_pid);
    fs::remove_dir_all(root).expect("remove scheduler generation fixture");
  }

  #[test]
  fn scheduler_stop_binds_a_missing_generation_to_snapshot_identity() {
    let root = temp_root("scheduler-missing-generation");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create scheduler state root");
    let state_path = state_dir.join("juno-daemon.json");
    let replacement_state = state_dir.join("replacement-state.json");
    let state_bytes = br#"{"status":"running"}"#;
    fs::write(&state_path, state_bytes).expect("write generation-less daemon state");
    fs::write(&replacement_state, state_bytes).expect("write foreign generation-less state");
    let replacement_snapshot = read_bounded_control(
      &replacement_state,
      "Foreign scheduler daemon state",
      MAX_STATE_CONTROL_BYTES,
    )
    .expect("snapshot foreign generation-less state");

    let daemon = SchedulerDaemon::new();
    let child = spawn_sleeper();
    let child_pid = child.id();
    *daemon.child.lock().expect("scheduler lock") = Some(child);

    let error = stop_scheduler_daemon_at_with_hook(&daemon, &root, || {
      fs::remove_file(&state_path).expect("remove initial generation-less state");
      fs::rename(&replacement_state, &state_path)
        .expect("install foreign generation-less state");
    })
    .expect_err("a replacement without startedAt must still abort the old stop commit");
    assert!(error.contains("new scheduler daemon state generation"));
    assert!(!process_is_alive(child_pid));
    let final_snapshot = read_bounded_control(
      &state_path,
      "Scheduler daemon state",
      MAX_STATE_CONTROL_BYTES,
    )
    .expect("read preserved generation-less state");
    assert!(same_moved_control(&final_snapshot, &replacement_snapshot));
    fs::remove_dir_all(root).expect("remove missing generation fixture");
  }

  #[test]
  fn pid_claim_cleanup_preserves_a_replacement_target() {
    let root = temp_root("pid-claim-replacement");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create PID state root");
    let pid_path = state_dir.join("juno-daemon.pid");
    let replacement = state_dir.join("replacement.pid");
    fs::write(&pid_path, b"101\n").expect("write original PID");
    fs::write(&replacement, b"202\n").expect("write replacement PID");
    let expected = read_bounded_control(
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
    )
    .expect("read original PID snapshot");
    let canonical_root = fs::canonicalize(&root).expect("canonical Workbench");
    let canonical_state = fs::canonicalize(&state_dir).expect("canonical state root");

    let error = remove_control_snapshot_cas_with_hook(
      &canonical_root,
      &canonical_state,
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
      &expected,
      || {
        fs::remove_file(&pid_path).expect("remove original PID in race hook");
        fs::rename(&replacement, &pid_path).expect("install replacement PID in race hook");
      },
    )
    .expect_err("replacement PID must win the cleanup race");
    assert!(error.contains("changed during cleanup claim"));
    assert_eq!(fs::read(&pid_path).expect("read replacement PID"), b"202\n");
    read_bounded_control(
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
    )
    .expect("replacement PID remains exclusive");
    assert_eq!(
      fs::read_dir(&state_dir)
        .expect("read PID state root")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("preimage"))
        .count(),
      0
    );
    fs::remove_dir_all(root).expect("remove PID race fixture");
  }

  #[test]
  fn pid_final_cleanup_preserves_a_replacement_target() {
    let root = temp_root("pid-final-replacement");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create PID state root");
    let pid_path = state_dir.join("juno-daemon.pid");
    let replacement = state_dir.join("replacement.pid");
    fs::write(&pid_path, b"303\n").expect("write original PID");
    fs::write(&replacement, b"404\n").expect("write replacement PID");
    let expected = read_bounded_control(
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
    )
    .expect("read original PID snapshot");
    let canonical_root = fs::canonicalize(&root).expect("canonical Workbench");
    let canonical_state = fs::canonicalize(&state_dir).expect("canonical state root");

    let error = remove_control_snapshot_cas_with_hooks(
      &canonical_root,
      &canonical_state,
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
      &expected,
      || {},
      || {
        fs::remove_file(&pid_path).expect("remove expected PID in final hook");
        fs::rename(&replacement, &pid_path).expect("install foreign PID in final hook");
      },
    )
    .expect_err("foreign final PID replacement must survive");
    assert!(error.contains("foreign replacement was preserved"));
    assert_eq!(fs::read(&pid_path).expect("read foreign PID"), b"404\n");
    read_bounded_control(
      &pid_path,
      "Scheduler daemon PID",
      MAX_PID_CONTROL_BYTES,
    )
    .expect("foreign PID remains exclusive");
    assert_eq!(
      fs::read_dir(&state_dir)
        .expect("read PID state root")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("preimage"))
        .count(),
      0
    );
    fs::remove_dir_all(root).expect("remove final PID race fixture");
  }

  #[test]
  fn stale_pid_does_not_prevent_owned_daemon_shutdown() {
    let root = temp_root("stale-daemon-pid");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create state");
    fs::write(state_dir.join("juno-daemon.pid"), u32::MAX.to_string()).expect("write stale pid");
    fs::write(state_dir.join("juno-daemon.json"), r#"{"status":"running"}"#)
      .expect("write daemon state");

    let daemon = SchedulerDaemon::new();
    let child = spawn_sleeper();
    let child_pid = child.id();
    *daemon.child.lock().expect("scheduler lock") = Some(child);

    stop_scheduler_daemon_at(&daemon, &root).expect("stop with stale pid");
    assert!(!process_is_alive(child_pid));
    assert!(daemon.child.lock().expect("scheduler lock").is_none());
    assert!(!state_dir.join("juno-daemon.pid").exists());
    let state = fs::read_to_string(state_dir.join("juno-daemon.json")).expect("read state");
    assert!(state.contains(r#""status": "stopped""#));
    fs::remove_dir_all(root).expect("remove stale pid root");
  }

  #[test]
  fn live_external_legacy_pid_blocks_all_termination() {
    let root = temp_root("wrong-daemon-pid");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create state");
    fs::write(
      state_dir.join("juno-daemon.pid"),
      std::process::id().to_string(),
    )
    .expect("write wrong pid");

    let daemon = SchedulerDaemon::new();
    let child = spawn_sleeper();
    let child_pid = child.id();
    *daemon.child.lock().expect("scheduler lock") = Some(child);

    let result = stop_scheduler_daemon_at(&daemon, &root);
    let child_was_alive = process_is_alive(child_pid);
    let mut child = daemon
      .child
      .lock()
      .expect("scheduler lock")
      .take()
      .expect("owned child remains registered");
    terminate_and_reap_child(&mut child).expect("cleanup owned child fixture");
    let error = result.expect_err("reject unrelated pid");
    assert!(error.contains("external legacy scheduler PID"));
    assert!(child_was_alive);
    fs::remove_dir_all(root).expect("remove wrong pid root");
  }
}
