import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { junoProjectRoot } from "./env.js";
import { BOOK_MISSION_ID, countHan, validateChapterText } from "./quality-gate.js";
import type { RunManifest, WorkflowExperimentArm } from "./types.js";
import { resolveMissionDirectory } from "./workbench-paths.js";
import {
  compileWorkflowExperimentArmEpisode,
  inspectWorkflowExperiment,
  renderWorkflowExperimentFixture,
  workflowExperimentPaths,
  workflowExperimentSampleMissionId,
} from "./workflow-experiment.js";

export interface ArtifactCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface LiteratureVerificationBinding {
  ok: boolean;
  validatorMissionId?: string;
  artifactMissionId?: string;
  artifactMode?: "production" | "workflow_canary_literature_v1";
  expectedFixtureFiles?: Record<string, string>;
  checks: ArtifactCheck[];
}

const WORKFLOW_CANARY_PREFIX = "juno-workflow-canary-";
const SHA256 = /^[a-f0-9]{64}$/;
const FIXTURE_RECEIPT_KEYS = [
  "arm",
  "episode",
  "experimentId",
  "fixtureSha256",
  "fixtureVersion",
  "missionId",
  "renderedFilesSha256",
] as const;
const MAX_FIXTURE_RECEIPT_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function failedCanaryBinding(detail: string): LiteratureVerificationBinding {
  return {
    ok: false,
    checks: [{ label: "workflow canary literature binding", ok: false, detail }],
  };
}

function fixtureReceiptPath(
  workbench: string,
  experimentId: string,
  arm: WorkflowExperimentArm,
  episode: number,
): string {
  const proposalPath = workflowExperimentPaths(workbench, experimentId).proposal;
  const suffix = ".proposal.json";
  const name = path.basename(proposalPath);
  if (!name.endsWith(suffix)) throw new Error("Workflow experiment proposal path is invalid");
  return path.join(path.dirname(proposalPath), `${name.slice(0, -suffix.length)}.${arm}.${episode}.fixture.json`);
}

function assertFixtureReceipt(
  receiptPath: string,
  expected: {
    experimentId: string;
    arm: WorkflowExperimentArm;
    episode: number;
    missionId: string;
    fixtureSha256: string;
    fixtureVersion: 1 | 2;
    renderedFilesSha256: string;
  },
): void {
  const stat = lstatSync(receiptPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) {
    throw new Error(`Workflow experiment fixture receipt must be an exclusive regular file: ${receiptPath}`);
  }
  if (stat.size > BigInt(MAX_FIXTURE_RECEIPT_BYTES)) {
    throw new Error(`Workflow experiment fixture receipt is too large: ${receiptPath}`);
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error("Workflow experiment fixture receipt is unreadable", { cause: error });
  }
  if (!isRecord(receipt) || !hasExactKeys(receipt, FIXTURE_RECEIPT_KEYS)) {
    throw new Error("Workflow experiment fixture receipt has an invalid schema");
  }
  if (
    receipt.fixtureVersion !== expected.fixtureVersion ||
    receipt.experimentId !== expected.experimentId ||
    receipt.arm !== expected.arm ||
    receipt.episode !== expected.episode ||
    receipt.missionId !== expected.missionId ||
    receipt.fixtureSha256 !== expected.fixtureSha256 ||
    typeof receipt.renderedFilesSha256 !== "string" ||
    !SHA256.test(receipt.renderedFilesSha256) ||
    receipt.renderedFilesSha256 !== expected.renderedFilesSha256
  ) {
    throw new Error("Workflow experiment fixture receipt binding is invalid");
  }
}

interface ArtifactFile {
  ok: boolean;
  text: string;
  detail: string;
}

