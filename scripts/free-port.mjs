/**
 * Free a TCP port before `next dev` (Windows-focused; no-op if port is free).
 * Usage: node scripts/free-port.mjs 3000
 */
import { execSync } from "node:child_process";

const port = process.argv[2] ?? "3000";

if (process.platform === "win32") {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts.at(-1);
      if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[free-port] Stopped PID ${pid} on port ${port}`);
      } catch {
        // Process may have already exited.
      }
    }
  } catch {
    // Port not in use.
  }
}
