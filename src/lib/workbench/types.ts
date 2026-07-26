export type QueueHorizon = "day" | "mission";

type QueueExperimentMetadata =
  | {
      experiment_id?: never;
      experiment_arm?: never;
      experiment_episode?: never;
      source_phase_id?: never;
      experiment_fixture_sha256?: never;
      experiment_prompt_sha256?: never;
    }
  | {
      workflow_id: string;
      mission_id: string;
      phase_id: string;
      experiment_id: string;
      experiment_arm: "baseline" | "candidate";
      experiment_episode: number;
      source_phase_id: string;
      experiment_fixture_sha256: string;
      experiment_prompt_sha256: string;
    };

type QueueRevisionMetadata =
  | { revision_of?: never; revision_attempt?: never }
  | { revision_of: string; revision_attempt: number };

export type QueueItem = {
  id: string;
  horizon: QueueHorizon;
  kind: string;
  prompt: string;
  provider?: string;
  max_minutes?: number;
  mission_id?: string;
  phase_id?: string;
  workflow_id?: string;
  status?: "queued" | "running" | "done" | "failed" | "blocked";
} & QueueExperimentMetadata & QueueRevisionMetadata;

export type RuntimeSource = "tauri" | "demo" | "unavailable";

export type DaemonSnapshot = {
  status: string;
  blockedReason: string | null;
  evidenceReason: string | null;
  updatedAt: string | null;
  pid: number | null;
  lastExit: number | null;
  lastDetail: string | null;
  receiptState: string | null;
  artifactsReady: boolean | null;
};

export type WorkbenchDaemonsSnapshot = {
  juno: DaemonSnapshot;
  agi: DaemonSnapshot;
  book: DaemonSnapshot;
};

export type WorkbenchSnapshot = {
  source: RuntimeSource;
  error: string | null;
  rootConfigured: boolean;
  rootPath: string | null;
  queue: QueueItem[];
  dailyExcerpt: string | null;
  dailyTitle: string | null;
  activeRunId: string | null;
  activeRunStatus: "idle" | "running" | "stall" | "done" | "failed" | "blocked";
  daemons: WorkbenchDaemonsSnapshot;
  updatedAt: string;
};

export type RecoveryDomain =
  | "control_plane"
  | "queue"
  | "workflow_selection"
  | "completion";

export type RecoveryConfidence = "proven" | "ambiguous" | "invalid";
export type OperatorRecoveryAction = "resume_exact_intent";

