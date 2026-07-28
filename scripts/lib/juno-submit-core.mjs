import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { quietSpawnOpts } from "./win-spawn.mjs";

const KNOWN_BOOTSTRAPS = {
  "juno-wisdomechoes-axiom-blog-2026": "bootstrap-wisdomechoes-blog.mjs",
  "juno-daily-inbox-2026": "bootstrap-daily-inbox.mjs",
  "juno-hardware-mcp-2026": "bootstrap-hardware-mcp.mjs",
  "juno-agent-drive-research-2026": "bootstrap-agent-drive-research.mjs",
  "juno-nl-brief-2026": "bootstrap-nl-brief.mjs",
};

export async function submitBrief(options) {
  const {
    repoRoot,
    workbench,
    text,
    source = "juno-control",
    spawn = spawnSync,
  } = options;
  const missionBriefUrl = pathToFileURL(
    path.join(repoRoot, "orchestrator", "dist", "mission-brief.js"),
  ).href;
  const mcpProvisionUrl = pathToFileURL(
    path.join(repoRoot, "orchestrator", "dist", "mcp-provision.js"),
  ).href;
  const {
    clearPendingBrief,
    compileBriefFromText,
    routeBriefToKnownMission,
    savePendingBrief,
    writeBriefMission,
  } = await import(missionBriefUrl);
  const { provisionMcpForBrief } = await import(mcpProvisionUrl);

  savePendingBrief(workbench, {
    text,
    submittedAt: new Date().toISOString(),
    source,
  });

  const knownMissionId = routeBriefToKnownMission(text);
  if (knownMissionId) {
    const bootstrap = KNOWN_BOOTSTRAPS[knownMissionId];
    if (!bootstrap) throw new Error(`No bootstrap registered for known mission ${knownMissionId}`);
    const result = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", bootstrap), "--force-queue"],
      quietSpawnOpts(repoRoot, { encoding: "utf8" }),
    );
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `Known mission bootstrap failed (${knownMissionId}): ${String(result.stderr ?? "").trim()}`,
      );
    }
    writeFileSync(
      path.join(workbench, "state", "last-brief-plan.json"),
      `${JSON.stringify({
        missionId: knownMissionId,
        sourceText: text,
        createdAt: new Date().toISOString(),
        route: "known",
      }, null, 2)}\n`,
      "utf8",
    );
    clearPendingBrief(workbench);
    return {
      action: "route_known",
      missionId: knownMissionId,
      phaseTotal: null,
      schedule: null,
      autoPush: null,
      needsMcp: null,
    };
  }

  const plan = compileBriefFromText(text);
  const mcp = plan.needsMcp ? provisionMcpForBrief(repoRoot, workbench, text) : null;
  const missionDir = writeBriefMission(workbench, plan);
  clearPendingBrief(workbench);
  return {
    action: "compile",
    missionId: plan.missionId,
    missionDir,
    phaseTotal: plan.phases.length,
    schedule: plan.schedule,
    autoPush: plan.autoPush,
    needsMcp: plan.needsMcp,
    mcp,
  };
}
