#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";

function isUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true;
  if (buf.length < 8) return false;
  // UTF-16 LE without BOM: ASCII char followed by 0x00
  let pairs = 0;
  let utf16Like = 0;
  for (let i = 0; i < Math.min(buf.length - 1, 600); i += 2) {
    pairs += 1;
    if (buf[i + 1] === 0 && buf[i] >= 0x09 && buf[i] <= 0x7e) utf16Like += 1;
  }
  return pairs > 10 && utf16Like / pairs > 0.85;
}

function toUtf8(filePath) {
  const buf = readFileSync(filePath);
  if (!isUtf16(buf)) return false;
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString("utf16le").slice(1);
  } else {
    text = buf.toString("utf16le");
  }
  writeFileSync(filePath, text.replace(/^\uFEFF/, ""), "utf8");
  return true;
}

const skipDir = /^(node_modules|\.next|out|dist|\.git)$/;

function walk(dir, fixed) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (skipDir.test(name)) continue;
      walk(full, fixed);
      continue;
    }
    if (!/\.(ts|tsx|mts|mjs|js|jsx|json|md|css|yaml|yml|ps1)$/.test(name)) continue;
    if (toUtf8(full)) fixed.push(full);
  }
}

const fixed = [];
walk(ROOT, fixed);
console.log(`fixed ${fixed.length} utf16 files`);
for (const f of fixed.slice(0, 50)) console.log(f);
if (fixed.length > 50) console.log(`... and ${fixed.length - 50} more`);
