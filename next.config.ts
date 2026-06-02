import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Static export only for `next build` (Tauri release). `next dev` must not use export mode. */
const isStaticExportBuild = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  turbopack: {
    root: rootDir,
  },
  ...(isStaticExportBuild
    ? {
        output: "export",
        distDir: "out",
        images: {
          unoptimized: true,
        },
      }
    : {}),
};

export default nextConfig;
