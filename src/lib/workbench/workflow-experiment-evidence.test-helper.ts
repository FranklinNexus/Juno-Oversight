import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  executionAttemptBinding,
  verifyStepId,
} from "../../../orchestrator/src/execution-artifact.js";
import {
  normalizeEvalProfile,
  verifyStepsForProfile,
  type VerifyStep,
} from "../../../orchestrator/src/eval-profile.js";
import {
  materializeQueueRun,
  saveRunState,
} from "../../../orchestrator/src/manifest.js";
import { verifyStepInvocationEvidence } from "../../../orchestrator/src/verify-runner.js";
import type { QueueItem, RunKind, RunManifest } from "../../../orchestrator/src/types.js";

const FIXTURE_TIMESTAMP = "2026-07-15T00:00:00.000Z";

export function passingExperimentCheckpoint(kind: RunKind): string {
  if (kind === "implement") return "STATUS: COMPLETE\n\n## CHANGES\n- completed fixture task\n";
  if (kind === "verify") {
    return [
      "# Deterministic Verify",
      "",
      "## VERIFY_REPORT",
      "- verdict: PASS",
      "- profile: fixture",
      "- termination_confirmed: true",
      "- trusted fixture command: PASS (exit_code=0, duration_ms=1)",
      "",
      "## VERIFY_EVIDENCE",
      "- source: orchestrator/verify-runner",
      "",
      "",
    ].join("\n");
  }
  return [
    "## REVIEW_VERDICT",
    "verdict: PASS",
    "drift: none",
    "scope_violations: []",
    "must_fix_next_slot: []",
    "reviewer_notes: fixture evidence is complete",
    "",
  ].join("\n");
}

function materializeAt(workbench: string, item: QueueItem): string {
  const previous = process.env.AGENT_WORKBENCH_ROOT;
  process.env.AGENT_WORKBENCH_ROOT = workbench;
  try {
    return materializeQueueRun(item);
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
    else process.env.AGENT_WORKBENCH_ROOT = previous;
  }
}

