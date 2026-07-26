#!/usr/bin/env node
/** Compile an isolated Next dev fixture, verify localhost assets, then prove cleanup. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  processIsAlive,
  spawnWithTimeout,
  terminateProcessTree,
} from "./lib/specialized-loop-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const HOST = "localhost";
const DEFAULT_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_MS = 250;
const FIXTURE_PREFIX = "juno-next-dev-smoke-";
const FIXTURE_PARENT = path.join(root, ".juno-dev-smoke");
const FIXTURE_ENTRIES = [
  "next-env.d.ts",
  "package.json",
  "postcss.config.mjs",
  "public",
  "src",
  "tsconfig.json",
];
const FORBIDDEN = [
  "Internal Server Error",
  "Runtime Error",
  "Cannot find module",
  "Turbopack error",
  "Cross origin request detected",
];

function log(message) {
  process.stderr.write(`[dev-smoke] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerEnv(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function createIsolatedFixture() {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const fixtureRoot = mkdtempSync(path.join(FIXTURE_PARENT, FIXTURE_PREFIX));
  try {
    for (const entry of FIXTURE_ENTRIES) {
      const source = path.join(root, entry);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(fixtureRoot, entry), {
        recursive: lstatSync(source).isDirectory(),
        errorOnExist: true,
      });
    }

    const sourceModules = path.join(root, "node_modules");
    if (!existsSync(sourceModules)) {
      throw new Error("node_modules is missing; run `corepack pnpm install --frozen-lockfile`");
    }
    symlinkSync(
      sourceModules,
      path.join(fixtureRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      path.join(fixtureRoot, "next.config.mjs"),
      `const nextConfig = { turbopack: { root: ${JSON.stringify(root)} } };\nexport default nextConfig;\n`,
      "utf8",
    );
    return fixtureRoot;
  } catch (error) {
    removeIsolatedFixture(fixtureRoot);
    throw error;
  }
}

function assertDisposableFixture(fixtureRoot) {
  const fixtureParent = path.resolve(FIXTURE_PARENT);
  const resolved = path.resolve(fixtureRoot);
  const relative = path.relative(fixtureParent, resolved);
  if (
    path.dirname(resolved) !== fixtureParent ||
    !path.basename(resolved).startsWith(FIXTURE_PREFIX) ||
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`refusing to clean an unsafe smoke fixture path: ${resolved}`);
  }
}

function removeIsolatedFixture(fixtureRoot) {
  if (!fixtureRoot) return;
  assertDisposableFixture(fixtureRoot);
  const linkedModules = path.join(fixtureRoot, "node_modules");
  if (existsSync(linkedModules)) {
    if (!lstatSync(linkedModules).isSymbolicLink()) {
      throw new Error(`smoke fixture node_modules is not a link: ${linkedModules}`);
    }
    unlinkSync(linkedModules);
  }
  rmSync(fixtureRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  if (existsSync(fixtureRoot)) {
    throw new Error(`smoke fixture cleanup could not be confirmed: ${fixtureRoot}`);
  }
  try {
    rmdirSync(FIXTURE_PARENT);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
}

function probePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolve(null);
      } else {
        reject(error);
      }
    });
    server.listen({ host: HOST, port, exclusive: true }, () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else resolve(selected);
      });
    });
  });
}

async function selectAvailablePort() {
  const requested = positiveIntegerEnv("JUNO_DEV_SMOKE_PORT", 0, 65_535);
  const selected = await probePort(requested);
  if (selected === null) {
    throw new Error(`requested smoke port is not available on ${HOST}: ${requested}`);
  }
  return selected;
}

async function waitForPortRelease(port, deadline) {
  while (Date.now() < deadline) {
    if ((await probePort(port)) === port) return;
    await sleep(100);
  }
  throw new Error(`Next process tree still owns ${HOST}:${port} after cleanup`);
}

async function fetchWithinDeadline(url, deadline, headers = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`deadline exceeded before fetching ${url}`);
  return fetch(url, {
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
  });
}

async function waitForReady(url, deadline, readRunResult) {
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    const earlyResult = readRunResult();
    if (earlyResult) {
      throw new Error(
        `Next dev exited before readiness (status=${earlyResult.status ?? "none"}): `
          + `${earlyResult.stderr || earlyResult.stdout || earlyResult.error?.message || "no output"}`,
      );
    }
    try {
      const response = await fetchWithinDeadline(url, deadline);
      const body = await response.text();
      if (response.status === 200) return body;
      if (response.status >= 500) {
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 1_000)}`);
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Next dev did not become ready before deadline (${lastFailure})`);
}

function nextAssetUrls(body, pageUrl) {
  const urls = new Set();
  for (const match of body.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const raw = match[1].replaceAll("&amp;", "&");
    const asset = new URL(raw, pageUrl);
    if (asset.pathname.startsWith("/_next/")) urls.add(asset.href);
  }
  return [...urls];
}

async function verifyNextAssets(body, pageUrl, deadline) {
  const assets = nextAssetUrls(body, pageUrl);
  if (assets.length === 0) throw new Error("Next dev HTML did not reference any /_next/ assets");
  const origin = new URL(pageUrl).origin;
  for (const asset of assets.slice(0, 32)) {
    const response = await fetchWithinDeadline(asset, deadline, {
      Origin: origin,
      Referer: pageUrl,
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Next asset failed: HTTP ${response.status} ${asset}`);
  }
  return assets.length;
}

function firstForbidden(text) {
  return FORBIDDEN.find((needle) => text.toLowerCase().includes(needle.toLowerCase()));
}

async function runDevSmoke() {
  const timeoutMs = positiveIntegerEnv("JUNO_DEV_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 300_000);
  if (timeoutMs < 15_000) throw new Error("JUNO_DEV_SMOKE_TIMEOUT_MS must be at least 15000");
  const port = await selectAvailablePort();
  const fixtureRoot = createIsolatedFixture();
  const pageUrl = `http://${HOST}:${port}/`;
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const shutdown = new AbortController();
  let stopSignal = null;
  let runResult = null;
  let runPromise = null;
  let pageBody = "";
  let verifiedAssets = 0;
  let failure = null;
  let cleanupFailure = null;

  const requestStop = (signal) => {
    stopSignal ??= signal;
    shutdown.abort();
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    log(`starting isolated Next dev at ${pageUrl}`);
    const env = { ...process.env, FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1" };
    delete env.PORT;
    runPromise = spawnWithTimeout(
      process.execPath,
      [nextBin, "dev", "--port", String(port), "--hostname", HOST],
      {
        cwd: fixtureRoot,
        env,
        encoding: "utf8",
        signal: shutdown.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
      timeoutMs,
    );
    void runPromise.then((result) => { runResult = result; });

    const verificationDeadline = Date.now() + timeoutMs - CLEANUP_TIMEOUT_MS;
    pageBody = await waitForReady(pageUrl, verificationDeadline, () => runResult);
    const bodyFailure = firstForbidden(pageBody);
    if (bodyFailure) throw new Error(`page contains forbidden marker: ${bodyFailure}`);
    if (!pageBody.includes("Juno Oversight")) {
      throw new Error("root page did not render the Juno application metadata");
    }
    verifiedAssets = await verifyNextAssets(pageBody, pageUrl, verificationDeadline);
  } catch (error) {
    failure = error;
  } finally {
    shutdown.abort();
    if (runPromise) {
      try {
        runResult = await runPromise;
      } catch (error) {
        failure ??= error;
      }
      if (runResult?.pid && processIsAlive(runResult.pid)) {
        terminateProcessTree(runResult.pid);
        await sleep(250);
      }
      if (
        runResult &&
        (!runResult.terminationConfirmed ||
          (runResult.pid && processIsAlive(runResult.pid)))
      ) {
        failure ??= new Error("Next process tree termination could not be confirmed");
      }
    }

    try {
      await waitForPortRelease(port, Date.now() + CLEANUP_TIMEOUT_MS);
      await sleep(250);
      removeIsolatedFixture(fixtureRoot);
    } catch (error) {
      cleanupFailure = error;
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const output = `${runResult?.stdout ?? ""}\n${runResult?.stderr ?? ""}`;
  const outputFailure = firstForbidden(output);
  if (outputFailure) failure ??= new Error(`Next output contains forbidden marker: ${outputFailure}`);
  if (stopSignal) failure ??= new Error(`smoke interrupted by ${stopSignal}`);
  if (cleanupFailure) {
    const cleanupMessage = cleanupFailure instanceof Error
      ? cleanupFailure.message
      : String(cleanupFailure);
    failure = new Error(
      failure
        ? `${failure instanceof Error ? failure.message : String(failure)}; cleanup also failed: ${cleanupMessage}`
        : `cleanup failed: ${cleanupMessage}`,
      { cause: cleanupFailure },
    );
  }
  if (failure) throw failure;

  log(`PASS: ${pageUrl} (${verifiedAssets} Next assets; process tree and fixture cleaned)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await runDevSmoke();
  } catch (error) {
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
