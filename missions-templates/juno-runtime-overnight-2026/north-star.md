# North Star — juno-runtime-overnight-2026

**验收时间**：2026-07-04（人类 review）

**目标**：Juno Runtime **自我优化一轮** — 从「能跑」到「明天可验收」。

## 完成定义

- [ ] `pnpm verify:desktop` 全绿（含 **dev-smoke**）
- [ ] `pnpm dev` → `pnpm ui:smoke` 通过（localhost:3000）
- [ ] `ACCEPTANCE.md` 写明明天验收清单与实测结果
- [ ] README / wiki/maintenance 与当前代码一致
- [ ] `evolution-fitness.json` 有 overnight tick 记录
- [ ] 本 mission `STATUS: COMPLETE` + 终审 REVIEW_VERDICT PASS

## 范围

仅 **Juno Oversight** 仓库 + Workbench mission 目录。不改 Vault 正文、不 force-push。

## 命令真源

```bash
pnpm verify:desktop
pnpm dev:smoke
pnpm evolution:tick
pnpm loop:smoke
```
