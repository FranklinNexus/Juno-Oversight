/**
 * Free a TCP port before `next dev` (Windows-focused; no-op if port is free).
 * Usage: node scripts/free-port.mjs 3000
 */
import { spawnSync } from "node:child_process";
import { terminateProcessTree } from "./lib/specialized-loop-guard.mjs";

const rawPort = process.argv[2] ?? "3000";
if (!/^\d{1,5}$/.test(rawPort)) {
  throw new Error(`invalid TCP port: ${rawPort}`);
}
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid TCP port: ${rawPort}`);
}

if (process.platform === "win32") {
  const observed = spawnSync("netstat.exe", ["-ano"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (observed.error) throw observed.error;
  if (observed.status !== 0) {
    throw new Error(`netstat exited with status ${observed.status ?? "unknown"}`);
  }

  const pids = new Set();
  for (const line of observed.stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !parts[1].endsWith(`:${port}`)) continue;
    const pid = parts.at(-1);
    if (pid && /^\d+$/.test(pid) && pid !== "0" && Number(pid) !== process.pid) {
      pids.add(pid);
    }
  }

  for (const pid of pids) {
    if (terminateProcessTree(Number(pid))) {
      console.log(`[free-port] Stopped PID ${pid} on port ${port}`);
    }
  }
}
