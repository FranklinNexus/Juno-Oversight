# Workflow 版本库

Mission `juno-self-iterate-2026` 引入的可版本化 **phase 图**（JSON，无新依赖）。

| 文件 | 用途 |
|------|------|
| `default.json` | 标准 implement → review → verify |
| `meta-loop.json` | smoke/meta 自指三 slot |
| `self-iterate.json` | 本 Mission P0 交付 |

加载：`import { loadWorkflow } from "./workflow.js"` → `loadWorkflow("default")`。

Queue item 可选字段 `workflow_id`；manifest 写入 `workflowId` + `evalProfile`。
