import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

const MAX_PROMPT_TEMPLATE_BYTES = 256 * 1024;
const SAFE_PROMPT_TEMPLATE = /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,126}[\p{L}\p{N}])?$/u;
const WINDOWS_RESERVED_PROMPT_TEMPLATE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function assertExclusivePromptFile(stat: BigIntStats, target: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) {
    throw new Error(`Prompt template must be an exclusive regular file: ${target}`);
  }
  if (stat.size > BigInt(MAX_PROMPT_TEMPLATE_BYTES)) {
    throw new Error(
      `Prompt template exceeds the ${MAX_PROMPT_TEMPLATE_BYTES}-byte limit: ${target}`,
    );
  }
}

function samePromptFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    (process.platform === "win32" || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function resolvePromptTemplatePath(workbench: string, promptTemplate: string): string {
  if (
    !SAFE_PROMPT_TEMPLATE.test(promptTemplate) ||
    WINDOWS_RESERVED_PROMPT_TEMPLATE.test(promptTemplate)
  ) {
    throw new Error(`Invalid prompt template: ${promptTemplate}`);
  }
  const canonicalWorkbench = realpathSync.native(path.resolve(workbench));
  const lexicalPrompts = path.join(canonicalWorkbench, "prompts");
  if (!existsSync(lexicalPrompts)) {
    throw new Error(`Workbench prompts directory is missing: ${lexicalPrompts}`);
  }
  const promptsStat = lstatSync(lexicalPrompts);
  if (!promptsStat.isDirectory() || promptsStat.isSymbolicLink()) {
    throw new Error(`Workbench prompts directory must be a non-link directory: ${lexicalPrompts}`);
  }
  const canonicalPrompts = realpathSync.native(lexicalPrompts);
  if (canonicalPrompts !== lexicalPrompts) {
    throw new Error(`Workbench prompts directory must not be a link: ${lexicalPrompts}`);
  }
  const target = path.join(canonicalPrompts, `${promptTemplate}.md`);
  if (!existsSync(target)) {
    throw new Error(`Prompt template does not exist: ${target}`);
  }
  assertExclusivePromptFile(lstatSync(target, { bigint: true }), target);
  return target;
}

export interface PromptTemplateSnapshot {
  filePath: string;
  text: string;
  sha256: string;
  byteLength: number;
}

/** Read exact prompt bytes through a bounded descriptor and reject linked or changing files. */
export function readPromptTemplateSnapshot(
  workbench: string,
  promptTemplate: string,
): PromptTemplateSnapshot {
  const target = resolvePromptTemplatePath(workbench, promptTemplate);
  const before = lstatSync(target, { bigint: true });
  assertExclusivePromptFile(before, target);
  const noFollow =
    (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(target, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertExclusivePromptFile(opened, target);
    if (!samePromptFile(before, opened)) {
      throw new Error(`Prompt template changed while opening: ${target}`);
    }

    const buffer = Buffer.alloc(MAX_PROMPT_TEMPLATE_BYTES + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        byteLength,
        buffer.length - byteLength,
        byteLength,
      );
      if (count === 0) break;
      byteLength += count;
    }
    if (byteLength > MAX_PROMPT_TEMPLATE_BYTES) {
      throw new Error(
        `Prompt template exceeds the ${MAX_PROMPT_TEMPLATE_BYTES}-byte limit: ${target}`,
      );
    }

    const afterHandle = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(target, { bigint: true });
    assertExclusivePromptFile(afterHandle, target);
    assertExclusivePromptFile(afterPath, target);
    if (!samePromptFile(opened, afterHandle) || !samePromptFile(afterHandle, afterPath)) {
      throw new Error(`Prompt template changed while reading: ${target}`);
    }
    if (afterHandle.size !== BigInt(byteLength)) {
      throw new Error(`Prompt template size changed while reading: ${target}`);
    }

    const bytes = buffer.subarray(0, byteLength);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Prompt template must be valid UTF-8: ${target}`, { cause: error });
    }
    return {
      filePath: target,
      text,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength,
    };
  } finally {
    closeSync(fd);
  }
}
