#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node recover-best-write.mjs <filename-substring>");
  process.exit(1);
}

const ROOT = "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
const dirs = [
  "C:\\Users\\kfr34\\.cursor\\projects\\e-Obsidian-Vault\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\c-Users-kfr34-Desktop-Entrepreneurship-Juno-Oversight\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\d-DesktopData-Entrepreneurship-Juno-Oversight\\agent-transcripts",
];

let best = { len: 0, content: "", rel: "", src: "" };

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (name.endsWith(".jsonl")) {
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const blocks = row?.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          if (b?.type !== "tool_use" || b.name !== "Write") continue;
          const p = b.input?.path ?? "";
          if (!p.includes(target)) continue;
          const c = b.input?.contents ?? "";
          if (c.length <= best.len) continue;
          const rel = p.replace(/.*Juno Oversight[\\/]/i, "").replace(/\\/g, "/");
          best = { len: c.length, content: c, rel, src: full };
        }
      }
    }
  }
}

for (const d of dirs) walk(d);
console.error(`best: ${best.rel} len=${best.len} from ${best.src}`);
if (!best.content) process.exit(1);
const out = path.join(ROOT, best.rel.replace(/\//g, "\\"));
writeFileSync(out, best.content, "utf8");
console.error(`wrote ${out}`);
