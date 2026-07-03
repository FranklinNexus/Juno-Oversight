# Experiments — 历史 Mission 与演进路线

**合并自**：`architecture-loop.md` · `juno-axiom-book-experiment.md` · `juno-agent-architecture.md` · `agent-literature-index.md`（索引）

---

## 演进路线图（摘要）

| 阶段 | 状态 |
|------|------|
| smoke + meta 本地 runner | 完成 |
| P0–P2 自迭代 | 完成 |
| AGI 1000 篇 | 完成 → [juno-agi-north-star.md](./juno-agi-north-star.md) |
| 公理之书 | 完成 |
| Overseer Hardening h01–h11 | 完成 |
| Von Neumann v0–v1 | 完成 |
| Workbench cleanup | 完成 |

```bash
pnpm loop:smoke
pnpm loop:self-iterate-p2-run
pnpm queue:agi-literature && pnpm agi:loop
pnpm queue:axiom-book && pnpm book:loop
```

---

## Smoke & Meta

**试跑** → [smoke-loop.md](./smoke-loop.md) · `pnpm loop:smoke`

Loop gate（24/7 前可选）：`state/loop-gate.json` 24h stamp。

---

## AGI 文献

- 交付 wiki：[juno-agi-north-star.md](./juno-agi-north-star.md)（**脚本硬编码路径，勿删**）
- 100 篇架构：[juno-agent-architecture.md](./juno-agent-architecture.md)
- 索引表：[agent-literature-index.md](./agent-literature-index.md)

---

## 公理之书

overnight 写书实验 → [juno-axiom-book-experiment.md](./juno-axiom-book-experiment.md)

```bash
pnpm book:loop
pnpm book:quality-loop
```

---

## 详细 loop 架构

完整 P0/P1/P2 组件表 → [architecture-loop.md](./architecture-loop.md)