export function writeTrustedExperimentRunEvidence(
  workbench: string,
  item: QueueItem,
  checkpoint = passingExperimentCheckpoint(item.run_kind ?? "implement"),
  executionOk = true,
): string {
  const manifestPath = materializeAt(workbench, item);
  const runDir = path.dirname(manifestPath);
  mkdirSync(runDir, { recursive: true });
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as RunManifest;
  const attempt = executionAttemptBinding(item.id, 1, 0);
  let finalExecutionOk = executionOk;
  writeFileSync(path.join(runDir, "checkpoint.md"), checkpoint, "utf8");

  if (item.run_kind === "verify") {
    const profile = normalizeEvalProfile(manifest.evalProfile);
    const expectedSteps =
      profile === "literature" || manifest.repoRoot === "juno-overseer"
        ? verifyStepsForProfile(profile)
        : [];
    const orchestratorStep = (
      label: string,
      command: "orchestrator:safety-verify" | "orchestrator:artifact-check",
      ok: boolean,
    ) => ({
      stepId: evidenceSha256(JSON.stringify({ command, label })),
      label,
      command,
      exitCode: ok ? 0 : 1,
      durationMs: 0,
      optional: false,
      ok,
      terminationConfirmed: true,
      stdout: "fixture evidence",
      stderr: "",
    });
    const initialSteps = [
      ...(manifest.missionId
        ? [orchestratorStep("mission safety preflight", "orchestrator:safety-verify", true)]
        : []),
      ...(profile === "literature"
        ? [orchestratorStep("fixture literature artifacts", "orchestrator:artifact-check", true)]
        : manifest.repoRoot === "workbench"
          ? [orchestratorStep(
              "Workbench package execution has an OS sandbox",
              "orchestrator:artifact-check",
              false,
            )]
          : []),
    ];
    const effectiveOk =
      executionOk && initialSteps.every((step) => step.optional || step.ok);
    finalExecutionOk = effectiveOk;
    const realSteps = expectedSteps.map((step: VerifyStep, index) => {
      const ok = effectiveOk || index > 0;
      const invocation = verifyStepInvocationEvidence(step);
      return {
        stepId: verifyStepId(step),
        label: step.label,
        command: invocation.command,
        tool: invocation.tool,
        args: invocation.args,
        exitCode: ok ? 0 : 1,
        durationMs: 1,
        optional: step.optional === true,
        ok,
        terminationConfirmed: true,
        stdout: "",
        stderr: "",
      };
    });
    const artifactSteps = [...initialSteps, ...realSteps];
    const toolEvents = realSteps.flatMap((step) => {
      const event = {
        ts: FIXTURE_TIMESTAMP,
        type: "tool_call",
        tool: step.tool,
        args: step.args,
        stepId: step.stepId,
        ...attempt,
      };
      return [
        { ...event, phase: "started" },
        { ...event, phase: "completed", ok: step.ok },
      ];
    });
    const eventsText = [
      {
        ts: FIXTURE_TIMESTAMP,
        type: "status",
        status: "verify_starting",
        detail: `profile=${profile}; steps=${realSteps.length}; artifact_checks=${initialSteps.length}`,
        ...attempt,
      },
      ...toolEvents,
      {
        ts: FIXTURE_TIMESTAMP,
        type: "finished",
        status: effectiveOk ? "finished" : "error",
        result: `deterministic verify ${effectiveOk ? "PASS" : "FAIL"}`,
        model: "deterministic",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    writeFileSync(path.join(runDir, "events.jsonl"), eventsText, "utf8");
    writeFileSync(
      path.join(runDir, "verify-artifact.json"),
      `${JSON.stringify({
        version: EXECUTION_ARTIFACT_VERSION,
        runId: item.id,
        ...attempt,
        profile,
        cwd: process.cwd(),
        verifiedAt: FIXTURE_TIMESTAMP,
        ok: effectiveOk,
        terminationConfirmed: true,
        manifestSha256: evidenceSha256(manifestText),
        checkpointSha256: evidenceSha256(checkpoint),
        eventsSha256: evidenceSha256(eventsText),
        steps: artifactSteps.map((step) => ({
          stepId: step.stepId,
          label: step.label,
          command: step.command,
          exitCode: step.exitCode,
          durationMs: step.durationMs,
          optional: step.optional,
          ok: step.ok,
          terminationConfirmed: step.terminationConfirmed,
          stdout: step.stdout,
          stderr: step.stderr,
        })),
      }, null, 2)}\n`,
      "utf8",
    );
  } else {
    const threadId = `thread-${item.id}`;
    const eventsText = [
      {
        ts: FIXTURE_TIMESTAMP,
        type: "status",
        status: "starting",
        detail: `openai_codex:${manifest.model ?? "default"}; quota=openai`,
        ...attempt,
      },
      ...(executionOk
        ? [
            {
              ts: FIXTURE_TIMESTAMP,
              type: "status",
              status: "codex_thread_started",
              detail: threadId,
            },
            { ts: FIXTURE_TIMESTAMP, type: "assistant", text: checkpoint },
          ]
        : [{ ts: FIXTURE_TIMESTAMP, type: "error", message: "fixture Codex failure" }]),
      {
        ts: FIXTURE_TIMESTAMP,
        type: "finished",
        status: executionOk ? "finished" : "error",
        result: executionOk ? checkpoint : "fixture Codex failure",
        model: manifest.model ?? "codex-default",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    writeFileSync(path.join(runDir, "events.jsonl"), eventsText, "utf8");
    writeFileSync(
      path.join(runDir, "codex-artifact.json"),
      `${JSON.stringify({
        version: EXECUTION_ARTIFACT_VERSION,
        runId: item.id,
        ...attempt,
        threadId: executionOk ? threadId : null,
        model: manifest.model ?? "default",
        completedAt: FIXTURE_TIMESTAMP,
        ok: executionOk,
        ...(executionOk ? {} : { failure: "fixture Codex failure" }),
        usage: executionOk
          ? {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            }
          : null,
        manifestSha256: evidenceSha256(manifestText),
        checkpointSha256: evidenceSha256(checkpoint),
        eventsSha256: evidenceSha256(eventsText),
      }, null, 2)}\n`,
      "utf8",
    );
  }

  saveRunState(runDir, {
    retryCount: 0,
    slotIndex: 1,
    maxRetries: 3,
    lastStatus: finalExecutionOk ? "done" : "failed",
    updatedAt: FIXTURE_TIMESTAMP,
  });
  return runDir;
}
