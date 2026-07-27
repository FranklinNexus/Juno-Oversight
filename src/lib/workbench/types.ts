export type QueueHorizon = "day" | "mission";

export type QueueItem = {
  id: string;
  horizon: QueueHorizon;
  kind: string;
  prompt: string;
  provider?: string;
  max_minutes?: number;
  mission_id?: string;
  phase_id?: string;
  status?: "queued" | "running" | "done" | "failed";
};

export type WorkbenchSnapshot = {
  rootConfigured: boolean;
  rootPath: string | null;
  queue: QueueItem[];
  dailyExcerpt: string | null;
  dailyTitle: string | null;
  activeRunId: string | null;
  activeRunStatus: "idle" | "running" | "stall" | "done" | "failed";
  updatedAt: string;
};

export type WorkflowEffectMetrics = {
  date: string;
  ticks: number;
  capFilled: boolean;
  escalations: number;
  strategy: string;
  topMission: string;
  queueHead: boolean;
  idleAction: string;
  missionDone: number;
  verifyPass: number;
  reviewRework: number;
  reviewBlock: number;
  verifyPassRate: number | null;
  reworkRate: number | null;
};

export type WorkflowEffectSnapshot = {
  available: boolean;
  version: number;
  generatedAt: string | null;
  latest: WorkflowEffectMetrics | null;
};

export const EMPTY_WORKFLOW_EFFECT: WorkflowEffectSnapshot = {
  available: false,
  version: 1,
  generatedAt: null,
  latest: null,
};

export const EMPTY_WORKBENCH: WorkbenchSnapshot = {
  rootConfigured: false,
  rootPath: null,
  queue: [],
  dailyExcerpt: null,
  dailyTitle: null,
  activeRunId: null,
  activeRunStatus: "idle",
  updatedAt: "",
};
