# Scope Lock — juno-wisdomechoes-axiom-blog-2026

## 站点根目录（真源）

**唯一路径** — `config.yaml` → `wisdomechoes_root`：

```
C:/Users/kfr34/Desktop/Entrepreneurship/WisdomEchoes.net
```

- **禁止** `git clone` / `git pull` 到新目录
- **禁止** 复制整仓到 `D:\DesktopData\`、`E:\Obsidian Vault\` 等其它路径
- 所有改动 **就地** 在该目录完成；`pnpm build` / `pnpm dev` 也在该目录执行

Helper：`scripts/lib/wisdomechoes-root.mjs` · env 覆盖：`WISDOMECHOES_ROOT`

## 允许修改

**WisdomEchoes.net**（`{wisdomechoes_root}/`）：

- `content/posts/growing-from-axioms-full.mdx`
- `content/posts/juno-min-agi-loop.mdx`（**仅删除**）
- `scripts/import-axiom-book.mjs`
- `app/blog/[slug]/page.tsx`
- `components/blog/**`（新建 LongBookReader 等）
- `lib/mdx.ts`（若需 chapter 元数据）
- `public/**`（本书配图，若需）

**只读**：

- `E:/AgentWorkbench/missions/juno-axiom-book-2026/book/全书.md`
- Juno README / wiki/product.md（写 intro 时引用）

## 禁止

- 改 LASZLO / SurferGarage / 港户等无关博文
- force-push WisdomEchoes 或 Juno 仓库
- 把 10 万字仍一次性塞进单页 MDXRemote 而不做分章/lazy（w04 阻断项）
- 下载/克隆 WisdomEchoes 到 scope 外路径

## repo 说明

队列 `repo_target: juno-overseer`；implement 在 **wisdomechoes_root** 写文件（非 Juno 仓内副本）。
