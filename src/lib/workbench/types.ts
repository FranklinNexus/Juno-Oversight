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

export const EMPTY_WORKBENCH: WorkbenchSnapshot = {
  rootConfigured: false,
  rootPath: null,
  queue: [],
  dailyExcerpt: null,
  dailyTitle: null,
  activeRunId: null,
  activeRunStatus: "idle",
  updatedAt: new Date().toISOString(),
};

/** Dev placeholder until Tauri `read_workbench_file` (P2). */
export const DEMO_WORKBENCH: WorkbenchSnapshot = {
  rootConfigured: false,
  rootPath: null,
  queue: [
    {
      id: "demo-jinstone-001",
      horizon: "day",
      kind: "jinstone",
      prompt: "executor_jinstone",
      provider: "cursor_composer",
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
      provider: "cursor_composer",
      max_minutes: 25,
      status: "running",
    },
  ],
  dailyExcerpt:
    "## 今日完成\n- （Demo）等待 AgentWorkbench 路径配置\n\n## 阻塞\n- 配置 `E:\\\\AgentWorkbench` 后由 Tauri 读取",
  dailyTitle: "Agent Daily · Demo",
  activeRunId: "demo-site-pages",
  activeRunStatus: "running",
  updatedAt: new Date().toISOString(),
};
