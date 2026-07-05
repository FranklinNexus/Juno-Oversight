# North Star — juno-wisdomechoes-axiom-blog-2026

**目标**：把 WisdomEchoes.net 上两篇 AI 博文合并为一篇；删掉质量不过关的「实验复盘」；顶部写 Juno 项目新描述；正文换 quality-scan PASS 的公理之书；**打开网页不卡**（~10 万字）。

## 现状

| Slug | 文件 | 处置 |
|------|------|------|
| `juno-min-agi-loop` | `content/posts/juno-min-agi-loop.mdx` | **删除**（描述质量不过关） |
| `growing-from-axioms-full` | `content/posts/growing-from-axioms-full.mdx` | **保留为唯一 AI 文** |

## 完成定义

- [ ] 删除 `juno-min-agi-loop.mdx`；博客列表 / 内链 / sitemap 无死链
- [ ] 从 `E:/AgentWorkbench/missions/juno-axiom-book-2026/book/全书.md` 重新 import（quality-rubric PASS 版，非旧 merge）
- [ ] 在 `growing-from-axioms-full.mdx` **顶部**写新描述：Juno 项目（Runtime for AI Work · LLMs write. Juno governs. · GitHub 链接 · 与书的关系）— **不用**旧 recap 正文
- [ ] **性能**：单 URL 打开不卡死 — 实现分章阅读器（推荐方案见下）
- [ ] `pnpm build`（WisdomEchoes.net）PASS；人工 spot-check 滚动/切章流畅
- [ ] mission `STATUS: COMPLETE`

## 性能方案（必选其一，推荐 A）

**A. 分章客户端 Reader（推荐）**

- 按 `# 第\d+章` 或 `全书.md` 章节边界 split
- `components/blog/LongBookReader.tsx`：章节目录 + **仅 mount 当前章** MDX/HTML
- `[slug]/page.tsx`：slug=`growing-from-axioms-full` 时走 Reader，其它文不变
- 禁用全书一次性 `rehypeHighlight` / `rehypeKatex` 全量 parse（按章 lazy）

**B. 多路由** `/blog/growing-from-axioms/ch/[n]` — 可选，工作量大

## 书源

```
E:/AgentWorkbench/missions/juno-axiom-book-2026/book/全书.md
```

quality-scan：`state/quality-scan.json` failedChapters=[] · rubric 已刷新（r07 self-optimize）

## 命令

```bash
cd WisdomEchoes.net
node scripts/import-axiom-book.mjs   # 更新为 single-post 模式后
pnpm build
pnpm dev   # 打开 /blog/growing-from-axioms-full
```
