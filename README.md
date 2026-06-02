# Juno Oversight HUD

高信息密度、机构终端风格的战术看板（Next.js 16 + Tauri 2）。

## 文档

- **[Wiki 索引](./wiki/README.md)**
- [产品白皮书](./wiki/whitepaper.md)
- [维护手册](./wiki/maintenance.md)

## 运行

```bash
pnpm install
pnpm dev          # 浏览器（mock 数据）
pnpm tauri:dev    # 桌面壳 + 真实系统指标
pnpm test         # 单元测试
pnpm lint
pnpm build        # 静态导出到 out/（Tauri 打包前置）
```

桌面发布：`pnpm build` 后于 `src-tauri` 执行 `pnpm tauri build`（见 [维护手册](./wiki/maintenance.md)）。

- 主界面：http://localhost:3000  
- 组件目录（仅开发）：http://localhost:3000/dev/components  

## 能力概览

- 多窗可拖拽网格、`Omni-Surveillance` / `Deep Focus` 模式
- Widget：行情、GitHub 雷达、基础设施遥测、应用嵌入位
- 多市场自选（Crypto / US / HK / A股）、布局预设与本地保存
- HUD UI Kit、`/dev/components` 预览

详见 [wiki/whitepaper.md](./wiki/whitepaper.md)。
