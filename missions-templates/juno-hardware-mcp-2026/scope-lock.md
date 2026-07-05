# Scope Lock — juno-hardware-mcp-2026

## 允许

- `mcp-servers/serial-boards/**`
- `E:/AgentWorkbench/config/mcp-servers.json`
- `orchestrator/src/mcp-provision.ts`
- 本机 COM 口读写（用户已接开发板）

## 禁止

- 写 Vault 除 `Juno/**`
- 无文档的 flash/砖机操作
