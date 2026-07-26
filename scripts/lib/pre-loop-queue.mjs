import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

export function backupExistingQueue(workbench, timestamp = Date.now()) {
  const queuePath = path.join(workbench, "queue", "now.yaml");
  if (!existsSync(queuePath)) return null;

  const backupPath = path.join(
    workbench,
    "queue",
    `now.yaml.bak-pre-loop-${timestamp}`,
  );
  copyFileSync(queuePath, backupPath);
  return backupPath;
}
