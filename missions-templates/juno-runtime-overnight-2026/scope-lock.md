# Scope Lock — juno-runtime-overnight-2026

## 允许修改（Juno Oversight）

- `README.md`、`wiki/**`、`docs/**`
- `scripts/**`（dev-smoke、verify、overnight bootstrap）
- `package.json`（scripts 字段）
- `orchestrator/src/**`（小步修复 verify/dev 失败项）
- `src/**`（仅修复 verify/dev 暴露的 bug）
- `missions-templates/juno-runtime-overnight-2026/**`
- `config/**`

## 允许修改（Workbench）

- `missions/juno-runtime-overnight-2026/**`（含 ACCEPTANCE.md、checkpoint、purge 无关）

## 禁止

- Obsidian Vault 写入（hooks 拦截）
- `git push --force`、amend 已 push commit
- 删除 `missions/` 其他 mission 正文
- 改 `autonomy-charter.json` 的 `forbiddenMissionIds` 放行 landing-site
