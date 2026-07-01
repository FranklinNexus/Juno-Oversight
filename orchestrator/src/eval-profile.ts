export type EvalProfile = "code" | "ui" | "literature" | "orchestrator";

export interface VerifyStep {
  label: string;
  cmd: string;
  args: string[];
  optional?: boolean;
}

const PROFILES: Record<EvalProfile, VerifyStep[]> = {
  code: [
    { label: "pnpm test", cmd: "pnpm", args: ["test"] },
    { label: "check-orchestrator-deps", cmd: "node", args: ["scripts/check-orchestrator-deps.mjs"] },
    { label: "ui_smoke", cmd: "pnpm", args: ["ui:smoke"], optional: true },
  ],
  ui: [
    { label: "pnpm test", cmd: "pnpm", args: ["test"] },
    { label: "check-orchestrator-deps", cmd: "node", args: ["scripts/check-orchestrator-deps.mjs"] },
    { label: "ui_smoke", cmd: "pnpm", args: ["ui:smoke"] },
  ],
  literature: [
    { label: "pnpm test", cmd: "pnpm", args: ["test"] },
    { label: "check-orchestrator-deps", cmd: "node", args: ["scripts/check-orchestrator-deps.mjs"] },
  ],
  orchestrator: [
    { label: "pnpm test", cmd: "pnpm", args: ["test"] },
    { label: "orchestrator:build", cmd: "pnpm", args: ["orchestrator:build"] },
    { label: "check-orchestrator-deps", cmd: "node", args: ["scripts/check-orchestrator-deps.mjs"] },
  ],
};

export function normalizeEvalProfile(raw: string | undefined): EvalProfile {
  if (raw === "ui" || raw === "literature" || raw === "orchestrator") return raw;
  return "code";
}

export function verifyStepsForProfile(profile: EvalProfile): VerifyStep[] {
  return PROFILES[profile];
}

export function evalProfileFromWorkflow(workflowId: string | undefined): EvalProfile {
  if (workflowId === "self-iterate" || workflowId === "meta-loop" || workflowId === "self-iterate-p1" || workflowId === "self-iterate-p2") {
    return "orchestrator";
  }
  if (workflowId === "default") return "code";
  return "code";
}
