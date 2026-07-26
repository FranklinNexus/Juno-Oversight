const BARE_FLAGS = new Set(["--commit", "--skip-build"]);
const VALUE_OPTIONS = new Set(["expected-sha256", "reason"]);

function option(argv, name) {
  const prefix = `--${name}=`;
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Duplicate --${name}`);
  return matches[0]?.slice(prefix.length);
}

export function parseWorkflowSelectionMigrationArgs(argv) {
  for (const arg of argv) {
    if (BARE_FLAGS.has(arg)) continue;
    const match = arg.match(/^--([^=]+)=/);
    if (!match || !VALUE_OPTIONS.has(match[1])) throw new Error(`Unknown argument: ${arg}`);
  }
  const expectedSha256 = option(argv, "expected-sha256");
  const reason = option(argv, "reason");
  const commit = argv.includes("--commit");
  if (argv.filter((arg) => arg === "--commit").length > 1) throw new Error("Duplicate --commit");
  if (argv.filter((arg) => arg === "--skip-build").length > 1) {
    throw new Error("Duplicate --skip-build");
  }
  if (commit && (!expectedSha256 || !reason)) {
    throw new Error("--commit requires --expected-sha256=<sha256> and --reason=<text>");
  }
  if (!commit && (expectedSha256 !== undefined || reason !== undefined)) {
    throw new Error("--expected-sha256 and --reason are only valid with --commit");
  }
  return {
    commit,
    expectedSha256: expectedSha256 ?? null,
    reason: reason ?? null,
    skipBuild: argv.includes("--skip-build"),
  };
}
