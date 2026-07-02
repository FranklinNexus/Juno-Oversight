# 每日自动批处理（Daily Juno）

**最后更新**：2026-07-03  
**代码**：`scripts/run-daily-juno.mjs` · `orchestrator/src/daily-export.ts`

---

## 1. 做什么

| 阶段 | 行为 |
|------|------|
| **Autonomy 刷满** | 循环 tick 直到 `iterationsToday >= maxSelfIterationsPerDay` |
| **隔离导出** | 复制 digest + mission markdown → `exportRoot/YYYY-MM-DD/` |
| **Purge** | 删除过期 `runs/`、`staging/`（不碰 missions/config/state） |

人只需：设一次 `daily-schedule.json` + 安装计划任务。

---

## 2. 隔离原则

| 区域 | 策略 |
|------|------|
| **exportRoot** | 专用目录（如 `E:\JunoDailyExport`）；禁止 Vault / Workbench / 仓库 |
| **Vault** | 本流程**只读** `config.yaml` 取路径做校验，**从不写入** |
| **Purge** | 仅 `runs/`、`staging/`；`isSafePurgePath()` 门禁 |
| **导出保留** | 默认 30 天后删旧日期文件夹（仅 exportRoot 内） |

---

## 3. 安装（Windows）

```powershell
Copy-Item config\daily-schedule.example.json E:\AgentWorkbench\config\daily-schedule.json
# 编辑 exportRoot → 你的隔离目录

pnpm daily:juno:install              # 默认每天 07:00
pnpm daily:juno:install -Hour 8      # 改时间

pnpm daily:juno                      # 手动立即跑
```

日志：`AgentWorkbench/state/daily-juno.json` · `daily-juno.log`

---

## 4. 导出结构

```text
E:\JunoDailyExport\
  2026-07-03\
    Juno日报_2026-07-03.md          ← Obsidian 可直接打开
    artifacts/
      state/quality-scan.json
      missions/juno-axiom-book-2026/chapters/ch01.md
      ...
```

---

## 5. 关联

- [juno-bounded-autonomy.md](./juno-bounded-autonomy.md)
- [workbench.md](./workbench.md)
- [config/README.md](../config/README.md)
