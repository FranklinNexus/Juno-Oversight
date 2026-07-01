#!/usr/bin/env node
/**
 * Recover Juno Overseer files from Cursor agent transcript Write/StrReplace events.
 * Usage: node scripts/recover-from-transcripts.mjs [--dry-run]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
const DRY = process.argv.includes("--dry-run");

const TRANSCRIPT_DIRS = [
  "C:\\Users\\kfr34\\.cursor\\projects\\e-Obsidian-Vault\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\c-Users-kfr34-Desktop-Obsidian-Vault\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\d-DesktopData-Entrepreneurship-Juno-Oversight\\agent-transcripts",
  "C:\\Users\\kfr34\\.cursor\\projects\\c-Users-kfr34-Desktop-Entrepreneurship-Juno-Oversight\\agent-transcripts",
];

function normalizeJunoPath(p) {
  if (!p) return null;
  let s = p.replace(/\//g, "\\");
  const rootLower = ROOT.toLowerCase();
  if (s.toLowerCase().startsWith(rootLower)) {
    return s.slice(ROOT.length).replace(/^\\+/, "");
  }
  const markers = [
    "Desktop\\Entrepreneurship\\Juno Oversight",
    "DesktopData\\Entrepreneurship\\Juno Oversight",
  ];
  for (const m of markers) {
    const idx = s.toLowerCase().indexOf(m.toLowerCase());
    if (idx >= 0) {
      return s.slice(idx + m.length).replace(/^\\+/, "");
    }
  }
  return null;
}

function collectJsonlFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectJsonlFiles(full, out);
    else if (name.endsWith(".jsonl")) out.push({ full, mtime: st.mtimeMs });
  }
  return out;
}

function applyStrReplace(content, oldStr, newStr) {
  if (!content.includes(oldStr)) return null;
  return content.replace(oldStr, newStr);
}

const files = new Map(); // rel -> { content, mtime, source }
const events = [];

for (const dir of TRANSCRIPT_DIRS) {
  for (const { full, mtime: fileMtime } of collectJsonlFiles(dir)) {
    const text = readFileSync(full, "utf8");
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo += 1;
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const name = block.name;
        const input = block.input ?? {};
        const rel = normalizeJunoPath(input.path);
        if (!rel) continue;
        if (name === "Write" && typeof input.contents === "string") {
          events.push({ kind: "write", rel, content: input.contents, ts: fileMtime + lineNo });
        } else if (name === "StrReplace" && input.old_string != null && input.new_string != null) {
          events.push({
            kind: "replace",
            rel,
            old_string: input.old_string,
            new_string: input.new_string,
            ts: fileMtime + lineNo,
          });
        }
      }
    }
  }
}

events.sort((a, b) => a.ts - b.ts);

for (const ev of events) {
  if (ev.kind === "write") {
    files.set(ev.rel, { content: ev.content, ts: ev.ts });
    continue;
  }
  const cur = files.get(ev.rel)?.content;
  if (cur == null) continue;
  const next = applyStrReplace(cur, ev.old_string, ev.new_string);
  if (next != null) files.set(ev.rel, { content: next, ts: ev.ts });
}

let written = 0;
let skipped = 0;
for (const [rel, { content }] of files) {
  const outPath = path.join(ROOT, rel);
  if (rel.includes("..") || rel.startsWith("\\")) {
    skipped += 1;
    continue;
  }
  if (DRY) {
    console.log(`[dry-run] would write ${rel} (${content.length} bytes)`);
    written += 1;
    continue;
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
  written += 1;
}

console.error(
  `[recover] events=${events.length} unique_files=${files.size} written=${written} skipped=${skipped} dry=${DRY}`,
);