function artifactMissionDirectory(workbench: string, missionId: string): string {
  const canonicalWorkbench = realpathSync.native(path.resolve(workbench));
  const missionsRoot = path.join(canonicalWorkbench, "missions");
  if (existsSync(missionsRoot)) {
    const rootStat = lstatSync(missionsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Workbench missions root must be a regular directory: ${missionsRoot}`);
    }
    if (realpathSync.native(missionsRoot) !== missionsRoot) {
      throw new Error(`Workbench missions root must not resolve through a link: ${missionsRoot}`);
    }
  }
  const missionDir = resolveMissionDirectory(canonicalWorkbench, missionId);
  if (!existsSync(missionDir)) return missionDir;
  const missionStat = lstatSync(missionDir);
  if (!missionStat.isDirectory() || missionStat.isSymbolicLink()) {
    throw new Error(`Literature artifact mission must be a regular directory: ${missionDir}`);
  }
  if (realpathSync.native(missionDir) !== missionDir) {
    throw new Error(`Literature artifact mission must not resolve through a link: ${missionDir}`);
  }
  return missionDir;
}

function readArtifactFile(filePath: string): ArtifactFile {
  if (!existsSync(filePath)) return { ok: false, text: "", detail: filePath };
  try {
    const stat = lstatSync(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== BigInt(1) ||
      realpathSync.native(filePath) !== path.resolve(filePath)
    ) {
      return { ok: false, text: "", detail: `unsafe linked artifact: ${filePath}` };
    }
    return { ok: true, text: readFileSync(filePath, "utf8"), detail: filePath };
  } catch (error) {
    return {
      ok: false,
      text: "",
      detail: `unreadable artifact: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function fileCheck(label: string, filePath: string): ArtifactCheck {
  const artifact = readArtifactFile(filePath);
  return { label, ok: artifact.ok, detail: artifact.detail };
}

function parseYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function normalizedEvidenceKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function resolveLiteratureVerificationBinding(
  workbench: string,
  manifest: RunManifest,
): LiteratureVerificationBinding {
  const missionId = manifest.missionId;
  const isCanaryMission = missionId?.startsWith(WORKFLOW_CANARY_PREFIX) === true;
  const experimentFields = [
    manifest.experimentId,
    manifest.experimentArm,
    manifest.experimentEpisode,
    manifest.sourcePhaseId,
    manifest.experimentFixtureSha256,
    manifest.experimentPromptSha256,
  ];
  const hasExperimentMetadata = experimentFields.some((value) => value !== undefined);
  if (!isCanaryMission && !hasExperimentMetadata) {
    return {
      ok: true,
      validatorMissionId: missionId,
      artifactMissionId: missionId,
      artifactMode: "production",
      checks: [],
    };
  }
  if (!isCanaryMission) {
    return failedCanaryBinding("experiment metadata is not bound to a workflow canary mission");
  }
  if (experimentFields.some((value) => value === undefined)) {
    return failedCanaryBinding("workflow canary experiment metadata is incomplete");
  }
  if (
    manifest.runKind !== "verify" ||
    manifest.repoRoot !== "workbench" ||
    manifest.evalProfile !== "literature" ||
    manifest.cwd !== `missions/${missionId}` ||
    !manifest.phaseId ||
    !manifest.workflowId
  ) {
    return failedCanaryBinding("workflow canary verify manifest bindings are incomplete");
  }

  const experimentId = manifest.experimentId!;
  const arm = manifest.experimentArm!;
  const episode = manifest.experimentEpisode!;
  const sourcePhaseId = manifest.sourcePhaseId!;
  const fixtureSha256 = manifest.experimentFixtureSha256!;
  try {
    const snapshot = inspectWorkflowExperiment(workbench, experimentId);
    const proposal = snapshot.proposal;
    if (episode > proposal.requiredEpisodes) {
      throw new Error("Workflow canary episode exceeds the proposal episode count");
    }
    const expectedMissionId = workflowExperimentSampleMissionId(proposal, arm, episode);
    const expectedWorkflowId =
      arm === "baseline" ? proposal.baselineWorkflowId : proposal.candidateWorkflowId;
    if (
      missionId !== expectedMissionId ||
      sourcePhaseId !== proposal.sourcePhaseId ||
      fixtureSha256 !== proposal.fixtureSha256 ||
      manifest.workflowId !== expectedWorkflowId
    ) {
      throw new Error("Workflow canary manifest does not match its trusted proposal");
    }

    const expectedRun = compileWorkflowExperimentArmEpisode(proposal, arm, episode)
      .find((item) => item.id === manifest.runId);
    if (
      !expectedRun ||
      expectedRun.run_kind !== "verify" ||
      manifest.phaseId !== expectedRun.phase_id ||
      manifest.promptTemplate !== expectedRun.prompt ||
      manifest.experimentPromptSha256 !== expectedRun.experiment_prompt_sha256 ||
      manifest.provider !== expectedRun.provider ||
      manifest.maxMinutes !== expectedRun.max_minutes
    ) {
      throw new Error("Workflow canary manifest is not a compiled verify slot");
    }

    const receiptPath = fixtureReceiptPath(workbench, experimentId, arm, episode);
    const renderedFixture = renderWorkflowExperimentFixture(proposal, expectedMissionId);
    assertFixtureReceipt(receiptPath, {
      experimentId,
      arm,
      episode,
      missionId: expectedMissionId,
      fixtureSha256,
      fixtureVersion: renderedFixture.fixtureVersion,
      renderedFilesSha256: renderedFixture.renderedFilesSha256,
    });
    artifactMissionDirectory(workbench, expectedMissionId);
    return {
      ok: true,
      validatorMissionId: proposal.targetMissionId,
      artifactMissionId: expectedMissionId,
      artifactMode: "workflow_canary_literature_v1",
      expectedFixtureFiles: renderedFixture.files,
      checks: [
        {
          label: "workflow canary literature binding",
          ok: true,
          detail: `validator=${proposal.targetMissionId}; artifacts=${expectedMissionId}`,
        },
        {
          label: "workflow canary fixture receipt",
          ok: true,
          detail: receiptPath,
        },
      ],
    };
  } catch (error) {
    return failedCanaryBinding(error instanceof Error ? error.message : String(error));
  }
}

function agiBatchChecks(missionDir: string): ArtifactCheck[] {
  const checks: ArtifactCheck[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const requiredFields = ["authors", "year", "venue", "url", "one_line", "juno_hook"];
  for (let batch = 1; batch <= 40; batch += 1) {
    const name = `batch-${String(batch).padStart(2, "0")}.yaml`;
    const filePath = path.join(missionDir, "papers", name);
    const artifact = readArtifactFile(filePath);
    if (!artifact.ok) {
      checks.push({
        label: `${name} has 25 complete unique records`,
        ok: false,
        detail: artifact.detail,
      });
      continue;
    }
    const text = artifact.text;
    const starts = [...text.matchAll(/^  - title:\s*(.*)$/gm)];
    let reason = starts.length === 25 ? "" : `records=${starts.length}`;
    for (let index = 0; !reason && index < starts.length; index += 1) {
      const start = starts[index];
      const end = starts[index + 1]?.index ?? text.length;
      const block = text.slice(start.index, end);
      const title = parseYamlScalar(start[1] ?? "");
      const fields: Record<string, string> = {};
      for (const field of requiredFields) {
        const match = block.match(new RegExp(`^    ${field}:\\s*(.*)$`, "m"));
        fields[field] = match ? parseYamlScalar(match[1]) : "";
      }
      if (title.trim().length < 5 || requiredFields.some((field) => !fields[field].trim())) {
        reason = `entry ${index + 1} has empty fields`;
        break;
      }
      const year = Number(fields.year);
      if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 1) {
        reason = `entry ${index + 1} has invalid year`;
        break;
      }
      if (!/^https?:\/\//i.test(fields.url)) {
        reason = `entry ${index + 1} has invalid url`;
        break;
      }
      if (fields.one_line.trim().length < 20 || fields.juno_hook.trim().length < 20) {
        reason = `entry ${index + 1} lacks substantive evidence`;
        break;
      }
      const titleKey = normalizedEvidenceKey(title);
      const urlKey = normalizedEvidenceKey(fields.url).replace(/\/$/, "");
      if (seenTitles.has(titleKey) || seenUrls.has(urlKey)) {
        reason = `entry ${index + 1} duplicates prior evidence`;
        break;
      }
      seenTitles.add(titleKey);
      seenUrls.add(urlKey);
    }
    checks.push({
      label: `${name} has 25 complete unique records`,
      ok: !reason,
      detail: reason || "records=25",
    });
  }
  return checks;
}

function verifyAxiomBook(workbench: string, artifactMissionId: string): ArtifactCheck[] {
  const missionDir = artifactMissionDirectory(workbench, artifactMissionId);
  const planningRules: Array<[string, RegExp]> = [
    ["axioms.md", /\bA[1-5]\b/],
    ["outline.md", /第(?:20|二十)章/],
    ["quality-rubric.md", /硬门禁|quality/i],
    ["book-meta.yaml", /^chapters:\s*20\s*$/m],
  ];
  const planningChecks = planningRules.map(([name, pattern]) => {
    const filePath = path.join(missionDir, name);
    const artifact = readArtifactFile(filePath);
    const text = artifact.text.trim();
    return {
      label: `${name} is substantive`,
      ok: artifact.ok && text.length >= 80 && pattern.test(text),
      detail: artifact.detail,
    };
  });
  const chapterBodies = Array.from({ length: 20 }, (_, index) => {
    const filePath = path.join(missionDir, "chapters", `ch${String(index + 1).padStart(2, "0")}.md`);
    return readArtifactFile(filePath).text;
  });
  const reports = chapterBodies.map((body, index) =>
    validateChapterText(body, index + 1, { strictLength: true }),
  );
  const failedChapters = reports.filter((report) => !report.ok).map((report) => report.chapter);
  const normalizedChapterBodies = chapterBodies.map((body) => body.replace(/\s+/g, ""));
  const mergedPath = path.join(missionDir, "book", "全书.md");
  const merged = readArtifactFile(mergedPath).text;
  const normalizedMerged = merged.replace(/\s+/g, "");
  const missingChapter = normalizedChapterBodies.findIndex(
    (body) => !body || !normalizedMerged.includes(body),
  );
  return [
    ...planningChecks,
    {
      label: "20 chapters pass the strict quality gate",
      ok: reports.length === 20 && failedChapters.length === 0,
      detail: `chapters=${reports.length}, failed=${failedChapters.join(",") || "none"}`,
    },
    {
      label: "20 chapter bodies are unique",
      ok:
        normalizedChapterBodies.length === 20 &&
        normalizedChapterBodies.every(Boolean) &&
        new Set(normalizedChapterBodies).size === 20,
      detail: `unique=${new Set(normalizedChapterBodies).size}`,
    },
    {
      label: "merged book contains every chapter and at least 95,000 Han characters",
      ok: countHan(merged) >= 95_000 && missingChapter < 0,
      detail: `mergedHan=${countHan(merged)}, missingChapter=${missingChapter < 0 ? "none" : missingChapter + 1}`,
    },
    fileCheck("book/全书.md", mergedPath),
  ];
}

function verifyWorkflowCanaryLiterature(
  workbench: string,
  artifactMissionId: string,
  expectedFixtureFiles: Record<string, string> | undefined,
): ArtifactCheck[] {
  const missionDir = artifactMissionDirectory(workbench, artifactMissionId);
  if (!expectedFixtureFiles) {
    return [{ label: "workflow canary fixture contract", ok: false, detail: "missing expected files" }];
  }
  const immutableNames = Object.keys(expectedFixtureFiles).filter((name) => name !== "essay.md");
  const immutableChecks = immutableNames.map((name): ArtifactCheck => {
    const artifact = readArtifactFile(path.join(missionDir, name));
    return {
      label: `${name} retained immutable fixture bytes`,
      ok: artifact.ok && artifact.text === expectedFixtureFiles[name],
      detail: artifact.detail,
    };
  });
  const essayPath = path.join(missionDir, "essay.md");
  const essayArtifact = readArtifactFile(essayPath);
  const essay = essayArtifact.text;
  const words = essay.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g)?.length ?? 0;
  const requiredSections = ["Thesis", "Argument", "Counterargument", "Conclusion"];
  const missingSections = requiredSections.filter(
    (section) => !new RegExp(`^##\\s+${section}\\s*$`, "im").test(essay),
  );
  const missingCitations = ["[S1]", "[S2]", "[S3]"].filter(
    (citation) => !essay.includes(citation),
  );
  return [
    ...immutableChecks,
    {
      label: "essay.md is an exclusive regular artifact",
      ok: essayArtifact.ok,
      detail: essayArtifact.detail,
    },
    {
      label: "essay has 450-900 English words",
      ok: words >= 450 && words <= 900,
      detail: `words=${words}`,
    },
    {
      label: "essay contains every required argument section",
      ok: missingSections.length === 0,
      detail: `missing=${missingSections.join(",") || "none"}`,
    },
    {
      label: "essay grounds claims in all supplied source capsules",
      ok: missingCitations.length === 0,
      detail: `missing=${missingCitations.join(",") || "none"}`,
    },
    {
      label: "essay states an auditable and falsifiable oversight thesis",
      ok:
        /\baudit(?:able|ability|ed|ing)?\b/i.test(essay) &&
        /\bfalsif(?:iable|y|ied|ication)\b/i.test(essay) &&
        /\boversight\b/i.test(essay),
      detail: essayPath,
    },
    {
      label: "essay replaces the intentionally incomplete seed",
      ok: essay !== expectedFixtureFiles["essay.md"],
      detail: essayPath,
    },
  ];
}

function verifyAgiLiterature(
  workbench: string,
  artifactMissionId: string,
  isolated: boolean,
): ArtifactCheck[] {
  const missionDir = artifactMissionDirectory(workbench, artifactMissionId);
  const wikiPath = isolated
    ? path.join(missionDir, "wiki", "juno-agi-north-star.md")
    : path.join(junoProjectRoot(), "wiki", "juno-agi-north-star.md");
  const wikiArtifact = readArtifactFile(wikiPath);
  const wiki = wikiArtifact.text.trim();
  return [
    fileCheck("taxonomy-agi.md", path.join(missionDir, "taxonomy-agi.md")),
    fileCheck("papers/README.md", path.join(missionDir, "papers", "README.md")),
    ...agiBatchChecks(missionDir),
    {
      label: "wiki/juno-agi-north-star.md is substantive",
      ok:
        wikiArtifact.ok &&
        wiki.length >= 1_000 &&
        /^#\s+\S/m.test(wiki) &&
        /^##\s+\S/m.test(wiki),
      detail: wikiArtifact.detail,
    },
  ];
}

function verifyAgentLiterature(
  workbench: string,
  artifactMissionId: string,
  isolated: boolean,
): ArtifactCheck[] {
  const missionDir = artifactMissionDirectory(workbench, artifactMissionId);
  const wikiRoot = isolated ? path.join(missionDir, "wiki") : path.join(junoProjectRoot(), "wiki");
  return [
    fileCheck("taxonomy.md", path.join(missionDir, "taxonomy.md")),
    ...[1, 2, 3, 4].map((index) =>
      fileCheck(
        `batch-${String(index).padStart(2, "0")}.yaml`,
        path.join(missionDir, "papers", `batch-${String(index).padStart(2, "0")}.yaml`),
      ),
    ),
    fileCheck(
      "wiki/juno-agent-architecture.md",
      path.join(wikiRoot, "juno-agent-architecture.md"),
    ),
    fileCheck(
      "wiki/agent-literature-index.md",
      path.join(wikiRoot, "agent-literature-index.md"),
    ),
  ];
}

export function verifyLiteratureArtifacts(
  workbench: string,
  validatorMissionId: string | undefined,
  artifactMissionId: string | undefined = validatorMissionId,
  artifactMode: LiteratureVerificationBinding["artifactMode"] = "production",
  expectedFixtureFiles?: Record<string, string>,
): ArtifactCheck[] {
  const isolated = artifactMissionId !== validatorMissionId;
  try {
    if (artifactMode === "workflow_canary_literature_v1" && artifactMissionId) {
      return verifyWorkflowCanaryLiterature(
        workbench,
        artifactMissionId,
        expectedFixtureFiles,
      );
    }
    if (validatorMissionId === BOOK_MISSION_ID && artifactMissionId) {
      return verifyAxiomBook(workbench, artifactMissionId);
    }
    if (validatorMissionId === "juno-agi-literature-2026" && artifactMissionId) {
      return verifyAgiLiterature(workbench, artifactMissionId, isolated);
    }
    if (validatorMissionId === "juno-agent-literature-2026" && artifactMissionId) {
      return verifyAgentLiterature(workbench, artifactMissionId, isolated);
    }
  } catch (error) {
    return [
      {
        label: "literature artifact mission isolation",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  return [
    {
      label: "supported literature mission validator",
      ok: false,
      detail: `no deterministic validator registered for ${validatorMissionId ?? "missing missionId"}`,
    },
  ];
}
