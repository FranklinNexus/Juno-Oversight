# North Star — juno-daily-autonomy-2026

**Perpetual meta-mission**：在章程与日限额内，0 点配额重置后自动续跑 autonomy loops。

## 目标

- `juno:daemon` 刷满当日 cap 后 **等待 Asia/Shanghai 日切**，自动继续 tick
- 计划任务 `JunoDailyAutonomy` 在 **0:00** 备份启动 `daily:juno`（export + purge + 刷 cap）
- 队列空时由 **mission-planner** 自决策（hardening / AGI / cleanup 等），无需人工 assign

## 不产出 checkpoint COMPLETE

本 mission 永不完结；进度见 `state/juno-daemon.json` 与 `state/daily-juno.json`。
