# North Star — juno-nl-brief-2026

**Meta-mission**：完善 `pnpm juno:brief` — 自然语言 → mission + 单次/每日判定 + MCP 预置 + auto-push。

## 完成定义

- [ ] `orchestrator/src/mission-brief.ts` 增强（LLM slot 可选 refine）
- [ ] `pnpm juno:brief --file Vault/Juno/inbox/brief.md --execute`
- [ ] `routeBriefToKnownMission` 覆盖常见意图
- [ ] inbox 完成摘要写回 `Juno/inbox/`
- [ ] 单元测试 ≥ 8
- [ ] STATUS: COMPLETE
