import { spawnSync } from "node:child_process";
import net from "node:net";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** End a child and every descendant it started, including cmd.exe / pnpm wrappers on Windows. */
export function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process has already stopped.
    }
  }
}

export async function portIsListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

export async function waitForPortRelease(port, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsListening(port))) return true;
    await sleep(intervalMs);
  }
  return !(await portIsListening(port));
}
