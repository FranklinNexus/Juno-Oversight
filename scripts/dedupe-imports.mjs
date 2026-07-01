#!/usr/bin/env node
/** Remove exact duplicate import lines (transcript recovery artifact). */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
const skipDir = /^(node_modules|\.next|out|dist|\.git)$/;

function dedupeImports(text) {
  const lines = text.split("\n");
  const seen = new Set();
  const out = [];
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("export ") && trimmed.includes(" from ")) {
      if (seen.has(trimmed)) {
        changed = true;
        continue;
      }
      seen.add(trimmed);
    } else if (trimmed !== "" && !trimmed.startsWith("//")) {
      seen.clear();
    }
    out.push(line);
  }

  return { text: out.join("\n"), changed };
}

const fixed = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (skipDir.test(name)) continue;
      walk(full);
      continue;
    }
    if (!/\.(tsx?|jsx?|mts)$/.test(name)) continue;
    const raw = readFileSync(full, "utf8");
    const { text, changed } = dedupeImports(raw);
    if (changed) {
      writeFileSync(full, text, "utf8");
      fixed.push(full);
    }
  }
}

walk(path.join(ROOT, "src"));
console.log(`deduped imports in ${fixed.length} files`);
for (const f of fixed) console.log(f);
