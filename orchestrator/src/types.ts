export type RunKind = "implement" | "review" | "verify" | "debate" | "vote";
export type RepoTarget = "workbench" | "juno-overseer";

export interface RunManifest {
  runId: string;
  horizon: "day" | "mission";
  missionId?: string;
  phaseId?: string;
  runKind?: RunKind;
  repoRoot?: RepoTarget;
  provider: "api_token" | "cursor_composer";
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
}

export interface QueueItem {
  id: string;
  horizon: "day" | "mission";
  kind: string;
  run_kind?: RunKind;
  repo_target?: RepoTarget;
  prompt: string;
  provider?: "api_token" | "cursor_composer";
  max_minutes?: number;
  mission_id?: string;
  phase_id?: string;
  success_criteria?: string;
  depends_on?: string;
  workflow_id?: string;
  eval_profile?: "code" | "ui" | "literature" | "orchestrator";
  allowed_tools?: string[];
}

export interface RunState {
  retryCount: number;
  slotIndex: number;
  maxRetries: number;
  lastStatus?: string;
  updatedAt?: string;
}

export type RunEvent =
  | { ts: string; type: "status"; status: string; detail?: string }
  | { ts: string; type: "assistant"; text: string; partial?: boolean }
  | { ts: string; type: "finished"; status: string; result?: string }
  | { ts: string; type: "error"; message: string; retryable?: boolean };

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
