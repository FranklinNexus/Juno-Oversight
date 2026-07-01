import { classifyShellCommand } from "./safety-doctrine.js";

export type SafetyFinding = {
  category: "destructive_cmd" | "secret_pattern" | "scope_path";
  severity: "warn" | "block";
  message: string;
};

export type SafetyVerifyReport = {
  ok: boolean;
  findings: SafetyFinding[];
};

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(api[_-]?key|secret[_-]?key|password)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\.env\.local\b.*(?:write|commit|add)/i,
];

const SCOPE_FORBIDDEN = [
  /obsidian\s*vault/i,
  /rmdir\s+.*vault/i,
  /rm\s+-rf\s+.*vault/i,
];

/** Readonly safety bundle for verify slots (AgentDojo / GuardAgent inspired). */
export function scanTextForSecrets(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      findings.push({
        category: "secret_pattern",
        severity: "block",
        message: `Possible secret/credential pattern matched: ${re.source.slice(0, 40)}…`,
      });
    }
  }
  return findings;
}

export function scanTextForDestructiveCommands(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.includes("rmdir") && !trimmed.includes("rm ")) {
      continue;
    }
    const verdict = classifyShellCommand(trimmed);
    if (verdict.blocked) {
      findings.push({
        category: "destructive_cmd",
        severity: "block",
        message: verdict.reason ?? "Blocked destructive command pattern in checkpoint text.",
      });
    }
  }
  for (const re of SCOPE_FORBIDDEN) {
    if (re.test(text)) {
      findings.push({
        category: "scope_path",
        severity: "block",
        message: "Checkpoint references forbidden Vault/destructive scope.",
      });
    }
  }
  return findings;
}

export function runSafetyVerifyBundle(text: string): SafetyVerifyReport {
  const findings = [
    ...scanTextForSecrets(text),
    ...scanTextForDestructiveCommands(text),
  ];
  const ok = !findings.some((f) => f.severity === "block");
  return { ok, findings };
}

export function formatSafetyVerifyMarkdown(report: SafetyVerifyReport): string {
  const lines = ["## SAFETY_VERIFY", `- ok: ${report.ok ? "PASS" : "FAIL"}`];
  if (report.findings.length === 0) {
    lines.push("- findings: none");
  } else {
    for (const f of report.findings) {
      lines.push(`- [${f.severity}] ${f.category}: ${f.message}`);
    }
  }
  return lines.join("\n");
}
