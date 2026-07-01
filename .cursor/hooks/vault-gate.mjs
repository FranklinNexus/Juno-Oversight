#!/usr/bin/env node
/**
 * Vault firewall for Agent Workbench runs.
 * Blocks shell commands and file reads targeting Obsidian Vault paths.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_VAULT = "E:/Obsidian Vault";

function loadVaultPath() {
  if (process.env.JUNO_VAULT_PATH?.trim()) {
    return process.env.JUNO_VAULT_PATH.trim();
  }
  const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
  try {
    const configPath = path.join(workbench, "config.yaml");
    const text = readFileSync(configPath, "utf8");
    const match = text.match(/vault_path:\s*["']?([^"'\n]+)["']?/i);
    if (match?.[1]) return match[1].trim();
  } catch {
    // fall through
  }
  return DEFAULT_VAULT;
}

function normalize(p) {
  return path.normalize(p).replace(/\\/g, "/").toLowerCase();
}

function isVaultPath(candidate, vaultRoot) {
  if (!candidate) return false;
  const normVault = normalize(vaultRoot);
  const normCandidate = normalize(candidate);
  return normCandidate === normVault || normCandidate.startsWith(`${normVault}/`);
}

function extractPaths(payload) {
  const paths = [];
  if (typeof payload.command === "string") paths.push(payload.command);
  if (typeof payload.path === "string") paths.push(payload.path);
  if (typeof payload.filePath === "string") paths.push(payload.filePath);
  if (typeof payload.file_path === "string") paths.push(payload.file_path);
  if (typeof payload.target === "string") paths.push(payload.target);
  return paths;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message:
        "Juno Overseer Vault firewall: Agent Workbench runs must not touch Obsidian Vault. Use staging/ and Promote instead.",
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

const vaultRoot = loadVaultPath();
for (const candidate of extractPaths(payload)) {
  if (isVaultPath(candidate, vaultRoot)) {
    deny(`Blocked access to Obsidian Vault path: ${candidate}`);
  }
  // Also block obvious vault references in shell one-liners
  if (/obsidian\s+vault/i.test(candidate) && /[\\/](?:Obsidian Vault|Obsidian%20Vault)/i.test(candidate)) {
    deny(`Blocked shell command referencing Obsidian Vault: ${candidate}`);
  }
}

allow();
