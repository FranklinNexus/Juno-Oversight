# Scope Lock — juno-daily-autonomy-2026

## 允许

- `autonomy:tick --execute` / `juno:daemon` / `daily:juno`
- 章程内 mission registry 自 queue、自 advance
- 隔离导出 `E:\JunoDailyExport`、workbench purge（runs/staging only）

## 禁止

- 直写 Obsidian Vault / git destructive
- 绕过 `allowedMissionIds` 与 loop-gate
- 超 `maxSelfIterationsPerDay` 继续 tick