export type RecoveryFileIdentity = {
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

export type RecoveryArtifact = {
  relativePath: string;
  entryKind: "file" | "directory" | "symlink" | "other" | "missing";
  identity: RecoveryFileIdentity | null;
  byteLength: number | null;
  sha256: string | null;
  validation:
    | "stable_file"
    | "unexpected_link_count"
    | "oversized"
    | "non_file"
    | "unreadable";
  detail?: string;
};

export type RecoveryCompletionBinding = {
  missionId: string;
  terminalRunId: string;
  expectedHeadFingerprint: string;
  intentSha256: string;
  expectedReceipt: {
    receiptVersion: 1;
    missionId: string;
    terminalRunId: string;
    runCheckpointSha256: string;
    evidenceVersion: string;
    completedAt: string;
  };
};

export type RecoveryIncident = {
  incidentId: string;
  domain: RecoveryDomain;
  kind: string;
  blocking: true;
  confidence: RecoveryConfidence;
  artifact: RecoveryArtifact;
  detail: string;
  completionBinding?: RecoveryCompletionBinding;
  allowedActions: OperatorRecoveryAction[];
  preconditionSha256: string;
};

export type RecoveryInventory = {
  inventoryVersion: 1;
  observedAt: string;
  workbench: string;
  controls: {
    queue: RecoveryArtifact | null;
    workflowSelection: RecoveryArtifact | null;
  };
  incidents: RecoveryIncident[];
  inventorySha256: string;
};

export type OperatorRecoveryResult = {
  operationId: string;
  incidentId: string;
  action: OperatorRecoveryAction;
  reason: string;
  recovery: {
    status: "none" | "recovered" | "busy" | "blocked";
    recovered: Array<{
      missionId: string;
      terminalRunId: string;
      mode: "dequeued_head" | "head_already_absent";
    }>;
    reason?: string;
  };
};

function unavailableDaemon(status = "unavailable"): DaemonSnapshot {
  return {
    status,
    blockedReason: null,
    evidenceReason: null,
    updatedAt: null,
    pid: null,
    lastExit: null,
    lastDetail: null,
    receiptState: null,
    artifactsReady: null,
  };
}

export const EMPTY_WORKBENCH: WorkbenchSnapshot = {
  source: "unavailable",
  error: null,
  rootConfigured: false,
  rootPath: null,
  queue: [],
  dailyExcerpt: null,
  dailyTitle: null,
  activeRunId: null,
  activeRunStatus: "idle",
  daemons: {
    juno: unavailableDaemon(),
    agi: unavailableDaemon(),
    book: unavailableDaemon(),
  },
  updatedAt: new Date().toISOString(),
};

/** Explicit browser-only demo; the Tauri runtime never falls back to this snapshot. */
export const DEMO_WORKBENCH: WorkbenchSnapshot = {
  source: "demo",
  error: null,
  rootConfigured: false,
  rootPath: null,
  queue: [
    {
      id: "demo-jinstone-001",
      horizon: "day",
      kind: "jinstone",
      prompt: "executor_jinstone",
      provider: "openai_codex",
      max_minutes: 25,
      status: "queued",
    },
    {
      id: "demo-site-pages",
      horizon: "mission",
      kind: "web",
      prompt: "executor_generic",
      mission_id: "landing-site-2026",
      phase_id: "pages",
      provider: "openai_codex",
      max_minutes: 25,
      status: "running",
    },
  ],
  dailyExcerpt:
    "## 今日完成\n- （Demo）等待 AgentWorkbench 路径配置\n\n## 阻塞\n- 配置 `E:\\\\AgentWorkbench` 后由 Tauri 读取",
  dailyTitle: "Agent Daily · Demo",
  activeRunId: "demo-site-pages",
  activeRunStatus: "running",
  daemons: {
    juno: unavailableDaemon("demo"),
    agi: unavailableDaemon("demo"),
    book: unavailableDaemon("demo"),
  },
  updatedAt: new Date().toISOString(),
};

const DEMO_RECOVERY_SHA = "d".repeat(64);

export const EMPTY_RECOVERY_INVENTORY: RecoveryInventory = {
  inventoryVersion: 1,
  observedAt: new Date().toISOString(),
  workbench: "",
  controls: { queue: null, workflowSelection: null },
  incidents: [],
  inventorySha256: "0".repeat(64),
};

/** Browser-only recovery fixture. Desktop recovery always comes from the signed runtime helper. */
export const DEMO_RECOVERY_INVENTORY: RecoveryInventory = {
  inventoryVersion: 1,
  observedAt: new Date().toISOString(),
  workbench: "E:\\AgentWorkbench (demo)",
  controls: { queue: null, workflowSelection: null },
  incidents: [
    {
      incidentId: DEMO_RECOVERY_SHA,
      domain: "completion",
      kind: "completion_pending_intent",
      blocking: true,
      confidence: "proven",
      artifact: {
        relativePath: `state/mission-completion-transactions/${DEMO_RECOVERY_SHA}.json`,
        entryKind: "file",
        identity: null,
        byteLength: 1240,
        sha256: DEMO_RECOVERY_SHA,
        validation: "stable_file",
      },
      detail: "Demo: strict immutable completion intent is pending reconciliation",
      completionBinding: {
        missionId: "demo-mission",
        terminalRunId: "demo-verify",
        expectedHeadFingerprint: DEMO_RECOVERY_SHA,
        intentSha256: DEMO_RECOVERY_SHA,
        expectedReceipt: {
          receiptVersion: 1,
          missionId: "demo-mission",
          terminalRunId: "demo-verify",
          runCheckpointSha256: DEMO_RECOVERY_SHA,
          evidenceVersion: "ordinary-verify-v1",
          completedAt: "2026-07-15T00:00:00.000Z",
        },
      },
      allowedActions: ["resume_exact_intent"],
      preconditionSha256: DEMO_RECOVERY_SHA,
    },
  ],
  inventorySha256: DEMO_RECOVERY_SHA,
};
