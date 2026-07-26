import { createHash } from "node:crypto";

export const MAX_REVISION_ATTEMPTS = 20;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeRevisionParentRunId(parentRunId: unknown): asserts parentRunId is string {
  if (typeof parentRunId !== "string" || !SAFE_RUN_ID.test(parentRunId)) {
    throw new Error(`Invalid revision parent run id: ${String(parentRunId)}`);
  }
}

export function assertRevisionAttempt(attempt: unknown): asserts attempt is number {
  if (
    !Number.isSafeInteger(attempt)
    || (attempt as number) < 1
    || (attempt as number) > MAX_REVISION_ATTEMPTS
  ) {
    throw new Error(
      `revision attempt must be an integer between 1 and ${MAX_REVISION_ATTEMPTS}`,
    );
  }
}

export function revisionFixRunId(parentRunId: string, attempt: number): string {
  assertSafeRevisionParentRunId(parentRunId);
  assertRevisionAttempt(attempt);
  const parentHash = createHash("sha256").update(parentRunId, "utf8").digest("hex").slice(0, 32);
  return `revision-${parentHash}-${attempt}`;
}
