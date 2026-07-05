/**
 * NL brief → mission scaffold (v0 heuristics; Live slot refines in juno-nl-brief-2026).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { saveNowQueue, parseNowYaml } from "./queue-io.js";
import type { QueueItem } from "./types.js";

export type BriefSchedule = "once" | "daily" | "perpetual";

export interface BriefPlan {
  missionId: string;
  title: string;
  schedule: BriefSchedule;
  northStar: string;
  scopeLock: string;
  phases: Array<{ phaseId: string; kind: "implement" | "review" | "verify"; criteria: string }>;
  autoPush: boolean;
  needsMcp: boolean;
  tags: string[];
  sourceText: string;
  createdAt: string;
}

export interface PendingBrief {
  text: string;
  submittedAt: string;
  source?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function inferSchedule(text: string): BriefSchedule {
  const t = text.toLowerCase();
  if (/每天|每日|daily|0\s*点|inbox|次日删|morning brief/.test(t)) return "daily";
  if (/一直|永续|daemon|自治|always/.test(t)) return "perpetual";
  return "once";
}

export function inferTags(text: string): string[] {
  const tags: string[] = [];
  const t = text.toLowerCase();
  if (/wisdomechoes|博客|blog/.test(t)) tags.push("wisdomechoes");
  if (/mcp|硬件|开发板|serial|esp32|stm32|arduino|gpio/.test(t)) tags.push("hardware-mcp");
  if (/push|提交|git|deploy/.test(t)) tags.push("auto-push");
  if (/赚钱|revenue|产品|saas|客户/.test(t)) tags.push("revenue");
  if (/juno|runtime|overseer/.test(t)) tags.push("juno-runtime");
  return tags;
}

export function compileBriefFromText(text: string, opts: { missionId?: string } = {}): BriefPlan {
  const schedule = inferSchedule(text);
  const tags = inferTags(text);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = slugify(text.slice(0, 40)) || "task";
  const missionId = opts.missionId ?? `juno-brief-${date}-${slug}`.slice(0, 48);

  const autoPush = tags.includes("auto-push") || /push|推送|commit/.test(text);
  const needsMcp = tags.includes("hardware-mcp") || /\bmcp\b/i.test(text);

  const phases: BriefPlan["phases"] = [
    {
      phaseId: "p01-plan",
      kind: "implement",
      criteria: "Read brief + scope-lock; write execution plan in checkpoint CHANGES",
    },
    {
      phaseId: "p02-implement",
      kind: "implement",
      criteria: "Implement per north-star; minimal diff; record CHANGES",
    },
  ];

  if (needsMcp) {
    phases.push({
      phaseId: "p02b-mcp",
      kind: "implement",
      criteria: "Discover existing MCP in config; if missing scaffold mcp-servers/* and register config/mcp-servers.json",
    });
  }

  phases.push(
    {
      phaseId: "p03-review",
      kind: "review",
      criteria: "REVIEW_VERDICT PASS — drift/scope check",
    },
    {
      phaseId: "p04-verify",
      kind: "verify",
      criteria: "VERIFY_REPORT — tests/build as applicable; auto-push if enabled",
    },
  );

  const northStar = `# North Star — ${missionId}

**来源**：自然语言 brief（${new Date().toISOString().slice(0, 10)}）

## 用户意图

${text.trim()}

## 调度

- **schedule**: \`${schedule}\`
- **autoPush**: ${autoPush}
- **needsMcp**: ${needsMcp}
- **tags**: ${tags.join(", ") || "general"}

## 完成定义

- [ ] 意图在 scope-lock 内实现
- [ ] p03 REVIEW_VERDICT PASS
- [ ] p04 VERIFY_REPORT PASS
- [ ] mission STATUS: COMPLETE
${autoPush ? "- [ ] git push 成功（见 config/auto-push.json）\n" : ""}
`;

  const scopeLock = `# Scope Lock — ${missionId}

## 允许

- 由 brief 推断的路径（implement 前须列出 CHANGES 路径）
- \`mcp-servers/**\`（若 needsMcp）
- Juno / WisdomEchoes 仓库内（config.yaml 真源路径）

## 禁止

- \`git push --force\`
- Obsidian Vault 除 \`Juno/**\`
- 破坏性 shell（§11）

## Brief 原文

${text.trim()}
`;

  return {
    missionId,
    title: text.split("\n")[0]?.slice(0, 80) ?? missionId,
    schedule,
    northStar,
    scopeLock,
    phases,
    autoPush,
    needsMcp,
    tags,
    sourceText: text,
    createdAt: new Date().toISOString(),
  };
}

export function pendingBriefPath(workbench: string): string {
  return path.join(workbench, "state", "pending-brief.json");
}

export function savePendingBrief(workbench: string, brief: PendingBrief): void {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(pendingBriefPath(workbench), `${JSON.stringify(brief, null, 2)}\n`, "utf8");
}

export function loadPendingBrief(workbench: string): PendingBrief | null {
  const p = pendingBriefPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PendingBrief;
  } catch {
    return null;
  }
}

export function clearPendingBrief(workbench: string): void {
  const p = pendingBriefPath(workbench);
  if (existsSync(p)) writeFileSync(p, "{}\n", "utf8");
}

export function writeBriefMission(workbench: string, plan: BriefPlan): string {
  const missionDir = path.join(workbench, "missions", plan.missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(path.join(missionDir, "north-star.md"), plan.northStar, "utf8");
  writeFileSync(path.join(missionDir, "scope-lock.md"), plan.scopeLock, "utf8");

  const progressLines = [
    "# Mission Progress — " + plan.missionId,
    "",
    "| Phase | Kind | Status |",
    "|-------|------|--------|",
    ...plan.phases.map((p) => `| ${p.phaseId} | ${p.kind} | queued |`),
    "",
  ];
  writeFileSync(path.join(missionDir, "progress.md"), progressLines.join("\n"), "utf8");

  const now: QueueItem[] = plan.phases.map((p) => ({
    id: `${plan.missionId}-${p.phaseId}`,
    horizon: "mission",
    kind: p.kind,
    run_kind: p.kind,
    repo_target: "juno-overseer",
    mission_id: plan.missionId,
    phase_id: p.phaseId,
    prompt: p.kind === "implement" ? "executor_implement" : p.kind === "review" ? "executor_review" : "executor_verify",
    provider: "cursor_composer",
    max_minutes: 60,
    success_criteria: p.criteria,
  }));

  const { backlog } = parseNowYaml(workbench);
  saveNowQueue(workbench, now, backlog);

  const planPath = path.join(workbench, "state", "last-brief-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return missionDir;
}

export function routeBriefToKnownMission(text: string): string | null {
  const t = text.toLowerCase();
  if (/wisdomechoes|两篇.*ai|growing-from-axioms|juno-min-agi/.test(t)) {
    return "juno-wisdomechoes-axiom-blog-2026";
  }
  if (/daily.inbox|每日任务|inbox.*juno/.test(t)) return "juno-daily-inbox-2026";
  if (/开发板|两块板|serial|esp32|stm32|hardware|gpio|外接硬件/.test(t)) {
    return "juno-hardware-mcp-2026";
  }
  if (/100.*论文|drive.*research|好奇心|野心|自主性|自我思维|agent.?mind/.test(t)) {
    return "juno-agent-drive-research-2026";
  }
  if (/nl.brief|自然语言.*mission|brief.*compiler/.test(t)) return "juno-nl-brief-2026";
  return null;
}
