# Product — HUD · Widgets · 视觉

**合并自**：`whitepaper.md` · `widgets.md`

---

## 定位

**Juno Surface** = Next.js + Tauri 战术 HUD。与 **Runtime** 同屏：Run Queue · Active Run · Mission Board · Promote 预览。

设计：机构终端风格 · 高信息密度 · 1440×900 逻辑画布 · 主题（夜间 / 土星金 / 日间）。

---

## Widget 概览

| ID | 用途 |
|----|------|
| WIDGET-Q | Run Queue |
| Active Run | Live slot 状态 · events tail |
| Mission Board | progress · scope |
| WIDGET-P | Promote 预览 → Vault |
| 行情 / GitHub / Jupiter | 战术数据层 |

注册表：`src/lib/widget-registry.ts`。IPC：`src-tauri/`。

**完整 Widget 表与交互** → [whitepaper.md](./whitepaper.md) · [widgets.md](./widgets.md)

---

## 开发

```bash
pnpm dev           # 浏览器 mock
pnpm tauri:dev     # 桌面 + Workbench 探针
```
