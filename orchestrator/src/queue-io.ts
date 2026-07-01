import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "./env.js";
import type { QueueItem } from "./types.js";

function yamlQuote(value: string | number | undefined): string {
  if (value == null || value === "") return '""';
  const s = String(value);
  if (/^[a-zA-Z0-9_./+-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatQueueItem(item: QueueItem): string {
  const lines = [`  - id: ${yamlQuote(item.id)}`];
  const fields: Array<[keyof QueueItem, string]> = [
    ["horizon", "horizon"],
    ["kind", "kind"],
    ["run_kind", "run_kind"],
    ["repo_target", "repo_target"],
    ["mission_id", "mission_id"],
    ["phase_id", "phase_id"],
    ["prompt", "prompt"],
    ["provider", "provider"],
    ["success_criteria", "success_criteria"],
    ["workflow_id", "workflow_id"],
    ["eval_profile", "eval_profile"],
    ["depends_on", "depends_on"],
  ];
  for (const [key, label] of fields) {
    const val = item[key];
    if (val == null || val === "") continue;
    lines.push(`    ${label}: ${yamlQuote(String(val))}`);
  }
  if (item.max_minutes != null) {
    lines.push(`    max_minutes: ${item.max_minutes}`);
  }
  return lines.join("\n");
}

export function saveNowQueue(
  workbench: string,
  now: QueueItem[],
  backlog: QueueItem[] = [],
): void {
  const lines = [`updated: ${nowIso()}`, "now:"];
  if (now.length === 0) {
    lines.push("  []");
  } else {
    for (const item of now) lines.push(formatQueueItem(item));
  }
  lines.push("backlog:");
  if (backlog.length === 0) {
    lines.push("  []");
  } else {
    for (const item of backlog) lines.push(formatQueueItem(item));
  }
  writeFileSync(path.join(workbench, "queue/now.yaml"), `${lines.join("\n")}\n`, "utf8");
}

export function parseNowYaml(workbench: string): { now: QueueItem[]; backlog: QueueItem[] } {
  const file = path.join(workbench, "queue/now.yaml");
  if (!existsSync(file)) return { now: [], backlog: [] };
  const text = readFileSync(file, "utf8");
  const sections: Record<"now" | "backlog", QueueItem[]> = { now: [], backlog: [] };
  let section: "now" | "backlog" = "now";
  let item: Partial<QueueItem> | null = null;

  const pushItem = () => {
    if (item?.id) sections[section].push(item as QueueItem);
    item = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("now:")) {
      pushItem();
      section = "now";
      continue;
    }
    if (line.startsWith("backlog:")) {
      pushItem();
      section = "backlog";
      continue;
    }
    const listId = line.match(/^\s*-\s*id:\s*(.+)$/);
    if (listId) {
      pushItem();
      item = {
        id: listId[1].trim().replace(/^["']|["']$/g, ""),
        horizon: "day",
        kind: "task",
        prompt: "executor_generic",
      };
      continue;
    }
    if (!item) continue;
    const m = line.match(/^\s{2,}([a-z_]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim().replace(/^["']|["']$/g, "");
    if (key === "horizon") item.horizon = val as QueueItem["horizon"];
    if (key === "kind") item.kind = val;
    if (key === "run_kind") item.run_kind = val as QueueItem["run_kind"];
    if (key === "repo_target") item.repo_target = val as QueueItem["repo_target"];
    if (key === "prompt") item.prompt = val;
    if (key === "provider") item.provider = val as QueueItem["provider"];
    if (key === "max_minutes") item.max_minutes = Number(val);
    if (key === "mission_id") item.mission_id = val;
    if (key === "phase_id") item.phase_id = val;
    if (key === "success_criteria") item.success_criteria = val;
    if (key === "workflow_id") item.workflow_id = val;
    if (key === "eval_profile") item.eval_profile = val as QueueItem["eval_profile"];
    if (key === "depends_on") item.depends_on = val;
  }
  pushItem();
  return { now: sections.now, backlog: sections.backlog };
}
