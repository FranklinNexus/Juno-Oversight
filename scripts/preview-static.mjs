#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "out");
const port = Number(process.env.PORT ?? process.env.JUNO_PREVIEW_PORT ?? 3000);

if (!existsSync(path.join(outputRoot, "index.html"))) {
  process.stderr.write("[preview] out/index.html is missing; run `corepack pnpm build` first\n");
  process.exit(1);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveAsset(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://localhost").pathname);
  } catch {
    return null;
  }
  const relative = pathname.replace(/^\/+/, "");
  const candidate = path.resolve(outputRoot, relative || "index.html");
  const inside = path.relative(outputRoot, candidate);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;

  const choices = [candidate];
  if (!path.extname(candidate)) {
    choices.push(`${candidate}.html`, path.join(candidate, "index.html"));
  }
  return choices.find((choice) => {
    try {
      return statSync(choice).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

const server = http.createServer((request, response) => {
  const asset = resolveAsset(request.url);
  if (!asset) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(asset).toLowerCase()) ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(asset).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`[preview] http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
