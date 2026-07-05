# North Star — juno-hardware-mcp-2026

**目标**：发现本机 USB 串口开发板（用户称两块板），有 MCP 则用，无则 `mcp-servers/serial-boards` 自建，可读写 serial。

## 完成定义

- [ ] 扫描 COM 口（Windows `SerialPort.list`）
- [ ] 注册/启用 `config/mcp-servers.json` → `serial-boards`
- [ ] 两块板识别记录于 checkpoint（path/manufacturer）
- [ ] 最小 verify：list_ports + echo 命令（或 dry-run 文档）
- [ ] 禁止 raw GPIO 无 scope 文档
- [ ] STATUS: COMPLETE

## 赚钱 / 项目延伸（后续 brief）

硬件 MCP 就绪后，可用 `juno:brief` 派生 revenue mission（产品原型、自动化测试服务）。
