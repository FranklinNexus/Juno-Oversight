#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boot = spawnSync(
  "powershell",
  ["-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/bootstrap-self-iterate-p2.ps1")],
  { stdio: "inherit" },
);
if (boot.status !== 0) process.exit(boot.status ?? 1);
const run = spawnSync("node", [path.join(root, "scripts/run-minimal-loop.mjs"), "--skip-bootstrap"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
