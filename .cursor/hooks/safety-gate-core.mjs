/** Shared destructive shell classifier (keep in sync with orchestrator/src/safety-doctrine.ts). */

const RECURSIVE_DELETE =
  /\brmdir\b[^;\n]*\/s\b|\brm\b[^;\n]*(-rf|-fr|-r\s+-f)|Remove-Item\b[^;\n]*-Recurse|del\s+\/s\s+\/q|fs\.rmSync\([^)]*recursive:\s*true/i;

const GIT_DESTROY =
  /\bgit\s+clean\b[^;\n]*-f|\bgit\s+reset\s+--hard\b|\bgit\s+push\b[^;\n]*--force|\bgit\s+push\b[^;\n]*-f\b/i;

const PROTECTED_BASENAMES = [
  "juno oversight",
  "agentworkbench",
  "entrepreneurship",
  "obsidian vault",
  "desktopdata",
];

const BROAD_TARGET =
  /(?:^|[\s"'`])\.(?:[\s"'`;]|$)|(?:^|[\s"'`])(\*|\.\.)(?:[\s"'`;]|$)|(?:^|[\s"'`])[a-z]:\\?(?:[\s"'`;]|$)/i;

function normalizeCommand(command) {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractPathLikeTokens(command) {
  const tokens = [];
  const quoted = command.match(/["']([^"']+)["']/g) ?? [];
  for (const q of quoted) tokens.push(q.slice(1, -1));
  const winPaths = command.match(/[a-z]:\\[^;\s"'`|]+/gi) ?? [];
  tokens.push(...winPaths);
  const unixish = command.match(/(?:\/|\\)[\w\s.-]+(?:\/|\\)[\w\s.-]+/g) ?? [];
  tokens.push(...unixish);
  return tokens;
}

function basenameLower(p) {
  const cleaned = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = cleaned.split("/");
  return (parts[parts.length - 1] ?? cleaned).toLowerCase();
}

function hitsProtectedRoot(token) {
  const norm = token.replace(/\\/g, "/").toLowerCase();
  for (const name of PROTECTED_BASENAMES) {
    if (norm.includes(name.replace(/\s+/g, " "))) return true;
    if (basenameLower(token) === name) return true;
  }
  if (/desktopdata\/entrepreneurship/i.test(norm)) return true;
  if (/desktop\/entrepreneurship/i.test(norm)) return true;
  return false;
}

export function classifyShellCommand(command) {
  if (!command?.trim()) return { blocked: false };

  const norm = normalizeCommand(command);
  const tokens = extractPathLikeTokens(command);

  if (GIT_DESTROY.test(norm)) {
    return {
      blocked: true,
      category: "git_destroy",
      reason: "Blocked git history-destructive command (clean/reset --hard/force push).",
    };
  }

  if (!RECURSIVE_DELETE.test(norm)) {
    return { blocked: false };
  }

  if (BROAD_TARGET.test(norm)) {
    return {
      blocked: true,
      category: "broad_wildcard",
      reason: "Blocked recursive delete with broad target (. .. * or drive root).",
    };
  }

  for (const token of tokens) {
    if (hitsProtectedRoot(token)) {
      return {
        blocked: true,
        category: "protected_root",
        reason: `Blocked recursive delete targeting protected path: ${token}`,
      };
    }
  }

  if (/juno\s*oversight|agentworkbench|entrepreneurship|obsidian\s*vault/i.test(norm)) {
    return {
      blocked: true,
      category: "protected_root",
      reason: "Blocked recursive delete referencing Juno/Workbench/Vault/Entrepreneurship roots.",
    };
  }

  return { blocked: false };
}
