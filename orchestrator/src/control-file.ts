import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";

export interface ControlFileSnapshot {
  text: string;
  byteLength: number;
  sha256: string;
}

export interface ControlFileReadHooks {
  afterOpen?: (descriptor: number) => void;
  afterRead?: (descriptor: number) => void;
}

function assertExclusiveRegularFile(
  stat: BigIntStats,
  target: string,
  label: string,
  maxBytes: number,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) {
    throw new Error(`${label} must be an exclusive regular file: ${target}`);
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
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

/** Read bounded UTF-8 control bytes through one descriptor and reject links or mutation. */
export function readExclusiveControlText(
  target: string,
  label: string,
  maxBytes: number,
  hooks: ControlFileReadHooks = {},
): ControlFileSnapshot {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`Invalid ${label} byte limit: ${maxBytes}`);
  }
  const before = lstatSync(target, { bigint: true });
  assertExclusiveRegularFile(before, target, label, maxBytes);
  const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = openSync(target, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertExclusiveRegularFile(opened, target, label, maxBytes);
    if (!sameFile(before, opened)) throw new Error(`${label} changed while opening: ${target}`);
    hooks.afterOpen?.(descriptor);

    const buffer = Buffer.alloc(maxBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        byteLength,
        buffer.length - byteLength,
        byteLength,
      );
      if (count === 0) break;
      byteLength += count;
    }
    if (byteLength > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
    }
    hooks.afterRead?.(descriptor);

    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(target, { bigint: true });
    assertExclusiveRegularFile(afterHandle, target, label, maxBytes);
    assertExclusiveRegularFile(afterPath, target, label, maxBytes);
    if (!sameFile(opened, afterHandle) || !sameFile(afterHandle, afterPath)) {
      throw new Error(`${label} changed while reading: ${target}`);
    }
    if (afterHandle.size !== BigInt(byteLength)) {
      throw new Error(`${label} size changed while reading: ${target}`);
    }

    const bytes = buffer.subarray(0, byteLength);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} must be valid UTF-8: ${target}`, { cause: error });
    }
    return {
      text,
      byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}
