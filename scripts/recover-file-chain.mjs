#!/usr/bin/env node
/** Replay Write + StrReplace chain for one file from transcripts (chronological). */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const fileSuffix = process.argv[2];
const outRel = process.argv[3] ?? fileSuffix;
if (!fileSuffix) {
  console.error("Usage: node recover-file-chain.mjs <path-substring> [output-rel]");
  process.exit(1);
}

const ROOT = "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
const dirs = [
  "C:\\Users\\kfr34\\.cursor\\projects\\e-Obsidian-Vault\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\c-Users-kfr34-Desktop-Entrepreneurship-Juno-Oversight\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\d-DesktopData-Entrepreneurship-Juno-Oversight\\agent-transcripts",
];

const events = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (name.endsWith(".jsonl")) {
      let lineNo = 0;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        lineNo += 1;
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
          if (b?.type !== "tool_use") continue;
          const p = b.input?.path ?? "";
          if (!p.includes(fileSuffix)) continue;
          const ts = st.mtimeMs + lineNo;
          if (b.name === "Write" && typeof b.input?.contents === "string") {
            events.push({ kind: "write", content: b.input.contents, ts, src: full });
          } else if (b.name === "StrReplace") {
            events.push({
              kind: "replace",
              old_string: b.input.old_string,
              new_string: b.input.new_string,
              ts,
              src: full,
            });
          }
        }
      }
    }
  }
}

for (const d of dirs) walk(d);
events.sort((a, b) => a.ts - b.ts);

let content = null;
let applied = 0;
let skipped = 0;

for (const ev of events) {
  if (ev.kind === "write") {
    content = ev.content;
    applied += 1;
    continue;
  }
  if (content == null) continue;
  if (!content.includes(ev.old_string)) {
    skipped += 1;
    continue;
  }
  content = content.replace(ev.old_string, ev.new_string);
  applied += 1;
}

if (content == null) {
  console.error("No content recovered");
  process.exit(1);
}

const outPath = path.join(ROOT, outRel.replace(/\//g, "\\"));
writeFileSync(outPath, content, "utf8");
console.error(`chain: events=${events.length} applied=${applied} skipped=${skipped} bytes=${content.length}`);
console.error(`wrote ${outPath}`);
