# North Star — juno-agent-drive-research-2026

**目标**：读 **100 篇**前沿论文（非 1000 泛读），综合出 Juno **好奇心 / 野心 / 自主性 / 自我思维** 的可迭代架构，并落地到 `drive-engine` + `constitution`。

## 论文范围（4×25）

| Batch | 主题 |
|-------|------|
| 01 | 内在动机、好奇心驱动 RL、探索（Schmidhuber, Oudeyer, Pathak, Burda…） |
| 02 | Active inference、预测加工、自由能（Friston, Millidge…） |
| 03 | LLM Agent：ReAct, Reflexion, Voyager, MetaGPT, Generative Agents |
| 04 | 元认知、自我模型、Constitutional AI、open-ended / autotelic agents |

## 交付物

- [ ] `papers/taxonomy-drive.md` + `papers/batch-01..04.yaml`（各 25 篇，含 arxiv/id/one-line）
- [ ] `wiki/juno-drive-architecture.md` — 综合架构（Drive Engine L1/L2/L3 + fitness + 与现有 bounded-autonomy 映射）
- [ ] `orchestrator/src/drive-engine.ts` 按文献 refine（implement slot）
- [ ] dr11 VERIFY_REPORT PASS
- [ ] mission STATUS: COMPLETE

## 与 juno-agi-literature-2026 关系

- AGI 1000 篇 = 广谱背景；**本 mission = 聚焦 agent mind 的 100 篇 + 可执行 synthesis**
- 可交叉引用 batch 已有条目，但本 mission 必须独立 100 篇 curated list
