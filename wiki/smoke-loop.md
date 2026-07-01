# Smoke Loop — UI 冒烟

Mission `juno-smoke-loop-2026` 的最小交付：`scripts/ui-smoke.mjs` + `pnpm ui:smoke`。

## 做什么

对 Next dev 根路径发 HTTP GET，要求：

- 状态码 **200**
- HTML body **不含**：`Internal Server Error`、`Turbopack error`、`Runtime Error`

## 用法

```bash
pnpm dev          # 默认 localhost:3000
pnpm ui:smoke     # 或 JUNO_DEV_URL=http://127.0.0.1:3000 pnpm ui:smoke
```

## 在 Overseer loop 中的位置

| Phase | 职责 |
|-------|------|
| sl00 implement | 交付脚本与 npm script |
| sl01 review | REVIEW_VERDICT，不改功能 |
| sl02 verify | VERIFY_REPORT 含 `ui_smoke` 结果 |

verify slot 前需有 dev server 在跑；未启动时 `ui:smoke` 会 FAIL（连接拒绝）。
