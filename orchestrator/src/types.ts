export type RunKind = "implement" | "review" | "verify" | "debate" | "vote";
export type RepoTarget = "workbench" | "juno-overseer";
export type AgentProvider = "api_token" | "cursor_composer" | "openai_codex";
export type WorkflowExperimentArm = "baseline" | "candidate";

export interface RunManifest {
  runId: string;
  horizon: "day" | "mission";
  missionId?: string;
  phaseId?: string;
  runKind?: RunKind;
  repoRoot?: RepoTarget;
  provider: AgentProvider;
  providerRef?: string;
  model?: string;
  promptTemplate: string;
  cwd: string;
  maxMinutes: number;
  maxRetries: number;
  allowedTools?: string[];
  outputDir?: string;
  successCriteria?: string;
  workflowId?: string;
  evalProfile?: "code" | "ui" | "literature" | "orchestrator";
  experimentId?: string;
  experimentArm?: WorkflowExperimentArm;
  experimentEpisode?: number;
  sourcePhaseId?: string;
  experimentFixtureSha256?: string;
  experimentPromptSha256?: string;
  revisionOf?: string;
  revisionAttempt?: number;
}

export interface QueueItem {
  id: string;
  horizon: "day" | "mission";
  kind: string;
  run_kind?: RunKind;
  repo_target?: RepoTarget;
  prompt: string;
  provider?: AgentProvider;
  max_minutes?: number;
  mission_id?: string;
  phase_id?: string;
  success_criteria?: string;
  depends_on?: string;
  workflow_id?: string;
  eval_profile?: "code" | "ui" | "literature" | "orchestrator";
  allowed_tools?: string[];
  experiment_id?: string;
  experiment_arm?: WorkflowExperimentArm;
  experiment_episode?: number;
  source_phase_id?: string;
  experiment_fixture_sha256?: string;
  experiment_prompt_sha256?: string;
  revision_of?: string;
  revision_attempt?: number;
  /** Optional provider model override for this slot. */
  model?: string;
}

export interface RunState {
  retryCount: number;
  slotIndex: number;
  maxRetries: number;
  lastStatus?: string;
  updatedAt?: string;
}

interface ExecutionAttemptEventBinding {
  attemptId?: string;
  slotIndex?: number;
  retryCount?: number;
}

export type RunEvent =
  | ({ ts: string; type: "status"; status: string; detail?: string } & ExecutionAttemptEventBinding)
  | { ts: string; type: "assistant"; text: string; partial?: boolean }
  | { ts: string; type: "finished"; status: string; result?: string; model?: string }
  | { ts: string; type: "error"; message: string; retryable?: boolean }
  | ({
      ts: string;
      type: "tool_call";
      tool: string;
      args?: string;
      ok?: boolean;
      stepId?: string;
      phase?: "started" | "completed";
    } & ExecutionAttemptEventBinding);

export interface SchedulerState {
  enabled: boolean;
  daemonStartedAt?: string;
  lastTickAt?: string;
  runsToday: number;
  lastRunId?: string;
  lastAction?: string;
  missionInjectIntervalMin: number;
  lastMissionInjectAt?: string;
}

export interface MissionPhase {
  id: string;
  goal: string;
  status: string;
}

export interface MissionSummary {
  id: string;
  title: string;
  status: string;
  provider: string;
  currentPhaseId?: string;
  phases: MissionPhase[];
  progressExcerpt?: string;
}
