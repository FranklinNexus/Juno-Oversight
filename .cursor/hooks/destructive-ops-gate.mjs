#!/usr/bin/env node
/**
 * Blocks destructive shell commands (recursive delete, git annihilation) on protected roots.
 */
import { readFileSync } from "node:fs";
import { classifyShellCommand } from "./safety-gate-core.mjs";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message:
        "Juno Overseer destructive-ops firewall: this command can wipe the repo or workbench. Use scoped edits, git status, or ask a human.",
    }),
  );
  process.exit(2);
}

function allow() {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}

const raw = readFileSync(0, "utf8");
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  allow();
}

const command = typeof payload.command === "string" ? payload.command : "";
if (!command) allow();

const verdict = classifyShellCommand(command);
if (verdict.blocked) {
  deny(verdict.reason ?? "Blocked destructive shell command.");
}

allow();
