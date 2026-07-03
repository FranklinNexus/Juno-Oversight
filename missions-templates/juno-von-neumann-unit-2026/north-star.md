# North Star — juno-von-neumann-unit-2026

**最小自指单元 v0**：observe → plan → act → measure(fitness) → mutate(whitelist)

见 [wiki/modules/evolution.md](../../../wiki/modules/evolution.md)

## 成功标准

- `state/evolution-fitness.json` 每 tick 更新
- fitness 7 日均线可审计
- 故障注入 24h 内自恢复（无人工 assign mission）
