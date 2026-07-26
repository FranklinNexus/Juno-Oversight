const STATUS_LINE = /^\uFEFF?\s*STATUS:\s*([^\r\n]+?)\s*$/gim;

export function parseCheckpointStatuses(checkpointText: string): string[] {
  return [...checkpointText.matchAll(STATUS_LINE)].map((match) =>
    match[1].trim().toLowerCase(),
  );
}

export function hasUniqueCompleteStatus(checkpointText: string): boolean {
  const statuses = parseCheckpointStatuses(checkpointText);
  return statuses.length === 1 && statuses[0] === "complete";
}
