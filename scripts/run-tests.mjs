#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requireSpawnSuccess,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const configPath = path.join(repoRoot, "vitest.config.mts");
const partitionedSuites = [
  {
    suite: "src/lib/workbench/specialized-loop-guard.test.ts",
    testNamePattern:
      "^specialized loop guard rejects fake COMPLETE.*run-agi-literature-daemon",
  },
  {
    suite: "src/lib/workbench/specialized-loop-guard.test.ts",
    testNamePattern:
      "^specialized loop guard rejects fake COMPLETE.*run-axiom-book-daemon",
  },
  {
    suite: "src/lib/workbench/specialized-loop-guard.test.ts",
    testNamePattern:
      "^specialized loop guard (?=[rR])(?!rejects fake COMPLETE)",
  },
  {
    suite: "src/lib/workbench/specialized-loop-guard.test.ts",
    testNamePattern: "^specialized loop guard (?![rR])",
  },
  {
    suite: "src/lib/workbench/safety-verify.test.ts",
    testNamePattern: "^safety-verify (?=[a-eA-E])",
  },
  {
    suite: "src/lib/workbench/safety-verify.test.ts",
    testNamePattern: "^safety-verify (?![a-eA-E])",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment isolation and policy (?!rejects )",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment isolation and policy rejects (?=[a-mA-M])",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment isolation and policy rejects (?![a-mA-M])",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment receipts and activation (?=re(?:stores|quires|covers))",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment receipts and activation (?=r(?:efuses|olls))",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment receipts and activation (?=[a-mA-M])",
  },
  {
    suite: "src/lib/workbench/workflow-experiment.test.ts",
    testNamePattern:
      "^workflow experiment receipts and activation (?![a-mA-Mr-zR-Z])",
  },
];
const singleForkArgs = [
  "--pool=forks",
  "--maxWorkers=1",
  "--no-file-parallelism",
];
const SUITE_TIMEOUT_MS = 5 * 60_000;

if (!existsSync(vitestCli)) {
  throw new Error(`Vitest CLI is unavailable: ${vitestCli}`);
}

async function runVitest(label, args) {
  const result = await spawnWithTimeout(
    process.execPath,
    [vitestCli, "run", "--config", configPath, ...args],
    { cwd: repoRoot, stdio: "inherit" },
    SUITE_TIMEOUT_MS,
  );
  requireSpawnSuccess(result, label);
}

try {
  for (const { suite, testNamePattern } of partitionedSuites) {
    await runVitest(`Vitest partition ${testNamePattern}`, [
      suite,
      `--testNamePattern=${testNamePattern}`,
      ...singleForkArgs,
    ]);
  }
  const mainSuiteExclusions = [
    ...new Set(partitionedSuites.map(({ suite }) => suite)),
  ];
  await runVitest(
    "Vitest main suite",
    mainSuiteExclusions.map((suite) => `--exclude=${suite}`),
  );
} catch (error) {
  process.stderr.write(`[juno-test] ${error.message}\n`);
  process.exitCode = 1;
}
